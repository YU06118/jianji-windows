/* 简记 · Windows 桌面端（Tauri v2）
 * 小程序 main@264ede1 的 1:1 功能移植：
 *   首页(hero 预算态+记一笔弹窗+常用档位+近7天+最近记录+新手必读) /
 *   记一笔(类型切换+自动猜分类+今日概览三格) /
 *   统计(月份切换+两级年月选择器+环形图+分类排行展开+分项预算+近6月趋势) /
 *   预算(总额+分项+历史填充+快捷建议) / 目标(编辑+存取) / 我的 / 设置(外观主题+备份恢复+示例+清空)
 * 数据层见 js/mp-core.js（SQLite + settings KV，备份格式与小程序互通）。
 */
(function () {
  'use strict'
  window.onerror = function (msg, src, line, col) {
    /* WebView2 无控制台，出错时至少在 console 留痕（发布版静默） */
    if (window.console) console.error('[jianji]', msg, '@' + (src || '').split('/').pop() + ':' + line + ':' + col)
    return false
  }
  const { M, D, C, S, store, IN_TAURI, uid } = window.JJ

  /* ================= 基础工具 ================= */
  const $ = id => document.getElementById(id)
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

  let toastTimer = null
  function toast(title) {
    const t = $('toast')
    t.textContent = title
    t.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800)
  }

  /* 自绘确认弹窗（WebView2 下原生 confirm 不可靠） */
  function askConfirm(title, msg, opts) {
    opts = opts || {}
    return new Promise(resolve => {
      const mask = $('confirm-modal')
      $('cf-title').textContent = title
      $('cf-msg').textContent = msg
      const ok = $('cf-ok'), cancel = $('cf-cancel')
      ok.textContent = opts.okText || '确定'
      ok.className = 'modal-btn ' + (opts.danger ? 'danger' : 'primary')
      cancel.textContent = opts.cancelText || '取消'
      cancel.style.display = opts.hideCancel ? 'none' : ''
      mask.classList.add('show')
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

  /* 金额输入拼接规则（与小程序 appendAmount 一致：防 00 / 多小数点 / 超 2 位小数） */
  function appendAmount(cur, k) {
    const s = String(cur || '')
    if (k === 'del') return s.slice(0, -1)
    if (k === '.') {
      if (s.indexOf('.') >= 0) return s
      return s === '' ? '0.' : s + '.'
    }
    const dot = s.indexOf('.')
    if (dot >= 0 && s.length - dot > 2) return s
    if (s === '0') return k
    if (s.replace('.', '').length >= 7) return s
    return s + k
  }
  function sanitizeAmount(raw) {
    const s = String(raw == null ? '' : raw).replace(/[^0-9.]/g, '')
    let out = ''
    for (let i = 0; i < s.length; i++) out = appendAmount(out, s[i])
    return out
  }

  function iconImg(cat) {
    return '<img src="assets/icons/' + encodeURIComponent(cat) + '.svg" alt="" />'
  }

  /* ================= 外观（主题 + 深浅模式） ================= */
  function applyAppearance() {
    document.body.className = store.modeClass() + ' ' + store.themeClass()
    /* Windows 原生窗口标题栏跟随深浅色（Tauri v2 setTheme；失败静默） */
    try {
      if (IN_TAURI && window.__TAURI__ && window.__TAURI__.window) {
        const p = window.__TAURI__.window.getCurrentWindow().setTheme(document.body.classList.contains('mode-dark') ? 'dark' : 'light')
        if (p && p.catch) p.catch(function () { })
      }
    } catch (e) { /* 非 Tauri 环境忽略 */ }
  }
  /* 跟随系统时监听系统主题变化（与小程序 wx.onThemeChange 单向驱动一致） */
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (store.getAppearance() === 'system') applyAppearance()
    })
  } catch (e) { /* 旧内核无 addEventListener */ }

  /* ================= 页面路由（替代 tabBar + navigateTo） ================= */
  let curPage = 'index'
  function goto(page) {
    if (page === curPage) return
    curPage = page
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('on', b.dataset.page === page))
    const sec = $('page-' + page)
    document.querySelectorAll('#app > .page').forEach(p => { p.hidden = p.id !== 'page-' + page })
    /* 内容淡入（CSS class 方案，终态必为 opacity:1 —— 移植 transition.js 血泪教训口径） */
    sec.classList.remove('page-fade')
    void sec.offsetWidth
    sec.classList.add('page-fade')
    document.body.scrollTop = 0
    document.documentElement.scrollTop = 0
    render(page)
  }
  function renderAdd() { resetAdd() }
  function render(page) {
    if (page === 'index') renderIndex()
    else if (page === 'add') renderAdd()
    else if (page === 'stats') renderStats()
    else if (page === 'budget') renderBudget()
    else if (page === 'goal') renderGoal()
    else if (page === 'me') renderMe()
    else if (page === 'settings') renderSettings()
  }

  /* =========================================================================
     首页
     ========================================================================= */
  function renderIndex() {
    const ym = D.thisMonth()
    const today = D.today()
    const bs = store.budgetStatus(ym)
    const sum = store.summary(ym)
    const records = store.getRecords(ym)

    const todayCents = records.reduce(function (s, r) {
      if (r.type !== 'expense' || r.date !== today) return s
      return s + M.toCents(r.amount)
    }, 0)
    const todayExpense = M.toYuan(todayCents)

    /* 近 7 天柱状（颜色口径与小程序一致：最高=主题色，今天=tint .55，其余=tint .8） */
    const rawDays = store.recentDays(7)
    let maxAmt = 0
    let weekCents = 0
    for (let i = 0; i < rawDays.length; i++) {
      if (rawDays[i].amount > maxAmt) maxAmt = rawDays[i].amount
      weekCents += M.toCents(rawDays[i].amount)
    }
    const days = rawDays.map(function (d) {
      let h = 4
      if (maxAmt > 0 && d.amount > 0) h = Math.max(10, Math.round(d.amount / maxAmt * 100))
      else if (d.amount > 0) h = 30
      const isToday = d.date === today
      return {
        date: d.date,
        label: isToday ? '今' : String(Number(d.label)),
        amount: d.amount, h: h,
        color: (d.amount === maxAmt && maxAmt > 0) ? store.themeColor()
          : (isToday ? store.themeTint(0.55) : store.themeTint(0.8))
      }
    })

    /* 最近记录 */
    const recent = records.slice(0, 8).map(function (r) {
      const c = C.getCat(r.cat)
      return {
        id: r.id, ym: ym, type: r.type, cat: r.cat,
        catName: c.name, emoji: c.emoji,
        note: r.note, when: D.human(r.date),
        amountText: M.fmt(r.amount)
      }
    })

    const heroLabel = bs.status === 'over' ? '本月已超支'
      : (ym === D.thisMonth() ? '本月还能花' : D.monthLabel(ym) + ' 剩余')
    const dailyLeftText = bs.status === 'over'
      ? '已超 ¥' + M.fmt(Math.abs(bs.left))
      : '每天可花 ¥' + M.fmt(bs.dailyLeft)

    let hero = ''
    if (bs.hasBudget) {
      hero += '<div class="hero-mask1"></div><div class="hero-mask2"></div>'
      hero += '<div class="hero-top"><span class="hero-label">' + esc(heroLabel) + '</span>'
      hero += '<button class="hero-pill" id="idx-gobudget">改预算</button></div>'
      hero += '<div class="hero-num"><span class="hero-cur">¥</span><span class="hero-amt num">' + esc(M.fmt(Math.abs(bs.left))) + '</span></div>'
      hero += '<div class="hero-bar"><div class="bar"><div class="bar-fill" style="width:' + Math.min(100, Math.max(bs.pct, 0)) + '%"></div></div></div>'
      hero += '<div class="hero-meta"><span>预算 ¥' + esc(M.fmt(bs.total)) + '</span><span class="dot">·</span><span>已花 ¥' + esc(M.fmt(bs.hasBudget ? bs.used : sum.expense)) + '（' + bs.pct + '%）</span></div>'
      hero += '<div class="hero-foot">'
      if (bs.daysLeft > 0) {
        hero += '<span class="foot-k">还剩 ' + bs.daysLeft + ' 天</span><span class="foot-v">' + esc(dailyLeftText) + '</span>'
      } else {
        hero += '<span class="foot-k">本月已结束</span><span class="foot-v">共花 ¥' + esc(M.fmt(bs.hasBudget ? bs.used : sum.expense)) + '</span>'
      }
      hero += '</div>'
    } else {
      hero += '<div class="hero-mask1"></div><div class="hero-mask2"></div>'
      hero += '<div class="hero-top"><span class="hero-label">本月已花</span></div>'
      hero += '<div class="hero-num"><span class="hero-cur">¥</span><span class="hero-amt num">' + esc(M.fmt(sum.expense)) + '</span></div>'
      hero += '<div class="hero-meta solo"><span>还没有预算，就没法帮你盯住超支</span></div>'
      hero += '<button class="hero-cta" id="idx-gobudget"><span>设一个本月预算 · 30 秒</span><span class="arrow">→</span></button>'
    }
    const heroEl = $('idx-hero')
    heroEl.className = 'hero tone-' + bs.tone
    heroEl.innerHTML = hero
    const gob = $('idx-gobudget')
    if (gob) gob.onclick = () => goto('budget')

    $('idx-stats').innerHTML =
      '<div class="stat" data-goto="stats"><span class="stat-k">今日花掉</span><span class="stat-v num">¥' + esc(M.fmt(todayExpense)) + '</span></div>' +
      '<div class="stat" data-goto="stats"><span class="stat-k">' + esc(D.monthLabel(ym)) + '支出</span><span class="stat-v num">¥' + esc(M.fmt(bs.hasBudget ? bs.used : sum.expense)) + '</span></div>' +
      '<div class="stat" data-goto="stats"><span class="stat-k">收入</span><span class="stat-v num income">¥' + esc(M.fmt(sum.income)) + '</span></div>'

    $('idx-bars').innerHTML = days.map(d =>
      '<div class="bar-col"><div class="bar-track"><div class="bar-col-fill" style="height:' + d.h + '%;background:' + d.color + '"></div></div><span class="bar-x">' + esc(d.label) + '</span></div>'
    ).join('')
    $('idx-barsfoot').innerHTML =
      '<span>7 天共花 <span class="bold">¥' + esc(M.fmt(M.toYuan(weekCents))) + '</span></span>' +
      '<span class="muted">最高一天 ¥' + esc(M.fmt(maxAmt)) + '</span>'

    if (recent.length) {
      $('idx-recent').innerHTML = recent.map(r =>
        '<div class="rec" data-id="' + esc(r.id) + '" data-ym="' + esc(r.ym) + '">' +
        '<div class="rec-ico">' + iconImg(r.cat) + '</div>' +
        '<div class="rec-mid"><div class="rec-note">' + esc(r.note || r.catName) + '</div>' +
        '<div class="rec-sub">' + esc(r.when) + ' · ' + esc(r.catName) + '</div></div>' +
        '<span class="rec-amt num ' + (r.type === 'income' ? 'income' : '') + '">' + (r.type === 'income' ? '+' : '-') + '¥' + esc(r.amountText) + '</span>' +
        '<button class="rec-del" data-del="1" title="删除">✕</button>' +
        '</div>'
      ).join('') + '<div class="rec-hint">点击可以改，点 ✕ 可以删</div>'
      $('idx-recent').querySelectorAll('.rec').forEach(row => {
        row.onclick = e => {
          if (e.target.closest('[data-del]')) return
          openAddEdit(row.dataset.ym, row.dataset.id)
        }
      })
      $('idx-recent').querySelectorAll('[data-del]').forEach(btn => {
        btn.onclick = e => {
          const row = btn.closest('.rec')
          delRecordFlow(row.dataset.ym, row.dataset.id)
        }
      })
    } else {
      $('idx-recent').innerHTML =
        '<div class="empty"><div class="empty-emoji"><img src="assets/icons/empty-receipt.svg" alt="" /></div>' +
        '<div class="empty-txt">还没有记录</div><div class="empty-txt">从上面点「记一笔」开始吧</div></div>'
    }
  }

  async function delRecordFlow(ym, id) {
    const ok = await askConfirm('删掉这笔？', '删掉就找不回来了', { okText: '删除', cancelText: '留着', danger: true })
    if (!ok) return
    await store.deleteRecord(ym, id)
    toast('已删除')
    render(curPage)
  }

  /* ---------------- 记一笔弹窗（首页 quick sheet） ---------------- */
  let cqCat = 'food'
  function openCqSheet() {
    cqCat = 'food'
    $('cq-note').value = ''
    $('cq-amt').value = ''
    renderCqCats()
    renderCqList()
    $('cq-sheet').hidden = false
    $('cq-mask').classList.add('show')
    requestAnimationFrame(() => $('cq-sheet').classList.add('show'))
    setTimeout(() => $('cq-amt').focus(), 320)
  }
  function closeCqSheet() {
    $('cq-sheet').classList.remove('show')
    $('cq-mask').classList.remove('show')
    setTimeout(() => { $('cq-sheet').hidden = true }, 300)
  }
  function renderCqCats() {
    $('cq-cats').innerHTML = C.catsOf('expense').map(c =>
      '<button class="cq-cat ' + (cqCat === c.key ? 'on' : '') + '" data-cat="' + c.key + '">' +
      '<span class="cq-cat-emoji">' + c.emoji + '</span>' + esc(c.name) + '</button>'
    ).join('')
    $('cq-cats').querySelectorAll('.cq-cat').forEach(b => {
      b.onclick = () => { cqCat = b.dataset.cat; renderCqCats() }
    })
  }
  function decorateCq(list) {
    return (list || []).map(function (it, i) {
      const c = C.getCat(it.cat)
      return { cat: it.cat, note: it.note, amount: it.amount, index: i, name: c.name, emoji: c.emoji, amountText: M.fmt(it.amount) }
    })
  }
  function renderCqList() {
    const list = decorateCq(store.getCustomQuick())
    $('cq-existing').hidden = !list.length
    $('cq-list').innerHTML = list.map(it =>
      '<div class="cq-row" data-i="' + it.index + '">' +
      '<span class="cq-row-emoji">' + it.emoji + '</span>' +
      '<span class="cq-row-note">' + esc(it.note) + '</span>' +
      '<span class="cq-row-amt num">¥' + esc(it.amountText) + '</span>' +
      '<button class="cq-row-del" data-del="1" data-i="' + it.index + '">✕</button></div>'
    ).join('')
    $('cq-list').querySelectorAll('.cq-row').forEach(row => {
      row.onclick = e => {
        if (e.target.closest('[data-del]')) return
        useCq(Number(row.dataset.i))
      }
    })
    $('cq-list').querySelectorAll('[data-del]').forEach(btn => {
      btn.onclick = e => delCq(Number(btn.dataset.i))
    })
  }
  async function saveCq() {
    const amount = M.parse($('cq-amt').value)
    if (!(amount > 0)) { toast('金额要大于 0'); return }
    const note = String($('cq-note').value || '').trim() || C.getCat(cqCat).name
    await store.addRecord({ type: 'expense', amount: amount, cat: cqCat, note: note, date: D.today() })
    if (!store.lastWriteOk()) { toast('保存失败，空间可能已满'); return }
    toast('记好了 ¥' + M.fmt(amount))
    closeCqSheet()
    render(curPage)
  }
  async function keepCq() {
    const amount = M.parse($('cq-amt').value)
    if (!(amount > 0)) { toast('金额要大于 0'); return }
    const note = String($('cq-note').value || '').trim() || C.getCat(cqCat).name
    const list = store.getCustomQuick()
    const hit = list.findIndex(x => x.cat === cqCat && x.note === note)
    if (hit >= 0) list[hit].amount = amount
    else list.push({ cat: cqCat, note: note, amount: amount })
    if (!(await store.saveCustomQuick(list))) { toast('保存失败，空间可能已满'); return }
    toast('已存为档位')
    renderCqList()
  }
  async function useCq(i) {
    const it = store.getCustomQuick()[i]
    if (!it) return
    await store.addRecord({ type: 'expense', amount: it.amount, cat: it.cat, note: it.note, date: D.today() })
    if (!store.lastWriteOk()) { toast('保存失败，空间可能已满'); return }
    const c = C.getCat(it.cat)
    toast('记好了 ' + c.emoji + ' ¥' + M.fmt(it.amount))
    closeCqSheet()
    render(curPage)
  }
  async function delCq(i) {
    const list = store.getCustomQuick()
    if (i < 0 || i >= list.length) return
    const ok = await askConfirm('删掉这个档位？', '只删快捷档位，不影响已记的账',
      { okText: '删除', cancelText: '留着', danger: true })
    if (!ok) return
    list.splice(i, 1)
    if (!(await store.saveCustomQuick(list))) { toast('保存失败，空间可能已满'); return }
    renderCqList()
    render(curPage)
  }

  /* =========================================================================
     记一笔（add）
     ========================================================================= */
  const addState = { type: 'expense', cat: 'food', catTouched: false, autoHint: false, editingId: '', editingYm: '' }

  function openAddEdit(ym, id) {
    goto('add')
    const rec = store.getRecords(ym).filter(r => r.id === id)[0]
    if (!rec) return
    addState.editingId = rec.id
    addState.editingYm = ym
    addState.type = rec.type
    addState.cat = rec.cat
    addState.catTouched = true
    addState.autoHint = false
    $('add-amt').value = String(rec.amount)
    $('add-note').value = rec.note || ''
    $('add-date').value = rec.date
    $('add-save').textContent = '保存修改'
    $('add-noteclear').hidden = !rec.note
    refreshAddView()
  }
  function resetAdd() {
    addState.editingId = ''
    addState.editingYm = ''
    addState.type = 'expense'
    addState.cat = 'food'
    addState.catTouched = false
    addState.autoHint = false
    $('add-amt').value = ''
    $('add-note').value = ''
    $('add-date').value = D.today()
    $('add-save').textContent = '保存这一笔'
    $('add-noteclear').hidden = true
    refreshAddView()
  }
  function refreshAddView() {
    const cats = C.catsOf(addState.type)
    const exists = cats.some(c => c.key === addState.cat)
    if (!exists) addState.cat = cats[0].key
    const curCat = C.getCat(addState.cat)

    $('add-typeseg').querySelectorAll('.type-seg-i').forEach(b =>
      b.classList.toggle('on', b.dataset.t === addState.type))
    $('add-catbadge').innerHTML = iconImg(curCat.key) + '<span>' + esc(curCat.name) + '</span>'
    $('add-sectitle').textContent = addState.type === 'expense' ? '支出分类' : '收入分类'
    $('add-hint-touched').hidden = !addState.catTouched
    $('add-hint-auto').hidden = !(addState.autoHint && !addState.catTouched)

    $('add-cats').innerHTML = cats.map(c =>
      '<button class="cat ' + (addState.cat === c.key ? 'on' : '') + '" data-k="' + c.key + '">' +
      '<span class="c-ico">' + iconImg(c.key) + '</span><span class="c-name">' + esc(c.name) + '</span></button>'
    ).join('')
    $('add-cats').querySelectorAll('.cat').forEach(b => {
      b.onclick = () => {
        addState.cat = b.dataset.k
        addState.catTouched = true
        addState.autoHint = false
        refreshAddView()
      }
    })

    /* 今日概览三格（记前瞄一眼当日累计） */
    const today = D.today()
    const ym = today.slice(0, 7)
    const days = store.recentDays(1)
    const todayExpense = days.length && days[0].date === today ? days[0].amount : 0
    const sum = store.summary(ym)
    const recs = store.getRecords(ym)
    const count = recs.filter(r => r.date === today).length
    $('add-stats').innerHTML =
      '<div class="stat"><span class="stat-k">今日花掉</span><span class="stat-v num">¥' + esc(M.fmt(todayExpense)) + '</span></div>' +
      '<div class="stat"><span class="stat-k">本月支出</span><span class="stat-v num">¥' + esc(M.fmt(sum.expense)) + '</span></div>' +
      '<div class="stat"><span class="stat-k">今日已记</span><span class="stat-v num">' + count + ' 笔</span></div>'
  }
  function reguess() {
    if (addState.catTouched) return
    const guessKey = C.guess($('add-note').value)
    const cats = C.catsOf(addState.type)
    const hit = cats.filter(c => c.key === guessKey)[0]
    if (guessKey && hit && hit.key !== addState.cat) {
      addState.cat = hit.key
      addState.autoHint = true
    } else if (guessKey && hit) {
      addState.autoHint = true
    } else {
      addState.autoHint = false
    }
    refreshAddView()
  }
  async function submitAdd() {
    if (submitAdd._busy) return
    const amount = M.parse($('add-amt').value)
    if (!(amount > 0)) { toast('先输入金额'); return }
    submitAdd._busy = true
    const payload = {
      type: addState.type, amount: amount,
      cat: addState.cat, note: $('add-note').value, date: $('add-date').value || D.today()
    }
    if (addState.editingId) {
      await store.updateRecord(addState.editingYm, addState.editingId, payload)
    } else {
      await store.addRecord(payload)
    }
    submitAdd._busy = false
    /* P0：写库失败时不提示成功、不清表单 */
    if (!store.lastWriteOk()) { toast('保存失败，空间可能已满'); return }
    toast(addState.editingId ? '改好了' : '记好了')
    resetAdd()
  }

  /* =========================================================================
     统计（stats）
     ========================================================================= */
  const stState = { ym: '', expandedCat: '', pickerShow: false, pickerStep: 'year', years: [], decadeStart: 2020, pickedYear: 0, pickedMonth: 0, minYear: 2000, maxYear: 0, maxMonth: 12, canNextDecade: false }

  function renderStats() {
    if (!stState.ym) stState.ym = D.thisMonth()
    loadStats(stState.ym)
  }

  function loadStats(ym) {
    const cur = D.thisMonth()
    const sum = store.summary(ym)
    const prev = store.summary(D.shiftMonth(ym, -1))
    const records = store.getRecords(ym)

    /* 与上月对比 */
    const diff = M.toYuan(M.toCents(sum.expense) - M.toCents(prev.expense))
    let diffText = ''
    let diffTone = 'pill-plain'
    if (prev.expense > 0 && Math.abs(diff) >= 1) {
      const p = Math.round(Math.abs(diff) / prev.expense * 100)
      if (diff > 0) { diffText = '比上月多 ¥' + M.fmt(diff) + ' ↑' + p + '%'; diffTone = 'pill-warn' }
      else { diffText = '比上月少 ¥' + M.fmt(-diff) + ' ↓' + p + '%'; diffTone = 'pill-ok' }
    } else if (prev.expense === 0 && sum.expense > 0) {
      diffText = '上月没有记录'
    }

    /* 分类排行（含展开明细） */
    const byCat = sum.byCat.map(function (c) {
      const recs = records.filter(r => r.type === 'expense' && r.cat === c.key).slice(0, 12).map(r => ({
        id: r.id, when: D.human(r.date), note: r.note || C.catName(r.cat), amountText: M.fmt(r.amount)
      }))
      return {
        key: c.key, name: c.name, emoji: c.emoji, color: c.color,
        amount: c.amount, amountRaw: c.amount, amountText: M.fmt(c.amount),
        count: c.count, pct: c.pct, pctW: Math.max(3, c.pct), records: recs
      }
    })
    const legendCats = byCat.slice(0, 6)

    /* 分项预算进度 */
    const bs = store.budgetStatus(ym)
    const catBudgets = (bs.cats || []).map(c => ({
      key: c.key, name: c.name, emoji: c.emoji, color: c.color,
      usedText: M.fmt(c.used), budgetText: M.fmt(c.budget),
      pct: c.pct, w: Math.min(100, Math.max(0, c.pct)), status: c.status,
      tip: c.status === 'over' ? '超出 ¥' + M.fmt(Math.abs(c.left)) : '还能花 ¥' + M.fmt(c.left)
    }))

    /* 近 6 个月趋势 */
    const rawTrend = store.recentMonths(6, ym)
    let maxT = 0, sumT = 0
    let top = { amount: -1, label: '' }
    for (let i = 0; i < rawTrend.length; i++) {
      if (rawTrend[i].amount > maxT) maxT = rawTrend[i].amount
      sumT += M.toCents(rawTrend[i].amount)
      if (rawTrend[i].amount > top.amount && rawTrend[i].ym !== cur) top = { amount: rawTrend[i].amount, label: rawTrend[i].label }
    }
    const trend = rawTrend.map(t => {
      const isCur = t.ym === cur
      return {
        ym: t.ym, label: t.label, amount: t.amount,
        h: maxT > 0 ? Math.max(4, Math.round(t.amount / maxT * 100)) : 4,
        isCur: isCur,
        color: isCur ? store.themeColor()
          : (t.amount === maxT && maxT > 0 ? store.themeTint(0.5) : store.themeTint(0.8))
      }
    })
    const trendAvg = M.toYuan(Math.round(sumT / rawTrend.length))

    stState.ym = ym
    const monthLabelText = D.monthLabel(ym)
    const canNext = ym < cur

    $('st-prev').classList.toggle('off', false)
    $('st-next').classList.toggle('off', !canNext)
    $('st-monthlabel').innerHTML =
      '<span>' + esc(monthLabelText) + '</span>' +
      (ym === cur ? '<span class="mb-live">进行中</span>' : '') +
      '<span class="mb-caret">▾</span>'

    $('st-total').innerHTML =
      '<div class="row-between"><span class="card-sub">' + esc(monthLabelText) + '一共花了</span>' +
      (diffText ? '<span class="pill ' + diffTone + '">' + esc(diffText) + '</span>' : '') + '</div>' +
      '<div class="total-num num"><span class="total-cur">¥</span>' + esc(M.fmt(sum.expense)) + '</div>' +
      '<div class="total-sub">' + (sum.dayCount ? sum.dayCount + ' 笔 · 日均 ¥' + esc(M.fmt(sum.avgPerDay)) : '这个月还没有记录') + '</div>' +
      '<div class="row-between total-foot"><span class="t-sm muted-2">收入 ¥' + esc(M.fmt(sum.income)) + '</span>' +
      '<span class="t-sm muted-2">结余 ¥' + esc(M.fmt(sum.balance)) + '</span></div>'

    if (byCat.length) {
      $('st-donutcard').innerHTML =
        '<span class="card-title">钱花在哪了</span>' +
        '<div class="donut-box"><canvas id="donut" class="donut"></canvas>' +
        '<div class="donut-legend">' + legendCats.map(c =>
          '<div class="lg"><span class="lg-dot" style="background:' + c.color + '"></span>' +
          '<span class="lg-name">' + esc(c.name) + '</span><span class="lg-pct num">' + c.pct + '%</span></div>'
        ).join('') + '</div></div>' +
        '<div class="rank">' + byCat.map(c =>
          '<div class="rk" data-k="' + esc(c.key) + '">' +
          '<div class="rk-head"><span class="rk-ico">' + iconImg(c.key) + '</span>' +
          '<span class="rk-name">' + esc(c.name) + '</span>' +
          '<span class="rk-count">' + c.count + '笔</span>' +
          '<span class="rk-amt num">¥' + esc(c.amountText) + '</span>' +
          '<span class="rk-pct num">' + c.pct + '%</span></div>' +
          '<div class="rk-bar"><div class="rk-fill" style="width:' + c.pctW + '%;background:' + c.color + '"></div></div>' +
          (stState.expandedCat === c.key
            ? '<div class="rk-detail">' + c.records.map(rec =>
              '<div class="rd-row"><span class="rd-date">' + esc(rec.when) + '</span>' +
              '<span class="rd-note">' + esc(rec.note) + '</span>' +
              '<span class="rd-amt num">¥' + esc(rec.amountText) + '</span></div>').join('') + '</div>'
            : '') +
          '</div>'
        ).join('') + '</div>' +
        '<div class="tap-hint">点分类可以展开看每一笔</div>'
      $('st-donutcard').querySelectorAll('.rk').forEach(el => {
        el.onclick = () => {
          stState.expandedCat = stState.expandedCat === el.dataset.k ? '' : el.dataset.k
          loadStats(stState.ym)
        }
      })
      drawDonut(byCat, sum.expense)
    } else {
      $('st-donutcard').innerHTML =
        '<span class="card-title">钱花在哪了</span>' +
        '<div class="empty"><div class="empty-emoji"><img src="assets/icons/empty-chart.svg" alt="" /></div>' +
        '<div class="empty-txt">这个月还没有记录</div><div class="empty-txt">记上几笔，这里就能看出钱去哪了</div></div>'
    }

    $('st-cbudgetwrap').hidden = !catBudgets.length
    $('st-cbudget').innerHTML = catBudgets.map(c =>
      '<div class="cb"><div class="cb-head"><span class="cb-name">' + esc(c.name) + '</span>' +
      '<div class="cb-right"><span class="cb-amt num">¥' + esc(c.usedText) + '</span>' +
      '<span class="cb-of num">/ ¥' + esc(c.budgetText) + '</span></div></div>' +
      '<div class="bar"><div class="bar-fill ' + c.status + '" style="width:' + c.w + '%"></div></div>' +
      '<div class="cb-foot"><span class="cb-pct ' + c.status + '">已用 ' + c.pct + '%</span>' +
      '<span class="cb-tip">' + esc(c.tip) + '</span></div></div>'
    ).join('')

    $('st-trendavg').textContent = maxT > 0 ? '月均 ¥' + M.fmt(trendAvg) : ''
    $('st-trend').innerHTML = trend.map(t =>
      '<div class="tr-col"><div class="tr-track"><div class="tr-fill" style="height:' + t.h + '%;background:' + t.color + '"></div></div>' +
      '<span class="tr-x ' + (t.isCur ? 'cur' : '') + '">' + esc(t.label) + '</span></div>'
    ).join('')
    $('st-trendfoot').innerHTML = top.amount > 0
      ? '花得最多的是 <span class="bold">' + esc(top.label) + '</span>，¥' + esc(M.fmt(top.amount)) : ''
  }

  /* 环形图（canvas 2d，明暗换色口径与小程序一致） */
  function drawDonut(cats, total) {
    const canvas = document.getElementById('donut')
    if (!canvas || !(total > 0)) return
    const dpr = window.devicePixelRatio || 2
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (!w || !h) return
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    const cx = w / 2, cy = h / 2
    const margin = 4
    const ringRatio = 0.27
    const r = (Math.min(w, h) / 2 - margin) / (1 + ringRatio / 2)
    const lw = r * ringRatio
    const dark = store.isDark()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.strokeStyle = dark ? '#3A3A3C' : '#F6EEED'
    ctx.lineWidth = lw
    ctx.lineCap = 'butt'
    ctx.stroke()
    if (cats.length && total > 0) {
      let start = -Math.PI / 2
      for (let i = 0; i < cats.length; i++) {
        const c = cats[i]
        const ang = (c.amountRaw / total) * Math.PI * 2
        if (ang <= 0) continue
        ctx.beginPath()
        ctx.arc(cx, cy, r, start + 0.006, start + ang - 0.006)
        ctx.strokeStyle = c.color
        ctx.lineWidth = lw
        ctx.stroke()
        start += ang
      }
    }
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = dark ? '#9E9E9E' : '#A2939A'
    ctx.font = '12px sans-serif'
    ctx.fillText('共花', cx, cy - 17)
    ctx.fillStyle = dark ? '#F5F5F5' : '#2E2A2B'
    ctx.font = 'bold 21px sans-serif'
    ctx.fillText('¥' + M.short(total), cx, cy + 11)
  }

  /* 年月两级选择器（年份网格 → 月份网格） */
  function buildDecade(start) {
    const out = []
    for (let y = start; y < start + 10; y++) out.push(y)
    return out
  }
  function openMonthPicker() {
    const cur = D.parseMonth(D.thisMonth())
    const sel = D.parseMonth(stState.ym || D.thisMonth())
    const decade = Math.floor(sel.y / 10) * 10
    const maxDecade = Math.floor(cur.y / 10) * 10
    Object.assign(stState, {
      pickerShow: true, pickerStep: 'year',
      years: buildDecade(decade), decadeStart: decade,
      pickedYear: sel.y, pickedMonth: sel.m,
      minYear: 2000, maxYear: cur.y,
      maxMonth: cur.y === sel.y ? cur.m : 12,
      canNextDecade: decade < maxDecade
    })
    renderPicker()
    $('py-sheet').hidden = false
    $('py-mask').classList.add('show')
    requestAnimationFrame(() => $('py-sheet').classList.add('show'))
  }
  function closePicker() {
    stState.pickerShow = false
    $('py-sheet').classList.remove('show')
    $('py-mask').classList.remove('show')
    setTimeout(() => { $('py-sheet').hidden = true }, 300)
  }
  function renderPicker() {
    const cur = D.thisMonth()
    $('py-stepback').hidden = stState.pickerStep !== 'month'
    $('py-decade').hidden = stState.pickerStep === 'month'
    $('py-decade').textContent = stState.decadeStart + ' - ' + (stState.decadeStart + 9)
    $('py-yearview').hidden = stState.pickerStep !== 'year'
    $('py-monthview').hidden = stState.pickerStep !== 'month'
    if (stState.pickerStep === 'year') {
      const maxDecade = Math.floor(stState.maxYear / 10) * 10
      $('py-prevdec').classList.toggle('off', stState.decadeStart - 10 < stState.minYear)
      $('py-nextdec').classList.toggle('off', stState.decadeStart >= maxDecade)
      $('py-declabel').textContent = stState.decadeStart + ' - ' + (stState.decadeStart + 9)
      $('py-years').innerHTML = stState.years.map(y =>
        '<button class="py-cell ' + (y === stState.pickedYear ? 'on' : '') + ' ' + (y > stState.maxYear ? 'off' : '') + '" data-y="' + y + '">' + y + '</button>'
      ).join('')
      $('py-years').querySelectorAll('.py-cell').forEach(b => {
        b.onclick = () => {
          const y = Number(b.dataset.y)
          if (y > stState.maxYear) { toast('还没到这一年'); return }
          stState.pickerStep = 'month'
          stState.pickedYear = y
          stState.maxMonth = y === D.parseMonth(cur).y ? D.parseMonth(cur).m : 12
          renderPicker()
        }
      })
    } else {
      $('py-yeartitle').textContent = stState.pickedYear + ' 年'
      $('py-months').innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(m =>
        '<button class="py-cell month ' + (m === stState.pickedMonth ? 'on' : '') + ' ' + (m > stState.maxMonth ? 'off' : '') + '" data-m="' + m + '">' + m + '月</button>'
      ).join('')
      $('py-months').querySelectorAll('.py-cell').forEach(b => {
        b.onclick = () => {
          const m = Number(b.dataset.m)
          if (m > stState.maxMonth) { toast('还不能选未来的月份'); return }
          const ym = stState.pickedYear + '-' + (m < 10 ? '0' + m : m)
          closePicker()
          stState.expandedCat = ''
          loadStats(ym)
        }
      })
    }
  }

  /* =========================================================================
     预算（budget）
     ========================================================================= */
  const bdState = { cats: [], historyAvg: null, historyText: '' }

  function renderBudget() {
    const s = store.getSettings()
    const budgetCats = s.budget.cats || {}
    bdState.cats = C.BUDGET_CATS.map(c => {
      const v = M.parse(budgetCats[c.key])
      return { key: c.key, name: c.name, emoji: c.emoji, color: c.color, soft: c.soft, value: v > 0 ? String(v) : '' }
    })
    const prev = store.summary(D.shiftMonth(D.thisMonth(), -1))
    const sugText = prev.expense > 0 ? M.fmt(M.toYuan(Math.ceil(M.toCents(prev.expense) / 1000) * 1000)) : ''
    $('bd-total').value = s.budget.total > 0 ? String(M.parse(s.budget.total)) : ''
    calcHistory()
    renderBdCats()
    $('bd-sugs').innerHTML =
      (sugText ? '<button class="sug-pill" id="bd-usesug">按上个月花销填 ¥' + esc(sugText) + '</button>' : '') +
      (bdState.historyText ? '<button class="sug-pill" id="bd-usehist">按近 3 个月平均填 ¥' + esc(bdState.historyText) + '</button>' : '')
    const usesug = $('bd-usesug')
    if (usesug) usesug.onclick = () => {
      $('bd-total').value = String(M.parse(usesug.textContent.replace('按上个月花销填 ¥', '')))
      recalcBd()
    }
    const usehist = $('bd-usehist')
    if (usehist) usehist.onclick = fillByHistory
    $('bd-fillhist').hidden = !bdState.historyText
    $('bd-clear').hidden = !(M.parse($('bd-total').value) > 0)
    recalcBd()
  }
  function renderBdCats() {
    $('bd-cats').innerHTML = bdState.cats.map((c, i) =>
      '<div class="cb-item"><div class="cb-ico">' + iconImg(c.key) + '</div>' +
      '<span class="bitem-name">' + esc(c.name) + '</span>' +
      '<div class="bitem-right"><span class="bitem-cur">¥</span>' +
      '<input class="bitem-in num" data-i="' + i + '" inputmode="decimal" placeholder="不限" value="' + esc(c.value) + '" /></div></div>'
    ).join('')
    $('bd-cats').querySelectorAll('.bitem-in').forEach(inp => {
      inp.oninput = () => {
        bdState.cats[Number(inp.dataset.i)].value = inp.value
        recalcBd()
      }
    })
  }
  function recalcBd() {
    let cents = 0
    const totalCents = M.toCents(M.parse($('bd-total').value))
    for (let i = 0; i < bdState.cats.length; i++) cents += M.toCents(M.parse(bdState.cats[i].value))
    const sum = M.toYuan(cents)
    let diffText = ''
    let warn = false
    if (cents > 0 && totalCents > 0) {
      const d = M.toYuan(cents - totalCents)
      if (d > 0) { diffText = '超出总额 ¥' + M.fmt(d); warn = true }
      else if (d >= -100) diffText = '刚好对上'
      else { diffText = '比总额少 ¥' + M.fmt(-d) + '，这部分没有管'; warn = true }
    } else if (cents > 0 && totalCents === 0) {
      diffText = '还没填总预算'
      warn = true
    }
    $('bd-sum').className = 'cb-sum' + (warn ? ' warn' : '')
    $('bd-sum').innerHTML = '<span>分项合计 ¥' + esc(M.fmt(sum)) + '</span><span class="cb-diff">' + esc(diffText) + '</span>'
    $('bd-clear').hidden = !(totalCents > 0)
  }
  function calcHistory() {
    const cur = D.thisMonth()
    const months = [D.shiftMonth(cur, -1), D.shiftMonth(cur, -2), D.shiftMonth(cur, -3)]
    const acc = {}
    let validMonths = 0
    for (let i = 0; i < months.length; i++) {
      const s = store.summary(months[i])
      if (s.expense > 0) validMonths++
      for (let j = 0; j < s.byCat.length; j++) {
        acc[s.byCat[j].key] = (acc[s.byCat[j].key] || 0) + M.toCents(s.byCat[j].amount)
      }
    }
    if (!validMonths) { bdState.historyText = ''; bdState.historyAvg = null; return null }
    const avg = {}
    let totalCents = 0
    Object.keys(acc).forEach(k => {
      const v = Math.ceil(acc[k] / validMonths / 1000) * 1000
      avg[k] = M.toYuan(v)
      totalCents += v
    })
    bdState.historyAvg = avg
    bdState.historyText = M.fmt(M.toYuan(totalCents))
    return avg
  }
  function fillByHistory() {
    const avg = bdState.historyAvg || calcHistory()
    if (!avg) { toast('历史数据还不够，先记两周账'); return }
    bdState.cats = bdState.cats.map(c => Object.assign({}, c, { value: avg[c.key] > 0 ? String(avg[c.key]) : '' }))
    let totalCents = 0
    Object.keys(avg).forEach(k => { totalCents += M.toCents(avg[k]) })
    $('bd-total').value = String(M.toYuan(totalCents))
    renderBdCats()
    recalcBd()
    toast('已按历史填好，可再微调')
  }
  async function saveBudget() {
    const total = M.parse($('bd-total').value)
    const cats = {}
    for (let i = 0; i < bdState.cats.length; i++) {
      const v = M.parse(bdState.cats[i].value)
      if (v > 0) cats[bdState.cats[i].key] = v
    }
    const s = store.getSettings()
    s.budget = { total: total, cats: cats }
    await store.saveSettings(s)
    if (!store.lastWriteOk()) { toast('保存失败，空间可能已满'); return }
    toast(total > 0 ? '预算存好了' : '已保存')
  }
  async function clearBudget() {
    const ok = await askConfirm('清空预算？', '账目记录不会受影响', { okText: '清空', danger: true })
    if (!ok) return
    const s = store.getSettings()
    s.budget = { total: 0, cats: {} }
    await store.saveSettings(s)
    if (!store.lastWriteOk()) { toast('保存失败，空间可能已满'); return }
    bdState.cats = bdState.cats.map(c => Object.assign({}, c, { value: '' }))
    $('bd-total').value = ''
    renderBdCats()
    recalcBd()
    toast('已清空')
  }

  /* =========================================================================
     攒钱目标（goal）
     ========================================================================= */
  const EMOJIS = ['🎓', '✈️', '🏠', '🚗', '💍', '🎁', '🧳', '📱', '🐷', '🎨', '🏥', '🎉']
  const DEPOSIT_QUICK = [200, 500, 1000, 2000]
  const glState = { sheetMode: '', form: {}, depositGoal: {}, depositMode: 'in' }

  function renderGoal() {
    const raw = store.getGoals()
    let savedCents = 0, targetCents = 0
    const goals = raw.map(function (g) {
      const target = M.parse(g.target)
      const saved = M.parse(g.saved)
      const pct = target > 0 ? Math.round(saved / target * 100) : 0
      const done = target > 0 && saved >= target
      const need = M.toYuan(Math.max(0, M.toCents(target) - M.toCents(saved)))
      savedCents += M.toCents(saved)
      targetCents += M.toCents(target)
      let subline = ''
      let dl = null
      if (g.deadline) {
        dl = D.daysUntil(g.deadline)
        if (dl > 0) subline = '目标日 ' + D.fmtMD(g.deadline) + ' · 还剩 ' + dl + ' 天'
        else subline = '目标日 ' + D.fmtMD(g.deadline) + '（已过期）'
      }
      if (!subline || done) subline = done ? '已经达成了' : ('还差 ¥' + M.fmt(need))
      let tip = ''
      if (done) tip = '🎉 目标达成，这笔钱可以放心用了'
      else if (dl !== null && dl > 0) {
        const months = Math.max(1, Math.ceil(dl / 30))
        tip = '每月存 ¥' + M.fmt(M.toYuan(Math.ceil(M.toCents(need) / months))) + '，就能在目标日前存够'
      }
      if (!tip) {
        const createdDays = Math.max(1, Math.round((Date.now() - (g.createdAt || Date.now())) / 86400000))
        const speedCents = M.toCents(saved) / createdDays
        if (speedCents > 1 && need > 0) {
          const daysNeed = Math.ceil(M.toCents(need) / speedCents)
          if (daysNeed <= 365 * 3) {
            const fd = new Date(Date.now() + daysNeed * 86400000)
            tip = '按现在的速度，大约 ' + fd.getFullYear() + ' 年 ' + (fd.getMonth() + 1) + ' 月能存够'
          } else {
            tip = '按现在的速度还得好几年，可以把每月目标调高一点'
          }
        }
      }
      if (!tip) tip = '还差 ¥' + M.fmt(need) + '，存一笔就开始积累吧'
      return {
        id: g.id, name: g.name, emoji: g.emoji || '🎯',
        pct: pct, done: done, w: Math.min(100, Math.max(2, pct)),
        barColor: done ? 'linear-gradient(90deg,#6FD3B8,#3FAE9F)' : 'linear-gradient(90deg,#FFD08A,#F5A93B)',
        savedText: M.fmt(saved), targetText: M.fmt(target),
        subline: subline, tip: tip
      }
    })
    const totalPct = targetCents > 0 ? Math.round(savedCents / targetCents * 100) : 0

    $('gl-hero').innerHTML =
      '<div class="hero-mask"></div>' +
      '<span class="hero-label">已经攒下</span>' +
      '<div class="hero-num"><span class="hero-cur">¥</span><span class="hero-amt num">' + esc(M.fmt(M.toYuan(savedCents))) + '</span></div>' +
      '<div class="hero-sub">' + (goals.length ? '目标总额 ¥' + esc(M.fmt(M.toYuan(targetCents))) + ' · 完成 ' + totalPct + '%' : '给未来的自己定一个目标吧') + '</div>' +
      '<div class="hero-bar"><div class="bar"><div class="bar-fill" style="width:' + Math.min(100, totalPct) + '%;background:#FFFFFF"></div></div></div>'

    let html = ''
    goals.forEach((g, i) => {
      html += '<div class="gcard">' +
        '<div class="gc-head" data-edit="' + i + '">' +
        '<div class="gc-ico">' + esc(g.emoji) + '</div>' +
        '<div class="gc-title"><span class="gc-name">' + esc(g.name) + '</span>' +
        '<span class="gc-sub">' + esc(g.subline) + '</span></div>' +
        '<span class="gc-pct num ' + (g.done ? 'done' : 'pending') + '">' + g.pct + '%</span></div>' +
        '<div class="bar"><div class="bar-fill" style="width:' + g.w + '%;background:' + g.barColor + '"></div></div>' +
        '<div class="gc-foot"><span class="gc-saved num">¥' + esc(g.savedText) + '</span>' +
        '<span class="gc-target num">/ ¥' + esc(g.targetText) + '</span>' +
        '<button class="gc-btn" data-deposit="' + i + '">存一笔</button></div>' +
        (g.tip ? '<div class="gc-tip"><span>' + esc(g.tip) + '</span></div>' : '') +
        '</div>'
    })
    if (!goals.length) {
      html += '<div class="empty"><div class="empty-emoji"><img src="assets/icons/empty-pig.svg" alt="" /></div>' +
        '<div class="empty-txt">还没有攒钱目标</div><div class="empty-txt">宝宝教育金、家庭旅行、换台冰箱……</div>' +
        '<div class="empty-txt">写下来，才知道每个月该留多少</div></div>'
    }
    html += '<button class="btn btn-ghost new-btn" id="gl-new">＋ 新的攒钱目标</button>'
    html += '<div class="foot-note">攒钱进度是手动记的，不会自动从账本里扣 —— 免得你记错了还要对账。</div>'
    $('gl-list').innerHTML = html
    $('gl-new').onclick = () => openGoalEdit(null)
    $('gl-list').querySelectorAll('[data-edit]').forEach(el => {
      el.onclick = () => openGoalEdit(Number(el.dataset.edit))
    })
    $('gl-list').querySelectorAll('[data-deposit]').forEach(el => {
      el.onclick = () => openDeposit(Number(el.dataset.deposit))
    })

    /* 「我的」页目标文案同步 */
    $('me-goaltext').textContent = raw.length ? '已攒 ¥' + M.fmt(M.toYuan(savedCents)) : '还没有目标'
  }

  function closeGlSheets() {
    glState.sheetMode = ''
    ;['gl-sheet-edit', 'gl-sheet-deposit'].forEach(id => {
      $(id).classList.remove('show')
    })
    $('gl-mask').classList.remove('show')
    setTimeout(() => {
      $('gl-sheet-edit').hidden = true
      $('gl-sheet-deposit').hidden = true
    }, 300)
  }
  function openGoalEdit(idx) {
    const raw = idx === null ? null : store.getGoals()[idx]
    glState.form = raw ? {
      id: raw.id, name: raw.name, emoji: raw.emoji || '🎓',
      target: String(M.parse(raw.target) || ''),
      saved: String(M.parse(raw.saved) || ''),
      deadline: raw.deadline || ''
    } : { id: '', name: '', emoji: '🎓', target: '', saved: '', deadline: '' }
    $('gl-edittitle').textContent = glState.form.id ? '修改目标' : '新目标'
    $('gl-name').value = glState.form.name
    $('gl-target').value = glState.form.target
    $('gl-saved').value = glState.form.saved
    $('gl-deadline').value = glState.form.deadline
    $('gl-deadclear').hidden = !glState.form.deadline
    $('gl-del').hidden = !glState.form.id
    renderEmojiRow()
    $('gl-sheet-edit').hidden = false
    $('gl-mask').classList.add('show')
    requestAnimationFrame(() => $('gl-sheet-edit').classList.add('show'))
  }
  function renderEmojiRow() {
    $('gl-emojis').innerHTML = EMOJIS.map(e =>
      '<button class="em ' + (glState.form.emoji === e ? 'on' : '') + '" data-e="' + e + '">' + e + '</button>'
    ).join('')
    $('gl-emojis').querySelectorAll('.em').forEach(b => {
      b.onclick = () => { glState.form.emoji = b.dataset.e; renderEmojiRow() }
    })
  }
  async function submitGoalForm() {
    const f = glState.form
    f.name = $('gl-name').value.trim()
    f.target = $('gl-target').value
    f.saved = $('gl-saved').value
    f.deadline = $('gl-deadline').value
    if (!f.name) { toast('给它起个名字吧'); return }
    const target = M.parse(f.target)
    if (!(target > 0)) { toast('填一下目标金额'); return }
    const saved = M.parse(f.saved)
    if (f.id) {
      await store.updateGoal(f.id, { name: f.name, emoji: f.emoji, target: target, saved: saved, deadline: f.deadline })
    } else {
      if (!(await store.addGoal({ name: f.name, emoji: f.emoji, target: target, saved: saved, deadline: f.deadline }))) {
        toast('名称或金额不合规'); return
      }
    }
    if (!store.lastWriteOk()) { toast('保存失败，空间可能已满'); return }
    toast(f.id ? '改好了' : '目标已定下')
    closeGlSheets()
    renderGoal()
  }
  async function removeGoal() {
    const id = glState.form.id
    const ok = await askConfirm('删掉这个目标？', '已经存的钱不会自动记账，删了只是不再跟踪',
      { okText: '删除', danger: true })
    if (!ok) return
    await store.deleteGoal(id)
    closeGlSheets()
    renderGoal()
    toast('已删除')
  }
  function openDeposit(idx) {
    const g = store.getGoals()[idx]
    if (!g) return
    glState.depositGoal = { id: g.id, name: g.name }
    glState.depositMode = 'in'
    $('dp-title').textContent = '给「' + g.name + '」存一笔'
    $('dp-amt').value = ''
    $('dp-tip').textContent = '还差 ¥' + M.fmt(M.toYuan(Math.max(0, M.toCents(M.parse(g.target)) - M.toCents(M.parse(g.saved))))) + ' 就够目标了'
    renderDpSeg()
    renderDpQuick()
    $('gl-sheet-deposit').hidden = false
    $('gl-mask').classList.add('show')
    requestAnimationFrame(() => $('gl-sheet-deposit').classList.add('show'))
  }
  function renderDpSeg() {
    $('dp-seg').querySelectorAll('.dp-seg-i').forEach(b =>
      b.classList.toggle('on', b.dataset.m === glState.depositMode))
  }
  function renderDpQuick() {
    $('dp-quick').innerHTML = DEPOSIT_QUICK.map(v =>
      '<button class="dq" data-v="' + v + '">+' + v + '</button>'
    ).join('')
    $('dp-quick').querySelectorAll('.dq').forEach(b => {
      b.onclick = () => {
        const cur = M.parse($('dp-amt').value)
        $('dp-amt').value = String(M.toYuan(M.toCents(cur) + M.toCents(Number(b.dataset.v))))
      }
    })
  }
  async function submitDeposit() {
    const amt = M.parse($('dp-amt').value)
    if (!(amt > 0)) { toast('先输入金额'); return }
    const delta = glState.depositMode === 'out' ? -amt : amt
    const goal = store.getGoals().filter(g => g.id === glState.depositGoal.id)[0]
    if (!goal) { toast('目标已不存在'); return }
    await store.depositToGoal(glState.depositGoal.id, delta)
    if (!store.lastWriteOk()) { toast('保存失败，空间可能已满'); return }
    toast((delta > 0 ? '存进 ¥' : '取出 ¥') + M.fmt(amt))
    closeGlSheets()
    renderGoal()
  }

  /* =========================================================================
     我的（me）
     ========================================================================= */
  function renderMe() {
    const s = store.stats()
    const meta = store.getMeta()
    const created = meta.createdAt || Date.now()
    const days = Math.max(1, Math.round((Date.now() - created) / 86400000))
    $('me-head').innerHTML =
      '<div class="hc-mask"></div>' +
      '<span class="hc-t">简记</span>' +
      '<span class="hc-s">' + (s.months ? '已经记了 ' + s.records + ' 笔，坚持了 ' + s.months + ' 个月' : '还没有开始记录') + '</span>' +
      '<div class="hc-grid">' +
      '<div class="hc-i"><span class="hc-v num">' + s.records + '</span><span class="hc-k">记账笔数</span></div>' +
      '<div class="hc-i"><span class="hc-v num">' + s.months + '</span><span class="hc-k">记账月数</span></div>' +
      '<div class="hc-i"><span class="hc-v num">' + days + '</span><span class="hc-k">使用天数</span></div></div>'
    const goals = store.getGoals()
    let savedCents = 0
    for (let i = 0; i < goals.length; i++) savedCents += M.toCents(M.parse(goals[i].saved))
    $('me-goaltext').textContent = goals.length ? '已攒 ¥' + M.fmt(M.toYuan(savedCents)) : '还没有目标'
  }

  /* =========================================================================
     设置（settings）
     ========================================================================= */
  function renderSettings() {
    const s = store.getSettings()
    $('set-appearance').innerHTML = store.appearanceList().map(a =>
      '<button class="seg-a ' + (a.key === store.getAppearance() ? 'on' : '') + '" data-v="' + a.key + '">' + a.name + '</button>'
    ).join('')
    $('set-appearance').querySelectorAll('.seg-a').forEach(b => {
      b.onclick = async () => {
        await store.setAppearance(b.dataset.v)
        applyAppearance()
        renderSettings()
      }
    })
    const themes = store.themeList()
    $('set-themename').textContent = (themes.filter(t => t.key === store.getTheme())[0] || { name: '系统蓝' }).name
    $('set-themes').innerHTML = themes.map(t =>
      '<button class="th-item ' + t.cls + ' ' + (t.key === store.getTheme() ? 'on' : '') + '" data-k="' + t.key + '">' +
      '<span class="th-dot"></span><span class="th-name">' + esc(t.name) + '</span>' +
      (t.key === store.getTheme() ? '<span class="th-check">✓</span>' : '') + '</button>'
    ).join('')
    $('set-themes').querySelectorAll('.th-item').forEach(b => {
      b.onclick = async () => {
        await store.setTheme(b.dataset.k)
        applyAppearance()
        renderSettings()
      }
    })
    const total = M.parse(s.budget.total)
    $('set-budgettext').textContent = total > 0 ? '¥' + M.fmt(total) + ' / 月' : '未设置'
  }

  async function doBackup() {
    /* P0：按真实内容判断是否可备份（有记录 / 有目标 / 有预算） */
    let recCount = 0
    const keys = store.getMonthKeys()
    for (let i = 0; i < keys.length; i++) recCount += store.getRecords(keys[i]).length
    const goalCount = store.getGoals().length
    const total = (store.getSettings().budget && store.getSettings().budget.total) || 0
    if (!recCount && !goalCount && !(M.parse(total) > 0)) {
      toast('还没有数据可以备份')
      return
    }
    const text = store.exportJSON()
    let copied = false
    try {
      await navigator.clipboard.writeText(text)
      copied = true
    } catch (e) { /* WebView 未授权剪贴板时降级为手动复制 */ }
    await askConfirm(
      copied ? '备份已复制到剪贴板' : '备份已生成',
      '内容共 ' + text.length + ' 个字符。' + (copied
        ? '建议立刻粘贴到备忘录或文件保存，别留在剪贴板里被覆盖。下方文本框也可手动复制。'
        : '自动复制不可用，请全选下方文本手动复制保存。'),
      { okText: '知道了', hideCancel: true }
    )
  }
  function doRestore() {
    $('rs-text').value = ''
    $('rs-sheet').hidden = false
    $('gl-mask').classList.add('show')
    requestAnimationFrame(() => $('rs-sheet').classList.add('show'))
  }
  async function submitRestore() {
    const text = $('rs-text').value || ''
    if (!text.trim()) { toast('先粘贴备份文本'); return }
    const ok = await askConfirm('确认恢复？', '同一个月的记录会被备份里的内容替换掉，其他月份不受影响。',
      { okText: '恢复', danger: true })
    if (!ok) return
    const out = await store.importJSON(text)
    const writeFailed = out.ok && !store.lastWriteOk()
    $('rs-sheet').classList.remove('show')
    $('gl-mask').classList.remove('show')
    setTimeout(() => { $('rs-sheet').hidden = true }, 300)
    await askConfirm(
      out.ok ? (writeFailed ? '部分恢复' : '恢复完成') : '没能恢复',
      writeFailed ? out.msg + '。但部分写入失败，建议重试。' : out.msg,
      { okText: '知道了', hideCancel: true }
    )
    if (out.ok) { applyAppearance(); render(curPage) }
  }
  async function doSeed() {
    const keys = store.getMonthKeys()
    const thisMonth = keys.length ? keys[0] : ''
    const exist = thisMonth ? store.getRecords(thisMonth).length : 0
    const content = exist
      ? '本月已有 ' + exist + ' 笔真实记录，填入示例会先把它们清空并覆盖。建议先「备份数据」。确定继续？'
      : '会填入 26 笔示例账，方便你先看看效果。'
    const ok = await askConfirm('填入示例数据？', content, { okText: '继续', danger: !!exist })
    if (!ok) return
    if (exist) {
      const ok2 = await askConfirm('最后确认', '真的要清空本月 ' + exist + ' 笔记录吗？此操作不可恢复。',
        { okText: '确定填入', danger: true })
      if (!ok2) return
    }
    const n = await store.seedDemo()
    if (!store.lastWriteOk()) { toast('保存失败，空间可能已满'); return }
    await askConfirm('已填入 ' + n + ' 笔', '回到「首页」看本月进度，去「统计」看分类占比。',
      { okText: '好', hideCancel: true })
    render(curPage)
  }
  async function doClear() {
    const ok = await askConfirm('清空所有数据？', '所有账目、预算、攒钱目标都会被删除，无法恢复。',
      { okText: '继续', danger: true })
    if (!ok) return
    const ok2 = await askConfirm('最后确认一次', '真的要把全部数据删掉吗？建议先做一次备份。',
      { okText: '确定删除', danger: true })
    if (!ok2) return
    await store.clearAll()
    applyAppearance()
    render(curPage)
    toast('已清空')
  }

  /* ================= 启动 ================= */
  async function boot() {
    store.setWriteFailHandler(async function () {
      await askConfirm('保存失败', '写入没有保存成功（数据库可能被占用或磁盘空间不足）。建议先备份，再重试。',
        { okText: '知道了', hideCancel: true, danger: true })
    })
    await store.init()
    applyAppearance()

    /* 关于页版本号与实际包版本对齐 */
    try {
      if (IN_TAURI && window.__TAURI__ && window.__TAURI__.app && window.__TAURI__.app.getVersion) {
        window.__TAURI__.app.getVersion().then(function (v) {
          const el = document.getElementById('about-ver')
          if (el && v) el.textContent = 'v' + v + ' · Windows 桌面端'
        }).catch(function () { })
      }
    } catch (e) { /* 非 Tauri 环境忽略 */ }

    /* meta：记录打开次数（与小程序一致） */
    const meta = store.getMeta()
    meta.openCount = (meta.openCount || 0) + 1
    meta.lastOpen = Date.now()
    store.saveMeta(meta)

    /* 首页日期输入上限 */
    $('add-date').max = D.today()

    /* 事件绑定 */
    document.querySelectorAll('.nav-item').forEach(b => { b.onclick = () => goto(b.dataset.page) })
    document.addEventListener('click', e => {
      const go = e.target.closest('[data-goto]')
      if (go) goto(go.dataset.goto)
    })
    $('idx-goadd').onclick = openCqSheet
    $('idx-howhead').onclick = () => {
      const body = $('idx-howbody')
      body.hidden = !body.hidden
      $('idx-howcaret').textContent = body.hidden ? '›' : '⌄'
    }
    $('cq-cancel').onclick = closeCqSheet
    $('cq-mask').onclick = closeCqSheet
    $('cq-save').onclick = saveCq
    $('cq-keep').onclick = keepCq
    $('cq-amt').oninput = e => { e.target.value = sanitizeAmount(e.target.value) }

    $('add-typeseg').querySelectorAll('.type-seg-i').forEach(b => {
      b.onclick = () => {
        if (b.dataset.t === addState.type) return
        addState.type = b.dataset.t
        addState.cat = C.catsOf(addState.type)[0].key
        addState.catTouched = false
        addState.autoHint = false
        refreshAddView()
      }
    })
    $('add-amt').oninput = e => {
      e.target.value = sanitizeAmount(e.target.value)
      reguess()
    }
    $('add-note').oninput = e => {
      $('add-noteclear').hidden = !e.target.value
      reguess()
    }
    $('add-noteclear').onclick = () => {
      $('add-note').value = ''
      $('add-noteclear').hidden = true
      reguess()
    }
    $('add-save').onclick = submitAdd

    $('st-prev').onclick = () => loadStats(D.shiftMonth(stState.ym, -1))
    $('st-next').onclick = () => {
      if (stState.ym < D.thisMonth()) loadStats(D.shiftMonth(stState.ym, 1))
    }
    $('st-monthlabel').onclick = openMonthPicker
    $('py-cancel').onclick = closePicker
    $('py-mask').onclick = closePicker
    $('py-stepback').onclick = () => { stState.pickerStep = 'year'; renderPicker() }
    $('py-prevdec').onclick = () => {
      const start = stState.decadeStart - 10
      if (start < stState.minYear) return
      stState.decadeStart = start
      stState.years = buildDecade(start)
      stState.canNextDecade = true
      renderPicker()
    }
    $('py-nextdec').onclick = () => {
      const start = stState.decadeStart + 10
      const maxDecade = Math.floor(stState.maxYear / 10) * 10
      if (stState.decadeStart >= maxDecade) return
      stState.decadeStart = start
      stState.years = buildDecade(start)
      stState.canNextDecade = start < maxDecade
      renderPicker()
    }

    $('bd-total').oninput = () => recalcBd()
    $('bd-save').onclick = saveBudget
    $('bd-clear').onclick = clearBudget
    $('bd-fillhist').onclick = fillByHistory

    $('gl-cancel').onclick = closeGlSheets
    $('gl-mask').onclick = closeGlSheets
    $('gl-save').onclick = submitGoalForm
    $('gl-del').onclick = removeGoal
    $('gl-deadline').oninput = () => { $('gl-deadclear').hidden = !$('gl-deadline').value }
    $('gl-deadclear').onclick = () => { $('gl-deadline').value = ''; $('gl-deadclear').hidden = true }
    $('dp-cancel').onclick = closeGlSheets
    $('dp-ok').onclick = submitDeposit
    $('dp-seg').querySelectorAll('.dp-seg-i').forEach(b => {
      b.onclick = () => { glState.depositMode = b.dataset.m; renderDpSeg() }
    })
    $('dp-amt').oninput = e => { e.target.value = sanitizeAmount(e.target.value) }

    $('set-backup').onclick = doBackup
    $('set-restore').onclick = doRestore
    $('rs-cancel').onclick = () => {
      $('rs-sheet').classList.remove('show')
      $('gl-mask').classList.remove('show')
      setTimeout(() => { $('rs-sheet').hidden = true }, 300)
    }
    $('rs-ok').onclick = submitRestore
    $('set-seed').onclick = doSeed
    $('set-clear').onclick = doClear
    $('set-how').onclick = () => {
      const body = $('set-howbody')
      body.hidden = !body.hidden
      $('set-howcaret').textContent = body.hidden ? '›' : '⌄'
    }

    /* 启动页 */
    render('index')
  }

  function runBoot() {
    Promise.resolve(boot()).catch(function (e) {
      /* 启动异常兜底：写失败弹窗机制覆盖不到启动阶段，至少让用户看见 title 变化 */
      document.title = '启动异常: ' + (e && e.message ? e.message : e)
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runBoot)
  } else {
    runBoot()
  }
})()
