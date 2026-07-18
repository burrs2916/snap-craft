// AI 客户端：OpenAI 兼容 / Anthropic 流式调用（前端直连）
// 设计对齐 privdoc-ai 的 OpenAiCompatProvider：
//  - OpenAI 兼容：POST {baseUrl}/chat/completions，SSE 解析 choices[].delta.content
//  - Anthropic：POST {baseUrl}/v1/messages，SSE 解析 content_block_delta.delta.text
// 支持 vision：user 消息带 imageDataUrl 时，按接口类型拼装多模态 content。
//
// 2026-07-15 Phase 13 — 流式可靠性对齐顶级项目（openclaw / claw-code）：
//  - 健壮 SSE 帧解析：按 `\n\n`/`\r\n\r\n` 切帧（而非按单 `\n`），多 `data:` 行自动拼接，
//    `\r\n` 归一、尾部 flush、跳过 `[DONE]` 与注释/keepalive；识别内嵌 `error` 帧。
//  - 退避重试：429/5xx/网络抖动自动重试（最多 3 次，指数退避+抖动）；尊重 429 的
//    Retry-After；用户取消（AbortError）与 4xx 业务错误绝不重试。
//  - 上下文预算护栏：在发请求前按「字符/4」估算 token，超额则裁剪最旧历史轮次
//    （保留最近若干轮与全部 system），避免超长会话触发 API 400/413。

import type { AiConfig, AiMessage, StreamOpts, AiUsage, AiToolDef, AiToolCall, AiToolResult, AiAgentStep } from './aiTypes';
import {
  parseShapedToolCalls,
  stripShapedToolCalls as stripShapedToolCallsText,
  looksLikeShapedToolCall,
} from './toolCallParser';

interface ParsedDataUrl {
  mediaType: string;
  base64: string;
}

function parseDataUrl(dataUrl: string): ParsedDataUrl {
  // data:image/png;base64,xxxx
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (m) return { mediaType: m[1], base64: m[2] };
  return { mediaType: 'image/png', base64: '' };
}

/** 收集一条消息内全部图片 data URL（主图 + 多图），并去空 */
function collectImages(m: AiMessage): string[] {
  const all = [m.imageDataUrl, ...(m.images ?? [])].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  );
  // 去重（同一张图可能因主图+附加而重复）
  return Array.from(new Set(all));
}

function toOpenAiMessages(messages: AiMessage[]) {
  return messages.map((m) => {
    // 工具结果消息：role=tool，携带 tool_call_id（OpenAI 约定）
    if (m.role === 'tool' && m.toolResult) {
      return {
        role: 'tool',
        tool_call_id: m.toolResult.toolCallId,
        content: m.toolResult.content,
      };
    }
    // assistant 携带工具调用：还原为 tool_calls（供模型下一轮读取结果）
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    const imgs = collectImages(m);
    if (imgs.length > 0) {
      return {
        role: m.role,
        content: [
          { type: 'text', text: m.content },
          ...imgs.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

function toAnthropicMessages(messages: AiMessage[]) {
  // 多条 system 消息合并（Phase 14 修复：原 find 只取第一条，会吞掉「长期记忆注入」与「工具循环」下的预设 system）
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n\n');
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      // 工具结果消息：Anthropic 用 user + tool_result 块承载
      if (m.role === 'tool' && m.toolResult) {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.toolResult.toolCallId,
              content: m.toolResult.content,
            },
          ],
        };
      }
      // assistant 携带工具调用：还原为 text + tool_use 块
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const content: any[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        }
        return { role: 'assistant', content };
      }
      const imgs = collectImages(m);
      if (imgs.length > 0) {
        const content: any[] = [{ type: 'text', text: m.content }];
        for (const url of imgs) {
          const { mediaType, base64 } = parseDataUrl(url);
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          });
        }
        return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
      }
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
    });
  return { system, rest };
}

