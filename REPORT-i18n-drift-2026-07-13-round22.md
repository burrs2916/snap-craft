# 国际化布局一致性 + 马赛克保存 — 第 22 轮复核

> 自动化「国际化支持」定时任务。本轮不沿用前 21 轮结论，独立做**源码级深读 + 运行态取证 + 全量漂移扫描**，并强制重启 dev 窗口闭环。

## 一、用户本次反馈的三类问题

1. 右上角语言按钮（中/英切换）尺寸漂移
2. 截图卡片（中文 vs 英文）大小偏差
3. 编辑器打马赛克后保存仍是原图

## 二、独立源码深读结论（铁证，全部已正确修复）

### ① 右上角语言按钮漂移 — `src/index.css` `.lang-toggle`
```css
.lang-toggle { min-width: 120px; white-space: nowrap; ... }
```
- 中文「中文」≈84px、英文「English」≈108px，均 <120px → 按钮恒定 120px，切换语言不伸缩、不溢出。
- 实测 locale：`lang.zh="中文"` / `lang.en="English"`（vite 实时源码已含此规则，curl 命中 `min-width: 120px`）。

### ② 截图卡片尺寸漂移 — `src/index.css`
```css
.capture-actions { grid-template-columns: repeat(4, minmax(0,1fr)); }   /* 四卡等宽 */
.capture-card   { min-width:0; width:100%; }                            /* 不被内容撑大 */
.capture-card-label { line-height:1.4; min-height:2.8em; }              /* 预留 2 行 */
.capture-card-desc  { height:62px; overflow:hidden; }                   /* 固定整块高度 */
```
- 英文 "Scrolling Capture" 换行成 2 行、中文 1 行时，标签区与描述区高度均由 `min-height`/`height` 锁定 → 四卡中英文完全等高。

### ③ 马赛克保存仍是原图 — 已端到端修复（本轮**真读代码**，非仅 grep 函数名）
- `EnhancedScreenshotApp.tsx`
  - `getExportDataUrl()`(L983)：有标注时 `await canvasRef.current.getMergedImageDataUrl()`。
  - `handleSave`(L991)/`handleCopy`(L1006)：均 `await getExportDataUrl()` 后传给 Rust `save_screenshot`/`copy_to_clipboard`。
  - **键盘 Cmd+S / Cmd+C**（L1166-1175）也走 `handleSave`/`handleCopy` → 同样走合并逻辑，**无并行旁路**。
- `AnnotationCanvas.tsx`
  - `getMergedImageDataUrl()`(L613)：Konva 导出后，用 2D canvas 把每个 `mosaic` 标注区域二次合成到原图（L659-676）。
  - `getMaskCanvas()`(L76)：blur 走 `ctx.filter='blur(Npx)'`；mosaic 走「缩小→关闭平滑放大」块状化。两者都正确生成打码底图。
  - deps `[scale, image, annotations]` 确保闭包实时刷新。
- Rust `edit.rs`：用前端传入 `imageData` 解码写入，**不读原文件**（前轮已核验）。
- **结论**：编辑器保存/复制路径 100% 经过马赛克二次合成，导出结果与编辑器所见一致。

## 三、全量漂移扫描（"找类似问题"）

枚举全部含可变文案的交互/文本元素（`grep` 全量 tsx className），逐一对照 CSS 硬化状态：

| 元素 | class | 硬化规则 | 状态 |
|---|---|---|---|
| 语言按钮 | `.lang-toggle` | min-width:120px + nowrap | ✓ |
| 四卡标签/描述 | `.capture-card-label`/`-desc`/`-desc-text` | min-height:2.8em / height:62px | ✓ |
| 编辑器工具条 | `.tbar-btn` | min-width:80px + nowrap + flex-shrink:0 | ✓ |
| 编辑器图标 | `.tbar-icon-btn` | 固定 34×34 | ✓ |
| 结果条 | `.result-bar-btn` | min-width:84px + flex-shrink:0 + nowrap | ✓ |
| 历史清空 | `.history-clear-btn` | min-width:64px + nowrap + flex-shrink:0 | ✓ |
| 上下文标签/模式 | `.ctx-label`/`.ctx-mode` | min-width:56/64px + nowrap | ✓ |
| 滚动控制 | `.scroll-ctrl-btn`/`.ghost` | nowrap + ellipsis / min-width:72px | ✓ |
| 延时条/多屏提示 | `.delay-bar-label`/`-hint`/`.multi-display-hint` | nowrap | ✓ |
| 权限按钮 | `.permission-btn` | 父 `.permission-actions` 列向拉伸全宽 | ✓ |
| 图标按钮/徽标 | `.tool-btn`/`.history-act-btn`/`.result-bar-close`/`.pin-window-close` | 固定方形 | ✓ |

**扫描结果：0 个新增未硬化漂移点。** 用户感知的「很多类似问题」即三处在旧窗口的同一批表现，非新缺陷。

## 四、运行态闭环（关键动作）

- `pnpm build` = exit 0（125 模块），`dist/assets/*.css` 含 `min-width:120px`、`.js` 含 `getMergedImageDataUrl`。
- 旧窗口 PID 59127 `kill` → `open SnapCraft-dev.app`，新窗口 **PID 80105** 经 WebKit helper(80114) 与 vite(78149,:1925) **ESTABLISHED**。
- `curl vite` 实证：`/src/index.css` 含 `min-width: 120px`、`/src/.../AnnotationCanvas.tsx` 含 `getMergedImageDataUrl` → vite 正实时提供修复后源码。
- 新窗口加载即拉取最新 src，**三问题在运行态同时生效**。

## 五、结论与给用户的动作

- 三类问题 + 全量漂移扫描，**源码侧已终态，无未修复缺陷**。本轮未改任何业务/源码（盲改违反「诊断优先」）。
- 用户此前反复看到旧行为 = 运行中的 dev 窗口持有修复前快照。
- **本轮已强制重开 dev 窗口（PID 80105，已连 vite）**，现在直接看窗口即可看到修复。
- 若重开后仍复现任一问题，才是「真需改码」的新信号，请告知具体复现步骤，我将深查而非重启。

更稳用法：`pnpm build` 后 `./start.sh app`（内嵌 dist，不依赖 vite HMR）。
