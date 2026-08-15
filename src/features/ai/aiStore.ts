// AI assistant state: config persistence + streaming generation state
// Config (endpoint / key / model) is persisted only to the local browser localStorage,
// Under the initial "frontend direct-connect" architecture the key is not handed to the Rust side (backend proxy considered in Phase 2).
//
// 2026-07-14 Phase 2b：
//  - Custom presets (user business templates) are persisted to localStorage `snapcraft-ai-templates`,
//    merged with built-in presets and offered as selectable "generation mode" chips.
//  - generate supports "multi-screenshot doc": pass images[] and ocrTexts[] and merge with the current image into
//    a single multimodal user message (images attached only when preset.vision is true).
//
// 2026-07-23 architecture decoupling refactor:
//  - Persistence layer extracted to lib/persistence.ts
//  - History index management extracted to lib/conversationIndex.ts
//  - Streaming helpers / error classification / memory injection extracted to lib/streamHelpers.ts
//  - This file keeps only the Zustand store orchestration logic (state + action glue)

import { create } from 'zustand';
import type { AiConfig, AiMessage, AiChatTurn, AiMemory, AiUsage, AiAgentStep } from './aiTypes';
import { streamChat, chatOnce, trimHistoryToBudget, streamChatWithTools, estimateTokens, diagLogAi } from './aiClient';
import { AI_TOOL_DEFS, createToolExecutor, agentSystem, agentSystemSentinel, type AiToolHost } from './aiTools';
import { mergeAgents, BUILTIN_AGENTS, type AiAgent } from './aiAgents';
import {
  AI_PRESETS,
  getPreset,
  makeCustomPreset,
  type AiPreset,
  type UserPreset,
} from './aiPresets';
import { t, getLang } from '../../i18n';
import { useLicenseStore } from '../licensing/licenseStore';
import { useUpgradeDialogStore } from '../licensing/upgradeDialogStore';
import { loadMemories, saveMemories, selectMemories, MAX_LIVE_ENTRIES, COMPACT_ENTRIES, isCompacting, setCompacting } from './aiMemory';

// Extracted submodules
import { loadConfig, saveConfig, loadTemplates, saveTemplates, loadConversation, saveConversation, loadAgents, saveAgents, loadActiveAgent, saveActiveAgent } from './lib/persistence';
import { resolveConfig, defaultModelId, modelVisionSupport, findModel } from './providerConfig';
import { resolveModelLimits, fitFirstTurn, type FirstTurnFit } from './contextBudget';
import { recordConvMeta, listConvMeta, getConvByHash, deleteConv, forkConversation, type AiConvMeta } from './lib/conversationIndex';
import { makeStreamSink, aiErrorI18nKey, refineSystem, buildMemoryNote, buildCompactSystem, langOutputDirective, parseImportance, genId, genMemId } from './lib/streamHelpers';

// Re-exported for external use (kept for backward compatibility)
export { type AiConvMeta } from './lib/conversationIndex';

// Lightweight content hash: compress a potentially multi-MB dataURL into a stable short key (collision probability negligible)
export function convHash(s?: string): string {
  if (!s) return 'noimage';
  const sample = s.length > 1024 ? s.slice(0, 1024) : s;
  let h = 5381;
  for (let i = 0; i < sample.length; i++) {
    h = ((h << 5) + h + sample.charCodeAt(i)) | 0;
  }
  return 'img-' + (h >>> 0).toString(36) + '-' + s.length.toString(36);
}

// Module-level AbortController: only one generation task at a time, to avoid entangled state
let abortCtl: AbortController | null = null;
// Activate "generate document" (doc) by default — i.e. the first feature tab / headline selling point
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
  /** Part 2: pro Agent custom system prompt (takes priority over the agentKind fixed wording) */
  agentSystemPrompt?: string;
  /** Part 2: an Agent can bind a tool subset (AI_TOOL_DEFS.name list); empty = all */
  agentToolIds?: string[];
  /** Part 2: the model bound to the Agent (provider model id); empty = follow global endpoint settings */
  agentModelId?: string;
  /** Part 2: Agent temperature override (falls back to global config.temperature when unset) */
  agentTemperature?: number;
  /** Part 2: fallback model (provider model id); automatically used for one retry when the primary model call fails */
  agentFallbackModelId?: string;
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
  agents: AiAgent[];
  activeAgentId: string | null;
  setActiveAgent: (id: string | null) => void;
  upsertAgent: (a: AiAgent) => void;
  deleteAgent: (id: string) => void;
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
  // First-turn self-healing context-trim result (plan B), surfaced to the panel as the "auto-trimmed" hint
  contextTrim?: FirstTurnFit;
  runAgent: (input: GenerateInput & { host: AiToolHost }) => Promise<void>;
  agentResult: AiAgentResult | null;
}

