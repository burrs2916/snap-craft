# N3：编辑窗多区域连续框选 OCR

## 背景
原编辑窗「框选区域 OCR」是**单次**行为：框一个区域就退出选区模式，且结果会替换整图 `ocrResult`。一张图里若有多个分散区域要识别，用户必须反复点击「框选区域」按钮。本轮将其升级为**多区域连续框选累加**，直接贴合用户最初最看重的「框选一部分 OCR」诉求。

## 改动文件（纯前端，零后端 / 零 Rust 重编）
- `src/features/screenshot/components/EditorWindow.tsx`
- `src/index.css`
- `src/locales/zh-CN.json` / `src/locales/en-US.json`

## 关键设计
1. **AnnotationCanvas 零改动** —— 选区模式是否保持完全由编辑窗 `handleRegionOcr` 回调控制，组件本身不用动。
2. 新增 state：
   - `ocrMultiRegion: boolean`（默认 false，侧栏 toggles 第 5 个开关）
   - `ocrRegions: RegionOcrResult[]`（每个区域 `{ id, dataUrl, text, blocks }`）
3. `handleRegionOcr` 分支：
   - 多区域模式 → 不退出选区模式，直接 `invoke('ocr_image', {imageData, lang})` 单独识别并 `push` 进 `ocrRegions`（不复用整图 `doOcr`，避免覆盖整图结果 / 误落库）；
   - 单区域模式 → 原行为（退出模式 + 预览 + `doOcr`）。
4. 辅助操作：`copyRegion`（复制单区域）、`mergeCopyRegions` / `mergeExportRegions`（合并所有区域文本，以 `\n\n` 分隔，复制 / 导出 `save_text_file`）。
5. 侧栏区块 `.ocr-regions`：仅 `ocrMultiRegion && ocrRegions.length>0` 时显示，列出区域卡片（序号徽标 + 缩略图 + 文字 + 复制本区域/删除），底部「合并复制 / 合并导出」，头部「清空区域」。

## 质量要点
- **修复 stale 闭包**：合并文本改为在 `useCallback` 内联计算，避免抽成普通函数被闭包捕获后读不到最新 `ocrRegions`。
- 样式复用 `--surface-strong` / `--border` / `--border-soft` / `--accent` / `--text` 等变量，深浅色自适应。

## 验证
- `pnpm build` → exit 0（126 模块），`tsc` 零类型错误。
- grep 确认无 `mergeRegionsText` 残留引用。
- dist 产物包含新逻辑 + 新 CSS + 9 个新增 i18n 键。

## 生效方式
纯前端改动，但前几轮动过 Rust 后端，需重启 App：
- 开发：`cd src-tauri && ./start.sh dev`（或项目既有 dev 启动脚本）
- 生产：`pnpm build && ./start.sh app`
