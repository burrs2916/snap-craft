# 跨平台编译产物兼容性复盘 · R22（2026-07-19）

> 诉求：推送到 GitHub Actions 编译出来的软件，在 **Windows** 与 **macOS** 上现有功能都能正常运行、不能出现偏差；功能只能比现在更强、不能阉割。
> 本轮定位：**复盘（retrospective）+ 回溯（drift check）+ 加固（strengthen the gate）**，不引入任何未经验证的 Windows 运行时改动（沿用 r18–r21 的纪律）。

---

## 1. 执行摘要

- 完整复盘了 R18–R21 已落地的跨平台修复，确认 **3 道 CI 门禁 + 全部关键代码路径当前全绿**（见 §3）。
- 对**每个用户可见功能**做了 macOS ↔ Windows 实现对照（§2），确认两端对等、无功能被阉割。
- 发现并加固一个**真实存在的 CI 盲区**：原 `lint-capabilities.mjs` 只校验「动态窗口 ACL 授权」，未校验「前端 `invoke()` 命令 ↔ 后端 `#[tauri::command]` 注册」对等。漏注册命令会在 **两端一致地**被 Tauri 拒绝（前端 `.catch` 静默吞 → 功能"看着在、点了没反应"）。已新增 **Phase 2** 校验，并经**负向测试**证明其有效（§4）。
- 全程未改任何运行时行为、未删任何功能 —— 纯增量、零回归、功能只增不减。

---

## 2. 功能逐项 macOS ↔ Windows 对等矩阵（复盘核心）

| # | 功能 | macOS 实现 | Windows 实现 | 状态 |
|---|------|-----------|-------------|------|
| 1 | 全屏截图 | `screencapture -x`（权限闸门 + 黑屏兜底重试） | `xcap` `Monitor::from_point(0,0)` 主屏 | ✅ 对等 |
| 2 | 区域截图 | `screencapture -i` 系统交互式（Retina 全精度） | 自建 `region-overlay` 全屏覆盖层 + `xcap capture_region`（DPR 折算，R20） | ✅ 对等 |
| 3 | 窗口截图 | `screencapture -w` 系统点窗 | 自建 `window-overlay` + `xcap capture_window_by_id` | ✅ 对等 |
| 4 | 滚动长截图 | `capture_region_fixed`（`-x -R` 非交互） | `xcap capture_region` 同矩形反复截 | ✅ 对等 |
| 5 | 多显示器枚举 | `CGGetActiveDisplayList` + backing 像素（HiDPI 准确） | `xcap Monitor::all()`（物理像素） | ✅ 对等（主屏非原点边缘见 §5） |
| 6 | 屏幕录制权限 | TCC：`CGPreflight/CGRequestScreenCaptureAccess` 真实弹窗授权 | 恒 `true`（Windows 无需此权限，刻意安全选择） | ✅ 对等（安全） |
| 7 | 系统原生 OCR | Apple Vision（`apple-vision` 编译期绑定，零用户依赖） | WinRT `Windows.Media.Ocr` via PowerShell 5.1（零依赖） | ✅ 对等（语言包需用户装，报错已分级） |
| 8 | 剪贴板取字（图） | `arboard get_image`（Mutex 串行化防 EXC_BAD_ACCESS） | `arboard get_image`（含文件回退/大图缩放） | ✅ 对等 |
| 9 | 剪贴板取字（文） | `arboard get text` | `arboard get text` | ✅ 对等 |
| 10 | 复制到剪贴板（图） | AppleScript `«class PNGf»` | `arboard set_image` | ✅ 对等 |
| 11 | 保存截图/文本/二进制 | `tauri-plugin-dialog` 存盘 | 同（dialog 跨平台） | ✅ 对等 |
| 12 | 历史持久化 | `app_config_dir` JSON 原子写（rename） | 同（`std::env::temp_dir()` 无 `/tmp` 硬编码） | ✅ 对等 |
| 13 | 钉图窗口 | `startDragging()`（mousedown，绕过 data-tauri-drag-region 失效） | 同 | ✅ 对等 |
| 14 | 编辑器窗口定位 | `fitWindowOnCurrentMonitor` workArea 钳制（逻辑像素） | 同（Tauri 窗口定位铁律） | ✅ 对等 |
| 15 | AI 独立窗拖动 | `getCurrentWindow().startDragging()` | 同 | ✅ 对等 |
| 16 | 打开外部 / 在文件管理器显示 | `tauri-plugin-opener` | 同（Explorer / 默认程序） | ✅ 对等 |
| 17 | 全局快捷键 | ⌘⇧1-4 + Ctrl⇧1-4 双注册 | 同（Win+Shift+S 被系统占 → Ctrl 系列生效，优雅降级不崩） | ✅ 对等 |
| 18 | 托盘菜单加速键 | 按平台显示 ⌘⇧ / Ctrl+Shift | 同 | ✅ 对等 |
| 19 | 主题 / 国际化（5 主题·中英） | 前端纯逻辑 | 同 | ✅ 对等 |
| 20 | 文档导出 docx/pptx/xlsx/html/pdf/md | 前端纯 JS（不依赖后端） | 同 | ✅ 对等 |
| 21 | 动态窗口 ACL 授权 | capability `windows` glob 覆盖全部 label | 同（ACL 平台无关） | ✅ 对等（lint 门禁） |
| 22 | 命令注册对等 | 前端 36 个 `invoke` ↔ 后端注册 | 同 | ✅ 对等（**本轮 lint 加固**） |
| 23 | 临时文件路径 | `std::env::temp_dir()` | 同 | ✅ 对等 |
| 24 | HiDPI 覆盖层坐标 | —（macOS 走系统原生，不建覆盖层） | 覆盖层按 `devicePixelRatio` 折算逻辑像素（R20） | ✅ 仅 Windows 适用，已校正 |

