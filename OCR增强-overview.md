# SnapCraft · OCR 取字功能增强

> 实施时间：2026-07-13 20:27 起。状态：代码完成，`pnpm build`(前端) + `cargo check`(后端) 通过，release `.app` 已重建。

## 改了什么

之前 OCR 只返回「纯文本字符串」——其实 Apple Vision 已经算好了每个文字块的**坐标 + 置信度**，旧代码只取了 `.text` 把它们扔掉了。本次把结构化数据用起来了。

### 1. 后端 `src-tauri/src/commands/ocr.rs`
- `ocr_image` 返回从 `String` 改为结构化 `OcrResult { text, blocks: OcrBlock[] }`，每块含 `text / x / y / w / h / confidence`（坐标**归一化、原点左上**，与前端画布一致）。
- macOS 侧：把 Vision 的 `bounding_box`（原点左下）做 `y = 1 - y - h` 翻转为左上原点。
- 新增 `lang: Option<String>` 参数：
  - **Windows** 侧走 `TryCreateFromLanguage` 强制语言，PowerShell 输出归一化 JSON 由 Rust `serde_json` 解析；
  - **macOS** 侧 `apple-vision` 0.16 未暴露强制语言接口，仍走系统自动选语言（UI 已注明仅 Windows 强制生效）。
- `OcrBlock` / `OcrResult` 必须 `pub`（Tauri command 宏跨 FFI 边界要求）。

### 2. 前端
- `types.ts`：新增 `OcrBlock` / `OcrResult` 接口。
- `AnnotationCanvas.tsx`：新增 `ocrRegionMode` + `onRegionOcr` 属性，**复用现有 crop 拖拽机**实现「框选区域」——拖拽出矩形，松手用 `image` 裁出区域图回传，不创建标注。
- `EnhancedScreenshotApp.tsx`：
  - 面板升级为 **语言选择（自动/中文/英文/日文）+ 全文只读框 + 逐行列表（置信度 chip + 该行单独复制）+ 「作为文字标注贴回截图」按钮 + 复制全部/关闭**；
  - 工具栏新增 **「框选区域」** 按钮，进入框选模式并在画布上方显示提示条；
  - `applyOcrAsAnnotations`：把每个文字块按 `x*W, y*H` 映射成图内像素锚点、字号取块高、复用当前字体/颜色/背景默认，生成可编辑文字标注——**与前面做好的文字编辑体系打通**。
- `locales`(zh-CN/en-US) + `index.css`：新增文案键与 `.ocr-lang / .ocr-blocks / .ocr-block / .ocr-chip / .ocr-block-copy / .ocr-region-hint / .ocr-panel-count` 样式。

## 怎么验收
```bash
./start.sh app      # 打开已含新后端的 SnapCraft.app
```
- 截图进入编辑器 → 点「取字」：面板应显示语言选择、逐行结果（带置信度）、「作为文字标注贴回截图」按钮。
- 点「框选区域」→ 在图上拖拽框选 → 松手只识别该区域文字。
- 贴回后可在画布上双击文字继续编辑（颜色/字体/背景等沿用已做的文字工具）。

## 已知限制
- macOS 强制语言受 `apple-vision` 0.16 限制暂不可行（自动选语言已够准）；Windows 侧可强制。
- 逐行块的「阅读顺序」对多列/竖排版面 Vision 可能仍按读序，未作额外重排（后续可增强）。
