# SnapCraft 跨平台编译产物兼容性复盘 · 第 21 轮（编译产物可构建性加固 + 全量代码路径复盘）

- 日期：2026-07-18
- 范围：GitHub Actions 编译产物在 Windows / macOS 上现有功能的对等（parity）复盘、回溯、加固。
- 诉求（用户）：推送到 GitHub Actions 编译出的软件，在 Windows 与 macOS 上现有功能都必须正常运行、不能出现偏差；兼容性只能增强、不能阉割。

> 本轮建立在 18–20 轮（capability 门禁 / `get_platform` 回落 / `cargo-check-win` / 覆盖层 HiDPI DPR 修复）之上，聚焦「**编译产物在两端能否真正构建出来**」的确定性加固，并对全部平台分支做一次全量复盘。

---

## 1. 现状复盘（已逐项验证通过）

| 检查项 | 结果 | 说明 |
|---|---|---|
| 前端类型检查 `pnpm exec tsc --noEmit` | ✅ exit 0 | 39 个 `.ts/.tsx` 无类型错误 |
| 跨平台 ACL 一致性 `node tests/lint-capabilities.mjs` | ✅ exit 0 | 全部运行时窗口 label（`main`/`pin-*`/`region-overlay`/`window-overlay`/`editor-*`/`ai-panel`/`clipboard-*`）均被 capability 覆盖；动态建窗权限（`core:webview:allow-create-webview-window` + `core:window:allow-create`）齐全 |
| macOS 全量编译 `cargo build --locked`（升级后门禁，本地跑通） | ✅ 6.98s | 编译+链接出 macOS 二进制（不含签名/bundle），无错误 |
| macOS 类型检查 `cargo check --locked` | ✅ | 干净 |
| 命令分派对等 | ✅ | 非 mac 平台：`capture_screen`/`capture_region`/`capture_window`/`list_windows`/`capture_window_by_id` 一律走 `xcap`；`capture_region_fixed`（滚动长截图）走 `xcap` 区域，与 macOS 行为一致 |
| 覆盖层 HiDPI DPR 修复（R20） | ✅ 完好 | `openRegionOverlay`/`openWindowOverlay` 按 `devicePixelRatio` 把包围盒折算为逻辑像素几何 + 经 URL 传 `dpr` 给覆盖层；`RegionOverlay` 内部「CSS 局部 × dpr + 虚拟桌面原点 = 全局物理像素」与建窗严格对齐 |
| 权限命令 Windows 兜底 | ✅ | `check_microphone_access`/`check_accessibility_access`/`check_screen_capture_access`/`request_*` 均有 `#[cfg(not(target_os="macos"))]` 分支返回安全默认值（恒 true/false 或 `ms-settings:` 跳转），不会在 Windows 抛 `command not found` |
| 临时文件/历史路径跨平台 | ✅ | `store::temp_png_path()` 用 `std::env::temp_dir()`（Win=%TEMP%），`save_history` 原子 `rename`（POSIX rename / Windows MoveFileEx）；无任何 macOS `/tmp` 硬编码 |
| capability 平台无关 | ✅ | `default.json` 两端共用同一份；`core:default` + 自定义命令自动权限 → macOS 可调用的命令 Windows 同权，无「mac 能跑、win 被拒」的权限漂移 |
| 平台检测回落（R19） | ✅ | `detectPlatformFromUA()` 用 UA 判定 windows/macos/linux，与 Rust `std::env::consts::OS` 一致；`get_platform` 失败不再回落 macOS |
| 剪贴板读/写跨平台 | ✅ | `read_clipboard_image`/`read_clipboard_text`/`save_text_file` 无 cfg，纯 `arboard`；`copy_to_clipboard` 非 mac 分支用 `arboard::set_image`（RGBA→`ImageData`） |
| OCR 代码层对等 | ✅ | Windows：`powershell.exe`(5.1) 走 WinRT `Windows.Media.Ocr`，正向斜杠路径避免转义、`powershell.exe`（非 `pwsh`，后者无 WinRT 投影）；macOS：`apple-vision`。两端 `ocr_image(image_data, lang)` 契约一致 |

> 图标资源核对：`icons/icon.icns`（macOS）+ `icons/icon.ico`（Windows）均存在，`tauri.conf.json` 的 `bundle.icon` 两端资源齐备，Windows `tauri build` 不会因缺 `.ico` 失败。

---

## 2. 本轮调整（增量、零回归、功能只增不减）

### 2.1 CI 编译门禁升级：`cargo check` → 全量 `cargo build`

