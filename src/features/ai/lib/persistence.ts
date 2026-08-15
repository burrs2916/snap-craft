// src/features/ai/lib/persistence.ts
// 从 aiStore.ts 提取的 localStorage 持久化层。
// 职责：配置、模板、对话线程的读写，与业务逻辑完全解耦。
// 所有函数均为纯 I/O，不持有状态，方便单元测试与替换存储后端。

import type { AiConfig, AiChatTurn, EndpointFamily, AiCapability, AiModality, AiProviderConfig, AiEndpointConfig, AiModelConfig, AiApiType } from '../aiTypes';
import type { UserPreset } from '../aiPresets';
import type { AiAgent } from '../aiAgents';

// ── 存储键 ──

const STORAGE_KEY = 'snapcraft-ai-config';
const TPL_KEY = 'snapcraft-ai-templates';
const CONV_PREFIX = 'snapcraft-ai-conv:';

// ── 配置 ──

// 段一（P0+P2）新增字段的缺省值：endpointFamily / capabilities / modality。
// 旧配置（无这些字段）经 loadConfig 的 { ...DEFAULT_CONFIG, ...parsed } 合并后自动补齐。
const DEFAULT_ENDPOINT_FAMILY: EndpointFamily = 'openai-chat';
const DEFAULT_CAPABILITIES: AiCapability[] = ['text', 'vision'];
const DEFAULT_MODALITY: AiModality = 'analyze';

const DEFAULT_CONFIG: AiConfig = {
  apiType: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  temperature: 0.7,
  theme: 'modern',
  endpointFamily: DEFAULT_ENDPOINT_FAMILY,
  capabilities: DEFAULT_CAPABILITIES,
  modality: DEFAULT_MODALITY,
};

export function loadConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedProviders({ ...DEFAULT_CONFIG });
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_CONFIG, ...parsed };
    return seedProviders(merged);
  } catch {
    return seedProviders({ ...DEFAULT_CONFIG });
  }
}

/** 模型名 → 稳定 slug（用于生成可重现的模型 id） */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** 模型名启发式：是否视觉模型（用于播种 inputTypes 初值） */
function visionHint(ref: string): boolean {
  const r = ref.toLowerCase();
  return (
    r.includes('vision') ||
    r.includes('-vl') ||
    r.includes('vl-') ||
    r.includes('gpt-4o') ||
    r.includes('gpt-4.1') ||
    r.includes('gpt-4-turbo') ||
    r.includes('claude-3') ||
    r.includes('claude-sonnet-4') ||
    r.includes('claude-opus-4') ||
    r.includes('glm-4v') ||
    r.includes('gemini') ||
    r.includes('qvq') ||
    r.includes('internvl') ||
    r.includes('llava') ||
    r.includes('pixtral') ||
    r.includes('step-1v') ||
    r.includes('yi-vision')
  );
}

/** 模型名启发式：是否推理模型（用于播种 reasoning 初值） */
function reasoningHint(ref: string): boolean {
  const r = ref.toLowerCase();
  return r.includes('reasoner') || r.includes('-r1') || r.includes('thinking') || r.includes('o1') || r.includes('o3');
}

/**
 * 旧配置（2 层压扁：provider 上挂 apiType/baseUrl/models:string[]）幂等迁移为三层：
 *  - 每个旧 provider → 只保留密钥层的 AiProviderConfig（去除 apiType/baseUrl/models）；
 *  - 其 apiType/baseUrl → 造 1 条默认 AiEndpointConfig（providerId 指回，authType 按 apiType）；
 *  - 其 models:string[] → 每个造 AiModelConfig（refKey=原串，inputTypes 用启发式推断）。
 * 已迁移数据（endpoints/models 均为数组且 provider 无 apiType/models 字段）直接跳过，不重复造。
 */
