// 多供应商三层解析助手（P3）：对齐 biosphere 的 Provider→Endpoint→Model 三层模型。
//
// 设计要点：
//  - 运行时按「模型 id」→ 模型.endpointId → endpoint.providerId → provider.apiKey
//    两步动态解析出 apiType/baseUrl/apiKey，从而支持「接入多个模型/多个供应商各自独立密钥」；
//  - 模型实体只存 refKey（真实 API 名）+ name（展示名）+ 能力，绝不在模型上写死 key/baseurl；
//  - 供应商 apiKey 留空时回退到全局 config.apiKey，保证旧用户（只有全局 key）行为不变；
//  - 内置供应商（builtin）也参与解析，与用户自定义供应商一视同仁。

import type { AiConfig, AiProviderConfig, AiEndpointConfig, AiModelConfig } from './aiTypes';
import { PROVIDERS } from './providers';

/** 供应商是否启用（enabled 缺省视为启用，兼容旧配置） */
export function isProviderEnabled(p: AiProviderConfig): boolean {
  return p.enabled !== false;
}

/** 仅启用的供应商 */
export function enabledProviders(config: AiConfig): AiProviderConfig[] {
  return (config.providers ?? []).filter(isProviderEnabled);
}

/** 按 id 取供应商 */
export function providerById(config: AiConfig, id?: string): AiProviderConfig | undefined {
  if (!id) return undefined;
  return (config.providers ?? []).find((p) => p.id === id);
}

/** 按 id 取接入方式 */
export function endpointById(config: AiConfig, id?: string): AiEndpointConfig | undefined {
  if (!id) return undefined;
  return (config.endpoints ?? []).find((e) => e.id === id);
}

/** 按 id 取模型实体（严格按实体 id，供设置页编辑/删除等需要精确定位的场景使用） */
export function modelById(config: AiConfig, id?: string): AiModelConfig | undefined {
  if (!id) return undefined;
  return (config.models ?? []).find((m) => m.id === id);
}

/**
 * 宽松查找模型实体：先按实体 id，再按 refKey 兜底。
 *
 * 为什么需要 refKey 兜底：旧版（2 层压扁）配置里 `config.model` 与 `agent.modelId`
 * 存的是「真实 API 模型名」（如 gpt-4o-mini），而不是模型实体 id。迁移后若只按 id 查，
 * 这些旧值会全部查不到 → 退化成用全局 apiKey/baseUrl，丢掉供应商独立密钥，属于回归。
 * 因此所有「解析用于请求的配置」的链路统一走这里，保证新旧值都能落到正确的 endpoint/provider。
 */
export function findModel(config: AiConfig, idOrRefKey?: string): AiModelConfig | undefined {
  if (!idOrRefKey) return undefined;
  const models = config.models ?? [];
  return models.find((m) => m.id === idOrRefKey) ?? models.find((m) => m.refKey === idOrRefKey);
}

/**
 * 供应商下的接入方式。
 * 顺序 = 数组插入序（用户添加次序），刻意不按名字排序：
 * 否则用户重命名一个接入方式会导致列表跳动，与供应商列表「保持插入序」的策略保持一致。
 */
export function endpointsForProvider(config: AiConfig, providerId: string): AiEndpointConfig[] {
  return (config.endpoints ?? []).filter((e) => e.providerId === providerId);
}

/** 接入方式下的模型（同样保持插入序） */
export function modelsForEndpoint(config: AiConfig, endpointId: string): AiModelConfig[] {
  return (config.models ?? []).filter((m) => m.endpointId === endpointId);
}

/**
 * 按模型 id 反查模型所属的供应商（优先启用的链路；无则返回 undefined）。
 * 链路：model.endpointId → endpoint.providerId → provider。
 */
