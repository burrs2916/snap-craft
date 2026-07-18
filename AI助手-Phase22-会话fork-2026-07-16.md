# AI 助手 Phase 22 — P1 会话 fork（分支探索）

> 时间：2026-07-16 | 延续 Phase 19/20/21 路线图 | 纯前端、零 Rust、零新依赖

## 需求来源
Phase 19 路线图 P1：「会话 fork」。多轮 AI 对话里，用户常想**从某一轮换一种写法 / 换一个方向继续**，但又不舍得丢掉已生成的好版本。原架构是「每个截图一份线程」（`convHash(imageDataUrl)` 单键），fork 让同一条对话能被复制成独立分支，互不破坏。

## 实施（复用现有存储与加载路径，增量最小）

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/features/ai/aiStore.ts` | `AiConvMeta` 加 `parent?: string`；接口声明 `forkConversation`；实现 `forkConversation(sourceHash, uptoIndex?)` | 切片复制 → `源hash::fork-<rand>` 新键落盘 → `recordConvMeta` 登记 → 回写 `parent` 标记 + 复用源缩略图；返回新 hash |
| `src/features/ai/AIPanel.tsx` | 解构 `forkConversation`；阅读器头部「🍴 复制为新分支」；每条 AI 消息「🍴 从此分支」；列表卡片 `parent` 时显示「🍴 分支」徽标 | 复用既有 `loadConvIntoPanel(hash)`（= `setConvKey(hash)`），fork 后一键载入继续追问 |
| `src/locales/zh-CN.json` / `en-US.json` | 新增 `historyFork`/`historyForkTitle`/`historyForked`/`historyForkFrom`/`historyForkFromTitle`/`historyForkBadge`/`forkSuffix` | 中英双语 |
| `src/index.css` | `.ai-hist-fork-badge`（琥珀色）/ `.ai-msg-fork`（hover 填充） | 视觉区分 |

## 两种分支粒度
1. **整条复制**（阅读器头部按钮）：复制全线程为新分支 → 载入后从末尾继续，原线程不动。
2. **从某轮截断**（每条 AI 回复下的「从此分支」）：`forkConversation(hash, i)` 只保留前 `i+1` 轮 → 从该 AI 回复处另起炉灶，探索不同走向。

## 关键技术决策
- **不改造核心线程模型**：fork 只是「复制 + 新键 + 载入」，完全复用 Phase 4 的 `convHash` 落盘与 Phase 11 的 `loadConvIntoPanel`。原线程零风险。
- **新键派生**：`源hash::fork-<rand>`，永不与原键/其他 fork 碰撞；`loadConversation`/`saveConversation` 对键字符串无格式假设，直接可用。
- **缩略图复用**：fork 脱离实时截图，`recordConvMeta` 内部 `downscaleThumb(undefined)` 拿不到图；fork 后手动把源 `thumb` 写回索引项，避免分支卡片无图。
- **`parent` 标记**：历史列表卡片显示「🍴 分支」徽标，用户一眼区分原线程与衍生分支。

## 验证
- `tsc --noEmit` → **0 错**
- `pnpm build` → **exit 0（1.89s，139 模块）**
- `test-tool-call-parser.mjs` → **50/50 绿**
- 两 i18n JSON → 合法

## 路线图进度
- ✅ P0-α AI 操作可视化（Phase 20）
- ✅ P0-β 隐私哨兵 Agent（Phase 21）
- ✅ P1 会话 fork（Phase 22，本阶段）
- ⬜ P0-γ 后端代理隐藏 Key（需 Rust）
- ⬜ P1 本地语义记忆 / docx 高级排版 / 会话打包 zip
- ⬜ P2 选区划词 AI / 批量 Agent 队列 / 工具集扩充 / PPT 导出

## AI 卖点四件套（仍成立）
1. AI 直接改图（Phase 14）2. 编辑后图即上下文（Phase 8/10）3. 长程不丢上下文（Phase 6+15）4. 全模型通用（Phase 16）
会话 fork 让「多轮探索」从线性变树状——对需要反复打磨文案 / 对比多种成稿的 B 端用户是实打实的生产力提升。
