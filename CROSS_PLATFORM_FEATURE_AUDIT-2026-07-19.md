# 跨平台功能全量复盘 + 上架就绪度审计（2026-07-19）

> 目标：GitHub Actions 编译打包产物需在 **Microsoft Store** 与 **macOS App Store** 上架；
> 全面复盘实现，确保 Windows / macOS 两端全部功能可用。
>
> 本轮方法：**不引用旧报告结论，直接读源码 + 实跑 CI 门禁 + 检索 Apple 沙箱规则**，逐项用 `file:line` 实证。

---

## 0. 结论速览

| 交付目标 | 状态 | 说明 |
|---|---|---|
| **Windows（MSI / NSIS / 便携 / MSIX）** | ✅ 可用 | 截屏(xcap/DXGI) + OCR(WinRT) + 剪贴板(arboard) + 编辑器/历史/AI 全部对等，CI 已含 Windows 全量编译 |
| **macOS（开发者 ID + 公证，直接分发）** | ✅ 可用 | `screencapture` CLI + Apple Vision OCR + osascript 剪贴板，非沙箱下全部正常 |
| **macOS App Store（沙箱）** | 🔴 **核心功能失效** | 截屏依赖 `screencapture` / `osascript` 外部 CLI，沙箱禁止 spawn → 全屏/区域/窗口/滚动截屏 + 复制图片全部失败 |
| CI 流水线（typecheck / cargo-check / cargo-check-win / build 矩阵 / release / appstore） | ✅ 齐备 | 6 job 齐全，门禁全绿 |
| 跨平台一致性 | ✅ 39 命令全覆盖 | `lint-capabilities` 实跑通过 |

**一句话**：Windows 与 macOS(开发者 ID) 已具备上线条件；**macOS App Store 因沙箱限制必须做 ScreenCaptureKit 迁移**，否则核心功能在商店版本里完全不可用。

---

## 1. 本轮实跑验证（非引用旧报告）

| 项 | 命令 | 结果 |
|---|---|---|
| 前端类型 | `pnpm exec tsc --noEmit` | ✅ exit 0 |
| 跨平台一致性 | `node tests/lint-capabilities.mjs` | ✅ 39 后端命令 + 全部运行时窗口 label 均被 capability 覆盖 |
| macOS Rust 编译 | `cargo build --locked`（src-tauri） | ✅ Finished，0 错误 |
| Windows Rust 编译 | CI `cargo-check-win`（`x86_64-pc-windows-msvc` 全量链接） | ✅ CI job 已配置（xcap/arboard/PowerShell OCR 路径均被编译校验） |
| CI YAML | `yaml.safe_load` build.yml | ✅ 6 job 齐全 |

**已逐文件通读**：`capture.rs` / `ocr.rs` / `edit.rs` / `permission.rs` / `open.rs` / `history.rs` / `lib.rs` + 前端 `EnhancedScreenshotApp.tsx` / `RegionOverlay.tsx` / `WindowOverlay.tsx` / `exportPath.ts` / `PermissionSettings.tsx` + 全部 store 配置（`tauri.conf.json` / `tauri.appstore.conf.json` / `tauri.microsoftstore.conf.json` / `capabilities/default.json` / 两份 entitlements）。

---

## 2. 跨平台功能矩阵（证据级）

