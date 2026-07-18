# AI 助手 Phase 24 — P2 工具集扩充：draw_arrow（AI 画箭头）

> 接 Phase 23，继续路线图 P2 工具集扩充。给 AI 智能编辑新增「画箭头」能力——AI 不再只会画框/打码/高亮，还能**用一个箭头指向重点位置并贴标签**，和 Phase 20 画布脉冲联动，演示效果更"会画"。

## 背景
AI 智能编辑当前 4 个工具（draw_rectangle / redact_area / highlight_text / summarize_region）覆盖了"圈区域"，但缺少**引导视线**的箭头。箭头是截图标注最高频的动作之一（指"看这里""这是原因"）。调研发现标注模型 `AnnotationGeometry` 早已支持 `arrow` 类型、canvas 也早已渲染 `<Arrow>`——只是 AI 工具契约层没暴露它。所以本次是**低侵入的能力补齐**，不是新功能从零造。

## 实施（3 改 + 2 宿主实现 + 2 i18n 键，零 Rust）
1. **`src/features/ai/aiTools.ts`**
   - 新增 `NormPoint` 接口（`{x,y}` 归一化点）
   - `AiToolHost` 加 `drawArrow(from, to, opts?: {color?, label?})`
   - `AI_TOOL_DEFS` 加 `draw_arrow` 定义（fromX/fromY/toX/toY + color/label）
   - `createToolExecutor` 加 `draw_arrow` 分支（from/to 各自 `clamp01` 防御越界）
   - `toolLabel` 映射加 `draw_arrow → ai.agentTool.draw_arrow`
   - `agentSystem()` 中英提示词列出 `draw_arrow`（让模型知道可用）
2. **`EnhancedScreenshotApp.tsx` + `EditorWindow.tsx`** —— 两编辑器 `aiTools` 宿主实现 `drawArrow`：
   - from/to 归一化点 × 原图尺寸换算像素 → `addAnnotation({ geometry: { type: 'arrow', points: [from, to] } })`
   - 若带 `label`，在箭头末端追加一个带底衬的文字标注（复用 drawRectangle 的 label 写法）
   - 画布脉冲：外接框 + 青色（`#0a84ff`）+ `kind: 'arrow'`
   - 走既有 `addAnnotation` → 自动进撤销栈，用户可一键撤销
3. **`AnnotationCanvas.tsx`** —— `flashRegion` 的 `kind` 联合类型扩展 `'arrow'`，并加 arrow 配色分支（`#0a84ff` 半透明填充）
4. **`locales`** —— `agentTool.draw_arrow`（中英）

## 关键技术决策
- **零新增渲染代码**：箭头几何与渲染早就存在，本次只在"契约层 + 宿主实现"打通，维护成本趋零
- **坐标约定一致**：沿用 Phase 14 的"模型只给 0~1 归一化比例、宿主换算像素"铁律，from/to 各 `clamp01` 防御越界（与 RECT 同口径）
- **工具循环零改**：`parseShapedToolCalls`（Phase 16 多形态解析）对工具名完全泛型，`draw_arrow` 的 JSON/XML/Bracketed/ReAct 形态自动支持 → **国产模型 stream 模式也能画箭头**
- **隐私哨兵不受影响**：`agentSystemSentinel` 仍只约束 `redact_area`，`draw_arrow` 不污染哨兵行为

## 验证
- `tsc --noEmit` → **0 错**
- `pnpm build` → **exit 0（2.00s，139 模块）**
- `test-tool-call-parser.mjs` → **50/50 绿**（Phase 16 多形态解析无回归）
- `test-zip.mjs` → **7/7 绿**
- 两 i18n JSON → **合法**

## 用户可感知效果
开「🤖 智能编辑」→ 让 AI"用一个箭头指向报错位置并标注原因" → AI 调用 `draw_arrow`，画布上对应箭头先亮**青色脉冲**再落定 + 末端贴标签；右栏 Agent 步骤时间线显示"画箭头"。

## 路线图进度
- ✅ P0-α 操作可视化 / ✅ P0-β 隐私哨兵 / ✅ P1 fork / ✅ P1 打包 zip / ✅ P2 工具扩充 arrow
- ⬜ P0-γ 后端代理隐藏 Key（需 Rust，违反 AI 模块零 Rust 约束，单独评估）
- ⬜ P1 本地语义记忆 / docx 高级排版
- ⬜ P2 选区划词 / 批量 Agent 队列 / 工具集扩充(callout/crop) / PPT 导出
