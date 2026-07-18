// OCR 文本清洗 - 独立验证脚本
// 运行：node --experimental-strip-types scripts/test-ocr-clean.mjs
// 覆盖：零宽字符 / 控制字符 / 重复字截断 / 超长行截断 / 3+ 空格 / 边界

import { cleanOcrText, cleanOcrTextWithStats } from '../src/features/ai/ocrClean.ts';

let pass = 0;
let fail = 0;
const failures = [];

function eq(actual, expected, msg) {
  if (actual === expected) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`❌ ${msg}\n   期望: ${JSON.stringify(expected).slice(0, 80)}\n   实际: ${JSON.stringify(actual).slice(0, 80)}`);
  }
}

// ─── Case 1: 零宽字符（U+200B/C, U+FEFF BOM）───
eq(cleanOcrText('Hello\u200B\u200C\uFEFF world'), 'Hello world', 'C1 零宽字符');

// ─── Case 2: 控制字符（保留 \n \r \t）───
eq(cleanOcrText('line1\x00\x01\nline2\tcol'), 'line1\nline2\tcol', 'C2 控制字符');

// ─── Case 3: 9 个连续重复保留 ───
eq(cleanOcrText('啊'.repeat(9)), '啊'.repeat(9), 'C3 repeat-9 保留');

// ─── Case 4: 10 个连续重复截到 4 ───
eq(cleanOcrText('啊'.repeat(10)), '啊啊啊啊', 'C4 repeat-10 截断');

// ─── Case 5: 100 个连续重复 ───
eq(cleanOcrText('啊'.repeat(100)), '啊啊啊啊', 'C5 repeat-100 截断');

// ─── Case 6: 1000 个拉丁字符（连续重复→截到 4）───
eq(cleanOcrText('x'.repeat(1000)).length, 4, 'C6 repeat-LATIN-1000');

// ─── Case 7: 1000 个 CJK ───
eq(cleanOcrText('中'.repeat(1000)).length, 4, 'C7 repeat-CJK-1000');

// ─── Case 8: 混合行（中 200 + abc + x 800）───
eq(cleanOcrText('中'.repeat(200) + 'abc' + 'x'.repeat(800)).length, 11, 'C8 mixed');

// ─── Case 9: 合法长文本（400 字符）保留 ───
eq(cleanOcrText('你好世界'.repeat(100)).length, 400, 'C9 合法 400 字符');

// ─── Case 10: 合法长文本（600 字符）截断到 500+… ───
eq(cleanOcrText('你好世界'.repeat(150)).length, 501, 'C10 合法 600 字符');

// ─── Case 11: 3+ 连续空格 → 1 ───
eq(cleanOcrText('a    b'), 'a b', 'C11 3+ 空格');

// ─── Case 12: 边界空字符串 ───
eq(cleanOcrText(''), '', 'C12 empty');
eq(cleanOcrText(null), '', 'C12 null');
eq(cleanOcrText(undefined), '', 'C12 undefined');

// ─── Case 13: 正常文本不变 ───
eq(cleanOcrText('你好世界 hello world'), '你好世界 hello world', 'C13 正常文本');

// ─── Case 14: trim 头尾空白 ───
eq(cleanOcrText('  \n\nhello\n\n  '), 'hello', 'C14 trim 头尾');

// ─── Case 15: 详细统计 ───
{
  const r = cleanOcrTextWithStats('Hello\u200B\u200C\uFEFF world\x00');
  eq(r.stats.zeroWidth, 3, 'C15 stats.zeroWidth=3');
  eq(r.stats.control, 1, 'C15 stats.control=1');
  eq(r.text, 'Hello world', 'C15 text');
}

console.log(`\n=== OCR 文本清洗 - 独立验证 ===`);
console.log(`✅ 通过 ${pass} / ❌ 失败 ${fail}`);
if (fail > 0) {
  console.log('\n失败用例：');
  failures.forEach((f) => console.log(f));
  process.exit(1);
}
process.exit(0);
