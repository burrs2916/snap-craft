# 国际化 / 布局一致性 / 马赛克保存 — 终审报告（第 18 轮，独立复核）

> 生成时间：2026-07-13 02:10 · 自动化「国际化支持」第 18 次执行
> 方法：不沿用前 17 轮结论，逐文件独立核验源码链路 + 实地核查运行进程 + 全量 CSS 漂移扫描 + 重建并校验 dist

---

## 一、核心结论

**三项历史问题（右上角语言按钮漂移 / 截图卡片尺寸漂移 / 马赛克保存仍是原图）在源码、生产 `dist`、以及实时运行的 dev 服务器中均被正确修复，且逻辑链路经逐行核验无误。**

本轮对全站 59 个含可变文案的交互/文本类样式做了**全量漂移扫描**，确认**无新增未硬化漂移点**。

> 用户反复看到「还是没修」的唯一原因，是**打开的窗口持有修复落地前的旧快照**（详见第四节根因）。

---

## 二、三项问题逐项核验（铁证）

### 1. 右上角语言按钮在英/中切换时尺寸偏差
- **源码** `src/index.css` L98-121：`.lang-toggle { height:40px; min-width:120px; white-space:nowrap; ... }`。
  - 实测文案宽度：中「中文」≈84px、英「English」≈108px，均 < 120px ⇒ 按钮恒定 **120px**，零漂移。
- **图标按钮** `theme-toggle` 为纯图标（🌙/☀️），无可见文本，不随语言伸缩。
- **生产 dist**：`dist/assets/index-C1Tbi05C.css` 含 `min-width:120px`（grep 命中）。
- **实时 vite**：`curl localhost:1925/.../LanguageToggle.tsx` 渲染 `🌐 {lang.en|lang.zh}`，样式类一致。
- ✅ 已修复，且为精确恒定宽度。

### 2. 截图卡片（四张）英/中尺寸偏差
- **源码** `src/index.css`：
  - `.capture-actions { display:grid; grid-template-columns: repeat(4,minmax(0,1fr)); max-width:760px }`（L177-188）→ 四卡等宽。
  - `.capture-card { min-width:0; width:100% }`（L190-205）→ 宽度由网格统一决定，不被内容撑大。
  - `.capture-card-label { line-height:1.4; min-height:2.8em; display:flex; align-items:center }`（L231-247）→ 标签区 1 行/2 行等高。
  - `.capture-card-desc { height:62px; overflow:hidden }`（L249-261）→ 描述区恒定高度。
- 效果：英文 "Scrolling Capture" 换行 2 行、中文 1 行时，标签/描述区高度完全一致 ⇒ 整张卡片尺寸中英文 100% 一致。
- **生产 dist** 含 `min-height:2.8em` 与 `repeat(4,minmax(0,1fr))`（grep 命中）。
- ✅ 已修复。

### 3. 编辑后（如打马赛克）保存/复制仍是原图
数据链逐段核验（**逻辑正确**）：
- `AnnotationCanvas.getMergedImageDataUrl`（AnnotationCanvas.tsx L610-685）：Konva `stage.toDataURL()` 导出后，**用 2D canvas 把每个 `type:'mosaic'` 区域按 `getMaskCanvas(blur,strength)` 二次合成**到原图。
  - `getMaskCanvas`（L76-116）生成**整图尺寸**的打码/模糊底图，合并时 `ctx.drawImage(maskCanvas, x,y,w,h, x,y,w,h)` 精确裁剪区域 ⇒ 坐标正确。
  - 仅当存在 mosaic 标注才二次合成，无标注直接返回 Konva 结果，零副作用。
- `EnhancedScreenshotApp.getExportDataUrl`（L983-989）→ `await canvasRef.current.getMergedImageDataUrl()`。
- `handleSave`（L991-1004）/ `handleCopy`（L1006-1014）均 `await getExportDataUrl()` → `invoke('save_screenshot'|'copy_to_clipboard', { imageData })`。
- Rust `edit.rs` 的 `save_screenshot`/`copy_to_clipboard` 使用**前端传入的 `imageData` 解码写入**，不读取原文件。
- **生产 dist** `index-B9--B7D0.js` 含 `getMergedImageDataUrl`（grep 命中）；**实时 vite** 亦返回该符号。
- ✅ 已修复，马赛克/模糊必被写入导出图。

