# 简记 · API 文档

> 本文面向需要改代码或接入数据的开发者。日常使用请看 [使用与部署说明](使用与部署说明.md)。
> 源码中的注释与实现始终是最终依据；本文只描述稳定调用面。

## 一、桌面端：Tauri 命令层

前端运行在**无打包器**环境，`withGlobalTauri: true` 会把 API 注入 `window.__TAURI__`。
**必须使用全局对象调用，不要用裸模块导入**（`import('@tauri-apps/api/...')` 在无打包器前端会抛错）。

```js
// 调用命令
await window.__TAURI__.core.invoke('list_records', { includeDeleted: 0 })
// 监听更新进度
const unlisten = await window.__TAURI__.event.listen('updater://progress', ({ payload }) => {
  console.log(payload.downloaded, payload.total)
})
```

> 参数以 camelCase 传入，Rust 侧以 snake_case 接收（Tauri 自动转换）。

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `list_records` | `includeDeleted?: number` | `Record[]` | 流水列表；`1` 包含回收站 |
| `save_record` | `record: Record` | `void` | 新增或更新一笔（按 id upsert） |
| `trash_record` | `id: string, deleted: number` | `void` | 移入 / 恢复回收站 |
| `purge_trash` | — | `void` | 清空回收站（物理删除） |
| `list_categories` | — | `Category[]` | 预设 + 自定义分类 |
| `save_category` | `category: Category` | `void` | 新增 / 更新分类 |
| `delete_category` | `id: string` | `void` | 删除自定义分类 |
| `get_setting` | `key: string` | `string \| null` | 读取设置项 |
| `set_setting` | `key: string, value: string` | `void` | 写入设置项 |
| `export_backup` | — | `object` | 导出全量 JSON 备份（内存对象） |
| `import_backup` | `payload: string` | `number` | 导入 JSON，返回导入条数 |
| `import_backup_from` | `path: string` | `number` | 从本地 JSON 文件导入（前端 dialog 选路径，Rust 直接读文件，绕过 fs 作用域），返回导入条数 |
| `save_backup_to` | `path: string` | `void` | 把备份写到指定文件路径 |
| `save_image` | `srcPath: string, name: string` | `string` | 保存小票图片，返回应用内路径 |
| `data_dir` | — | `string` | 返回 `%APPDATA%\com.jianji.ledger` 实际路径 |
| `updater_check` | `source?: 'official' \| 'mirror'` | `UpdateMeta \| null` | 检查更新；不传=双源自动。结果暂存供下载用 |
| `updater_download_install` | — | `void` | 下载并安装已暂存的更新（静默安装后自动退出） |

`UpdateMeta = { version: string, notes: string, current_version: string }`。
更新进度事件：`updater://progress` → `{ downloaded: number, total: number }`。

**设置项 key（`get_setting` / `set_setting`）**
| key | 取值 | 默认 | 说明 |
|---|---|---|---|
| `auto_update_check` | `'1'` / `'0'` | `'1'` | 启动时静默检查更新 |
| `update_source` | `'auto'` / `'official'` / `'mirror'` | `'auto'` | 更新下载源 |
| `remind_daily_enabled` | `'1'` / `'0'` | `'1'` | 每日记账提醒开关 |
| `remind_daily_time` | `'HH:MM'` | `'21:00'` | 每日提醒时间（前端设置，Rust 定时器读取） |
| `remind_daily_last_fired` | `'YYYY-MM-DD'` | — | 当日已提醒标记，Rust 侧写入用于去重 |
| `theme_mode` | `'system'` / `'light'` / `'dark'` | `'system'` | 桌面端外观：跟随系统 / 浅色 / 深色 |