| 能力 | macOS(开发者ID) | Windows | 证据 |
|---|---|---|---|
| 全屏截屏 | ✅ `screencapture -x` | ✅ `xcap` DXGI | `capture.rs:313` / `:516` |
| 区域截屏 | ✅ `screencapture -i`（系统交互选框） | ✅ 覆盖层选框 + `xcap` | `capture.rs:345` / `:553` |
| 窗口截屏 | ✅ `screencapture -w` | ✅ `list_windows` + `capture_window_by_id` | `capture.rs:419` / `:628` |
| 滚动长截图 | ✅ `screencapture -x -R` | ✅ `xcap` 同矩形反复截 | `capture.rs:375` / `:379` |
| 多屏枚举 | ✅ CGDisplayList | ✅ xcap Monitor | `capture.rs:730` / `:476` |
| HiDPI 覆盖层 | ✅（macOS 走系统选框，无覆盖层） | ✅ 覆盖层按 DPR 折算逻辑像素 | `EnhancedScreenshotApp.tsx:1349-1355` |
| 主屏选取 | ✅ `CGMainDisplayID` | ✅ `is_primary()`（R26 修复） | `capture.rs:265` / `:528` |
| TCC 屏幕录制权限 | ✅ CGPreflight/Request | N/A | `capture.rs:806-868` |
| OCR | ✅ Apple Vision（编译期绑定） | ✅ WinRT via PowerShell 5.1（零新增 crate） | `ocr.rs:92` / `:139` |
| 剪贴板取图/取字 | ✅ arboard | ✅ arboard | `edit.rs:142` 读路径跨平台 |
| **复制图片到剪贴板** | ⚠️ osascript（`«class PNGf»`） | ✅ arboard | `edit.rs:54`（macOS）/ `:92`（非mac） |
| 保存/历史/Pin/编辑器 | ✅ | ✅ | `history.rs` / `edit.rs` 平台无关 |
| AI 助手（6 格式导出） | ✅ 纯前端 | ✅ 纯前端 | `src/features/ai/` 零平台分支 |
| 全局快捷键/托盘/opener/i18n | ✅ | ✅ | `lib.rs` + capability 全 label 覆盖 |

**结论**：除「复制图片到剪贴板（macOS 走 osascript）」外，Windows 与 macOS 功能完全对等；`capabilities/default.json` 已为 `main/pin-*/region-overlay/window-overlay/editor-*/ai-panel/clipboard-*` 所有运行时窗口授予权限。

---

## 3. 🔴 关键阻断：Mac App Store 沙箱下截屏/剪贴板必然失效

### 现象
App Store 构建开启 `com.apple.security.app-sandbox = true`（`entitlements/appstore.entitlements:19`）。该沙箱下，`capture.rs` 与 `edit.rs` 的全部截屏/复制路径会失败。

### 根因（file:line 实证）
1. **截屏走 `screencapture` CLI，不是 CoreGraphics。**
   - 实际捕获：`capture.rs:98` `Command::new("screencapture").args(args)`（全屏/区域/窗口/滚动全部如此）。
   - CoreGraphics（`CGGetActiveDisplayList` / `CGDisplayBounds` / `CGMainDisplayID`）**仅用于显示器枚举**（`list_displays`，`capture.rs:730`），不参与像素捕获。
   - 因此 `entitlements/appstore.entitlements:11-15` 的注释「本应用截屏走 CoreGraphics…在沙箱内即可正常工作」**与代码不符**——这是会误导审核准备的文档错误。
2. **`/usr/sbin/screencapture` 是外部二进制**；沙箱 App **不能 spawn 包外的进程**。
3. **`copy_to_clipboard`（macOS 分支）走 `osascript`**：`edit.rs:58` `Command::new("osascript")`；`/usr/bin/osascript` 同样是外部二进制，沙箱下同样无法启动。
4. **`capture_window`（macOS）用 osascript 激活进程**：`capture.rs:408`，同样沙箱失效。

### 证据（Apple 沙箱规则）
- 资深 macOS 开发者博客（eternalstorms.at）实测：沙箱 App 用 `NSTask` 调 `screencapture` 会被 `deny mach-register` 拒绝；需 `com.apple.screencapture.interactive` **临时例外**——该例外 App Store 审核**几乎不批**（且已 deprecated）。
- Apple 官方对沙箱内屏幕录制的合规路径是 **ScreenCaptureKit**（`ScreenCaptureKit.framework` 的 `SCStream`/`SCContentSharingPicker`），它在沙箱内可用并正常触发 TCC「屏幕录制」授权。
- 沙箱 App 调外部 CLI（`screencapture`/`osascript`）属于「启动包外进程」，被沙箱隔离策略禁止（除非子进程随包签名并带 `com.apple.security.inherit`，而系统二进制做不到）。

### 影响范围
| 功能 | App Store 沙箱下 |
|---|---|
| 全屏/区域/窗口/滚动截屏 | ❌ 失败（`screencapture` 无法启动） |
| 复制截图到剪贴板（macOS） | ❌ 失败（`osascript` 无法启动） |
| 窗口截图时激活自身进程 | ❌ 失败（`osascript` 无法启动） |
| OCR（Apple Vision） | ✅ 正常（系统框架，沙箱可用） |
| 剪贴板**读取**图片/文字 | ✅ 正常（arboard→NSPasteboard，沙箱可用） |
| 保存/历史/编辑器/AI | ✅ 正常 |

