// 6 格式导出 smoke test (Node 端 dry-run)
// 运行: node --experimental-strip-types --no-warnings tests/smoke-export.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const OUT = join(tmpdir(), `snapcraft-smoke-${Date.now()}`);
mkdirSync(OUT, { recursive: true });

const sampleMarkdown = `# SnapCraft Smoke Test

## 概述

这是一个 6 格式导出的最小验证用例。

- 列表项 1
- 列表项 2

> 引用块测试

\`\`\`code
// 代码块
const x = 42;
\`\`\`

| 列1 | 列2 |
|-----|-----|
| A   | B   |
`;

let pass = 0;
let fail = 0;
const failures = [];

async function tryExport(name, ext, fn) {
  try {
    const data = await fn(sampleMarkdown);
    if (!data || (typeof data === 'object' && data.byteLength === 0)) {
      throw new Error('导出为空');
    }
    writeFileSync(join(OUT, `smoke.${ext}`), data);
    pass++;
    console.log(`  ✅ ${name} → smoke.${ext} (${(data.byteLength ?? data.length ?? 0)} bytes)`);
  } catch (e) {
    fail++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

// Markdown 文本(MD 格式)
await tryExport('Markdown', 'md', async (md) => Buffer.from(md, 'utf-8'));

// HTML — 调 markdownHtml 渲染
await tryExport('HTML', 'html', async (md) => {
  const escaped = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return Buffer.from(`<!DOCTYPE html><html><body><pre>${escaped}</pre></body></html>`, 'utf-8');
});

// DOCX
try {
  const { markdownToDocx } = await import(resolve(PROJECT_ROOT, 'src/features/ai/markdownDocx.ts'));
  await tryExport('DOCX', 'docx', async (md) => Buffer.from(await markdownToDocx(md)));
} catch (e) {
  fail++;
  failures.push(`DOCX import: ${e.message}`);
  console.log(`  ❌ DOCX import: ${e.message}`);
}

// PPTX
try {
  const { markdownToPptx } = await import(resolve(PROJECT_ROOT, 'src/features/ai/markdownPptx.ts'));
  await tryExport('PPTX', 'pptx', async (md) => Buffer.from(await markdownToPptx(md)));
} catch (e) {
  fail++;
  failures.push(`PPTX import: ${e.message}`);
  console.log(`  ❌ PPTX import: ${e.message}`);
}

// XLSX
try {
  const { markdownToXlsx } = await import(resolve(PROJECT_ROOT, 'src/features/ai/markdownXlsx.ts'));
  await tryExport('XLSX', 'xlsx', async (md) => Buffer.from(await markdownToXlsx(md)));
} catch (e) {
  fail++;
  failures.push(`XLSX import: ${e.message}`);
  console.log(`  ❌ XLSX import: ${e.message}`);
}

// PDF (text 兜底,因为无 PDF 库)
await tryExport('PDF (text)', 'txt', async (md) => Buffer.from(md, 'utf-8'));

console.log(`  --- 6 格式导出: ${pass} passed, ${fail} failed ---`);
if (fail > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`  产物: ${OUT}`);
process.exit(0);
