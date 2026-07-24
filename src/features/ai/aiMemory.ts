// ===== AI 长期记忆子系统 =====
// 从 aiStore.ts 提取的记忆管理纯函数：
// 压缩、相关性检索、多因子加权、MMR 多样性重排。
// 零 React、零 Tauri 依赖，仅用 localStorage。

import type { AiMemory } from './aiTypes';

// ── 常量 ──
const MEM_PREFIX = 'snapcraft-ai-mem:';
export const MAX_LIVE_ENTRIES = 16;
export const COMPACT_ENTRIES = 4;
const MAX_RELEVANT = 5;
const ALWAYS_IMPORTANCE = 4;
const MEM_HALF_LIFE_DAYS = 14;
const W_RELEVANCE = 0.6;
const W_RECENCY = 0.2;
const W_IMPORTANCE = 0.2;
const MMR_LAMBDA = 0.7;

// 压缩调用守卫，避免与新一轮 chat 并发
let compacting = false;
export function isCompacting() { return compacting; }
export function setCompacting(v: boolean) { compacting = v; }

// ── 持久化 ──
export function loadMemories(key: string): AiMemory[] {
  try {
    const raw = localStorage.getItem(MEM_PREFIX + key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as AiMemory[]).map(withMemId);
  } catch {
    return [];
  }
}

export function saveMemories(key: string, mem: AiMemory[]) {
  try {
    localStorage.setItem(MEM_PREFIX + key, JSON.stringify(mem));
  } catch { /* 忽略写入失败 */ }
}

export function removeMemories(key: string): void {
  try {
    localStorage.removeItem(MEM_PREFIX + key);
  } catch { /* 忽略 */ }
}

// ── 检索 ──
/** 把文本切成检索 token：拉丁/数字词（小写）+ CJK 单字 + CJK 二元组 */
export function tokenize(text: string): string[] {
  const t = (text || '').toLowerCase();
  const tokens: string[] = [];
  const latin = t.match(/[a-z0-9]+/g);
  if (latin) tokens.push(...latin);
  const cjk = t.match(/[一-鿿]/g);
  if (cjk) {
    tokens.push(...cjk);
    for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk[i] + cjk[i + 1]);
  }
  return tokens;
}

/** 相关性得分：用户输入 token 在记忆摘要中的命中率（0~1） */
export function relevanceScore(input: string, summary: string): number {
  const a = new Set(tokenize(input));
  const b = new Set(tokenize(summary));
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const tk of a) if (b.has(tk)) hit++;
  return hit / a.size;
}

/** 时间衰减分量：0~1，越新越高 */
export function recencyComponent(createdAt?: number): number {
  if (!createdAt) return 0.5;
  const ageDays = Math.max(0, (Date.now() - createdAt) / 86_400_000);
  const lambda = Math.LN2 / MEM_HALF_LIFE_DAYS;
  return Math.exp(-lambda * ageDays);
}

/** 重要性归一：1→0，5→1 */
export function importanceNorm(m: AiMemory): number {
  return Math.max(0, Math.min(1, ((m.importance ?? 3) - 1) / 4));
}

/** 多因子复合分：相关性 + 时间衰减 + 重要性 */
export function compositeScore(input: string, m: AiMemory): number {
  return (
    W_RELEVANCE * relevanceScore(input, m.summary) +
    W_RECENCY * recencyComponent(m.createdAt) +
    W_IMPORTANCE * importanceNorm(m)
  );
}

/** 两条记忆摘要的 Jaccard 相似度（MMR 多样性度量） */
export function jaccardSim(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size && !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

/**
 * 从全部记忆中选出「本次应注入」的子集：
 *  - 记忆不多（≤MAX_RELEVANT）时全部注入（无回归）；
 *  - 否则：重要性≥ALWAYS_IMPORTANCE 恒注入，其余走复合分排序 → MMR 多样性贪心重排；
 *  - 返回按 createdAt 升序。
 */
export function selectMemories(input: string, memories: AiMemory[]): AiMemory[] {
  if (!memories.length) return [];
  if (memories.length <= MAX_RELEVANT) return memories;
  const must = memories.filter((m) => (m.importance ?? 3) >= ALWAYS_IMPORTANCE);
  const rest = memories.filter((m) => (m.importance ?? 3) < ALWAYS_IMPORTANCE);

  const scored = rest
    .map((m) => ({ m, s: compositeScore(input, m) }))
    .sort((x, y) => y.s - x.s);
  const quota = Math.max(0, MAX_RELEVANT - must.length);
  const poolSize = Math.min(scored.length, MAX_RELEVANT * 2);
  const pool = scored.slice(0, poolSize).map((x) => x.m);

  const picked: AiMemory[] = [];
  const poolCopy = [...pool];
  while (picked.length < quota && poolCopy.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < poolCopy.length; i++) {
      const cand = poolCopy[i];
      const maxSim = picked.length
        ? Math.max(...picked.map((p) => jaccardSim(cand.summary, p.summary)))
        : 0;
      const val = compositeScore(input, cand) - MMR_LAMBDA * maxSim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    picked.push(poolCopy.splice(bestIdx, 1)[0]);
  }

  return [...must, ...picked].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** 给记忆补一个稳定 id（加载旧数据时若缺失则合成） */
export function withMemId(m: AiMemory, i: number): AiMemory {
  return m.id ? m : { ...m, id: `legacy-${i}-${m.createdAt ?? i}` };
}