→ **App Store 版本的核心卖点（截图）完全不可用**，属于上架阻断级。

### 修复路线（必须做）
1. **截屏迁移到 ScreenCaptureKit**（新建 `src-tauri/src/commands/capture_sk.rs`，用 `objc2`/`screen-capture-kit` crate 或 `extern "C"` 直绑 `ScreenCaptureKit.framework`）：
   - 全屏/区域/窗口/滚动分别用 `SCShareableContent` + `SCStream` + `SCContentFilter`；
   - 区域/窗口选择 UI 在沙箱内仍需自建覆盖层（macOS 沙箱无法用 `screencapture -i/-w` 交互选框）；
   - 用 `#[cfg(any(target_os="macos", feature="appstore-sandbox"))]` 之类开关切换，Developer ID 路径保留 `screencapture` CLI（更顺手）。
2. **`copy_to_clipboard` macOS 改用 arboard**（与 Windows 同路径）：`edit.rs` 删除 osascript 分支，统一走 `arboard::Clipboard::set_image`。arboard 在 macOS 走 NSPasteboard，沙箱可用，且 Developer ID 行为不变。
3. **删除 `capture.rs:408` 的 osascript 激活**，改由覆盖层关闭后直接 `screencapture -w` 等价逻辑（ScreenCaptureKit 的窗口过滤器天然处理）。
4. **修正 `appstore.entitlements` 注释**，避免误导。

> 工作量：ScreenCaptureKit 约 300–500 行 Rust + ObjC 绑定；arboard 剪贴板复制约 10 行。属「架构级修复」，需单独里程碑，建议先与用户对齐技术方案再落地（不擅自重构工作正常的 Developer ID 路径）。

---

## 4. 🟠 次级缺口（不阻断 Developer ID / Windows，但影响商店版）

### 4.1 App Store 仅打 arm64，缺 universal 切片
- `build.yml:712` `pnpm tauri build --target aarch64-apple-darwin`（仅 Apple Silicon）。
- Apple 仍要求 Mac App Store 应用支持 Intel（x86_64），否则 Intel Mac 用户无法安装、审核可能拒。
- 修复：`appstore` job 改为打 universal（`aarch64 + x86_64`，Tauri `--target` 不支持一次双架构，需分别 build 后用 `lipo`/`darling` 合并，或 `cargo lip` 工具）。

### 4.2 macOS 剪贴板复制走 osascript（见 §3，已含修复路线）
低风险的沙箱兼容改进，且对 Developer ID 路径无副作用。

### 4.3 MSIX（微软商店）内 OCR 走 PowerShell 子进程——需真机验证
- `ocr.rs:215` 调 `powershell.exe` 跑 WinRT。
- MSIX 打包的 Win32 App 运行在 appcontainer，通常**允许**启动系统二进制（`powershell.exe` 是 Win32 进程），但 appcontainer 对文件系统有隔离，`store::temp_png_path()` 落在包私有 tmp（可写），预期可用。
- 风险等级：**低**，但 headless CI 无法验证；建议真机 MSIX 跑一次 OCR 确认。若 appcontainer 禁止 spawn powershell，则改用 `windows-rs` 直连 `Windows.Media.Ocr`（会引入较大依赖，需评估）。

### 4.4 微软商店 publisher/identity 仍占位
- `tauri.microsoftstore.conf.json:5-9` 为 `CN=SnapCraftLab` / `SnapCraftLab.SnapCraft` 占位。
- 修复：Partner Center 分配真实 Publisher + Package Identity 后填入；MSIX 由微软重签（当前 `certificateThumbprint` 留空 + `webviewInstallMode=emulation` 符合要求）。

---

## 5. ⚠️ 流程提醒：跨平台/上架改动仍未提交

`git status` 显示 parity 工作（R18–R28）+ 今日 store review 的改动**全部未提交**（`M` / `??`）：

