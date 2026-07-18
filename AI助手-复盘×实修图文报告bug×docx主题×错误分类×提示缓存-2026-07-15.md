# AI 助手整体复盘 × 真值核查 × 实修（图文报告 bug / docx 主题 / 错误分类 / 提示缓存）

> 自动化轮次：2026-07-15 16:55 · 方法：只读审计当前码 + 对照 `claw-code-main` / `openclaw-main` 两份顶级项目源码

## 一、真值核查结论（先确认健康度）

| 检查项 | 结果 |
|---|---|
| 空 / 假实现 | **无**。AIPanel 全部按钮均有真实 handler，10 项声明功能均可从 UI 点击到达真实输出 |
| 前后端联动 | **18/18 `invoke` 命令与 `src-tauri` `#[tauri::command]` 100% 对齐**，无 camelCase/snake_case 错位、无参数形状错配 |
| AI 编辑器接线 | Phase 8 `visionImageUrl`、Phase 10 `aiOcrText`/`refreshAiVision`、Phase 11 历史覆盖层均真实挂载并生效 |
| i18n 完整性 | 修复前发现 **5 个孤儿 key**，已清理；新增 4 个错误文案 key，中英齐备 |

## 二、本轮实修（纯前端 / 零 Rust / `pnpm build` exit0 / 136 模块 / 零回归）

### 🔴 P0 — 旗舰「图文报告」章节内嵌截图在导出端完全失效（关键 bug，已修）
- **根因**：`hasSnapMarkers()` 用 `SNAP_MARKER_RE.test(md.trim())`（`^...$` 整篇锚定）→ 只有「整篇恰好只有一行标记」才为真，真实多段报告恒为 `false`；且三个导出 handler 在把原文交给渲染器**之前**先 `stripSnapMarkers()`，标记被删，渲染器再也找不到 `<!--SNAP:k-->` 锚点。
- **后果**：HTML 导出**整篇无截图**；PDF 仅把全部截图堆在正文前（非分章混排）；docx 走整块前置。
- **修复**（`aiPresets.ts` + `AIPanel.tsx`）：
  - `hasSnapMarkers` 改为「任意位置匹配」`/<!--\s*SNAP:\d+\s*-->/g`；
  - `handleExport`/`handleExportDocx`/`handleExportPdf` 在**含章节标记时把未剥离的原文**交给 `mdToHtml`/`markdownToDocx`，由渲染器据标记把对应截图内嵌到章节前（图文混排），`.md/.txt/.xlsx` 仍剥离保持干净。

### 🟢 P1 — docx 导出与 HTML/PDF 不对等（主题 / 封面 / 目录，已补）
此前 docx 永远是朴素衬线纯文本，而 HTML/PDF 已有 5 套精致主题 + 封面 + 自动 TOC。本轮 `markdownDocx.ts`：
- 新增 `theme` 选项（复用 `DocThemeId`），按主题给封面与全部标题上强调色（modern 靛蓝 / elegant 暖棕 / magazine 珊瑚 / product 紫 / tech 青）；
- 新增**封面页**（强调色装饰条 + 大标题 + 副标题 + 日期）；
- 新增**自动目录**（标题 ≥4 时生成，与 HTML 自动 TOC 行为一致）；
- AIPanel 的 docx 导出同步传入 `theme` / `subtitle: goal` / `tocTitle`，补齐旗舰文档形态的最后一环。

### 🟢 P2 — AI 错误分类（401/429/5xx/上下文，对齐顶级项目，已补）
- 新增 `aiClient.classifyAiError(e)`（状态码 + 关键词双重判断，对齐 openclaw `classifyProviderRuntimeFailureKind`）；
- `aiStore` 生成 / 润色失败时按类别映射到友好文案：`错误密钥无效(401/403)` / `请求过于频繁(429)` / `服务端异常(5xx)` / `上下文超限(400/413/422)`，而非裸 401/500。

