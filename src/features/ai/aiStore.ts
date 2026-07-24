// AI 助手状态：配置持久化 + 流式生成状态
// 配置（接口地址 / Key / 模型）仅持久化到本机浏览器 localStorage，
// 首版「前端直连」架构下密钥不下发到 Rust 侧（Phase 2 再考虑后端代理）。
//
// 2026-07-14 Phase 2b：
//  - 自定义预设（用户业务模板）持久化到 localStorage `snapcraft-ai-templates`，
//    与内置预设合并后作为可选的「生成方式」芯片。
//  - generate 支持「多截图成稿」：传入 images[] 与 ocrTexts[]，与当前图合并为
//    单条多模态 user 消息（仅当 preset.vision 为真时附带图片）。
//
// 2026-07-23 架构解耦重构：
//  - 持久化层提取至 lib/persistence.ts
//  - 历史索引管理提取至 lib/conversationIndex.ts
//  - 流式辅助/错误分类/记忆注入提取至 lib/streamHelpers.ts
//  - 本文件仅保留 Zustand store 编排逻辑（状态 + action 胶水）

import { create } from 'zustand';
import type { AiConfig, AiMessage, AiChatTurn, AiMemory, AiUsage, AiAgentStep } from './aiTypes';
import { streamChat, chatOnce, trimHistoryToBudget, streamChatWithTools } from './aiClient';
import { AI_TOOL_DEFS, createToolExecutor, agentSystem, agentSystemSentinel, type AiToolHost } from './aiTools';
import {
  AI_PRESETS,
  getPreset,
  makeCustomPreset,
  type AiPreset,
  type UserPreset,
} from './aiPresets';
import { t, getLang } from '../../i18n';
import { loadMemories, saveMemories, selectMemories, MAX_LIVE_ENTRIES, COMPACT_ENTRIES, isCompacting, setCompacting } from './aiMemory';

// 提取的子模块
import { loadConfig, saveConfig, loadTemplates, saveTemplates, loadConversation, saveConversation } from './lib/persistence';
import { recordConvMeta, listConvMeta, getConvByHash, deleteConv, forkConversation, type AiConvMeta } from './lib/conversationIndex';
import { makeStreamSink, aiErrorI18nKey, refineSystem, buildMemoryNote, buildCompactSystem, parseImportance, genId, genMemId } from './lib/streamHelpers';

// 重新导出供外部使用（保持向后兼容）
export { type AiConvMeta } from './lib/conversationIndex';

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

// 模块级 AbortController：同一时刻仅一个生成任务，避免状态纠缠
let abortCtl: AbortController | null = null;
// 默认激活「生成文档」(doc)——即第一个功能标签 / 头号卖点
let activePresetId: string = AI_PRESETS[0]?.id ?? '';

export type AiStatus = 'idle' | 'streaming' | 'done' | 'error';