function buildUrl(config: AiConfig): string {
  const base = config.baseUrl.replace(/\/+$/, '');
  return config.apiType === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`;
}

function buildHeaders(config: AiConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiType === 'anthropic') {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function buildBody(config: AiConfig, messages: AiMessage[], stream: boolean, tools?: AiToolDef[]) {
  if (config.apiType === 'anthropic') {
    const { system, rest } = toAnthropicMessages(messages);
    // 提示缓存（对齐 openclaw anthropic-payload-policy.ts）：把稳定的 system 打上
    // cache_control，并在最后一条 user 消息末尾打缓存点。多轮对话 / 记忆压缩 /
    // 反复润色等重复调用会复用缓存，显著降低输入 token 成本与首字延迟。
    const systemBlocks: any = system
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : undefined;
    const cachedRest = rest.length
      ? rest.map((m, idx) => {
          if (idx !== rest.length - 1 || m.role !== 'user') return m;
          const content: any[] = Array.isArray(m.content)
            ? [...m.content]
            : [{ type: 'text', text: String(m.content) }];
          const last = content[content.length - 1];
          if (last && typeof last === 'object') last.cache_control = { type: 'ephemeral' };
          else content.push({ type: 'text', text: '', cache_control: { type: 'ephemeral' } });
          return { ...m, content };
        })
      : rest;
    const body: any = {
      model: config.model,
      system: systemBlocks,
      messages: cachedRest,
      // 输出上限：8192 在 PRD / 竞品分析 / 多截图图文报告等长文档场景下会被截断。
      // 提升至 16384 覆盖 GPT-4o / Claude 3.5 的常用上限；不支持的模型会按 API 报错回退。
      max_tokens: 16384,
      temperature: config.temperature,
      stream,
    };
    // AI Agent 工具循环（Phase 14）：Anthropic 工具格式
    if (tools?.length) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }
    return body;
  }
  const body: any = {
    model: config.model,
    messages: toOpenAiMessages(messages),
    temperature: config.temperature,
    max_tokens: 16384,
    stream,
    // 请求服务端在末帧回传 usage（prompt/completion tokens），用于成本透明（OpenAI 兼容）
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
  // AI Agent 工具循环（Phase 14）：OpenAI 兼容工具格式
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
    body.tool_choice = 'auto';
  }
  return body;
}

// ─────────────────────────────────────────────────────────────
// Phase 13：流式可靠性基础设施
// ─────────────────────────────────────────────────────────────

function makeAbortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

/** 可感知 abort 的 sleep：等待期间若被取消，立即 reject（不重试取消） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 解析 429/503 响应头里的重试等待秒数（Retry-After / Retry-After-Ms / HTTP-date） */
function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw) {
    const sec = Number.parseFloat(raw);
    if (Number.isFinite(sec) && sec >= 0) return sec;
    const ts = Date.parse(raw);
    if (!Number.isNaN(ts)) return Math.max(0, (ts - Date.now()) / 1000);
  }
  const ms = headers.get('retry-after-ms');
  if (ms) {
    const v = Number.parseFloat(ms);
    if (Number.isFinite(v) && v >= 0) return v / 1000;
  }
  return undefined;
}

/** 指数退避（对齐 openclaw CONFIG_LOAD_RETRY_POLICY：initialMs=1s, factor=2, jitter） */
function computeBackoff(
  attempt: number,
  initialMs = 800,
  maxMs = 8000,
  factor = 2,
  jitter = 0.3,
): number {
  const base = Math.min(maxMs, initialMs * Math.pow(factor, attempt));
  const j = base * jitter * Math.random();
  return Math.round(base + j);
}

const RETRYABLE_STATUS = (s: number) =>
  s === 408 || s === 409 || s === 429 || (s >= 500 && s < 600);

/** 在 buffer 中找下一个 SSE 事件帧边界（支持 \n\n 与 \r\n\r\n） */
function findFrameEnd(b: string): number {
  const a = b.indexOf('\n\n');
  const c = b.indexOf('\r\n\r\n');
  if (a >= 0 && c >= 0) return Math.min(a, c);
  if (a >= 0) return a;
  if (c >= 0) return c;
  return -1;
}

function frameDelimLen(b: string, idx: number): number {
  return b.startsWith('\r\n\r\n', idx) ? 4 : 2;
}

// ─────────────────────────────────────────────────────────────
// Phase 14：AI Agent 工具循环 — SSE 中解析 tool_use / tool_calls
// ─────────────────────────────────────────────────────────────

/** 模型产出的原始工具调用（参数尚未解析 JSON） */
interface RawToolCall {
  id: string;
  name: string;
  rawArgs: string;
  arguments: Record<string, any>;
}

/** 工具调用累积器：Anthropic 用 cur 顺序构建；OpenAI 用 openaiMap 按 index 收集 */
interface ToolAccum {
  toolCalls: RawToolCall[];
  cur: RawToolCall | null;
  openaiMap: Map<number, RawToolCall>;
}

/** 思考块状态（跨帧保持）：Anthropic 的 thinking 块以 content_block_start/delta/stop 三段流式，
 *  需跨帧记住「当前是否处于思考块中」，才能正确把 thinking_delta 喂给 onThinking 回调。 */
interface ThinkState {
  active: boolean;
}

/**
 * 解析单个 SSE 事件帧，提取文本增量并回调。
 *  - 多 `data:` 行（同一事件的跨行分片）自动用 `\n` 拼接后再 JSON.parse；
 *  - 跳过注释行（`:` 开头）、空帧、`[DONE]`；
 *  - 识别内嵌 `error` 帧，抛出带 status 的结构化错误（供上层决定是否重试）；
 *  - Anthropic 解析 `tool_use` 内容块（content_block_start/delta/stop），
 *    OpenAI 解析 `delta.tool_calls`（按 index 累积 partial_json）。
 */
function processFrame(
  frame: string,
  config: AiConfig,
  emit: (t: string) => void,
  onUsage?: (u: AiUsage) => void,
  usage?: AiUsage,
  toolAcc?: ToolAccum,
  onThinking?: (t: string) => void,
  think?: ThinkState,
): void {
  const trimmed = frame.trim();
  if (!trimmed) return;
  const dataLines = trimmed
    .split(/\r\n|\n|\r/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => (l.length > 5 && l[5] === ' ' ? l.slice(6) : l.slice(5)));
  if (dataLines.length === 0) return;
  const data = dataLines.join('\n');
  if (!data || data === '[DONE]') return;

  let json: any;
  try {
    json = JSON.parse(data);
  } catch {
    return; // 畸形帧：跳过（部分代理会发 keepalive 脏块）
  }

  if (json?.error) {
    const msg = json.error?.message ?? JSON.stringify(json.error);
    const err: any = new Error(`Stream error: ${msg}`);
    err.status = typeof json.error?.code === 'number' ? json.error.code : 0;
    err.streamError = true;
    throw err;
  }

  if (config.apiType === 'anthropic') {
    // 用量在独立事件帧里回传：message_start 给 input_tokens，message_delta 给 output_tokens
    if (json?.type === 'message_start' && json?.usage?.input_tokens != null) {
      if (usage) {
        usage.input = json.usage.input_tokens;
        // 提示缓存（对齐 openclaw anthropic-payload-policy）：建立缓存 / 命中缓存的 token 单独回显
        if (json.usage.cache_creation_input_tokens != null) usage.cacheCreate = json.usage.cache_creation_input_tokens;
        if (json.usage.cache_read_input_tokens != null) usage.cacheRead = json.usage.cache_read_input_tokens;
      }
      onUsage?.({ ...(usage as AiUsage) });
      return;
    }
    // tool_use 内容块开始：记录 id / name，准备累积参数
    if (json?.type === 'content_block_start') {
      const cb = json.content_block;
      if (cb?.type === 'tool_use' && toolAcc) {
        toolAcc.cur = { id: cb.id, name: cb.name ?? '', rawArgs: '', arguments: {} };
      } else if (cb?.type === 'thinking') {
        // 进入思考块（对齐 openclaw anthropic-transport-stream：thinking 也是独立 content block）
        if (think) think.active = true;
      }
      return;
    }
    // tool_use 参数增量（input_json_delta）/ 思考增量（thinking_delta）/ 正文文本增量（text_delta）
    if (json?.type === 'content_block_delta' && json?.delta) {
      const d = json.delta;
      if (d.type === 'thinking_delta') {
        if (think?.active) onThinking?.(d.thinking ?? '');
      } else if (d.type === 'text_delta') {
        if (d.text) emit(d.text);
      } else if (d.type === 'input_json_delta' && toolAcc?.cur) {
        toolAcc.cur!.rawArgs += d.partial_json ?? '';
      }
      return;
    }
    // tool_use 内容块结束：解析参数并落库
    if (json?.type === 'content_block_stop') {
      if (toolAcc?.cur) {
        try {
          toolAcc.cur.arguments = JSON.parse(toolAcc.cur.rawArgs || '{}');
        } catch {
          toolAcc.cur.arguments = {};
        }
        toolAcc.toolCalls.push(toolAcc.cur);
        toolAcc.cur = null;
      } else if (think) {
        // 思考块结束（非工具块）→ 退出思考态
        think.active = false;
      }
      return;
    }
    if (json?.type === 'message_delta' && json?.usage?.output_tokens != null) {
      if (usage) usage.output = json.usage.output_tokens;
      onUsage?.({ ...(usage as AiUsage) });
    }
  } else {
    // OpenAI 兼容：usage 在末帧（空 choices）回传；部分代理把 usage 挂在普通 chunk
    if (json?.usage && (json.usage.prompt_tokens != null || json.usage.completion_tokens != null)) {
      if (usage) {
        if (json.usage.prompt_tokens != null) usage.input = json.usage.prompt_tokens;
        if (json.usage.completion_tokens != null) usage.output = json.usage.completion_tokens;
        // OpenAI 提示缓存命中（prompt caching）：cached_tokens 计入 cacheRead 一并回显
        const cached = json.usage.prompt_tokens_details?.cached_tokens;
        if (cached != null) usage.cacheRead = cached;
      }
      onUsage?.({ ...(usage as AiUsage) });
    }
    // 工具调用增量：按 index 累积到 openaiMap（流末统一解析参数）
    const tcDelta = json?.choices?.[0]?.delta?.tool_calls;
    if (tcDelta && Array.isArray(tcDelta) && toolAcc) {
      for (const item of tcDelta) {
        const idx = typeof item.index === 'number' ? item.index : 0;
        let entry = toolAcc.openaiMap.get(idx);
        if (!entry) {
          entry = { id: item.id ?? `call-${idx}`, name: '', rawArgs: '', arguments: {} };
          toolAcc.openaiMap.set(idx, entry);
        }
        if (item.id && !entry.id.startsWith('call-')) entry.id = item.id;
        if (item.function?.name) entry.name = item.function.name;
        if (typeof item.function?.arguments === 'string') entry.rawArgs += item.function.arguments;
      }
    }
    const delta = json?.choices?.[0]?.delta?.content;
    if (delta) emit(delta);
    // 推理模型（DeepSeek-R1 / Qwen / o-series 兼容端点）在 delta 内回传 reasoning_content / reasoning，
    // 单独回调给 onThinking，UI 上作为「思考过程」展示（对齐 openclaw reasoning 事件流）。
    const rsn =
      json?.choices?.[0]?.delta?.reasoning_content ?? json?.choices?.[0]?.delta?.reasoning;
    if (rsn) onThinking?.(rsn);
  }
}

/** 可感知 abort 的 reader.read()（对齐 openclaw readAnthropicSseChunk） */
function readAbortable(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (!signal) return reader.read();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(makeAbortError());
      return;
    }
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reader.cancel(signal.reason).catch(() => undefined);
      reject(makeAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (r) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(r);
      },
      (e) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** 单次流式请求（含 SSE 帧解析，不含重试）；HTTP/内嵌错误带 .status 供重试判定。
 *  返回正文文本 + 本次请求产出的原始工具调用（供 streamChatWithTools 驱动工具循环）。 */
async function streamOnce(opts: StreamOpts): Promise<{ text: string; toolCalls: RawToolCall[] }> {
  const { config, messages, onChunk, signal, onUsage, tools, onThinking } = opts;
  const usage: AiUsage = { input: 0, output: 0 };
  const url = buildUrl(config);
  const resp = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(buildBody(config, messages, true, tools)),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      if (j?.error?.message) detail = j.error.message;
    } catch {
      /* ignore */
    }
    const err: any = new Error(`HTTP ${resp.status}: ${detail}`);
    err.status = resp.status;
    err.retryAfter = parseRetryAfter(resp.headers);
    throw err;
  }
  if (!resp.body) throw new Error('no response body');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  const toolAcc: ToolAccum = { toolCalls: [], cur: null, openaiMap: new Map() };
  const think: ThinkState = { active: false };

  while (true) {
    const { done, value } = await readAbortable(reader, signal);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let frameEnd: number;
    while ((frameEnd = findFrameEnd(buffer)) >= 0) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + frameDelimLen(buffer, frameEnd));
      processFrame(frame, config, (t) => {
        full += t;
        onChunk(t);
      }, onUsage, usage, toolAcc, onThinking, think);
    }
  }
  // 流末尾 flush：剩余未以分隔符结尾的尾部也要解析（对齐 openclaw tail flush）
  const tail = buffer + decoder.decode();
  if (tail.trim()) {
    processFrame(tail, config, (t) => {
      full += t;
      onChunk(t);
    }, onUsage, usage, toolAcc, onThinking, think);
  }
  // OpenAI tool_calls 按 index 累积，流末统一解析参数为对象
  for (const [, v] of toolAcc.openaiMap) {
    try {
      v.arguments = JSON.parse(v.rawArgs || '{}');
    } catch {
      v.arguments = {};
    }
    toolAcc.toolCalls.push(v);
  }
  return { text: full, toolCalls: toolAcc.toolCalls };
}

/** 轻量 token 估算（无需 tokenizer）：每 4 字符 ≈ 1 token（对齐 claw-code compact.rs） */
export function estimateTokens(s: string): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

// 常见模型的每 1K tokens 价格（USD，近似值），用于本地成本估算（对齐 claw-code usage.rs 的 ModelPricing）
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-3-5-sonnet': { in: 0.003, out: 0.015 },
  'claude-3-5-sonnet-20241022': { in: 0.003, out: 0.015 },
  'claude-3-opus': { in: 0.015, out: 0.075 },
  'claude-3-haiku': { in: 0.00025, out: 0.00125 },
  'gpt-4o': { in: 0.005, out: 0.015 },
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  'gpt-4-turbo': { in: 0.01, out: 0.03 },
  'gpt-3.5-turbo': { in: 0.0005, out: 0.0015 },
};

/** 估算一次对话的成本（USD）；模型不在价目表时返回 null（UI 隐藏成本，仅显 token） */
export function estimateCost(model: string, input: number, output: number): number | null {
  const key = Object.keys(PRICING).find((k) => model.includes(k) || k.includes(model));
  if (!key) return null;
  const p = PRICING[key];
  return (input / 1000) * p.in + (output / 1000) * p.out;
}

/**
 * 错误分类（对齐 openclaw provider-http-errors / classifyProviderRuntimeFailureKind）：
 * 用状态码 + 关键词双重判断，把底层 HTTP 错误归并为面向用户的少数几类，
 * 让 UI 给出「是哪类问题 + 怎么修」的明确文案，而非裸 401/500。
 */
export type AiErrorKind = 'auth' | 'rate' | 'context' | 'server' | 'unknown';

export function classifyAiError(e: any): AiErrorKind {
  const status = e?.status;
  const msg: string = e?.message ?? '';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status === 408 || (status >= 500 && status < 600)) return 'server';
  if (status === 400 || status === 413 || status === 422) {
    if (/context|too long|maximum|token|overflow|length|exceed/i.test(msg)) return 'context';
    return 'unknown';
  }
  return 'unknown';
}

/**
 * 上下文预算护栏：历史消息总 token 超过 budget 时，从最旧一轮开始成对丢弃
 * （user+assistant），保留最近 preserveLastRounds 轮与全部 system 消息。
 * 防止超长会话（或超长首轮 OCR/目标）触发 API 400/413。
 */
export function trimHistoryToBudget(
  msgs: AiMessage[],
  budgetTokens = 120_000,
  preserveLastRounds = 3,
): AiMessage[] {
  const sys = msgs.filter((m) => m.role === 'system');
  const rest = msgs.filter((m) => m.role !== 'system');
  if (rest.length === 0) return msgs;

  const total = rest.reduce(
    (s, m) => s + estimateTokens(m.content) + (m.images?.length ?? 0) * 256,
    0,
  );
  if (total <= budgetTokens) return msgs;

  const preserve = Math.min(rest.length, preserveLastRounds * 2);
  let dropFrom = rest.length - preserve;
  // 逐步减少丢弃量，直到剩余历史落入预算（至少保留 preserve 轮）。
  // 注意：估算需把每张图片的 token 一并计入（每张约 256 token），否则多截图 / 长 OCR
  // 会话即便裁剪后仍可能超模型上下文上限，触发 API 400/413。
  while (dropFrom > 0) {
    const keptTokens = rest
      .slice(dropFrom)
      .reduce((s, m) => s + estimateTokens(m.content) + (m.images?.length ?? 0) * 256, 0);
    if (keptTokens <= budgetTokens) break;
    dropFrom--;
  }
  return [...sys, ...rest.slice(dropFrom)];
}

const MAX_RETRIES = 3;

/** 流式调用：每个 chunk 通过 onChunk 实时回调，返回完整文本。内置退避重试。 */
export async function streamChat(opts: StreamOpts): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await streamOnce({ ...opts, onThinking: opts.onThinking })).text;
    } catch (e: any) {
      // 用户取消（或超时）绝不重试
      if (e?.name === 'AbortError') throw e;
      const status = e?.status;
      const isLast = attempt >= MAX_RETRIES - 1;
      const canRetry = status ? RETRYABLE_STATUS(status) : !e?.streamError; // 网络异常（无 status）也可重试
      if (isLast || !canRetry) throw e;

      let delay = computeBackoff(attempt);
      // 429 尊重 Retry-After（不超时过长则优先用服务端建议）
      if (status === 429 && typeof e?.retryAfter === 'number') {
        delay = Math.min(delay, Math.max(500, e.retryAfter * 1000 + 200));
      }
      await sleep(delay, opts.signal);
      if (opts.signal?.aborted) throw makeAbortError();
    }
  }
}

/**
 * AI Agent 工具循环（Phase 14，对齐 claw-code run_turn / openclaw 工具循环）：
 *  - 发起一次流式请求；若模型返回工具调用，则逐条派发到 executor 在宿主侧执行
 *    （如直接修改截图标注画布），把结果作为 tool_result 回传模型，继续下一轮；
 *  - 模型不再调用工具（产出纯文本）或达到 maxToolTurns 上限时终止；
 *  - 支持中断（AbortSignal）：取消即抛出 AbortError，上层按「用户取消」处理。
 * 工具定义对 OpenAI 兼容 / Anthropic 透明（由 buildBody 转换）。
 */
export interface StreamWithToolsOpts extends StreamOpts {
  tools: AiToolDef[];
  executor: (name: string, args: Record<string, any>) => Promise<{ content: string; isError?: boolean }>;
  maxToolTurns?: number;
  onToolCall?: (step: AiAgentStep) => void;
  onToolResult?: (callId: string, result: string, isError: boolean) => void;
}

// 工具调用稳定指纹：同名 + 同参视为「同一次调用」，用于失控循环检测
function stableToolKey(name: string, args: Record<string, any>): string {
  try {
    const sorted: Record<string, any> = {};
    for (const k of Object.keys(args).sort()) sorted[k] = args[k];
    return `${name}:${JSON.stringify(sorted)}`;
  } catch {
    return `${name}:${JSON.stringify(args)}`;
  }
}
// 连续相同工具调用达到此次数即判定为失控循环、提前终止（桌面端 8 轮上限下收紧为 3；
// 对齐 openclaw tool-loop-detection 的 no-progress 思想，避免模型陷入「重复调用同工具」空转）。
const MAX_REPEAT_TOOL = 3;

export async function streamChatWithTools(
  opts: StreamWithToolsOpts,
): Promise<{ text: string; toolCalls: AiToolCall[] }> {
  const { tools, executor, maxToolTurns = 8, onToolCall, onToolResult, onChunk, signal, config } = opts;
  // 退化路径：未给工具时等同于普通流式
  if (!tools?.length) {
    const text = await streamChat({ config, messages: opts.messages, onChunk, onUsage: opts.onUsage, signal });
    return { text, toolCalls: [] };
  }

  // 复制消息列表，避免篡改调用方数组（工具循环会在其后追加 assistant/tool 消息）
  const messages: AiMessage[] = opts.messages.map((m) => ({ ...m }));
  let fullText = '';
  let totalToolCalls: AiToolCall[] = [];
  // 失控循环检测状态：记录上一轮工具指纹与连续重复计数
  let lastTurnKey = '';
  let repeatCount = 0;

  for (let turn = 0; turn <= maxToolTurns; turn++) {
    if (signal?.aborted) throw makeAbortError();

    const { text, toolCalls: nativeToolCalls } = await streamOnce({
      config,
      messages,
      onChunk,
      onUsage: opts.onUsage,
      onThinking: opts.onThinking,
      signal,
      tools,
    });
    fullText += text;

    // Phase 16：多形态工具调用兜底（对齐 openclaw tool-call-shaped-text）
    // 当原生 `tool_calls` 字段为空时，从累积文本里识别并解析 shaped text
    // （国产模型在 OpenAI 兼容接口的 stream 模式可能只输出文本，不下发 tool_calls）。
    // 已识别的工具调用片段会从用户可见输出中剔除，避免「正文 + 工具调用 JSON」重复。
    let toolCalls: RawToolCall[] = nativeToolCalls;
    let shapedRanges: Array<{ start: number; end: number; kind: import('./toolCallParser').ShapedToolCallKind }> = [];
    if (toolCalls.length === 0 && text && looksLikeShapedToolCall(text)) {
      const shaped = parseShapedToolCalls(text);
      if (shaped.calls.length) {
        // 转为 RawToolCall（rawArgs 用 JSON 字符串占位，便于与原生路径统一处理）
        toolCalls = shaped.calls.map((c) => ({
          id: c.fingerprint,
          name: c.name,
          rawArgs: JSON.stringify(c.arguments),
          arguments: c.arguments,
        }));
        shapedRanges = shaped.ranges;
        // 抹掉 shaped 片段：避免用户既看到 JSON 又看到工具执行
        if (shapedRanges.length) {
          const cleaned = stripShapedToolCallsText(text, shapedRanges);
          // 把累积的 fullText 也修正：把本 turn 追加的 `text` 替换为 `cleaned`
          fullText = fullText.slice(0, fullText.length - text.length) + cleaned;
        }
      }
    }

    // 模型未再调用工具 → 这是最终答案，结束循环
    if (toolCalls.length === 0) break;

    // 失控循环检测（对齐 openclaw tool-loop-detection 的 no-progress 思想）：
    // 若模型连续多轮发出「完全相同」的工具调用，判定为陷入重复，提前终止以免空转浪费 token。
    const turnKey = toolCalls
      .map((tc) => stableToolKey(tc.name, tc.arguments))
      .sort()
      .join('|');
    if (turnKey && turnKey === lastTurnKey) repeatCount += 1;
    else {
      lastTurnKey = turnKey;
      repeatCount = 1;
    }

    // 逐条派发工具，执行结果回传给模型
    const results: AiToolResult[] = [];
    for (let tcIdx = 0; tcIdx < toolCalls.length; tcIdx += 1) {
      const tc = toolCalls[tcIdx];
      const callId = `call-${totalToolCalls.length}-${tc.id}`;
      // Phase 16：标记 source/shapedKind（shaped 兜底路径时统一为 'shaped'）
      const shapedKind = shapedRanges[tcIdx]?.kind;
      onToolCall?.({
        callId,
        name: tc.name,
        label: tc.name,
        args: tc.arguments,
        source: shapedRanges.length ? 'shaped' : 'native',
        shapedKind,
      });
      try {
        const res = await executor(tc.name, tc.arguments);
        results.push({ toolCallId: tc.id, name: tc.name, content: res.content, isError: res.isError });
        onToolResult?.(callId, res.content, !!res.isError);
      } catch (e: any) {
        const msg = e?.message ? String(e.message) : String(e);
        results.push({ toolCallId: tc.id, name: tc.name, content: `Tool error: ${msg}`, isError: true });
        onToolResult?.(callId, msg, true);
      }
      if (signal?.aborted) throw makeAbortError();
    }
    totalToolCalls.push(...toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })));

    // 连续相同工具调用达阈值 → 判定失控，提前终止并提示
    if (repeatCount >= MAX_REPEAT_TOOL) {
      fullText += '\n\n[已自动停止：检测到连续重复的工具调用，疑似陷入循环]';
      break;
    }

    // 把 assistant（含 tool_calls）与 tool 结果追加进对话，驱动下一轮
    messages.push({
      role: 'assistant',
      content: text,
      toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
    });
    for (const r of results) {
      messages.push({ role: 'tool', content: r.content, toolResult: r });
    }
  }

  return { text: fullText, toolCalls: totalToolCalls };
}

/** 非流式单次调用（用于「测试连接」/「记忆压缩」） */
export async function chatOnce(opts: {
  config: AiConfig;
  messages: AiMessage[];
}): Promise<string> {
  const { config, messages } = opts;
  const url = buildUrl(config);
  const resp = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(buildBody(config, messages, false)),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      if (j?.error?.message) detail = j.error.message;
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${resp.status}: ${detail}`);
  }
  const json = await resp.json();
  if (config.apiType === 'anthropic') {
    const parts = Array.isArray(json?.content) ? json.content : [];
    return parts.map((p: any) => (p?.type === 'text' ? p.text : '')).join('');
  }
  return json?.choices?.[0]?.message?.content ?? '';
}
