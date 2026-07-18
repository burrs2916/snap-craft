// 多形态工具调用解析器（Phase 16，对齐 openclaw shared/text/tool-call-shaped-text.ts）
//
// 设计目标：
//  - 当模型不支持原生 `tool_calls` 字段（如部分国产 LLM OpenAI 兼容接口在 stream=true 时
//    不下发 `choices[].delta.tool_calls`，只在文本里"伪"输出工具调用）时，从累积文本里
//    识别并解析出工具调用，转换为内部 `AiToolCall[]` 格式。
//  - 支持 4 种常见形态（按国产模型实测优先）：
//      1. JSON 围栏 ```json { "name": "...", "arguments": {...} } ```
//      2. JSON 裸对象：直接出现在文本里的 {...} 或 [{...}, {...}]
//      3. XML 风格：<tool_call name="...">{...}</tool_call>
//      4. Bracketed：[tool_name]{...}[/END_TOOL_REQUEST]
//      5. ReAct 风格：Action: tool_name\nAction Input: {...}
//  - 与原生 `tool_calls` 字段去重（同 name + 同参指纹）。
//  - 健壮的 JSON 平衡匹配：字符串内跳过转义、深度计数、超长截断。
//  - 容错：单条解析失败不阻断其它调用，全部失败则返回空数组（调用方退化到「无工具」）。
//
// 依赖：仅 0 个外部包，可被 aiClient / aiStore 任何环境使用。

import type { AiToolCall } from './aiTypes';

export type ShapedToolCallKind =
  | 'json_fenced'
  | 'json_bare'
  | 'xml'
  | 'bracketed'
  | 'react';

/** 解析出的单条工具调用（含来源形态，用于 UI 提示/调试） */
export interface ShapedToolCall {
  /** 工具名 */
  name: string;
  /** 已解析的参数对象 */
  arguments: Record<string, any>;
  /** 工具名+参数稳定指纹（与 aiClient.stableToolKey 同源；用于去重） */
  fingerprint: string;
  /** 文本里识别出的形态种类 */
  kind: ShapedToolCallKind;
  /** 原始匹配文本（用于从用户可见输出里抹掉） */
  raw: string;
  /** 该调用在原文本里的起始偏移（用于精确抹除） */
  start: number;
  /** 该调用在原文本里的结束偏移（不含） */
  end: number;
}

/** 多形态解析结果 */
export interface ShapedParseResult {
  calls: ShapedToolCall[];
  /** 已识别为工具调用的片段（按 start 升序；用于从最终输出中剔除） */
  ranges: Array<{ start: number; end: number; kind: ShapedToolCallKind }>;
  /** 调试/统计：本次扫描识别到的形态种类（去重） */
  detectedKinds: ShapedToolCallKind[];
}

// ─── 通用工具 ───

function readTrimmedString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t || undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function readToolName(rec: Record<string, unknown>): string | undefined {
  return (
    readTrimmedString(rec.name) ??
    readTrimmedString(rec.tool_name) ??
    readTrimmedString(rec.tool) ??
    readTrimmedString(rec.function_name) ??
    readTrimmedString(asRecord(rec.function)?.name)
  );
}

function readToolArgs(rec: Record<string, unknown>): Record<string, any> | undefined {
  // OpenAI 标准：{ name, arguments } 其中 arguments 可能是 string(JSON) 或 object
  const candidates: unknown[] = [
    rec.arguments,
    rec.args,
    rec.input,
    rec.parameters,
    asRecord(rec.function)?.arguments,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'string') {
      const s = c.trim();
      if (!s) continue;
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, any>;
        }
        // 若解析出来是数组等也跳过，让上层兜底
      } catch {
        continue;
      }
    } else if (typeof c === 'object' && !Array.isArray(c)) {
      return c as Record<string, any>;
    }
  }
  return undefined;
}

