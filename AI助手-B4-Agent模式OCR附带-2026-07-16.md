# AI 助手 B4 — Agent 模式 attachImage/attachOcr UX 路径修复

> 日期：2026-07-16 ｜ 类型：Bug 修复（低优先收尾）｜ 约束：纯前端 / 零 Rust / 零新依赖 / 增量

## 1. 问题根因（诊断优先）

路线图在「零 Rust / 零新依赖」铁律下的正式功能（Phase 19–29）已全部交付。剩余仅低优先 bug 收尾，**B4 是铁律内最后一个**：

- `runAgent`（`src/features/ai/aiStore.ts`）虽然从 store 读取了 `attachImage` / `attachOcr` 两个开关，但**两者都没真正用**：
  - 截图被 **强制** 携带（`images = [input.imageDataUrl, ...]`，注释说明坐标编辑必须看图）→ `attachImage` 开关形同虚设；
  - **OCR 文本被直接丢弃** → `attachOcr` 开关完全无效，模型在 Agent 模式下拿不到截图文字。
- 对照：普通模式 `chat` 首轮（L638-639）正确用 `attachOcr` 把 OCR 注入 `buildUser`，行为一致性的缺口只在 Agent 模式。
- 类型层面无碍：`RunAgentInput = GenerateInput & { host }` 已含 `ocrText` / `ocrTexts`，`handleAgentRun` 也已把 `ocrText` 传入（AIPanel.tsx:619），只是 `runAgent` 没收。

## 2. 修复方案（增量、不破任何既有逻辑）

### 2.1 `runAgent` 尊重 `attachOcr`（aiStore.ts）
- 当 `attachOcr === true` 且存在 OCR（`input.ocrText` 或 `input.ocrTexts`）时，把 OCR 文字注入用户消息：
  ```
  `${goal}\n\n[截图文字内容 / OCR]\n${ocrBody}`
  ```
  `ocrBody` 优先用 `ocrTexts.join('\n\n')`，否则用 `ocrText`——与 `chat` 首轮一致。
- `attachImage` 在 Agent 模式**保持强制带图**（坐标编辑圈选/打码/高亮必须看图，设计上不可关），仅补注释说明开关在此模式恒为 true。

### 2.2 AIPanel 上下文选项 UX 对齐（AIPanel.tsx）
- **Agent / 隐私哨兵模式**下：
  - `attachImage` → 显示为 **勾选 + 禁用**，标题改为 `attachImageAgentTitle`（说明「必须看图才能按坐标编辑，已自动附带，不可关闭」），消除「勾了没用」的误导。
  - `attachOcr` → 保持为**真实生效**的开关（有 OCR 时可开/关）。
- 普通模式行为完全不变。

### 2.3 i18n
- zh-CN / en-US 新增 `attachImageAgentTitle`。

## 3. 验证（与 Phase 27–29 同一标准）

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | ✅ 0 错 |
| `pnpm build` | ✅ exit 0（141 模块，1.90s） |
| `dist` 含 `attachImageAgentTitle` | ✅ ×4 |
| `dist` 含 `已自动附带当前截图` | ✅ ×1 |
| `dist` 含 `截图文字内容 / OCR`（OCR 注入标记） | ✅ ×1 |
| 普通模式 `chat` / 导出链路 | ✅ 未改动，零回归 |

## 4. 影响范围与边界

- **影响**：Agent / 隐私哨兵模式现在能利用截图文字（按文字定位、翻译、提取、文档产出更准）；UX 上开关状态与真实行为一致。
- **边界（非缺陷）**：Agent 模式截图强制携带为既有设计（坐标编辑必需），本次仅让 UI 诚实呈现、未引入可关开关——符合「坐标编辑必须看图」的铁约束。

## 5. 状态

- B4 修复完成 → **B1–B6 全部收尾**。
- 路线图在「零 Rust / 零新依赖」铁律下已无剩余可交付项。后续推进只能放宽某条铁律：
  - 🔥 P0-γ 后端代理隐藏 Key（需 Rust）
  - 🟠 P1 本地语义记忆（需 transformers.js 新依赖，需你特批放宽「零新依赖」）