export function providerForModel(
  config: AiConfig,
  modelId?: string,
): AiProviderConfig | undefined {
  const m = findModel(config, modelId);
  if (!m) return undefined;
  const ep = endpointById(config, m.endpointId);
  if (!ep) return undefined;
  // 注意：即使供应商被停用也返回它，调用方需要拿到实体去判断/提示，而不是拿到 undefined
  return providerById(config, ep.providerId);
}

/**
 * 解析出实际用于请求的扁平配置。
 *  - modelId 为空（跟随全局）：直接返回全局 config（默认接口）；
 *  - modelId 命中某模型实体：返回该模型所属 endpoint 的 apiType/baseUrl +
 *    endpoint.authType + 所属 provider 的 apiKey（apiKey 空则回退全局）+ model=refKey；
 *  - modelId 未命中任何模型实体（手动填写的自定义模型 refKey）：沿用全局其他字段，仅覆盖 model。
 * model 字段发请求用 refKey（真实 API 名），不是展示名 name。
 */
export function resolveConfig(config: AiConfig, modelId?: string): AiConfig {
  const m = findModel(config, modelId);
  if (!m) return config; // 未命中 → 原样（model 作为自定义 refKey 兜底）
  const ep = endpointById(config, m.endpointId);
  const prov = ep && providerById(config, ep.providerId);
  return {
    ...config,
    apiType: ep?.apiType ?? config.apiType,
    baseUrl: ep?.baseUrl ?? config.baseUrl,
    apiKey: (prov?.apiKey ?? '') || config.apiKey,
    model: m.refKey,
  };
}

/** 取某模型 id 的真实 API 名（refKey）；非模型实体时原样返回（自定义 refKey） */
export function modelRefKey(config: AiConfig, modelId?: string): string {
  if (!modelId) return '';
  return findModel(config, modelId)?.refKey ?? modelId;
}

/**
 * 跟随全局时的默认模型 id。
 *
 * 背景（2026-08-13 修复）：三层重构后「模型接入」tab 只把模型实体写进 `config.models`，
 * 设置页**没有「设为默认」UI**，因此 `config.model`（旧扁平默认模型字段）永远为空。
 * 此前 `chat()`/`runAgent()` 跟随全局时传 `undefined` 给 `resolveConfig`，而
 * `findModel(config, undefined)` 直接返回 undefined → 解析出空 model → 触发「请先选择模型」拦截，
 * 即便用户已在「模型接入」tab 配了模型也用不了。
 *
 * 这里优先用已设默认（config.model，兼容旧配置遗留的 refKey），否则兜底取第一个模型实体 id，
 * 保证「配了模型就能用」，无需额外的「设为默认」操作。
 */
export function defaultModelId(config: AiConfig): string | undefined {
  if (config.model) return config.model;
  return (config.models ?? [])[0]?.id;
}

/** 供应商展示名：builtin 供应商 name 存的是 i18n key，需经 t() 解析 */
export function providerDisplayName(p: AiProviderConfig, t: (k: string) => string): string {
  if (p.builtin) return t(p.name);
  return p.name || p.id;
}

/** 接入方式展示名（无 name 时回退到 apiType 文案） */
export function endpointLabel(e: AiEndpointConfig, t: (k: string) => string): string {
  if (e.name) return e.name;
  return e.apiType === 'anthropic' ? t('ai.apiTypeAnthropic') : t('ai.apiTypeOpenAI');
}

/**
 * 模型嵌套树，供下拉/列表/智能体绑定渲染。
 * 结构：provider → 其下各 endpoint → 该 endpoint 下的模型。
 * 默认只返回「启用」的供应商/endpoint/模型；设置页需要展示全部时传 includeDisabled=true。
 */
