# 平台编译产物兼容性复盘 R28（GitHub Release 产物门禁补齐）

> 日期：2026-07-19 · 轮次：R28（跨平台编译产物兼容性复盘系列第 28 轮）
> 目标：GitHub Actions 编译产物在 Windows / macOS 现有功能全部正常运行、无偏差；功能只增不减。

## 1. 本轮复盘范围与方法

在确认 R18–R27 全部防线 intact 的前提下，做整轮「产物级 + 发布级」复盘：

- 重新通读 `.github/workflows/build.yml`、`src-tauri/tauri.conf.json`、`capabilities/default.json`；
- 重新审查 Windows 专属代码路径：`capture.rs`(xcap)、`ocr.rs`(WinRT/PowerShell)、`edit.rs`(arboard)、`lib.rs`(命令注册 + 托盘/快捷键平台门控)；
- 全前端扫描：硬编码 unix 路径、平台分支兜底、`get_platform`/`detectPlatformFromUA` 回落、覆盖层 DPR/原点换算；
- 跑齐全部 CI 门禁（tsc / lint-capabilities / cargo check macOS / YAML 解析）。

**结论**：R18–R27 已落地的 10 类修复（capability 门禁、get_platform 回落、cargo-check-win 全量编译、HiDPI 覆盖层 DPR、命令注册 lint、导出路径分隔符、build 打包门禁前移、WebView2 offlineInstaller、macOS x64、导出文件名跨平台显示、主屏 is_primary、权限设置按钮 Windows deeplink）**全部仍在位、无回归**。前端零硬编码 unix 路径，零未兜底平台分支。

## 2. 本轮定位并修复的真实缺口（R28）

### 🔴 真实产物级偏差：Release 漏发 Windows 独立 exe 与便携 zip

**现象**：`build` job 在 Windows 上确实产出了两类真实产物并上传为 artifact：
- 独立 exe：`src-tauri/target/<target>/release/snap-craft.exe`（artifact `windows-standalone-exe`）；
- 免安装便携 zip：`src-tauri/target/windows-portable.zip`（artifact `windows-portable`）。

但 `release` job 的 `files:` glob 仅匹配 `src-tauri/target/**/release/bundle/**/*`——
独立 exe 位于 `release/` 根（不在 `bundle/` 下），便携 zip 位于 `release/windows-portable.zip`，
**两者都不命中任何 glob**。结果是：Tag Release 的附件里从来没有独立 exe 与便携 zip，
而 Release 说明却明确写了「Download `SnapCraft_*.exe` (standalone)」「免安装便携包」→
**用户照说明找不到下载物**，与「GitHub Actions 编译产物在 Windows 能正常交付使用」诉求直接冲突。

**根因**：`files:` glob 口径遗漏了「非 bundle/ 目录」的产物路径，属发布级一致性缺口（两端
release 产物与说明不一致）。

**修复（纯增量、零新增权限/零新增依赖、不阉割任何功能）**：
1. `release` job `files:` 补齐两条 glob：
   - `src-tauri/target/**/release/snap-craft.exe`（独立 exe）
   - `src-tauri/target/**/windows-portable.zip`（便携 zip）
2. Release 说明措辞校正：独立 exe 真实文件名是 `snap-craft.exe`（Tauri/Cargo 产物名），
   原 `SnapCraft_*.exe` 不准确，改为 `snap-craft.exe`，与实际上传文件名一致。

**影响面**：仅扩宽 Release 附件集合（dmg/msi/nsis/app.zip/msix 照旧）；`fail_on_unmatched_files:false`
保证 Windows 某步未产该件时也不报错。Windows 独立 exe / 便携 zip 现在与 macOS dmg 一同随 Tag Release 发布。

## 3. 验证（全绿）

| 项 | 命令 | 结果 |
|---|---|---|
| YAML 解析 | `python yaml.safe_load` | ✅ 6 job 齐全，新 glob 已纳入，body 含 `snap-craft.exe` |
| 前端类型 | `pnpm exec tsc --noEmit` | ✅ exit 0 |
| 跨平台一致性 | `node tests/lint-capabilities.mjs` | ✅ 39 命令 + label 全覆盖，无静默失效功能 |
| Rust 编译 | `cargo check --locked`(macOS) | ✅ 0 |
| 资源/图标 | `icons/icon.ico`、`icon.icns`、`.lproj` | ✅ 均存在，Windows 打包资源齐备 |

## 4. 功能只增不减确认

- 修复仅扩宽 Release 附件与校正说明，**未删除/削弱任何功能**，未触碰运行时代码；
- 既有 24 项跨平台功能矩阵（全屏/区域/窗口/滚动截屏、多屏、TCC 权限、OCR、剪贴板取字/复制、
  保存、历史、钉图、编辑器定位、AI 窗拖动、opener、快捷键、托盘、主题 i18n、6 格式导出、ACL、
  命令注册、临时路径、HiDPI 覆盖层、主屏选取、权限设置按钮、WebView2 自包含、macOS x64）两端对等无阉割。

## 5. 仍须 Windows 真机巡检（headless CI 不可验，诚实标注）

以下属平台能力本质差异 / 真机视觉验证，CI 无法替代，延续前轮标注：
- G1/G3 真实像素截屏（xcap 在真机 HiDPI 多屏的坐标精度）；
- G4 SmartScreen 拦截（安装器/独立 exe 的信誉告警，代码无法消除）；
- G8 OCR 语言包（Windows 需系统装 OCR 语言包，属平台能力非代码缺陷；已 `NO_OCR_ENGINE` 降级提示）；
- G10 WebView2（离线 installer 已内嵌，独立 exe/portable 仍要求系统预装，格式本质）；
- 混合 DPR 多屏主屏非原点坐标（R20 覆盖层按单屏 dpr 折算，已知近似非偏差）。

## 6. 交付物

- 修改：`.github/workflows/build.yml`（`release` job `files:` + 说明措辞）
- 报告：`PLATFORM_PARITY_FIX-2026-07-19-r28.md`
- 均未提交，随用户工作流审阅。
