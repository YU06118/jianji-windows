/**
 * shared/schema.js —— 简记双端统一数据契约（Schema）
 *
 * 设计目标（需求文档 Q26）：两端共享数据格式（必须）+ 核心逻辑尽量一致。
 * 桌面端（Tauri/Web）与小程序端（微信原生）都按此契约读写，
 * 使 JSON 备份、扫码迁移、云同步三通道无需字段转换即可互通。
 *
 * 金额口径：一律用「元」的定点数，计算时先转「分」整数再运算，杜绝浮点误差。
 * 与小程序模板 utils/money.js 的 toCents/toYuan 口径完全一致。
 */

// ---------- 记录（Record）----------
// {
//   id:     string   唯一 ID，形如 r<base36><随机>
//   type:   'expense' | 'income'        收支类型（Q3）
//   amount: number>0 金额（元，两位小数）
//   cat:    string   分类 ID（见 categories.js）
//   note:   string   备注文字（Q3），资金来源/去向写在这里（Q2）
//   date:   'YYYY-MM-DD'                 业务日期
//   ts:     number   毫秒时间戳，用于排序
//   image:  string|null                  小票图片：本地相对路径或云端 fileID（Q3/Q20）
//   deleted:boolean                       软删除标记 → 回收站（Q23）
// }
const RECORD_FIELDS = ['id', 'type', 'amount', 'cat', 'note', 'date', 'ts', 'image', 'deleted']

// ---------- 分类（Category）----------
// { id: string, name: string, type: 'expense'|'income', icon: string, color: string, custom: boolean }
// 预设 custom=false；用户自定义 custom=true（Q5）

// ---------- 周期项（Recurring）到期提醒（Q7）----------
// 注意：只提醒、不自动生成记录（需求文档 2.4）
// { id, type, amount, cat, note, dayOfMonth:1-31, enabled:boolean, lastNotifiedMonth:'YYYY-MM' }

// ---------- 设置（Settings）----------
// {
//   currency: 'CNY', decimals: 2,            // Q27 人民币两位小数
//   theme: 'system'|'light'|'dark',          // Q14 冷调黑白灰 + 跟随系统
//   remindDaily: boolean, remindMonthly: boolean,  // Q8
//   syncCode: string|null,                   // 补4 同步码/口令
//   autoSync: boolean,                       // Q22 自动云同步主通道
// }

// ---------- 备份文件（JSON，Q12/Q22）----------
// {
//   app: '简记', version: 1, exportedAt: ISO string,
//   records: Record[], categories: Category[], recurring: Recurring[], settings: Settings
// }

/** 创建一个符合契约的空记录（字段齐全，便于两端一致初始化） */
function makeRecord(patch) {
  const p = patch || {}
  return {
    id: p.id || '',
    type: p.type === 'income' ? 'income' : 'expense',
    amount: Number(p.amount) > 0 ? Number(p.amount) : 0,
    cat: p.cat || '',
    note: String(p.note || ''),
    date: p.date || '',
    ts: Number(p.ts) || 0,
    image: p.image || null,
    deleted: !!p.deleted
  }
}

/** 校验记录字段完整性与取值合法性（纯函数，两端共用） */
function validateRecord(r) {
  if (!r || typeof r !== 'object') return { ok: false, reason: '记录不是对象' }
  if (!r.id) return { ok: false, reason: '缺少 id' }
  if (r.type !== 'expense' && r.type !== 'income') return { ok: false, reason: 'type 非法' }
  if (!(Number(r.amount) > 0)) return { ok: false, reason: 'amount 必须大于 0' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) return { ok: false, reason: 'date 格式应为 YYYY-MM-DD' }
  return { ok: true }
}

module.exports = { RECORD_FIELDS, makeRecord, validateRecord }