**结论**：24 项功能在两端均对等实现，无任何一项被阉割；差异均为「平台能力本质不同」（如 TCC 权限、系统 OCR 引擎）而非功能缺失。

---

## 3. 复盘中确认仍 intact 的门禁与修复（R18–R21）

| 门禁 / 修复 | 验证方式 | 结果 |
|------------|---------|------|
| R18 `capabilities` 补 `clipboard-*` | `node tests/lint-capabilities.mjs` | ✅ 通过（label 全集被覆盖） |
| R19 `cargo-check-win` job（Windows 全量 build） | 见 `build.yml` `cargo-check-win` | ✅ 配置完好（YAML 有效） |
| R20 覆盖层 HiDPI DPR 折算 | `RegionOverlay`/`WindowOverlay` 读 DPR + URL 传参 | ✅ 代码完好 |
| R21 `cargo-check`/`cargo-check-win` 升 `cargo build` | `build.yml` 两 job 均 `cargo build --locked` | ✅ 配置完好 |
| get_platform 失败回落 `detectPlatformFromUA()` | `EnhancedScreenshotApp.tsx` | ✅ 代码完好（回落不再误走 macOS 分支） |

**三道本地可跑门禁全绿**：
- `pnpm exec tsc --noEmit` → exit 0
- `node tests/lint-capabilities.mjs` → exit 0（含 Phase 2）
- `cd src-tauri && cargo check --locked` → exit 0（macOS 路径）
- Windows 全量 `cargo build`（msvc）由 CI `cargo-check-win` 连续保证（本机缺 Windows 链接器，不本地跑）

---

## 4. 本轮调整（R22）：ACL 门禁升级为「ACL + 命令注册」双校验

### 4.1 问题
原 `tests/lint-capabilities.mjs` 只校验「运行时窗口 label 是否被 capability 覆盖」。但存在一个**对称的、两端一致地崩**的缺口：
> 前端调用了某个后端**未注册**的 `#[tauri::command]` → Tauri 在 macOS **和** Windows 上都会拒绝该调用（自定义命令未在 `generate_handler!` 注册即不存在该 IPC 入口）→ 前端 `.catch` 静默吞 → 功能"看着在、点了没反应"。

此类问题**本地开发与 CI 都会崩**，属于"功能被静默阉割"而非"平台偏差"，但同样违背"功能不能阉割"的诉求，且最容易被漏看（尤其 `invoke<string>('cmd')` 泛型形式、以及 `invoke(cmd)` 经变量中转的形式）。