### 🟢 P3 — Anthropic 提示缓存（对齐 openclaw `anthropic-payload-policy`，已补）
`buildBody` 对 anthropic 请求把稳定的 `system` 与最后一条 user 消息打上 `cache_control: {type:'ephemeral'}`。多轮对话 / 记忆压缩 / 反复润色等重复调用复用缓存，**显著降低输入 token 成本与首字延迟**。

### 🧹 卫生
- 删除 5 个孤儿 i18n key（`ai.exportDocx/exportPdf/exportXlsx/outputEmpty/styleTitle`）；
- 每次生成 / 润色开始时清空 `usage` 状态，避免残留上次的 token/成本数字。

## 三、对照两份顶级项目的能力映射

| 能力 | claw-code-main | openclaw-main | 我们现状 |
|---|---|---|---|
| 流式 SSE 健壮解析 | `rust/crates/api/src/sse.rs:28-79` | `anthropic-transport-stream.ts:549-592` | ✅ Phase 13 已追平（帧切分 / 尾 flush / abort） |
| 退避重试 / 429 Retry-After | `anthropic.rs:401-464` | `retry.ts:69-137` | ✅ 已追平 |
| 上下文预算护栏 | `compact.rs` 裁最旧 | `compaction.ts` 增量摘要 | ✅ 已追平（裁最旧+非流式摘要） |
| **提示缓存** | `prompt_cache.rs` | `anthropic-payload-policy.ts:52-177` | 🟢 **本轮 P3 已补** |
| **错误分类** | `error.rs:164-240` | `provider-http-errors.ts` + `errors.ts:899-969` | 🟢 **本轮 P2 已补** |
| 记忆多因子 + MMR | 无 | `short-term-promotion.ts:1205` + `mmr.ts:152` | ✅ Phase 9 已多因子+MMR |
| 上下文增量压缩 | `compact.rs` 保最近 4 | `compaction.ts` 增量 previousSummary | ⚠️ 我们为非流式整体摘要，缺增量链 |
| **Agent 工具循环** | `conversation.rs:314-515 run_turn` | `tool-loop-detection.ts:498` + `runTurn` | 🔴 **未做 = 最大差距 = 最大卖点** |
| 会话 fork / 隔离 | `session.rs:62 fork` | `session-key.ts:30` | ⚠️ 仅前端按截图哈希分桶（桌面端足够） |

## 四、卖点挖掘与下一步路线图

**#1 胜负手（仍未做，需先确认工具契约）**：AI Agent 化——让模型直接调用标注工具
（`annotate_rect` / `highlight_text` / `redact_area` 隐私哨兵 / `read_region_ocr` / `summarize_selection`）。
竞品只产出文字，而我们是**截图工具**，让 AI 直接「操作截图」= 真正的差异化卖点。
参考 `claw-code run_turn`（迭代工具循环 + `max_iterations` 失控护栏）与 openclaw `detectToolCallLoop`（哈希级无进展检测）。
> ⚠️ 动手前需与用户确认「前端暴露给模型的标注操作工具契约」，避免盲目改码。

**次级增强（按优先级）**：
1. 上下文增量压缩（对齐 openclaw `previousSummary` 递进链 + 分层降级）；
2. 语义记忆（本地 embedding 检索，替代纯词法重叠）+ 项目级长期记忆；
3. 选区 / 划词 AI（选中截图区域即时问答 / 翻译）；
4. 后端代理隐藏 Key（需 Rust，安全性卖点）；
5. 会话 fork / 分支对话（对齐 claw-code `Session.fork`）；
6. 易用性：AI 面板快捷键（⌘K / ⌘⇧A）开合、错误态一键「重试」。

## 五、验证

- `npx tsc --noEmit` → 0 错误；`pnpm build` → exit0（136 模块）；
- 产物含新增 token：5 套主题色、`目录`、`cache_control`/`ephemeral`、4 个错误文案 key；孤儿 key 已从包中移除；
- 重启 App（`./start.sh dev` 或 `pnpm build && ./start.sh app`）即可见：图文报告 HTML/PDF/docx 分章内嵌截图；docx 带主题封面与目录；API 报错给出友好分类提示；Anthropic 请求自动命中提示缓存。
