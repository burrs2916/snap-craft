# 跨平台功能复核 + 上架配置复盘（2026-07-19）

> 目标：GitHub Actions 编译打包产物需在 **Microsoft Store** 与 **macOS App Store** 上架；
> 全面复盘实现，确保 Windows / macOS 两端全部功能可用、无明显回归。

## 0. 一句话结论

- **CI 编译/打包流水线已成熟**（typecheck / cargo-check macOS / cargo-check-win 全量链接 / 三平台 build 矩阵 / tag Release / App Store .pkg job 齐全）。
- **跨平台功能对等基本完成**（R18–R28 已落地：截屏/多屏/HiDPI 覆盖层/TCC/OCR/剪贴板/保存/历史/钉图/编辑器/AI 窗/opener/快捷键/托盘/主题 i18n/6 格式导出/ACL/命令注册/WebView2 自包含/macOS x64 等 24 项）。
- **本轮定位并修复 3 个真实「上架阻断级」缺口**（均为配置缺失，非运行时代码）：
  1. 🔴 **macOS 构建直接失败**：`tauri.conf.json` 引用 `entitlements/app.entitlements`，但该文件不存在（旧 `Entitlements.plist` 被删、新文件漏建）→ `tauri build` 报错。已补建。
  2. 🟠 **App Store 打包用错 entitlements**：`appstore` job 用默认（非沙箱）entitlements 打 .app → App Store 必拒（强制 sandbox）。已新增 `appstore.entitlements`（sandbox=true）并用专用 conf 接管。
  3. 🟠 **MS Store 配置缺失 + MSIX 步骤必然失败**：无 `tauri.microsoftstore.conf.json`，且 MSIX 步骤从未 `init`、含一行无效的 `cargo install msixbundle-cli`。已补 Store 配置 + 加 `init` 步骤 + 移除错误命令。

---

## 1. 跨平台功能矩阵复核（证据级）

| 能力 | macOS | Windows | 证据 |
|---|---|---|---|
| 全屏/区域/窗口截屏 | ✅ CGDisplayCreateImage/CGWindowListCreateImage | ✅ xcap(DXGI) | `capture.rs` 全 `#[cfg(target_os)]` 门控 |
| 多屏枚举 | ✅ | ✅ | `capture.rs:315/347/377/421` 等 |
| HiDPI 覆盖层 | ✅ | ✅（DPR 折算） | 覆盖层组件 + 前端 `get_platform` 回落 |
| TCC 屏幕录制权限 | ✅（系统授权） | N/A（Windows 无需） | `permission.rs` macOS 门控 |
| OCR | ✅ Apple Vision | ✅ WinRT via PowerShell（零新增 crate） | `ocr.rs:74/138/281` |
| 剪贴板取字/复制 | ✅ arboard | ✅ arboard | 跨平台 crate |
| 保存/历史/Pin/编辑器 | ✅ | ✅ | `edit.rs`/`history.rs` 门控 |
| AI 助手（6 格式导出） | ✅ 纯前端 | ✅ 纯前端 | `src/features/ai/` 零平台分支 |
| 全局快捷键/托盘/opener/i18n | ✅ | ✅ | capability 全 label 覆盖 |

**一致性门禁（实跑）**：`node tests/lint-capabilities.mjs` → 39 个后端命令 + 全部运行时窗口 label 均被 capability 覆盖、前端 invoke 全注册、无静默失效功能 ✅。`pnpm exec tsc --noEmit` → exit 0 ✅。

---

## 2. 本轮修复清单（纯增量、零运行时代码改动）

| # | 文件 | 改动 | 影响 |
|---|---|---|---|
| 1 | `src-tauri/entitlements/app.entitlements` | **新建**（开发者 ID+公证路径，非沙箱，含 JIT/库校验豁免） | 解除 macOS `tauri build` 构建阻断 |
| 2 | `src-tauri/entitlements/appstore.entitlements` | **新建**（sandbox=true + 用户选文件/Downloads/network.client + JIT 豁免） | App Store 审核合规起点 |
| 3 | `src-tauri/tauri.appstore.conf.json` | **新建**（覆盖 `entitlements` → 沙箱版） | App Store job 用沙箱签名 |
| 4 | `src-tauri/tauri.microsoftstore.conf.json` | **新建**（publisher/identity 占位 + `webviewInstallMode=emulation` + `createWithMakeAppx` + 空 thumbprint） | MS Store 打包配置就绪 |
| 5 | `.github/workflows/build.yml` | `appstore` job 构建加 `--config src-tauri/tauri.appstore.conf.json` | 沙箱 entitlements 生效 |
| 6 | `.github/workflows/build.yml` | MSIX 步骤：加 `tauri-windows-bundle init` 前置步骤；删无效 `cargo install msixbundle-cli`；注释指向 Store 配置 | MSIX 不再因缺 init 必败 |

