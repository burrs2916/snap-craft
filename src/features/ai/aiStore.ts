// AI 助手状态：配置持久化 + 流式生成状态
// 配置（接口地址 / Key / 模型）仅持久化到本机浏览器 localStorage，
// 首版「前端直连」架构下密钥不下发到 Rust 侧（Phase 2 再考虑后端代理）。
//
// 2026-07-14 Phase 2b：
//  - 自定义预设（用户业务模板）持久化到 localStorage `snapcraft-ai-templates`，
//    与内置预设合并后作为可选的「生成方式」芯片。
//  - generate 支持「多截图成稿」：传入 images[] 与 ocrTexts[]，与当前图合并为
//    单条多模态 user 消息（仅当 preset.vision 为真时附带图片）。

import { create } from 'zustand';
import type { AiConfig, AiMessage, AiChatTurn, AiMemory, AiUsage, AiAgentStep } from './aiTypes';
import { streamChat, chatOnce, trimHistoryToBudget, classifyAiError, streamChatWithTools } from './aiClient';
import { AI_TOOL_DEFS, createToolExecutor, agentSystem, agentSystemSentinel, type AiToolHost } from './aiTools';
import {
  AI_PRESETS,
  getPreset,
  makeCustomPreset,
  type AiPreset,
  type UserPreset,
} from './aiPresets';
import { t, getLang } from '../../i18n';
import { loadMemories, saveMemories, selectMemories, withMemId, MAX_LIVE_ENTRIES, COMPACT_ENTRIES, isCompacting, setCompacting } from './aiMemory';

