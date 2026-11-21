/** shared/core.test.js —— 核心逻辑确定性单测（Node 直接跑，无依赖） */
const assert = require('assert')
const core = require('./core.js')

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name) }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message) }
}

console.log('=== 金额精度 ===')
t('0.1+0.2 用分计算得 0.3', () => assert.strictEqual(core.sumYuan([0.1, 0.2]), 0.3))
t('大额求和无误', () => assert.strictEqual(core.sumYuan([12800, 35.5, 0.01]), 12835.51))
t('fmt 千分位+两位', () => assert.strictEqual(core.fmt(12800.5, 2), '12,800.50'))
t('fmt 整数不带小数', () => assert.strictEqual(core.fmt(12800), '12,800'))

console.log('=== 日期与周期 ===')
t('monthKey 截取', () => assert.strictEqual(core.monthKey('2026-11-17'), '2026-11'))
t('yearKey 截取', () => assert.strictEqual(core.yearKey('2026-11-17'), '2026'))
t('month 范围判定', () => assert.strictEqual(core.inRange('2026-11-17', 'month', '2026-11-01'), true))
t('跨月不在本月', () => assert.strictEqual(core.inRange('2026-10-17', 'month', '2026-11-01'), false))
t('近3年边界含当年', () => assert.strictEqual(core.inRange('2024-03-01', 'last3y', '2026-11-01'), true))
t('近3年排除更早', () => assert.strictEqual(core.inRange('2023-12-01', 'last3y', '2026-11-01'), false))

const recs = [
  { id: 'r1', type: 'income', amount: 12800, cat: 'salary', note: '工资', date: '2026-11-15', deleted: false },
  { id: 'r2', type: 'expense', amount: 38.5, cat: 'food', note: '午饭', date: '2026-11-17', deleted: false },
  { id: 'r3', type: 'expense', amount: 12, cat: 'transport', note: '地铁', date: '2026-11-17', deleted: false },
  { id: 'r4', type: 'expense', amount: 3200, cat: 'rent', note: '房租', date: '2026-11-05', deleted: true }
]

console.log('=== 检索（Q11）===')
t('默认排除软删除', () => assert.strictEqual(core.filterRecords(recs, {}).length, 3))
t('含删除可见', () => assert.strictEqual(core.filterRecords(recs, { includeDeleted: true }).length, 4))
t('关键词匹配备注', () => assert.strictEqual(core.filterRecords(recs, { keyword: '午饭' }).length, 1))
t('按类型筛选支出', () => assert.strictEqual(core.filterRecords(recs, { type: 'expense' }).length, 2))
t('金额区间筛选', () => assert.strictEqual(core.filterRecords(recs, { amountMin: 30, amountMax: 100 }).length, 1))

console.log('=== 汇总（Q9/Q10）===')
const s = core.summarize(recs)
t('收入汇总', () => assert.strictEqual(s.income, 12800))
t('支出排除软删除', () => assert.strictEqual(s.expense, 50.5))
t('结余', () => assert.strictEqual(s.balance, 12749.5))
t('储蓄率', () => assert.strictEqual(s.savingsRate, 100))
t('分类按金额降序', () => assert.strictEqual(s.byCat[0].cat, 'food'))

console.log('=== 趋势与热力（Q10）===')
const tr = core.trendSeries(recs, 'date')
t('按日趋势分桶（软删除不计入）', () => assert.strictEqual(tr.length, 2))
t('热力图当日支出', () => assert.strictEqual(core.heatmap(recs)['2026-11-17'], 50.5))

console.log('=== 导出（Q12）===')
t('CSV 公式注入加前缀', () => assert.strictEqual(core.csvCell('=SUM(A1)'), "'=SUM(A1)"))
t('CSV 逗号转义', () => assert.strictEqual(core.csvCell('a,b'), '"a,b"'))
const cats = [{ id: 'food', name: '餐饮' }, { id: 'salary', name: '工资' }]
t('CSV 分类名映射', () => assert.ok(core.toCSV(recs, cats).indexOf('餐饮') > 0))
t('备份结构完整', () => {
  const b = core.makeBackup(recs, cats, [], {})
  assert.strictEqual(b.app, '简记'); assert.strictEqual(b.version, 1); assert.strictEqual(b.records.length, 4)
})

console.log('\n==============================================')
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
console.log('==============================================')
process.exit(fail > 0 ? 1 : 0)
