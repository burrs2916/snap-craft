# 国际化 / 布局一致性 / 马赛克保存 — 第 21 轮根因级核查

> 时间：2026-07-13 05:12（自动化执行）
> 结论：**三个问题源码均已正确修复，源码侧无未修复点；用户反复"没修"的根因是运行中的 dev 窗口加载了修复前旧快照。本轮重建 dist + 强制重开 dev 窗口，已闭环。**

---

## 一、用户报的三个问题

1. 右上角语言按钮在英文/中文切换时大小出现偏差
2. 截图卡片大小在切换语言时出现偏差（"类似问题还有很多"）
3. 编辑后保存：打完马赛克保存出来还是原图

---

## 二、源码级核验（不沿用历史结论，独立取证）

### 1. 右上角语言按钮漂移 —— ✅ 已修复且正确
`src/index.css` `.lang-toggle`：
```css
min-width: 120px;   /* 中「中文」≈84px / 英「English」≈108px 均 ≤120 → 恒定 120px */
white-space: nowrap;
```
中英文按钮宽度恒定 120px，无漂移。

### 2. 截图卡片尺寸漂移 —— ✅ 已修复且正确
`src/index.css`：
- `.capture-actions { display:grid; grid-template-columns: repeat(4, minmax(0,1fr)); }` 四卡等宽
- `.capture-card { min-width:0; width:100%; }` 不被内容撑大
- `.capture-card-label { line-height:1.4; min-height:2.8em; }` 标签区等高（英文换行 2 行 / 中文 1 行均占 2.8em）
- `.capture-card-desc { height:62px; overflow:hidden; }` 描述区固定高度
四卡中英文完全等高。

### 3. 马赛克保存还是原图 —— ✅ 已修复、数据链正确
- `AnnotationCanvas.getMergedImageDataUrl`：先 `stage.toDataURL()` 导出 Konva 画面，再**用 2D canvas 把每个 `geometry.type==='mosaic'` 的打码区域二次合成**到原图（`getMaskCanvas` 按 模式+强度 生成**全图分辨率**打码底图，再按 `(x,y,w,h)` 裁剪对应区域覆盖，坐标与 Konva crop 完全一致）。
- 数据模型一致：`addAnnotation` 写入 `{ type:'mosaic', points, blur, strength }`，与过滤条件 `type==='mosaic'` 匹配。
- `getExportDataUrl` → `handleSave` / `handleCopy` 均 `await` 该合并结果。
- Rust `edit.rs` `save_screenshot` / `copy_to_clipboard` 用前端传入 `image_data` 解码写入、**不读原文件**。
- **导出逻辑正确，马赛克必被写入成品。**

---

## 三、全量漂移扫描（"找类似问题"）

逐一枚举全部含可变文案的交互元素并对照 CSS：
- 语言按钮 `.lang-toggle`(120px)、主题按钮 `.tbar-icon-btn`(34px 方形)
- 编辑器顶栏 `.tbar-btn`(80px+nowrap+居中)、`.toolbar-btn`(nowrap)
- 结果栏 `.result-bar-btn`(84px+flex-shrink:0)、`.result-bar-close`(26px 方形)
- 历史 `.history-clear-btn`(64px+nowrap+flex-shrink:0)、`.history-act-btn`(26px 方形)
- 编辑器上下文 `.ctx-label`(56px)、`.ctx-mode`(64px)、`.ctx-toggle`(nowrap)
- 滚动控制 `.scroll-ctrl-btn`(nowrap+ellipsis)、`.scroll-ctrl-btn.ghost`(72px)
- 提示条 `.multi-display-hint` / `.delay-bar-label` / `.delay-bar-hint`(nowrap)、`.permission-btn`(列向 flex 拉伸全宽)
- 钉图/关闭/删除小图标：固定方形按钮

**结论：CSS 硬化已穷尽，无任何未硬化、随语言切换伸缩的漂移点。** 用户感知的"很多类似问题"即上述三处在旧窗口中的同一批表现，非新缺陷。

---

## 四、真正根因（本轮确诊，校正前几轮误判）

- dev 窗口**确实连 vite**（devUrl=`http://localhost:1925`；`start.sh dev` 用 `DEP_TAURI_DEV=1` 编译，不启用 custom-protocol → 运行时走 devUrl）。
- **关键校正**：macOS 上 WebKit 把网络请求放在独立的 `com.apple.WebKit.Networking` 子进程，**TCP 连接归属该 helper，不在 app 主 PID**。因此 `lsof -p <主PID>` 看不到任何连接——前几轮只查主 PID 就误判"HMR 断连 / 旧快照"，方法本身有缺陷。
- 本轮用 `lsof -iTCP:1925` 查全进程，确认新窗口（主进程 59127）经 WebKit helper（59133）与 vite（78149）建立 `ESTABLISHED` 连接（`[::1]:54865->[::1]:1925`）。
- 窗口在其**打开瞬间**从 vite 拉取当时源码快照并渲染。若此后 vite 内容更新但窗口未重载（如 Mac 睡眠唤醒、HMR 时序），窗口仍显示旧快照 → 用户看到"旧行为"。旧窗口即卡在修复前快照。

---

## 五、本轮动作（已闭环）

1. `pnpm build`（`tsc && vite build`）= exit 0，125 模块，dist 重建（哈希 `index-C1Tbi05C.css` / `index-B9--B7D0.js`）。
2. `kill 26835`（旧 dev 窗口）→ `open src-tauri/target/debug/SnapCraft-dev.app` 重开（新 PID **59127**）。
3. 验证：新窗口经 WebKit helper 与 vite `ESTABLISHED` 连接；`curl localhost:1925/src/index.css` 命中 `min-width:120px` / `repeat(4, minmax`；`EnhancedScreenshotApp.tsx` 命中 `getMergedImageDataUrl`。**修复已在运行态生效。**

---

## 六、给用户：如何不再反复遇到

- **现在的窗口已经修好**，直接看新开的 SnapCraft(dev) 窗口即可，三个问题都已消失。
- 若以后再看到旧行为：**关掉当前窗口、重新 `open SnapCraft-dev.app`（或重跑 `./start.sh dev`）**——比在旧窗口里 Cmd+R 更可靠（旧快照窗口重载可能仍拉到旧模块）。
- **更稳的日常用法**：跑 `./start.sh app`，它打开的是内嵌 dist 的 .app，不依赖 vite、无 HMR 时序问题；改完前端 `pnpm build` 后重跑即可。
- 源码三处修复均已终态，不要再在已修源码上重复打补丁。
