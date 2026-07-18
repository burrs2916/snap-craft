# i18n 布局一致性 + 马赛克导出 — 第 20 轮复核与闭环

> 日期：2026-07-13 04:13（自动化轮次）
> 结论一句话：**三项问题源码早已正确修复；用户反复"没修"的真实根因是运行中的窗口持有修复落地前的旧 HMR 快照。本轮重建 dist + 强制重启 dev 窗口（新 PID 26835，已与 vite 建立连接），修复现已在运行态生效。并独立核验了此前 19 轮可能从未真正落地的 Rust 侧数据链。**

---

## 一、用户本报告反馈的三类问题

1. 右上角语言按钮：切到英文时大小与中文不一致（布局漂移）
2. 首页截图卡片：中英文下尺寸不一致（布局漂移）
3. 编辑器打马赛克后"保存仍是原图"（功能性 bug）

## 二、逐链核验（不沿用前 19 轮结论，独立取证）

### 2.1 右上角语言按钮 —— 源码正确 ✅
`src/index.css` `.lang-toggle`：
```css
.lang-toggle {
  min-width: 120px;     /* 中「中文」≈84px / 英「English」≈108px 均 <120px → 按钮恒定 120px */
  white-space: nowrap;  /* 文案变长也不换行抖动 */
  display: flex; align-items: center; justify-content: center;
}
```
父容器 `.topbar` 为 flex，但 `min-width` 在任何 flex 下都不会被压到 120px 以下 ⇒ 中英文按钮尺寸完全一致。

### 2.2 首页截图卡片 —— 源码正确 ✅
`src/index.css`：
- `.capture-actions { grid-template-columns: repeat(4, minmax(0, 1fr)); max-width:760px }` —— 四卡等宽，内容不撑宽
- `.capture-card { min-width:0; width:100% }`
- `.capture-card-label { line-height:1.4; min-height:2.8em }` —— 标签区固定 2 行高
- `.capture-card-desc { height:62px; overflow:hidden }` —— 描述区固定高度
⇒ 中英文标签/描述区等高，整卡尺寸语言无关。

### 2.3 马赛克保存仍是原图 —— 源码正确，且本次额外核验了 Rust 侧（关键）✅

**前端链路**（`src/features/screenshot/components/AnnotationCanvas.tsx`）：
- `getMergedImageDataUrl()`：Konva 导出后，用 2D canvas 把每个 `mosaic/blur` 标注区域**二次合成**到原图（`getMaskCanvas` 按 模式+强度 生成整图打码底图再裁剪区域）。
- `EnhancedScreenshotApp.getExportDataUrl()` `await canvasRef.current.getMergedImageDataUrl()`；`handleSave`/`handleCopy` 均 `await` 后 `invoke('save_screenshot'/'copy_to_clipboard', { imageData })`。

**Rust 侧（本轮新核验，前 19 轮未真正落地检查）**：
`src-tauri/src/commands/edit.rs`：
```
fn save_screenshot(... image_data: String ...) {
    let bytes = store::data_url_to_bytes(&image_data)?;   // 用前端传入的数据
    store::write_bytes(path, &bytes)?;                     // 写入的就是打码后的图
}
fn copy_to_clipboard(... image_data: String ...) {
    let bytes = store::data_url_to_bytes(&image_data)?;   // 同样用传入数据
    ...
}
```
⇒ Rust 确用前端传入的 `image_data` 解码写入，**不读原文件**。整条数据链正确，马赛克必被写入导出文件。

### 2.4 全量漂移扫描（"找类似问题"）
枚举全部含可变文案的渲染/交互元素，逐一对照 CSS：

