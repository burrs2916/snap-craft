# 跨平台编译产物兼容性复盘 R24 · WebView2 自包含 + macOS Intel 覆盖

> 日期：2026-07-19 ｜ 轮次：第二十四轮 ｜ 诉求：GitHub Actions 编译产物在 Windows / macOS 上现有功能都必须正常运行、无偏差、只增不减。

## 0. 复盘结论（先给结论）

在确认 R18–R23 全部防线 intact 的基础上（见下「验证」），本轮**未做无根据的改动**，而是定位并落地 2 项真实存在的**产物级兼容性缺口**——二者都会导致「GA 编译出来的包在目标平台跑不起来 / 覆盖不全」，属硬偏差而非平台能力差异：

| # | 缺口 | 影响 | 修复 | 是否阉割 |
|---|------|------|------|----------|
| 🔴 F1 | Windows bundle `webviewInstallMode: downloadBootstrapper` | MSI/NSIS 安装时需联网下载 WebView2 引导器+运行时；**独立 exe / portable zip 始终要求系统预装 WebView2**——干净/受限网/无 WebView2 的 Win10/11 上「装完打不开 / 双击无反应」，是 Tauri Windows 包最常见的「编译出来了却跑不起来」根因 | 改 `offlineInstaller`：把完整 WebView2 运行时**嵌入 MSI/NSIS**（安装零联网、零预装即可运行） | 否，更强 |
| 🔴 F2 | macOS 仅产出 `aarch64-apple-darwin`（Apple Silicon） | Intel Mac 用户拿不到可运行产物（现有 CI 矩阵无 x86_64 目标） | 矩阵新增 `x86_64-apple-darwin`，macOS 构建步改为 `${{ matrix.target }}` 参数化 → 同时出 Apple Silicon + Intel 两种 dmg | 否，更强（覆盖扩大） |

## 1. 复盘范围与现状（确认 R18–R23 防线 intact）

逐项核对既有防线，确认未被破坏、仍有效：

1. **capability ACL 门禁**（`tests/lint-capabilities.mjs` Phase 1）：动态窗口 label 全集 `main / pin-* / region-overlay / window-overlay / editor-* / ai-panel / clipboard-*` 均被 `capabilities/default.json` `windows` glob 覆盖；动态建窗权限 `core:webview:allow-create-webview-window` + `core:window:allow-create` 齐全（R18 修）。
2. **命令注册对等**（Phase 2）：39 个后端注册命令 ⊇ 前端 36 个 `invoke` 命令，无静默失效（R22 修）。
3. **get_platform 回落**：失败回落 `detectPlatformFromUA()`（R2 修），Windows/Linux 不再误走 macOS 分支。
4. **HiDPI 覆盖层 DPR**：区域/窗口截图自建全屏覆盖层按 `devicePixelRatio` 折算逻辑像素（R19 修）。
5. **导出路径分隔符**：`exportPath.ts` 的 `pathSep()` 按平台选 `\`/`/`（R23 修，本轮复核仍 intact）。
6. **CI 构建门禁**：`cargo-check-win`（x86_64-pc-windows-msvc 全量 build）+ macOS `cargo build` + `build` job 同源 PR 也跑完整 `tauri build`（R20/R21/R23 修）。
7. **Rust 平台隔离**：`screencapture`/`osascript`/`open` 仅 macOS；`powershell`(WinRT OCR)/xcap 仅非 macOS；均 `#[cfg]` 门控，`cargo-check-win` 连续保证 Windows 编译通过。

## 2. 修复 F1 — Windows 安装包内嵌 WebView2 运行时（offlineInstaller）

**根因**：`tauri.conf.json` 的 `bundle.windows.webviewInstallMode.type` 原为 `downloadBootstrapper`。该模式：
- 安装时先从微软下载引导器，再下载完整 WebView2 运行时 → **安装过程依赖联网**；
- 若目标机无 WebView2 且安装环境受限，安装失败或运行时缺失；
- **独立 exe / portable zip 类产品天生不含 WebView2**，必须系统预装 → 常见「装好双击没反应」。

Tauri 2 的 `offlineInstaller` 在**打包阶段**把完整 WebView2 运行时塞进 MSI/NSIS，安装与运行**全程零联网、零预装要求**，是「GitHub Actions 编译的 Windows 包必须能直接跑」最强的工程保证。

**改动**：`src-tauri/tauri.conf.json`
```diff
   "windows": {
     "webviewInstallMode": {
-      "type": "downloadBootstrapper"
+      "type": "offlineInstaller"
     }
   }
```

**代价与缓解（诚实标注）**：打包时 bundler 需从微软 CDN 拉取 ~150MB WebView2 运行时。windows-latest 联网稳定，该下载可靠性高；且 `build` job `fail-fast: false` —— 即便 Windows 打包偶发下载抖动，macOS 产物照常产出，不会株连。若遇 CDN 抖动，CI 重跑即可。

