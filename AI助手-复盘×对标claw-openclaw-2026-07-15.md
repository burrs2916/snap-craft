# SnapCraft AI 整体复盘 × 对标顶级项目（claw-code / openclaw）

> 自动化轮次：2026-07-15 ｜ 复盘方法：**真值核查**（直接读源码，而非仅依赖历史记忆）
> 参照样本：`/Volumes/HPFX900固态盘/large model/references/claw-code-main`（Rust+TS）、`/Volumes/HPFX900固态盘/large model/references/openclaw-main`（TS/Swift 巨仓）

---

## 一、结论速览

| 维度 | 现状 | 是否假实现 | 对标顶级项目后的差距 |
|---|---|---|---|
| 功能落地 | Phase 1–12 全量真实可达 | **无空/假实现** | — |
| 前后端联动 | 18/18 `invoke` 命令对齐 | 无断联 | — |
| 流式输出 | SSE 帧解析 + 退避重试 + 预算护栏 | 真实现（Phase 13） | **已追平** |
| 上下文窗口 | 字符/4 估算 + 裁剪最旧轮次 | 真实现 | 中等（缺增量摘要链/渐进降级） |
| 记忆 | 启发式词重叠 + 重要性筛选 | 真实现（Phase 6/9） | **较大**（纯词法，无衰减/多样性/概念） |
| 会话持久化 | localStorage 按截图哈希分桶 | 真实现（Phase 4/11） | 适当（桌面端无需服务端分库） |
| Agent 工具循环 | **未做** | — | **最大差距 = 最大卖点** |

**核心判断**：我们已经把"截图 → AI 文档"做成了**真实可用、无假实现**的完整链路；基础层（流式/上下文/记忆/会话）已达**可用且部分追平顶级项目**的水平。下一步真正的胜负手是 **AI Agent 化（让模型直接操作截图）**，其余为润色与增强。

---

## 二、真值核查：已落地功能（无空/假实现）

逐项核对 `src/features/ai/` 九大文件源码，确认以下能力**均可从 UI 点击到达真实后端/输出**：

1. **AI 面板**（AIPanel.tsx，1298 行，全量 JSX 接线）— 预设 chips / 需求输入 / 上下文开关 / 流式输出 / 复制 / 清空 / 新对话
2. **流式生成**（aiClient.streamChat）— SSE 帧边界切分、多 `data:` 拼接、尾部 flush、内嵌 error 帧识别、指数退避重试（≤3 次、尊重 429 Retry-After、用户取消绝不重试）
3. **6 格式导出**：`.md / .txt / .html / .docx（内嵌截图）/ .xlsx / .pdf` — 全部接真实 `save_text_file` / `save_binary_file`
4. **多截图成稿 + 图文报告**（Phase 5：`<!--SNAP:k-->` 章节锚点 + 图文混排）
5. **精美文档主题**（Phase 12：5 套主题化 HTML 封面 + 预览）
6. **多轮对话**（Phase 4：按截图哈希分桶持久化）
7. **记忆压缩 + 相关性检索**（Phase 6/9：压缩早期轮次、按相关性注入）
8. **跨截图 AI 历史库**（Phase 11：索引 + 列表 + 阅读器 + 搜索 + 载入追问 + 6 格式导出）
9. **AI 看"编辑后截图" + OCR 跟随**（Phase 8/10：`visionImageUrl` + `aiOcrText`，打码/模糊区不外泄，**隐私闭环**）

> grep 全仓 `TODO/FIXME/stub/未实现/placeholder`：仅命中合法的 input `placeholder`，**无死代码 stub**。

### 前后端联动核查（18/18 对齐）
`invoke` 命令与 `src-tauri` `#[tauri::command]` 100% 对应，无参数错位/形状错配：
`get_history / save_text_file / save_binary_file / ocr_image` 均在 AIPanel 真实调用并匹配返回类型（如 `HistoryItem` 字段对齐 Rust `HistoryItem`）。

---

## 三、对标顶级项目：四维度能力映射

