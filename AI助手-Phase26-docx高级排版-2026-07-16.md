# AI 助手 Phase 26 — P1② docx 高级排版（已完成）

> 续 Phase 25。落地 Phase 19 路线图 P1「docx 高级排版」：把 AI 导出的 `.docx` 从「朴素纯文本文档」升级为**专业报告质感**，全部为 `markdownDocx.ts` 内部纯增量增强，**零 Rust、零新依赖、不破坏对外接口**。

## 1. 为什么做
现有 `markdownDocx.ts` 已能导出封面 / 自动目录 / 表格 / 代码块 / 引用 / 图片 / 章节锚点，但整体仍是「朴素文档」观感：表格无行交替、标题无强调、引用是灰竖条、没有页眉页脚、行内不支持链接/删除线。这些都是「专业感」的直观信号，补齐后导出文档可直接用于正式交付/汇报。

## 2. 改动清单（单文件 `src/features/ai/markdownDocx.ts`，约 +50 行增强）

| 增强点 | 实现 | 价值 |
|---|---|---|
| **表格斑马纹** | 数据行 `ri>0` 按奇偶交替浅色底 `F4F5F9`，表头维持 accent 浅紫 `E8EAF6` | 长表格一眼可读，告别白底疲劳 |
| **标题强调竖条 + 下划线** | H1/H2 左侧 accent 竖条（size 18）+ 加大字号（H1 40 / H2 32）；H2/H3 下方 accent 细线（下划线强调）；标题色随 5 套主题强调色 | 像 Notion / 产品文档的层级感 |
| **引用块 accent 配色** | 左侧竖条改 accent 色（size 18）+ 浅底 `F7F8FA` 配色，替换原灰竖条 | 引用 / 提示块更易辨识 |
| **页眉 + 页脚页码** | 页眉右对齐显示标题（灰字 `9CA3AF` + 细分隔线）；页脚「第 X / 共 Y 页」用 `PageNumber.CURRENT` / `PageNumber.TOTAL_PAGES` | 专业报告标配，长文档可导航 |
| **行内语法补全** | `[text](url)` → `ExternalHyperlink`（Word 内可点击跳转，accent 色 + 下划线）；`~~del~~` → `TextRun.strike` 删除线 | 补全 Markdown 行内表达，文档更完整 |

`import` 新增 `Header / Footer / PageNumber / ExternalHyperlink`（docx 9.7.1 原生导出，已确认 API 存在）。

## 3. 铁律保持（零回归）
- **未改 `markdownToDocx` 对外接口**：调用方 `AIPanel.tsx` 两处（`handleExportDocx` 以及另一处 docx 导出）无需任何改动，标题/主题自动驱动新排版。
- **主题配色驱动**：所有强调色继续来自 `THEME_ACCENT`（modern/elegant/magazine/product/tech 五套），未硬编码。
- **不碰截图/标注/导出链路**：纯渲染层润色，AI 编辑、合并导出、OCR 逻辑完全不受影响。
- **坐标铁律无关**：本阶段与 AI 工具坐标无关，无回归面。

## 4. 验证（全绿）
- `npx tsc --noEmit` → 0 错（修复点：`underline` 必须传 `IUnderlineOptions` 对象而非布尔，docx 9.7.1 类型约束）
- `pnpm build` → exit 0（1.96s，140 模块）
- `test-tool-call-parser.mjs` → 50 / 50 绿
- `test-zip.mjs` → 7 / 7 绿（`unzip -t` No errors detected）
- **端到端 docx 生成 sanity**：esbuild 打包 `markdownDocx.ts` → node 跑 `markdownToDocx` 生成真实 `.docx`（11,539 字节）→ 系统 `unzip -t` 报告 **No errors detected**（OOXML 结构合法，证明 `ExternalHyperlink`/`PageNumber` 运行时 API 完全正确，无抛错）
- `dist/assets/index-*.js` 含全部新排版 token：`F4F5F9`(斑马纹) / `F7F8FA`(引用底) / `9CA3AF`(页眉页脚灰 ×4) / `E5E7EB`(分隔线 ×2) / 页脚中文「第 」「 页」

## 5. 故意未做（避免过度 / 风险控制）
- **列表嵌套**：当前扁平 bullet，嵌套需重写 `flushList`，有回归风险，留独立优化。
- **代码语法高亮**：docx 无内建分词高亮，需自建 tokenizer，复杂度高收益低，跳过。
- **封面大改 / 品牌 logo**：当前封面已够用，避免引入图片资源依赖。

## 6. 路线图剩余
- 🔥P0-γ 后端代理隐藏 Key（需 Rust，零 Rust 约束外 → 单独评估）
- 🟠P1 ①本地语义记忆（transformers.js + MiniLM 量化）
- 🟡P2 ①选区/划词 AI（OCR 文本→标注）②批量 Agent 队列 ③Agent 工具集扩充（callout ✅ / crop 暂缓）④PPT 导出

---
交付日期：2026-07-16 ｜ 阶段：Phase 26 ｜ 模块：AI 助手 / docx 导出
