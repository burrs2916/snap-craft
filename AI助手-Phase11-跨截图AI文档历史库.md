# AI 助手 Phase 11 — 跨截图 AI 文档历史库（UI 渲染补完）

> 参考 `privdoc-ai` 的 conversations 列表能力，把 SnapCraft 从「单轮生成」升级为「成稿可沉淀、可复用」。
> 纯前端，零 Rust 改动，不影响截图 / 标注 / OCR / 生成 / 导出。

## 需求发掘（为什么做）

复盘 Phase 1–10：AI 已能基于「编辑后截图」生成文档/文案，并能多轮打磨、导出 .md/.txt/.html/.docx/.pdf/.xlsx。
但有一个**最后一公里断点**——所有成稿「用完即弃」：用户生成几十份后无从回看，也无法在旧成稿上继续追问。

对照 `privdoc-ai` 的 `conversations` 列表，确诊 SnapCraft 缺一个「历史成稿库」。
关键发现：**Phase 11 的存储与逻辑层此前早已就绪**（`aiStore.ts` 的 `AiConvMeta` 索引 + `recordConvMeta` 在生成/润色后自动落盘 `snapcraft-ai-conv-index`；`listConvMeta`/`getConvByHash`/`deleteConv` 齐全；
AIPanel 也已声明 `showHistory` 状态与 `openHistory`/`openConvReader`/`loadConvIntoPanel`/`removeConv`/`handleHistoryExport` 等 handler，并挂了 📚 按钮）——**唯一缺口是 JSX 从未渲染该覆盖层，且 `ai.history*` i18n 键全部缺失**（📚 点了无反应）。

## 实现（本轮补完）

### 1. `src/features/ai/AIPanel.tsx`
- 新增 `fmtTime(ts)`（紧凑本地时间）与 `filteredList`（标题/预设名/预览 不区分大小写搜索）。
- 补「覆盖层」渲染块（`position:absolute; inset:0` 遮住面板，纯前端、零侵入）：
  - **列表态**：搜索框 + 卡片列表（缩略图 / 标题 / 预设徽标 / 时间 / 轮数 + `阅读`·`载入追问`·`删除`）。
  - **阅读器态**：返回 + 预设徽标 + `载入追问` + 末轮成稿标题 + `.md/.txt/.html/.xlsx` 导出 + 只读对话流。
- 复用既有 `handleHistoryExport`（md/txt/html/xlsx → Rust 保存命令，零新后端）。

### 2. `src/locales/zh-CN.json` + `en-US.json`
补 13 个 `history*` 键（中英）：`historyTitle / historyClose / historyLoaded / historyDeleted / historyEmpty / historyNoResult / historySearchPh / historyRead / historyLoad / historyDelete / historyBack / historyNoGoal / historyMsgs`。

### 3. `src/index.css`
补 20 个 `.ai-hist*` 类（覆盖层 / 标题 / 搜索 / 列表 / 卡片 / 缩略图 / 徽标 / 操作 / 阅读器 / 导出 / 对话流），复用 `--accent/--surface/--border/--text` 主题变量，**明暗主题自适应**。

## 与 privdoc-ai 的差异
其 conversations 是纯文档列表；本库天然把「**截图**」作为文档锚点——每份成稿按截图哈希分桶、带编辑后截图缩略图，更贴合「截图工具产文档」的独有价值。

## 验证
- `pnpm build` exit0（136 模块，零类型错误，无回归）。
- dist 含全部 20 个 `.ai-hist*` CSS 类 + 13 个 `history*` locale 键 + `ai-hist` 渲染接线。
- 触发路径：编辑器工具栏 📚 → 看到按截图分桶、时间倒序的成稿列表 → 搜索 / 阅读（导出）/ 载入追问 / 删除。

## 后续候选（未做）
- ② 后端代理隐藏 Key（需改 Rust，降低密钥前端暴露面）
- ③ 拖拽重排多截图选择顺序（纯前端，优化图文报告章节顺序）

## 生效方式
`./start.sh dev` 或 `pnpm build && ./start.sh app`。