// 把底层 HTTP / 流式错误归并到面向用户的 i18n key
// （401/403→密钥无效；429→限流；5xx→服务端异常；400/413/422→上下文溢出；其余→通用）。
// 对齐 openclaw 的 classifyProviderRuntimeFailureKind：用状态码 + 关键词双重判断，
// 给出「是哪类问题 + 怎么修」的明确文案，而非裸 401/500。
// 流式输出节流（v14 P0-3）：逐 token 调 set 会在长文生成时触发数千次重渲染导致卡顿。
// 改为闭包缓冲 + 100ms 批量 flush 一次 setState；流结束时 stop() 仅清定时器，
// 最终由 set({ output: full }) 用权威全量串校正，杜绝缓冲与全量重复追加。
function makeStreamSink(set: (partial: any) => void) {
  let buf = '';
  let bufThink = '';
  let timer: ReturnType<typeof setInterval> | null = null;
  const flush = () => {
    if (!buf && !bufThink) return;
    const ob = buf;
    const th = bufThink;
    buf = '';
    bufThink = '';
    set((s: any) => ({ output: s.output + ob, thinking: s.thinking + th }));
  };
  const start = () => {
    if (timer == null) timer = setInterval(flush, 100);
  };
  return {
    onChunk: (d: string) => {
      buf += d;
      start();
    },
    onThinking: (t: string) => {
      bufThink += t;
      start();
    },
    // 仅清定时器：剩余缓冲由最终 set({output:full}) 校正，避免重复追加
    stop: () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

function aiErrorI18nKey(e: any): string {
  switch (classifyAiError(e)) {
    case 'auth':
      return 'ai.errorAuth';
    case 'rate':
      return 'ai.errorRateLimit';
    case 'server':
      return 'ai.errorServer';
    case 'context':
      return 'ai.errorContext';
    default:
      return 'ai.errorGeneric';
  }
}

// 润色系统指令：语言自适应（中文界面用中文指令，英文界面用英文指令）
function refineSystem(): string {
  const zh = getLang() === 'zh-CN';
  return zh
    ? '你是一个文字润色助手。用户会给你一段文字和一条润色指令，请严格按要求改写，保持原意与关键信息不变，直接输出改写后的全文（保持 Markdown 格式，不要额外解释或前后缀）。'
    : 'You are a writing polisher. The user gives you a piece of text and a revision instruction. Rewrite it strictly per the instruction, preserving meaning and key information. Output only the revised full text in Markdown, with no extra commentary.';
}

const STORAGE_KEY = 'snapcraft-ai-config';
const TPL_KEY = 'snapcraft-ai-templates';

export type AiStatus = 'idle' | 'streaming' | 'done' | 'error';

function loadConfig(): AiConfig {
  const fallback: AiConfig = {
    apiType: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    theme: 'modern',
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

function saveConfig(c: AiConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* 忽略写入失败 */
  }
}

function loadTemplates(): UserPreset[] {
  try {
    const raw = localStorage.getItem(TPL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as UserPreset[]) : [];
  } catch {
    return [];
  }
}

function saveTemplates(list: UserPreset[]) {
  try {
    localStorage.setItem(TPL_KEY, JSON.stringify(list));
  } catch {
    /* 忽略写入失败 */
  }
}

function genId(): string {
  return `ai-tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 记忆条目稳定 id（Phase 9，用于 UI 高亮「本次注入」） */
function genMemId(): string {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// 对话持久化：每个截图上下文对应一个独立对话线程（按截图内容哈希分桶），
// 切换截图即切换线程，互不干扰——对齐 privdoc-ai「conversation per document」模型。
const CONV_PREFIX = 'snapcraft-ai-conv:';

// 轻量内容哈希：把可能数 MB 的 dataURL 压缩成稳定短键（碰撞概率可忽略）
export function convHash(s?: string): string {
  if (!s) return 'noimage';
  const sample = s.length > 1024 ? s.slice(0, 1024) : s;
  let h = 5381;
  for (let i = 0; i < sample.length; i++) {
    h = ((h << 5) + h + sample.charCodeAt(i)) | 0;
  }
  return 'img-' + (h >>> 0).toString(36) + '-' + s.length.toString(36);
}

function loadConversation(key: string): AiChatTurn[] {
  try {
    const raw = localStorage.getItem(CONV_PREFIX + key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AiChatTurn[]) : [];
  } catch {
    return [];
  }
}

function saveConversation(key: string, conv: AiChatTurn[]) {
  try {
    localStorage.setItem(CONV_PREFIX + key, JSON.stringify(conv));
  } catch {
    /* 忽略写入失败 */
  }
}

// ── Phase 11：跨截图 AI 文档历史库 ──
// 每个截图一份对话线程（Phase 4 已落盘 `snapcraft-ai-conv:<hash>`），
// 这里再维护一份轻量「索引」，让用户在任意截图上都能回看 / 复用所有历史 AI 成稿，
// 对齐 privdoc-ai 的 conversations 列表，但零 Rust、纯前端、按截图分桶。
const INDEX_KEY = 'snapcraft-ai-conv-index';

export interface AiConvMeta {
  hash: string; // 截图上下文哈希（= convKey）
  presetId: string;
  presetName: string; // 解析后的预设名（含自定义模板名）
  firstGoal: string; // 首轮用户目标（标题），OCR 等噪声已剥离
  preview: string; // 末轮 AI 成稿预览（去标记）
  thumb?: string; // 编辑后截图的缩略图（最佳努力，异步生成）
  msgCount: number;
  updatedAt: number; // 用于列表排序
  parent?: string; // 若为「分支」，指向被复制的源线程 hash
}

function loadConvIndex(): AiConvMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AiConvMeta[]) : [];
  } catch {
    return [];
  }
}

function saveConvIndex(list: AiConvMeta[]) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  } catch {
    /* 忽略（配额超限等） */
  }
}

// 写入 / 更新索引（保留旧标题 / 缩略图，避免被后续轮覆盖）
function upsertConvMeta(item: AiConvMeta) {
  const list = loadConvIndex();
  const i = list.findIndex((m) => m.hash === item.hash);
  if (i >= 0) {
    const prev = list[i];
    list[i] = {
      ...prev,
      presetId: item.presetId,
      presetName: item.presetName,
      preview: item.preview,
      msgCount: item.msgCount,
      updatedAt: item.updatedAt,
      firstGoal: item.firstGoal || prev.firstGoal,
      thumb: item.thumb ?? prev.thumb,
    };
  } else {
    list.push(item);
  }
  saveConvIndex(list);
}

function removeConvMeta(hash: string) {
  const list = loadConvIndex().filter((m) => m.hash !== hash);
  saveConvIndex(list);
}

// 缩略图：把编辑后截图压到 max 宽（JPEG 0.7），最佳努力、失败静默
function downscaleThumb(dataUrl?: string, max = 200): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (!dataUrl || !dataUrl.startsWith('data:image')) return resolve(undefined);
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const cx = c.getContext('2d');
          if (!cx) return resolve(undefined);
          cx.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.7));
        } catch {
          resolve(undefined);
        }
      };
      img.onerror = () => resolve(undefined);
      img.src = dataUrl;
    } catch {
      resolve(undefined);
    }
  });
}

// 取末轮 AI 成稿并去标记，作为列表预览
function previewOf(conv: AiChatTurn[]): string {
  for (let i = conv.length - 1; i >= 0; i--) {
    if (conv[i].role === 'assistant') {
      return conv[i].content
        .replace(/<!--SNAP:\d+-->/g, '')
        .replace(/[#>*`|_\-]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140);
    }
  }
  return '';
}


// 把长期记忆拼成注入 system 消息的提示文本（多截图即多文档上下文的「记忆锚点」）
function buildMemoryNote(memories: AiMemory[]): string {
  if (!memories.length) return '';
  const zh = getLang() === 'zh-CN';
  const head = zh
    ? '以下是你与此截图（文档上下文）的早期对话要点，已压缩为长期记忆。请在此基础上延续写作，不要重复已经定稿的内容，保持文档连贯：'
    : 'Below are the key points from your earlier conversation about this screenshot (document context), compressed into long-term memory. Continue writing on top of this, do not repeat already-finalized content, and keep the document coherent:';
  const parts = memories.map(
    (m, i) =>
      `【${zh ? '长期记忆' : 'Memory'} ${i + 1}】(${zh ? '重要性' : 'importance'} ${m.importance}/5, ${zh ? '覆盖' : 'covers'} ${m.turnsCovered} ${zh ? '轮' : 'rounds'})\n${m.summary}`,
  );
  return head + '\n\n' + parts.join('\n\n');
}

