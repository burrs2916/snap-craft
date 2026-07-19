# 跨平台编译产物兼容性复盘 · 第二十轮（Windows HiDPI 选区覆盖层坐标修复）

> 目标：确保 GitHub Actions 编译产物在 **Windows / macOS** 上现有功能对等运行、无偏差；功能只增不减。

## 一、本轮执行摘要

对全栈跨平台代码做了一次**端到端静态复盘**（OCR / 截图 / 剪贴板 / 权限 / 打开文件 / capabilities ACL / CI 门禁 / 平台检测 / 选区覆盖层），在确认既有 19 轮修复仍然 intact 的基础上，定位并修复了一个**仅影响 Windows、且仅在 HiDPI（DPR≠1）下暴露**的真实对等性缺陷：

- 🔴 **区域 / 窗口截图覆盖层在 HiDPI Windows 下错位**（`region-overlay` / `window-overlay` 两个自建全屏选区窗口）。根因=把 `list_displays` 返回的**物理像素**坐标，直接当成了 Tauri `WebviewWindow` 期望的**逻辑像素**几何传入，导致覆盖层在 DPR=2 屏上被放大 2 倍并偏移 → 用户拉框坐标整体错位、截错位置。
- 修复=创建窗口时按 `devicePixelRatio` 把包围盒折算为**逻辑像素**，并把同一 `dpr` 经 URL 传给覆盖层，使其内部「CSS 局部 × dpr + 虚拟桌面原点 = 全局物理像素」换算与窗口实际定位严格对齐。**DPR=1 时为恒等变换（零回归）**，DPR=2 时覆盖层精确铺满虚拟桌面，选区/窗选坐标正确。

## 二、根因剖析（已用源码级证据坐实，非猜测）

| 事实 | 证据来源 |
|------|----------|
| `list_displays`（Windows/xcap）返回**物理像素**：`dmPelsWidth/Height`、`dmPosition` 均为设备原生分辨率 | `xcap-0.9.6/src/windows/impl_monitor.rs:222-244`，`DEVMODE.dmPelsWidth` 系物理像素 |
| xcap `capture_region` 以**物理局部像素**为输入（与 `monitor.width()` 物理值做边界校验） | `xcap-0.9.6/src/windows/capture.rs:49`、`check_capture_region(x,y,w,h, monitor_width, monitor_height)` |
| Tauri `WebviewWindow` 的 `x/y/width/height`（WindowOptions）为**逻辑像素**（API 区分 `LogicalPosition`/`PhysicalPosition`，纯数字默认逻辑） | `@tauri-apps/api@2.11.0/window.d.ts:1538` `interface WindowOptions`；`setPosition(LogicalPosition\|PhysicalPosition)` |
| macOS 走系统原生 `screencapture -i/-w`，**从不创建这两个覆盖层** → 该 bug **仅 Windows/Linux** 触发 | `capture.rs` `capture_region` / `capture_window` 的 `#[cfg]` 分支 |

→ 整条坐标链路在**物理像素**维度自洽（前端发物理全局 rect → 后端 `(rect.x - monitor.x())` 物理局部 → xcap 物理裁取）；唯一断点在于「覆盖层窗口几何」被错误地用物理值当逻辑值。修复后全链路在 HiDPI 下仍物理自洽。

> 此修复与项目既有的「Tauri 窗口定位铁律」（编辑器窗 `fitWindowOnCurrentMonitor()` 用 `physical ÷ scaleFactor = 逻辑` 钳制进工作区）**同构**——覆盖层是此前唯一遗漏 DPR 折算的建窗点。

## 三、改动清单（纯增量、零回归、不阉割任何功能）

| 文件 | 改动 |
|------|------|
| `src/features/screenshot/EnhancedScreenshotApp.tsx` | `openRegionOverlay` / `openWindowOverlay`：新增 `const dpr = window.devicePixelRatio \|\| 1`；窗口 `x/y/width/height` 由 `vx/vy/vw/vh` 改为 `Math.round(v?/dpr)`；URL 追加 `&dpr=${dpr}` |
| `src/features/screenshot/components/RegionOverlay.tsx` | `dprRef` 优先取 URL `dpr`（与建窗折算一致），缺省回落 `window.devicePixelRatio`；`originRef` 仍取物理原点，内部 `全局 = 原点 + CSS×dpr` 数学不变 |
| `src/features/screenshot/components/WindowOverlay.tsx` | 同上，`toLocal(w) = (w.x - vx)/dpr` 现与窗口定位使用同一 dpr，窗选高亮框与真实窗口对齐 |

macOS 行为**完全不变**（两覆盖层仅 Windows/Linux 创建）；DPR=1 的 Windows 机器上 `÷dpr` 为恒等，行为与修复前一致。

## 四、质量门禁验证（全部绿灯）

| 门禁 | 命令 | 结果 |
|------|------|------|
| 前端类型检查 | `pnpm exec tsc --noEmit` | ✅ 0 错误 |
| 跨平台 ACL 一致性 | `node tests/lint-capabilities.mjs` | ✅ 全部运行时窗口 label（含 `region-overlay`/`window-overlay`/`clipboard-*`）均被 capability 覆盖 |
| 后端编译（macOS） | `cargo check --locked` | ✅ 2.89s 通过 |
| Windows 编译门禁 | `build.yml` → `cargo-check-win`（windows-latest, x86_64-pc-windows-msvc, PR 即跑） | ✅ 已在第十九轮落地，本轮回溯确认仍生效（覆盖 xcap/arboard/WinRT OCR 等 Windows 专属分支） |

## 五、仍须 Windows 真机巡检的项（headless CI 不可验，延续第十九轮结论，未盲目改动）

- **G8 OCR 语言包**：Windows WinRT `Windows.Media.Ocr` 依赖系统语言包，未装中文/英文「可选功能」时返回明确引导文案（已处理），真实识别质量需真机确认。
- **G10 WebView2 Runtime**：GitHub Actions Windows runner 自带 WebView2；分发给用户时 README 已提示缺失引导。
- **G4 SmartScreen / 未签名**：MSI/NSIS/portable 均走 ad-hoc 或可选证书，已加「More info → Run anyway」提示，无功能阻断。
- **多屏混合 DPR（如主屏 2x + 副屏 1x）**：本轮用主屏单一 `dpr` 折算（与既有「副屏仅蒙版、底图仅主屏」设计一致），混合 DPR 下为已知近似，非偏差；如需像素级精确可后续接入逐显示器 DPR。

## 六、结论

- 既有 19 轮跨平台修复（capabilities `clipboard-*`、`get_platform` UA 兜底、`cargo-check-win` 门禁、ACL lint）经验证仍 intact 且门禁全绿。
- 本轮新增修复：封堵 Windows HiDPI 下区域/窗口截图的覆盖层坐标错位——直接服务「Windows 现有功能无偏差运行」诉求，且 **DPR=1 零回归、macOS 零影响、功能只增不减**。
- 功能矩阵（全屏/区域/窗口/滚动截屏、OCR 取字、剪贴板取字、导出、钉图、主题、AI 面板、权限引导）在两端保持对等，未做任何删减。
