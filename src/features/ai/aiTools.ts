// AI Agent 工具契约（Phase 14，对齐 claw-code run_turn / openclaw 工具循环）
//
// 设计要点：
//  - 工具定义（AI_TOOL_DEFS）对 OpenAI 兼容 / Anthropic 透明，由 aiClient.buildBody
//    在发送时转换为各自 provider 的 tools 格式；
//  - 模型给出的区域坐标一律是 0~1 的「相对整图比例」(左上角 0,0)，由宿主侧（编辑器）
//    换算为原图像素——与现有标注坐标体系（natural pixel）保持一致；
//  - 真正的「副作用」（改画布、跑 OCR）全部由宿主侧 AiToolHost 实现，aiClient 的工具
//    循环只负责「调度 + 回传结果」，保持纯前端、零 Rust、零破坏性。

import { getLang } from '../../i18n';
import type { AiToolDef } from './aiTypes';
import { clamp01, type NormRect, type NormPoint } from '../../shared/geometry';

// 向后兼容：此前 NormRect / NormPoint 定义在本文件，外部消费者仍可从 aiTools 导入
export type { NormRect, NormPoint } from '../../shared/geometry';

/**
 * 宿主侧（编辑器）实现的工具宿主：AI 工具执行器通过它真实修改截图。
 * 编辑器用既有 useScreenshotStore.addAnnotation 写入标注，与用户手动标注同路，
 * 自动进入撤销历史——不引入新的画布交互层。
 */
export interface AiToolHost {
  /** 当前截图原图像素尺寸；取不到时返回 null（工具将拒绝执行） */
  getImageSize: () => { width: number; height: number } | null;
  /** 画矩形标注；返回人类可读的坐标描述（用于回传给模型 / UI） */
  drawRectangle: (rect: NormRect, opts?: { color?: string; label?: string }) => string;
  /** 打码：blur=高斯模糊 / mosaic=马赛克 / black=涂黑；返回坐标描述 */
  redactArea: (rect: NormRect, mode: 'blur' | 'mosaic' | 'black', strength?: number) => string;
  /** 高亮文字/区域（半透明色块）；返回坐标描述 */
  highlightRect: (rect: NormRect, color?: string) => string;
  /** 画箭头：从 from 指向 to（均为 0~1 归一化点）；可选标签文字画在箭头末端；返回坐标描述 */
  drawArrow: (from: NormPoint, to: NormPoint, opts?: { color?: string; label?: string }) => string;
  /** 文字标注气泡：anchor 为引线指向的锚点、label 为气泡中心（均为 0~1 归一化点）；可选说明文字与颜色；返回坐标描述 */
  drawCallout: (anchor: NormPoint, label: NormPoint, opts?: { color?: string; text?: string }) => string;
  /** 识别指定区域文字（裁剪后走 OCR）；返回识别文本 */
  summarizeRegion: (rect: NormRect) => Promise<string>;
}

// 区域四点的共享 JSON Schema 片段
const RECT_PROPS = {
  x: { type: 'number', description: '区域左上角 X，取值范围 0~1（相对整张图片宽度）' },
  y: { type: 'number', description: '区域左上角 Y，取值范围 0~1（相对整张图片高度）' },
  w: { type: 'number', description: '区域宽度，取值范围 0~1' },
  h: { type: 'number', description: '区域高度，取值范围 0~1' },
};

