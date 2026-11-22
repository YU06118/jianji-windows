# 简记 · Windows 桌面端

家庭记账工具「简记」的 Windows 桌面端，基于 **Tauri v2 + SQLite** 构建，数据完全存本机。

> 本仓库从原整合仓库拆分而来；该整合仓库现为 [`YU06118/jianji-android`](https://github.com/YU06118/jianji-android)（Android 端），历史 Windows 发版 v0.1.2–v0.1.8 与 `latest.json` 仍随其 Releases 保留，原链接经 GitHub 重定向继续可用。
> 四端总导航（文档集合与直达）：[`YU06118/jianji`](https://github.com/YU06118/jianji)。微信小程序端（主端）：[`YU06118/jianji-miniprogram`](https://github.com/YU06118/jianji-miniprogram)；macOS 端：[`YU06118/jianji-macos`](https://github.com/YU06118/jianji-macos)；Android 端（骨架）：[`YU06118/jianji-android`](https://github.com/YU06118/jianji-android)。

## 功能概览（v0.2 · 与微信小程序 1:1 对齐）

> 2026-11-22 起前端整体重写，界面与功能逻辑完全对齐小程序 `main` 分支（Apple 卡片体系 v5）。

- **首页**：预算 hero（还能花 / 超支 / 预警三态）、记一笔弹窗、今日·本月·收入三格、近 7 天柱状图、最近记录（点击改、✕ 删）、常用档位快捷记账
- **记一笔**：支出/收入分段、金额清洗、备注自动猜分类（奶茶→餐饮）、今日概览、日期上限今天
- **统计**：本月共花（笔数·日均·收入·结余）、分类环形图（Canvas DPR 适配）、分类条目点击展开每一笔、近 6 个月对比、年月两级选择器
- **预算**：每月总预算 + 12 项分项预算、近 3 个月平均一键填入、超支红/预警黄
- **目标**：攒钱目标卡片（emoji 图标）、存一笔/取一笔、进度预测（按当前速度约 X 年 X 月存够）
- **我的 / 设置**：记账笔数·月数·使用天数、外观（深色/浅色/跟随系统）、主题色（系统蓝/紫罗兰/青蓝/森绿）、剪贴板备份/粘贴恢复、示例数据、清空数据（双重确认）
- **数据可靠性**：金额内部按「分」整数运算、写失败弹窗拦截（不提示成功、不跳页）
- **跨端互通**：备份 JSON `app:'mama-ledger'` 格式与小程序一致，可互相导入

### 与小程序的差异（桌面端适配）

| 小程序 | 桌面端 |
|---|---|
| 震动反馈 wx.vibrateShort | 微动画（按压态/淡入） |
| tabBar 底部导航 | 顶部 7 项导航 |
| 下拉刷新 | 省略（数据写穿，实时刷新） |
| 长按删除记录 | 行尾 ✕ 按钮 + 自绘确认弹层 |
| 原生 ActionSheet/Toast | 自绘 sheet / toast（WebView2 原生 confirm 不可靠） |
| 小票图片选择 wx.chooseMedia | 省略（后续版本接入文件对话框） |

## 快速开始

```bash
# 前端为原生 HTML/JS，无构建步骤；直接用浏览器打开预览
# 完整桌面端需 Rust + Tauri 环境
cd desktop
npm install
npm run tauri dev
```

前置依赖：Node.js、Rust（rustup）、WebView2（Win11 通常已内置）。

```bash
npm run tauri build          # 打包 MSI/NSIS 安装包
node ../shared/core.test.js  # 共享核心逻辑单测（26 项）
```

## 目录结构

```
desktop/
├── frontend/              原生 HTML/CSS/JS 前端
├── src-tauri/             Rust 后端（Tauri 命令、SQLite、通知、更新）
│   └── src/main.rs        17 个 Tauri 命令 + 插件注册 + 通知定时器
shared/                    双端共享数据契约与核心算法（仅参照/单测，运行时内置）
docs/                      API、更新日志、部署、热更新、交接文档
prototypes/                桌面端视觉原型（浏览器直接打开）
.github/workflows/         tag 触发的签名发版流水线
```

## 文档索引

- `docs/使用与部署说明.md` — 运行环境、构建、部署
- `docs/API.md` — Tauri 命令层、设置项、共享核心接口
- `docs/CHANGELOG.md` — 版本演进
- `docs/热更新设计与使用说明.md` — 更新机制、安全模型、发布 SOP、回滚
- `docs/GitHub上传流程.md` — 日常上传与 tag 自动发版
- `docs/项目进度交接文档-2026-11-21.md` — 现状、待办、架构要点、已知问题
- `docs/交付清单.md` — 交付内容总览

## 安全与数据

数据本地优先：`jianji.db`（SQLite）+ `images\`，位于 `data_dir` 返回目录。零网络请求（热更新除外）。

## 许可与作者

个人项目，作者 YU06118。