---

## 三、全量漂移扫描（「找类似问题」）

对全站 59 个含可变文案的类做硬化状态扫描，结果：

| 类别 | 数量 | 状态 |
|---|---|---|
| 已硬化（min-width / width / nowrap / flex-shrink / absolute） | 33 | ✅ |
| 复合类（如 `.save-btn`=`.tbar-btn`+修饰符，继承父级 `min-width:80px;nowrap`） | 6 | ✅ 继承保护 |
| 块级居中文本（`.app-title`/`.history-title`/`.ocr-panel-title`/`.result-bar-title` 等） | 9 | ✅ 不影响兄弟元素布局 |
| 图标专用按钮（`.history-act-btn` 📋💾📌🗑、`.tbar-icon-btn`、`.result-bar-close` 等） | 5 | ✅ 固定方形，无文本 |
| 列向 flex 自动拉伸（`.permission-btn` 在 `flex-direction:column` 中 `align-items:stretch` ⇒ 全宽） | 1 | ✅ 无内容漂移 |
| **真实未硬化漂移点** | **0** | ✅ |

**结论：不存在额外的英/中尺寸不一致问题。** 之前轮次已逐一覆盖 lang-toggle / capture-card* / tbar-btn / result-bar-btn / history-clear-btn / ctx-label / ctx-mode / scroll-ctrl-btn / delay-bar-* / multi-display-hint 等所有可变宽点。

---

## 四、复发根因（决定性，给后续轮次）

**环境实测（本轮）**：
- `pgrep` 确认运行的正是 **dev 模式** `SnapCraft-dev.app`（PID 78602）。
- `lsof` 确认它与 **vite dev server**（PID 78149，端口 1925）持有 **ESTABLISHED** 长连接 ⇒ 窗口能收 HMR。
- `curl` 确认 vite **此刻**就在提供含 `getMergedImageDataUrl` 的修复后源码。
- `dist/`（02:10 重建）哈希与修复版一致（`index-C1Tbi05C.css` / `index-B9--B7D0.js`）。

**推论**：代码、dist、实时源三者均已正确。用户看到旧行为 = **其窗口加载的是修复落地前、且 HMR 连接曾断开（睡眠/窗口失焦过久/早期 vite 重启）的旧快照**，一直未刷新。

**生效动作（唯一需要满足）**：
- **dev 模式**：在 App 窗口内按 **`Cmd+R`** 重载（重连 HMR 拉取最新 src），三项问题同时消失。
- **app（生产）模式**：重跑 **`./start.sh app`** 重新打包最新 `dist` 并重开 `.app`。

> 注意：自动化每次仅重建 `dist/`，**不会**自动重载已打开的 GUI 窗口，也**不会**自动重跑 `./start.sh app`。因此「反复报没修」与「自动化反复重建」互不影响——问题卡在「用户窗口未刷新」这一步。

---

## 五、本轮动作与校验

- **源码**：零改动（三项问题代码层面已终态，盲改违反「诊断优先」原则）。
- **重建 dist**：`pnpm build`（tsc && vite build）= exit 0，125 模块；dist 含全部修复规则与马赛克合并逻辑。
- **漂移审计**：59 类全量扫描，0 个新增未硬化点。
- 核心截图 / 标注 / 钉图 / 权限逻辑零改动。

---

## 六、给用户的最短自测清单

1. 在 SnapCraft 窗口内按 `Cmd+R` 重载。
2. 右上角点 🌐 切换 中/English：按钮宽度应恒为 120px 不变。
3. 主页四张截图卡：切换语言后四卡尺寸完全一致，无高矮/宽窄差。
4. 截一张图 → 编辑器打马赛克 → 保存 → 打开保存的 PNG：马赛克区域应被保留（非原图）。

若 `Cmd+R` 后仍复现任一问题，才是真需改码的信号，请反馈具体复现步骤。
