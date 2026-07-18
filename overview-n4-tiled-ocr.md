# N4 长图/超大图自动分块 OCR

## 痛点
系统 OCR(Apple Vision / WinRT)对超大输入会**内部降采样**,一张很长的截图(长聊天记录、长网页)小字识别率骤降、整行漏识。此前整图一次识别,长图质量差。

## 方案(纯前端,零后端)
识别前在编辑窗前端判定「长图」,按高度切块分别识别,再把各块坐标映射回整图、几何重排、重叠区去重。

### 判定
- `isLongImage(w,h)`:高/宽 > 2.2 **或** 高 > 2400px → 长图。
- 普通截图(如 1920×1080)直接整图识别,行为完全不变。

### 分块与合并(`EditorWindow.tsx` 模块级函数)
- 块高 `OCR_BLOCK_H=1200px`,块间重叠 `OCR_OVERLAP=150px`(缓解边界行截断)。
- `runTiledOcr`:`new Image()` 加载整图 → 逐块 `canvas.drawImage` 裁出 → `toDataURL('image/png')` → `invoke('ocr_image')` 识别 → `mapBlockToFull` 把块内归一化坐标映射回整图(宽不变,高按偏移缩放) → 累加。
- 合并后 `ocrReadingOrder`(既有的多栏/竖排智能重排)排序 → `dedupeBlocks` 去重重叠区重复行(相邻同文本且垂直接近 <2%)。
- 单块识别失败不中断整体,其余块仍可用。

### 接入点
- `doOcr` 改写:`!img && isLongImage(imgWidth,imgHeight)` 时走分块;区域 OCR(`img` 传入)永远不分块(区域本身已足够小)。
- 后处理(结果写入、落库 `set_screenshot_ocr`、自动复制)只写一份,两条路径共用。

## 改动文件
- `src/features/screenshot/components/EditorWindow.tsx`
  - 模块级:常量 + `isLongImage` / `loadImageEl` / `mapBlockToFull` / `dedupeBlocks` / `runTiledOcr`
  - `doOcr` 增加长图分支

## 验证
- `pnpm build` exit 0(126 模块),`tsc` 零类型错误。
- 无新增 UI / 文案,对用户透明(仅感知长图识别更全更准、略慢)。
- 纯前端,前几轮已建 `ocr_image` / `set_screenshot_ocr`,**重启 App 生效**:`./start.sh dev` 或 `pnpm build && ./start.sh app`。

## 风险与边界
- 分块串行识别,长图总耗时 ≈ 各块之和(每块 Vision ~0.5–1s),有 `ocrBusy` loading 指示。
- 重叠区去重为轻量启发式,极个别情况下相邻不同列同文本不会被误删(按垂直距离判定)。
