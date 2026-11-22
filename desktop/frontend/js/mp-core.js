/* mp-core.js —— 小程序核心逻辑移植层（utils/* 四件套 + store 数据层适配器）
 * ----------------------------------------------------------------------------
 * 移植来源（jianji-miniprogram main @264ede1）：
 *   utils/money.js · utils/date.js · utils/categories.js · utils/safe.js · utils/store.js
 * 口径完全一致：金额内部「分」整数运算；日期 'YYYY-MM-DD'；月份键 'YYYY-MM'。
 *
 * 与小程序的差异仅在存储介质：
 *   - 流水 → SQLite（Tauri save_record / trash_record / purge_trash），启动一次性载入内存，
 *     之后读写内存 + 写穿持久层（与小程序「月分片 storage」同语义，页面代码无感知）。
 *   - settings / goals / meta → settings KV（键名与小程序完全一致，备份可跨端互导）。
 *   - 写失败可观测性（P0）：任何关键写失败都会触发 writeFailHandler（app 层弹窗）。
 * 浏览器直接打开（非 Tauri）：KV 降级到 localStorage，流水仅内存态。
 */
(function (global) {
  'use strict'

  /* ================= money.js ================= */
  const M = {
    toCents: function (yuan) {
      const n = Number(yuan)
      if (!isFinite(n)) return 0
      return Math.round(n * 100)
    },
    toYuan: function (cents) { return Math.round(cents) / 100 },
    sumYuan: function (list) {
      let c = 0
      for (let i = 0; i < list.length; i++) c += M.toCents(list[i])
      return M.toYuan(c)
    },
    fmt: function (yuan, opts) {
      const o = opts || {}
      const forceDigits = o.digits === undefined ? null : o.digits
      const n = Number(yuan) || 0
      const neg = n < 0
      const abs = Math.abs(n)
      let intPart, decPart
      if (forceDigits === 0) {
        intPart = String(Math.round(abs)); decPart = ''
      } else if (forceDigits === 2) {
        intPart = String(Math.floor(abs + 1e-9))
        decPart = String(Math.round((abs - Math.floor(abs + 1e-9)) * 100)).padStart(2, '0')
      } else {
        const rounded = Math.round(abs * 100) / 100
        if (Math.abs(rounded - Math.round(rounded)) < 1e-9) {
          intPart = String(Math.round(rounded)); decPart = ''
        } else {
          intPart = String(Math.floor(rounded + 1e-9))
          decPart = String(Math.round((rounded - Math.floor(rounded + 1e-9)) * 100)).padStart(2, '0')
        }
      }
      intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      return (neg ? '-' : '') + intPart + (decPart ? '.' + decPart : '')
    },
    yuan: function (v, o) { return '¥' + M.fmt(v, o) },
    short: function (v) {
      const n = Number(v) || 0
      const abs = Math.abs(n)
      if (abs >= 100000000) return (n / 100000000).toFixed(2) + '亿'
      if (abs >= 10000) return (n / 10000).toFixed(abs >= 100000 ? 0 : 1) + '万'
      return M.fmt(n)
    },
    pct: function (part, whole) {
      const w = Number(whole) || 0
      if (w <= 0) return 0
      return Math.round((Number(part) || 0) / w * 100)
    },
    parse: function (str) {
      if (str === null || str === undefined) return 0
      const s = String(str).trim().replace(/[¥,，\s]/g, '')
      if (!s) return 0
      const n = Number(s)
      return isFinite(n) ? M.toYuan(M.toCents(n)) : 0
    }
  }

  /* ================= date.js ================= */
  const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  function pad2(n) { return n < 10 ? '0' + n : '' + n }
  const D = {
    WEEK_CN, pad2,
    toDateStr: function (d) {
      const dt = d instanceof Date ? d : new Date(d)
      return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate())
    },
    toMonthKey: function (d) {
      if (typeof d === 'string' && /^\d{4}-\d{2}$/.test(d)) return d
      const s = typeof d === 'string' ? d : D.toDateStr(d)
      return s.slice(0, 7)
    },
    today: function () { return D.toDateStr(new Date()) },
    thisMonth: function () { return D.today().slice(0, 7) },
    parseMonth: function (ym) {
      const p = String(ym).split('-')
      return { y: Number(p[0]), m: Number(p[1]) }
    },
    daysInMonth: function (ym) {
      const p = D.parseMonth(ym)
      return new Date(p.y, p.m, 0).getDate()
    },
    shiftMonth: function (ym, delta) {
      const p = D.parseMonth(ym)
      const d = new Date(p.y, p.m - 1 + delta, 1)
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1)
    },
    monthLabel: function (ym, opts) {
      const o = opts || {}
      const cur = D.thisMonth()
      if (o.relative !== false) {
        if (ym === cur) return '本月'
        if (ym === D.shiftMonth(cur, -1)) return '上月'
      }
      const p = D.parseMonth(ym)
      return p.y + '年' + p.m + '月'
    },
    daysLeftInMonth: function (ym) {
      if (ym !== D.thisMonth()) return 0
      return Math.max(0, D.daysInMonth(ym) - new Date().getDate() + 1)
    },
    daysPassedInMonth: function (ym) {
      const total = D.daysInMonth(ym)
      if (ym !== D.thisMonth()) return total
      return Math.min(total, new Date().getDate())
    },
    fmtMD: function (dateStr) {
      const p = String(dateStr).split('-')
      if (p.length < 3) return dateStr
      return Number(p[1]) + '月' + Number(p[2]) + '日'
    },
    weekday: function (dateStr) {
      const d = new Date(String(dateStr).replace(/-/g, '/'))
      return WEEK_CN[d.getDay()] || ''
    },
    human: function (dateStr) {
      const t = D.today()
      if (dateStr === t) return '今天 ' + D.weekday(dateStr)
      if (dateStr === D.toDateStr(new Date(Date.now() - 86400000))) return '昨天 ' + D.weekday(dateStr)
      return D.fmtMD(dateStr) + ' ' + D.weekday(dateStr)
    },
    dayOf: function (dateStr) { return Number(String(dateStr).slice(8, 10)) || 0 },
    daysUntil: function (dateStr) {
      if (!dateStr) return null
      const target = new Date(String(dateStr).replace(/-/g, '/') + ' 23:59:59').getTime()
      return Math.ceil((target - Date.now()) / 86400000)
    }
  }

  /* ================= categories.js ================= */
  const EXPENSE_CATS = [
    { key: 'food', name: '餐饮', emoji: '🍜', color: '#E8836A', soft: '#FCEDE8' },
    { key: 'grocery', name: '买菜', emoji: '🥬', color: '#6FAE5F', soft: '#EDF6E9' },
    { key: 'kid', name: '孩子', emoji: '🧸', color: '#E9A23B', soft: '#FEF4E4' },
    { key: 'daily', name: '日用', emoji: '🧴', color: '#4FB3A5', soft: '#E7F6F3' },
    { key: 'clothing', name: '服饰', emoji: '👗', color: '#E5759B', soft: '#FCEBF1' },
    { key: 'home', name: '家庭', emoji: '🏠', color: '#8E7CD1', soft: '#F1EDFB' },
    { key: 'social', name: '人情', emoji: '🧧', color: '#D9736E', soft: '#FBECEB' },
    { key: 'transport', name: '交通', emoji: '🚗', color: '#5B9FE0', soft: '#EAF3FC' },
    { key: 'medical', name: '医疗', emoji: '💊', color: '#3FB0C4', soft: '#E6F6F9' },
    { key: 'fun', name: '娱乐', emoji: '🎬', color: '#A96FC4', soft: '#F6ECFA' },
    { key: 'study', name: '学习', emoji: '📚', color: '#6C7CC9', soft: '#EDF0FB' },
    { key: 'other', name: '其他', emoji: '📦', color: '#A79DA2', soft: '#F3EFEF' }
  ]
  /* 合规口径与小程序一致：invest 显示名「利息」 */
  const INCOME_CATS = [
    { key: 'salary', name: '工资', emoji: '💰', color: '#4CBFA3', soft: '#E8F7F2' },
    { key: 'bonus', name: '奖金', emoji: '🎁', color: '#E9A23B', soft: '#FEF4E4' },
    { key: 'redpack', name: '红包', emoji: '🧧', color: '#D9736E', soft: '#FBECEB' },
    { key: 'invest', name: '利息', emoji: '📈', color: '#5B9FE0', soft: '#EAF3FC' },
    { key: 'other_in', name: '其他', emoji: '📥', color: '#A79DA2', soft: '#F3EFEF' }
  ]
  const ALL_CATS = EXPENSE_CATS.concat(INCOME_CATS)
  const CAT_MAP = {}
  for (let i = 0; i < ALL_CATS.length; i++) CAT_MAP[ALL_CATS[i].key] = ALL_CATS[i]

  const KEYWORDS = {
    kid: ['奶粉', '尿不湿', '纸尿裤', '尿裤', '玩具', '童装', '童鞋', '绘本', '幼儿园', '学费', '疫苗', '儿科', '宝宝', '娃', '乐高', '积木', '辅导班', '兴趣班', '亲子', '儿童', '补习', '奶瓶', '辅食', '婴儿', '幼小衔接', '托管', '夏令营', '游乐场', '儿童医院', '校服'],
    grocery: ['菜市场', '菜场', '超市', '生鲜', '蔬菜', '水果', '排骨', '鸡蛋', '粮油', '大米', '食用油', '海鲜', '猪肉', '牛肉', '鸡肉', '豆制品', '早点', '速冻', '蔬菜店', '菜店', '干货'],
    food: ['早餐', '早餐店', '午餐', '晚餐', '外卖', '吃饭', '餐厅', '饭店', '快餐', '食堂', '奶茶', '咖啡', '烧烤', '火锅', '麦当劳', '肯德基', '星巴克', '汉堡', '面馆', '小吃', '夜宵', '下午茶', '米线', '卤味', '水果茶', '奶茶店', '聚餐', '请客吃饭'],
    home: ['房租', '水费', '电费', '燃气', '煤气', '物业', '宽带', '话费', '手机费', '家电', '冰箱', '洗衣机', '空调', '家具', '维修', '装修', '有线电视', '取暖', '热水器', '油烟机', '床垫', '窗帘'],
    social: ['红包', '礼金', '随礼', '份子', '送礼', '满月', '结婚', '生日礼', '探病', '白事', '红事', '人情', '伴手礼', '孝敬', '压岁钱', '礼盒', '看望'],
    transport: ['打车', '公交', '地铁', '加油', '油费', '停车', '高铁', '火车', '机票', '滴滴', '出租车', '共享单车', '过路费', '洗车', '车险', '违章', '网约车', '电瓶车', '充电桩', '油卡'],
    medical: ['医院', '挂号', '药店', '体检', '看病', '门诊', '住院', '化验', '药费', '牙科', '口腔', '推拿', '理疗', '中医', '疫苗', '拍片', '复诊', '买药'],
    daily: ['纸巾', '洗衣液', '洗洁精', '牙膏', '洗发', '沐浴', '沐浴露', '清洁', '日用品', '垃圾袋', '拖把', '抹布', '收纳', '电池', '雨伞', '拖鞋', '五金', '灯泡', '卫生巾', '湿巾', '洗面奶'],
    clothing: ['衣服', '服装', '裤子', '外套', '鞋', '包包', '化妆品', '护肤', '美妆', '香水', '面膜', '口红', '内衣', '袜', '羽绒服', '卫衣', '连衣裙', '首饰'],
    fun: ['电影', '旅游', '门票', '游乐', 'KTV', '健身', '美容', '按摩', '游戏', '骑行', '露营', '摄影', '演出', '足浴', '美甲', '宠物', '花'],
    study: ['课程', '培训', '网课', '资料', '考试', '报名费', '考证', '教材', '订阅', '会员', '书籍', '买个书', '书店', '学习', '知识付费'],
    invest: ['利息', '存款', '国债', '理财赎回', '理财', '基金', '股票', '分红', '赎回'],
    other: []
  }

  const DEFAULT_QUICK = [
    { type: 'expense', cat: 'food', note: '早餐', amount: 15 },
    { type: 'expense', cat: 'grocery', note: '买菜', amount: 80 },
    { type: 'expense', cat: 'grocery', note: '水果', amount: 45 },
    { type: 'expense', cat: 'kid', note: '奶粉尿裤', amount: 200 },
    { type: 'expense', cat: 'daily', note: '日用', amount: 50 },
    { type: 'expense', cat: 'transport', note: '打车', amount: 25 },
    { type: 'expense', cat: 'food', note: '奶茶', amount: 18 },
    { type: 'expense', cat: 'home', note: '水电燃气', amount: 150 }
  ]
  const BUDGET_CATS = EXPENSE_CATS.filter(function (c) { return c.key !== 'other' })

  const C = {
    EXPENSE_CATS, INCOME_CATS, ALL_CATS, CAT_MAP, KEYWORDS, DEFAULT_QUICK, BUDGET_CATS,
    guess: function (text) {
      const s = String(text || '').trim()
      if (!s) return null
      let best = null
      const keys = Object.keys(KEYWORDS)
      for (let i = 0; i < keys.length; i++) {
        const words = KEYWORDS[keys[i]]
        for (let j = 0; j < words.length; j++) {
          if (s.indexOf(words[j]) >= 0) {
            if (!best || words[j].length > best.len) best = { cat: keys[i], len: words[j].length }
          }
        }
      }
      return best ? best.cat : null
    },
    getCat: function (key) {
      return CAT_MAP[key] || { key: key || 'other', name: '其他', emoji: '📦', color: '#B0A0A4' }
    },
    catName: function (k) { return C.getCat(k).name },
    catEmoji: function (k) { return C.getCat(k).emoji },
    catColor: function (k) { return C.getCat(k).color },
    catsOf: function (type) { return type === 'income' ? INCOME_CATS : EXPENSE_CATS }
  }

  /* ================= safe.js ================= */
  const LIMITS = {
    NOTE: 30, GOAL_NAME: 20, MONTHS: 36, RECORDS_PER_MONTH: 2000, RECORDS_TOTAL: 20000,
    GOALS: 30, CUSTOM_QUICK: 8, ID_LEN: 32,
    AMOUNT_MAX: 9999999.99, DELTA_MAX: 9999999.99,
    IMPORT_TEXT: 2 * 1024 * 1024, YEAR_MIN: 2000, YEAR_MAX: 2100
  }
  const S = {
    LIMITS,
    isMonthKey: function (v) {
      const s = String(v || '')
      if (!/^\d{4}-\d{2}$/.test(s)) return false
      const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7))
      return y >= LIMITS.YEAR_MIN && y <= LIMITS.YEAR_MAX && m >= 1 && m <= 12
    },
    isDateStr: function (v) {
      const s = String(v || '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
      const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10))
      if (y < LIMITS.YEAR_MIN || y > LIMITS.YEAR_MAX) return false
      if (m < 1 || m > 12) return false
      return d >= 1 && d <= new Date(y, m, 0).getDate()
    },
    cleanText: function (v, max) {
      if (v === null || v === undefined) return ''
      let s = String(v)
      s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
      s = s.replace(/[<>]/g, '')
      s = s.trim()
      const cap = max || LIMITS.NOTE
      if (s.length > cap) s = s.slice(0, cap)
      return s
    },
    cleanAmount: function (v) {
      const c = M.toCents(v)
      if (!isFinite(c) || c < 0) return 0
      if (c > M.toCents(LIMITS.AMOUNT_MAX)) return 0
      return M.toYuan(c)
    },
    cleanDelta: function (v) {
      const c = M.toCents(v)
      if (!isFinite(c)) return 0
      const max = M.toCents(LIMITS.DELTA_MAX)
      if (c > max) return M.toYuan(max)
      if (c < -max) return M.toYuan(-max)
      return M.toYuan(c)
    },
    cleanType: function (v) { return v === 'income' ? 'income' : 'expense' },
    cleanCat: function (key, type) {
      const list = C.catsOf(S.cleanType(type))
      const k = String(key || '')
      for (let i = 0; i < list.length; i++) if (list[i].key === k) return k
      return S.cleanType(type) === 'income' ? 'other_in' : 'other'
    },
    cleanDate: function (v) { return S.isDateStr(v) ? String(v) : '' },
    cleanId: function (v) {
      const s = String(v || '')
      return /^[A-Za-z0-9_-]{1,32}$/.test(s) ? s : ''
    },
    cleanTs: function (v, dateStr) {
      const n = Number(v)
      const min = new Date(LIMITS.YEAR_MIN + '-01-01').getTime()
      const max = Date.now() + 86400000
      if (isFinite(n) && n >= min && n <= max) return Math.round(n)
      const t = new Date(String(dateStr).replace(/-/g, '/') + ' 12:00:00').getTime()
      return isFinite(t) ? t : Date.now()
    },
    cleanRecord: function (r, uid) {
      if (!r || typeof r !== 'object') return null
      const type = S.cleanType(r.type)
      const date = S.cleanDate(r.date)
      if (!date) return null
      const amount = S.cleanAmount(r.amount)
      if (!(amount > 0)) return null
      return {
        id: S.cleanId(r.id) || uid('r'),
        type: type, amount: amount,
        cat: S.cleanCat(r.cat, type),
        note: S.cleanText(r.note, LIMITS.NOTE),
        date: date, ts: S.cleanTs(r.ts, date)
      }
    },
    cleanGoal: function (g, uid) {
      if (!g || typeof g !== 'object') return null
      const name = S.cleanText(g.name, LIMITS.GOAL_NAME)
      if (!name) return null
      const target = S.cleanAmount(g.target)
      if (!(target > 0)) return null
      const saved = Math.min(S.cleanAmount(g.saved), LIMITS.AMOUNT_MAX)
      const logs = []
      if (Array.isArray(g.logs)) {
        const cap = Math.min(g.logs.length, 500)
        for (let i = 0; i < cap; i++) {
          const l = g.logs[i]
          if (!l || typeof l !== 'object') continue
          const amt = S.cleanDelta(l.amount)
          if (!amt) continue
          const date = S.cleanDate(l.date) || D.today()
          logs.push({ amount: amt, date: date, ts: S.cleanTs(l.ts, date), note: S.cleanText(l.note, LIMITS.NOTE) })
        }
      }
      return {
        id: S.cleanId(g.id) || uid('g'),
        name: name,
        emoji: S.cleanText(g.emoji, 4) || '🎯',
        target: target, saved: saved,
        deadline: S.cleanDate(g.deadline),
        createdAt: S.cleanTs(g.createdAt, D.today()),
        logs: logs
      }
    },
    cleanSettings: function (s) {
      const out = {}
      if (!s || typeof s !== 'object') return out
      if (typeof s.budget === 'object' && s.budget) {
        const b = {}
        b.total = S.cleanAmount(s.budget.total)
        const cb = {}
        if (s.budget.cats && typeof s.budget.cats === 'object') {
          Object.keys(s.budget.cats).forEach(function (k) {
            const key = S.cleanCat(k, 'expense')
            const v = S.cleanAmount(s.budget.cats[k])
            if (v > 0) cb[key] = v
          })
        }
        b.cats = cb
        out.budget = b
      }
      if (typeof s.nickname === 'string') out.nickname = S.cleanText(s.nickname, 12)
      if (typeof s.theme === 'string' && /^[a-z]{2,12}$/.test(s.theme)) out.theme = s.theme
      if (['dark', 'light', 'system'].indexOf(s.appearance) >= 0) out.appearance = s.appearance
      if (Array.isArray(s.customQuick)) {
        out.customQuick = s.customQuick.slice(0, LIMITS.CUSTOM_QUICK).map(function (it) {
          if (!it || typeof it !== 'object') return null
          const cat = S.cleanCat(it.cat, 'expense')
          if (!cat) return null
          const amount = S.cleanAmount(it.amount)
          if (!(amount > 0)) return null
          return { cat: cat, note: S.cleanText(it.note, LIMITS.NOTE), amount: amount }
        }).filter(Boolean)
      }
      return out
    },
    parseBackup: function (text, uid) {
      const raw = String(text === null || text === undefined ? '' : text)
      if (!raw.trim()) return { ok: false, msg: '没读到内容，请先复制备份文本' }
      if (raw.length > LIMITS.IMPORT_TEXT) {
        return { ok: false, msg: '备份内容过大（超过 2MB），请确认复制的是简记的备份' }
      }
      let data
      try { data = JSON.parse(raw) } catch (e) {
        return { ok: false, msg: '文本格式不对，请检查是否完整复制了备份内容' }
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, msg: '这不是简记的备份内容' }
      }
      if (data.app !== 'mama-ledger') return { ok: false, msg: '这不是简记的备份内容' }
      if (!data.months || typeof data.months !== 'object' || Array.isArray(data.months)) {
        return { ok: false, msg: '备份里没有找到账目数据' }
      }
      const ymList = Object.keys(data.months).filter(S.isMonthKey)
      if (ymList.length > LIMITS.MONTHS) {
        return { ok: false, msg: '备份月份过多（上限 ' + LIMITS.MONTHS + ' 个月），已拒绝导入' }
      }
      const months = {}
      let kept = 0, dropped = 0
      for (let i = 0; i < ymList.length; i++) {
        const ym = ymList[i]
        const list = Array.isArray(data.months[ym]) ? data.months[ym] : []
        const out = []
        const cap = Math.min(list.length, LIMITS.RECORDS_PER_MONTH)
        for (let j = 0; j < cap; j++) {
          const rec = S.cleanRecord(list[j], uid)
          if (rec) {
            if (D.toMonthKey(rec.date) === ym) { out.push(rec); kept++ } else dropped++
          } else dropped++
          if (kept >= LIMITS.RECORDS_TOTAL) break
        }
        if (out.length) months[ym] = out
        if (kept >= LIMITS.RECORDS_TOTAL) break
      }
      const goals = []
      if (Array.isArray(data.goals)) {
        const gcap = Math.min(data.goals.length, LIMITS.GOALS)
        for (let i = 0; i < gcap; i++) {
          const g = S.cleanGoal(data.goals[i], uid)
          if (g) goals.push(g)
        }
      }
      return {
        ok: true, months: months,
        settings: S.cleanSettings(data.settings),
        goals: goals, kept: kept, dropped: dropped,
        msg: '已恢复 ' + kept + ' 笔记录、' + goals.length + ' 个攒钱目标' +
          (dropped ? '（已跳过 ' + dropped + ' 条异常数据）' : '')
      }
    }
  }

  /* ================= store.js（存储适配器） ================= */
  const IN_TAURI = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
  const invoke = IN_TAURI
    ? function (cmd, args) { return window.__TAURI_INTERNALS__.invoke(cmd, args || {}) }
    /* 浏览器降级：流水命令空操作成功（仅内存态，便于无 Rust 环境预览）；KV 走 localStorage */
    : function () { return Promise.resolve() }

  const K_INDEX = 'ledger_index_v1'   // 兼容键：月索引不再单存（由流水派生），仅清空时清理
  const K_SETTINGS = 'ledger_settings_v1'
  const K_GOALS = 'ledger_goals_v1'
  const K_META = 'ledger_meta_v1'

  const KV = {
    async get(key, def) {
      try {
        let v = null
        if (IN_TAURI) v = await invoke('get_setting', { key: key })
        else v = localStorage.getItem('jianji_kv_' + key)
        if (v === null || v === undefined || v === '') return def
        return JSON.parse(v)
      } catch (e) { return def }
    },
    async set(key, val) {
      const s = JSON.stringify(val)
      if (IN_TAURI) return invoke('set_setting', { key: key, value: s })
      localStorage.setItem('jianji_kv_' + key, s)
      return Promise.resolve()
    },
    async remove(key) {
      if (IN_TAURI) return invoke('set_setting', { key: key, value: '' })
      localStorage.removeItem('jianji_kv_' + key)
      return Promise.resolve()
    }
  }

  let _months = {}          // { 'YYYY-MM': [记录...] }，记录为小程序口径 {id,type,amount(元),cat,note,date,ts}
  let _settings = null
  let _goals = []
  let _meta = {}
  let _lastCriticalOk = true
  let _writeFailHandler = null

  function uid(prefix) {
    return (prefix || 'r') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  }

  function setWriteFailHandler(fn) { _writeFailHandler = typeof fn === 'function' ? fn : null }
  function lastWriteOk() { return _lastCriticalOk }

  async function writeOrWarn(fn) {
    let ok = false
    try { await fn(); ok = true } catch (e) { ok = false }
    _lastCriticalOk = ok
    if (!ok && _writeFailHandler) { try { _writeFailHandler() } catch (ignore) {} }
    return ok
  }

  /* ---- 记录：小程序口径 ↔ SQLite 口径 ---- */
  function toDb(r) {
    return {
      id: r.id, kind: r.type, amount: M.toCents(r.amount),
      cat: r.cat, note: r.note || '', date: r.date,
      ts: r.ts || Date.now(), image: '', deleted: 0
    }
  }
  function fromDb(r) {
    if (r.deleted) return null
    const type = r.kind === 'income' ? 'income' : 'expense'
    return {
      id: r.id, type: type, amount: M.toYuan(r.amount),
      cat: S.cleanCat(r.cat, type),
      note: S.cleanText(r.note, LIMITS.NOTE),
      date: S.isDateStr(r.date) ? r.date : D.today(),
      ts: S.cleanTs(r.ts, r.date)
    }
  }

  function defaultSettings() {
    return {
      budget: { total: 0, cats: {} },
      currency: '¥',
      theme: 'pink',
      appearance: 'dark',
      nickname: '',
      seeded: false,
      customQuick: []
    }
  }

  const THEMES = ['pink', 'lilac', 'blue', 'matcha']
  const THEME_NAMES = { pink: '系统蓝', lilac: '紫罗兰', blue: '青蓝', matcha: '森绿' }
  /* 与 app.wxss .t-xxx 的 --accent-solid（浅色档）逐一对齐，图表柱色用 */
  const THEME_NAV = { pink: '#0078D4', lilac: '#6B4EFF', blue: '#00809D', matcha: '#0E7C3A' }

  const store = {
    IN_TAURI, uid,
    setWriteFailHandler, lastWriteOk,

    async init() {
      _settings = await KV.get(K_SETTINGS, null)
      if (!_settings || typeof _settings !== 'object') _settings = defaultSettings()
      if (!_settings.budget) _settings.budget = { total: 0, cats: {} }
      if (!_settings.budget.cats) _settings.budget.cats = {}
      if (!_settings.seeded) _settings.seeded = false
      if (!Array.isArray(_settings.customQuick)) _settings.customQuick = []

      _goals = await KV.get(K_GOALS, [])
      if (!Array.isArray(_goals)) _goals = []

      _meta = await KV.get(K_META, {})
      if (!_meta || typeof _meta !== 'object') _meta = {}
      if (!_meta.createdAt) {
        _meta.createdAt = Date.now()
        await KV.set(K_META, _meta)
      }

      _months = {}
      if (IN_TAURI) {
        try {
          const rows = await invoke('list_records', { includeDeleted: 0 })
          for (let i = 0; i < rows.length; i++) {
            const rec = fromDb(rows[i])
            if (!rec) continue
            const ym = D.toMonthKey(rec.date)
            if (!_months[ym]) _months[ym] = []
            _months[ym].push(rec)
          }
          Object.keys(_months).forEach(function (ym) {
            _months[ym].sort(function (a, b) { return (b.ts || 0) - (a.ts || 0) })
          })
        } catch (e) { _months = {} }
      }
    },

    /* ---- 月份索引（由内存流水派生，降序） ---- */
    getMonthKeys() {
      const keys = Object.keys(_months).filter(S.isMonthKey)
      keys.sort(function (a, b) { return a < b ? 1 : (a > b ? -1 : 0) })
      return keys.slice(0, S.LIMITS.MONTHS + 12)
    },

    getRecords(ym) {
      if (!S.isMonthKey(ym)) return []
      const list = _months[ym] || []
      return list.slice(0, S.LIMITS.RECORDS_PER_MONTH)
    },

    async saveRecords(ym, list) {
      if (!S.isMonthKey(ym)) return
      const safeList = (Array.isArray(list) ? list : []).slice(0, S.LIMITS.RECORDS_PER_MONTH)
      const old = _months[ym] || []
      const keep = {}
      for (let i = 0; i < safeList.length; i++) keep[safeList[i].id] = true
      const removed = old.filter(function (r) { return !keep[r.id] })
      return writeOrWarn(async function () {
        for (let i = 0; i < removed.length; i++) {
          await invoke('trash_record', { id: removed[i].id, deleted: 1 })
        }
        for (let i = 0; i < safeList.length; i++) {
          await invoke('save_record', { record: toDb(safeList[i]) })
        }
        if (!IN_TAURI) { /* 浏览器降级：仅内存 */ }
        _months[ym] = safeList.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0) })
        if (!_months[ym].length) delete _months[ym]
      })
    },

    async addRecord(rec) {
      const r = rec && typeof rec === 'object' ? rec : {}
      const date = S.cleanDate(r.date) || D.today()
      const ym = D.toMonthKey(date)
      const amount = S.cleanAmount(r.amount)
      if (!(amount > 0)) return null
      const type = S.cleanType(r.type)
      const item = {
        id: S.cleanId(r.id) || uid('r'),
        type: type, amount: amount,
        cat: S.cleanCat(r.cat, type),
        note: S.cleanText(r.note, S.LIMITS.NOTE),
        date: date, ts: S.cleanTs(r.ts, date)
      }
      const ok = await writeOrWarn(async function () {
        await invoke('save_record', { record: toDb(item) })
        if (!_months[ym]) _months[ym] = []
        _months[ym].unshift(item)
        _months[ym].sort(function (a, b) { return (b.ts || 0) - (a.ts || 0) })
      })
      return ok ? item : null
    },

    async deleteRecord(ym, id) {
      const list = (S.isMonthKey(ym) ? (_months[ym] || []) : []).filter(function (r) { return r.id !== id })
      const ok = await writeOrWarn(async function () {
        await invoke('trash_record', { id: id, deleted: 1 })
        if (_months[ym]) {
          _months[ym] = list
          if (!list.length) delete _months[ym]
        }
      })
      return ok ? list : S.isMonthKey(ym) ? (_months[ym] || []) : []
    },

    async updateRecord(ym, id, patch) {
      const p = patch && typeof patch === 'object' ? patch : {}
      const list = (S.isMonthKey(ym) ? (_months[ym] || []) : []).map(function (r) {
        if (r.id !== id) return r
        const type = S.cleanType(p.type === undefined ? r.type : p.type)
        const date = S.cleanDate(p.date) || r.date
        return {
          id: r.id, type: type,
          amount: S.cleanAmount(p.amount === undefined ? r.amount : p.amount),
          cat: S.cleanCat(p.cat === undefined ? r.cat : p.cat, type),
          note: S.cleanText(p.note === undefined ? r.note : p.note, S.LIMITS.NOTE),
          date: date, ts: S.cleanTs(p.ts === undefined ? r.ts : p.ts, date)
        }
      })
      if (S.isMonthKey(ym)) _months[ym] = list
      await store.saveRecords(ym, list)
      return list
    },

    getAllRecords(monthsLimit) {
      const keys = store.getMonthKeys()
      const use = keys.slice(0, monthsLimit || 3)
      let out = []
      for (let i = 0; i < use.length; i++) out = out.concat(store.getRecords(use[i]))
      return out
    },

    /* ---- 设置 ---- */
    getSettings() { return _settings || defaultSettings() },
    async saveSettings(s) {
      const merged = Object.assign(defaultSettings(), store.getSettings(), S.cleanSettings(s))
      const ok = await writeOrWarn(async function () { await KV.set(K_SETTINGS, merged) })
      if (ok) _settings = merged
      return merged
    },
    getCustomQuick() {
      const s = store.getSettings()
      return Array.isArray(s.customQuick) ? s.customQuick : []
    },
    async saveCustomQuick(list) {
      const s = store.getSettings()
      s.customQuick = Array.isArray(list) ? list : []
      const merged = await store.saveSettings(s)
      return Array.isArray(merged.customQuick) && !!lastWriteOk()
    },

    getMeta() { return _meta && typeof _meta === 'object' ? _meta : {} },
    async saveMeta(m) { _meta = m; await KV.set(K_META, m); return m },

    /* ---- 主题 ---- */
    getTheme() {
      const t = String(store.getSettings().theme || 'pink')
      return THEMES.indexOf(t) >= 0 ? t : 'pink'
    },
    themeClass() { return 't-' + store.getTheme() },
    themeColor() { return THEME_NAV[store.getTheme()] || THEME_NAV.pink },
    themeTint(t) {
      const base = store.themeColor()
      const n = Math.max(0, Math.min(0.85, Number(t) || 0))
      const ch = [1, 3, 5].map(function (i) {
        const c = parseInt(base.slice(i, i + 2), 16)
        const v = Math.round(c + (255 - c) * n)
        return ((v < 16 ? '0' : '') + v.toString(16)).toUpperCase()
      })
      return '#' + ch.join('')
    },
    async setTheme(name) {
      const t = String(name || '')
      if (THEMES.indexOf(t) === -1) return store.getTheme()
      await store.saveSettings({ theme: t })
      return t
    },
    themeList() {
      return THEMES.map(function (k) { return { key: k, name: THEME_NAMES[k], cls: 't-' + k } })
    },

    /* ---- 外观模式 ---- */
    async setAppearance(v) {
      const a = String(v || '')
      if (['dark', 'light', 'system'].indexOf(a) === -1) return store.getAppearance()
      await store.saveSettings({ appearance: a })
      return a
    },
    getAppearance() {
      const a = String(store.getSettings().appearance || 'dark')
      return ['dark', 'light', 'system'].indexOf(a) >= 0 ? a : 'dark'
    },
    systemIsDark() {
      try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch (e) { return false }
    },
    isDark() {
      const a = store.getAppearance()
      return a === 'dark' || (a === 'system' && store.systemIsDark())
    },
    modeClass() { return store.isDark() ? 'mode-dark' : 'mode-light' },
    appearanceList() {
      return [{ key: 'dark', name: '深色' }, { key: 'light', name: '浅色' }, { key: 'system', name: '跟随系统' }]
    },

    /* ---- 攒钱目标 ---- */
    getGoals() { return Array.isArray(_goals) ? _goals.slice(0, S.LIMITS.GOALS) : [] },
    async saveGoals(list) {
      const safeList = (Array.isArray(list) ? list : []).slice(0, S.LIMITS.GOALS)
      const ok = await writeOrWarn(async function () { await KV.set(K_GOALS, safeList) })
      if (ok) _goals = safeList
      return safeList
    },
    async addGoal(goal) {
      const item = S.cleanGoal(goal, uid)
      if (!item) return null
      const list = store.getGoals()
      list.push(item)
      await store.saveGoals(list)
      return lastWriteOk() ? item : null
    },
    async updateGoal(id, patch) {
      const p = patch && typeof patch === 'object' ? patch : {}
      const list = store.getGoals().map(function (g) {
        if (g.id !== id) return g
        return {
          id: g.id,
          name: S.cleanText(p.name === undefined ? g.name : p.name, S.LIMITS.GOAL_NAME) || g.name,
          emoji: S.cleanText(p.emoji === undefined ? g.emoji : p.emoji, 4) || g.emoji,
          target: S.cleanAmount(p.target === undefined ? g.target : p.target) || g.target,
          saved: Math.max(0, S.cleanAmount(p.saved === undefined ? g.saved : p.saved)),
          deadline: p.deadline === undefined ? g.deadline : S.cleanDate(p.deadline),
          createdAt: g.createdAt,
          logs: Array.isArray(g.logs) ? g.logs.slice(-500) : []
        }
      })
      await store.saveGoals(list)
      return list
    },
    async deleteGoal(id) {
      const list = store.getGoals().filter(function (g) { return g.id !== id })
      await store.saveGoals(list)
      return list
    },
    async depositToGoal(id, delta, note) {
      const d = S.cleanDelta(delta)
      if (!d) return store.getGoals()
      const list = store.getGoals().map(function (g) {
        if (g.id !== id) return g
        const next = Object.assign({}, g)
        const raw = M.toCents(next.saved) + M.toCents(d)
        next.saved = M.toYuan(Math.max(0, Math.min(raw, M.toCents(S.LIMITS.AMOUNT_MAX))))
        next.logs = (Array.isArray(next.logs) ? next.logs : []).slice(-499).concat([{
          amount: d, date: D.today(), ts: Date.now(), note: S.cleanText(note, S.LIMITS.NOTE)
        }])
        return next
      })
      await store.saveGoals(list)
      return list
    },

    /* ---- 统计聚合（与小程序 store.js 逐行同口径） ---- */
    summary(ym) {
      const month = ym || D.thisMonth()
      const list = store.getRecords(month)
      const expenseList = list.filter(function (r) { return r.type === 'expense' })
      const incomeList = list.filter(function (r) { return r.type === 'income' })
      const expense = M.sumYuan(expenseList.map(function (r) { return r.amount }))
      const income = M.sumYuan(incomeList.map(function (r) { return r.amount }))

      const catMap = {}
      for (let i = 0; i < expenseList.length; i++) {
        const r = expenseList[i]
        if (!catMap[r.cat]) catMap[r.cat] = { key: r.cat, amount: 0, count: 0, cents: 0 }
        catMap[r.cat].cents += M.toCents(r.amount)
        catMap[r.cat].count += 1
      }
      const byCat = Object.keys(catMap).map(function (k) {
        const c = catMap[k]
        const meta = C.getCat(k)
        return {
          key: k, name: meta.name, emoji: meta.emoji, color: meta.color,
          amount: M.toYuan(c.cents), count: c.count,
          pct: expense > 0 ? Math.round(M.toYuan(c.cents) / expense * 100) : 0
        }
      })
      byCat.sort(function (a, b) { return b.amount - a.amount })

      const total = D.daysInMonth(month)
      const byDay = []
      for (let d = 1; d <= total; d++) byDay.push({ day: d, amount: 0 })
      for (let i = 0; i < expenseList.length; i++) {
        const day = D.dayOf(expenseList[i].date)
        if (day >= 1 && day <= total) byDay[day - 1].amount += M.toCents(expenseList[i].amount)
      }
      for (let i = 0; i < byDay.length; i++) byDay[i].amount = M.toYuan(byDay[i].amount)
      let maxDay = { day: 0, amount: 0 }
      for (let i = 0; i < byDay.length; i++) {
        if (byDay[i].amount > maxDay.amount) maxDay = { day: byDay[i].day, amount: byDay[i].amount }
      }
      const passed = D.daysPassedInMonth(month)
      return {
        ym: month, expense, income,
        balance: M.toYuan(M.toCents(income) - M.toCents(expense)),
        count: list.length, dayCount: expenseList.length,
        byCat, byDay, maxDay,
        topCat: byCat.length ? byCat[0] : null,
        avgPerDay: passed > 0 ? M.toYuan(Math.round(M.toCents(expense) / passed)) : 0,
        passed
      }
    },

    recentMonths(n, endYm) {
      const end = endYm || D.thisMonth()
      const out = []
      for (let i = n - 1; i >= 0; i--) {
        const ym = D.shiftMonth(end, -i)
        const list = store.getRecords(ym).filter(function (r) { return r.type === 'expense' })
        const cents = list.reduce(function (s, r) { return s + M.toCents(r.amount) }, 0)
        const p = D.parseMonth(ym)
        out.push({ ym: ym, label: p.m + '月', amount: M.toYuan(cents) })
      }
      return out
    },

    recentDays(n) {
      const out = []
      const base = Date.now()
      const monthCache = {}
      for (let i = n - 1; i >= 0; i--) {
        const d = new Date(base - i * 86400000)
        const ds = D.toDateStr(d)
        const ym = ds.slice(0, 7)
        if (!Object.prototype.hasOwnProperty.call(monthCache, ym)) monthCache[ym] = store.getRecords(ym)
        const list = monthCache[ym].filter(function (r) { return r.type === 'expense' && r.date === ds })
        const cents = list.reduce(function (s, r) { return s + M.toCents(r.amount) }, 0)
        out.push({ date: ds, label: ds.slice(8, 10), amount: M.toYuan(cents) })
      }
      return out
    },

    budgetStatus(ym) {
      const month = ym || D.thisMonth()
      const s = store.getSettings()
      const total = M.parse(s.budget.total)
      const sum = store.summary(month)
      const used = sum.expense
      const daysLeft = Math.max(0, D.daysInMonth(month) - D.daysPassedInMonth(month)) + (month === D.thisMonth() ? 1 : 0)
      const passed = Math.max(1, D.daysPassedInMonth(month))
      const left = M.toYuan(M.toCents(total) - M.toCents(used))
      const pct = total > 0 ? Math.min(999, Math.round(used / total * 100)) : 0
      const monthDays = D.daysInMonth(month)
      const timeRatio = passed / monthDays
      const moneyRatio = total > 0 ? used / total : 0
      const pace = total > 0 ? moneyRatio - timeRatio : 0
      const avgPerDay = used / passed
      const forecast = M.toYuan(Math.round(M.toCents(avgPerDay) * monthDays))
      const forecastOver = M.toYuan(Math.max(0, M.toCents(forecast) - M.toCents(total)))
      let status = 'ok'
      if (total > 0) {
        if (pct >= 100) status = 'over'
        else if (pct >= 80 || pace >= 0.15) status = 'warn'
      }
      const dailyLeft = daysLeft > 0 && left > 0
        ? M.toYuan(Math.round(M.toCents(left) / daysLeft)) : 0
      const suggestDaily = total > 0 ? M.toYuan(Math.round(M.toCents(total) / monthDays)) : 0

      const cats = []
      const catBudget = s.budget.cats || {}
      const catUsedMap = {}
      for (let i = 0; i < sum.byCat.length; i++) catUsedMap[sum.byCat[i].key] = sum.byCat[i].amount
      Object.keys(catBudget).forEach(function (k) {
        const b = M.parse(catBudget[k])
        if (b <= 0) return
        const u = catUsedMap[k] || 0
        const p = Math.round(u / b * 100)
        const meta = C.getCat(k)
        cats.push({
          key: k, name: meta.name, emoji: meta.emoji, color: meta.color,
          budget: b, used: u,
          left: M.toYuan(M.toCents(b) - M.toCents(u)),
          pct: p,
          status: p >= 100 ? 'over' : (p >= 80 ? 'warn' : 'ok')
        })
      })
      cats.sort(function (a, b) { return b.pct - a.pct })

      const advice = buildAdvice({ total, used, left, pct, status, daysLeft, dailyLeft, forecast, forecastOver, pace, cats })
      const tone = status === 'over' ? 'over' : (status === 'warn' ? 'warn' : 'ok')
      return {
        hasBudget: total > 0, total, used, left, pct, status, tone,
        daysLeft: month === D.thisMonth() ? D.daysLeftInMonth(month) : 0,
        dailyLeft, suggestDaily,
        avgPerDay: M.toYuan(Math.round(M.toCents(avgPerDay))),
        forecast, forecastOver,
        pace: Math.round(pace * 100),
        cats, advice
      }
    },

    quickTags(limit) {
      const max = limit || 6
      const all = store.getAllRecords(3)
      const groups = {}
      for (let i = 0; i < all.length; i++) {
        const r = all[i]
        const label = r.note || C.catName(r.cat)
        const key = r.type + '|' + r.cat + '|' + label
        if (!groups[key]) {
          groups[key] = { type: r.type, cat: r.cat, label: label, count: 0, amounts: {}, lastTs: 0, lastAmount: 0, lastOccTs: -1 }
        }
        const g = groups[key]
        const a = M.parse(r.amount)
        const ts = r.ts || 0
        g.count += 1
        g.amounts[a] = (g.amounts[a] || 0) + 1
        if (ts > g.lastTs) g.lastTs = ts
        if (ts > g.lastOccTs) { g.lastOccTs = ts; g.lastAmount = a }
      }
      const arr = []
      Object.keys(groups).forEach(function (k) {
        const g = groups[k]
        if (g.count < 2) return
        let bestAmt = g.lastAmount, bestN = 0
        Object.keys(g.amounts).forEach(function (a) {
          const n = g.amounts[a]
          if (n > bestN) { bestN = n; bestAmt = Number(a) }
        })
        if (bestN <= 1) bestAmt = g.lastAmount
        arr.push({ type: g.type, cat: g.cat, note: g.label, amount: bestAmt, count: g.count, learned: true, lastTs: g.lastTs })
      })
      arr.sort(function (a, b) {
        if (b.count !== a.count) return b.count - a.count
        return b.lastTs - a.lastTs
      })
      const out = arr.slice(0, max)
      if (out.length < 4) {
        const used = {}
        for (let i = 0; i < out.length; i++) used[out[i].cat + '|' + out[i].note] = true
        for (let i = 0; i < C.DEFAULT_QUICK.length; i++) {
          const d = C.DEFAULT_QUICK[i]
          if (out.length >= max) break
          if (used[d.cat + '|' + d.note]) continue
          out.push({ type: d.type, cat: d.cat, note: d.note, amount: d.amount, count: 0, learned: false })
        }
      }
      return out
    },

    stats() {
      const keys = store.getMonthKeys()
      let total = 0
      for (let i = 0; i < keys.length; i++) total += store.getRecords(keys[i]).length
      const meta = store.getMeta()
      return {
        months: keys.length, records: total,
        firstDate: keys.length ? keys[keys.length - 1] + '-01' : '',
        createdAt: meta.createdAt || 0
      }
    },

    /* ---- 备份与恢复（备份格式与小程序完全一致，可跨端互导） ---- */
    exportJSON() {
      const keys = store.getMonthKeys()
      const months = {}
      for (let i = 0; i < keys.length; i++) months[keys[i]] = store.getRecords(keys[i])
      return JSON.stringify({
        app: 'mama-ledger',
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: store.getSettings(),
        goals: store.getGoals(),
        months: months
      })
    },

    async importJSON(text) {
      const r = S.parseBackup(text, uid)
      if (!r.ok) return r
      const keys = Object.keys(r.months)
      for (let i = 0; i < keys.length; i++) {
        await store.saveRecords(keys[i], r.months[keys[i]])
      }
      if (r.settings && Object.keys(r.settings).length) await store.saveSettings(r.settings)
      if (r.goals.length) await store.saveGoals(store.getGoals().concat(r.goals))
      return { ok: true, msg: r.msg, dropped: r.dropped }
    },

    async clearAll() {
      if (IN_TAURI) {
        const keys = Object.keys(_months)
        const ids = []
        for (let i = 0; i < keys.length; i++) {
          store.getRecords(keys[i]).forEach(function (r) { ids.push(r.id) })
        }
        for (let i = 0; i < ids.length; i++) {
          try { await invoke('trash_record', { id: ids[i], deleted: 1 }) } catch (e) { /* 清空尽力而为 */ }
        }
        try { await invoke('purge_trash') } catch (e) { /* 同上 */ }
      }
      _months = {}
      _settings = defaultSettings()
      _goals = []
      await KV.remove(K_SETTINGS)
      await KV.remove(K_GOALS)
      await KV.remove(K_META)
      await KV.remove(K_INDEX)
      _meta = { createdAt: Date.now() }
      await KV.set(K_META, _meta)
    },

    async seedDemo() {
      const today = D.today()
      const ym = D.thisMonth()
      const plan = [
        ['grocery', '菜市场买菜', 86, 1], ['food', '早餐', 12, 1],
        ['kid', '宝宝奶粉', 268, 2], ['transport', '打车', 28, 2],
        ['grocery', '水果', 42, 3], ['daily', '纸巾日用', 56, 4],
        ['food', '外卖午饭', 32, 5], ['kid', '兴趣班', 600, 6],
        ['home', '水电燃气', 186, 7], ['food', '奶茶', 18, 8],
        ['grocery', '菜市场买菜', 92, 9], ['social', '同事随礼', 500, 10],
        ['food', '早餐', 15, 11], ['daily', '超市日用', 128, 12],
        ['clothing', '宝宝衣服', 159, 13], ['transport', '加油', 300, 14],
        ['grocery', '菜市场买菜', 78, 15], ['food', '家庭聚餐', 268, 16],
        ['medical', '儿童体检', 220, 17], ['kid', '玩具', 89, 18],
        ['food', '早餐', 14, 19], ['grocery', '水果', 56, 20],
        ['daily', '洗护用品', 96, 21], ['fun', '周末游乐场', 180, 22],
        ['grocery', '买菜', 88, 23], ['food', '外卖晚饭', 46, 24]
      ]
      const out = []
      const base = Date.now() - 3600000 * 40
      for (let i = 0; i < plan.length; i++) {
        const p = plan[i]
        const date = ym + '-' + String(p[3]).padStart(2, '0')
        if (date > today) continue
        out.push({ id: uid('r'), type: 'expense', amount: p[2], cat: p[0], note: p[1], date: date, ts: base + i * 3600000 })
      }
      out.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0) })
      await store.saveRecords(ym, out)
      const s = store.getSettings()
      if (!s.budget.total) {
        s.budget.total = 8000
        s.budget.cats = { grocery: 1500, food: 1200, kid: 2000, daily: 600, social: 600, transport: 600 }
        await store.saveSettings(s)
      }
      if (!store.getGoals().length) {
        await store.addGoal({ name: '宝宝教育金', emoji: '🎓', target: 50000, saved: 12000, deadline: '' })
      }
      return out.length
    }
  }

  function buildAdvice(o) {
    if (!o.total) {
      return { title: '还没设预算', body: '设一个每月总额，我才能帮你看住钱袋子。', action: '去设预算' }
    }
    if (o.status === 'over') {
      return {
        title: '这个月已经超支了',
        body: '超出 ¥' + M.fmt(o.pct >= 100 ? Math.abs(o.left) : 0) + '，' +
          (o.daysLeft > 0 ? '还剩 ' + o.daysLeft + ' 天，先停掉非必要的开销。' : '下个月把预算调准一点。'),
        action: '看看钱花哪了'
      }
    }
    if (o.forecastOver > 0) {
      return {
        title: '按这个速度，月底要超',
        body: '照现在的节奏会花到 ¥' + M.fmt(o.forecast) + '，比预算多 ¥' + M.fmt(o.forecastOver) +
          '。接下来每天控制在 ¥' + M.fmt(o.dailyLeft) + ' 以内就能拉回来。',
        action: '调整预算'
      }
    }
    if (o.status === 'warn') {
      return {
        title: '这个月要悠着点',
        body: '已经花掉 ' + o.pct + '%，还剩 ' + o.daysLeft + ' 天，每天可花 ¥' + M.fmt(o.dailyLeft) + '。',
        action: '看看钱花哪了'
      }
    }
    return {
      title: '节奏很好，继续保持',
      body: '剩 ' + o.daysLeft + ' 天，每天可花 ¥' + M.fmt(o.dailyLeft) + '，安心花。',
      action: ''
    }
  }

  global.JJ = { M, D, C, S, store, IN_TAURI, invoke, uid }
})(window)