export interface ModelTreeNode {
  provider: AiProviderConfig;
  endpoints: { endpoint: AiEndpointConfig; models: AiModelConfig[] }[];
}
export function modelTree(config: AiConfig, includeDisabled = false): ModelTreeNode[] {
  const providers = includeDisabled ? (config.providers ?? []) : enabledProviders(config);
  const endpointsAll = config.endpoints ?? [];
  const modelsAll = config.models ?? [];
  return providers.map((p) => ({
    provider: p,
    endpoints: endpointsAll
      .filter((e) => e.providerId === p.id && (includeDisabled || e.enabled !== false))
      .map((e) => ({
        endpoint: e,
        models: modelsAll.filter(
          (m) => m.endpointId === e.id && (includeDisabled || m.enabled !== false),
        ),
      })),
  }));
}

// ── 视觉能力（结合 SnapCraft 主业务：截图分析必须是视觉模型）──

/** 模型视觉支持判定结果 */
export type VisionSupport = 'yes' | 'no' | 'unknown';

/** 模型名启发式：命中即视为具备视觉能力（覆盖用户自定义供应商里的常见视觉模型命名） */
export const VISION_NAME_HINTS = [
  'vision', '-vl', 'vl-', 'gpt-4o', 'gpt-4.1', 'gpt-4-turbo', 'gpt-5',
  'claude-3', 'claude-sonnet-4', 'claude-opus-4', 'glm-4v', 'glm-4.1v',
  'gemini', 'qvq', 'internvl', 'llava', 'pixtral', 'step-1v', 'yi-vision',
];

/** 纯文本模型名启发式：命中即视为不支持视觉（优先级高于目录缺省） */
const TEXT_ONLY_NAME_HINTS = ['deepseek-chat', 'deepseek-reasoner', 'moonshot-v1', 'text-embedding'];

/**
 * 判定某模型是否支持视觉：
 *  1. 用户「视觉能力探测」确认过的模型（config.visionModels，按模型 id 记录）→ yes（最高优先级，实测为准）
 *  2. 模型实体已显式声明 inputTypes → yes/no
 *  3. PROVIDERS 目录里该模型 refKey 所属预设的 capabilities → yes/no
 *  4. 模型名(refKey)启发式 → yes/no
 *  5. 都不命中 → unknown（UI 显示「未知」并引导探测）
 */
export function modelVisionSupport(config: AiConfig, modelId?: string): VisionSupport {
  if (!modelId) return 'unknown';
  if ((config.visionModels ?? []).includes(modelId)) return 'yes';
  const m = findModel(config, modelId);
  if (m) {
    if (m.inputTypes.includes('image')) return 'yes';
    if (m.inputTypes.length > 0 && m.inputTypes.every((t) => t === 'text')) return 'no';
  }
  const ref = (m?.refKey ?? modelId).toLowerCase();
  const def = PROVIDERS.find((p) => p.models.some((mm) => mm.toLowerCase() === ref));
  if (def) return def.capabilities.includes('vision') ? 'yes' : 'no';
  if (TEXT_ONLY_NAME_HINTS.some((h) => ref.includes(h))) return 'no';
  if (VISION_NAME_HINTS.some((h) => ref.includes(h))) return 'yes';
  return 'unknown';
}

/** 把探测确认支持视觉的模型记入 config.visionModels（按模型 id，去重） */
export function withVisionModel(config: AiConfig, modelId: string): string[] {
  const set = new Set(config.visionModels ?? []);
  set.add(modelId);
  return Array.from(set);
}

// ── 非对话类模型（视频/图像生成等）防护 ──

/** 模型名启发式：命中即视为「非对话模型」（视频/图像生成等），不应经 chat/completions 调用。
 *  典型：阿里万相 Wan 系列（wan2.7-t2v / wan2.1-i2v 等文生/图生视频）、Seedance、Kling、HunyuanVideo。
 *  这类模型 DashScope 仅在专用 task 接口提供，走 chat 路由会返回 400 "url error, please check url"。 */
const NON_CHAT_NAME_HINTS = [
  'wan', 't2v', 'i2v', 'video', '-vid-', 'seedance', 'kling', 'hunyuan-video', 'cogvideox',
];

