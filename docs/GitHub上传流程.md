# 简记 · GitHub 仓库说明与上传流程

> 仓库：https://github.com/YU06118/jianji ｜ 主分支：`main` ｜ 更新：2026-11-17

## 一、仓库现状

| 内容 | 位置 |
|---|---|
| 共享数据契约与核心逻辑（26 项单测） | `shared/` |
| Windows 桌面端（Tauri v2 + SQLite + 热更新） | `desktop/` |
| 微信小程序端（Apple 冷调主题，自检 88+118 全过） | `简记小程序/` |
| 两端视觉原型（自包含可预览） | `prototypes/` |
| 文档（需求/部署/热更新/GitHub） | `docs/` |
| 发布流水线（tag 触发自动构建签名发布） | `.github/workflows/release.yml` |

同步约定：**每完成一个文件/模块即提交并推送一次**（用户要求的实时同步）。

## 二、提交约定

| 前缀 | 含义 |
|---|---|
| feat(x) | 新功能（x = shared / desktop / miniprogram / prototypes / docs / ci） |
| fix(x) | 缺陷修复 |
| test(x) | 测试与自检 |
| chore / docs / ci | 版本号 / 文档 / 流水线 |

## 三、日常上传流程（手动）

```bash
cd C:\Users\TDavid\WorkBuddy\2026-11-17-19-34-16
git add <文件>
git commit -m "feat(desktop): 变更说明"
git push origin main          # 网络抖动（502/CONNECT tunnel）时稍候重试即可
```

凭据：Windows 凭据管理器已存 GitHub 账号 **YU06118** 的令牌，git push 免密。

## 四、发版上传流程（自动，推荐）

发新版只需两步，其余全部由 CI 完成：

```bash
# 1) 改版本号三处：desktop/src-tauri/tauri.conf.json、desktop/src-tauri/Cargo.toml、desktop/package.json
git add . && git commit -m "chore: bump x.y.z"
# 2) 打 tag 推送
git tag vX.Y.Z && git push origin main vX.Y.Z
```

CI（约 10 分钟）自动完成：
1. Windows runner 构建 + minisign 签名
2. 创建 Release，上传 `jianji_x.y.z_x64-setup.exe`（+ .sig）
3. 生成并上传 `latest.json`（热更新清单，含签名内容）
4. （已配置 COS Secrets 时）同步安装包与 latest.json 到腾讯云 COS 镜像

验收检查：
- `https://github.com/YU06118/jianji/releases/latest/download/latest.json` 可访问，且 `platforms["windows-x86_64"].url` 指向 NSIS 安装包
- 已装旧版应用"设置 → 检查更新"能走完整更新流程

## 五、Secrets 清单（仓库 Settings → Secrets and variables → Actions）

| Secret | 用途 | 状态 |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 更新包 minisign 签名私钥 | ✅ 已配置 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码（当前为空） | ✅ 已配置 |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | 腾讯云 COS 镜像同步 | ⬜ 待用户提供后配置 |
| `COS_BUCKET` / `COS_REGION` | 桶名（含 APPID）/ 地域（如 ap-guangzhou） | ⬜ 同上 |

> COS 未配置时流水线自动跳过镜像同步，不影响 GitHub 单源热更新；私钥文件本体在 `%USERPROFILE%\.tauri\jianji.key`，**丢失将无法签发后续更新**，务必备份。

## 六、不入库内容（.gitignore）

- `desktop/node_modules/`、`desktop/src-tauri/target/`、`desktop/src-tauri/gen/`
- `.workbuddy/`（会话数据）、系统临时文件
- **签名私钥永不入库**（在本机用户目录，且建议另行备份到离线介质）