/** Agent one-shot task output (privacy sentinel / smart edit / custom analyze), shown independently and not entering the conversation chat stream */
export interface AiAgentResult {
  goal: string;
  content: string;
  presetId: string;
  imageDataUrl?: string;
  createdAt: number;
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
  agents: mergeAgents(loadAgents()),
  activeAgentId: loadActiveAgent(),
  conversation: [],
  convKey: '',
  memories: [],
  activeMemoryIds: [],
  usage: { input: 0, output: 0 },
  agentSteps: [],
  thinking: '',
  agentResult: null,

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

  setActiveAgent: (id) => {
    saveActiveAgent(id);
    set({ activeAgentId: id });
  },
  upsertAgent: (a) => {
    if (a.builtin) return; // built-ins cannot be overwritten
    const prevCustom = get().agents.filter((x) => !x.builtin);
    const isNew = !prevCustom.some((x) => x.id === a.id);
    const cur = prevCustom.map((x) => (x.id === a.id ? a : x));
    if (isNew) cur.push(a);
    const list = [...BUILTIN_AGENTS, ...cur];
    // Persistence must use the "updated custom list", otherwise a newly created / edited assistant (with bound model) won't be saved and is lost on refresh.
    saveAgents(cur);
    // A newly created assistant (incl. copies from "edit built-in assistant") is set as the current assistant immediately so the bound model takes effect at once,
    // sparing the user from manually picking it again in the conversation selector.
    set({ agents: list, activeAgentId: isNew ? a.id : get().activeAgentId });
  },
  deleteAgent: (id) => {
    const cur = get().agents.filter((x) => !x.builtin && x.id !== id);
    saveAgents(cur);
    const nextActive = get().activeAgentId === id ? null : get().activeAgentId;
    saveActiveAgent(nextActive);
    set({ agents: [...BUILTIN_AGENTS, ...cur], activeAgentId: nextActive });
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
    // Paywall: after the AI trial ends a subscription is required. Without entitlement, open the upgrade dialog and return early.
    if (!useLicenseStore.getState().canUse('ai')) {
      useUpgradeDialogStore.getState().openDialog('ai');
      return;
    }
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
    // Paywall (centralized enforcement): chat() is the final executor for generate/runAgent/refine/multi-turn follow-up (handleFollow)
    // and every other AI entry point. Validating here uniformly guarantees that any path calling chat directly
    // (including the previously missed "multi-turn follow-up" button) cannot bypass the subscription check (fail-closed).
    if (!useLicenseStore.getState().canUse('ai')) {
      useUpgradeDialogStore.getState().openDialog('ai');
      return;
    }
    let sink: ReturnType<typeof makeStreamSink> | null = null;
    const { config, attachImage, attachOcr, conversation, convKey, activeAgentId, agents } = get();
    if (!config.apiKey.trim()) {
      set({ status: 'error', error: t('ai.errorNoKey') });
      return;
    }
    const text = (input ?? '').trim();
    if (!text) return;

    // Part 2: the global "current assistant" selector takes effect — when set it overrides the system prompt / bound model / temperature (falling back to preset defaults).
    const activeAgent = activeAgentId ? agents.find((a) => a.id === activeAgentId) ?? null : null;
    const agentSystemPrompt = activeAgent?.systemPrompt?.trim() || null;
    // Part 2: when following the global setting, use the default model (bound assistant model → global default config.model → first model entity),
    // to avoid the "model connection" tab configuring a model but leaving model empty (no "set as default" UI) and erroring (fixed 2026-08-13).
    const agentModelId = activeAgent?.modelId || defaultModelId(config);
    const agentTemperature = activeAgent?.temperature;

    // Vision handling (adapted to the OCR architecture): the app's standard approach is "text model + OCR text" to understand screenshots,
    // the model itself needs no vision capability. Hence: non-vision model with OCR text → drop the useless image, let OCR supply content, no error;
    // non-vision model with neither OCR nor vision → that is a genuine misconfiguration, show a friendly error.
    const modelSeesImages = modelVisionSupport(config, agentModelId) !== 'no';
    const hasOcr = attachOcr && !!(ctx.ocrText || (ctx.ocrTexts && ctx.ocrTexts.length));
    const wouldSendImage =
      ctx.preset.vision && ((attachImage && ctx.imageDataUrl) || (ctx.images && ctx.images.length));
    if (wouldSendImage && !modelSeesImages && !hasOcr) {
      set({ status: 'error', error: t('ai.errorNoVision') });
      return;
    }

    const conv = conversation.slice();
    const isFirst = conv.length === 0;

    const selectedMem = selectMemories(text, get().memories);
    const memoryNote = buildMemoryNote(selectedMem);
    // Budget guardrail (plan A): budget follows the model's real context window instead of a hard-coded 120k.
    const { contextWindow, maxTokens } = resolveModelLimits(config, agentModelId);
    const sysPrompt = agentSystemPrompt || ctx.preset.system;
    const callConfig = { ...resolveConfig(config, agentModelId) };
    if (agentTemperature != null) callConfig.temperature = agentTemperature;
    // Plan B: assembly-chain diagnostics — log "global model / assistant-bound modelId / resolved model" together,
    // so debug.log reveals whether a 400 means "global not filled" or "assistant not bound" (see 2026-08-13 investigation).
    diagLogAi(
      `[ai-assemble][chat] rawModel="${config.model}" agentModelId=${agentModelId ?? '∅'} resolved="${callConfig.model}" base=${callConfig.baseUrl}`,
      'info',
    );
        // Plan A (defense): empty model is blocked outright to avoid sending an empty request and triggering server-side 400 noise.
    if (!callConfig.model?.trim()) {
      diagLogAi(`[ai-client] ABORT: model empty (rawModel="${config.model}" agentModelId=${agentModelId ?? '∅'})`);
      set({ status: 'error', error: t('ai.errorNoModel') });
      return;
    }
    const sysReserve =
      estimateTokens(sysPrompt) + (memoryNote ? estimateTokens(memoryNote) : 0);

    let userContent: string;
    let images: string[] | undefined;
    let contextTrim: FirstTurnFit | undefined;
    if (isFirst) {
      // First-turn user-message budget: reserve system prompt + model max output, give the rest to the first turn
      // (so "requirement + many images + long OCR" itself doesn't exceed context → plan B first-turn self-healing trim).
      const firstTurnBudget = Math.max(2_000, contextWindow - sysReserve - maxTokens);
      const rawImages = ctx.preset.vision
        ? [
            ...(attachImage && ctx.imageDataUrl && modelSeesImages ? [ctx.imageDataUrl] : []),
            ...(ctx.images ?? []).filter(() => modelSeesImages),
          ]
        : [];
      const fit = fitFirstTurn({
        goal: text,
        ocrText: attachOcr ? ctx.ocrText : undefined,
        ocrTexts: attachOcr ? ctx.ocrTexts : undefined,
        images: rawImages,
        budgetTokens: firstTurnBudget,
        mainImageCount: 1,
      });
      contextTrim = fit.trimmed ? fit : undefined;
      userContent = ctx.preset.buildUser({
        goal: text,
        ocrText: fit.ocrText,
        ocrTexts: fit.ocrTexts,
      });
      images = fit.images.length ? fit.images : undefined;
    } else {
      userContent = text;
      images = undefined;
    }

    const userMsg: AiMessage = {
      role: 'user',
      content: userContent,
      ...(images && images.length ? { images } : {}),
    };
    // History + first-turn userMsg are both subject to trimming (userMsg at the end is always kept; then slice(0,-1)
    // removes it from history to avoid duplication), and pre-deduct system, memory, and model max-output tokens, guaranteeing
    // input + max_tokens <= real context window, eliminating the 400 caused by "hitting window limit + output" stacking.
    const historyMsgs: AiMessage[] = trimHistoryToBudget(
      [...conv.map((m) => ({ role: m.role, content: m.content })), userMsg],
      Math.max(4_000, contextWindow - sysReserve - maxTokens),
      3,
    ).slice(0, -1);
    const messages: AiMessage[] = [
      ...(memoryNote ? [{ role: 'system' as const, content: memoryNote }] : []),
      { role: 'system', content: langOutputDirective() + sysPrompt },
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
      contextTrim,
    });
    const ctl = new AbortController();
    abortCtl = ctl;
    try {
      sink = makeStreamSink(set);
      const full = await streamChat({
        config: callConfig,
        messages,
        onChunk: sink.onChunk,
        onUsage: (u) => set({ usage: u }),
        onThinking: sink.onThinking,
        onRetry: () => sink?.reset(),
        signal: ctl.signal,
        maxTokens,
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
        // Roll back to the pre-request snapshot: the user turn was enqueued first; if it fails without rollback a dangling user turn remains,
        // and the next send would produce consecutive user messages (Anthropic requires alternating user/assistant → 400).
        set({ status: 'error', error: t(aiErrorI18nKey(e), { msg }), conversation: conv });
      }
    } finally {
      abortCtl = null;
    }
  },

