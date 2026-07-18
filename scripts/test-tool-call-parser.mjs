// 多形态工具调用解析器 - 独立验证脚本
// 运行：node --experimental-strip-types scripts/test-tool-call-parser.mjs
// （Node 22+ 原生支持 TS 剥离；走 ESM 直跑）
//
// 覆盖：4 种形态 + 混合 + 边界；与 aiClient stableToolKey 同源的去重；stripShapedToolCalls。

import {
  parseShapedToolCalls,
  toAiToolCalls,
  stripShapedToolCalls,
  looksLikeShapedToolCall,
} from '../src/features/ai/toolCallParser.ts';

let pass = 0;
let fail = 0;
const failures = [];

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`❌ ${msg}\n   期望: ${e}\n   实际: ${a}`);
  }
}

function ok(cond, msg) {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(`❌ ${msg}`);
  }
}

// ─── Case 1: JSON 围栏（最常见）───
{
  const text = '我先帮你圈出重点区域：\n```json\n{"name":"draw_rectangle","arguments":{"x":0.1,"y":0.2,"w":0.4,"h":0.3,"label":"核心数据"}}\n```\n请查看。';
  const r = parseShapedToolCalls(text);
  eq(r.calls.length, 1, 'C1 围栏：解析出 1 条');
  eq(r.calls[0]?.name, 'draw_rectangle', 'C1 name');
  eq(r.calls[0]?.arguments.label, '核心数据', 'C1 label');
  eq(r.calls[0]?.kind, 'json_fenced', 'C1 kind=json_fenced');
  const cleaned = stripShapedToolCalls(text, r.ranges);
  ok(!cleaned.includes('draw_rectangle'), 'C1 strip 后不再含工具调用');
  ok(cleaned.includes('我先帮你圈出重点区域'), 'C1 strip 保留正文');
}

// ─── Case 2: JSON 裸对象 ───
{
  const text = '好的，结果如下：{"name":"redact_area","arguments":{"x":0.05,"y":0.7,"w":0.3,"h":0.15,"mode":"blur","strength":12}}';
  const r = parseShapedToolCalls(text);
  eq(r.calls.length, 1, 'C2 裸对象：1 条');
  eq(r.calls[0]?.name, 'redact_area', 'C2 name');
  eq(r.calls[0]?.arguments.mode, 'blur', 'C2 mode');
  eq(r.calls[0]?.kind, 'json_bare', 'C2 kind=json_bare');
}

// ─── Case 3: OpenAI 标准 { tool_calls: [...] } ───
{
  const text = '```json\n{"tool_calls":[{"name":"highlight_text","arguments":{"x":0.2,"y":0.2,"w":0.5,"h":0.05}}]}\n```';
  const r = parseShapedToolCalls(text);
  eq(r.calls.length, 1, 'C3 tool_calls：1 条');
  eq(r.calls[0]?.name, 'highlight_text', 'C3 name');
  eq(r.calls[0]?.arguments.x, 0.2, 'C3 x=0.2');
}

// ─── Case 4: XML 风格 ───
{
  const text2 = '<tool_call name="draw_rectangle">{"x":0.1,"y":0.2,"w":0.4,"h":0.3}</tool_call>';
  const r = parseShapedToolCalls(text2);
  eq(r.calls.length, 1, 'C4 XML：1 条');
  eq(r.calls[0]?.name, 'draw_rectangle', 'C4 name');
  eq(r.calls[0]?.kind, 'xml', 'C4 kind=xml');
}

// ─── Case 5: Bracketed ───
{
  const text = '我先做识别 [summarize_region]{"x":0.2,"y":0.3,"w":0.4,"h":0.2}[/END_TOOL_REQUEST] 然后输出结果。';
  const r = parseShapedToolCalls(text);
  eq(r.calls.length, 1, 'C5 Bracketed：1 条');
  eq(r.calls[0]?.name, 'summarize_region', 'C5 name');
  eq(r.calls[0]?.kind, 'bracketed', 'C5 kind=bracketed');
  const cleaned = stripShapedToolCalls(text, r.ranges);
  ok(!cleaned.includes('summarize_region'), 'C5 strip 后不再含工具名');
  ok(cleaned.includes('我先做识别'), 'C5 strip 保留前半');
  ok(cleaned.includes('然后输出结果'), 'C5 strip 保留后半');
}

