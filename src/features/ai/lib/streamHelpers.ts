// src/features/ai/lib/streamHelpers.ts
// 从 aiStore.ts 提取的流式输出辅助函数与错误分类。
// 职责：流式节流缓冲、错误 i18n 映射、记忆注入文本构建、压缩系统指令。
// 纯函数，不持有状态，可独立测试。

import type { AiMemory } from '../aiTypes';
import { classifyAiError } from '../aiClient';
import { getLang } from '../../../i18n';

// ── 流式输出节流 ──
// 逐 token 调 set 会在长文生成时触发数千次重渲染导致卡顿。
// 改为闭包缓冲 + 100ms 批量 flush 一次 setState；流结束时 stop() 仅清定时器，
// 最终由 set({ output: full }) 用权威全量串校正，杜绝缓冲与全量重复追加。

export interface StreamSink {
  onChunk: (d: string) => void;
  onThinking: (t: string) => void;
  stop: () => void;
  /** 丢弃未 flush 的缓冲并把 store 的 output/thinking 清零。
   * 流式重试前调用：上一次尝试已流式输出的片段会被重试从头覆盖，
   * 不清零则两者叠加重复显示。 */
  reset: () => void;
}

export function makeStreamSink(set: (partial: any) => void): StreamSink {
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
    stop: () => {
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    },
    reset: () => {
      buf = '';
      bufThink = '';
      set({ output: '', thinking: '' });
    },
  };
}

// ── 错误分类 → i18n key ──

export function aiErrorI18nKey(e: any): string {
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

// ── 润色系统指令 ──

export function refineSystem(): string {
  const zh = getLang() === 'zh-CN';
  return zh
    ? '你是一位专业文档编辑。用户会给你一段 Markdown 文档和一条修改指令。\n\n' +
      '执行规则：\n' +
      '1. 严格按指令改写，保持原文核心信息与数据不变。\n' +
      '2. 保持 Markdown 格式完整（标题层级、列表、表格、引用块结构不破坏）。\n' +
      '3. 提升文字质量：消除冗余、统一语气、增强逻辑连贯性。\n' +
      '4. 若指令涉及结构调整（如「更简洁」「加表格」），在不丢失信息的前提下执行。\n' +
      '5. 直接输出改写后的完整文档，不加任何解释、前缀或后缀。'
    : 'You are a professional document editor. The user provides a Markdown document and a revision instruction.\n\n' +
      'Rules:\n' +
      '1. Rewrite strictly per the instruction, preserving all core information and data.\n' +
      '2. Maintain Markdown structure integrity (heading levels, lists, tables, blockquotes).\n' +
      '3. Improve writing quality: eliminate redundancy, unify tone, strengthen logical flow.\n' +
      '4. If the instruction involves restructuring (e.g., "more concise", "add tables"), execute without losing information.\n' +
      '5. Output only the revised full document in Markdown, with no commentary or preamble.';
}

// ── 文档生成语言指令 ──
// 修复：截图→文档预设（doc/copy/report/...）的 system 提示词写死中文，且含
// 「输出语言与截图中文字的语言保持一致」规则，导致 UI 设为英文时文档仍输出中文。
// 这里在英文 UI 下前置一条最高优先级英文指令，强制全篇英文并覆盖「跟随截图语言」规则。
// 中文 UI 返回空串，保持原中文行为（与截图文字语言一致）。
export function langOutputDirective(): string {
  const zh = getLang() === 'zh-CN';
  if (zh) return '';
  return (
    'CRITICAL LANGUAGE INSTRUCTION: The user\'s app interface language is set to English. ' +
    'You MUST write the ENTIRE response — all headings, prose, notes and the document body — in English. ' +
    'Ignore any rule in the instructions below that says to match the language of the text shown in the screenshot. ' +
    'All structural, formatting and quality requirements below still apply exactly; only the output language changes to English.\n\n'
  );
}

// ── 长期记忆注入 ──

/** 把长期记忆拼成注入 system 消息的提示文本 */
export function buildMemoryNote(memories: AiMemory[]): string {
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

// ── 压缩系统指令 ──

export function buildCompactSystem(zh: boolean): string {
  return zh
    ? '你是一个对话压缩助手，负责维护一份「滚动长期摘要」。规则：① 你会在下方收到【已有长期摘要】（可能为空）与【新增对话片段】；② 必须输出一份【更新后的完整摘要】，把新片段中的要点融合进已有摘要——保留全部既有事实、决策、数字、用户偏好与修改要求，只丢弃寒暄、重复与可丢弃草稿；③ 摘要应连贯、信息密度高，而非简单拼接；④ 若需标注重要性，在开头用单独一行 "IMPORTANCE: N"（N 为 1-5，越大越关键），其余均为摘要正文。不要输出任何解释性前缀。'
    : 'You are a conversation compressor maintaining a ROLLING long-term summary. Rules: 1) you will receive an [EXISTING SUMMARY] (may be empty) and a [NEW DIALOGUE SEGMENT]; 2) output an UPDATED COMPLETE summary that merges the new segment into the existing one — preserve ALL prior facts, decisions, numbers, user preferences and revision requests, dropping only greetings, repetition and disposable drafts; 3) the summary must be coherent and information-dense, not a naive concatenation; 4) if you want to flag importance, start with a single line "IMPORTANCE: N" (N from 1-5, higher = more critical); everything else is the summary body. Output no explanatory preamble.';
}

/** 解析 "IMPORTANCE: N" 前缀 */
export function parseImportance(raw: string): { text: string; importance: number } {
  const m = /IMPORTANCE:\s*([1-5])/i.exec(raw);
  if (!m) return { text: raw.trim(), importance: 3 };
  const importance = Number(m[1]);
  const text = raw.replace(/IMPORTANCE:\s*[1-5]/i, '').trim();
  return { text: text || raw.trim(), importance };
}

// ── ID 生成 ──

export function genId(): string {
  return `ai-tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function genMemId(): string {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