### 3.1 流式 / SSE 输出
| | claw-code（Rust） | openclaw（TS） | 我们 |
|---|---|---|---|
| 帧切分 | `next_frame` 按 `\n\n`/`\r\n\r\n` | 归一 `\r\n` + `indexOf("\n\n")` | ✅ 同（`findFrameEnd`） |
| 跨块合并 | 多 `data:` 行 `join("\n")` | 同 | ✅ 同 |
| 尾部 flush | — | `decode` 尾 flush | ✅ 同 |
| 重试 | 指数退避+抖动，最多 8 次，仅 408/409/429/5xx | `retryAsync` 3 次 | ✅ 已实现（≤3 次） |
| abort | — | abort 感知 reader | ✅ `readAbortable` |

**结论：流式已追平顶级项目，无需再投入。**

### 3.2 上下文窗口管理
- **claw-code** `compact.rs`：`CompactionConfig{preserve_recent_messages:4, max_estimated_tokens:10_000}`、`estimate_message_tokens=len/4+1`、自动压缩阈值 `input_tokens≥100k`、且**保护 tool-use/tool-result 对边界**避免 400。
- **openclaw** `compaction.ts`：`contextEngine.compact({tokenBudget})`、保留 `firstKeptEntryId`、**安全剥离 toolResult.details 后再摘要**、**渐进降级**（全量失败→仅小消息）、`previousSummary` 增量汇总、检查点持久化。
- **我们** `trimHistoryToBudget`（字符/4、裁最旧、保留最近 3 轮+system）+ `compactMemory`（非流式摘要、失败静默回退）。

**差距**：① 压缩未做"增量摘要链"（每次重摘要而非在旧摘要上追加）；② 无渐进降级（openclaw 的 safety strip + fallback）；③ 无自动压缩阈值（我们仅在 >16 条时触发）。**影响有限，属稳健性增强。**

### 3.3 记忆（长期）
- **claw-code**：无独立向量记忆库；长期记忆 = JSONL 持久化 + 压缩摘要（结构化字段）。**这是它的可增强缺口。**
- **openclaw** `memory-core`：六因子加权评分 `frequency·relevance·diversity·recency·consolidation·conceptual + phaseBoost`，recency 用**半衰衰减** `calculateRecencyComponent(ageDays, halfLifeDays)`，重要性为 0–1 多分量 + 概念标签；模型**主动调用 `memory_search` 工具**检索；"dreaming" cron 把高频短期记忆提升进 `MEMORY.md`。
- **我们** `Phase 9`：启发式 `tokenize`（CJK 单字+二元组+拉丁词）/ `relevanceScore`（命中率）/ `selectMemories`（≤5 全注入，≥4 重要性恒注入，其余按相关性补满）。

**差距（明显）**：① 纯词法重叠，对"同义不同词"失效；② 无 recency 衰减（旧记忆与刚发生的事等权）；③ 无 diversity（可能注入高度重复的记忆）；④ 无概念标签。这是"AI 更聪明"最该补的点，且**纯前端可落地**（本地轻量 embedding 或 BM25 + 衰减）。

### 3.4 会话 / 持久化
- **claw-code** `session.rs`：每会话 **JSONL 原子追加写**（临时文件 + rename）、**>256KB 滚动**、**单调时间戳会话 ID**、按 `workspace_root` 隔离。
- **openclaw**：按 `canonical` 会话键的**文件分桶**（每 agent 一个 store）、规范键合并。
- **我们**：localStorage 按 `convHash(截图)` 分桶、对话线程 + 长期记忆 + 历史索引三套键。

**结论**：桌面端单用户场景，localStorage 分桶**足够且更轻**，无需对齐服务端的文件/原子写体系——此为**架构事实差异，非短板**。

### 3.5 Agent / 工具调用循环（最大差距）
- **claw-code** `conversation.rs` `run_turn`：**迭代循环**——`stream` → 聚合 `ToolUse` → 逐工具跑 pre-hook/权限/`tool_executor`/post-hook → 回写 `ToolResult` → 下一轮，直到无待执行工具或超 `max_iterations`。
- **openclaw** `agent-runner.ts`：封装成熟 agent 核心库，自补 **`detectToolCallLoop`**（哈希级失控循环检测）+ 钩子 + 权限审批。