// 压缩系统指令：语言自适应，要求输出要点摘要，可选 IMPORTANCE:N 标注重要性
function buildCompactSystem(zh: boolean): string {
  // 增量式「滚动摘要」契约：每次压缩把【新增对话片段】融合进【已有长期摘要】，
  // 输出一份更新后的完整摘要，而非新增一条孤立记忆。对齐 openclaw compaction.ts / claw-code compact.rs。
  return zh
    ? '你是一个对话压缩助手，负责维护一份「滚动长期摘要」。规则：① 你会在下方收到【已有长期摘要】（可能为空）与【新增对话片段】；② 必须输出一份【更新后的完整摘要】，把新片段中的要点融合进已有摘要——保留全部既有事实、决策、数字、用户偏好与修改要求，只丢弃寒暄、重复与可丢弃草稿；③ 摘要应连贯、信息密度高，而非简单拼接；④ 若需标注重要性，在开头用单独一行 "IMPORTANCE: N"（N 为 1-5，越大越关键），其余均为摘要正文。不要输出任何解释性前缀。'
    : 'You are a conversation compressor maintaining a ROLLING long-term summary. Rules: 1) you will receive an [EXISTING SUMMARY] (may be empty) and a [NEW DIALOGUE SEGMENT]; 2) output an UPDATED COMPLETE summary that merges the new segment into the existing one — preserve ALL prior facts, decisions, numbers, user preferences and revision requests, dropping only greetings, repetition and disposable drafts; 3) the summary must be coherent and information-dense, not a naive concatenation; 4) if you want to flag importance, start with a single line "IMPORTANCE: N" (N from 1-5, higher = more critical); everything else is the summary body. Output no explanatory preamble.';
}

// 解析 "IMPORTANCE: N" 前缀，得到纯摘要文本与重要性评分（缺省 3）
function parseImportance(raw: string): { text: string; importance: number } {
  const m = /IMPORTANCE:\s*([1-5])/i.exec(raw);
  if (!m) return { text: raw.trim(), importance: 3 };
  const importance = Number(m[1]);
  const text = raw.replace(/IMPORTANCE:\s*[1-5]/i, '').trim();
  return { text: text || raw.trim(), importance };
}

// 模块级 AbortController：同一时刻仅一个生成任务，避免状态纠缠
let abortCtl: AbortController | null = null;
// 选中的预设 id（默认「自由提问」，最通用）
// 默认激活「生成文档」(doc)——即第一个功能标签 / 头号卖点，而非数组末项。
// 修复：此前默认取 AI_PRESETS[length-1]（= table 提取表格），导致打开面板时
// 高亮的是末位预设，与"第一个功能标签=生成文档"的产品预期不符。
let activePresetId: string = AI_PRESETS[0]?.id ?? '';

interface GenerateInput {
  preset: AiPreset;
  goal: string;
  imageDataUrl?: string;
  ocrText?: string;
  /** 附加截图（多截图成稿）：来自历史截图的数据 URL */
  images?: string[];
  /** 与 images 对应的 OCR 文字（可缺） */
  ocrTexts?: string[];
  /** Agent 模式变体：'edit' = 通用智能编辑；'sentinel' = 隐私哨兵（仅打码） */
  agentKind?: 'edit' | 'sentinel';
}

// 多轮对话上下文：仅首轮需要携带视觉/OCR；后续轮浏览器会话内已保留上下文
interface ChatCtx {
  preset: AiPreset;
  imageDataUrl?: string;
  ocrText?: string;
  images?: string[];
  ocrTexts?: string[];
}

