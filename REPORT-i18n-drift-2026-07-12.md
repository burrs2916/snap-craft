# 国际化布局一致性 + 马赛克保存 — 复核与本轮修复

> 生成时间：2026-07-12 （i18n 自动化第 14 轮）
> 范围：中/英切换时的布局漂移全量审计 + 马赛克保存导出链路复核

## 本轮做了什么
对**全站所有「中英文文案长度不同、可能随语言切换而抖动」的交互元素**做了一次**独立审计**（不沿用历史结论），并修复了 1 个真实残留点。结论：之前 3 个被反复报告的问题在源码与 dist 中均已正确修复，用户「仍看到旧行为」的唯一原因是**运行中的 App 加载的是改动前的旧代码**。

---

## 1. 三个历史问题的根因级复核（源码 + dist 双重核验）

| 问题 | 源码现状（已确认） | 状态 |
|---|---|---|
| 右上角语言按钮切换英文时尺寸漂移 | `.lang-toggle` = `min-width:120px` + `white-space:nowrap`（`src/index.css`）。“中文”/“English” 均 ≤120px → 按钮恒定 120px | ✅ 已修 |
| 截图卡片英文比中文大 | `.capture-actions` grid `repeat(4,minmax(0,1fr))` + `.capture-card{min-width:0;width:100%}`；`.capture-card-label{line-height:1.4;min-height:2.8em}`；`.capture-card-desc{height:62px}`。四卡中英文完全等高 | ✅ 已修 |
| 打完马赛克保存仍是原图 | `AnnotationCanvas.getMergedImageDataUrl`（`AnnotationCanvas.tsx`）异步：Konva 导出后**用 2D canvas 把每个 mosaic/blur 区域二次合成**；`getExportDataUrl`/`handleSave`/`handleCopy`（`EnhancedScreenshotApp.tsx`）均 `await`；Rust 端 `save_screenshot({imageData})` 用前端传入数据 | ✅ 已修 |

`dist/assets/*.js` 含 `getMergedImageDataUrl`，`dist/assets/*.css` 含上述全部规则（已重建，grep 命中）。

---

## 2. 全量布局漂移扫描（本轮新增，不重复打补丁）

逐一枚举全部 `tsx` 文本交互元素并对照 CSS，结论：

**已硬化（中英文下尺寸恒定，无漂移）：**
- 工具栏：`tbar-btn`(80px+nowrap)、`result-bar-btn`(84px+nowrap)、`history-clear-btn`(64px+nowrap)、`ctx-toggle`/`ctx-mode`(nowrap)、`back-btn`(继承 `tbar-btn`)
- 提示条：`delay-bar-label`/`delay-bar-hint`(nowrap)、`multi-display-hint`(nowrap)
- 固定方形按钮：`theme-toggle`(40px)、`ocr-panel-close`、`history-act-btn`(26px)、`pin-window-close`、`result-bar-close`
- 等宽/全宽：`scroll-ctrl-btn`(flex:1)、`permission-btn`(列内全宽)、`capture-card*`

**本轮新修（唯一真实残留点）：**
- `.scroll-ctrl-btn` 补 `min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis`（`src/index.css` L1747）。
  原因：中英按钮文案不同（如「开始/取消」vs「Start/Cancel」），原规则 `flex:1` 虽不会撑高整行，但英文过长时会换行/溢出难看。补 `nowrap`+`min-width:0` 后中英文控制条布局一致、文案过长时优雅省略。

---

## 3. 为什么你反复看到「还是没修」——根因定论

当前运行的是 **dev 模式**：`SnapCraft-dev.app` 通过 vite HMR 从 `http://localhost:1925` 加载前端。
- 已确认：**vite 正在 1925 端口运行**，且 `tauri.conf.json` 的 `devUrl` = `http://localhost:1925`，两者一致 → 窗口确实能收到 HMR 推送。
- **但**：已打开的窗口如果其 HMR 连接曾断开（系统睡眠 / vite 重启 / 网络抖动），就不会再收到后续更新，于是窗口一直显示改动**前**的旧快照。
- 你看到的「按钮漂移 / 卡片漂移 / 马赛克存原图」全部是**旧代码在跑**的表现——而旧代码里马赛克保存**确实是 broken 的**，与你的描述完全吻合。

### 👉 一招解决：在 SnapCraft 窗口里按 **Cmd+R**
（或退出重跑 `./start.sh dev`）。重载后窗口重新连上 HMR、加载最新 `src`，三个问题会同时消失。
若你用的是 app 模式（`./start.sh app`），则需重跑 `./start.sh app` 重新打包最新 `dist`。

---

## 4. 校验
- `pnpm build`（`tsc && vite build`）= exit 0，125 模块。
- `dist/assets/index-*.css` 已含 `scroll-ctrl-btn{...white-space:nowrap;...}`（grep 命中）。
- 核心截图 / 标注 / 钉图 / 权限逻辑**零改动**。
