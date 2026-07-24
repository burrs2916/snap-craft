// src/features/ai/lib/conversationIndex.ts
// 从 aiStore.ts 提取的「跨截图 AI 文档历史库」索引管理。
// 职责：维护轻量索引（标题/预览/缩略图/时间戳），支持列表、删除、fork。
// 与对话线程的读写（persistence.ts）配合，但自身不持有对话内容。

import type { AiChatTurn } from '../aiTypes';
import type { AiPreset } from '../aiPresets';
import { loadConversation, saveConversation, removeConversation, removeSelection } from './persistence';
import { removeMemories } from '../aiMemory';
import { t } from '../../../i18n';

// ── 索引存储 ──

const INDEX_KEY = 'snapcraft-ai-conv-index';

export interface AiConvMeta {
  hash: string;
  presetId: string;
  presetName: string;
  firstGoal: string;
  preview: string;
  thumb?: string;
  msgCount: number;
  updatedAt: number;
  parent?: string;
}

// ── 索引 CRUD ──

export function loadConvIndex(): AiConvMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AiConvMeta[]) : [];
  } catch {
    return [];
  }
}

export function saveConvIndex(list: AiConvMeta[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  } catch {
    /* 忽略（配额超限等） */
  }
}

export function upsertConvMeta(item: AiConvMeta): void {
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

export function removeConvMeta(hash: string): void {
  const list = loadConvIndex().filter((m) => m.hash !== hash);
  saveConvIndex(list);
}

// ── 预览与缩略图 ──

/** 取末轮 AI 成稿并去标记，作为列表预览 */
export function previewOf(conv: AiChatTurn[]): string {
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

/** 缩略图：把编辑后截图压到 max 宽（JPEG 0.7），最佳努力、失败静默 */
export function downscaleThumb(dataUrl?: string, max = 200): Promise<string | undefined> {
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

// ── 高层操作 ──

/** 写入/更新索引（含异步缩略图回写） */
export function recordConvMeta(
  hash: string,
  conv: AiChatTurn[],
  preset: AiPreset,
  imageDataUrl?: string,
  title?: string,
): void {
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
}

/** 列出全部历史 AI 文档（按更新时间倒序） */
export function listConvMeta(): AiConvMeta[] {
  return loadConvIndex().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 按哈希取回完整对话线程 */
export function getConvByHash(hash: string): AiChatTurn[] {
  return loadConversation(hash);
}

/** 删除某条历史对话（同时清掉线程与索引项） */
export function deleteConv(hash: string): void {
  removeConversation(hash);
  removeConvMeta(hash);
}

/** 复制一条对话线程为新分支，返回新线程 hash */
export function forkConversation(
  sourceHash: string,
  uptoIndex?: number,
  activePresetId?: string,
): string | null {
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
  // 源索引项（拿 preset / 缩略图）
  const srcMeta = loadConvIndex().find((m) => m.hash === sourceHash);
  const preset: AiPreset = srcMeta
    ? ({ id: srcMeta.presetId, name: srcMeta.presetName } as AiPreset)
    : ({ id: activePresetId || 'custom', name: 'Fork' } as AiPreset);
  const baseTitle = (srcMeta?.firstGoal || sliced.find((m) => m.role === 'user')?.content || '').trim().slice(0, 70);
  recordConvMeta(newHash, sliced, preset, undefined, baseTitle + t('ai.forkSuffix'));
  // 把 parent 标记 + 复用源缩略图写回索引
  const list = loadConvIndex();
  const i = list.findIndex((m) => m.hash === newHash);
  if (i >= 0) {
    list[i] = { ...list[i], parent: sourceHash, thumb: srcMeta?.thumb ?? list[i].thumb };
    saveConvIndex(list);
  }
  return newHash;
}

// ── 脏数据清理：删除截图时级联清除所有关联 AI 数据 ──

const CONV_PREFIX = 'snapcraft-ai-conv:';
const SEL_PREFIX = 'snapcraft-ai-sel:';
const MEM_PREFIX = 'snapcraft-ai-mem:';

/**
 * 彻底清除某张截图关联的全部 AI localStorage 数据：
 * - conv:<hash>（对话线程）
 * - sel:<hash>（多截图选择顺序）
 * - mem:<hash>（AI 长期记忆）
 * - conv:<hash>::fork-*（所有 fork 分支对话）
 * - conv-index 中 hash 匹配或 parent 指向该 hash 的条目
 */
export function purgeAiDataForHash(hash: string): void {
  // 1. 移除主键
  removeConversation(hash);
  removeSelection(hash);
  removeMemories(hash);

  // 2. 扫描并移除所有 fork 分支（键格式：snapcraft-ai-conv:<hash>::fork-xxx）
  const forkPrefix = CONV_PREFIX + hash + '::';
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(forkPrefix)) keysToRemove.push(k);
  }
  keysToRemove.forEach((k) => localStorage.removeItem(k));

  // 3. 清理 conv-index：移除自身 + 所有以该 hash 为 parent 的 fork 条目
  const list = loadConvIndex();
  const filtered = list.filter(
    (m) => m.hash !== hash && m.parent !== hash && !m.hash.startsWith(hash + '::'),
  );
  if (filtered.length !== list.length) saveConvIndex(filtered);
}

/**
 * 清空全部 AI localStorage 数据（用于「清空历史」场景）。
 * 遍历所有键，移除 conv:/sel:/mem: 前缀及 conv-index。
 */
export function purgeAllAiData(): void {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (
      k &&
      (k.startsWith(CONV_PREFIX) ||
        k.startsWith(SEL_PREFIX) ||
        k.startsWith(MEM_PREFIX) ||
        k === INDEX_KEY)
    ) {
      keysToRemove.push(k);
    }
  }
  keysToRemove.forEach((k) => localStorage.removeItem(k));
}
