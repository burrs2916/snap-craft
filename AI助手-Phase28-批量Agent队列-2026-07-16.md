# AI 助手 Phase 28 — P2 批量 Agent 队列

> 日期：2026-07-16 ｜ 栈：React 18 + TS + Vite + Tauri 2 ｜ 约束：零 Rust、零新依赖、增量优先、诊断优先

## 1. 路线图筛选（先排除不可行项）
- **P0-γ 后端代理隐藏 Key** → 需 Rust，违反「零 Rust」铁律，排除。
- **P1 本地语义记忆（transformers.js）** → 需引入新依赖，违反「零新依赖」铁律，排除（除非你特批放宽）。
- **P2 crop** → 需改写底图，违反「永不改底图」铁律，排除。
- **P2 缩略图回传 History** → 已在 Phase 19（B5）随来源截图导出解决，排除。
- ✅ **P2 批量 Agent 队列** → 纯前端、零 Rust、零新依赖，落地本阶段。

## 2. 改动清单
### 2.1 `EnhancedScreenshotApp.tsx`
- **复用既有选择机制**：直接复用 `selIds`（历史多选复选框，批量取字 `handleBatchOcr` 已用）与 `history.find(id).dataUrl` 取图 —— 不新建选择 UI。
- **新增 `handleBatchAi`**：
  - 对每张选中截图**顺序**调用 `chatOnce({ config, messages: [{role:'system'},{role:'user', imageDataUrl}] })`。
  - 关键设计：用 `chatOnce`（底层**一次性非流式**调用），**不触碰共享 AI 会话状态** → 批量与单图对话零互相干扰（对比 `aiStore.generate/runAgent` 会改写共享 status/output/会话，不适合循环）。
  - 汇总 `AiBatchItem[] = { id, time, text, error? }`；进度 `aiBatchDone / aiBatchTotal` 实时反馈。
  - 前置校验：无指令 → `flash(请先输入指令)`；无 API Key → `flash(请先配置 Key)`。
  - 失败项单独记 `error` 且红底展示，整体 `flash` 汇总「成功 N / 失败 M」，不中断队列。
  - 配置读取 `useAiStore.getState().config`（用户已在 AI 设置配好的 Key/模型），批量复用同一模型。
- **UI**：
  - 批量栏加「批量 AI」按钮（`batch-btn accent`）→ 开 `showAiBatch` 弹窗。
  - 弹窗内：指令 textarea + 「运行批量 AI」按钮 + 进度条文字 + 结果卡片（可编辑/复制）+ 操作行：**复制全部 / 导出 Markdown / 导出 Word / 关闭**。
  - 导出复用成熟链路：Markdown→`save_text_file`；Word→`markdownToDocx(...)` + `save_binary_file`（零新后端）。
  - 导入 `chatOnce` / `markdownToDocx` / `useAiStore`（沿用既有 `../ai/*` import 模式）。

### 2.2 `src/index.css`
- `.batch-btn.accent`（accent 描边强调色）、`.ai-batch-prompt-row` / `.ai-batch-prompt` / `.ai-batch-progress` / `.batch-card-err`（失败红底）。

### 2.3 `zh-CN.json` / `en-US.json`
- 14 键：`batchAi` / `batchAiTitle` / `batchAiRun` / `batchAiBusy` / `batchAiRunning` / `batchAiEmpty2` / `batchAiPrompt` / `batchAiPromptNeeded` / `batchAiNoKey` / `batchAiProgress` / `batchAiDone` / `batchAiEmpty` / `batchAiError` / `batchAiExportMd` / `batchAiExportDocx`。

## 3. 关键设计决策
- **批量并发安全**：选 `chatOnce` 而非 `aiStore.generate/runAgent`，避免循环改写共享会话/UI 状态导致批量与单图对话互相污染 —— 这是「纯增量、零回归」的核心。
- **零配置 UI 重复**：复用 AI 设置里已配的 Key/模型，批量不另造配置入口。
- **与批量取字视觉一致**：同款 modal/card 结构，交互连贯；导出链路与 AI 面板同源。
- **失败不中断**：单项错误红底保留、整体汇总，符合「批量任务」预期。

## 4. 验证（全绿）
- `npx tsc --noEmit` → 0 错
- `pnpm build` → **exit 0，140 模块（4.29s）**
- `dist` 含新 token：`批量 AI`·`运行批量 AI`·`已完成 `·`导出 Word`·`请先在 AI 设置` + `.ai-batch-prompt-row`·`.ai-batch-progress`·`.batch-card-err`·`.batch-btn.accent`

## 5. 用户可感知流程
1. 历史面板进入「多选」模式，勾选若干截图。
2. 点「批量 AI」→ 弹窗输入指令（如「提取这张截图里的所有按钮文案并翻译成中文」）。
3. 点「运行批量 AI」→ 逐张带图调用模型，进度 `3/8` 实时显示。
4. 每张结果成卡片（可改/可复制），一键「复制全部 / 导出 Markdown / 导出 Word」汇总成稿。

## 6. 路线图剩余
P0-γ 后端代理隐藏 Key（需 Rust）｜ P1 本地语义记忆（需新依赖，待你放宽铁律）｜ P2 PPT 导出（可手搓 OOXML 零依赖但体量大）｜ 缩略图回传 History（已 B5 解决）。
