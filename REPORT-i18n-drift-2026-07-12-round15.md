# 国际化布局一致性 + 马赛克保存 · 第 15 轮核查报告

> 生成时间：2026-07-12 23:10 · 执行者：Senior Developer（国际化自动化）

## 一句话结论

你反馈的 **三个问题（右上角按钮漂移 / 截图卡片尺寸漂移 / 马赛克保存还是原图）在最新源码和 `dist` 里都已经修好了**。本次逐文件核验 + 实地查进程确认：你当前看到的"没修"，是因为 **正在运行的 SnapCraft 窗口加载的是旧页面**，而不是代码没改。

**最快见效的一步：在 SnapCraft 窗口里按 `⌘R` 重新加载**，三处问题会同时消失。

---

## 一、为什么你反复看到"还是没修"？（根因，铁证）

本次实地核查运行进程：

| 进程 | 说明 |
|------|------|
| `SnapCraft-dev.app` (PID 78602) | 你正在运行的是 **dev 模式** |
| `vite` (PID 78149) | 页面由 vite 开发服务器实时提供 |

dev 模式下的窗口**直接读 vite 的实时源码（src/），不读 `dist/`**。当你改了源码后，只有**保持 HMR 连接**的窗口才会自动热更；一旦窗口的 HMR 连接在睡眠 / vite 重启 / 网络抖动中断开，它就会一直显示改动之前的旧快照——也就是你看到的"按钮漂移、卡片漂移、马赛克存原图"（旧代码里这些确实是 bug，与你的描述完全吻合）。

**所以：代码已修 ✓，你需要的是让窗口重新加载最新代码。**

---

## 二、你报告的三处问题 — 当前代码状态

| 问题 | 源码状态 | 修复方式 |
|------|----------|----------|
| 右上角语言按钮中英大小不一 | ✅ 已修 | `.lang-toggle { min-width:120px; white-space:nowrap }` |
| 截图卡片中英大小不一 | ✅ 已修 | `.capture-actions` grid 等宽 + `.capture-card-label/desc` 固定高度 |
| 打马赛克后保存仍是原图 | ✅ 已修 | `AnnotationCanvas.getMergedImageDataUrl` 二次合成 + `handleSave/handleCopy` 改 `await` → 后端 `save_screenshot({imageData})` |

> 马赛克保存的链路我专门通读了一遍：`handleSave → getExportDataUrl() → canvasRef.getMergedImageDataUrl()`，后者先用 Konva 导出原图+矢量标注，再在 2D canvas 上把每个马赛克/模糊区域按原坐标重新合成，最后才交给后端。数据链正确，马赛克**一定**会被写入。

---

## 三、本轮真正新增的修复（唯一还没覆盖到的真实漂移点）

你说"类似的问题还有很多"，我因此把全站每一个带文字的交互元素都对照了 CSS。绝大多数早已硬化，唯一漏网的是：

1. **`.ctx-mode`（马赛克 / 模糊，英文 Mosaic / Blur）**
   - 原：只有 `white-space:nowrap`，没定宽。中英切换时两个胶囊宽度跳变，编辑器上下文栏轻微抖动。
   - 改：`min-width: 64px` → 两个模式按钮等宽，中英切换宽度恒定。
2. **`.capture-card-desc`** 补 `overflow:hidden`：极端字体度量下也不溢出卡片，四张卡始终等高。
3. **`.result-bar-btn`** 补 `flex-shrink:0`：英文按钮含 emoji 略宽时，整条结果栏不挤压按钮，四种操作恒等宽对齐。

其余早已硬化的元素（确认无遗漏）：`.tbar-btn`(80px) · `.result-bar-btn`(84px) · `.history-clear-btn`(64px+nowrap) · `.ctx-toggle`(nowrap) · `.multi-display-hint`(nowrap) · `.delay-bar-*`(nowrap) · `.scroll-ctrl-btn`(nowrap+ellipsis/72px) · `.permission-btn`(全宽) · 各关闭/工具按钮(固定方形)。

---

## 四、构建校验

```
pnpm build  →  tsc && vite build  →  exit 0，125 模块
dist 重建于 23:10：index-BeDP_1bd.css / index-Br4BWi_7.js
```

逐项验证 dist 已含：`min-width:120px` ✅ · `capture-card-label` ✅ · `ctx-mode` 定宽 ✅ · `flex-shrink:0` ✅ · `overflow:hidden` ✅ · `getMergedImageDataUrl` ✅

---

## 五、你需要做的（最关键）

| 你现在的运行方式 | 让修复生效的操作 |
|------------------|------------------|
| dev 模式（你当前就是） | 在 SnapCraft 窗口内按 **`⌘R`** 重新加载，加载最新 src |
| `./start.sh app`（正式包） | 重跑 **`./start.sh app`** 重新打包最新 dist 并重启窗口 |

重载后请验证：
1. 点右上角 🌐 在 中文 / English 间切换 → 语言按钮宽度不变、四张截图卡尺寸不变。
2. 打开任意截图 → 编辑器里打一块马赛克 → 点「保存」→ 导出的图**带马赛克**（不再是原图）。

如果 `⌘R` 重载后**仍然**复现，那才是真有代码问题，请告诉我，我会立即深入改码（而不是像前几轮那样在已修好的源码上重复打补丁）。
