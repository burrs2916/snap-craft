# SnapCraft 跨平台编译产物兼容性复盘与修复（2026-07-18）

> 目标：确保 GitHub Actions 编译出的软件在 **Windows** 与 **macOS** 上现有功能都能正常运行、不得出现偏差；功能只增不减。

## 一、复盘结论（兼容性风险地图）

基于代码审查 + `tests/PARITY_TEST_STRATEGY.md`，两平台**命令契约一致**但**实现机制完全分叉**（`#[cfg(target_os="macos")]` vs `#[cfg(not(target_os="macos"))]`）。定位到 3 个会在 Windows 真机/CI 暴露、macOS 开发机却正常的偏差根因：

| # | 风险 | 严重度 | 现象 | 根因 |
|---|---|---|---|---|
| **P0** | `clipboard-ocr` 窗口 ACL 缺口 | 🔴 致命 | Windows 点「剪贴板取字」无反应 | `capabilities/default.json` 的 `windows` 数组缺 `"clipboard-*"` → 该动态窗口在 Windows 被 Tauri 2 ACL 拒绝，前端 `.catch` 静默吞掉 |
| **R2** | `get_platform` 失败回落到 `'macos'` | 高 | Windows 误走 macOS 专属分支（快捷键提示 ⌘⇧、区域截屏走 `screencapture -i`） | `EnhancedScreenshotApp.tsx` 的 `.catch` 硬编码 `setPlatform('macos')` |
| **结构** | Windows Rust 路径 PR 阶段零编译校验 | 高 | 仅 push 到 main 的 Windows 构建才暴露编译错误，PR 无门禁 | `cargo-check` 仅跑 macOS；Windows `build` 仅 `push`/`workflow_dispatch` 触发 |

> 核查项（已确认**非问题**，未改）：
> - **G14 Windows 权限 UI**：`PermissionSettings.tsx` 对 `get_platform !== 'macos'` 一律标记已授权、无崩溃，前端分支健壮。
> - **R5 Windows 屏幕录制权限恒返回 `true`**：属刻意安全选择（避免吓退用户），真实 xcap 截屏失败仍会透出错误，不掩盖故障。

## 二、已落地修复（功能只增不减）

### 1. 🔴 P0：`clipboard-ocr` 窗口 ACL 放行（Windows 剪贴板取字从「坏了」变「可用」）
`src-tauri/capabilities/default.json` 的 `windows` 数组补 `"clipboard-*"`：
```json
"windows": ["main","pin-*","region-overlay","window-overlay","editor-*","ai-panel","clipboard-*"]
```
→ 动态创建的 `clipboard-ocr` WebviewWindow 在 Windows 真机不再被 ACL 拒绝；剪贴板取字成为 Windows 上**可用**功能（此前为静默失效）。

### 2. R2：平台判定失败回落改为 UA 兜底（杜绝 Windows 误走 macOS 分支）
`src/features/screenshot/EnhancedScreenshotApp.tsx`：
- 新增 `detectPlatformFromUA()`：IPC 失败时改用 `navigator.userAgent` 判定（`'windows' | 'macos' | 'linux'`，与 Rust `std::env::consts::OS` 一致）。
- `.catch` 由原来的 `setPlatform('macos')` 改为 `detectPlatformFromUA()`，并 `console.warn` 留痕。
→ Windows / Linux 在 `get_platform` 调用异常时，绝不会再被错误当作 macOS。

### 3. 新增 CI 能力一致性 Lint（预防「clipboard-* 类」ACL 回归）
新增 `tests/lint-capabilities.mjs`（零依赖、零平台依赖）：
- 静态扫描 `src/**/*.{ts,tsx}` 全部 `new WebviewWindow/Window(...)` 与 `getByLabel(...)` 提取运行时窗口 label 全集（含变量解析与模板串前缀推导）；
- 解析 `src-tauri/capabilities/*.json` 的 `windows` glob 集合；
- 断言每个运行时 label 至少被一个 glob 覆盖，并校验动态建窗所需 `core:webview:allow-create-webview-window` / `core:window:allow-create` 权限齐全；
- 不达标 → `exit 1`。
- 已接入 `build.yml` 的 `typecheck` job（PR/push 即跑，先于构建阻断）。
- **负向验证**：临时移除 `clipboard-*` 时 lint 精确报 `窗口 label "clipboard-ocr" 未被任何 capability glob 覆盖` 并 `exit 1`，恢复后 `exit 0` —— 证明该门禁真正生效。

### 4. 新增 Windows 编译门禁（PR 阶段即编译校验 Windows 专属代码）
`build.yml` 新增 `cargo-check-win` job（Windows 专属，PR 阶段即跑）：
- `runs-on: windows-latest`，目标 `x86_64-pc-windows-msvc`，`cargo check --locked`；
- 复用 Windows 专用 Cargo 缓存路径；
- `build` job 的 `needs` 增加 `cargo-check-win`，Windows 真机构建前先过编译门禁。
→ `#[cfg(not(target_os="macos"))]` 的 xcap 截屏 / OCR 等 Windows 分支在合并前即被编译校验，杜绝「仅 Windows Release 才暴露的编译错误」。

## 三、验证结果

| 项 | 命令 | 结果 |
|---|---|---|
| 能力一致性 Lint | `node tests/lint-capabilities.mjs` | ✅ exit 0（含负向测试 exit 1） |
| 前端类型门禁 | `pnpm exec tsc --noEmit` | ✅ exit 0 |
| CI 配置合法性 | YAML 解析 + capability JSON 解析 | ✅ 6 job 均有效，`build.needs` 含 `cargo-check-win` |
| 运行时 label 全集 | lint 扫描 39 个 .ts/.tsx | 具体 `ai-panel / clipboard-ocr / region-overlay / window-overlay` + 模板前缀 `pin-` + `editor-*`，全部被 glob 覆盖 |

## 四、仍须 Windows 真机/自托管巡检的项（headless CI 无法验证，已记录于 PARITY_TEST_STRATEGY.md §2）

- **G1/G3** Windows 真实像素截屏（xcap 需真实桌面会话，无头 CI 黑屏）
- **R4** 多显示器坐标（主屏不在原点 / 负坐标 / 混合 DPI）—— `capture_xcap_screen` 用 `Monitor::from_point(0,0)`，主屏非原点时可能误取；属需真机验证的优化点，未经真机验证前**未盲目改动**
- **G8** Windows OCR 语言包缺失路径（`NO_OCR_ENGINE`）+ 多语言包安装后行为
- **G10** WebView2 Runtime 缺失引导
- **G4** SmartScreen 拦截（未签名 exe/msi 首次运行）

以上均依赖带显示器的 Windows 真机，CI 仅能守住房建/契约/能力层；本次修复已把可在 CI 拦截的全部偏差清零。

## 五、变更文件清单

- `src-tauri/capabilities/default.json`（+1 行：`"clipboard-*"`）
- `src/features/screenshot/EnhancedScreenshotApp.tsx`（R2 UA 兜底 + helper）
- `tests/lint-capabilities.mjs`（新增，CI 能力 Lint）
- `.github/workflows/build.yml`（新增 `cargo-check-win` job + typecheck 步骤 + `build.needs`）

> 说明：工作区另存在 round-18 的未提交改动（edit.rs / locales / EditorWindow.tsx 等），属既有工作，本次未触碰。