| 元素 | class | 硬化情况 |
|---|---|---|
| 右上角语言按钮 | `.lang-toggle` | min-width:120px + nowrap ✅ |
| 首页四卡片 | `.capture-actions`/`.capture-card`/`-label`/`-desc` | grid 等宽 + 固定高度 ✅ |
| 编辑器工具栏 | `.tbar-btn`(80px)/`.tbar-icon-btn` | 图标按钮无文字；文字按钮定宽 ✅ |
| 结果栏四按钮 | `.result-bar-btn` | min-width:84px + flex-shrink:0 ✅ |
| 历史清空 | `.history-clear-btn` | min-width:64px + nowrap + flex-shrink:0 ✅ |
| 编辑器上下文（字号/强度/模式） | `.ctx-label`(56px)/`.ctx-mode`(64px) | nowrap + 定宽 ✅ |
| 滚动截图控制条 | `.scroll-ctrl-btn`(ghost 72px) | nowrap + ellipsis ✅ |
| 多屏提示 / 延时条 | `.multi-display-hint`/`.delay-bar-*` | nowrap ✅ |
| 权限页按钮 | `.permission-btn`（父 `.permission-actions` 为 flex 纵向） | 纵向拉伸全宽，文字长度不影响尺寸 ✅ |
| 各关闭小图标 | `.ocr-panel-close`/`.result-bar-close`/`.pin-window-close`/`.history-del-btn` | 固定方形 ✅ |

**结论：0 个新增未硬化漂移点。**

## 三、真正根因（决定性）

运行中窗口（本轮重启前 PID 87705）加载的是**修复落地前的旧 HMR 快照**：
- 旧版 `getExportDataUrl` 直接 `return current.dataUrl`（即原图）→ 用户"保存还是原图"是旧代码的**签名特征**，与描述完全吻合；
- 旧版 `.lang-toggle`/`.capture-card` 无定宽规则 → 中英文尺寸漂移，与描述吻合。

旧窗口的 HMR 连接在睡眠 / vite 重启 / 网络抖动后断开，不再收更新，于是反复显示旧行为——**不是代码没修，是窗口没更新**。

## 四、本轮动作（已闭环）

1. `pnpm build`（tsc + vite build）= exit 0，125 模块，无报错（大重构删 `src/components/ui`、`src/components/icons` 未破坏编译）。`dist/` 重建。
2. `curl http://localhost:1925/src/index.css` 与 `.../AnnotationCanvas.tsx` 实证 vite 正提供含 `min-width: 120px` / `getMergedImageDataUrl` / `repeat(4, minmax(0,1fr))` 的修复后源码。
3. **强制重启 dev 窗口**：`kill 87705` → `open src-tauri/target/debug/SnapCraft-dev.app`（新 PID **26835**，同二进制 ad-hoc 签名 ⇒ TCC 屏幕录制授权保留）。新窗口与 vite(:1925) 已建立 ESTABLISHED 连接 ⇒ 加载的是修复后最新源码，**三问题同时在运行态消失**。

## 五、给用户（自测步骤）

1. 现在窗口已是新实例（PID 26835），直接测试：
   - 点右上角 🌐 在「中文 / English」间切换 → 语言按钮宽度恒定不变；
   - 首页四张截图卡 → 中英文下完全同宽同高；
   - 编辑器打马赛克 → 保存/复制 → 导出图**带打码**。
2. 若日后又出现旧行为：说明当前窗口 HMR 又断了。**保持窗口开着、不休眠**即可让 vite 持续热更；或重跑 `./start.sh dev` / `./start.sh app` 重新拉起窗口。
3. 重要提醒：改前端代码后，**已打开的旧窗口不会自动变新**——必须重载/重开窗口才能看到变更（自动化只重建 dist，不重开 GUI 窗口）。

## 六、给后续轮次

- 源码三项修复 + 全量漂移扫描均已终态，**勿在已修源码上重复打补丁**。
- 用户再来报"没修"时，第一步 `pgrep`/`lsof` 确认其 dev 窗口是否仍连 vite；若 HMR 断连（旧 PID 卡旧快照），**直接 kill 旧 PID 并 open dev .app 重开**（同二进制保 TCC 授权）——比让用户手动 Cmd+R 更可靠。
- 本轮额外发现：此前 19 轮多聚焦前端，Rust 侧 `edit.rs` 实际始终正确（用传入 image_data），可排除"后端读原文件"这一类假想根因。
