# AI 助手 Phase 25 — Agent 工具集扩充：文字标注气泡（draw_callout）

> 续 Phase 24（draw_arrow）之后，继续 Phase 19 路线图的 P2「Agent 工具集扩充（callout/crop）」。
> 本轮落地 **callout（draw_callout 文字标注气泡）**；crop 因底图改写风险暂缓（见「范围界定」）。

## 需求
给「AI 智能编辑」加一个教程/说明类截图最常用的标注：**文字标注气泡**——从锚点（指向要说明的要素）拉一条引线到一个圆角气泡，气泡内显示说明文字。让 AI 能一句话在截图上生成「这里做什么 / 那是什么」的引导气泡，闭环「截图 → AI 标注 → 导出」。

## 设计要点
- **callout 是新标注类型**：`AnnotationGeometry.type` 联合加 `'callout'`；`points = [锚点, 气泡中心]`（两点）+ `text` + 文字样式（fontSize/fontFamily/bold/italic/align/bg/bgColor/bgOpacity/stroke），复用 `text` 标注既有字段，零新字段语义。
- **渲染走 Konva Group**：`renderShape` 新增 `case 'callout'`——引线 `<Line>` + 锚点 `<Circle>` + 圆角气泡 `<Rect>`（带底衬）+ `<Text>`。新增 `leaderHit()` 辅助函数算「从气泡中心指向锚点的射线与气泡边界交点」，引线停在气泡边缘、不穿入内部。
- **导出零改动**：callout 是 Konva 矢量，渲染在标注 Layer 上，`stage.toDataURL({pixelRatio:1/scale})` 合并导出**自动捕获**（与矩形/箭头/文字同路），不碰 `mergeToDataUrl` 的二次合成路径 → 零回归。
- **坐标铁律不变**：模型只给 0~1 归一化比例（锚点 `ax/ay`、气泡 `lx/ly`），宿主 `clamp01` 换原图像素 → 模型永不直接碰像素。
- **复用既有基建**：Phase 16 多形态解析（`draw_callout` 名称经合法名正则校验，国产模型 stream 也能跑）；Phase 20 `flashRegion` 在气泡区做脉冲高亮（AI 操作可视化）；与 draw_arrow/rect 同路经 `addAnnotation` 写入，**自动进撤销栈**，用户可一键撤销。
- **选中/拖动/缩放/删除**：callout 并入 `resizeHandles` 的「两端点手柄」分支（锚点 + 气泡中心），与 line/arrow 一致；拖动 Group 时 `handleDragEnd` 按位移量平移两点，无需新逻辑。

## 改动文件（7 个，纯前端，零 Rust，零新依赖）
1. `src/features/screenshot/types.ts` — 联合类型加 `'callout'`（1 行）。
2. `src/features/screenshot/components/AnnotationCanvas.tsx` — `leaderHit()` 辅助函数 + `renderShape` `case 'callout'` + 两端点手柄分支加 `'callout'`(~55 行)。
3. `src/features/ai/aiTools.ts` — `AiToolHost` 接口加 `drawCallout` + `AI_TOOL_DEFS` 加 `draw_callout` 定义 + `createToolExecutor` 加 `case` + `toolLabel` 加映射 + `agentSystem` 中英文案列出该工具(~40 行)。
4. `src/features/screenshot/EnhancedScreenshotApp.tsx` — `aiTools` 宿主加 `drawCallout`（~35 行，对齐 drawArrow）。
5. `src/features/screenshot/components/EditorWindow.tsx` — 同上（独立 webview 镜像，~35 行）。
6. `src/locales/zh-CN.json` — `agentTool.draw_callout: "文字标注气泡"`。
7. `src/locales/en-US.json` — `agentTool.draw_callout: "Callout bubble"`。

## 范围界定（本阶段故意不做，避免越界/风险）
- **不接画布手动工具栏**：callout 仅作 AI Agent 工具（路线图标的是「Agent 工具集扩充」）。手动工具栏入口需引入「两点点击」交互，属独立交互优化，留待后续。
- **不做 callout 文字内联编辑**：双击编辑现有逻辑会把标注转成 `text` 类型（丢 callout 结构）。用户可删除后由 AI 重加。留作后续小优化。
- **crop 工具暂缓**：AI `crop_region` 需改写底图，与「AI 编辑走 addAnnotation、永不改底图」铁律冲突，且涉及导出裁剪链路改动，风险高 → 不在「纯增量」范围内，单独评估。

## 验证
- `npx tsc --noEmit` → **0 错误**
- `pnpm build` → **exit 0，140 模块**（比 Phase 24 同规模，增量约 ~70 行）
- `scripts/test-tool-call-parser.mjs` → **50/50 绿**（零回归，`draw_callout` 名称经正则校验合法）
- `scripts/test-zip.mjs` → **7/7 绿**
- dist 含 `draw_callout` / `文字标注气泡` / `Callout bubble` / `case"callout":` / `drawCallout`（13 处 `callout` 字面量）

## 路线图剩余（按 ROI）
- 🔥P0-γ 后端代理隐藏 Key（需 Rust，零 Rust 约束外 → 单独评估）
- 🟠P1 ①本地语义记忆（transformers.js + MiniLM 量化）②docx 高级排版
- 🟡P2 ①选区/划词 AI（OCR 文本→标注）②批量 Agent 队列 ③Agent 工具集扩充(剩余 crop) ④PPT 导出
