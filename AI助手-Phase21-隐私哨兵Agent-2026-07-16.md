# AI 助手 Phase 21 — P0-β 隐私哨兵 Agent（一键打码）

> 时间：2026-07-16 | 延续 Phase 19/20 路线图 | 纯前端、零 Rust、零新依赖

## 需求来源
Phase 19 路线图 P0-β：截图工具在分享/交付前，最痛的是**敏感信息泄露**（手机号、邮箱、证件号、银行卡、密码、API Key、地址、真实姓名、金额）。金融/医疗/法务 B 端用户的**付费刚需**——把"手动逐个打码"变成"AI 一键扫描全图打码 + 残留风险报告"。

## 实施（复用现有架构，增量最小）
完全建立在 Phase 14（Agent 工具循环）+ Phase 8/10（编辑后图即视觉上下文）+ Phase 20（画布脉冲可视化）之上：

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/features/ai/aiTools.ts` | 新增 `agentSystemSentinel()` | 隐私哨兵专用系统提示词（中/英）。约束模型**只调用 `redact_area`**，枚举必须打码的类型，给出"打码清单 + 残留风险"报告格式，并复用 Phase 16 的多形态工具调用兜底契约（JSON 围栏/XML/Bracketed/ReAct）——**国产模型 stream 模式也能跑** |
| `src/features/ai/aiStore.ts` | `GenerateInput.agentKind?: 'edit'\|'sentinel'`；`runAgent` 按 `agentKind` 切换 `agentSystem()` / `agentSystemSentinel()` | 一行分支切换，不复制任何逻辑 |
| `src/features/ai/AIPanel.tsx` | 新增 `sentinelMode` 状态（与 `agentMode` 互斥）；新增「🔒 隐私哨兵」芯片 + 运行按钮标签/行为切换；`handleAgentRun` 传 `agentKind` 并支持**空目标默认指令**；输入框 placeholder 随模式变化 | 零回归：非哨兵模式完全走原路径 |
| `src/locales/zh-CN.json` / `en-US.json` | 新增 `sentinelMode`/`sentinelModeDesc`/`sentinelRun`/`sentinelDefaultGoal`/`sentinelGoalPh`/`agentGoalPh` | 中英双语 |
| `src/index.css` | `.ai-chip-sentinel.active` 红橙渐变（区别于智能编辑的蓝紫） | 视觉区分 |

## 用户可感知流程
1. 面板里点「🔒 隐私哨兵」（红色高亮芯片）
2. 目标框留空直接点「🔒 一键打码」，或写"只打码右上角的金额和姓名"
3. AI 看到当前**编辑后截图**（已合层、已打码区也参与上下文），调用 `redact_area` 逐个涂黑敏感区
4. **画布上每处打码先亮红色脉冲**（Phase 20 的 `flashRegion`），1.4s 淡出，正式打码同时落定——AI 每步"看得见"
5. 右栏流式输出打码清单 + 残留风险提示

## 关键技术决策
- **不新建 Agent 模式，只派生系统提示词**：Agent 工具循环、记忆注入、压缩链、多形态解析全部复用，维护成本为 0
- **强制携带视觉上下文**（`runAgent` 内部已 `images=[imageDataUrl]`），不受预设 `vision` 开关影响 → 哨兵永远看得到图
- **哨兵只暴露 `redact_area` 语义约束**（提示词层），不限制工具定义本身 → 工具循环代码零改动，靠 prompt 约束行为
- **与 Phase 20 脉冲天然联动**：`redactArea` 已调 `flashRegion`，哨兵打码自动带红色脉冲

## 验证
- `tsc --noEmit` → **0 错**
- `pnpm build` → **exit 0（1.99s，139 模块）**
- `test-tool-call-parser.mjs` → **50/50 绿**（Phase 16 多形态解析无回归）
- `zh-CN.json` / `en-US.json` → JSON 合法

## 路线图进度
- ✅ P0-α AI 操作过程可视化（Phase 20）
- ✅ P0-β 隐私哨兵 Agent（Phase 21，本阶段）
- ⬜ P0-γ 后端代理隐藏 Key（需 Rust，企业版）
- ⬜ P1 本地语义记忆 / 会话 fork / docx 高级排版 / 会话打包 zip
- ⬜ P2 选区划词 AI / 批量 Agent 队列 / 工具集扩充 / PPT 导出

## AI 卖点四件套（仍成立）
1. AI 直接改图（Phase 14）
2. 编辑后图即上下文（Phase 8/10 隐私闭环）
3. 长程不丢上下文（Phase 6+15 增量压缩链）
4. 全模型通用（Phase 16 多形态解析）

**隐私哨兵 = 卖点②（隐私闭环）的"主动防御"形态**，把"编辑后图才打码"升级成"AI 主动发现并打码"，对 B 端合规场景是差异化杀手锏。