/** 工具契约：AI 可直接调用的四类截图操作（截图工具独有价值） */
export const AI_TOOL_DEFS: AiToolDef[] = [
  {
    name: 'draw_rectangle',
    description: '在当前截图上用矩形框标注一个区域（可选附带文字标签，画在框上方）。',
    inputSchema: {
      type: 'object',
      properties: {
        x: RECT_PROPS.x,
        y: RECT_PROPS.y,
        w: RECT_PROPS.w,
        h: RECT_PROPS.h,
        color: { type: 'string', description: '边框颜色，十六进制，如 #ff3b30' },
        label: { type: 'string', description: '可选的标签文字，会画在矩形框上方' },
      },
      required: ['x', 'y', 'w', 'h'],
    },
  },
  {
    name: 'redact_area',
    description: '对截图上的敏感区域打码：模糊(blur) / 马赛克(mosaic) / 涂黑(black)。',
    inputSchema: {
      type: 'object',
      properties: {
        x: RECT_PROPS.x,
        y: RECT_PROPS.y,
        w: RECT_PROPS.w,
        h: RECT_PROPS.h,
        mode: { type: 'string', enum: ['blur', 'mosaic', 'black'], description: '打码方式，默认 mosaic（马赛克）' },
        strength: { type: 'number', description: '强度 1~20（模糊半径 / 马赛克块大小），默认 12' },
      },
      required: ['x', 'y', 'w', 'h'],
    },
  },
  {
    name: 'highlight_text',
    description: '高亮截图上的一段文字或区域（半透明色块覆盖），便于读者聚焦。',
    inputSchema: {
      type: 'object',
      properties: {
        x: RECT_PROPS.x,
        y: RECT_PROPS.y,
        w: RECT_PROPS.w,
        h: RECT_PROPS.h,
        color: { type: 'string', description: '高亮颜色，十六进制，默认 #FFE600' },
      },
      required: ['x', 'y', 'w', 'h'],
    },
  },
  {
    name: 'draw_arrow',
    description: '在当前截图上画一个箭头，从一个点指向另一个点（用于引导视线、标注重点位置）；可选在箭头末端加标签文字。',
    inputSchema: {
      type: 'object',
      properties: {
        fromX: { type: 'number', description: '箭头起点 X，取值范围 0~1（相对整张图片宽度）' },
        fromY: { type: 'number', description: '箭头起点 Y，取值范围 0~1（相对整张图片高度）' },
        toX: { type: 'number', description: '箭头终点 X，取值范围 0~1' },
        toY: { type: 'number', description: '箭头终点 Y，取值范围 0~1' },
        color: { type: 'string', description: '箭头与标签颜色，十六进制，如 #34c759' },
        label: { type: 'string', description: '可选标签文字，画在箭头末端' },
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
    },
  },
  {
    name: 'draw_callout',
    description: '在截图上添加一个「文字标注气泡」：从锚点（指向要说明的位置）拉一条引线到一个气泡，气泡内显示说明文字。用于教程/说明类截图标注重点要素。',
    inputSchema: {
      type: 'object',
      properties: {
        ax: { type: 'number', description: '锚点 X（引线指向的位置），取值范围 0~1（相对整张图片宽度）' },
        ay: { type: 'number', description: '锚点 Y，取值范围 0~1（相对整张图片高度）' },
        lx: { type: 'number', description: '气泡中心 X，取值范围 0~1（通常放在锚点旁边的留白处）' },
        ly: { type: 'number', description: '气泡中心 Y，取值范围 0~1' },
        text: { type: 'string', description: '气泡内显示的说明文字' },
        color: { type: 'string', description: '引线/气泡边框/文字颜色，十六进制，如 #0a84ff' },
      },
      required: ['ax', 'ay', 'lx', 'ly', 'text'],
    },
  },
  {
    name: 'summarize_region',
    description: '识别截图上指定区域内的文字（OCR），返回识别结果，供后续分析/文档引用。',
    inputSchema: {
      type: 'object',
      properties: {
        x: RECT_PROPS.x,
        y: RECT_PROPS.y,
        w: RECT_PROPS.w,
        h: RECT_PROPS.h,
      },
      required: ['x', 'y', 'w', 'h'],
    },
  },
];

/**
 * 把模型给出的工具调用派发到宿主侧执行，封装为「工具循环」可用的 executor。
 * 所有区域参数先钳制到 [0,1] 再交给宿主（防御越界 / 注入破坏画布）。
 */
export function createToolExecutor(host: AiToolHost) {
  return async (
    name: string,
    args: Record<string, any>,
  ): Promise<{ content: string; isError?: boolean }> => {
    // 兼容扁平 {x,y,w,h} 与隐私哨兵 prompt 误用的嵌套 {r:{x,y,w,h}}（防御层，避免打码坐标塌成 0）
    const rr = (args && typeof args.r === 'object' && args.r) ? args.r : {};
    const r: NormRect = {
      x: clamp01(args.x ?? rr.x),
      y: clamp01(args.y ?? rr.y),
      w: clamp01(args.w ?? rr.w),
      h: clamp01(args.h ?? rr.h),
    };
    try {
      switch (name) {
        case 'draw_rectangle':
          return {
            content: `已绘制矩形标注：${host.drawRectangle(r, { color: args.color, label: args.label })}`,
          };
        case 'redact_area': {
          const mode: 'blur' | 'mosaic' | 'black' =
            args.mode === 'blur' || args.mode === 'black' ? args.mode : 'mosaic';
          return { content: `已对区域打码（${mode}）：${host.redactArea(r, mode, args.strength)}` };
        }
        case 'highlight_text':
          return { content: `已高亮区域：${host.highlightRect(r, args.color)}` };
        case 'draw_arrow': {
          const from: NormPoint = { x: clamp01(args.fromX), y: clamp01(args.fromY) };
          const to: NormPoint = { x: clamp01(args.toX), y: clamp01(args.toY) };
          return { content: `已绘制箭头：${host.drawArrow(from, to, { color: args.color, label: args.label })}` };
        }
        case 'draw_callout': {
          const anchor: NormPoint = { x: clamp01(args.ax), y: clamp01(args.ay) };
          const label: NormPoint = { x: clamp01(args.lx), y: clamp01(args.ly) };
          return { content: `已添加文字标注气泡：${host.drawCallout(anchor, label, { color: args.color, text: args.text })}` };
        }
        case 'summarize_region': {
          const txt = await host.summarizeRegion(r);
          return { content: `该区域识别文字如下：\n${txt}` };
        }
        default:
          return { content: `未知工具：${name}`, isError: true };
      }
    } catch (e: any) {
      return { content: `工具执行失败：${e?.message ?? e}`, isError: true };
    }
  };
}

/** 工具名 → 友好标签（用于 Agent 步骤 UI；与 i18n key 对齐） */
export function toolLabel(name: string): string {
  const map: Record<string, string> = {
    draw_rectangle: 'ai.agentTool.draw_rectangle',
    redact_area: 'ai.agentTool.redact_area',
    highlight_text: 'ai.agentTool.highlight_text',
    draw_arrow: 'ai.agentTool.draw_arrow',
    draw_callout: 'ai.agentTool.draw_callout',
    summarize_region: 'ai.agentTool.summarize_region',
  };
  return map[name] ?? name;
}

/** AI Agent 模式专用系统指令（语言自适应）：告知模型可用工具与坐标约定 */
export function agentSystem(): string {
  const zh = getLang() === 'zh-CN';
  return zh
    ? '你是 SnapCraft 截图助手的「AI 智能编辑」引擎。你可以直接调用工具来修改当前正在编辑的截图：用 draw_rectangle 画矩形标注并可选加标签、用 draw_arrow 画箭头从一个点指向另一个点（引导视线/标注重点）、用 draw_callout 在图上添加「文字标注气泡」（锚点指向要说明的位置、气泡显示说明文字）、用 redact_area 对敏感区域打码（模糊/马赛克/涂黑）、用 highlight_text 高亮重点文字区域、用 summarize_region 识别某区域的文字。所有坐标均为 0~1 的相对比例（相对于整张图片，左上角为 0,0；x 向右、y 向下）。\n\n【工具调用方式】优先使用模型原生 tool_calls 字段（最稳）。若你所在的接口在流式输出时不原生支持 tool_calls（部分国产 LLM 的 OpenAI 兼容接口在 stream 模式只输出文本），可改用以下「文本兜底」契约之一在回复里表达工具调用：\n  ① JSON 围栏：\\`\\`\\`json\\n{"name":"工具名","arguments":{...}}\\n\\`\\`\\`\n  ② XML 风格：<tool_call name="工具名">{...}</tool_call>\n  ③ Bracketed：[工具名]{...}[/END_TOOL_REQUEST]\n  ④ ReAct：Action: 工具名\\nAction Input: {...}\n  上述任一形态宿主都会自动识别并执行。\n\n在调用工具完成编辑后，用中文输出一段简洁说明：你做了哪些编辑、为什么这么做；如果用户还附带了文档/文案要求，则继续产出对应内容。若用户只要求编辑而不要求文档，则仅说明编辑结果即可。'
    : 'You are the "AI Smart Edit" engine of the SnapCraft screenshot assistant. You can directly call tools to modify the screenshot currently being edited: draw_rectangle to outline an area (with an optional label), draw_arrow to draw an arrow from one point to another (guide the eye / point at a key spot), draw_callout to add a text callout bubble (an anchor pointing at the spot, a bubble showing the explanation), redact_area to mask sensitive regions (blur/mosaic/black), highlight_text to highlight key text, and summarize_region to OCR a region. All coordinates are 0~1 relative ratios (relative to the whole image; top-left is 0,0; x grows right, y grows down).\n\n[Tool calling] Prefer the model\'s native `tool_calls` field (most reliable). If your endpoint doesn\'t emit `tool_calls` in streaming mode (some domestic LLMs in OpenAI-compatible stream mode only output text), you can fall back to one of these text contracts:\n  ① JSON fenced: \\`\\`\\`json\\n{"name":"tool","arguments":{...}}\\n\\`\\`\\`\n  ② XML: <tool_call name="tool">{...}</tool_call>\n  ③ Bracketed: [tool]{...}[/END_TOOL_REQUEST]\n  ④ ReAct: Action: tool\\nAction Input: {...}\n  Any of the above will be auto-detected and executed by the host.\n\nAfter using tools to finish editing, output a concise explanation in the user\'s language: what you edited and why; if the user also asked for a document/copy, continue producing it. If the user only asked for editing, just describe the edits.';
}

/**
 * 「隐私哨兵」专用系统提示词：复用同一套工具循环，但目标被约束为
 * 全图敏感信息扫描 + 打码。区别于通用智能编辑：模型必须只调用 redact_area，
 * 不画图框/高亮，最后用中文给出「已打码清单 + 残留风险」报告。
 */
export function agentSystemSentinel(): string {
  const zh = getLang() === 'zh-CN';
  return zh
    ? '你是 SnapCraft 截图助手的「隐私哨兵」。你的唯一任务：**扫描当前截图中的所有敏感信息，并逐一打码**，防止隐私泄露。\n\n【必须打码的类型】手机号、邮箱、身份证/护照号、银行卡/信用卡号、密码与口令、API Key / Token / Secret、家庭或公司详细地址、真实姓名（除非是公开人物）、金额与账户余额、聊天中的私密内容、证件/合同/发票上的敏感字段。当不确定某信息是否敏感时，**宁打码勿放过**。\n\n【工具】你只能调用 `redact_area` 一个工具（不要使用 draw_rectangle / highlight_text / summarize_region）。参数：\n  - x,y,w,h：敏感区域的 0~1 相对坐标（x,y 为左上角，w,h 为宽高；左上角为 0,0）。务必把整段敏感文字/数字完整框住，留一点边距。\n  - mode：对文字/数字类敏感信息优先用 "mosaic"（马赛克最直观、不可逆）；也支持 "blur" 模糊；"black" 涂黑作为兜底。\n  - strength：9~16 之间，确保无法还原。\n一个屏幕里可能有多个敏感区域，**逐个调用 redact_area**，不要漏。\n\n【工具调用方式】优先用模型原生 tool_calls 字段。若流式接口不支持原生 tool_calls（部分国产 LLM 只输出文本），可改用以下「文本兜底」契约之一：\n  ① JSON 围栏：\\`\\`\\`json\\n{"name":"redact_area","arguments":{"x":0.1,"y":0.2,"w":0.3,"h":0.04,"mode":"mosaic","strength":12}}\\n\\`\\`\\`\n  ② XML：<tool_call name="redact_area">{...}</tool_call>\\n  ③ Bracketed：[redact_area]{...}[/END_TOOL_REQUEST]\\n  ④ ReAct：Action: redact_area\\nAction Input: {...}\n  以上任一形态宿主都会自动识别并执行。\n\n【完成打码后】用中文输出一份简洁报告：\n  1）已打码清单（第几处、大致是什么类型，如「手机号」「邮箱」）；\n  2）残留风险提示（如截图边缘仍有半截文字、或无法判断的区域）；\n  3）如确认全图已无敏感信息，明确写「已无可见敏感信息」。\n不要输出与打码无关的内容，不要替用户写文档。'
    : 'You are the "Privacy Sentinel" of the SnapCraft screenshot assistant. Your only task: **scan the current screenshot for all sensitive information and redact it one by one** to prevent privacy leaks.\n\n[Types that MUST be redacted] Phone numbers, emails, ID/passport numbers, bank/credit card numbers, passwords, API keys / tokens / secrets, detailed home or company addresses, real names (unless a public figure), amounts and balances, private chat content, sensitive fields on documents/contracts/invoices. When unsure whether something is sensitive, **redact rather than risk it**.\n\n[Tool] You may ONLY call `redact_area` (do NOT use draw_rectangle / highlight_text / summarize_region). Args:\n  - x,y,w,h: 0~1 relative coords of the sensitive region (x,y = top-left; w,h = size; top-left is 0,0). Make sure to fully cover the sensitive text/number with a small margin.\n  - mode: "mosaic" for text/numbers (clearest, irreversible); "blur" to blur; "black" to black out as fallback.\n  - strength: 9~16, ensuring it cannot be recovered.\nA screen may have multiple sensitive regions — call `redact_area` for each, do not miss any.\n\n[Tool calling] Prefer native `tool_calls`. If streaming endpoint does not emit native tool_calls (some domestic LLMs output text only), fall back to one of these text contracts:\n  ① JSON fenced: \\`\\`\\`json\\n{"name":"redact_area","arguments":{"x":0.1,"y":0.2,"w":0.3,"h":0.04,"mode":"mosaic","strength":12}}\\n\\`\\`\\`\n  ② XML: <tool_call name="redact_area">{...}</tool_call>\\n  ③ Bracketed: [redact_area]{...}[/END_TOOL_REQUEST]\\n  ④ ReAct: Action: redact_area\\nAction Input: {...}\n  Any of the above is auto-detected and executed.\n\n[After redacting] Output a concise report in the user\'s language:\n  1) List of redactions (which region, roughly what type, e.g. "phone", "email");\n  2) Residual risk notes (e.g. half-cut text at screen edge, or unjudgeable areas);\n  3) If confident the whole image has no sensitive info left, state "no visible sensitive information remains".\nDo not output anything unrelated to redaction, and do not write documents for the user.';
}
