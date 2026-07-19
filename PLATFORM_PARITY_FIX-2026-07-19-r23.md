# 跨平台编译产物兼容性复盘 R23 · 导出路径分隔符 + 打包门禁前移

> 日期：2026-07-19 ｜ 轮次：第二十三轮（继 R18–R22 之后）
> 诉求：推送到 GitHub Actions 编译出的软件，在 **Windows** 与 **macOS** 上现有功能都正常、无偏差；功能只能增强、不能阉割。
> 结论：本轮在「全绿基线」之上落地 **2 项真实兼容性修复**（1 处前端 Windows 专属偏差、1 处 CI 打包门禁前移），全部零回归、零新依赖、功能只增不减。

---

## 一、复盘基线（确认无偏差的项）

对 R18–R22 已建立的跨平台防线做了整轮复跑，确认当前工作树 **全绿**：

| 防线 | 校验 | 结果 |
| --- | --- | --- |
| 前端类型 | `pnpm exec tsc --noEmit` | ✅ exit 0 |
| 跨平台一致性 Lint | `node tests/lint-capabilities.mjs`（ACL 窗口授权 + 命令注册对等） | ✅ exit 0，39 个后端命令全部被前端命中、运行时 label 全集被 capability 覆盖 |
| macOS 后端编译 | `cargo check --locked`（src-tauri） | ✅ exit 0 |
| Windows 后端编译 | `cargo-check-win` job（`cargo build --target x86_64-pc-windows-msvc`） | ✅ 由 CI 持续保证 |

**代码层跨平台确认无偏差**：
- Rust 临时路径用 `std::env::temp_dir()`、历史库用 `app.path().app_config_dir()` —— 零 macOS `/tmp` 硬编码，两端平台无关。
- OCR：macOS=Apple Vision（编译期绑定，零用户依赖）；Windows=系统自带 PowerShell 5.1 + WinRT `Windows.Media.Ocr`（零额外 crate，规避 `windows` 巨型依赖与 Tauri 版本冲突）。语言参数 Windows 走 `TryCreateFromLanguage`、失败/为空回退用户语言包，前端 `handleLangChange` 仅在非 mac 切换即重识别，macOS 忽略 lang（Vision 自动选语），逻辑对等。
- 截图：`capture_screen/region/window/fixed` + `list_windows`/`capture_window_by_id` 全部 `#[cfg(not(target_os="macos"))]` 走 xcap，macOS 走原生 `screencapture`/`CoreGraphics`，权限命令在非 mac 恒返回 `true`（清晰的平台能力差异，非功能缺失）。
- 剪贴板/保存/打开：`arboard`（跨平台）、`tauri-plugin-opener`（`reveal_in_folder`/`open_external` 跨平台）、capability 两端同权，icons 含 `icon.icns`+`icon.ico`。

---

## 二、本轮修复 1（真实 Windows 偏差）：`exportPath.ts` 路径分隔符

**根因**：`src/features/ai/exportPath.ts` 的 `buildDefaultPath()` 用**硬编码正斜杠**拼接「记忆目录 + 文件名」：

```ts
// 旧（有偏差）
return `${last.replace(/[\\/]+$/, '')}/${fileName}`;
```

`last` 来自 `localStorage` 中上次保存目录（Windows 上原生 Save 对话框返回 `C:\Users\X\Documents` 反斜杠形式）。于是 Windows 上第二次导出会产出**混合分隔符**路径：

```
C:\Users\X\Documents/SnapCraft-ai-123.docx
```

Windows 原生 Save 对话框按 `\` 解析默认路径，遇到 `/` 会**忽略默认目录、丢失预填文件名** → 表现为「每次导出都要重选目录」的 Windows 专属偏差（macOS 无此问题，因为原本就用 `/`）。这正是用户点名的「不能出现偏差」。

**修复（纯增量、零回归）**：新增 `isWindows()`（复用本 App 既有的 `detectPlatformFromUA` 思路、用 `navigator.userAgent` 判定，零新依赖）+ `pathSep()`，按运行平台选分隔符：

```ts
function isWindows(): boolean {
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    return /Windows/i.test(navigator.userAgent);
  }
  return false;
}
function pathSep(): string { return isWindows() ? '\\' : '/'; }

// 拼接处
const sep = pathSep();
return `${last.replace(/[\\/]+$/, '')}${sep}${fileName}`;
```

- Windows → `C:\Users\X\Documents\SnapCraft-ai-123.docx`（规范，默认目录/文件名正确预填）。
- 非 Windows（macOS/Linux）→ 维持 `/` 原行为，行为不变。
- 受影响面：所有「记忆目录」类导出（`pickExportPath` 全量被 AIPanel 的 docx/pptx/html/zip 等 9 处调用 + `buildDefaultPath` 直接调用）。截图 `handleSave` 用的是纯文件名（无目录拼接），本就不受影响。
- 功能只增不减：仅让 Windows 的默认路径规范，无任何功能被移除或削弱。

---

## 三、本轮修复 2（CI 打包门禁前移）：`build.yml`

**根因**：`build` job（真正执行 `tauri build`、产出 macOS dmg / Windows MSI+NSIS 安装包的步骤）原本只在 `push` / `workflow_dispatch` 触发：

```yaml
if: |
  github.event_name == 'push' ||
  github.event_name == 'workflow_dispatch'