  clearConversation: () => {
    set({ conversation: [], memories: [], activeMemoryIds: [], output: '', error: '', status: 'idle', refining: false, thinking: '', agentSteps: [], contextTrim: undefined, agentResult: null });
  },

  // -- History library operations (delegated to lib/conversationIndex) --
  recordConvMeta: (hash, conv, preset, imageDataUrl, title) => {
    recordConvMeta(hash, conv, preset, imageDataUrl, title);
  },
  listConvMeta: () => listConvMeta(),
  getConvByHash: (hash) => getConvByHash(hash),
  deleteConv: (hash) => deleteConv(hash),
  forkConversation: (sourceHash, uptoIndex) => forkConversation(sourceHash, uptoIndex, get().activePresetId),

  // -- Long-term memory --
  compactMemory: async () => {
    // Paywall (centralized enforcement): compactMemory internally calls chatOnce to compress the conversation, which is
    // AI usage. Besides the automatic trigger after chat/runAgent finishes (already past the AI gate), the UI's
    // "compact memory" button (AIPanel) can also enter here directly → without a guard, free / expired users
    // could use the old long conversation saved during trial to click the button and freeload AI. The shared executor defends itself (fail-closed
    // + upgrade dialog), consistent with chat()'s centralized guard strategy.
    if (!useLicenseStore.getState().canUse('ai')) {
      useUpgradeDialogStore.getState().openDialog('ai');
      return;
    }
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
    // Paywall: AI polish is a Pro feature.
    if (!useLicenseStore.getState().canUse('ai')) {
      useUpgradeDialogStore.getState().openDialog('ai');
      return;
    }
    let sink: ReturnType<typeof makeStreamSink> | null = null;
    const { config, output, conversation, activeAgentId, agents } = get();
    if (!output.trim() || !config.apiKey.trim()) return;

    // Part 2: polish also honors the "current assistant" binding (model / temperature), consistent with chat/runAgent —
    // once an agent is selected, polish runs on the assistant's dedicated bound model rather than the global default model.
    const activeAgent = activeAgentId ? agents.find((a) => a.id === activeAgentId) ?? null : null;
    const refineConfig = { ...resolveConfig(config, activeAgent?.modelId || defaultModelId(config)) };
    if (activeAgent?.temperature != null) refineConfig.temperature = activeAgent.temperature;

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
        config: refineConfig,
        messages,
        onChunk: sink.onChunk,
        onUsage: (u) => set({ usage: u }),
        onThinking: sink.onThinking,
        onRetry: () => sink?.reset(),
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
    // Paywall: AI Agent is a Pro feature.
    if (!useLicenseStore.getState().canUse('ai')) {
      useUpgradeDialogStore.getState().openDialog('ai');
      return;
    }
    let sink: ReturnType<typeof makeStreamSink> | null = null;
    const { config, attachImage, attachOcr, conversation, convKey } = get();
    if (!config.apiKey.trim()) {
      set({ status: 'error', error: t('ai.errorNoKey') });
      return;
    }
    const text = (input.goal ?? '').trim();
    // The privacy sentinel allows an empty goal (the system prompt agentSystemSentinel already self-contains "scan and redact everything",
    // so an empty user message works); smart edit still needs an explicit goal.
    if (!text && input.agentKind !== 'sentinel') return;

    // Reasoning / thinking models (reasoning:true, e.g. DeepSeek-Reasoner) in thinking mode: the provider rejects
    // a "forced tool_choice" (required / object form) → immediate 400 ("tool_choice ... does not support
    // being set to required or object in thinking mode"). Such models switch to tool_choice:'auto',
    // and since the sentinel has narrowed tools to only redact_area the model has no choice but to call it, avoiding errors.
    const primaryModelId = input.agentModelId || defaultModelId(config);
    const primaryModel = findModel(config, primaryModelId);
    const modelIsReasoning =
      primaryModel?.reasoning === true ||
      // Fallback: the user didn't tick reasoning but the model name exposes reasoning traits (deepseek-reasoner / o1 / qwq, etc.)
      /reasoner|thinking|-r1\b|o1\b|qwq|glm-4\.5|deepseek-reason/i.test(primaryModel?.refKey ?? primaryModelId ?? '');

    const conv = conversation.slice();
    const selectedMem = selectMemories(text, get().memories);
    const memoryNote = buildMemoryNote(selectedMem);
    // Part 2: a pro Agent prefers a custom system prompt; otherwise it falls back to the original agentKind fixed wording (backward compatible).
    const sysPrompt =
      input.agentSystemPrompt?.trim() ||
      (input.agentKind === 'sentinel' ? agentSystemSentinel() : agentSystem());
    // Budget guardrail (plan A): follow the model's real context window; the first turn adds plan B self-healing trim.
    const { contextWindow, maxTokens } = resolveModelLimits(config, input.agentModelId || defaultModelId(config));
    const sysReserve =
      estimateTokens(sysPrompt) + (memoryNote ? estimateTokens(memoryNote) : 0);

    // Plan B: the first-turn "requirement + many images + long OCR" may itself exceed the window → trim OCR / drop the oldest attached image first.
    // Non-vision model: with OCR text, OCR supplies the screenshot content and only the image is dropped (no error); block only when there's neither vision nor OCR.
    const agentModelSeesImages = modelVisionSupport(config, input.agentModelId || defaultModelId(config)) !== 'no';
    const hasOcr = attachOcr && !!(input.ocrText || (input.ocrTexts && input.ocrTexts.length));
    const rawImages = [input.imageDataUrl, ...(input.images ?? [])].filter(
      (u): u is string => typeof u === 'string' && u.length > 0 && agentModelSeesImages,
    );
    if (rawImages.length && !agentModelSeesImages && !hasOcr) {
      set({ status: 'error', error: t('ai.errorNoVision') });
      return;
    }
    const firstTurnBudget = Math.max(2_000, contextWindow - sysReserve - maxTokens);
    const fit = fitFirstTurn({
      goal: text,
      ocrText: attachOcr ? input.ocrText : undefined,
      ocrTexts: attachOcr ? input.ocrTexts : undefined,
      images: rawImages,
      budgetTokens: firstTurnBudget,
      mainImageCount: 1,
    });
    const contextTrim = fit.trimmed ? fit : undefined;
    const images = fit.images;

    let userContent = text;
    if (attachOcr && (fit.ocrText || (fit.ocrTexts && fit.ocrTexts.length))) {
      const ocrBody =
        fit.ocrTexts && fit.ocrTexts.length
          ? fit.ocrTexts.join('\n\n')
          : (fit.ocrText ?? '');
      userContent = `${text}\n\n[截图文字内容 / OCR]\n${ocrBody}`;
    }
    const userMsg: AiMessage = {
      role: 'user',
      content: userContent,
      ...(images && images.length ? { images } : {}),
    };

    const historyMsgs: AiMessage[] = trimHistoryToBudget(
      [...conv.map((m) => ({ role: m.role, content: m.content })), userMsg],
      Math.max(4_000, contextWindow - sysReserve - maxTokens),
      3,
    ).slice(0, -1);
    const messages: AiMessage[] = [
      ...(memoryNote ? [{ role: 'system' as const, content: memoryNote }] : []),
      { role: 'system', content: sysPrompt },
      ...historyMsgs,
      userMsg,
    ];

    set({
      status: 'streaming',
      output: '',
      error: '',
      usage: { input: 0, output: 0 },
      thinking: '',
      agentSteps: [],
      activeMemoryIds: selectedMem.map((m) => m.id ?? '').filter(Boolean),
      contextTrim,
    });
    const ctl = new AbortController();
    abortCtl = ctl;
    try {
      sink = makeStreamSink(set);
      // Part 2: an Agent-bound model → look up its provider by model id and resolve apiType/baseUrl/apiKey
      // (fall back to global when the provider apiKey is empty). Aligns with biosphere's multi-provider multi-model capability.
      // Shallow-copy one, to avoid resolveConfig returning the store's config reference directly (and polluting it) when there's no modelId.
      // runStream is extracted into a closure: on primary-model failure it retries once with a fallback model (once only, to prevent infinite loops).
      const runStream = async (modelId?: string): Promise<string> => {
        const callConfig = { ...resolveConfig(config, modelId) };
        if (input.agentTemperature != null) callConfig.temperature = input.agentTemperature;
        // Plan B: assembly-chain diagnostics (same as chat) — helps confirm the root cause of an empty model from debug.log.
        diagLogAi(`[ai-assemble][agent] rawModel="${config.model}" agentModelId=${modelId ?? '∅'} resolved="${callConfig.model}" base=${callConfig.baseUrl}`, 'info');
        // Plan A (defense): empty model is blocked outright to avoid sending an empty request and triggering server-side 400 noise.
        if (!callConfig.model?.trim()) {
          diagLogAi(`[ai-client] ABORT: model empty (rawModel="${config.model}" agentModelId=${modelId ?? '∅'})`);
          set({ status: 'error', error: t('ai.errorNoModel') });
          throw Object.assign(new Error(t('ai.errorNoModel')), { modelEmpty: true });
        }
        // runStream is only called after sink is assigned; assert non-null — TS can't narrow a let inside a closure.
        const s = sink!;
        const { text: full } = await streamChatWithTools({
          config: callConfig,
          messages,
          // Part 2: an Agent can bind a tool subset (empty = all); the rest use the original full tool set.
          // Privacy sentinel: the tool set is narrowed to only redact_area (the prompt also forbids other tools),
          // and forces redact_area every turn — to stop the model from only emitting an "identified" text report without actually redacting.
          tools: input.agentKind === 'sentinel'
            ? AI_TOOL_DEFS.filter((td) => td.name === 'redact_area')
            : input.agentToolIds && input.agentToolIds.length
              ? AI_TOOL_DEFS.filter((td) => input.agentToolIds!.includes(td.name))
              : AI_TOOL_DEFS,
          executor: createToolExecutor(input.host),
          // The sentinel redacts region by region: it forces one call per turn, and needs more turns for many regions; 8→16 leaves headroom.
          // Reasoning models don't support forced tool_choice, so use 'auto' (tools are already narrowed to only redact_area, so the model will call it).
          maxToolTurns: input.agentKind === 'sentinel' ? 16 : 8,
          forceToolName: input.agentKind === 'sentinel' && !modelIsReasoning ? 'redact_area' : undefined,
          maxTokens,
          onChunk: s.onChunk,
          onUsage: (u) => set({ usage: u }),
          onThinking: s.onThinking,
          // A retry voids this turn's partial output: first clear the sink buffer and display, then roll back to
          // the full-text baseline of completed turns, to avoid duplicated content after the retry.
          onRetry: (baseline) => {
            s.reset();
            set({ output: baseline ?? '', thinking: '' });
          },
          onToolCall: (step) => {
            // Dedupe the step echo: the sentinel may re-emit the same redact_area; the UI shows it only once
            if (step.name === 'redact_area') {
              const a = step.args as Record<string, any>;
              const key = `${(+a.x).toFixed(3)},${(+a.y).toFixed(3)},${(+a.w).toFixed(3)},${(+a.h).toFixed(3)},${a.mode ?? 'mosaic'}`;
              if (get().agentSteps.some((st) => st.name === 'redact_area' && `${(+(st.args as any).x).toFixed(3)},${(+(st.args as any).y).toFixed(3)},${(+(st.args as any).w).toFixed(3)},${(+(st.args as any).h).toFixed(3)},${(st.args as any).mode ?? 'mosaic'}` === key)) {
                return;
              }
            }
            set((s) => ({ agentSteps: [...s.agentSteps, step] }));
          },
          onToolResult: (callId, result, isError) =>
            set((s) => ({
              agentSteps: s.agentSteps.map((st) => (st.callId === callId ? { ...st, result, isError } : st)),
            })),
          signal: ctl.signal,
        });
        return full;
      };
      let full: string;
      const fb = input.agentFallbackModelId;
      const primaryId = primaryModelId;
      try {
        full = await runStream(primaryModelId);
      } catch (e) {
        if (fb && fb !== primaryId) {
          // Primary model failed → clear current display, retry once with the fallback model (if the fallback also fails, throw up to the function-level catch)
          sink?.reset();
          set({ output: '', thinking: '', error: '' });
          full = await runStream(fb);
        } else {
          throw e;
        }
      }
      // An Agent task is a one-shot output and is not written into the conversation chat stream (avoids "task result piling at the bottom of the chat").
      // Instead it becomes an independent agentResult output state, shown by the panel as an MUI card; history still enters conversationIndex for review.
      sink?.stop();
      // An auto default prompt (e.g. the privacy sentinel's sentinelDefaultGoal) is a system instruction, not user conversation content;
      // when saving / displaying, replace it with a neutral label so the whole system prompt isn't shown as a "user message".
      const isAutoDefault = input.agentKind === 'sentinel' && !input.goal?.trim();
      const displayGoal = isAutoDefault ? t('ai.sentinelAutoLabel') : text;
      const resultConv: AiChatTurn[] = [
        { role: 'user', content: displayGoal },
        { role: 'assistant', content: full },
      ];
      set({
        status: 'done',
        output: full,
        agentResult: {
          goal: displayGoal,
          content: full,
          presetId: input.preset.id,
          imageDataUrl: input.imageDataUrl,
          createdAt: Date.now(),
        },
      });
      // History index title: an auto sentinel (empty text) falls back to the default goal, to avoid an empty title.
      get().recordConvMeta(convKey, resultConv, input.preset, input.imageDataUrl, text || (isAutoDefault ? t('ai.sentinelDefaultGoal') : ''));
      // Persisted body: runAgent doesn't write to the conversation chat stream; if saveConversation is skipped here,
      // the disk keeps only the meta index with no message body — reopening / quitting the app then loadConversation reads empty,
      // leaving the middle column blank, no preview/export, and clicking a history item looks "ineffective".
      try { saveConversation(convKey, resultConv); } catch { /* fail silently */ }
    } catch (e: any) {
      sink?.stop();
      if (e?.name === 'AbortError') {
        set({ status: 'idle' });
      } else if (e?.modelEmpty) {
        // runStream already set a friendly error (ai.errorNoModel), so skip the aiErrorI18nKey override
      } else {
        const msg = e?.message ? String(e.message) : String(e);
        // Roll back to the pre-request snapshot (same as chat): avoid a dangling user turn after failure causing consecutive user on next request → Anthropic 400.
        set({ status: 'error', error: t(aiErrorI18nKey(e), { msg }), conversation: conv });
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
        try { saveConversation(convKey, next); } catch { /* fail silently */ }
        return;
      }
    }
    set({ status: 'idle' });
  },

  reset: () => set({ status: 'idle', output: '', error: '', refining: false, thinking: '', agentSteps: [], contextTrim: undefined, agentResult: null }),

  setUsage: (u) => set({ usage: u }),
}));