// ─── Case 6: ReAct 风格 ───
{
  const text = '好的，我来执行。\nAction: draw_rectangle\nAction Input: {"x":0.1,"y":0.2,"w":0.3,"h":0.3}';
  const r = parseShapedToolCalls(text);
  eq(r.calls.length, 1, 'C6 ReAct：1 条');
  eq(r.calls[0]?.name, 'draw_rectangle', 'C6 name');
  eq(r.calls[0]?.kind, 'react', 'C6 kind=react');
}

// ─── Case 7: 一次回复多个工具（混合形态）───
{
  const text = '先画框再打码：\n```json\n{"name":"draw_rectangle","arguments":{"x":0.1,"y":0.1,"w":0.2,"h":0.2}}\n```\n然后 [redact_area]{"x":0.5,"y":0.5,"w":0.2,"h":0.2,"mode":"black"}[/END_TOOL_REQUEST]';
  const r = parseShapedToolCalls(text);
  eq(r.calls.length, 2, 'C7 混合：2 条');
  eq(r.calls[0]?.name, 'draw_rectangle', 'C7 first');
  eq(r.calls[1]?.name, 'redact_area', 'C7 second');
}

// ─── Case 8: 重复同一条（同 fingerprint 去重）───
{
  const text = '```json\n{"name":"draw_rectangle","arguments":{"x":0.1,"y":0.1,"w":0.2,"h":0.2}}\n``` 重复 [draw_rectangle]{"x":0.1,"y":0.1,"w":0.2,"h":0.2}[/END_TOOL_REQUEST]';
  const r = parseShapedToolCalls(text);
  eq(r.calls.length, 1, 'C8 重复去重：1 条');
}

// ─── Case 9: 字符串内含 JSON 字符（不误判）───
{
  const text = '回复说："例如 {"name":"draw_rectangle"} 是工具调用" 然后继续说明。';
  // 完整字符串被外层双引号包裹，无法独立平衡 → 应当不识别
  // 我们的 findBalancedJsonEnd 会基于字符串边界判定，应该不命中
  const r = parseShapedToolCalls(text);
  // 注：此场景会被错误识别（裸对象在字符串中），这是一个已知的简化限制；
  // 但当 arguments 不是 object 时我们的 extractCallsFromValue 会过滤掉
  // 所以即便识别了 raw JSON，最终 calls 应为 0
  eq(r.calls.length, 0, 'C9 字符串内伪 JSON：0 条（args 提取过滤）');
}

// ─── Case 10: 无工具调用（普通文本）───
{
  const text = '你好，这是一段说明文字，不含任何工具调用。';
  const r = parseShapedToolCalls(text);
  eq(r.calls.length, 0, 'C10 普通文本：0 条');
  ok(!looksLikeShapedToolCall(text), 'C10 粗筛不命中');
}

// ─── Case 11: arguments 为字符串 JSON ───
{
  const text = '```json\n{"name":"draw_rectangle","arguments":"{\\"x\\":0.1,\\"y\\":0.2,\\"w\\":0.3,\\"h\\":0.3}"}\n```';
  const r = parseShapedToolCalls(text);
  eq(r.calls.length, 1, 'C11 str-args：1 条');
  eq(r.calls[0]?.arguments.x, 0.1, 'C11 str-args 解析正确');
}