**注意事项**
- 检查更新必须先于下载安装调用，否则返回错误"请先执行检查更新"。
- WebView2 下原生 `confirm()` / `alert()` / `prompt()` 静默失效，所有确认与输入框必须用自绘模态框（见 `frontend/index.html` 的 `#upd-modal` / `#confirm-modal`）。
- 每日提醒由 Rust 独立线程每 15 秒轮询 `remind_daily_*` 设置，到点经 `tauri-plugin-notification` 弹系统通知；**仅应用运行时有效**，关闭应用后不提醒。
- 数据文件：`jianji.db`（SQLite）+ `images\`，均在 `data_dir` 返回的目录。
- 小票查看：图片经 `window.__TAURI__.core.convertFileSrc(data_dir + '\\images\\' + image)` 转 URL 显示；需 `tauri.conf.json` 开启 `assetProtocol`（scope `$APPDATA/**`）且 `Cargo.toml` 的 tauri 依赖启用 `protocol-asset` feature。

## 二、小程序端：`utils/store.js`（数据层）

纯 CommonJS 模块，不依赖页面，可单独在 Node 中测试。所有写入口都经 `utils/safe.js` 白名单清洗。

### 2.1 基础 CRUD

| 方法 | 说明 |
|---|---|
| `initIfEmpty()` | 首次启动时初始化索引与默认设置 |
| `getMonthKeys()` / `getAllRecords(monthsLimit)` | 有记录的月份列表 / 跨月汇总读取 |
| `getRecords(ym)` / `saveRecords(ym, list)` | 单月读写（key 形如 `ledger_rec_2026-11`） |
| `addRecord(rec)` / `updateRecord(ym, id, patch)` / `deleteRecord(ym, id)` | 单笔记录的增改删（删除走标记，保留索引一致性） |

`Record` 关键字段：`id, type('expense'|'income'), amount, category, note, date, ts`。

### 2.2 设置与外观

| 方法 | 说明 |
|---|---|
| `defaultSettings()` | 默认设置对象（预算、主题、外观、提醒等） |
| `getSettings()` / `saveSettings(s)` | 设置读写 |
| `getMeta()` / `saveMeta(m)` | 元信息（首次使用时间、打开次数） |
| `getTheme()` / `setTheme(name)` / `themeList()` / `themeClass()` / `themeColor()` / `themeTint(t)` | 四套主题色（themeClass 返回 `.t-*`，themeColor 返回浅色档强调色——**自检依赖此语义，勿改**） |
| `getAppearance()` / `setAppearance(v)` / `appearanceList()` | 外观三档 `'dark' \| 'light' \| 'system'`，默认 dark |
| `isDark()` / `systemIsDark()` / `modeClass()` | 当前是否深色 / 系统是否深色 / 根节点 class（`.mode-dark` 或 `.mode-light`） |
| `navColor()` | 导航栏色常量 `'#1E1A2E'`（theme.json 两档均已配置同色，API 只做兜底） |

> WXSS 的 `prefers-color-scheme` 无法被 JS 覆盖，因此主题 token 在根节点用 `.mode-dark` / `.mode-light` **全量重声明**；新增 token 时两处都要加。

### 2.3 攒钱目标

| 方法 | 说明 |
|---|---|
| `getGoals()` / `saveGoals(list)` | 目标数组读写 |
| `addGoal(goal)` / `updateGoal(id, patch)` / `deleteGoal(id)` | 目标增改删 |
| `depositToGoal(id, delta, note)` | 存入一笔，写日志并更新进度 |

### 2.4 统计与备份

| 方法 | 说明 |
|---|---|
| `summary(ym)` | 单月收入 / 支出 / 结余汇总（内部金额一律转"分"再累加） |
| `recentMonths(n, endYm)` / `recentDays(n)` | 近 n 月 / 近 n 日序列 |
| `budgetStatus(ym)` | 预算状态（时间进度、花钱进度、节奏差、预计月底总额、预警文案） |
| `quickTags(limit)` | 从近 3 个月记录学出的快捷标签 |
| `stats()` | 统计页聚合数据 |
| `exportJSON()` / `importJSON(text)` | 备份文本导出 / 导入（上限 2MB，白名单重建） |
| `clearAll()` / `seedDemo()` | 清空全部数据 / 填入示例账本 |

### 2.5 `utils/safe.js` — 输入校验

导出 `LIMITS` 与 `cleanText, cleanAmount, cleanDelta, cleanType, cleanCat, cleanDate, cleanId, cleanTs, cleanRecord, cleanGoal, cleanSettings, parseBackup, csvCell`，另有 `isMonthKey, isDateStr`。

**规则**：不是"过滤掉坏的"，而是"只挑认识的字段重新拼对象"的白名单重建。
`store.js` 每个写入口已接入；**新增写入口必须先在这里加清洗规则**。

`LIMITS` 摘要：备注 30 字 / 目标名 20 字 / 备份 2MB / 月数 36 / 单月 2000 笔 / 合计 20000 笔 / 目标 30 个 / 单目标日志 500 条 / 单笔 ≤ 999 万。

### 2.6 其他工具模块

| 模块 | 导出（摘要） |
|---|---|
| `utils/money.js` | `toCents, toYuan, sumYuan, fmt, yuan, short, pct, parse` — 全部金额先转整数分 |
| `utils/date.js` | `today, thisMonth, toDateStr, toMonthKey, parseMonth, daysInMonth, shiftMonth, monthLabel, daysLeftInMonth, daysPassedInMonth` 等 |
| `utils/categories.js` | `EXPENSE_CATS, INCOME_CATS, ALL_CATS, CAT_MAP, KEYWORDS, DEFAULT_QUICK, BUDGET_CATS, guess, getCat, catName, catEmoji, catColor` — `guess()` 最长关键词优先 |

## 三、共享核心：`shared/core.js`

双端共用的纯函数，无副作用。导出：

| 分类 | 方法 |
|---|---|
| 金额 | `toCents, toYuan, sumYuan, fmt` |
| 日期范围 | `monthKey, yearKey, inRange` |
| 数据查询 | `filterRecords(records, filters), summarize(records), trendSeries(records, dim, anchorDate), heatmap(records)` |
| 导出 | `csvCell, toCSV(records, categories), makeBackup(records, categories, recurring, settings)` |

`dim` 支持 `week / month / year / 3year / 5year`。测试：`node shared/core.test.js`。