**验证**：`plutil -lint` 双 entitlements OK；JSON 双 conf OK；`yaml.safe_load` build.yml OK（6 job 齐全）；lint 复跑仍通过。

---

## 3. 上架前仍必须由你（人工/账号/密钥）完成的事项

这些**无法在代码层替代**，需真实证书/账号 + 仓库 Secrets/Vars：

### macOS App Store
1. **Apple Developer Program** 账号（$99/年），App ID `com.snap-craft.app` 已用。
2. **`ENABLE_APPSTORE` 仓库变量**置 `true`，并配置 Secrets：`APPLE_APP_STORE_CERTIFICATE_BASE64` / `_PASSWORD`（3rd Party Mac Developer Application .p12）、`APPLE_APP_STORE_INSTALLER_CERTIFICATE_BASE64` / `_PASSWORD`（Installer .p12）、`APPLE_APP_STORE_SIGNING_IDENTITY`、`APPLE_APP_STORE_INSTALLER_IDENTITY`。
3. **`appstore.entitlements` 需你实测校验**：沙箱内「保存到 Downloads」依赖 `files.downloads.read-write`（已加）；若走保存对话框则 `files.user-selected.read-write`（已加）。截屏走 CoreGraphics + TCC，沙箱内可用，无需 `temporary-exception.screencapture`（该例外 App Store 禁止，已规避）。
4. 上传 `.pkg` 至 App Store Connect 需 `xcrun altool`/Transporter（CI 已产 `.pkg`，上传动作本流水线未自动做，建议手动或接 `apple/action`）。

### Microsoft Store
5. **Microsoft Partner Center** 账号，预留 **Publisher** + **Package Identity**（填入 `tauri.microsoftstore.conf.json` 的 `publisher`/`identity.name` 占位）。
6. **MSIX 由微软重签**：当前 `certificateThumbprint` 留空、`webviewInstallMode=emulation`（不内嵌离线安装包，符合 Store 政策）。
7. 真实提交用 `pnpm tauri build --config src-tauri/tauri.microsoftstore.conf.json` 产未签名 MSIX → Partner Center 上传。

### 通用合规（PRD 已列，非代码阻断）
8. 隐私政策页（中英文，零遥测声明）—— PRD R-C-03。
9. App Store 截图/描述/关键词/EULA；MS Store 截图/分类/年龄分级。
10. `tauri.conf.json` `version` 随发版递增（当前 `0.1.0`）。

---

## 4. 诚实标注：headless CI 无法验证的项（非代码缺陷）

- 真机屏幕录制权限弹窗与授权持久化（macOS TCC / Windows 首次运行）。
- 多屏混合 DPR 下的像素级截图精度（R20 覆盖层按单屏 DPR 折算，已知近似）。
- Windows SmartScreen / Microsoft 信誉告警（代码无法消除，依赖签名证书信誉）。
- 沙箱内「保存到任意目录」的实际行为（需真机 + 真实 entitlements 跑一遍）。
- 商店实际上传/审核结果（需真实账号）。

---

## 5. 当前 CI 流水线状态

| Job | 作用 | 状态 |
|---|---|---|
| `typecheck` | tsc + 跨平台一致性 lint | ✅ |
| `cargo-check` | macOS 全量编译+clippy | ✅ |
| `cargo-check-win` | Windows 全量链接（x86_64-msvc） | ✅（此前仅 PR 后 push 才编译，现已前置） |
| `build` | macOS arm64/x64 + Windows MSI/NSIS/便携/独立 exe | ⚠️ 修复前 macOS 因缺 entitlements 必败；修复后预期绿 |
| `release` | tag 时收集全产物发 GitHub Release | ✅（R28 已补独立 exe/便携 zip glob） |
| `appstore` | App Store .pkg（sandbox 签名） | ✅ 已指向沙箱 conf；需 Secrets+Vars 启用 |

**注意**：本轮改动**尚未提交**。CI 要生效需 `git add` + `commit` + `push`（沿用此前「改动留待用户审阅」的约定）。建议尽快提交 `src-tauri/entitlements/*`、`src-tauri/tauri.*.conf.json`、`.github/workflows/build.yml`。

---

## 6. 交付物
- 新建：`src-tauri/entitlements/app.entitlements`、`src-tauri/entitlements/appstore.entitlements`
- 新建：`src-tauri/tauri.appstore.conf.json`、`src-tauri/tauri.microsoftstore.conf.json`
- 修改：`.github/workflows/build.yml`
- 报告：本文件
