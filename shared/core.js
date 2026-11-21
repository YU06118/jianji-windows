/**
 * shared/core.js —— 简记核心逻辑（纯函数，双端共用）
 * 需求文档 Q26：核心记账/统计逻辑代码尽量一致；界面层两端各自原生。
 * 本文件不依赖 wx / DOM / Node 特有 API，可在小程序、WebView、Node 测试中直接运行。
 *
 * 口径与小程序模板 utils/money.js 完全一致：金额先转「分」整数再运算。
 */

// ---------- 金额精度（Q27 人民币两位小数）----------
function toCents(yuan) {
  const n = Number(yuan)
  if (!isFinite(n)) return 0
  return Math.round(n * 100)
}
function toYuan(cents) { return Math.round(cents) / 100 }
function sumYuan(list) {
  let c = 0
  for (let i = 0; i < list.length; i++) c += toCents(list[i])
  return toYuan(c)
}
function fmt(yuan, digits) {
  const n = Number(yuan) || 0
  const neg = n < 0
  const abs = Math.abs(n)
  const rounded = Math.round(abs * 100) / 100
  let intPart, decPart
  if (digits === 2) {
    intPart = String(Math.floor(rounded + 1e-9))
    decPart = String(Math.round((rounded - Math.floor(rounded + 1e-9)) * 100)).padStart(2, '0')
  } else {
    if (Math.abs(rounded - Math.round(rounded)) < 1e-9) { intPart = String(Math.round(rounded)); decPart = '' }
    else { intPart = String(Math.floor(rounded + 1e-9)); decPart = String(Math.round((rounded - Math.floor(rounded + 1e-9)) * 100)).padStart(2, '0') }
  }
  intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '-' : '') + intPart + (decPart ? '.' + decPart : '')
}

// ---------- 日期与周期（Q9 周/月/年/近3年/近5年）----------
function monthKey(date) { return String(date || '').slice(0, 7) }
function yearKey(date) { return String(date || '').slice(0, 4) }
function inRange(date, dim, anchorDate) {
  const a = anchorDate || new Date().toISOString().slice(0, 10)
  if (dim === 'all') return true
  if (dim === 'month') return monthKey(date) === monthKey(a)
  if (dim === 'year') return yearKey(date) === yearKey(a)
  if (dim === 'week') {
    const d = new Date(date), b = new Date(a)
    const day = (b.getDay() + 6) % 7 // 周一为一周起点
    b.setDate(b.getDate() - day); b.setHours(0, 0, 0, 0)
    const e = new Date(b); e.setDate(e.getDate() + 7)
    return d >= b && d < e
  }
  if (dim === 'last3y' || dim === 'last5y') {
    const n = dim === 'last3y' ? 3 : 5
    return Number(yearKey(date)) >= Number(yearKey(a)) - n + 1
  }
  return true
}

// ---------- 记录过滤：软删除 + 检索（Q11 四类检索）----------
// filters: { keyword, type:'expense'|'income'|null, cat, dateFrom, dateTo, amountMin, amountMax, includeDeleted }
function filterRecords(records, filters) {
  const f = filters || {}
  const kw = (f.keyword || '').trim().toLowerCase()
  return (records || []).filter(function (r) {
    if (!f.includeDeleted && r.deleted) return false
    if (f.type && r.type !== f.type) return false
    if (f.cat && r.cat !== f.cat) return false
    if (kw && String(r.note || '').toLowerCase().indexOf(kw) < 0) return false
    if (f.dateFrom && r.date < f.dateFrom) return false
    if (f.dateTo && r.date > f.dateTo) return false
    if (f.amountMin !== undefined && Number(r.amount) < Number(f.amountMin)) return false
    if (f.amountMax !== undefined && Number(r.amount) > Number(f.amountMax)) return false
    return true
  })
}

// ---------- 统计汇总（Q9/Q10）----------
function summarize(records) {
  let income = 0, expense = 0
  const byCat = {}
  const list = records || []
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    if (r.deleted) continue
    if (r.type === 'income') income += toCents(r.amount)
    else { expense += toCents(r.amount); byCat[r.cat] = (byCat[r.cat] || 0) + toCents(r.amount) }
  }
  const inc = toYuan(income), exp = toYuan(expense)
  const catArr = Object.keys(byCat).map(function (k) { return { cat: k, amount: toYuan(byCat[k]) } })
  catArr.sort(function (a, b) { return b.amount - a.amount })
  return {
    income: inc,
    expense: exp,
    balance: toYuan(income - expense),
    savingsRate: inc > 0 ? Math.round((income - expense) / income * 100) : 0,
    byCat: catArr
  }
}

/** 按周/月分组的趋势序列（Q10 折线/面积图） */
function trendSeries(records, dim, anchorDate) {
  const buckets = {}
  const list = records || []
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    if (r.deleted) continue
    const key = dim === 'month' ? monthKey(r.date) : dim === 'year' ? yearKey(r.date) : r.date
    if (!buckets[key]) buckets[key] = { key: key, income: 0, expense: 0 }
    if (r.type === 'income') buckets[key].income += toCents(r.amount)
    else buckets[key].expense += toCents(r.amount)
  }
  return Object.keys(buckets).sort().map(function (k) {
    return { key: k, income: toYuan(buckets[k].income), expense: toYuan(buckets[k].expense) }
  })
}

/** 日历热力图数据（Q10）：YYYY-MM-DD -> 当日支出 */
function heatmap(records) {
  const m = {}
  const list = records || []
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    if (r.deleted || r.type !== 'expense') continue
    m[r.date] = (m[r.date] || 0) + toCents(r.amount)
  }
  const out = {}
  Object.keys(m).forEach(function (k) { out[k] = toYuan(m[k]) })
  return out
}

// ---------- 导出汇总口径（Q12 PDF/CSV/JSON）----------
/** CSV 行转义：逗号、引号、换行、公式注入前缀（与安全层一致） */
function csvCell(v) {
  let s = String(v === null || v === undefined ? '' : v)
  if (/^[=+\-@]/.test(s)) s = "'" + s // 防表格公式注入
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'
  return s
}
function toCSV(records, categories) {
  const catName = {}
  ;(categories || []).forEach(function (c) { catName[c.id] = c.name })
  const head = ['日期', '类型', '分类', '金额', '备注'].join(',')
  const rows = (records || []).filter(function (r) { return !r.deleted }).map(function (r) {
    return [r.date, r.type === 'income' ? '收入' : '支出', catName[r.cat] || r.cat,
      fmt(r.amount, 2), r.note || ''].map(csvCell).join(',')
  })
  return [head].concat(rows).join('\r\n')
}

/** 生成 JSON 备份文件对象（Q12/Q22 三端互通） */
function makeBackup(records, categories, recurring, settings) {
  return {
    app: '简记',
    version: 1,
    exportedAt: new Date().toISOString(),
    records: records || [],
    categories: categories || [],
    recurring: recurring || [],
    settings: settings || {}
  }
}

module.exports = {
  toCents, toYuan, sumYuan, fmt,
  monthKey, yearKey, inRange,
  filterRecords, summarize, trendSeries, heatmap,
  csvCell, toCSV, makeBackup
}
