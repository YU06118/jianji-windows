/* 简记 · 桌面端前端逻辑
 * 运行在 Tauri WebView 中：数据走 Rust 命令 → 本机 SQLite（Q20）
 * 独立浏览器打开时：自动降级到 localStorage，便于无 Rust 环境预览
 * 金额口径与 shared/core.js 一致：内部用「分」整数运算
 */
(function () {
  'use strict'
  const IN_TAURI = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
  const invoke = IN_TAURI
    ? (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args || {})
    : async () => { throw new Error('not tauri') }

  // ---------- 金额与工具 ----------
  const toCents = y => Math.round((Number(y) || 0) * 100)
  const toYuan = c => Math.round(c) / 100
  const sumYuan = list => toYuan(list.reduce((a, b) => a + toCents(b), 0))
  const money = n => '¥ ' + (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const fmt2 = n => (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  let catColor = {}

  // ---------- 设置读写（顶层共用；浏览器降级用 localStorage）----------
  const getSet = async k => {
    if (!IN_TAURI) { try { return localStorage.getItem('jianji_set_' + k) } catch (e) { return null } }
    try { return await invoke('get_setting', { key: k }) } catch (e) { return null }
  }
  const setSet = (k, v) => IN_TAURI
    ? invoke('set_setting', { key: k, value: String(v) })
    : Promise.resolve().then(() => localStorage.setItem('jianji_set_' + k, String(v)))

  // ---------- 自绘确认/输入框（WebView2 下原生 confirm/prompt 不可靠）----------
  function askConfirm(title, msg, opts) {
    opts = opts || {}
    return new Promise(resolve => {
      const mask = document.getElementById('confirm-modal')
      if (!mask) { resolve(opts.input ? null : false); return }
      document.getElementById('cf-title').textContent = title
      document.getElementById('cf-msg').textContent = msg
      const input = document.getElementById('cf-input')
      if (opts.input) { input.style.display = ''; input.value = opts.inputValue || ''; input.placeholder = opts.input || '' }
      else { input.style.display = 'none'; input.value = '' }
      const ok = document.getElementById('cf-ok'), cancel = document.getElementById('cf-cancel')
      ok.textContent = opts.okText || '确定'
      ok.className = 'modal-btn ' + (opts.danger ? 'danger' : 'primary')
      mask.classList.add('show')
      if (opts.input) setTimeout(() => input.focus(), 30)
      const done = v => {
        mask.classList.remove('show')
        ok.onclick = cancel.onclick = mask.onclick = null
        resolve(v)
      }
      ok.onclick = () => done(opts.input ? input.value : true)
      cancel.onclick = () => done(opts.input ? null : false)
      mask.onclick = e => { if (e.target === mask) done(opts.input ? null : false) }
    })
  }

  // ---------- 预设分类（与 SQLite 初始化一致）----------
  const PRESET_OUT = [
    ['food', '🍜', '餐饮', '#4f5bd5'], ['grocery', '🥬', '买菜', '#6FAE5F'], ['daily', '🧴', '日用', '#4FB3A5'],
    ['clothing', '👗', '服饰', '#E5759B'], ['home', '🏠', '居住', '#7c86ff'], ['transport', '🚇', '交通', '#34c759'],
    ['medical', '💊', '医疗', '#ff2d55'], ['fun', '🎬', '娱乐', '#AF52DE'], ['study', '📚', '学习', '#32ADE6'], ['other', '📦', '其他', '#A79DA2']
  ]
  const PRESET_IN = [
    ['salary', '💰', '工资', '#34C759'], ['bonus', '🎁', '奖金', '#FFCC00'], ['redpack', '🧧', '红包', '#D9736E'], ['other_in', '📥', '其他', '#A79DA2']
  ]
  let catsOut = PRESET_OUT.map(([id, e, n, c]) => ({ id, e, n, c, kind: 'expense', custom: false })),
      catsIn = PRESET_IN.map(([id, e, n, c]) => ({ id, e, n, c, kind: 'income', custom: false }))
  PRESET_OUT.concat(PRESET_IN).forEach(([id, , , c]) => catColor[id] = c)

  const toUiCat = c => ({ id: c.id, e: c.icon, n: c.name, c: c.color, custom: !!c.custom, kind: c.kind })
  const toRustCat = c => ({ id: c.id, name: c.n, kind: c.kind, icon: c.e, color: c.c, custom: c.custom ? 1 : 0 })
  const cid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  async function loadCategories() {
    if (!IN_TAURI) return   // 降级：保留硬编码预设
    try {
      const rows = await invoke('list_categories')
      if (!rows || !rows.length) return
      const ui = rows.map(toUiCat)
      catsOut = ui.filter(c => c.kind === 'expense')
      catsIn = ui.filter(c => c.kind === 'income')
      catColor = {}
      rows.forEach(c => catColor[c.id] = c.color)
      renderPick()
    } catch (e) { /* 失败保留硬编码预设，不阻塞启动 */ }
  }

  // ---------- 数据层 ----------
  let txs = []          // UI 形态：{id,ic,bg,n,note,amt,out,t,ts,date,cat,image,deleted,_i}
  let pendingImage = null
  let activeFilter = 'all'   // 明细筛选：all | expense | income | month | range
  let searchKw = ''          // 备注关键词，与 chips 叠加
  let viewYM = new Date().toISOString().slice(0, 7)   // 概览选中月份
  let appDir = ''            // Tauri 数据目录缓存（小票查看用）

  function fromRecord(r) {
    const d = new Date(r.ts || Date.now())
    const c = catColor[r.cat] || '#8e8e93'
    const cat = catsOut.concat(catsIn).find(x => x.id === r.cat)
    return {
      id: r.id, cat: r.cat, date: r.date, ts: r.ts, image: r.image || '', deleted: !!r.deleted,
      ic: cat ? cat.e : '📦', bg: c + '1f',
      n: r.note || (cat ? cat.n : '未分类'), note: r.note || '',
      amt: toYuan(r.amount), out: r.kind === 'expense',
      t: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
  }
  function toRecord(x) {
    return {
      id: x.id || uid(), kind: x.out ? 'expense' : 'income', amount: toCents(x.amt),
      cat: x.cat || 'other', note: x.note || '', date: x.date || new Date().toISOString().slice(0, 10),
      ts: x.ts || Date.now(), image: x.image || '', deleted: x.deleted ? 1 : 0
    }
  }

  // localStorage 降级实现
  const LS = {
    get() { try { return JSON.parse(localStorage.getItem('jianji_records') || '[]') } catch (e) { return [] } },
    set(list) { localStorage.setItem('jianji_records', JSON.stringify(list)) }
  }

  async function loadRecords() {
    if (IN_TAURI) {
      const rows = await invoke('list_records', { includeDeleted: 1 })
      txs = rows.map(fromRecord)
    } else {
      let list = LS.get()
      if (!list.length) {
        // 演示数据（仅预览用，首次写入本地）
        list = [
          { id: uid(), kind: 'expense', amount: 3850, cat: 'food', note: '午餐 · 公司附近', date: '2026-11-17', ts: Date.now() - 3600000, image: '', deleted: 0 },
          { id: uid(), kind: 'expense', amount: 1200, cat: 'transport', note: '地铁通勤', date: '2026-11-17', ts: Date.now() - 7200000, image: '', deleted: 0 },
          { id: uid(), kind: 'income', amount: 1280000, cat: 'salary', note: '11月工资', date: '2026-11-15', ts: Date.now() - 86400000 * 2, image: '', deleted: 0 },
          { id: uid(), kind: 'expense', amount: 320000, cat: 'home', note: '房租', date: '2026-11-05', ts: Date.now() - 86400000 * 12, image: '', deleted: 0 }
        ]
        LS.set(list)
      }
      txs = list.map(fromRecord)
    }
    render()
  }
  async function saveRecord(rec) {
    if (IN_TAURI) await invoke('save_record', { record: toRecord(rec) })
    else {
      const list = LS.get(), idx = list.findIndex(r => r.id === rec.id)
      const row = toRecord(rec)
      if (idx >= 0) list[idx] = row; else list.unshift(row)
      LS.set(list)
    }
  }
  async function trashRecord(id, deleted) {
    if (IN_TAURI) await invoke('trash_record', { id, deleted })
    else {
      const list = LS.get().map(r => r.id === id ? Object.assign({}, r, { deleted }) : r)
      LS.set(list)
    }
    await loadRecords()
  }

  // ---------- 渲染 ----------
  function txRow(x, del) {
    return `<div class="tx"><div class="ic" style="background:${x.bg}">${x.ic}</div>
      <div class="meta"><b>${esc(x.n)}</b><span>${x.t} · ${esc(x.note)}</span></div>
      ${x.image ? `<button class="thumb" title="查看小票" data-id="${x.id}">▧</button>` : ''}
      <div class="money ${x.out ? 'out' : 'in'}">${x.out ? '−' : '+'} ${money(x.amt)}</div>
      ${del ? `<button class="edit" title="编辑" data-id="${x.id}">✎</button><button class="del" title="删除" data-id="${x.id}">✕</button>` : ''}</div>`
  }
  function groupByDate(list, del) {
    if (!list.length) return '<div style="padding:24px;text-align:center;color:var(--label3);font-size:13px">暂无记录</div>'
    const groups = {}
    list.forEach(x => { const k = x.date; (groups[k] = groups[k] || []).push(x) })
    return Object.keys(groups).sort().reverse().map(k =>
      `<div class="date-group"><div class="date-label"><span>${k}</span><span>${groups[k].length} 笔</span></div>${groups[k].map(x => txRow(x, del)).join('')}</div>`
    ).join('')
  }
  let trashView = false
  // 明细筛选：类型 / 本月 / 金额区间，与关键词搜索叠加
  function applyFilters(list) {
    const kw = searchKw.trim().toLowerCase()
    const nowYM = new Date().toISOString().slice(0, 7)
    return list.filter(x => {
      if (kw && (String(x.note || '') + ' ' + String(x.n || '')).toLowerCase().indexOf(kw) < 0) return false
      if (activeFilter === 'expense' && !x.out) return false
      if (activeFilter === 'income' && x.out) return false
      if (activeFilter === 'month' && !(x.date || '').startsWith(nowYM)) return false
      if (activeFilter === 'range') {
        const c = toCents(x.amt)
        if (c < 5000 || c > 50000) return false   // ¥50 – ¥500
      }
      return true
    })
  }
  function shiftMonth(ym, delta) {
    const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + delta, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }
  function monthText(ym) { return ym.slice(0, 4) + '年' + Number(ym.slice(5, 7)) + '月' }
  function paintMonth() {
    const t = monthText(viewYM)
    const el = document.getElementById('monthLabel'); if (el) el.textContent = t
    const sub = document.getElementById('ovSub'); if (sub) sub.textContent = t + ' · 你的收支一览'
    const ds = document.getElementById('donutSub'); if (ds) ds.textContent = Number(viewYM.slice(5, 7)) + '月占比'
  }
  function pctChange(cur, prev) { return prev > 0 ? (cur - prev) / prev * 100 : null }

  function render() {
    const live = txs.filter(x => !x.deleted)
    txs.forEach((x, i) => x._i = i)
    document.getElementById('recentList').innerHTML = groupByDate(live.slice(0, 5), false)
    const base = trashView ? txs.filter(x => x.deleted) : live
    const shown = applyFilters(base)
    document.getElementById('fullList').innerHTML = groupByDate(shown, true)
    document.getElementById('txCount').textContent = shown.length
    const et = document.getElementById('emptyTrash')
    if (et) et.textContent = `回收站（${txs.length - live.length}）`
    paintMonth()
    // 汇总：按工具栏选中月份（不再是全量）
    const monthLive = live.filter(x => (x.date || '').startsWith(viewYM))
    const prevLive = live.filter(x => (x.date || '').startsWith(shiftMonth(viewYM, -1)))
    const inc = sumYuan(monthLive.filter(x => !x.out).map(x => x.amt))
    const exp = sumYuan(monthLive.filter(x => x.out).map(x => x.amt))
    const pInc = sumYuan(prevLive.filter(x => !x.out).map(x => x.amt))
    const pExp = sumYuan(prevLive.filter(x => x.out).map(x => x.amt))
    const cards = document.querySelectorAll('#v-overview .card .v')
    if (cards[0]) cards[0].innerHTML = `<span class="cur">¥</span>${exp.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`
    if (cards[1]) cards[1].innerHTML = `<span class="cur">¥</span>${inc.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`
    if (cards[2]) cards[2].innerHTML = `<span class="cur">¥</span>${(inc - exp).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`
    // 卡片副文字：真实环比与储蓄率（替换写死假数据）
    const isCur = viewYM === new Date().toISOString().slice(0, 7)
    const ml = isCur ? '本月' : Number(viewYM.slice(5, 7)) + '月'
    const ks = document.querySelectorAll('#v-overview .stats .card .k')
    if (ks[0]) ks[0].textContent = ml + '支出'
    if (ks[1]) ks[1].textContent = ml + '收入'
    if (ks[2]) ks[2].textContent = ml + '结余'
    const ds = document.querySelectorAll('#v-overview .stats .card .d')
    const dExp = pctChange(exp, pExp), dInc = pctChange(inc, pInc)
    if (ds[0]) ds[0].innerHTML = ml + '环比 ' + (dExp === null ? '<b>—</b>' : `<b class="${dExp > 0 ? 'up' : 'down'}">${dExp > 0 ? '↑' : '↓'} ${Math.abs(dExp).toFixed(1)}%</b>`)
    if (ds[1]) ds[1].innerHTML = ml + '环比 ' + (dInc === null ? '<b>—</b>' : `<b class="${dInc >= 0 ? 'down' : 'up'}">${dInc >= 0 ? '↑' : '↓'} ${Math.abs(dInc).toFixed(1)}%</b>`)
    if (ds[2]) ds[2].textContent = '储蓄率 ' + (inc > 0 ? Math.round((inc - exp) / inc * 100) + '%' : '—')
    // 支出分类环形图（选中月份真实数据）
    renderDonut(monthLive.filter(x => x.out))
    // 近 12 个月收支趋势（以选中月份为终点）
    renderTrend(live)
  }

  function renderTrend(list) {
    const svg = document.querySelector('#v-overview .chart-svg')
    if (!svg) return
    const baseY = Number(viewYM.slice(0, 4)), baseM = Number(viewYM.slice(5, 7))
    const months = []
    for (let i = 11; i >= 0; i--) {
      const d = new Date(baseY, baseM - 1 - i, 1)
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    }
    const buckets = {}
    months.forEach(m => buckets[m] = { income: 0, expense: 0 })
    list.forEach(x => {
      const k = (x.date || '').slice(0, 7)
      if (buckets[k]) buckets[k][x.out ? 'expense' : 'income'] += toCents(x.amt)
    })
    const maxC = Math.max(1, ...months.map(m => Math.max(buckets[m].income, buckets[m].expense)))
    const pts = key => months.map((m, i) =>
      `${(i / 11 * 520).toFixed(1)},${(140 - buckets[m][key] / maxC * 110).toFixed(1)}`).join(' ')
    const incPts = pts('income'), expPts = pts('expense')
    svg.innerHTML = `
      <defs><linearGradient id="gi" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f9e6b" stop-opacity=".22"/><stop offset="1" stop-color="#2f9e6b" stop-opacity="0"/></linearGradient></defs>
      <g stroke="var(--sep)" stroke-width="1"><line x1="0" y1="38" x2="520" y2="38"/><line x1="0" y1="80" x2="520" y2="80"/><line x1="0" y1="122" x2="520" y2="122"/></g>
      <path d="M${incPts.split(' ').join(' L')} L520,150 L0,150Z" fill="url(#gi)"/>
      <polyline points="${incPts}" fill="none" stroke="#2f9e6b" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      <polyline points="${expPts}" fill="none" stroke="#c1504a" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
    const axis = document.querySelector('#v-overview .xaxis')
    if (axis) axis.innerHTML = months.filter((_, i) => i % 2 === 0).map(m => `<span>${Number(m.slice(5))}月</span>`).join('')
  }

  const DONUT_COLORS = ['#4f5bd5', '#7c86ff', '#34c759', '#ff9500', '#c1504a', '#af52de', '#32ade6', '#a2845e']
  function renderDonut(expList) {
    const byCat = {}
    expList.forEach(x => { byCat[x.cat] = (byCat[x.cat] || 0) + toCents(x.amt) })
    const arr = Object.keys(byCat).map(k => {
      const c = catsOut.concat(catsIn).find(z => z.id === k)
      return { name: c ? c.n : k, id: k, c: c ? c.c : '#8e8e93', v: toYuan(byCat[k]) }
    }).sort((a, b) => b.v - a.v)
    const donut = document.querySelector('#v-overview .donut')
    const listEl = document.querySelector('#v-overview .cat-list')
    if (!donut || !listEl) return
    const total = sumYuan(arr.map(a => a.v))
    const center = donut.querySelector('.donut-center b')
    if (center) center.textContent = '¥' + Math.round(total).toLocaleString('zh-CN')
    if (!arr.length) {
      donut.style.background = 'var(--surface2)'
      listEl.innerHTML = '<div style="font-size:12px;color:var(--label3)">本月暂无支出</div>'
      return
    }
    // conic-gradient 按占比连续绘制
    let acc = 0
    const stops = []
    arr.slice(0, 8).forEach((a, i) => {
      const from = acc / total * 100
      acc += toCents(a.v)
      const to = acc / total * 100
      stops.push(`${DONUT_COLORS[i % DONUT_COLORS.length]} ${from}% ${to}%`)
    })
    donut.style.background = `conic-gradient(${stops.join(',')})`
    listEl.innerHTML = arr.slice(0, 8).map((a, i) => {
      const pct = Math.round(toCents(a.v) / toCents(total) * 100)
      return `<div class="cat-row"><i class="dot" style="background:${DONUT_COLORS[i % DONUT_COLORS.length]}"></i><span class="name">${esc(a.name)}</span><span class="amt num">${a.v.toLocaleString('zh-CN')}</span><span class="pct">${pct}%</span></div>`
    }).join('')
  }

  // ---------- 导航 ----------
  document.querySelectorAll('.nav button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.nav button').forEach(x => x.classList.remove('active'))
    b.classList.add('active')
    const v = b.dataset.v
    document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === 'v-' + v))
    document.querySelector('.content').scrollTop = 0
    if (v === 'stats') renderStats()
    if (v === 'cats') renderCats()
  })
  document.querySelectorAll('.link[data-go]').forEach(e => e.onclick = () =>
    document.querySelector(`.nav button[data-v="${e.dataset.go}"]`).click())
  document.querySelectorAll('#segTime button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#segTime button').forEach(x => x.classList.remove('on'))
    b.classList.add('on'); renderStats()
  })
  // 检索 chips（Q11）：类型 / 本月 / 金额区间
  document.querySelectorAll('.chips .chip').forEach(c => c.onclick = () => {
    document.querySelectorAll('.chips .chip').forEach(x => x.classList.remove('on'))
    c.classList.add('on')
    activeFilter = c.dataset.f || 'all'
    render()
  })
  document.querySelector('.search').onclick = async () => {
    const kw = await askConfirm('搜索记录', '输入备注关键词（留空显示全部）：', { input: '备注关键词', okText: '搜索' })
    if (kw === null) return
    searchKw = kw.trim()
    document.querySelector('.nav button[data-v="list"]').click()
    render()
    toast(searchKw ? '搜索：' + searchKw : '已显示全部记录')
  }
  // fullList 统一事件委托（编辑/删除/恢复/小票），innerHTML 重渲染不丢事件
  document.getElementById('fullList').addEventListener('click', async e => {
    const thumb = e.target.closest('.thumb')
    if (thumb) { openReceipt(thumb.dataset.id); return }
    const ed = e.target.closest('.edit')
    if (ed) {
      const rec = txs.find(x => x.id === ed.dataset.id)
      if (rec) openEditor(rec)
      return
    }
    const del = e.target.closest('.del')
    if (del) {
      if (trashView) { await trashRecord(del.dataset.id, 0); toast('记录已恢复'); return }
      const ok = await askConfirm('删除记录', '确定删除这笔记录？可在回收站恢复。', { danger: true, okText: '删除' })
      if (ok) await trashRecord(del.dataset.id, 1)
    }
  })
  // 回收站切换 / 清空
  const emptyTrashEl = document.getElementById('emptyTrash')
  if (emptyTrashEl) emptyTrashEl.onclick = () => {
    trashView = !trashView
    const purge = document.getElementById('purgeTrash')
    if (purge) purge.style.display = trashView ? '' : 'none'
    render()
    toast(trashView ? '回收站：点 ✕ 恢复记录' : '已返回明细')
  }
  const purgeEl = document.getElementById('purgeTrash')
  if (purgeEl) purgeEl.onclick = async () => {
    const ok = await askConfirm('清空回收站', '物理删除所有已删除的记录，此操作不可恢复。', { danger: true, okText: '清空' })
    if (!ok) return
    await purgeTrash()
    toast('回收站已清空')
  }

  // ---------- 统计（Q9/Q10）----------
  function renderStats() {
    const live = txs.filter(x => !x.deleted)
    const dim = (document.querySelector('#segTime button.on') || {}).textContent || '月'
    let list = live
    if (dim === '周') {
      const n = new Date(), day = (n.getDay() + 6) % 7   // 周一=0
      n.setDate(n.getDate() - day); const start = n.toISOString().slice(0, 10)
      list = live.filter(x => x.date >= start)
    }
    else if (dim === '月') { const ym = new Date().toISOString().slice(0, 7); list = live.filter(x => x.date.startsWith(ym)) }
    else if (dim === '年') { const y = new Date().getFullYear(); list = live.filter(x => x.date.startsWith(String(y))) }
    else if (dim === '近3年') { const y = new Date().getFullYear() - 2; list = live.filter(x => +x.date.slice(0, 4) >= y) }
    else if (dim === '近5年') { const y = new Date().getFullYear() - 4; list = live.filter(x => +x.date.slice(0, 4) >= y) }
    // 三张大卡：与下方图表同口径，全部基于 list（真实数据）
    const incC = list.filter(x => !x.out).reduce((a, x) => a + toCents(x.amt), 0)
    const expC = list.filter(x => x.out).reduce((a, x) => a + toCents(x.amt), 0)
    const span = dim === '周' ? 1 : dim === '月' ? 1 : dim === '年' ? 12 : dim === '近3年' ? 36 : dim === '近5年' ? 60 : 1
    const RANGE = { '周': '本周', '月': '本月', '年': '本年', '近3年': '近3年', '近5年': '近5年' }
    const rangeLabel = RANGE[dim] || dim
    const sv = document.querySelectorAll('#v-stats .stats .card .v')
    if (sv[0]) sv[0].innerHTML = `<span class="cur">¥</span>${fmt2(toYuan(incC))}`
    if (sv[1]) sv[1].innerHTML = `<span class="cur">¥</span>${fmt2(toYuan(expC))}`
    if (sv[2]) sv[2].innerHTML = `<span class="cur">¥</span>${fmt2(toYuan(incC - expC))}`
    const sd = document.querySelectorAll('#v-stats .stats .card .d')
    if (sd[0]) sd[0].textContent = rangeLabel
    if (sd[1]) sd[1].textContent = rangeLabel
    if (sd[2]) sd[2].innerHTML = `${rangeLabel}月均 <b>¥${fmt2(toYuan(Math.round((incC - expC) / span)))}</b>`
    const byCat = {}
    list.filter(x => x.out).forEach(x => byCat[x.cat] = (byCat[x.cat] || 0) + toCents(x.amt))
    const arr = Object.keys(byCat).map(k => {
      const c = catsOut.concat(catsIn).find(z => z.id === k)
      return { name: c ? c.n : k, v: toYuan(byCat[k]) }
    }).sort((a, b) => b.v - a.v)
    const max = arr.length ? arr[0].v : 1
    document.getElementById('barChart').innerHTML = arr.length ? arr.map(b =>
      `<div style="display:flex;align-items:center;gap:12px;margin:9px 0">
        <span style="width:44px;font-size:12px;color:var(--label2)">${esc(b.name)}</span>
        <div style="flex:1;background:rgba(120,120,140,.10);border-radius:6px;height:16px;overflow:hidden">
          <div style="width:${b.v / max * 100}%;height:100%;border-radius:6px;background:linear-gradient(90deg,#4f5bd5,#7c86ff);transition:width .7s var(--ease-spring)"></div></div>
        <span class="num" style="width:70px;text-align:right;font-size:13px;font-weight:600">${money(b.v)}</span>
      </div>`).join('') : '<div style="color:var(--label3);font-size:13px;padding:12px">该时间段暂无支出</div>'
    // 热力（当日支出）
    const heat = {}
    list.filter(x => x.out).forEach(x => heat[x.date] = (heat[x.date] || 0) + x.amt)
    const maxH = Math.max(1, ...Object.values(heat))
    let html = ''
    for (let i = 0; i < 126; i++) {
      const d = new Date(); d.setDate(d.getDate() - (125 - i))
      const key = d.toISOString().slice(0, 10)
      const v = heat[key] || 0
      const a = v ? 0.15 + 0.65 * (v / maxH) : 0.06
      html += `<i style="background:rgba(79,91,213,${a.toFixed(2)})" title="${key} ${v ? money(v) : '无支出'}"></i>`
    }
    document.getElementById('heat').innerHTML = html
  }

  // ---------- 分类管理（Q5）----------
  const ICON_CHOICES = ['🍜', '🥬', '🧴', '👗', '🏠', '🚇', '💊', '🎬', '📚', '📦', '💰', '🎁', '🧧', '💼', '✈️', '☕', '🎮', '🐱', '💇', '🎯']
  const COLOR_CHOICES = ['#4f5bd5', '#7c86ff', '#34c759', '#ff9500', '#c1504a', '#af52de', '#32ade6', '#ff2d55', '#6FAE5F', '#A79DA2']
  function renderCats() {
    const card = c => `<div class="catcard${c.custom ? ' custom' : ''}" data-id="${esc(c.id)}" data-kind="${c.kind}">
      <div class="e" style="background:${esc(c.c)}1c">${esc(c.e)}</div><b>${esc(c.n)}</b><span>${c.custom ? '自定义 · 编辑' : '点击编辑'}</span></div>`
    document.getElementById('catGridOut').innerHTML = catsOut.map(card).join('')
    document.getElementById('catGridIn').innerHTML = catsIn.map(card).join('')
  }
  let catMode = 'new', catEditing = null, catPickIcon = '🍜', catPickColor = COLOR_CHOICES[0], catPickKind = 'expense'
  function paintCatChoices() {
    document.getElementById('cat-icons').innerHTML = ICON_CHOICES.map(x =>
      `<i class="${x === catPickIcon ? 'on' : ''}" data-v="${x}">${x}</i>`).join('')
    document.querySelectorAll('#cat-icons i').forEach(i => i.onclick = () => {
      catPickIcon = i.dataset.v
      document.querySelectorAll('#cat-icons i').forEach(x => x.classList.remove('on')); i.classList.add('on')
    })
    document.getElementById('cat-colors').innerHTML = COLOR_CHOICES.map(x =>
      `<i class="${x === catPickColor ? 'on' : ''}" data-v="${x}" style="background:${x}"></i>`).join('')
    document.querySelectorAll('#cat-colors i').forEach(i => i.onclick = () => {
      catPickColor = i.dataset.v
      document.querySelectorAll('#cat-colors i').forEach(x => x.classList.remove('on')); i.classList.add('on')
    })
  }
  function openCatModal(mode, c) {
    catMode = mode; catEditing = c || null
    catPickKind = c ? c.kind : 'expense'
    catPickIcon = c ? c.e : '🍜'
    catPickColor = c ? c.c : COLOR_CHOICES[0]
    document.getElementById('cat-modal-title').textContent = c ? '编辑分类' : '新建分类'
    document.getElementById('cat-name').value = c ? c.n : ''
    document.querySelectorAll('#cat-kind button').forEach(b => b.classList.toggle('on', b.dataset.k === catPickKind))
    document.getElementById('cat-del').style.display = (c && c.custom) ? '' : 'none'
    paintCatChoices()
    document.getElementById('cat-modal').classList.add('show')
  }
  function closeCatModal() { document.getElementById('cat-modal').classList.remove('show') }
  async function saveCategoryFlow() {
    const name = document.getElementById('cat-name').value.trim()
    if (!name) { toast('请输入分类名称'); return }
    const c = {
      id: catEditing ? catEditing.id : cid(), n: name, e: catPickIcon, c: catPickColor,
      kind: catPickKind, custom: catEditing ? catEditing.custom : true
    }
    try {
      if (IN_TAURI) await invoke('save_category', { category: toRustCat(c) })
      const list = c.kind === 'expense' ? catsOut : catsIn
      const idx = list.findIndex(x => x.id === c.id)
      if (idx >= 0) list[idx] = c; else list.push(c)
      catColor[c.id] = c.c
      closeCatModal(); renderCats(); renderPick()
      toast(catMode === 'edit' ? '分类已更新' : '分类已创建')
    } catch (e) { toast('保存失败：' + (e && e.message || e)) }
  }
  async function deleteCategoryFlow() {
    if (!catEditing || !catEditing.custom) return
    const ok = await askConfirm('删除分类', `确定删除「${catEditing.n}」？已使用该分类的记录不会被删除。`, { danger: true, okText: '删除' })
    if (!ok) return
    try {
      if (IN_TAURI) await invoke('delete_category', { id: catEditing.id })
      const list = catEditing.kind === 'expense' ? catsOut : catsIn
      const i = list.findIndex(x => x.id === catEditing.id); if (i >= 0) list.splice(i, 1)
      closeCatModal(); renderCats(); renderPick()
      toast('分类已删除')
    } catch (e) { toast('删除失败：' + (e && e.message || e)) }
  }
  // 事件委托：绑在容器上，innerHTML 重渲染不丢事件
  ;['catGridOut', 'catGridIn'].forEach(id => {
    document.getElementById(id).addEventListener('click', e => {
      const el = e.target.closest('.catcard'); if (!el) return
      const list = id === 'catGridOut' ? catsOut : catsIn
      const c = list.find(x => x.id === el.dataset.id)
      if (c) openCatModal('edit', c)
    })
  })
  document.getElementById('cat-new').onclick = () => openCatModal('new', null)
  document.getElementById('cat-cancel').onclick = closeCatModal
  document.getElementById('cat-modal').onclick = e => { if (e.target.id === 'cat-modal') closeCatModal() }
  document.getElementById('cat-save').onclick = saveCategoryFlow
  document.getElementById('cat-del').onclick = deleteCategoryFlow
  document.querySelectorAll('#cat-kind button').forEach(b => b.onclick = () => {
    catPickKind = b.dataset.k
    document.querySelectorAll('#cat-kind button').forEach(x => x.classList.remove('on')); b.classList.add('on')
  })

  // ---------- 记一笔（Q3/Q4）----------
  // 金额单一数据源为 #amt.value；把任意输入规范化为合法金额字符串（纯函数）
  function sanitizeAmt(raw) {
    let s = String(raw == null ? '' : raw).replace(/[^\d.]/g, '')
    const dot = s.indexOf('.')
    if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '')
    if (s.charAt(0) === '.') s = '0' + s
    s = s.replace(/^0+(?=\d)/, '')
    return s.slice(0, 8)
  }
  let curType = 'out', curCat = 0
  function renderPick() {
    const list = curType === 'out' ? catsOut : catsIn
    document.getElementById('pickcat').innerHTML = list.map((c, i) =>
      `<div class="pc ${i === curCat ? 'on' : ''}" data-i="${i}"><div class="e" style="background:${c.c}22">${c.e}</div><span>${esc(c.n)}</span></div>`).join('')
    document.querySelectorAll('.pc').forEach(p => p.onclick = () => { curCat = +p.dataset.i; renderPick() })
  }
  renderPick()
  let editingId = null
  function openEditor(rec) {
    editingId = rec ? rec.id : null
    document.getElementById('sheet-title').textContent = rec ? '编辑记录' : '记一笔'
    document.getElementById('btnDone').textContent = rec ? '保存修改' : '完成'
    document.getElementById('btnEditDel').style.display = rec ? '' : 'none'
    document.getElementById('amt').value = rec ? String(rec.amt) : '0'
    document.getElementById('note').value = rec ? rec.note : ''
    document.getElementById('tx-date').value = rec ? rec.date : new Date().toISOString().slice(0, 10)
    pendingImage = rec ? (rec.image || '') : null
    curType = rec ? (rec.out ? 'out' : 'in') : 'out'
    const list = curType === 'out' ? catsOut : catsIn
    const idx = rec ? list.findIndex(c => c.id === rec.cat) : 0
    curCat = idx >= 0 ? idx : 0
    document.querySelectorAll('#segType button').forEach(b =>
      b.classList.toggle('on', (b.textContent === '支出') === (curType === 'out')))
    renderPick()
    document.getElementById('backdrop').classList.add('show')
    setTimeout(() => {
      const el = document.getElementById('amt')
      el.focus(); el.select()   // 全选，直接输入即替换
    }, 300)
  }
  document.getElementById('addBtn').onclick = () => openEditor(null)
  document.getElementById('backdrop').onclick = e => { if (e.target.id === 'backdrop') document.getElementById('backdrop').classList.remove('show') }
  document.querySelectorAll('#segType button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#segType button').forEach(x => x.classList.remove('on'))
    b.classList.add('on'); curType = b.textContent === '支出' ? 'out' : 'in'; curCat = 0; renderPick()
  })
  const amtInput = document.getElementById('amt')
  amtInput.addEventListener('input', () => {
    const clean = sanitizeAmt(amtInput.value)
    if (clean !== amtInput.value) amtInput.value = clean   // 回写规范化结果（覆盖粘贴/IME）
  })
  amtInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
  })
  amtInput.addEventListener('blur', () => {
    if (amtInput.value === '' || amtInput.value === '.') amtInput.value = '0'
  })
  async function pickImage() {
    if (!IN_TAURI) { toast('小票图片需 Tauri 环境'); return }
    try {
      const p = await window.__TAURI__.dialog.open({ multiple: false, filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
      if (!p) return
      // 保留原扩展名（此前一律存成 .png，会导致 jpg 小票查看异常）
      const ext = (String(p).split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png'
      pendingImage = await invoke('save_image', { srcPath: p, name: 'receipt_' + Date.now() + '.' + ext })
      toast('小票图片已保存到本地')
    } catch (e) { toast('选择图片失败：' + e) }
  }
  document.getElementById('btnPhoto').onclick = () => pickImage()

  // 小票查看：图片存于 data_dir/images/，经 asset 协议转为可显示 URL
  async function ensureAppDir() {
    if (!IN_TAURI) return ''
    if (!appDir) { try { appDir = await invoke('data_dir') } catch (e) { appDir = '' } }
    return appDir
  }
  async function openReceipt(id) {
    if (!IN_TAURI) { toast('小票查看需 Tauri 环境'); return }
    const rec = txs.find(x => x.id === id)
    if (!rec || !rec.image) return
    const dir = await ensureAppDir()
    if (!dir) { toast('无法定位小票目录'); return }
    const img = document.getElementById('receipt-img')
    const mask = document.getElementById('receipt-modal')
    if (!img || !mask) return
    const full = dir.replace(/[\\/]+$/, '') + '\\images\\' + rec.image
    img.onerror = () => toast('小票文件不存在或已移动')
    img.src = window.__TAURI__.core.convertFileSrc(full)
    mask.classList.add('show')
  }
  const receiptMask = document.getElementById('receipt-modal')
  if (receiptMask) {
    const close = () => receiptMask.classList.remove('show')
    const btn = document.getElementById('receipt-close')
    if (btn) btn.onclick = close
    receiptMask.onclick = e => { if (e.target === receiptMask) close() }
  }
  // 概览「最近记录」也支持点缩略图查看
  const recentEl = document.getElementById('recentList')
  if (recentEl) recentEl.addEventListener('click', e => {
    const t = e.target.closest('.thumb')
    if (t) openReceipt(t.dataset.id)
  })
  document.getElementById('btnDone').onclick = () => commit()
  document.getElementById('btnEditDel').onclick = async () => {
    if (!editingId) return
    const ok = await askConfirm('删除记录', '确定删除这笔记录？可在回收站恢复。', { danger: true, okText: '删除' })
    if (!ok) return
    await trashRecord(editingId, 1)
    document.getElementById('backdrop').classList.remove('show')
    editingId = null
    toast('记录已删除，可在回收站恢复')
  }
  async function purgeTrash() {
    if (IN_TAURI) await invoke('purge_trash')
    else { const list = LS.get().filter(r => !r.deleted); LS.set(list) }
    await loadRecords()
  }
  async function commit() {
    const v = parseFloat(sanitizeAmt(document.getElementById('amt').value))
    if (!v || v <= 0) { toast('请输入金额'); return }
    const list = curType === 'out' ? catsOut : catsIn, c = list[curCat]
    const keep = editingId ? txs.find(x => x.id === editingId) : null
    const d = new Date()
    const x = {
      id: editingId || uid(),
      cat: c.id, ic: c.e, bg: c.c + '1f', out: curType === 'out', amt: v,
      note: document.getElementById('note').value || c.n, image: pendingImage || '',
      date: document.getElementById('tx-date').value || d.toISOString().slice(0, 10),
      ts: keep ? keep.ts : d.getTime(), deleted: keep ? keep.deleted : false
    }
    await saveRecord(x)
    document.getElementById('amt').value = '0'
    document.getElementById('backdrop').classList.remove('show')
    editingId = null
    await loadRecords()
    toast(keep ? '修改已保存' : (curType === 'out' ? '支出 ' : '收入 ') + money(v) + ' 已记录')
  }

  // ---------- 导出 / 备份（Q12/Q22）----------
  async function downloadText(name, text, mime) {
    if (IN_TAURI) {
      try {
        const path = await window.__TAURI__.dialog.save({ defaultPath: name })
        if (path) { await window.__TAURI__.fs.writeTextFile(path, text); toast('已保存到 ' + path); return }
      } catch (e) { /* fall through */ }
    }
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click()
    URL.revokeObjectURL(a.href)
  }
  function buildCSV() {
    const live = txs.filter(x => !x.deleted)
    const escCsv = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'; return s }
    const rows = [['日期', '类型', '分类', '金额', '备注'].join(',')]
    live.forEach(x => {
      const c = catsOut.concat(catsIn).find(z => z.id === x.cat)
      rows.push([x.date, x.out ? '支出' : '收入', c ? c.n : x.cat, x.amt.toFixed(2), x.note].map(escCsv).join(','))
    })
    return rows.join('\r\n')
  }
  // JSON 备份 / 导入（P1）：桌面端走 Rust 命令，浏览器降级走 Blob / FileReader
  function buildBackup() {
    return JSON.stringify({
      app: '简记', version: 1, exportedAt: new Date().toISOString(),
      records: txs.map(toRecord),
      categories: catsOut.concat(catsIn).map(toRustCat),
      settings: {}
    }, null, 2)
  }
  async function exportBackup() {
    const name = '简记-备份-' + new Date().toISOString().slice(0, 10) + '.json'
    if (!IN_TAURI) {
      downloadText(name, buildBackup(), 'application/json')
      toast('JSON 备份已下载')
      return
    }
    try {
      const path = await window.__TAURI__.dialog.save({ defaultPath: name, filters: [{ name: 'JSON 备份', extensions: ['json'] }] })
      if (!path) return
      await invoke('save_backup_to', { path })
      toast('JSON 备份已保存')
    } catch (e) { toast('备份失败：' + (e && e.message || e)) }
  }
  async function importBackup() {
    const ok = await askConfirm('导入 JSON 备份', '导入会覆盖当前全部记录与自定义分类，且不可撤销。确定继续？', { danger: true, okText: '选择文件' })
    if (!ok) return
    if (!IN_TAURI) {
      // 浏览器降级：隐藏 file input 读取本地 JSON
      const input = document.createElement('input')
      input.type = 'file'; input.accept = '.json,application/json'
      input.onchange = () => {
        const f = input.files && input.files[0]
        if (!f) return
        const reader = new FileReader()
        reader.onload = () => {
          try {
            const obj = JSON.parse(String(reader.result || ''))
            if (!obj || !Array.isArray(obj.records)) throw new Error('缺少 records 字段')
            LS.set(obj.records)
            loadRecords()
            toast(`已导入 ${obj.records.length} 条记录`)
          } catch (e) { toast('导入失败：' + (e && e.message || e)) }
        }
        reader.readAsText(f)
      }
      input.click()
      return
    }
    try {
      const p = await window.__TAURI__.dialog.open({ multiple: false, filters: [{ name: 'JSON 备份', extensions: ['json'] }] })
      if (!p) return
      const path = Array.isArray(p) ? p[0] : p
      const n = await invoke('import_backup_from', { path })
      await loadCategories()
      await loadRecords()
      toast(`已导入 ${n} 条记录`)
    } catch (e) { toast('导入失败：' + (e && e.message || e)) }
  }
  const exportCsvEl = document.getElementById('export-csv')
  if (exportCsvEl) exportCsvEl.onclick = async () => {
    await downloadText('简记-流水.csv', buildCSV(), 'text/csv;charset=utf-8'); toast('CSV 已导出')
  }
  const exportJsonEl = document.getElementById('export-json')
  if (exportJsonEl) exportJsonEl.onclick = exportBackup
  const importJsonEl = document.getElementById('import-json')
  if (importJsonEl) importJsonEl.onclick = importBackup

  // toast
  let tt
  function toast(msg) {
    const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show')
    clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2000)
  }

  // ---------- 热更新（自动更新）----------
  async function initUpdater() {
    const $ = id => document.getElementById(id)
    // 浏览器预览：隐藏全部更新入口（保留"当前版本"占位）
    if (!IN_TAURI) {
      ;['row-upd-check', 'row-upd-auto', 'row-upd-src'].forEach(id => { if ($(id)) $(id).style.display = 'none' })
      if ($('upd-curver')) $('upd-curver').textContent = '浏览器预览模式'
      if ($('sideVer')) $('sideVer').textContent = '预览模式'
      return
    }
    try {
      const ver = await window.__TAURI__.app.getVersion()
      if ($('upd-version')) $('upd-version').textContent = 'v' + ver
      if ($('sideVer')) $('sideVer').textContent = 'v' + ver
    } catch (e) { /* 版本显示失败不阻塞 */ }

    // 偏好持久化：复用顶层 getSet/setSet（setSet 失败静默）
    let autoCheck = (await getSet('auto_update_check')) !== '0'   // 默认开
    let src = await getSet('update_source') || 'auto'             // auto | official | mirror

    const autoEl = $('upd-auto')
    if (autoEl) autoEl.classList.toggle('on', autoCheck)
    if (autoEl) autoEl.onclick = () => { autoCheck = !autoCheck; autoEl.classList.toggle('on', autoCheck); setSet('auto_update_check', autoCheck ? '1' : '0').catch(() => {}) }
    const SRC_LABEL = { auto: '自动', official: '官方 GitHub', mirror: '国内镜像' }
    const srcEl = $('upd-src')
    if (srcEl) {
      srcEl.textContent = SRC_LABEL[src] + ' ›'
      srcEl.onclick = () => {
        const order = ['auto', 'official', 'mirror']
        src = order[(order.indexOf(src) + 1) % order.length]
        srcEl.textContent = SRC_LABEL[src] + ' ›'
        setSet('update_source', src).catch(() => {})
        toast('更新下载源：' + SRC_LABEL[src])
      }
    }

    // 检查 + 询问 + 下载安装
    // 状态持久显示在「检查更新」行副文字（upd-status），失败原因不丢失，便于诊断
    // 确认框必须自绘：WebView2 下原生 confirm() 不可靠（对话框不显示 / 同步返回假值）
    const STATUS_EL = $('upd-status')
    const STATUS_DEFAULT = '自动下载并静默安装新版本'
    function setStatus(t) { if (STATUS_EL) STATUS_EL.textContent = t || STATUS_DEFAULT }
    function confirmUpdate(msg) {
      return new Promise(resolve => {
        const mask = $('upd-modal'), msgEl = $('upd-modal-msg')
        if (!mask || !msgEl) { resolve(false); return }
        msgEl.textContent = msg
        mask.classList.add('show')
        const ok = $('upd-modal-ok'), cancel = $('upd-modal-cancel')
        const done = v => {
          mask.classList.remove('show')
          ok.onclick = cancel.onclick = mask.onclick = null
          resolve(v)
        }
        ok.onclick = () => done(true)
        cancel.onclick = () => done(false)
        mask.onclick = e => { if (e.target === mask) done(false) }
      })
    }
    let busy = false
    async function checkAndOffer(silent) {
      if (busy) return
      busy = true
      try {
        if (!silent) { toast('正在检查更新…'); setStatus('正在检查更新…') }
        const meta = await invoke('updater_check', { source: src })
        if (!meta) {
          if (!silent) { toast('当前已是最新版本'); setStatus('当前已是最新版本（' + new Date().toLocaleTimeString() + ' 检查）') }
          return
        }
        setStatus('发现新版本 v' + meta.version)
        const yes = await confirmUpdate(`发现新版本 v${meta.version}（当前 v${meta.current_version}）\n\n${meta.notes || '暂无更新说明'}\n\n立即下载并安装？`)
        if (!yes) { setStatus('已跳过 v' + meta.version + '，可再次点击「立即检查」'); return }
        let lastPct = -10
        const stop = await window.__TAURI__.event.listen('updater://progress', ev => {
          const { downloaded, total } = ev.payload || {}
          if (total) {
            const pct = Math.floor(downloaded / total * 100)
            if (pct >= lastPct + 10) { lastPct = pct; toast(`下载中 ${pct}%`); setStatus('下载中 ' + pct + '%') }
          }
        })
        try {
          toast('开始下载更新…'); setStatus('开始下载更新…')
          await invoke('updater_download_install')
          toast('下载完成，正在安装…'); setStatus('下载完成，正在安装…')
          // Windows 下 install 会自动退出应用；若未退出则主动重启
          setTimeout(async () => {
            try { await window.__TAURI__.process.relaunch() } catch (e) { }
          }, 3000)
        } finally { stop().catch(() => {}) }
      } catch (e) {
        const msg = '检查更新失败：' + (e && e.message || e)
        if (!silent) toast(msg)
        setStatus(msg) // 失败原因持久显示（含静默检查），便于诊断
      } finally { busy = false }
    }
    if ($('upd-check')) $('upd-check').onclick = () => checkAndOffer(false)

    // 启动静默检查：延后 3s 避开启动期 IO，异常吞掉
    if (autoCheck) setTimeout(() => checkAndOffer(true), 3000)
  }

  // ---------- 每日提醒设置 ----------
  async function initReminder() {
    const toggle = document.getElementById('remind-toggle')
    const timeEl = document.getElementById('remind-time')
    const desc = document.getElementById('remind-desc')
    if (!toggle || !timeEl || !desc) return
    let enabled = (await getSet('remind_daily_enabled')) !== '0'   // 默认开
    let time = (await getSet('remind_daily_time')) || '21:00'
    timeEl.value = /^\d{2}:\d{2}$/.test(time) ? time : '21:00'
    toggle.classList.toggle('on', enabled)
    const paint = () => {
      desc.textContent = IN_TAURI
        ? `应用运行时每天 ${timeEl.value} 提醒（关闭应用不提醒）`
        : `浏览器预览：已保存 ${timeEl.value}，不会实际弹通知`
    }
    paint()
    toggle.onclick = async () => {
      enabled = !enabled; toggle.classList.toggle('on', enabled)
      try { await setSet('remind_daily_enabled', enabled ? '1' : '0') }
      catch (e) { enabled = !enabled; toggle.classList.toggle('on', enabled); toast('保存失败，请重试'); return }
      toast(enabled ? '已开启每日提醒' : '已关闭每日提醒')
    }
    timeEl.addEventListener('change', async () => {
      const v = timeEl.value
      if (!/^\d{2}:\d{2}$/.test(v)) { toast('时间格式无效'); timeEl.value = time; return }
      try { await setSet('remind_daily_time', v); time = v; paint(); toast('提醒时间已设为 ' + v) }
      catch (e) { timeEl.value = time; toast('保存失败，请重试') }
    })
  }

  // ---------- 外观（跟随系统 / 浅色 / 深色；手动档持久化）----------
  async function initAppearance() {
    const LABEL = { system: '跟随系统', light: '浅色', dark: '深色' }
    const ORDER = ['system', 'light', 'dark']
    const el = document.getElementById('theme-mode'), desc = document.getElementById('theme-desc')
    const saved = await getSet('theme_mode')
    let cur = ORDER.indexOf(saved) >= 0 ? saved : 'system'
    const apply = () => {
      const root = document.documentElement
      root.classList.toggle('theme-dark', cur === 'dark')
      root.classList.toggle('theme-light', cur === 'light')
      if (el) el.textContent = LABEL[cur] + ' ›'
      if (desc) desc.textContent = cur === 'system' ? '深浅色跟随系统' : '已固定为' + LABEL[cur]
    }
    apply()
    if (el) el.onclick = () => {
      cur = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length]
      apply()
      setSet('theme_mode', cur).catch(() => {})
      toast('外观：' + LABEL[cur])
    }
  }

  // ---------- 月份切换（概览三卡 / 环形图 / 趋势终点）----------
  const monthPill = document.getElementById('monthPill')
  if (monthPill) monthPill.onclick = async () => {
    const v = await askConfirm('切换月份', '输入要查看的月份（格式 YYYY-MM）：', { input: '如 2026-11', inputValue: viewYM, okText: '查看' })
    if (v === null) return
    const ym = String(v).trim()
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) { toast('月份格式应为 YYYY-MM'); return }
    viewYM = ym
    render()
    toast('已切换到 ' + monthText(ym))
  }

  // 启动
  loadRecords()
  loadCategories()
  initReminder()
  initUpdater()
  initAppearance()
})()