function hasToolShape(rec: Record<string, unknown>): rec is Record<string, unknown> {
  const name = readToolName(rec);
  if (!name) return false;
  // 名字里带空格/控制字符视为非法（防止幻觉 / 误判）
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/.test(name)) return false;
  const args = readToolArgs(rec);
  if (!args) return false;
  // 空 args 视为无意义调用
  if (Object.keys(args).length === 0) return false;
  return true;
}

/** 与 aiClient.stableToolKey 同源：按 key 排序后 JSON 序列化（深比较稳定） */
function stableFingerprint(name: string, args: Record<string, any>): string {
  const sorted: Record<string, any> = {};
  for (const k of Object.keys(args).sort()) sorted[k] = args[k];
  return `${name}:${JSON.stringify(sorted)}`;
}

// ─── JSON 平衡匹配（字符串内跳过转义）───

const MAX_JSON_CANDIDATE_CHARS = 12_000;

function findBalancedJsonEnd(text: string, start: number): number | null {
  const opening = text[start];
  if (opening !== '{' && opening !== '[') return null;
  const stack: string[] = [opening === '{' ? '}' : ']'];
  let inString = false;
  let escaped = false;
  for (let i = start + 1; i < text.length; i += 1) {
    if (i - start > MAX_JSON_CANDIDATE_CHARS) return null;
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (stack[stack.length - 1] !== ch) return null;
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return null;
}

// ─── 形态 1+2：JSON 围栏 / 裸对象 ───

const FENCE_RE = /```(?:json|tool|tool_call|function_call)?[^\n\r]*[\r\n]([\s\S]*?)```/gi;

function collectJsonCandidates(text: string): Array<{ start: number; end: number; raw: string }> {
  const out: Array<{ start: number; end: number; raw: string }> = [];
  // 围栏
  for (const m of text.matchAll(FENCE_RE)) {
    const idx = m.index ?? 0;
    const inner = (m[1] ?? '').trim();
    if (inner && inner.length <= MAX_JSON_CANDIDATE_CHARS) {
      out.push({ start: idx, end: idx + m[0].length, raw: inner });
    }
  }
  // 裸对象 / 裸数组
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    // 简单预过滤：上一字符若是字母/数字则视为被字符串内的子串，跳过
    if (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1])) continue;
    const end = findBalancedJsonEnd(text, i);
    if (end == null) continue;
    const raw = text.slice(i, end).trim();
    if (raw.length > 1) out.push({ start: i, end, raw });
    i = end - 1;
  }
  return out;
}

function parseJsonCandidate(
  raw: string,
  start: number,
  end: number,
  kind: ShapedToolCallKind,
): ShapedToolCall[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return extractCallsFromValue(parsed, start, end, raw, kind);
}

function extractCallsFromValue(
  v: unknown,
  start: number,
  end: number,
  raw: string,
  kind: ShapedToolCallKind,
): ShapedToolCall[] {
  // 数组：逐项展开
  if (Array.isArray(v)) {
    const out: ShapedToolCall[] = [];
    for (const item of v) {
      out.push(...extractCallsFromValue(item, start, end, raw, kind));
    }
    return out;
  }
  const rec = asRecord(v);
  if (!rec) return [];
  // tool_calls 数组（OpenAI 标准）
  const tc = rec.tool_calls ?? rec.toolCalls;
  if (Array.isArray(tc)) {
    const out: ShapedToolCall[] = [];
    for (const item of tc) {
      out.push(...extractCallsFromValue(item, start, end, raw, kind));
    }
    if (out.length) return out;
  }
  if (hasToolShape(rec)) {
    const name = readToolName(rec)!;
    const args = readToolArgs(rec)!;
    return [{ name, arguments: args, fingerprint: stableFingerprint(name, args), kind, raw, start, end }];
  }
  return [];
}

function detectJson(text: string): ShapedToolCall[] {
  const candidates = collectJsonCandidates(text);
  const out: ShapedToolCall[] = [];
  for (const c of candidates) {
    const k: ShapedToolCallKind = c.raw.startsWith('{') && text.slice(c.start, c.start + 3) === '```'
      ? 'json_fenced'
      : 'json_bare';
    out.push(...parseJsonCandidate(c.raw, c.start, c.end, k));
  }
  return out;
}