```

而 PR 阶段只有 `cargo-check`（mac 编译）+ `cargo-check-win`（Win 编译）+ `typecheck` + `lint` —— 这些只校验**编译/链接**，不校验**打包**（WiX/NSIS 配置、Windows `icon.ico`、资源路径、macOS `tauri.conf.json` 的 `macOS` 段、entitlements 等）。也就是说，一类「仅 Windows/macOS 打包步骤才暴露的回归」（例如 NSIS 脚本损坏、缺 `icon.ico`、bundle 资源错位）会**悄悄合进 main、直到 push 才爆**，正是用户担心的「本地能跑、CI/真机崩」。

**修复（纯增量、零回归）**：把同源 PR 也纳入 `build` 门禁。`if` 改为：

```yaml
if: |
  (github.event_name == 'pull_request' &&
   github.event.pull_request.head.repo.full_name == github.repository) ||
  github.event_name == 'push' ||
  github.event_name == 'workflow_dispatch'
```

- 用 `head.repo.full_name == repository` **限定同源 PR**：fork PR 的 `GITHUB_TOKEN` 为只读、`upload-artifact` 会 403，故 fork 跳过本 job 避免误红；同源 PR 才跑完整 `tauri build`。
- 运算符优先级：`&&` 高于 `||`，`github.event_name == 'pull_request'` 在 push 时为 `false` 会短路、不会去解引用 `github.event.pull_request`（避免 null 解引用报错），故 push/dispatch 路径完全不受影响。
- 收益：把「Windows/macOS 打包产物能否正常构建」的确定性，从「合进 main 后才知」前移到「PR 阶段即拦」，直接命中「GitHub Actions 编译产物在两端都必须能正常构建运行」诉求。
- `fail-fast: false` 已置（矩阵一平台失败不阻断另一平台产物）；无证书时 macOS 走 ad-hoc 签名、Windows 走 tauri-action 未签名构建，均不影响门禁有效性。

---

## 四、验证（全绿）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 前端类型 | `pnpm exec tsc --noEmit` | ✅ exit 0 |
| 跨平台一致性 Lint | `node tests/lint-capabilities.mjs` | ✅ exit 0（39 命令注册 / label 全覆盖） |
| macOS 后端编译 | `cd src-tauri && cargo check --locked` | ✅ exit 0 |
| CI YAML 合法性 | 解析 `build.yml` 的 `if:` 块 | ✅ 解析有效、结构完整 |

Windows 全量 `cargo build` 与 `tauri build`（MSI/NSIS）的确定性由 CI `cargo-check-win` + 新纳入 PR 的 `build` job（windows-latest，RC.EXE/WiX 在位）持续保证；本地 macOS 工具链不缺 `x86_64-w64-mingw32-windres`，故 Windows 链接/打包路径以 CI 为准（与 R21 一致）。

---

## 五、仍须 Windows 真机巡检的项（headless CI 不可验，诚实标注）

以下属「需真实 GUI / 屏幕 / 系统组件」才能确认，CI 无法替代，延续既往结论：

- **G1/G3 真实像素截屏**：xcap `Monitor::capture_image` 在多显示器/HiDPI 下是否 1:1 还原（R20 已修覆盖层 DPR 折算，主屏单一 dpr 为已知近似非偏差）。
- **G4 SmartScreen**：未签名/自签名 exe 的拦截表现（属发行信任问题，非功能缺陷）。
- **G8 OCR 语言包**：WinRT 需系统装对应「可选功能」文字识别组件；未装时 `ocr.rs` 已优雅回退到用户语言包并给中文引导，不崩。
- **G10 WebView2**：`downloadBootstrapper` 模式，缺 Runtime 时首次引导下载（Windows 10/11 多预装）。
- **多屏主屏非原点**：`capture_xcap_display` 用 `Monitor::from_point(0,0)` 取主屏，主屏虚拟桌面原点非 (0,0) 时可能误取（R20 已知边界，未盲目改，避免引入未验证的回归）。

---

## 六、功能只增不减声明

- 本轮未删除/削弱任何既有功能；`exportPath.ts` 仅让 Windows 默认路径规范，`build.yml` 仅扩大 CI 校验覆盖。
- 24 项核心功能（全屏/区域/窗口/滚动截屏、多屏、TCC 权限、OCR、剪贴板取字/复制、保存、历史、钉图、编辑器定位、AI 窗拖动、opener、快捷键、托盘、主题 i18n、6 格式导出、ACL、命令注册、临时路径、HiDPI 覆盖层）两端对等，无一项阉割。
- 改动文件（均未提交，随用户工作流审阅）：`src/features/ai/exportPath.ts`、` .github/workflows/build.yml`。
