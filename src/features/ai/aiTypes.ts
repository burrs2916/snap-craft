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

/**
 * 接口协议族（P0+P2，对齐 biosphere 的 ProviderConfig.endpointFamily）。
 * 用于把「供应商预设」与「请求拼装方式」解耦：同一 apiType 下可能有多种端点
 * （如 OpenAI 兼容既可能是聊天也可能是图像生成）。段一先落 openai-chat / anthropic，
 * 图像类（openai-images / openai-images-edit / gemini / stability / comfyui）预留给 P4 图像输出。
 */
export type EndpointFamily =
  | 'openai-chat'
  | 'anthropic'
  | 'openai-images'
  | 'openai-images-edit'
  | 'gemini'
  | 'stability'
  | 'comfyui';

/** 模型能力标签（P2）：从 biosphere 借鉴的 capabilities 概念，驱动 UI 与图像方向功能开关 */
export type AiCapability = 'text' | 'vision' | 'image-gen' | 'image-edit';

/** 使用模态（P2）：服务于「图片生成图片」愿景——分析 / 艺术化 / 生成 */
export type AiModality = 'analyze' | 'artistic' | 'generate';

/**
 * 供应商配置（对齐 biosphere 三层模型的最底层 Provider：只持有「密钥」，
 * 不再捆绑 apiType/baseUrl/模型列表）。一个供应商下可有多个「接入方式(Endpoint)」，
 * 每个接入方式下挂多个「模型(Model)」，形成 Provider → Endpoint → Model 三层嵌套。
 */
export type EndpointAuthType = 'bearer' | 'x-api-key' | 'custom-header';

export interface AiProviderConfig {
  id: string;
  /** 显示名：builtin 供应商存 i18n key（如 'ai.providerOpenAI'），自定义供应商存用户文本 */
  name: string;
  /** 该供应商独立密钥；留空则运行时回退到全局 config.apiKey */
  apiKey: string;
  /** 来自 PROVIDERS 目录的内置供应商（不可删除） */
  builtin?: boolean;
  enabled?: boolean;
}

/**
 * 接入方式（Endpoint）：biosphere 的 EndpointDto 在 snap-craft 中承载两层含义——
 * 「服务族(apiType)」+「怎么接(baseUrl + authType)」，挂在某个供应商下。
 * 同一供应商可有多条 Endpoint（不同服务 / 不同基地址 / 不同鉴权）。
 */
export interface AiEndpointConfig {
  id: string;
  /** 外键 → AiProviderConfig.id */
  providerId: string;
  /** 展示名（如「聊天」「图像生成」「内网代理」） */
  name: string;
  /** 接口协议族（决定 aiClient 的请求拼装与鉴权） */
  apiType: AiApiType;
  /** 接口基地址，不含 /chat/completions 后缀 */
  baseUrl: string;
  /** 鉴权方式（对齐 biosphere 的 authType） */
  authType: EndpointAuthType;
  /** authType=custom-header 时的自定义请求头名（如 'Authorization'） */
  customAuthHeader?: string;
  enabled?: boolean;
}

/**
 * 模型实体（Model）：biosphere 的 ModelDto。不再是供应商下的字符串 id 列表，
 * 而是独立实体，带「展示名 name / 真实 API 名 refKey / 能力 / 推理 / 窗口 / tokens」。
 * 调用时按 model.endpointId → endpoint.providerId → provider.apiKey 两步动态解析，
 * 绝不在模型上写死 key/baseurl（命中用户「模型→配置绑定动态解析、不写死」铁律）。
 */
export interface AiModelConfig {
  id: string;
  /** 外键 → AiEndpointConfig.id */
  endpointId: string;
  /** 展示名（UI 列表显示；可等于 refKey，也可自取友好名） */
  name: string;
  /** 实际请求用的 API 模型名（如 gpt-4o-mini）；发请求用这个，不是 name */
  refKey: string;
  /** 输入模态能力：text / image（截图分析主业务依赖 image） */
  inputTypes: ('text' | 'image')[];
  /** 是否推理模型（Anthropic thinking / DeepSeek-R1 等） */
  reasoning?: boolean;
  /** 上下文窗口（token） */
  contextWindow?: number;
  /** 单次最大输出（token） */
  maxTokens?: number;
  enabled?: boolean;
}

export interface AiConfig {
  apiType: AiApiType;
  /** 接口基地址，不含 /chat/completions 后缀，如 https://api.openai.com/v1（全局兜底） */
  baseUrl: string;
  apiKey: string;
  /** 默认模型：存 AiModelConfig.id（指向具体模型实体）；未命中实体时视为自定义 refKey 兜底 */
  model: string;
  temperature: number;
  /** 导出文档（HTML / PDF）的主题，默认 'modern'，持久化于本机配置 */
  theme?: DocThemeId;
  /** 接口协议族（P2，可选，旧配置缺省回退 'openai-chat'/'anthropic'） */
  endpointFamily?: EndpointFamily;
  /** 模型能力标签（P2，可选）；由供应商预设初值 + 「能力探测」回填 */
  capabilities?: AiCapability[];
  /** 使用模态（P2，可选，旧配置缺省 'analyze'） */
  modality?: AiModality;
  /** 多供应商列表（仅密钥层） */
  providers?: AiProviderConfig[];
  /** 接入方式列表（服务族 + 基地址 + 鉴权），外键 providerId */
  endpoints?: AiEndpointConfig[];
  /** 模型实体列表（独立实体，外键 endpointId） */
  models?: AiModelConfig[];
  /** 已由「视觉能力探测」实测确认支持读图的模型 id（模型级能力记录，优先级高于目录推断）。
   *  截图分析是 SnapCraft 主业务，选到非视觉模型等于白配，故按模型而非全局记录。 */
  visionModels?: string[];
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
  /** 可选：强制模型调用指定工具（OpenAI: {type:'function',function:{name}} /
   *  Anthropic: {type:'tool',name}）；传入后模型本轮必须调用该工具，不能只写文本。
   *  用于「隐私哨兵」等必须真正执行工具、否则会退化成纯文字报告的场景。不传则 'auto'。 */
  toolChoice?: string;
  /** 可选：流式过程中实时回调模型「思考 / 推理」内容（Anthropic thinking_delta、
   *  OpenAI 兼容 reasoning / reasoning_content，如 DeepSeek-R1 / Qwen 推理模型）。
   *  UI 上可作为可折叠的「思考过程」展示，让用户看到 AI 如何拆解截图任务。 */
  onThinking?: (t: string) => void;
  /** 可选：本次请求的单次最大输出 token。由调用方按模型真实 maxTokens 传入（resolveModelLimits），
   *  用于同时满足：(1) 请求体 max_tokens 不超过模型上限；(2) history 预算为其预留空间，
   *  保证 input + max_tokens ≤ contextWindow，杜绝「触顶上下文 + 输出」叠加导致的 400。 */
  maxTokens?: number;
  /** 可选：每次重试前回调。流式重试会从头重新输出，调用方应借此把已展示内容回退到
   *  baseline（不传则清空）：普通流式清空即可；Agent 工具循环传「已完成轮次的累计文本」，
   *  使重试只覆盖当前轮片段，不丢失此前轮次的输出。 */
  onRetry?: (baseline?: string) => void;
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
