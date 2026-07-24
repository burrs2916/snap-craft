// src/features/ai/lib/persistence.ts
// 从 aiStore.ts 提取的 localStorage 持久化层。
// 职责：配置、模板、对话线程的读写，与业务逻辑完全解耦。
// 所有函数均为纯 I/O，不持有状态，方便单元测试与替换存储后端。

import type { AiConfig, AiChatTurn } from '../aiTypes';
import type { UserPreset } from '../aiPresets';

// ── 存储键 ──

const STORAGE_KEY = 'snapcraft-ai-config';
const TPL_KEY = 'snapcraft-ai-templates';
const CONV_PREFIX = 'snapcraft-ai-conv:';

// ── 配置 ──

const DEFAULT_CONFIG: AiConfig = {
  apiType: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  theme: 'modern',
};

export function loadConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
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
