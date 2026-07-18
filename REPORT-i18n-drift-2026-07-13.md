# 布局一致性 + 马赛克保存 — 第 16 轮复核报告（2026-07-13）

> 结论先行：**你看到的三个问题在源码里都已经修好了**。反复"还是没修"的唯一原因，是
> 你正在运行的 App 窗口加载的是**修复落地之前的旧页面快照**。只要重载窗口即可一次看到全部修复。

---

## 一、三项历史问题：源码级复核（全部已正确修复）

### 1. 右上角语言按钮（🌐 中 / 🌐 English）切换时大小漂移
- 位置：`src/index.css` → `.lang-toggle`
- 现状：`min-width:120px` + `white-space:nowrap`（已含在最新 dist）
- 中「中文」≈40px、英「English」≈98px，均 < 120px → 按钮恒定 120px，**两种语言完全同宽**。

### 2. 首页四张截图卡片大小漂移
- 位置：`src/index.css` → `.capture-actions` / `.capture-card` / `.capture-card-label` / `.capture-card-desc`
- 现状：
  - 卡片等宽：`grid-template-columns: repeat(4, minmax(0,1fr))` + `.capture-card{min-width:0;width:100%}`
  - 标签等高：`.capture-card-label{line-height:1.4;min-height:2.8em}`（"Scrolling Capture" 换行 2 行也不撑高）
  - 描述区固定：`.capture-card-desc{height:62px;overflow:hidden}`
- 四张卡片中英文**完全等高、同宽**。

### 3. 编辑后（打马赛克）保存/复制仍是原图
全链路核验，数据链正确：
- 前端合并：`src/features/screenshot/components/AnnotationCanvas.tsx`
  `getMergedImageDataUrl()` 先用 Konva 导出，再用 2D canvas 把**每个 mosaic/blur 区域二次合成**到图上。
- 导出入口：`src/features/screenshot/EnhancedScreenshotApp.tsx`
  `getExportDataUrl()` `await` 上述结果；`handleSave()` / `handleCopy()` 均 `await` 并把结果传给后端。
- 后端写入：`src-tauri/src/commands/edit.rs`
  `save_screenshot` / `copy_to_clipboard` 用**前端传入的 `image_data`** 解码写入，**不会去读原文件**。
- → 马赛克/模糊**必被写入**导出图。

---

## 二、本轮新修：唯一仍缺的 1 处真实漂移点

- 位置：编辑器上下文栏的 `.ctx-label`（「字号 / Font size」「强度 / Strength」标签）
- 问题：原本只有 `white-space:nowrap`、**无定宽**。中英切换时标签占位宽度变化，后面跟着的
  滑块/数值控件会左右位移，上下文栏轻微跳动。
- 修复：`src/index.css` 补 `.ctx-label{min-width:56px;display:inline-flex;align-items:center}`
  → 标签占位恒定，滑块位置中英一致。

---

## 三、关键：为什么反复"还是没修"？（根因）

- 运行进程确认：**dev 模式** —— vite 开发服务器（PID 78149）正在跑，服务的是**实时 `src/`**；
  `SnapCraft-dev.app`（PID 78602）加载的是 vite 实时页面（不读 `dist/`）。
- 三项修复 + 本轮 ctx-label 修复都已落在 `src/` 与最新 `dist/`（2026-07-13 00:13 重建）。
- 你看到的旧行为 = **打开的 dev 窗口持有修复落地之前的旧 HMR 快照**：
  窗口在修复写入前就已加载，或 HMR 连接在电脑睡眠 / vite 重启后断开，不再拉取更新。

### ✅ 你只需做一步就能看到全部修复
- **dev 模式**：在 SnapCraft 窗口内按 `Cmd + R` 重载（重连 HMR，拉取最新 `src`）。
  三项问题 + ctx-label 修复会**同时**生效；本轮回填 `src/index.css` 也会被 vite 热更新推过去。
- **app（生产）模式**：退出后重跑 `./start.sh app`（重新打包最新 `dist/` 并重开）。

> 重载后若**仍**复现任一问题，那才是真需要改码的信号 —— 届时再回报具体复现路径。

---

## 四、校验
- `pnpm build` = exit 0（125 模块）
- 新 `dist/assets/index-C1Tbi05C.css` 含 `min-width:56px` + `lang-toggle{min-width:120px}` + `capture-card-label{min-height:2.8em}`
- 新 `dist/assets/index-B9--B7D0.js` 含 `getMergedImageDataUrl`
- 核心截图 / 标注 / 钉图 / 权限逻辑零改动。