// ─── 形态 3：XML ───
// 容错：① 闭合标签 `</tool_call>` 之间的零宽/不可见字符（U+200B 等）经常被编辑器或模型插入
//     ② 自闭合 `<tool_call/>` 暂不处理（避免与围栏/裸 JSON 冲突）
//     ③ body 必须是合法 JSON（更稳健，便于后续统一处理）
const XML_TOOL_RE = /<tool_call\b([^>]*?)>([\s\S]*?)<\/\s*[\s\S]{0,5}?tool_call\s*>/gi;
const XML_NAME_RE = /\bname\s*=\s*["']([^"']{1,120})["']/i;
const XML_SELF_NAME_RE = /<tool_call\b[^>]*\bname\s*=\s*["']([^"']{1,120})["']/i;

function detectXml(text: string): ShapedToolCall[] {
  const out: ShapedToolCall[] = [];
  for (const m of text.matchAll(XML_TOOL_RE)) {
    const fullStart = m.index ?? 0;
    const fullEnd = fullStart + m[0].length;
    const attrs = m[1] ?? '';
    const body = (m[2] ?? '').trim();
    // ① name 在 <tool_call> 的属性里（推荐）
    // ② name 在 body 的 JSON 内（name 字段或 function.name 字段）
    const attrName = XML_NAME_RE.exec(attrs)?.[1];
    let name: string | undefined = attrName;
    let args: Record<string, any> | undefined;
    if (body) {
      try {
        const parsed = JSON.parse(body);
        const rec = asRecord(parsed);
        if (rec) {
          // 优先从 body JSON 拿 name，否则用属性 name
          name = readToolName(rec) ?? name;
          // body 有两种语义：
          //  1) {name, arguments} 形式 → 取 readToolArgs
          //  2) 直接是参数对象 → 整体作为 args（去掉 name 字段）
          const directArgs = readToolArgs(rec);
          if (directArgs && Object.keys(directArgs).length) {
            args = directArgs;
          } else {
            // 视为整体参数对象；剥离可能的 name 字段
            const { name: _n, tool_name: _t, tool: _t2, function: _f, ...rest } = rec;
            if (Object.keys(rest).length) {
              args = rest as Record<string, any>;
            }
          }
        }
      } catch {
        // body 不是 JSON 时只能取属性名 → 视为空调用，跳过
      }
    }
    if (!name) {
      const fallback = XML_SELF_NAME_RE.exec(m[0] ?? '')?.[1];
      name = fallback;
    }
    if (!name || !args) continue;
    out.push({
      name,
      arguments: args,
      fingerprint: stableFingerprint(name, args),
      kind: 'xml',
      raw: m[0],
      start: fullStart,
      end: fullEnd,
    });
  }
  return out;
}

// ─── 形态 4：Bracketed ───

const BRACKETED_RE = /\[([A-Za-z_][A-Za-z0-9_.:-]{0,119})\](\{[\s\S]*?\})\[\/END_TOOL_REQUEST\]/g;

