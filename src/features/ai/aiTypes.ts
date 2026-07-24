// AI 助手模块：类型定义
// 参考 privdoc-ai 的 LlmProvider 抽象（OpenAI 兼容 + Anthropic 适配），
// 但在 SnapCraft 中首版采用「前端直连」方案：由渲染进程直接调用用户配置的
// OpenAI 兼容接口（csp:null，外部 fetch 放行）。后端加固（密钥不下发渲染层、
// 原生流式事件、对话持久化）留待 Phase 2。

// ── 类型枢纽：DocThemeId / DocxImage ──
// 此前 DocThemeId 定义在 markdownHtml.ts，DocxImage 定义在 markdownDocx.ts，
// 导致 aiTypes → markdownHtml → (被 markdownDocx/markdownPptx 依赖) 的循环类型引用。
// 现统一移入本文件，各导出器从此处导入，消除循环依赖。

/** 文档主题 ID（5 套主题：现代简约 / 雅致衬线 / 杂志风 / 产品推广 / 科技风） */
export type DocThemeId = 'modern' | 'elegant' | 'magazine' | 'product' | 'tech';

/** 内嵌截图描述（用于 DOCX / PPTX / HTML 图文报告） */
export interface DocxImage {
  /** 截图 dataUrl（png/jpeg），将内嵌到文档 */
  dataUrl: string;
  /** 图注（可选） */
  caption?: string;
}

export type AiApiType = 'openai' | 'anthropic';

export interface AiConfig {
  apiType: AiApiType;
  /** 接口基地址，不含 /chat/completions 后缀，如 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** 导出文档（HTML / PDF）的主题，默认 'modern'，持久化于本机配置 */
  theme?: DocThemeId;
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 可选：主图（data URL），向后兼容单图 */
  imageDataUrl?: string;
  /** 可选：同一 user 消息内附带的多张截图（data URL），用于「多截图成稿」 */
  images?: string[];
  /** 可选：assistant 消息携带的工具调用（AI Agent 工具循环） */
  toolCalls?: AiToolCall[];
  /** 可选：工具结果消息（role 为 'tool' 时携带） */
  toolResult?: AiToolResult;
}

// ── Phase 14：AI Agent 工具调用（对齐 claw-code run_turn / openclaw 工具循环）──
// 工具契约对 OpenAI 兼容 / Anthropic 透明：统一用 JSON Schema 描述入参，
// 由 aiClient 在发送时转换为对应 provider 的 tools 格式。
export interface AiToolDef {
  name: string;
  description: string;
  /** JSON Schema（OpenAI 用 parameters，Anthropic 用 input_schema） */
  inputSchema: Record<string, any>;
}

/** 模型产出的单次工具调用（已解析参数） */
export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/** 工具执行结果，回传给模型作为下一轮上下文 */
export interface AiToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

/** AI Agent 在 UI 上回显的「正在执行 / 已完成」步骤 */
export interface AiAgentStep {
  callId: string;
  name: string;
  /** UI 展示用的友好名（由面板映射 i18n） */
  label: string;
  args: Record<string, any>;
  result?: string;
  isError?: boolean;
  /**
   * 工具调用来源：'native' = 原生 tool_calls 字段（OpenAI/Anthropic 严格格式）；
   *                'shaped' = 从文本里解析（多形态兜底，国产模型在 stream 模式下仅输出文本）。
   * UI 可据此显示小徽标，让用户了解本步是用哪种协议触发的。
   */
  source?: 'native' | 'shaped';
  /** shaped 形态具体类型（json_fenced/json_bare/xml/bracketed/react）—— 调试/统计用 */
  shapedKind?: string;
}

export interface AiUsage {
  input: number;
  output: number;
  /** Anthropic 提示缓存写入 token（首次建立缓存）；OpenAI 对应 prompt_tokens_details.cached_tokens */
  cacheCreate?: number;
  /** Anthropic 提示缓存命中（复用）token —— 这部分不计入「新」输入计费，是省钱信号 */
  cacheRead?: number;
}

export interface StreamOpts {
  config: AiConfig;
  /** 完整消息列表（含 system）；最后一条 user 消息可带 imageDataUrl */
  messages: AiMessage[];
  onChunk: (delta: string) => void;
  signal?: AbortSignal;
  /** 可选：流式过程中实时回调本次请求的 token 用量（用于成本透明展示） */
  onUsage?: (u: AiUsage) => void;
  /** 可选：工具定义（AI Agent 工具循环）；不传则不启用工具 */
  tools?: AiToolDef[];
  /** 可选：流式过程中实时回调模型「思考 / 推理」内容（Anthropic thinking_delta、
   *  OpenAI 兼容 reasoning / reasoning_content，如 DeepSeek-R1 / Qwen 推理模型）。
   *  UI 上可作为可折叠的「思考过程」展示，让用户看到 AI 如何拆解截图任务。 */
  onThinking?: (t: string) => void;
}

// 多轮对话中的一条记录（参考 privdoc-ai 的 conversations/messages 模型，
// 但在 SnapCraft 中截图即「文档上下文」：首轮携带视觉+OCR，后续轮仅文本迭代）。
export interface AiChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// 长期记忆条目（Phase 6，对齐 privdoc-ai 的 Agent Memory / MemoryEntry）：
// 当对话线程过长时，把最早几轮压缩为要点摘要存为「长期记忆」，
// 后续轮以 system 消息形式注入，避免上下文窗口溢出、支撑多轮迭代成稿。
// importance 为 1-5 重要性评分（与 privdoc-ai 的 importance 同款语义）。
export interface AiMemory {
  /** 稳定标识（用于 UI 高亮「本次注入」的记忆）；旧数据可能缺省，加载时补合成 id */
  id?: string;
  summary: string;
  importance: number;
  createdAt: number;
  turnsCovered: number;
  /**
   * 增量合并次数（≥2 表示这条「滚动摘要」由多次压缩链累加而成）。
   * 对齐 openclaw compaction.ts / claw-code compact.rs 的「单一滚动摘要」模式：
   * 每次压缩把新对话片段融合进既有摘要，而非新增一条孤立记忆，从而永不稀释早期事实。
   */
  merged?: number;
}
