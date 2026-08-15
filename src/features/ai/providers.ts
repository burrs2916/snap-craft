// AI 供应商目录（P0，从 biosphere-terminal-app 的 ProviderConfig 借鉴并精简）。
//
// 设计要点：
//  - 一份纯前端的「供应商预设」目录，替换 AIPanel 里原先硬编码的厂商芯片；
//  - 每个供应商带 endpointFamily / capabilities / 推荐模型，点击即回填 config；
//  - 与 biosphere 的 ProviderConfig 不同：snap-craft 是前端直连、密钥留在本机，
//    不引入后端端点管理，故只保留 UI 需要的「展示 + 初值」信息，不做 auth_type 抽象
//    （OpenAI 兼容统一 Bearer、Anthropic 统一 x-api-key，已由 aiClient.buildHeaders 处理）。
//  - capabilities 是该供应商「默认模型」的已知能力，作为 P1 自动识别起点；
//    最终以「能力探测」（发送测试图）回填为准。

import type { AiApiType, EndpointFamily, AiCapability, AiModality } from './aiTypes';

export interface ProviderDef {
  /** 稳定 id（与 i18n key 对齐，如 'openai' → t('ai.providerOpenAI')） */
  id: string;
  /** i18n key（展示名） */
  labelKey: string;
  /** 接口类型（决定 aiClient 的请求拼装与鉴权） */
  apiType: AiApiType;
  /** 接口基地址（不含 /chat/completions 后缀） */
  baseUrl: string;
  /** 默认模型（点击预设时回填） */
  defaultModel: string;
  /** 接口协议族 */
  endpointFamily: EndpointFamily;
  /** 默认模型已知能力（P1 自动识别起点） */
  capabilities: AiCapability[];
  /** 推荐模型列表（P1 模型下拉建议） */
  models: string[];
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'openai',
    labelKey: 'ai.providerOpenAI',
    apiType: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    endpointFamily: 'openai-chat',
    capabilities: ['text', 'vision'],
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-4-turbo', 'o1-mini', 'o3-mini'],
  },
  {
    id: 'anthropic',
    labelKey: 'ai.providerAnthropic',
    apiType: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
    endpointFamily: 'anthropic',
    capabilities: ['text', 'vision'],
    models: [
      'claude-sonnet-4-20250514',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
    ],
  },
  {
    id: 'google',
    labelKey: 'ai.providerGoogle',
    apiType: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    endpointFamily: 'openai-chat',
    capabilities: ['text', 'vision'],
    models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-1.5-flash'],
  },
  {
    // 本地框架：模型由用户在本地 `ollama pull` 安装，故不预置模型列表，用户自建模型即可
    id: 'ollama',
    labelKey: 'ai.providerOllama',
    apiType: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: '',
    endpointFamily: 'openai-chat',
    capabilities: ['text', 'vision'],
    models: [],
  },
];

/** 能力标签 → i18n key */
export const CAPABILITY_LABEL_KEY: Record<AiCapability, string> = {
  text: 'ai.capText',
  vision: 'ai.capVision',
  'image-gen': 'ai.capImageGen',
  'image-edit': 'ai.capImageEdit',
};

/** 模态 → i18n key */
export const MODALITY_LABEL_KEY: Record<AiModality, string> = {
  analyze: 'ai.modalityAnalyze',
  artistic: 'ai.modalityArtistic',
  generate: 'ai.modalityGenerate',
};

/** 按 baseUrl 反查供应商（用于配置区高亮当前所选预设） */
export function findProviderByBaseUrl(baseUrl: string): ProviderDef | undefined {
  const norm = (s: string) => s.replace(/\/+$/, '').toLowerCase();
  const target = norm(baseUrl);
  return PROVIDERS.find((p) => norm(p.baseUrl) === target);
}

/** 按 id 取供应商 */
export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