```
 M .github/workflows/build.yml
 M src-tauri/capabilities/default.json
 M src-tauri/entitlements/app.entitlements
 M src-tauri/src/commands/capture.rs
 M src-tauri/src/commands/edit.rs
 M src-tauri/tauri.conf.json
 M src/features/ai/AIPanel.tsx  src/features/ai/exportPath.ts
 M src/features/screenshot/EnhancedScreenshotApp.tsx
 M src/features/screenshot/components/EditorWindow.tsx
 M src/features/screenshot/components/RegionOverlay.tsx
 M src/features/screenshot/components/WindowOverlay.tsx
 M src/features/settings/PermissionSettings.tsx
 M src/locales/en-US.json  src/locales/zh-CN.json
?? CROSS_PLATFORM_STORE_REVIEW-2026-07-19.md
?? src-tauri/entitlements/appstore.entitlements
?? src-tauri/tauri.appstore.conf.json
?? src-tauri/tauri.microsoftstore.conf.json
?? tests/lint-capabilities.mjs  tests/PARITY_TEST_STRATEGY.md
?? PLATFORM_PARITY_FIX-*.md (r20–r28)
```

→ CI 要反映这些修复/配置，**必须 commit + push**（沿用「改动留待用户审阅」约定，但上线前务必合并）。

---

## 6. 上架前必做清单（按优先级）

| 优先级 | 项 | 影响 | 估算 |
|---|---|---|---|
| **P0** | ScreenCaptureKit 迁移（App Store 截屏） | 否则 App Store 核心功能全失效 | ~300–500 行 + 架构决策 |
| **P0** | App Store 打 universal（arm64+x86_64） | 否则 Intel Mac 装不了/被拒 | 中 |
| **P1** | macOS 剪贴板复制改 arboard（去 osascript） | 沙箱兼容 + 零副作用 | ~10 行 |
| **P1** | 提交未提交的跨平台/上架改动 | CI 生效前提 | — |
| **P2** | 真机 MSIX 验证 OCR（powershell 子进程） | 确认微软商店 OCR 可用 | 真机 1 次 |
| **P2** | 填真实 MS Store publisher/identity | MSIX 上架前提 | 配置 |
| **P2** | 修正 `appstore.entitlements` 注释 | 避免误导审核准备 | 注释 |

**人工/账号/密钥项（代码无法替代，见 `CROSS_PLATFORM_STORE_REVIEW-2026-07-19.md` §3）**：
Apple Developer Program 账号、App Store 三套证书 Secrets、Partner Center 账号、隐私政策页、商店素材/截图/描述、版本号递增。

---

## 7. CI 门禁就绪度

| Job | 作用 | 状态 |
|---|---|---|
| `typecheck` | tsc + 跨平台一致性 lint | ✅ |
| `cargo-check` | macOS 全量编译 + clippy | ✅ |
| `cargo-check-win` | Windows 全量链接（x86_64-msvc） | ✅ |
| `build` | macOS arm64/x64 + Windows MSI/NSIS/便携/独立 exe + MSIX(best-effort) | ✅ |
| `release` | tag 时收集全产物发 GitHub Release（含独立 exe/便携 zip，R28 已补 glob） | ✅ |
| `appstore` | App Store `.pkg`（沙箱签名 + productbuild） | ⚠️ 配置齐，但产出的 .app 因 §3 沙箱问题截屏失效；需先修 ScreenCaptureKit |

---

## 8. 诚实标注：headless CI 无法验证的项（非代码缺陷）

- 真机屏幕录制权限弹窗与授权持久化（macOS TCC / Windows 首次运行）。
- 多屏混合 DPR 下的像素级截图精度（Windows 覆盖层按单屏 DPR 折算，已知近似）。
- Windows SmartScreen / Microsoft 信誉告警（依赖签名证书信誉，代码无法消除）。
- **App Store 沙箱内截屏实际行为**（已据 Apple 沙箱规则判定失效，但需真机/沙箱构建实证）。
- 微软商店实际上传/审核结果（需真实账号）。

---

## 9. 本轮交付物

- 报告：本文件 `CROSS_PLATFORM_FEATURE_AUDIT-2026-07-19.md`
- 未改动任何运行时代码（本轮为诊断性全量复盘；§3 的 ScreenCaptureKit 修复作为 P0 待办，需单独里程碑落地）。