/**
 * 判定某模型是否可作为对话/视觉助手调用（经 chat/completions 或 /v1/messages 路由）。
 *  - false：视频/图像生成等非对话模型，当前版本不支持，强行调用会触发 DashScope 400 url error；
 *  - 模型实体显式声明 inputTypes 时以「含 text」为准；非对话模型名命中则一律判不可用（优先于声明，
 *    避免用户把视频模型误标 text 后仍被放行）。
 *  - 未指定 modelId（跟随全局）返回 true，交给调用方处理。
 */
export function modelChatUsable(config: AiConfig, modelId?: string): boolean {
  if (!modelId) return true;
  const m = findModel(config, modelId);
  const ref = (m?.refKey ?? modelId).toLowerCase();
  if (NON_CHAT_NAME_HINTS.some((h) => ref.includes(h))) return false;
  if (m && m.inputTypes.length > 0) return m.inputTypes.includes('text');
  return true;
}

// ── 配置就绪度（设置页状态总览 + tab 徽章）──

export interface SetupStatus {
  /** 启用的供应商数 */
  providerCount: number;
  /** 启用供应商下的接入方式数 */
  endpointCount: number;
  /** 启用接入方式下可用模型总数（去重） */
  modelCount: number;
  /** 是否有任何可用密钥（全局回退密钥或任一启用供应商的独立密钥） */
  hasKey: boolean;
  /** 默认模型是否落在某个启用模型实体里 */
  defaultModelResolved: boolean;
  /** 整体就绪：有密钥 + 有可用模型 */
  ready: boolean;
}

/** 计算接口配置就绪度（不发网络请求，纯本地判定） */
export function setupStatus(config: AiConfig): SetupStatus {
  const providers = enabledProviders(config);
  const eps = (config.endpoints ?? []).filter(
    (e) => e.enabled !== false && providers.some((p) => p.id === e.providerId),
  );
  const models = new Set<string>();
  eps.forEach((e) => modelsForEndpoint(config, e.id).forEach((m) => models.add(m.id)));
  const hasKey = !!config.apiKey.trim() || providers.some((p) => !!p.apiKey.trim());
  const defaultModelResolved = (config.models ?? []).some((m) => m.id === config.model);
  return {
    providerCount: providers.length,
    endpointCount: eps.length,
    modelCount: models.size,
    hasKey,
    defaultModelResolved,
    ready: hasKey && (models.size > 0 || !!config.model.trim()),
  };
}

// ── 供应商视觉（对齐 biosphere 的 preset logo；让列表有稳定的「先后顺序」与辨识度）──

/** 各内置供应商展示用 logo（emoji），顺序与 PROVIDERS 目录一致 */
export const PROVIDER_LOGO: Record<string, string> = {
  openai: '🟢',
  anthropic: '🟠',
  deepseek: '🔵',
  qwen: '🟣',
  zhipu: '🟡',
  moonshot: '⚪',
};

/** 取供应商 logo：内置预设优先；自定义/未知回退 ☁️ */
export function providerLogo(p: AiProviderConfig): string {
  if (p.builtin && PROVIDER_LOGO[p.id]) return PROVIDER_LOGO[p.id];
  return '☁️';
}

/**
 * 供应商列表确定性排序：
 *  - 内置供应商按 PROVIDERS 目录顺序（表达稳定的「先后顺序」）；
 *  - 自定义供应商随后，保持原数组（插入）顺序，不强行按名重排，尊重用户添加次序。
 * 目的：消除「供应商无顺序」的观感，每次渲染稳定不跳动（对齐 biosphere 的有序列表）。
 */
export function sortProviders(config: AiConfig): AiProviderConfig[] {
  const order = new Map(PROVIDERS.map((p, i) => [p.id, i]));
  return [...(config.providers ?? [])].sort((a, b) => {
    const ai = order.has(a.id) ? (order.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b.id) ? (order.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}