function migrateThreeLayer(c: AiConfig): AiConfig {
  const oldProviders = c.providers ?? [];
  const hasOld = oldProviders.some(
    (p) => (p as any).apiType !== undefined || Array.isArray((p as any).models),
  );
  if (!hasOld && Array.isArray(c.endpoints) && Array.isArray(c.models)) return c;
  const providers: AiProviderConfig[] = [];
  const endpoints: AiEndpointConfig[] = [];
  const models: AiModelConfig[] = [];
  for (const op of oldProviders) {
    const anyOp = op as any;
    providers.push({
      id: op.id,
      name: op.name,
      apiKey: anyOp.apiKey ?? '',
      builtin: op.builtin,
      enabled: op.enabled !== false,
    });
    const apiType: AiApiType = anyOp.apiType ?? 'openai';
    const baseUrl: string = anyOp.baseUrl ?? '';
    const epId = `ep-${op.id}`;
    endpoints.push({
      id: epId,
      providerId: op.id,
      name: '',
      apiType,
      baseUrl,
      authType: apiType === 'anthropic' ? 'x-api-key' : 'bearer',
    });
    const oldModels: string[] = Array.isArray(anyOp.models) ? anyOp.models : [];
    for (const mm of oldModels) {
      models.push({
        id: `m-${op.id}-${slug(mm)}`,
        endpointId: epId,
        name: mm,
        refKey: mm,
        inputTypes: visionHint(mm) ? ['text', 'image'] : ['text'],
        reasoning: reasoningHint(mm),
      });
    }
  }
  const next: AiConfig = { ...c, providers, endpoints, models };
  // 旧配置的 config.model 存的是真实 API 名（refKey），迁移后重映射为模型实体 id，
  // 这样设置页能正确高亮默认模型；找不到对应实体时保留原串（由 findModel 的 refKey 兜底继续可用）。
  const hit = models.find((m) => m.refKey === c.model);
  if (hit) next.model = hit.id;
  return next;
}

/** 当前代码支持的内置供应商 id（国际大厂 + 本地框架 Ollama）。
 *  用于「加载时清理」：删除已不再支持的内置供应商（如旧版播种的 deepseek/qwen/zhipu/moonshot），
 *  避免老用户 localStorage 里的过期内置数据残留。用户自定义供应商（builtin !== true）一律保留。 */
const KEEP_BUILTIN_IDS = new Set(['openai', 'anthropic', 'google', 'ollama']);

/** 清理不再支持的内置供应商，并级联删除其接入点与模型。
 *  若默认模型落在被删模型上，重映射为保留模型首项（否则清空），避免悬空引用。 */
function pruneUnsupportedBuiltins(c: AiConfig): AiConfig {
  const providers = c.providers ?? [];
  const kept = providers.filter((p) => !(p.builtin === true && !KEEP_BUILTIN_IDS.has(p.id)));
  if (kept.length === providers.length) return c;
  const keptIds = new Set(kept.map((p) => p.id));
  const endpoints = (c.endpoints ?? []).filter((e) => keptIds.has(e.providerId));
  const endpointIds = new Set(endpoints.map((e) => e.id));
  const models = (c.models ?? []).filter((m) => endpointIds.has(m.endpointId));
  let model = c.model;
  if (model && !models.some((m) => m.id === model || m.refKey === model)) {
    model = models[0]?.id ?? models[0]?.refKey ?? '';
  }
  return { ...c, providers: kept, endpoints, models, model };
}

/** 首次加载（旧配置无 providers 字段）时不自动播种任何内置供应商。
 *  由用户自行通过「快速添加」选择国际大厂或自定义添加，避免内置默认供应商干扰选择。
 *  仅当 providers 字段为 undefined（从未设置）才走此分支；已显式保存过（含空数组）则尊重用户选择。
 *  分支结束后统一跑 pruneUnsupportedBuiltins，清理老 localStorage 里遗留的不支持内置供应商。 */
