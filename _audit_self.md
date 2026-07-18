# AI 助手"生成文档"功能 · 主理人独立审计

> 审计人：齐活林（主理人） · 2026-07-18
> 范围：src/features/ai/ 全部 15 个文件（8346 行）

## 总体评价

**代码质量高，没有发现空实现或假实现。** 6 格式导出全部真实现，附带截图/OCR/润色/工具循环全部落地。PPT 元数据假实现已修复（markdownPptx.ts:660 `coreXml(title, nowIso)`）。

## 确认的问题清单

| # | 优先级 | 类型 | 问题 | 文件:行 |
|---|--------|------|------|---------|
| 1 | P1 | 体验缺陷 | PDF 导出走系统打印（`printHtmlViaIframe`），无落盘路径 → 无法 Finder 显示/打开，与其他 5 格式体验割裂 | AIPanel.tsx:1047-1081 |
| 2 | P1 | 体验缺陷 | `lastExportedPath` 是 useState 未持久化，重开应用丢失"上次导出到哪" | AIPanel.tsx:290 |
| 3 | P1 | 体验缺陷 | PDF 导出未设 `setExporting(true)`，无 loading 态（其他 5 格式都有），用户点击后无反馈 | AIPanel.tsx:1048-1049 |
| 4 | P2 | 可优化 | 两套导出 UI 代码重复（抽屉模式 ~1606 + 全屏模式 ~2134），维护负担、易不一致 | AIPanel.tsx |
| 5 | P2 | 不达预期 | `recordConvMeta` 传 `ctx.imageDataUrl`（原图），编辑后截图（getMergedImageDataUrl）不更新历史缩略图 | aiStore.ts:777 |
| 6 | P2 | 可优化 | `refine` 润色丢截图上下文（只传 output+instruction，不带历史对话/截图），润色可能偏离原文档语境 | aiStore.ts:962-1009 |
| 7 | P2 | 体验缺陷 | 导出成功反馈消息无自动消失（exportMsg 一直停留），用户需手动清空或被误导以为还在导出 | AIPanel.tsx:281 |
| 8 | P2 | 边界Bug | 用户手动选 report 预设 + 取消"附带截图"勾选 + 点"生成"（非图文报告按钮）→ AI 输出 SNAP:k 标记但 orderedImages() 不含当前图，导出时章节截图对不到图。handleMakeReport 强制 attachImage=true 规避，但 handleGenerate 路径未覆盖 | AIPanel.tsx:675-694 |
| 9 | P2 | 体验缺陷 | handleExportPdf 无 finally 块——若 printHtmlViaIframe 抛异常，无统一收尾（其他导出函数都有 finally setExporting(false)） | AIPanel.tsx:1047-1081 |

## 确认的真实现（排除嫌疑）

| 功能 | 结论 | 依据 |
|------|------|------|
| DOCX 导出 | ✅ 真实现 | 用 `docx` 库，ImageRun 内嵌截图，TOC + 表格对齐 + 表头跨页 |
| PPTX 导出 | ✅ 真实现 | 手搓 OOXML+ZIP，截图经 store-ZIP 内嵌 ppt/media，元数据已修复 |
| XLSX 导出 | ✅ 真实现（非空壳） | 用 `xlsx` 库，多 sheet + CJK 列宽 + 表头加粗 |
| HTML 导出 | ✅ 真实现 | 5 套主题 + GFM 表格 + TOC + 代码块 + 任务清单 + 富文本片段 |
| PDF 导出 | ⚠️ 真实现但体验割裂 | iframe + window.print()，能生成 PDF 但无落盘路径 |
| MD/TXT 导出 | ✅ 真实现 | save_text_file 落盘 |
| 附带截图 | ✅ 真发图 | images 数组进 streamChat 的 messages content |
| 附带 OCR | ✅ 真拼进 prompt | buildUser/buildReportUser 注入 withOcr 文本 |
| 润色 | ✅ 真调 AI | refine() → streamChat，5 个快捷指令 |
| 智能编辑工具 | ✅ 真执行 | createToolExecutor → AiToolHost，坐标 clamp01 归一化 |
| 隐私哨兵 | ✅ 真执行 | agentSystemSentinel + redact_area 工具循环 |
| 会话持久化 | ✅ 完整 | convHash + localStorage，output 从末条 assistant 回填 |
| 记忆压缩 | ✅ 完整 | 滚动摘要 + MMR 多样性 + 多因子评分 |
| Finder 显示 | ✅ 真实现 | revealInFolder → invoke('reveal_in_folder') |
| 打开文件 | ✅ 真实现 | openExported → invoke('open_path') |

## 新需求卖点（发掘）

| # | 卖点 | 价值 | 实现难度 |
|---|------|------|----------|
| N1 | **文档统计信息**（字数/字符/阅读时长/截图数）生成后展示 | 专业感、量化感知 | 低（纯前端计算） |
| N2 | **导出历史持久化** —— localStorage 记录最近 20 次导出（格式/路径/时间/标题） | 回顾、复用、不丢失 | 低 |
| N3 | **批量多格式导出** —— 勾选 docx+pdf+md 等，一次连续导出 | 效率、省事 | 中 |
| N4 | **PDF 真落盘**（html2pdf.js / jsPDF 纯前端） | 与其他格式体验一致，一键导出 | 中（新依赖+渲染质量权衡） |
| N5 | **导出文件名预览** —— 导出按钮旁实时显示将保存的文件名 | 透明、可预期 | 低 |
| N6 | **文档大纲侧边栏** —— 预览时左侧显示标题树，点击跳转 | 长文档导航 | 中 |

## 建议修复方案（给工程师）

### 第一批（P1，体验一致性）
1. **PDF 导出加 loading 态**：handleExportPdf 加 setExporting(true/false)，与其他格式对齐
2. **lastExportedPath 持久化**：改为 localStorage 读写（snapcraft-ai-last-export-path），重开应用恢复
3. **导出反馈自动消失**：exportMsg 设置后 4s 自动清空（成功消息），错误消息保留

### 第二批（P2，完善优化）
4. **recordConvMeta 缩略图**：润色/编辑后若 visionImageUrl 存在（编辑后合成图），优先用它生成缩略图
5. **refine 润色带上下文**：messages 增加最近 2 轮对话历史（轻量），避免润色偏离语境
6. **两套导出 UI 抽取共享组件**：ExportButtons({ onExport, ... }) 复用

### 第三批（新需求卖点）
7. **文档统计**：生成完成后在导出区上方显示「N 字 · M 行 · 约 K 分钟 · 含 P 张截图」
8. **导出历史持久化**：新模块 exportHistory.ts，localStorage 存最近 20 条，UI 入口在导出区
9. **导出文件名预览**：导出按钮区显示 buildDefaultPath 的文件名部分

### 暂缓（需评估）
- PDF 真落盘（html2pdf.js）：渲染质量可能不如原生打印，需 A/B 对比后决策
- 批量多格式导出：UI 复杂度高，先观察用户需求