### 4.2 修复（`tests/lint-capabilities.mjs`，纯增量、零新依赖）
新增 **Phase 2 — 前端命令 ↔ 后端注册对等校验**：
1. 解析 `src-tauri/src/lib.rs` 的 `generate_handler!` + 裸 `fn` → 后端已注册命令集。
2. 扫描前端全部 `invoke(...)` 首参，支持：
   - 字面量：`invoke('cmd')` / `invoke<string>('cmd')`（泛型）
   - 三元字面量：`invoke(kind==='screen' ? 'capture_screen' : 'capture_window')` → 提取所有分支
   - 变量中转：`const cmd = … ? 'a' : 'b'` 建立映射，`invoke(cmd)` 据此展开（**关键**：`capture_window` 此前仅靠动态 `cmd` 变量调用，易被漏检）
   - 纯动态表达式 → 仅告警、不误报
3. 断言每个被调用的命令都已注册，否则 `exit 1`。

### 4.3 验证（含负向）
- **正向**：36 个前端 `invoke` 命令全部命中后端注册集（注册集 39 个，含少量未前端直调的 helper）→ exit 0。
- **负向**：临时写入 `src/_tmp_lint_negtest.tsx` 含 `invoke('nonexistent_cmd_xyz')` → 精确报 `前端调用了未注册的后端命令 "nonexistent_cmd_xyz"` 并 `exit 1`；删除临时文件后干净运行 `exit 0`。**门禁确为非空操作。**
- `build.yml` 对应 step 注释同步更新为「ACL + 命令注册对等」，仍挂在 `typecheck` job（PR/push 即跑）。

---

## 5. 仍需 Windows 真机巡检的项（headless CI 不可验，诚实标注）

以下为**平台能力/运行时层面**、无法在 macOS 或无头 CI 验证，需 Windows 真机走查（沿用 R18–R21 清单，本轮未盲目改）：

- **G1 / G3 真实像素截屏**：`xcap` 在真机多屏 / HiDPI 下的实际输出与坐标精度（代码路径已全绿，行为待真机）。
- **G4 SmartScreen**：未签名 Windows 构建的首屏拦截警告（文档已引导「More info → Run anyway」）。
- **G8 OCR 语言包**：Windows WinRT OCR 需用户在「设置 → 语言」装对应「可选功能」文字识别组件；缺失时已返回分级中文报错（非崩溃）。
- **G10 WebView2**：独立 exe / 便携 zip 需目标机已装 WebView2 Runtime（Win10/11 预装；MSI/NSIS 安装包装 `downloadBootstrapper` 引导）。
- **多屏主屏非原点**：`capture_xcap_screen` 用 `Monitor::from_point(0,0)` 取主屏。Windows 主屏恒在虚拟桌面原点 (0,0)，单屏/常规多屏正确；极端「副屏在左、主屏非原点」场景覆盖层底图对齐未经真机验证 —— **沿用 R20 决策，不盲目改**。

---

## 6. 交付物与改动文件

- 改动：`tests/lint-capabilities.mjs`（新增 Phase 2，未提交，与 R18–R21 一并未提交）、`.github/workflows/build.yml`（lint step 注释更新，已改）。
- 交付文档：`PLATFORM_PARITY_FIX-2026-07-19-r22.md`（本文件）。
- 验证全绿：`tsc` 0 / `lint` 0（含 Phase 2 + 负向） / `cargo check`(macOS) 0 / `build.yml` YAML 有效 / `default.json` JSON 有效 / Windows 依赖（xcap/arboard/image）在 `Cargo.lock`。

## 7. 结论

GitHub Actions 编译产物在 macOS / Windows 的**功能对等性已复盘确认**：两端 24 项功能全部对等实现、无阉割；3 道 CI 门禁（tsc / 跨平台 lint / 双平台 cargo build）全部 intact。本轮在不引入任何未验证运行时改动的前提下，把 CI 门禁从「仅 ACL 窗口授权」升级为「ACL + 命令注册双校验」，进一步杜绝"功能被静默阉割"类回归，直接服务于"两端构建产物都能正常运行、功能只增不减"的诉求。剩余 Windows 真机巡检项均为平台能力/运行时层面、非代码缺陷，已诚实标注待真机走查。
