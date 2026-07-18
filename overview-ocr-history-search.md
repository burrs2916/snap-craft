# 历史按 OCR 文本搜索

## 做了什么
- 历史网格新增搜索框，匹配已落库的 OCR 文字（`ocr_text`）+ 截图时间
- `HistoryEntry` 补 `ocr_text?` 字段；新增 `historySearch` state + `filteredHistory` 过滤计算
- 空态双分支：无历史（原提示）vs 有搜索无匹配（新「没有匹配的截图」）
- 复用 `.ocr-search-input` 同款变量体系，深浅色自适应

## 改动文件
- `src/features/screenshot/EnhancedScreenshotApp.tsx`
- `src/index.css`（`.history-search-row` / `.history-search-input` / `.history-search-clear`）
- `src/locales/zh-CN.json` / `en-US.json`（`history.searchPlaceholder` / `history.noMatch`）

## 验证
- `pnpm build` exit 0（126 模块），`tsc` 零错误
- 纯前端改动，重启 App 生效（`./start.sh dev` 或 `pnpm build && ./start.sh app`）

## 下一步候选
1. **验收** — 重启跑一遍 N1 / N2 / R4 增强 / 本次搜索，确认无回归
2. **N2 下半** — 编辑窗 OCR 结果文字专属「字号 A−/A+」缩放（非阻塞）
3. **其他新需求** — 多区域一次批量取字 / 长图·PDF 支持