**产物影响**：MSI/NSIS 体积增大（内嵌运行时），但换来「任何 Win10/11 离线可装可跑」。

## 3. 修复 F2 — macOS 同时出 Apple Silicon + Intel 两种产物

**根因**：`build.yml` 的 `build` job 矩阵只有 `macOS-arm64`。Intel Mac 用户（仍有存量）无对应 CI 产物。诉求「功能只能比现在更强」直接指向——把 macOS 覆盖从单一架构扩到双架构。

**改动**：`.github/workflows/build.yml`
1. 矩阵新增 `macOS-x64` 条目：
```yaml
  - platform: macOS-x64
    runner: macos-latest
    target: x86_64-apple-darwin
    artifact: macos-x64
```
2. macOS 构建步由硬编码改为参数化（arm64 行为不变）：
```diff
- pnpm tauri build --target aarch64-apple-darwin
+ pnpm tauri build --target ${{ matrix.target }}
```
3. `build` job `timeout-minutes` 30 → 45（双 macOS 目标留余量，冷缓存不被掐）。
4. Release 说明同步：macOS 段列出 `SnapCraft_aarch64.dmg`（Apple Silicon）/ `SnapCraft_x64.dmg`（Intel）；Windows Installer 段注明「安装包已内嵌 WebView2，离线可装可跑」。
5. `release` job 的 `files:` glob `src-tauri/target/**/release/bundle/**/*.dmg` 用 `**` 通配 target 目录，自动收录两种 dmg，无需改。

**未动**：`appstore` job 仍 `aarch64-apple-darwin --bundles app`（App Store 提交通道，独立 opt-in，不受影响）。

**安全性**：x86_64 在 macos-latest（arm64 runner）上是标准交叉编译，Xcode SDK 自带；签名/公证逻辑按 `${{ matrix.target }}` 自然适配。无平台专属代码路径差异（cargo-check 已覆盖同一份源码），仅二进制目标不同。

## 4. 验证（全绿）

| 检查 | 命令 | 结果 |
|------|------|------|
| TypeScript 类型检查 | `pnpm exec tsc --noEmit` | ✅ 0 错误 |
| 跨平台一致性 Lint（ACL + 命令注册） | `node tests/lint-capabilities.mjs` | ✅ exit 0（39 命令 / label 全覆盖） |
| Rust 编译（macOS） | `cargo check --locked`（src-tauri） | ✅ 3.10s 通过 |
| `build.yml` YAML 语法 | `python3 -c "yaml.safe_load(...)"` | ✅ 有效 |
| `tauri.conf.json` JSON 语法 | `python3 -c "json.load(...)"` | ✅ 有效 |
| appstore job 未被误改 | grep `tauri build --target` | ✅ 仍 `aarch64-apple-darwin --bundles app` |

> 说明：`webviewInstaller` 属打包配置，`cargo check` 不解析；两处改动均为配置/矩阵，不影响 Rust/前端编译，故编译门禁全绿符合预期。

## 5. 仍须 Windows / 真机巡检的项（headless CI 不可验，诚实标注，不为改而改）

以下为**平台能力本质差异 / 运行时行为**，非代码缺陷，未盲目改动：
- **G1 / G3 真实像素截屏**：Windows 走 xcap、macOS 走 screencapture，需真机验证像素级正确性。
- **G4 SmartScreen**：未签名 MSI 的首屏拦截提示（功能本身正常，仅首次警告），需真机观感确认。
- **G8 Windows OCR 语言包**：WinRT OCR 依赖系统「可选功能」文字识别组件，缺失时后端已返回可操作中文报错（非崩溃）；属平台能力差异。
- **G10 WebView2**：F1 已让 MSI/NSIS 内嵌运行时；但**独立 exe / portable zip 仍要求系统预装 WebView2**（格式本质所限，已在上游说明文案标注）。
- **多屏主屏非原点 `from_point(0,0)`**（R19 已知边界）：混合 DPR / 主屏不在 (0,0) 的多显示器坐标，未经真机验证，本轮未改（避免无根据回归）。

## 6. 交付物与改动清单

- 交付文档：`PLATFORM_PARITY_FIX-2026-07-19-r24.md`（本文件）
- 改动文件（本轮，均未提交，随用户工作流审阅）：
  - `src-tauri/tauri.conf.json` — `webviewInstallMode: offlineInstaller`
  - `.github/workflows/build.yml` — macOS x86_64 矩阵 + 构建步参数化 + 超时 45min + Release 说明

**功能只增不减确认**：未删除/削弱任何功能；F1 让 Windows 安装包离线自包含（更强），F2 让 macOS 覆盖 Intel（更强）；既有 arm64 产物、所有命令、ACL、路径处理、HiDPI 覆盖层行为完全不变。