function detectBracketed(text: string): ShapedToolCall[] {
  const out: ShapedToolCall[] = [];
  for (const m of text.matchAll(BRACKETED_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const name = m[1];
    const body = m[2];
    if (!name || !body) continue;
    let args: Record<string, any> | undefined;
    try {
      const parsed = JSON.parse(body);
      const rec = asRecord(parsed);
      if (rec) args = rec;
    } catch {
      continue;
    }
    if (!args) continue;
    out.push({
      name,
      arguments: args,
      fingerprint: stableFingerprint(name, args),
      kind: 'bracketed',
      raw: m[0],
      start,
      end,
    });
  }
  return out;
}

// ─── 形态 5：ReAct ───

const REACT_RE =
  /(?:^|\n)\s*Action\s*:\s*([A-Za-z_][A-Za-z0-9_.:-]{0,119})\s*(?:\r?\n)+\s*Action Input\s*:\s*(\{[\s\S]*?\})/g;

function detectReact(text: string): ShapedToolCall[] {
  const out: ShapedToolCall[] = [];
  for (const m of text.matchAll(REACT_RE)) {
    const start = m.index ?? 0;
    const name = m[1];
    const body = m[2];
    if (!name || !body) continue;
    let args: Record<string, any> | undefined;
    try {
      const parsed = JSON.parse(body);
      const rec = asRecord(parsed);
      if (rec) args = rec;
    } catch {
      continue;
    }
    if (!args) continue;
    const end = start + m[0].length;
    out.push({
      name,
      arguments: args,
      fingerprint: stableFingerprint(name, args),
      kind: 'react',
      raw: m[0],
      start,
      end,
    });
  }
  return out;
}

// ─── 去重 + 跨形态合并 ───

function dedupeByFingerprint(calls: ShapedToolCall[]): ShapedToolCall[] {
  const seen = new Set<string>();
  const out: ShapedToolCall[] = [];
  // 按 fingerprint 出现顺序保留首个（JSON > XML > Bracketed > ReAct，按数组顺序自然优先）
  for (const c of calls) {
    if (seen.has(c.fingerprint)) continue;
    seen.add(c.fingerprint);
    out.push(c);
  }
  return out;
}

/** 检测是否存在工具调用形态（粗筛，避免对无工具文本做深度解析） */
export function looksLikeShapedToolCall(text: string): boolean {
  if (!text) return false;
  return (
    /```(?:json|tool|tool_call|function_call)/i.test(text) ||
    /<\s*tool_call\b/i.test(text) ||
    /\[END_TOOL_REQUEST\]/i.test(text) ||
    /Action\s*:\s*[A-Za-z_][A-Za-z0-9_.:-]{0,119}\s*(?:\r?\n)+\s*Action Input\s*:/i.test(text) ||
    /\{\s*["']?(?:name|tool_name|function)["']?\s*:/i.test(text)
  );
}

/** 主入口：从累积文本中解析工具调用（多形态 + 去重） */
export function parseShapedToolCalls(text: string): ShapedParseResult {
  if (!text || !text.trim()) {
    return { calls: [], ranges: [], detectedKinds: [] };
  }
  // 顺序：JSON → XML → Bracketed → ReAct（覆盖范围最广的优先；dedupe 保证同 fp 不重复）
  const all: ShapedToolCall[] = [
    ...detectJson(text),
    ...detectXml(text),
    ...detectBracketed(text),
    ...detectReact(text),
  ];
  // 按 start 升序排序，便于 ranges 输出
  all.sort((a, b) => a.start - b.start);
  const deduped = dedupeByFingerprint(all);
  const ranges = deduped.map((c) => ({ start: c.start, end: c.end, kind: c.kind }));
  const detectedKinds = Array.from(new Set(deduped.map((c) => c.kind)));
  return { calls: deduped, ranges, detectedKinds };
}

/** 将 ShapedParseResult.calls 转为 aiStore/AIPanel 内部使用的 AiToolCall[] */
export function toAiToolCalls(parsed: ShapedParseResult): AiToolCall[] {
  return parsed.calls.map((c, i) => ({
    id: `shaped-${i}-${c.name}`,
    name: c.name,
    arguments: c.arguments,
  }));
}

/** 从最终输出文本中抹掉所有已识别为工具调用的片段（保留友好正文） */
export function stripShapedToolCalls(text: string, ranges: ShapedParseResult['ranges']): string {
  if (!ranges.length) return text;
  // 合并重叠区间、按 start 排序
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  let out = '';
  let cursor = 0;
  for (const m of merged) {
    out += text.slice(cursor, m.start);
    cursor = m.end;
  }
  out += text.slice(cursor);
  // 规整空白：连续 3+ 换行收成 2 个；连续 2+ 空格收成 1 个；首尾 trim
  return out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}