// ─── Case 12: toAiToolCalls 转换 ───
{
  const r = parseShapedToolCalls('```json\n{"name":"draw_rectangle","arguments":{"x":0.1,"y":0.2,"w":0.3,"h":0.3}}\n```');
  const ai = toAiToolCalls(r);
  eq(ai.length, 1, 'C12 toAiToolCalls: 1 条');
  ok(ai[0]?.id?.startsWith('shaped-'), 'C12 id 前缀 shaped-');
  ok(typeof ai[0]?.name === 'string', 'C12 name 是 string');
}

// ─── Case 13: 中英混排 markdown ───
{
  const text = '好的，我来做：\n\n```json\n{"name":"draw_rectangle","arguments":{"x":0.1,"y":0.2,"w":0.3,"h":0.3,"label":"重点"}}\n```\n\n请查看。';
  const r = parseShapedToolCalls(text);
  eq(r.calls.length, 1, 'C13 markdown 混排：1 条');
  const cleaned = stripShapedToolCalls(text, r.ranges);
  ok(cleaned.includes('好的，我来做'), 'C13 保留首句');
  ok(cleaned.includes('请查看'), 'C13 保留末句');
  ok(!cleaned.includes('"name"'), 'C13 strip 掉 JSON');
}

// ─── Case 14: 边界 - 超长 JSON 截断（不崩溃）───
{
  const big = 'x'.repeat(15_000);
  const text = `{"name":"draw_rectangle","arguments":{"x":0.1,"y":0.2,"w":0.3,"h":0.3,"data":"${big}"}}`;
  const r = parseShapedToolCalls(text);
  // 超过 MAX_JSON_CANDIDATE_CHARS=12_000 会被截断 → 解析失败 → 0 条（不崩溃）
  ok(Array.isArray(r.calls), 'C14 超长 JSON 不崩溃');
}

// ─── Case 15: 工具名非法（带空格）跳过 ───
{
  const text = '```json\n{"name":"draw rectangle","arguments":{}}\n```';
  const r = parseShapedToolCalls(text);
  // hasToolShape 要求 readToolName 返回非空 string，这里 "draw rectangle" 合法 string
  // 但 arguments 为 {} → readToolArgs 返回 undefined → hasToolShape 返回 false
  // 所以应被过滤
  eq(r.calls.length, 0, 'C15 空 args 过滤');
}

// ─── Case 16: OpenAI function 嵌套形态 ───
{
  const text = '```json\n{"function":{"name":"draw_rectangle","arguments":{"x":0.1,"y":0.2,"w":0.3,"h":0.3}}}\n```';
  const r = parseShapedToolCalls(text);
  eq(r.calls.length, 1, 'C16 function 嵌套：1 条');
  eq(r.calls[0]?.name, 'draw_rectangle', 'C16 name from function.name');
  eq(r.calls[0]?.arguments.x, 0.1, 'C16 args from function.arguments');
}

// ─── Case 17: detectedKinds 包含实际命中的形态 ───
{
  const text = '```json\n{"name":"a","arguments":{"x":0}}\n```[b]{"y":0}[/END_TOOL_REQUEST]';
  const r = parseShapedToolCalls(text);
  ok(r.detectedKinds.includes('json_fenced'), 'C17 kinds 含 json_fenced');
  ok(r.detectedKinds.includes('bracketed'), 'C17 kinds 含 bracketed');
  eq(r.detectedKinds.length, 2, 'C17 kinds 2 种');
}

// ─── Case 18: strip 多个连续区间 ───
{
  const text = '前 [a]{"x":0}[/END_TOOL_REQUEST] 中 [b]{"y":0}[/END_TOOL_REQUEST] 后';
  const r = parseShapedToolCalls(text);
  const cleaned = stripShapedToolCalls(text, r.ranges);
  eq(cleaned, '前 中 后', 'C18 strip 多区间拼接正确');
}

console.log(`\n=== 多形态工具调用解析器 - 独立验证 ===`);
console.log(`✅ 通过 ${pass} / ❌ 失败 ${fail}`);
if (fail > 0) {
  console.log('\n失败用例：');
  failures.forEach((f) => console.log(f));
  process.exit(1);
}
process.exit(0);