interface GenerateInput {
  preset: AiPreset;
  goal: string;
  imageDataUrl?: string;
  ocrText?: string;
  images?: string[];
  ocrTexts?: string[];
  agentKind?: 'edit' | 'sentinel';
}

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
  conversation: AiChatTurn[];
  convKey: string;
  setConvKey: (key: string) => void;
  setOutput: (text: string) => void;
  chat: (input: string, ctx: ChatCtx) => Promise<void>;
  clearConversation: () => void;
  recordConvMeta: (hash: string, conv: AiChatTurn[], preset: AiPreset, imageDataUrl?: string, title?: string) => void;
  listConvMeta: () => AiConvMeta[];
  getConvByHash: (hash: string) => AiChatTurn[];
  deleteConv: (hash: string) => void;
  forkConversation: (sourceHash: string, uptoIndex?: number) => string | null;
  memories: AiMemory[];
  activeMemoryIds: string[];
  compactMemory: () => Promise<void>;
  deleteMemory: (id: string) => void;
  updateMemory: (id: string, patch: { summary?: string; importance?: number }) => void;
  setConfig: (patch: Partial<AiConfig>) => void;
  setAttachImage: (v: boolean) => void;
  setAttachOcr: (v: boolean) => void;
  setActivePreset: (id: string) => void;
  addCustomPreset: (p: Omit<UserPreset, 'id'>) => void;
  updateCustomPreset: (p: UserPreset) => void;
  deleteCustomPreset: (id: string) => void;
  allPresets: () => AiPreset[];
  resolvePreset: (id: string) => AiPreset;
  generate: (input: GenerateInput) => Promise<void>;
  refine: (instruction: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
  usage: AiUsage;
  setUsage: (u: AiUsage) => void;
  thinking: string;
  agentSteps: AiAgentStep[];
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
    await get().chat(input.goal, {
      preset: input.preset,
      imageDataUrl: input.imageDataUrl,
      ocrText: input.ocrText,
      images: input.images,
      ocrTexts: input.ocrTexts,
    });
  },

  setConvKey: (key) => {
    const cur = get().convKey;
    if (cur === key) return;
    const conv = loadConversation(key);
    const mem = loadMemories(key);
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
    }
  },

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
      images = ctx.preset.vision
        ? [
            ...(attachImage && ctx.imageDataUrl ? [ctx.imageDataUrl] : []),
            ...(ctx.images ?? []),
          ]
        : undefined;
    } else {
      userContent = text;
      images = undefined;
    }

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
      get().recordConvMeta(convKey, finalConv, ctx.preset, ctx.imageDataUrl, text);
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
    set({ conversation: [], memories: [], activeMemoryIds: [], output: '', error: '', status: 'idle', refining: false, thinking: '', agentSteps: [] });
  },

  // ── 历史库操作（委托给 lib/conversationIndex） ──
  recordConvMeta: (hash, conv, preset, imageDataUrl, title) => {
    recordConvMeta(hash, conv, preset, imageDataUrl, title);
  },
  listConvMeta: () => listConvMeta(),
  getConvByHash: (hash) => getConvByHash(hash),
  deleteConv: (hash) => deleteConv(hash),
  forkConversation: (sourceHash, uptoIndex) => forkConversation(sourceHash, uptoIndex, get().activePresetId),

  // ── 长期记忆 ──
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
        return;
      }
      if (!summary.trim()) return;
      const { text, importance } = parseImportance(summary);
      const prevCovered = memories.reduce((s, m) => s + (m.turnsCovered || 0), 0);
      const prevImp = memories.reduce((m, x) => Math.max(m, x.importance || 0), 0);
      const prevMerged = memories.reduce((m, x) => Math.max(m, x.merged || 0), 0);
      const rolled: AiMemory = {
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
      const conv = conversation.slice();
      if (conv.length && conv[conv.length - 1].role === 'assistant') {
        conv[conv.length - 1] = { role: 'assistant', content: full };
      } else {
        conv.push({ role: 'assistant', content: full });
      }
      sink?.stop();
      set({ status: 'done', output: full, refining: false, conversation: conv });
      saveConversation(get().convKey, conv);
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
    const images = [input.imageDataUrl, ...(input.images ?? [])].filter(
      (u): u is string => typeof u === 'string' && u.length > 0,
    );
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
      sink?.stop();
      get().recordConvMeta(convKey, finalConv, input.preset, input.imageDataUrl, text);
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
    const { output, conversation, convKey, status } = get();
    if (status === 'streaming' && output.trim() && conversation.length) {
      const last = conversation[conversation.length - 1];
      if (last.role === 'user') {
        const next = [...conversation, { role: 'assistant' as const, content: output }];
        set({ status: 'idle', conversation: next });
        try { saveConversation(convKey, next); } catch { /* 静默失败 */ }
        return;
      }
    }
    set({ status: 'idle' });
  },

  reset: () => set({ status: 'idle', output: '', error: '', refining: false, thinking: '', agentSteps: [] }),

  setUsage: (u) => set({ usage: u }),
}));