**我们：完全未做。** 这是 SnapCraft 与顶级 AI 产品之间**最大的功能代差，也是把 AI 做成"真正卖点"的胜负手**——因为我们的独有价值是"截图即画布"，让模型**直接操作截图**（自动标注 / 隐私哨兵打码 / 圈选重点 / 一键教程）是竞品（纯文档工具）做不到的。

---

## 四、本轮实修：文档润色增强（安全、可见、增量）

针对"文档生成还需继续润色"，本轮落地两项**纯前端、零 Rust、零回归**的增强（已 `pnpm build` 通过，136 模块 exit0）：

1. **封面副标题曝光**：此前 `subtitle` 已在主题引擎支持但 UI 从未传（即之前记录的"死代码"）。现 `AIPanel` 在 HTML/PDF/预览/历史导出时把**用户需求文本（goal / firstGoal）作为副标题**传入，封面信息更完整（"这份文档为谁而生"一目了然）。
2. **自动目录 TOC**：`markdownHtml.ts` 新增 `toc`/`tocTitle` 选项——为 H2/H3 生成锚点 id 并自动汇总为目录，支持中英标题（`ai.toc` 键），**仅当文档含 ≥3 个 H2 时自动出现**，长文档更易导航。

样例：`AI助手-样例-目录封面演示.html`（已生成，验证 `doc-toc` + `doc-sub` 均渲染）。

---

## 五、仍可发掘的新需求 / 卖点（按 ROI 排序）

| # | 机会 | 类型 | 收益 | 风险 |
|---|---|---|---|---|
| 1 | **AI Agent 工具循环**（模型操作截图：智能标注/隐私打码/圈选/教程） | 胜负手 | 竞品无此能力，差异化最强 | 中（需确认工具契约） |
| 2 | **语义/衰减记忆升级**（BM25+recency+importance，本地轻量） | 增强 | AI 更聪明、长文档更连贯 | 低（纯前端） |
| 3 | **后端代理隐藏 Key**（Rust 中转） | 安全 | 密钥不下发渲染层 | 中（需 Rust） |
| 4 | **实时划词/选区 AI**（选中区域即问） | 体验 | 极高频、强感知 | 低（纯前端） |
| 5 | **多截图选择拖拽重排**（候选③） | 易用性 | 修正误选顺序 | 低（纯前端） |
| 6 | **压缩稳健性**（增量摘要链 + 渐进降级） | 稳健 | 超长会话更稳 | 低 |
| 7 | **docx 套主题封面 + TOC 字段**（Word 目录） | 润色 | 文档更专业 | 中（docx 字段码） |
| 8 | **批量截图 AI 工厂**（队列批量成稿） | 效率 | 多截图工作流提效 | 低 |

---

## 六、优先级路线图

- **立即做（低成本高收益，纯前端）**：#5 拖拽重排 + #4 划词 → #2 语义记忆升级 → #6 压缩稳健性。
- **需确认契约后做（胜负手）**：#1 AI Agent 工具循环（建议先与用户确认"前端暴露给模型的标注操作工具契约"：`addAnnotation` / `redactRegion` / `circleRegion` / `generateTutorial`）。
- **需 Rust（择机）**：#3 后端代理隐藏 Key → #7 docx 封面/TOC。

> 原则（沿用用户偏好）：**诊断优先、增量增强、绝不推翻重构、私隐闭环不回退**（Phase 8/10 的"编辑后图 + 编辑后 OCR"对齐必须保持）。

---

## 七、下一步建议

**把 #1（AI Agent 化）作为本系统 AI 的真正卖点立项**，但动手前请确认工具契约与交互形态（模型"操作截图"的边界、是否需要用户逐操作确认）。在此之前，可先并行推进纯前端的 #2/#4/#5，持续把"截图→精美文档"这条已验证的真实链路打磨到竞品无法模仿。