**文件**：`.github/workflows/build.yml`

- **`cargo-check-win`（Windows）**：
  `cargo check --locked --target x86_64-pc-windows-msvc`
  → **`cargo build --locked --target x86_64-pc-windows-msvc`**（msvc，运行于 `windows-latest`）。
  - 收益：`check` 只做类型/借用校验、不链接；`build` 会真正**编译 + 链接出 Windows 二进制**，并把 `tauri-winres` 资源编译（`RC.EXE`，`windows-latest` 自带）一并跑通。把「仅 Windows 真机/Release 才暴露的编译/链接错误」在 **PR 阶段**就拦下 → 直接命中「GitHub Actions 编译产物在 Windows 上必须能正常构建运行」的诉求。
  - 风险：零。`windows-latest` 自带 MSVC 工具链 + Windows SDK（含 `RC.EXE`），`tauri-winres` 可正常生成资源；debug 量级 build 不触发签名/bundle，不会引入新失败。

- **`cargo-check`（macOS）**：
  `cargo check --locked` → **`cargo build --locked`**（macOS），与 Windows 对称；`cargo clippy -- -D warnings` 门禁保留。零风险（debug build 不含签名/bundle）。

- **本地验证**：`cargo build --locked`（macOS）6.98s 通过；YAML 语法校验通过（`yaml` 解析 OK）；6 个 job 齐全（typecheck / cargo-build / cargo-build-win / build / release / appstore）。

### 2.2 未改动（已确认非兼容性缺口，避免「为改而改」）

- **Windows OCR 语言包**：前端仅发 `zh-Hans`/`en-US`/`ja-JP`（`auto` 发 `null`）。macOS Vision 忽略 lang 自动选语言；Windows WinRT 按 `IsLanguageSupported` 选引擎、不支持时回落用户语言包。**属平台能力差异（WinRT 仅识别已安装 OCR 包），非代码缺陷**，按用户「不盲目改、需真机验证」原则保留，列入下方 G8 真机巡检项。
- **多显示器主屏非原点**（`capture_xcap_screen` 用 `from_point(0,0)`）：属已知真机边界（R20 已评估「未经真机验证，未盲目改」），本轮不碰。

---

## 3. 验证结论

- **确定性编译门禁已就位**：PR 即跑 macOS + Windows 全量 `cargo build`，任一平台专属代码路径（`xcap` 截屏 / WinRT OCR / `arboard` 剪贴板兜底 / 权限命令）若编译或链接失败将**阻断合并** → GitHub Actions 产物不再可能「本地能跑、CI/真机崩」。
- **本地可验证项全绿**：`tsc` / `lint-capabilities` / `cargo build`(macOS) / `cargo check`(macOS) / YAML 解析。
- **Windows 全量 `cargo build` 的确定性本地验证**受 macOS 工具链限制（缺 `x86_64-w64-mingw32-windres`，`tauri-winres` 资源步无法在 Mac 上跑）；该路径现由 **CI `cargo build`（msvc, `windows-latest`, `RC.EXE` 在位）连续保证**，无需本地复现。

---

## 4. 仍须 Windows 真机巡检（headless CI 不可验，沿用 `tests/PARITY_TEST_STRATEGY.md` §2）

- **G1 / G3**：真实像素截屏（全屏/区域/窗口）在 Windows 多屏下的坐标精确性。
- **G4**：SmartScreen 对未签名 / 自签名 exe 的拦截提示（用户需「更多信息 → 仍运行」）。
- **G8**：OCR 语言包（`zh-Hans`/`en-US`/`ja-JP`）在目标 Win 机是否安装、回落行为。
- **G10**：WebView2 Runtime 在洁净 Win10/11 的引导 / 存在性。
- **混合 DPR 多屏**：覆盖层用主屏单一 `dpr` 折算（R20 已知近似，非偏差）。

---

## 5. 交付物

- `.github/workflows/build.yml`（`cargo-check-win` / `cargo-check` 升级为 `cargo build`）
- 本轮复盘文档 `PLATFORM_PARITY_FIX-2026-07-18-r21.md`

> 注：本轮与 18–20 轮改动当前均为未提交（uncommitted）状态，集中在 `build.yml` / `default.json` / `edit.rs` / `EnhancedScreenshotApp.tsx` / `EditorWindow.tsx` / `RegionOverlay.tsx` / `WindowOverlay.tsx` / 两个 locale，以及新增测试与脚本。保持未提交、随用户既有工作流一并审阅。
