# 跨平台编译产物兼容性复盘 R25 · 导出文件名跨平台显示修复

> 自动化任务：`OCR功能增强` / automation-1783945899859
> 日期：2026-07-19
> 诉求：GitHub Actions 编译产物在 Windows / macOS 上现有功能都必须正常、无偏差、只增不减。

## 执行摘要

在确认 R18–R24 全部防线 intact（`tsc` / `lint-capabilities` / `cargo check` 全绿，`build.yml` 与 `tauri.conf.json` 配置有效）的基础上，做整轮前端跨平台复盘，定位并修复**一类真实的 Windows 显示偏差**：导出成功提示与导出历史列表在 Windows 上把整条文件路径（`C:\Users\X\Documents\SnapCraft-ai-123.docx`）当成文件名显示，而 macOS 只显示文件名。功能只增不减、零新依赖、零新增权限、零 Rust 改动。

## 复盘确认（R18–R24 防线完好）

- `build.yml`：6 job 齐全；`cargo-check-win`/`cargo-check` 均全量 `cargo build`；`build` job 同源 PR 也跑 `tauri build`；macOS arm64+x64 双 dmg。✅
- `tauri.conf.json`：`bundle.windows.webviewInstallMode.type = offlineInstaller`（内嵌 WebView2，零联网运行）；icons 含 `icon.icns`+`icon.ico`。✅
- `capabilities/default.json`：`windows` 数组含 `clipboard-*`/`region-overlay`/`window-overlay`/`editor-*`/`ai-panel`/`pin-*`，ACL 齐全。✅
- `lib.rs`：39 个 `#[tauri::command]` 全部注册；`tests/lint-capabilities.mjs` 复检通过（前端 36+ invoke 命令全部命中后端注册集）。✅
- 后端 Windows 分支（xcap 截屏 / WinRT OCR / arboard 剪贴板 / permission stub）均安全降级，无崩溃路径。✅

## 🔴 修复 1（真实 Windows 偏差）：导出文件名提取未跨平台

**根因**：R23 让 `buildDefaultPath()` 在 Windows 上用反斜杠 `\` 拼路径（修复"默认目录被忽略"偏差）。但 `AIPanel.tsx` 多处用
`path.split('/').pop() ?? path` 提取文件名——该写法只在路径含 `/` 时正确。Windows 路径用 `\`，`split('/')` 得到单元素数组，`.pop()` 原样返回**整条路径**，于是：

- "导出成功"提示：`ai.exportOk` 在 Windows 显示成 `C:\Users\X\Documents\SnapCraft-ai-123.docx` 整串；
- 文件名预览 `exportNamePreview` 同理显示整串；
- 导出历史列表（2 处渲染）显示整串路径而非 `SnapCraft-ai-123.docx`。

macOS/Linux 因用 `/` 一直正常 → **两端行为不一致**，属"Windows 上显示偏差"类兼容性缺陷。

**修复（纯增量、零回归、不阉割）**：

1. `src/features/ai/exportPath.ts` 新增导出函数 `baseNameOf(p)`：
   ```ts
   export function baseNameOf(p: string): string {
     if (!p) return '';
     return p.split(/[\\/]/).pop() ?? p;   // 同时切 / 与 \，两端等价
   }
   ```
   （与同文件的 `dirOf` 互为补充，天然跨平台。）

2. `src/features/ai/AIPanel.tsx`：导入 `baseNameOf`，将 **12 处** `*.split('/').pop() ?? *` 全部替换为 `baseNameOf(*)`：
   - 5 处"导出成功"提示（`exportOk`：docx / xlsx / pptx / md+txt / zip）；
   - 1 处文件名预览（`exportNamePreview`）；
   - 4 处历史项文件名（`const name = baseNameOf(path)`）；
   - 2 处导出历史列表渲染（`{baseNameOf(it.path)}`）。

**影响面**：

- macOS/Linux：`baseNameOf` 对 `/` 路径与原 `split('/').pop()` **完全等价**，行为不变；
- Windows：从"显示整条路径"变为"只显示文件名"，与 macOS 严格一致；
- 零新 crate / 零新权限 / 零 Rust 改动；前端仅新增 1 个纯函数 + 替换既有调用。功能只增不减。

## 验证（全绿）

```
pnpm exec tsc --noEmit                              → exit 0（无类型错误）
node tests/lint-capabilities.mjs                    → exit 0（39 命令 + 运行时窗口 label 全覆盖）
.github/workflows/build.yml (YAML)                  → 解析有效
src-tauri/tauri.conf.json (JSON)                    → 解析有效
src-tauri/capabilities/default.json (JSON)          → 解析有效
```

负向自检：`grep` 全仓库 `split('/').pop()` 仅剩 `exportPath.ts` 的 R25 注释，运行代码路径已无残留。

## 功能矩阵结论（延续 R22）

24 项核心功能（全屏/区域/窗口/滚动截屏、多屏、TCC 权限、OCR、剪贴板取字/复制、保存、历史、钉图、编辑器定位、AI 窗拖动、opener、快捷键、托盘、主题 i18n、6 格式导出、ACL、命令注册、临时路径、HiDPI 覆盖层、导出文件名显示）两端对等，无一项阉割；差异均为平台能力本质不同（TCC / 系统 OCR 引擎 / WebView2 引导方式）非功能缺失。

## 未改（沿用纪律，避免为改而改 / 未验证不盲改）

- 多屏主屏非原点 `from_point(0,0)`（R20 已知边界，缺 Windows 真机验证未盲改）；
- Windows OCR 语言包依赖系统组件（G8，平台能力非代码缺陷）；
- `powershell` WinRT OCR 的 `AsTask` 反射在当前 Windows 10/11 可用，失败有 `NO_OCR_ENGINE` 降级提示。

## 仍须 Windows 真机巡检（headless CI 不可验，诚实标注，延续）

- G1 / G3：真实像素截屏（xcap 物理像素 vs macOS 逻辑像素）；
- G4：SmartScreen 拦截（仅影响未签名构建的首次运行提示）；
- G8：OCR 语言包是否安装（影响 Windows OCR 可用性，非崩溃）；
- G10：WebView2 Runtime 自包含运行（offlineInstaller 已内嵌，真机确认零联网）；
- 多屏混合 DPR 主屏非原点坐标。

## 交付物

- `PLATFORM_PARITY_FIX-2026-07-19-r25.md`（本报告）
- 改动文件（均未提交，随用户工作流审阅）：
  - `src/features/ai/exportPath.ts`（新增 `baseNameOf`）
  - `src/features/ai/AIPanel.tsx`（12 处替换为 `baseNameOf`）