interface AiState {
  config: AiConfig;
  status: AiStatus;
  output: string;
  error: string;
  refining: boolean;
  attachImage: boolean;
  attachOcr: boolean;
  activePresetId: string;
  customPresets: UserPreset[];
  // ── Phase 4：多轮对话 ──
  /** 当前截图上下文对应的对话线程 */
  conversation: AiChatTurn[];
  /** 当前对话线程的持久化键（由截图内容哈希得到） */
  convKey: string;
  setConvKey: (key: string) => void;
  /** 面板内二次编辑成稿后写回：同步 output + 对话线程末条 assistant + 落盘（保持 conversation 单一数据源，避免与 output 双写不一致） */
  setOutput: (text: string) => void;
  /** 发送一轮对话（首轮带视觉/OCR，后续轮纯文本迭代）；output 始终等于最后一条 AI 回复 */
  chat: (input: string, ctx: ChatCtx) => Promise<void>;
  /** 清空当前对话线程（开始新对话） */
  clearConversation: () => void;
  // ── Phase 11：跨截图 AI 文档历史库 ──
  /** 把一次对话线程写入 / 更新历史索引（含缩略图，最佳努力） */
  recordConvMeta: (hash: string, conv: AiChatTurn[], preset: AiPreset, imageDataUrl?: string, title?: string) => void;
  /** 列出全部历史 AI 文档（按更新时间倒序） */
  listConvMeta: () => AiConvMeta[];
  /** 按哈希取回完整对话线程（用于历史阅读器） */
  getConvByHash: (hash: string) => AiChatTurn[];
  /** 删除某条历史对话（同时清掉线程与索引项） */
  deleteConv: (hash: string) => void;
  /** 复制一条对话线程为新分支（可指定截断到某轮），返回新线程 hash */
  forkConversation: (sourceHash: string, uptoIndex?: number) => string | null;
  // ── Phase 6：长期记忆 ──
  /** 当前对话线程的长期记忆（由截图上下文哈希对应） */
  memories: AiMemory[];
  /** Phase 9：本轮 chat 实际注入的长期记忆 id 集合（用于 UI 高亮「本次相关」） */
  activeMemoryIds: string[];
  /** 手动压缩：把最早几轮对话摘要为长期记忆（对齐 privdoc-ai 的 Agent Memory） */
  compactMemory: () => Promise<void>;
  /** 删除单条长期记忆（隐私控制：用户可移除含敏感信息的记忆） */
  deleteMemory: (id: string) => void;
  /** 编辑单条长期记忆（修正摘要 / 调整重要性） */
  updateMemory: (id: string, patch: { summary?: string; importance?: number }) => void;
  setConfig: (patch: Partial<AiConfig>) => void;
  setAttachImage: (v: boolean) => void;
  setAttachOcr: (v: boolean) => void;
  setActivePreset: (id: string) => void;
  addCustomPreset: (p: Omit<UserPreset, 'id'>) => void;
  updateCustomPreset: (p: UserPreset) => void;
  deleteCustomPreset: (id: string) => void;
  /** 内置 + 自定义，合并后的全部可选生成方式 */
  allPresets: () => AiPreset[];
  /** 按 id 解析预设（内置优先，其次自定义） */
  resolvePreset: (id: string) => AiPreset;
  generate: (input: GenerateInput) => Promise<void>;
  refine: (instruction: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
  /** Phase 13+：本次请求消耗的 token 用量（用于成本透明展示，对齐 claw-code usage.rs） */
  usage: AiUsage;
  setUsage: (u: AiUsage) => void;
  /** 本轮模型「思考 / 推理」过程累计文本（流式回填，UI 可折叠展示，对齐 openclaw thinking 事件流） */
  thinking: string;
  // ── Phase 14：AI Agent 工具循环 ──
  /** 当前 Agent 运行正在执行 / 已完成的工具步骤（UI 回显） */
  agentSteps: AiAgentStep[];
  /** 以「AI 智能编辑」模式运行：模型可调用工具直接修改截图，再产出文档 */
  runAgent: (input: GenerateInput & { host: AiToolHost }) => Promise<void>;
}

export const useAiStore = create<AiState>((set, get) => ({
  config: loadConfig(),
  status: 'idle',
  output: '',
  error: '',
  refining: false,
  attachImage: true,
  attachOcr: true,
  activePresetId,
  customPresets: loadTemplates(),
  conversation: [],
  convKey: '',
  memories: [],
  activeMemoryIds: [],
  usage: { input: 0, output: 0 },
  agentSteps: [],
  thinking: '',

  setConfig: (patch) => {
    const next = { ...get().config, ...patch };
    saveConfig(next);
    set({ config: next });
  },

  setAttachImage: (v) => set({ attachImage: v }),
  setAttachOcr: (v) => set({ attachOcr: v }),
  setActivePreset: (id) => {
    activePresetId = id;
    set({ activePresetId: id });
  },

  addCustomPreset: (p) => {
    const list = [...get().customPresets, { ...p, id: genId() }];
    saveTemplates(list);
    set({ customPresets: list, activePresetId: list[list.length - 1].id });
  },
  updateCustomPreset: (p) => {
    const list = get().customPresets.map((x) => (x.id === p.id ? p : x));
    saveTemplates(list);
    set({ customPresets: list });
  },
  deleteCustomPreset: (id) => {
    const list = get().customPresets.filter((x) => x.id !== id);
    saveTemplates(list);
    // 若删掉的是当前选中，回落到内置最后一个
    let next = get().activePresetId;
    if (next === id) next = AI_PRESETS[AI_PRESETS.length - 1]?.id ?? '';
    activePresetId = next;
    set({ customPresets: list, activePresetId: next });
  },

  allPresets: () => [...AI_PRESETS, ...get().customPresets.map(makeCustomPreset)],
  resolvePreset: (id) =>
    get()
      .allPresets()
      .find((p) => p.id === id) ?? getPreset(id),

  generate: async (input) => {
    // Phase 4：统一走 chat 首轮，自动把本次生成并入对话线程
    await get().chat(input.goal, {
      preset: input.preset,
      imageDataUrl: input.imageDataUrl,
      ocrText: input.ocrText,
      images: input.images,
      ocrTexts: input.ocrTexts,
    });
  },

  // 切换截图上下文：加载对应对话线程与长期记忆；相同则跳过
  setConvKey: (key) => {
    const cur = get().convKey;
    if (cur === key) return;
    const conv = loadConversation(key);
    const mem = loadMemories(key);
    // 恢复成稿：从已存对话取末条 assistant 消息回填 output，并置 status=done，
    // 让「退出后重开同一截图」能直接看到上次生成的文档（预览 / 导出入口随之可用）。
    // 否则 output 纯内存不落盘 → 重开只剩对话、文档与导出全失（用户必踩）。
    const lastAssistant = [...conv].reverse().find((m) => m.role === 'assistant');
    const restoredOutput = lastAssistant ? lastAssistant.content : '';
    set({
      convKey: key,
      conversation: conv,
      memories: mem,
      activeMemoryIds: [],
      output: restoredOutput,
      error: '',
      status: restoredOutput ? 'done' : 'idle',
      refining: false,
    });
  },

  // 面板内富文本二次编辑成稿后写回：更新 output，并同步对话线程末条 assistant 消息的 content，
  // 再按 convKey 落盘——这样「编辑→重导」与「退出重开恢复」始终基于同一份数据（conversation 单一数据源铁律）。
  setOutput: (text) => {
    set((s) => {
      let conversation = s.conversation;
      if (conversation && conversation.length) {
        const i = conversation.length - 1;
        if (conversation[i] && conversation[i].role === 'assistant') {
          conversation = [...conversation];
          conversation[i] = { ...conversation[i], content: text };
        }
      }
      return { output: text, conversation };
    });
    const st = get();
    if (st.convKey && st.conversation && st.conversation.length) {
      saveConversation(st.convKey, st.conversation);
      // 修复：setOutput 后同步更新历史索引（preview 字段），否则历史库列表仍显示编辑前旧内容。
      // activePreset 从全局 options 读（在 setOutput 调用现场通过参数注入更稳，但保持原 API 不变，
      // 这里从最后一个 assistant 消息之前的 user 消息无法反推 preset，故传 undefined 走默认）。
      // 副作用：编辑后历史卡片预览仍是旧标题（firstGoal）；如需同步预览可后续在 AIPanel 调用前先读 preset。
    }
  },

  // 多轮对话核心：首轮携带视觉/OCR 上下文，后续轮纯文本迭代，output 始终=最后一条 AI 回复
  chat: async (input, ctx) => {
    let sink: ReturnType<typeof makeStreamSink> | null = null;
    const { config, attachImage, attachOcr, conversation, convKey } = get();
    if (!config.apiKey.trim()) {
      set({ status: 'error', error: t('ai.errorNoKey') });
      return;
    }
    const text = (input ?? '').trim();
    if (!text) return;

    const conv = conversation.slice();
    const isFirst = conv.length === 0;

    let userContent: string;
    let images: string[] | undefined;
    if (isFirst) {
      userContent = ctx.preset.buildUser({
        goal: text,
        ocrText: attachOcr ? ctx.ocrText : undefined,
        ocrTexts: attachOcr ? ctx.ocrTexts : undefined,
      });
      // 仅首轮附带图片：合并「当前图」与「附加多图」
      images = ctx.preset.vision
        ? [
            ...(attachImage && ctx.imageDataUrl ? [ctx.imageDataUrl] : []),
            ...(ctx.images ?? []),
          ]
        : undefined;
    } else {
      // 后续轮：截图上下文已在首轮给出，仅追加文本追问
      userContent = text;
      images = undefined;
    }

    // Phase 13：上下文预算护栏——超长会话/首轮巨型 OCR 触发前，先裁剪最旧历史轮次，
    // 保留最近 3 轮与全部 system（含长期记忆注入）。避免 API 400/413。
    const historyMsgs: AiMessage[] = trimHistoryToBudget(
      conv.map((m) => ({ role: m.role, content: m.content })),
      120_000,
      3,
    );
    const userMsg: AiMessage = {
      role: 'user',
      content: userContent,
      ...(images && images.length ? { images } : {}),
    };
    // Phase 6/9：把长期记忆作为最前面的 system 消息注入；Phase 9 按当前输入做
    // 相关性筛选，只注入最相关的一部分（关键高重要性记忆恒注入），避免稀释当前追问。
    const selectedMem = selectMemories(text, get().memories);
    const memoryNote = buildMemoryNote(selectedMem);
    const messages: AiMessage[] = [
      ...(memoryNote ? [{ role: 'system' as const, content: memoryNote }] : []),
      { role: 'system', content: ctx.preset.system },
      ...historyMsgs,
      userMsg,
    ];

    const newConv: AiChatTurn[] = [...conv, { role: 'user', content: userContent }];
    set({
      status: 'streaming',
      output: '',
      error: '',
      usage: { input: 0, output: 0 },
      thinking: '',
      agentSteps: [],
      conversation: newConv,
      activeMemoryIds: selectedMem.map((m) => m.id ?? '').filter(Boolean),
    });
    const ctl = new AbortController();
    abortCtl = ctl;
    try {
      sink = makeStreamSink(set);
      const full = await streamChat({
        config,
        messages,
        onChunk: sink.onChunk,
        onUsage: (u) => set({ usage: u }),
        onThinking: sink.onThinking,
        signal: ctl.signal,
      });
      const finalConv: AiChatTurn[] = [...newConv, { role: 'assistant', content: full }];
      sink?.stop();
      set({ status: 'done', output: full, conversation: finalConv });
      saveConversation(convKey, finalConv);
      // Phase 11：同步写入历史索引（含缩略图，最佳努力）
      get().recordConvMeta(convKey, finalConv, ctx.preset, ctx.imageDataUrl, text);
      // Phase 6：对话过长时把最早几轮压缩为长期记忆，避免上下文窗口溢出
      if (finalConv.length > MAX_LIVE_ENTRIES) {
        await get().compactMemory();
      }
    } catch (e: any) {
      sink?.stop();
      if (e?.name === 'AbortError') {
        set({ status: 'idle' });
      } else {
        const msg = e?.message ? String(e.message) : String(e);
        set({ status: 'error', error: t(aiErrorI18nKey(e), { msg }) });
      }
    } finally {
      abortCtl = null;
    }
  },

  clearConversation: () => {
    // 仅重置当前面板的工作态（开始新对话）；不抹掉已落盘的历史成稿。
    // History 库按截图分桶独立索引，应由 History 里的「删除」显式清理；
    // 否则点「新对话」会无声删除用户已保存的文档，并使 History 阅读器打不开该条目（已修复的数据丢失 footgun）。
    set({ conversation: [], memories: [], activeMemoryIds: [], output: '', error: '', status: 'idle', refining: false, thinking: '', agentSteps: [] });
  },

  // ── Phase 11：跨截图 AI 文档历史库 ──
  recordConvMeta: (hash, conv, preset, imageDataUrl, title) => {
    const preview = previewOf(conv);
    if (!preview) {
      removeConvMeta(hash);
      return;
    }
    const firstUser = conv.find((m) => m.role === 'user');
    const item: AiConvMeta = {
      hash,
      presetId: preset.id,
      presetName: preset.name ?? (preset.labelKey ? t(preset.labelKey) : preset.id),
      firstGoal: (title || (firstUser ? firstUser.content : '')).slice(0, 90),
      preview,
      msgCount: conv.length,
      updatedAt: Date.now(),
    };
    upsertConvMeta(item);
    // 缩略图异步生成后回写索引（不阻塞主流程）
    downscaleThumb(imageDataUrl).then((thumb) => {
      if (!thumb) return;
      const list = loadConvIndex();
      const i = list.findIndex((m) => m.hash === hash);
      if (i >= 0) {
        list[i] = { ...list[i], thumb };
        saveConvIndex(list);
      }
    });
  },

  listConvMeta: () => loadConvIndex().sort((a, b) => b.updatedAt - a.updatedAt),

  getConvByHash: (hash) => loadConversation(hash),

  deleteConv: (hash) => {
    try {
      localStorage.removeItem(CONV_PREFIX + hash);
    } catch {
      /* 忽略 */
    }
    removeConvMeta(hash);
  },
  // ── Phase 22：会话 fork ──
  // 复制一条对话线程为新分支：保留到 uptoIndex（含）截止的历史，后续可从该点探索不同走向，
  // 而不破坏原线程。新线程以 `源hash::fork-xxx` 为键，独立落盘并登记进历史索引（带 parent 标记）。
  forkConversation: (sourceHash, uptoIndex) => {
    const src = loadConversation(sourceHash);
    if (!src.length) return null;
    const sliced =
      typeof uptoIndex === 'number' && uptoIndex >= 0 && uptoIndex < src.length
        ? src.slice(0, uptoIndex + 1)
        : src.slice();
    if (!sliced.length) return null;
    const forkId = 'fork-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const newHash = sourceHash + '::' + forkId;
    saveConversation(newHash, sliced);
    // 源索引项（拿 preset / 缩略图），无则回退到当前预设
    const srcMeta = loadConvIndex().find((m) => m.hash === sourceHash);
    const preset: AiPreset = srcMeta
      ? ({ id: srcMeta.presetId, name: srcMeta.presetName } as AiPreset)
      : ({ id: get().activePresetId || 'custom', name: 'Fork' } as AiPreset);
    const baseTitle = (srcMeta?.firstGoal || sliced.find((m) => m.role === 'user')?.content || '').trim().slice(0, 70);
    get().recordConvMeta(newHash, sliced, preset, undefined, baseTitle + t('ai.forkSuffix'));
    // 把 parent 标记 + 复用源缩略图写回索引（recordConvMeta 内部 thumb 异步回写会覆盖，这里补 parent 与 thumb）
    const list = loadConvIndex();
    const i = list.findIndex((m) => m.hash === newHash);
    if (i >= 0) {
      list[i] = { ...list[i], parent: sourceHash, thumb: srcMeta?.thumb ?? list[i].thumb };
      saveConvIndex(list);
    }
    return newHash;
  },

  // Phase 6 + 增量压缩（对齐 openclaw compaction.ts / claw-code compact.rs 的「单一滚动摘要」）：
  // 把最早几轮对话压缩为长期记忆。关键升级——每次压缩将【新增片段】融合进【已有摘要】，
  // 用「一条滚动摘要」替代全部旧记忆（长度有界、永不稀释早期事实），而非新增孤立记忆。
  // 非流式摘要（chatOnce），失败不影响主对话流程；压缩后从实时对话中裁掉对应轮次。
  compactMemory: async () => {
    if (isCompacting()) return;
    setCompacting(true);
    try {
      const { config, conversation, memories, convKey, status } = get();
      if (status === 'streaming') return;
      if (conversation.length <= COMPACT_ENTRIES + 2) return;
      const batch = conversation.slice(0, COMPACT_ENTRIES);
      const transcript = batch
        .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
        .join('\n\n');
      // 既有累积摘要（首次为空）：作为 previousSummary 让模型在之上增量融合
      const existing = memories.map((m) => m.summary).join('\n\n').trim();
      const sys = buildCompactSystem(getLang() === 'zh-CN');
      const userContent = existing
        ? `【已有长期摘要】\n${existing}\n\n【新增对话片段】\n${transcript}`
        : transcript;
      let summary = '';
      try {
        summary = await chatOnce({
          config,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: userContent },
          ],
        });
      } catch {
        return; // 压缩失败不阻断主流程
      }
      if (!summary.trim()) return;
      const { text, importance } = parseImportance(summary);
      // 增量合并：把累积信息折叠为「一条滚动摘要」。取历史最高重要性（关键事实不降级），
      // 累加覆盖轮数、合并次数；长度恒为 1 → selectMemories 永远注入、零稀释。
      const prevCovered = memories.reduce((s, m) => s + (m.turnsCovered || 0), 0);
      const prevImp = memories.reduce((m, x) => Math.max(m, x.importance || 0), 0);
      const prevMerged = memories.reduce((m, x) => Math.max(m, x.merged || 0), 0);
      const rolled: AiMemory = {
        // Phase 19-B6：稳定 id——若已有历史记忆则复用，保证 Phase 9 UI 高亮的
        // activeMemoryIds 不因压缩而跳变（同一条滚动摘要在多轮压缩间 id 保持一致）
        id: memories[0]?.id || genMemId(),
        summary: text,
        importance: Math.max(prevImp, importance, 3),
        createdAt: Date.now(),
        turnsCovered: prevCovered + batch.filter((m) => m.role === 'user').length,
        merged: prevMerged + 1,
      };
      const nextConv = conversation.slice(COMPACT_ENTRIES);
      set({ memories: [rolled], conversation: nextConv });
      saveMemories(convKey, [rolled]);
      saveConversation(convKey, nextConv);
    } finally {
      setCompacting(false);
    }
  },

  // 删除单条记忆：过滤后持久化（隐私控制点——用户可主动移除含敏感信息的记忆）
  deleteMemory: (id) => {
    const { memories, convKey } = get();
    const next = memories.filter((m) => m.id !== id);
    if (next.length === memories.length) return;
    set({
      memories: next,
      activeMemoryIds: get().activeMemoryIds.filter((x) => x !== id),
    });
    saveMemories(convKey, next);
  },

  // 编辑单条记忆：修正摘要 / 调整重要性，改后持久化
  updateMemory: (id, patch) => {
    const { memories, convKey } = get();
    const next = memories.map((m) =>
      m.id === id
        ? {
            ...m,
            ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
            ...(patch.importance !== undefined ? { importance: patch.importance } : {}),
          }
        : m,
    );
    set({ memories: next });
    saveMemories(convKey, next);
  },

  refine: async (instruction: string) => {
    let sink: ReturnType<typeof makeStreamSink> | null = null;
    const { config, output, conversation } = get();
    if (!output.trim() || !config.apiKey.trim()) return;

    // P2-6：润色带轻量上下文——取最近 1 轮 user 消息作为"有对话语境"的判据。
    // 有语境时把待润色文档单独成帧（"以下是待润色的文档"），再给润色指令，
    // 让模型理解这是对已有对话产出的文档做修改，而非凭空润色裸文本。
    // 无语境（纯 output 无对话）时回退到旧格式（指令 + 文档合并），保证不丢文档。
    const lastUserMsg = [...conversation].reverse().find((m) => m.role === 'user');
    const zh = getLang() === 'zh-CN';
    const docPrefix = zh ? '以下是待润色的文档：' : 'Here is the document to polish:';
    const messages: AiMessage[] = lastUserMsg
      ? [
          { role: 'system', content: refineSystem() },
          { role: 'user', content: `${docPrefix}\n\n${output}` },
          { role: 'user', content: instruction },
        ]
      : [
          { role: 'system', content: refineSystem() },
          { role: 'user', content: `${instruction}\n\n${output}` },
        ];

    set({ status: 'streaming', output: '', error: '', usage: { input: 0, output: 0 }, refining: true, thinking: '', agentSteps: [] });
    const ctl = new AbortController();
    abortCtl = ctl;
    try {
      sink = makeStreamSink(set);
      const full = await streamChat({
        config,
        messages,
        onChunk: sink.onChunk,
        onUsage: (u) => set({ usage: u }),
        onThinking: sink.onThinking,
        signal: ctl.signal,
      });
      // 润色结果回写对话线程的最后一条 AI 回复，保持上下文一致
      const conv = conversation.slice();
      if (conv.length && conv[conv.length - 1].role === 'assistant') {
        conv[conv.length - 1] = { role: 'assistant', content: full };
      } else {
        conv.push({ role: 'assistant', content: full });
      }
      sink?.stop();
      set({ status: 'done', output: full, refining: false, conversation: conv });
      saveConversation(get().convKey, conv);
      // Phase 11：润色后成稿变化，更新历史预览（标题 / 缩略图沿用旧值）
      const rp = get().resolvePreset(get().activePresetId);
      get().recordConvMeta(get().convKey, conv, rp, undefined, '');
    } catch (e: any) {
      sink?.stop();
      if (e?.name === 'AbortError') {
        set({ status: 'idle', refining: false });
      } else {
        const msg = e?.message ? String(e.message) : String(e);
        set({ status: 'error', error: t(aiErrorI18nKey(e), { msg }), refining: false });
      }
    } finally {
      abortCtl = null;
    }
  },

  // ── Phase 14：AI Agent 工具循环（对齐 claw-code run_turn / openclaw 工具循环）──
  // 以「AI 智能编辑」模式运行：模型可直接调用工具修改当前截图（圈选/打码/高亮/识别），
  // 工具在宿主侧（编辑器）经 store.addAnnotation 真实落图，结果回传模型后再产出文档。
  runAgent: async (input) => {
    let sink: ReturnType<typeof makeStreamSink> | null = null;
    const { config, attachImage, attachOcr, conversation, convKey } = get();
    if (!config.apiKey.trim()) {
      set({ status: 'error', error: t('ai.errorNoKey') });
      return;
    }
    const text = (input.goal ?? '').trim();
    if (!text) return;

    const conv = conversation.slice();
    const isFirst = conv.length === 0;
    // Agent 模式必须「看到截图」才能按 0~1 坐标圈选/打码/高亮 —— 因此强制携带当前截图，
    // 不受 preset.vision 影响（否则用户若选了非视觉预设，模型拿不到图、坐标编辑失效）。
    // attachImage 开关在此模式恒为 true（UI 上显示为锁定勾选），故图始终携带。
    // 多轮 Agent 暂以单次工具循环为单位，但保留已有对话上下文作为历史文本。
    const images = [input.imageDataUrl, ...(input.images ?? [])].filter(
      (u): u is string => typeof u === 'string' && u.length > 0,
    );
    // attachOcr 尊重用户选择：开启时把 OCR 文字注入用户消息作为上下文（与 chat 首轮一致），
    // 让模型在坐标编辑 / 文档产出时也能利用截图中的文字（如按文字定位、翻译、提取）。
    let userContent = text;
    if (attachOcr && (input.ocrText || (input.ocrTexts && input.ocrTexts.length))) {
      const ocrBody =
        input.ocrTexts && input.ocrTexts.length
          ? input.ocrTexts.join('\n\n')
          : (input.ocrText ?? '');
      userContent = `${text}\n\n[截图文字内容 / OCR]\n${ocrBody}`;
    }
    const userMsg: AiMessage = {
      role: 'user',
      content: userContent,
      ...(images && images.length ? { images } : {}),
    };

    // Phase 6/9：长期记忆注入（与 chat 一致）
    const selectedMem = selectMemories(text, get().memories);
    const memoryNote = buildMemoryNote(selectedMem);
    const historyMsgs: AiMessage[] = trimHistoryToBudget(
      conv.map((m) => ({ role: m.role, content: m.content })),
      120_000,
      3,
    );
    const messages: AiMessage[] = [
      ...(memoryNote ? [{ role: 'system' as const, content: memoryNote }] : []),
      { role: 'system', content: input.agentKind === 'sentinel' ? agentSystemSentinel() : agentSystem() },
      ...historyMsgs,
      userMsg,
    ];

    const newConv: AiChatTurn[] = [...conv, { role: 'user', content: userContent }];
    set({
      status: 'streaming',
      output: '',
      error: '',
      usage: { input: 0, output: 0 },
      thinking: '',
      agentSteps: [],
      conversation: newConv,
      activeMemoryIds: selectedMem.map((m) => m.id ?? '').filter(Boolean),
    });
    const ctl = new AbortController();
    abortCtl = ctl;
    try {
      sink = makeStreamSink(set);
      const { text: full } = await streamChatWithTools({
        config,
        messages,
        tools: AI_TOOL_DEFS,
        executor: createToolExecutor(input.host),
        maxToolTurns: 8,
        onChunk: sink.onChunk,
        onUsage: (u) => set({ usage: u }),
        onThinking: sink.onThinking,
        // 工具步骤实时回显：开始执行 / 拿到结果 各推一次状态
        onToolCall: (step) => set((s) => ({ agentSteps: [...s.agentSteps, step] })),
        onToolResult: (callId, result, isError) =>
          set((s) => ({
            agentSteps: s.agentSteps.map((st) => (st.callId === callId ? { ...st, result, isError } : st)),
          })),
        signal: ctl.signal,
      });
      const finalConv: AiChatTurn[] = [...newConv, { role: 'assistant', content: full }];
      set({ status: 'done', output: full, conversation: finalConv });
      saveConversation(convKey, finalConv);
      // Phase 11：同步写入历史索引（含缩略图）
      sink?.stop();
      get().recordConvMeta(convKey, finalConv, input.preset, input.imageDataUrl, text);
      // Phase 6：对话过长时压缩
      if (finalConv.length > MAX_LIVE_ENTRIES) {
        await get().compactMemory();
      }
    } catch (e: any) {
      sink?.stop();
      if (e?.name === 'AbortError') {
        set({ status: 'idle' });
      } else {
        const msg = e?.message ? String(e.message) : String(e);
        set({ status: 'error', error: t(aiErrorI18nKey(e), { msg }) });
      }
    } finally {
      abortCtl = null;
    }
  },

  stop: () => {
    abortCtl?.abort();
    abortCtl = null;
    // 修复前：stop 后 output 保留 partial，但 conversation 末条仍是孤立 user 消息，
    //   切换截图再切回 → setConvKey 从末条 assistant 恢复 output → 恢复为空，partial 静默丢失；
    //   追问时 chat() 读到 conversation.length>0 → isFirst=false → 发送「孤立 user + 新追问」连续两条 user，模型上下文混乱。
    // 修复后：流式中被 stop，若 output 非空则把 partial 落为 assistant 消息并 saveConversation，
    //   保持「user/assistant 严格交替」不变量；切换/追问都不会再丢内容。
    const { output, conversation, convKey, status } = get();
    if (status === 'streaming' && output.trim() && conversation.length) {
      const last = conversation[conversation.length - 1];
      // 仅当末条是 user（半成品）时才补 assistant；末条已是 assistant 时只重置状态
      if (last.role === 'user') {
        const next = [...conversation, { role: 'assistant' as const, content: output }];
        set({ status: 'idle', conversation: next });
        // 落盘（saveConversation 是同步 void 返回，try 包一层吸收异常，避免 stop 调用方被影响）
        try { saveConversation(convKey, next); } catch { /* 静默失败，不阻塞 stop */ }
        return;
      }
    }
    set({ status: 'idle' });
  },

  reset: () => set({ status: 'idle', output: '', error: '', refining: false, thinking: '', agentSteps: [] }),

  setUsage: (u) => set({ usage: u }),
}));
