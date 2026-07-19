# 平台编译产物兼容性复盘 R27 · 权限设置「打开系统设置」按钮 Windows 静默失效修复

> 自动化：`OCR功能增强`（实际已演进为「GitHub Actions 跨平台编译产物兼容性」专项）
> 轮次：第二十七轮（R27）｜ 日期：2026-07-19
> 诉求：推送到 GitHub Actions 编译出的软件，在 Windows 与 macOS 上现有功能都必须正常运行、无偏差；功能只增不减。

## 执行摘要

确认 R18–R26 全部防线 intact（tsc / lint-capabilities / cargo-check-win / build.yml / tauri.conf.json 有效）后，做整轮跨平台复盘，定位并修复一类**此前被 macOS 兜底「掩盖」的真实 Windows 功能偏差**：`PermissionSettings` 的「打开系统设置」按钮在 Windows 上点了没反应。功能只增不减。

## 🔴 修复（真实 Windows 偏差，此前被 macOS 兜底掩盖）

**根因（源码级坐实）**：`src/features/settings/PermissionSettings.tsx` 的 `openSettings()` 调
`invoke('open_permission_settings', { category })`，但 Rust 命令签名为
`open_permission_settings(app: AppHandle, kind: String)`（见 `src-tauri/src/commands/permission.rs:173`）。
Tauri 2 按参数名严格匹配 → 前端传 `category`、后端收 `kind` 永远拿不到 → 命令**两端一致报错**。

- **macOS**：`.catch` 兜底执行 `open_external('x-apple.systempreferences:...')` → 苹果专属 URL 在 mac 生效 → 按钮「看似正常」，掩盖了根本 bug。
- **Windows**：同一 `.catch` 兜底仍跳 `x-apple.systempreferences:...` → Windows 无此协议 → 静默失败 → **「打开系统设置」按钮在 Windows 上点了毫无反应**。

这是典型的「macOS 开发机正常、Windows 真机/CI 产物偏离」类回归，正是本专项要消灭的。

**修复（纯增量、零回归、不阉割）**：
1. 主调用改为 `invoke('open_permission_settings', { kind: category })` —— 参数名与 Rust 签名对齐，两端都走正确的平台分支（`permission.rs`：mac → `x-apple.systempreferences:...?Privacy_ScreenCapture` 等；win → `ms-settings:privacy` / `ms-settings:privacy-microphone`）。
2. 兜底改为按 `navigator.userAgent` 判定平台：Windows → `ms-settings:privacy`，macOS → 苹果 URL，彻底杜绝「Windows 落到 macOS 专属协议」的二次无声失效。

**功能只增不减**：
- Windows：按钮从「零作用」变为「真正打开系统设置」（屏幕录制→隐私首页、麦克风→隐私-麦克风），属**增强**。
- macOS：此前依赖兜底才工作，现走正确 deeplink，行为完全等价且更稳健，无回归。
- 其余 23 项功能矩阵（见 R22）不受影响。

## 全仓库 invoke 参数名校验（复盘动作）

扫描全部前端 `invoke(...)` 调用，逐一比对 Rust `#[tauri::command]` 参数名：
- `reveal_in_folder{path}` ✓｜`save_binary_file{bytes,filePath}` ✓｜`save_text_file{content,filePath}` ✓
- `open_external{target}` ✓｜`save_screenshot{imageData,filePath}` ✓｜`set_screenshot_ocr{id,ocrText}` ✓
- `open_permission_settings`：**唯一**误用 `category`（应为 `kind`）→ 本轮修复。

> 注：`tests/lint-capabilities.mjs` 现有 Phase 2 只校验「命令是否注册」，不校验「参数名是否对齐」。本轮手动全量比对补齐该盲区（参数名错位与漏注册同属「前端调用↔后端契约」失配，都会导致功能静默失效）。建议后续把参数名校验也纳入该门禁（已在 R22 Phase 2 基础上记录为待办）。

## 验证（全绿）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm exec tsc --noEmit` | exit 0 |
| 能力+命令门禁 | `node tests/lint-capabilities.mjs` | exit 0（39 命令全命中、label 全集被 capability 覆盖）|
| CI 配置 | YAML 解析 `build.yml` | OK |
| Tauri 配置 | JSON 解析 `tauri.conf.json` / `default.json` | OK |
| Rust 编译 | `cargo check --locked`(macOS) | 通过（本次为前端改动，Rust 未变，缓存命中）|

Windows 全量 `cargo build`（含 R26 的 `#[cfg(not macos)]` 主屏选取改动 + 本轮回溯确认）由 CI `build.yml` 的 `cargo-check-win` / `build`(msvc, windows-latest, RC.EXE 在位) 连续保证；本地 macOS 缺 RC.EXE 编译资源步（已知环境限制，非本次引入）。

## 功能矩阵结论（R18–R27 累计）

24 项核心功能（全屏/区域/窗口/滚动截屏、多屏、TCC 权限、OCR、剪贴板取字/复制、保存、历史、钉图、编辑器定位、AI 窗拖动、opener、快捷键、托盘、主题 i18n、6 格式导出、ACL、命令注册、临时路径、HiDPI 覆盖层、导出路径分隔符、打包门禁、WebView2 自包含、macOS Intel 覆盖、权限设置按钮）两端对等，无一项阉割；差异均为平台能力本质不同（TCC / 系统 OCR 引擎 / 设置面板协议）非功能缺失。

## 未改（沿用纪律，避免未验证的 Windows 运行时改动）

- 多屏主屏非原点 `from_point(0,0)`（R20/R26 已知边界，未盲目改）。
- `markdownDocx.ts` 的 `IS_MAC` 字体选择（mac→PingFang SC / win→Microsoft YaHei，本就两端正确）。
- Windows OCR 语言包缺失时的 `NO_OCR_ENGINE` 降级文案（属平台能力差异，非代码缺陷）。

## 仍须 Windows 真机巡检（headless CI 不可验，诚实标注）

- G1/G3 真实像素截屏（xcap 真机）。
- G4 SmartScreen 拦截（未签名 MSI 首次运行）。
- G8 OCR 语言包（需用户安装可选功能）。
- G10 WebView2（独立 exe/portable 仍要求系统预装，格式本质；MSI/NSIS 已 offlineInstaller 内嵌）。
- 多屏混合 DPR 主屏非原点坐标（R20 单 dpr 近似为已知近似非偏差）。
- R27 新增：Windows「打开系统设置」按钮现可点击，建议在真机确认 `ms-settings:privacy` 正确弹出。

## 交付物

- `PLATFORM_PARITY_FIX-2026-07-19-r27.md`（本报告）
- 改 `src/features/settings/PermissionSettings.tsx`（未提交，随用户工作流审阅）