function seedProviders(c: AiConfig): AiConfig {
  let next: AiConfig;
  if (c.providers === undefined) {
    // 不再播种内置供应商：返回空的三层结构，用户从零开始配置
    next = { ...c, providers: [], endpoints: [], models: [], model: '' };
  } else {
    // 已有 providers（可能是旧 2 层格式）→ 迁移到三层
    next = pruneUnsupportedBuiltins(migrateThreeLayer(c));
  }
  // 旧版自动播种的默认供应商（deepseek/qwen/zhipu/moonshot/openai/anthropic…）均带 builtin:true；
  // 用户自行「快速添加」或「自定义添加」的供应商不携带该标记。
  // 若当前供应商全部是旧播种内置（说明是从未手动清理过的默认数据），则清空三层结构，
  // 让用户通过「快速添加」从零自选。一旦添加了任意自定义（非 builtin）供应商，即不再触发。
  const provs = next.providers ?? [];
  if (provs.length > 0 && provs.every((p) => p.builtin === true)) {
    next = { ...next, providers: [], endpoints: [], models: [], model: '' };
  }
  return next;
}

export function saveConfig(c: AiConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* 忽略写入失败 */
  }
}

// ── 自定义模板 ──

export function loadTemplates(): UserPreset[] {
  try {
    const raw = localStorage.getItem(TPL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as UserPreset[]) : [];
  } catch {
    return [];
  }
}

export function saveTemplates(list: UserPreset[]): void {
  try {
    localStorage.setItem(TPL_KEY, JSON.stringify(list));
  } catch {
    /* 忽略写入失败 */
  }
}

// ── 自定义智能体（Agent）──
// 仅持久化用户自定义助手；内置助手由 BUILTIN_AGENTS 在运行时合并，不入库（避免内置被覆盖）。

const AGENT_KEY = 'snapcraft-ai-agents';

export function loadAgents(): AiAgent[] {
  try {
    const raw = localStorage.getItem(AGENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AiAgent[]).filter((a) => !a.builtin) : [];
  } catch {
    return [];
  }
}

export function saveAgents(list: AiAgent[]): void {
  try {
    // 入库前剔除内置（防重复 + 防内置被用户数据覆盖）
    localStorage.setItem(AGENT_KEY, JSON.stringify(list.filter((a) => !a.builtin)));
  } catch {
    /* 忽略写入失败 */
  }
}

// activeAgentId 持久化（最后选中的助手；null = 文档模式）
const AGENT_ACTIVE_KEY = 'snapcraft-ai-agent-active';

export function loadActiveAgent(): string | null {
  try {
    const raw = localStorage.getItem(AGENT_ACTIVE_KEY);
    return raw ?? null;
  } catch {
    return null;
  }
}

export function saveActiveAgent(id: string | null): void {
  try {
    if (id) localStorage.setItem(AGENT_ACTIVE_KEY, id);
    else localStorage.removeItem(AGENT_ACTIVE_KEY);
  } catch {
    /* 忽略写入失败 */
  }
}

// ── 对话线程 ──

export function loadConversation(key: string): AiChatTurn[] {
  try {
    const raw = localStorage.getItem(CONV_PREFIX + key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AiChatTurn[]) : [];
  } catch {
    return [];
  }
}

export function saveConversation(key: string, conv: AiChatTurn[]): void {
  try {
    localStorage.setItem(CONV_PREFIX + key, JSON.stringify(conv));
  } catch {
    /* 忽略写入失败 */
  }
}

export function removeConversation(key: string): void {
  try {
    localStorage.removeItem(CONV_PREFIX + key);
  } catch {
    /* 忽略 */
  }
}

// ── 多截图选择顺序 ──

const SEL_PREFIX = 'snapcraft-ai-sel:';

export function loadSelection(hash: string): string[] {
  try {
    const raw = localStorage.getItem(SEL_PREFIX + hash);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function saveSelection(hash: string, ids: string[]): void {
  try {
    localStorage.setItem(SEL_PREFIX + hash, JSON.stringify(ids));
  } catch {
    /* 忽略写入失败 */
  }
}

export function removeSelection(hash: string): void {
  try {
    localStorage.removeItem(SEL_PREFIX + hash);
  } catch {
    /* 忽略 */
  }
}
