# 简记 · Windows 桌面端

家庭记账工具「简记」的 Windows 桌面端，基于 **Tauri v2 + SQLite** 构建，数据完全存本机。

> 本仓库从原整合仓库 `YU06118/jianji` 拆分而来（原仓库已归档）。微信小程序端见 [`YU06118/jianji-miniprogram`](https://github.com/YU06118/jianji-miniprogram)。

## 功能概览

- 记一笔：系统输入法金额输入、支出/收入、分类、备注、日期、小票图片
- 明细：按日期分组、关键词搜索、筛选 chips、编辑/删除、回收站
- 统计：周/月/年/多年维度、真实数据三卡、分类对比、热力图
- 分类管理：新建/编辑/删除，事件委托绑定
- 每日记账提醒：自定义时分（仅应用运行时有效）
- 数据：CSV 导出 + JSON 备份/导入；浏览器环境降级走 localStorage
- 热更新：GitHub Releases + minisign 签名，tag 推送自动发版
- 外观：跟随系统 / 浅色 / 深色三档

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
