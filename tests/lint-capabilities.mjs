#!/usr/bin/env node
/**
 * SnapCraft · 跨平台一致性 Lint (ACL 窗口授权 + 命令注册对等)
 * =============================================================
 *
 * 跨平台对等(parity)的关键防线。本脚本在 CI（typecheck job，ubuntu，零平台依赖）
 * 静态校验两类「两端一致地崩」的兼容性缺口：
 *
 * Phase 1 — 动态窗口 ACL 授权：
 *   GitHub Actions 在 Windows 真机构建时，任何「运行时动态创建的窗口 label」
 *   若未出现在 capabilities/*.json 的 `windows` 数组中，其 WebviewWindow 创建
 *   会被 Tauri 2 ACL 拒绝（前端 `.catch` 静默吞 → 表现「点了没反应」，但 macOS
 *   开发机因 label 门禁宽松而正常 → 经典「本地能跑、CI/真机崩」偏差）。
 *   校验：① 扫描前端所有 new WebviewWindow/Window/getByLabel 提取运行时 label 全集
 *         （含变量解析与模板串前缀推导）；② 解析 capabilities `windows` glob；
 *         ③ 断言全覆盖；④ 断言 core:webview:allow-create-webview-window 与
 *         core:window:allow-create 权限已授予。
 *
 * Phase 2 — 前端命令 ↔ 后端注册 对等：
 *   任何前端 invoke('<cmd>')（含 invoke<string>('...') 泛型）必须对应 lib.rs
 *   `generate_handler!` 注册的后端 #[tauri::command]。漏注册 → 该命令在
 *   macOS/Windows 上【一致地】被 Tauri 拒绝，前端 .catch 静默吞 → 功能"看着在、
 *   点了没反应"。这把「命令注册漂移 / 拼写错位」在编译前拦下，杜绝功能被静默阉割。
 *   解析能力：字面量、三元分支字面量（含嵌套）、泛型形式；纯动态表达式仅告警。
 *
 * 复用零新依赖、零环境依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const CAP_DIR = path.join(ROOT, 'src-tauri', 'capabilities');

// ---- glob 匹配（Tauri capability 用 fnmatch 风格：* 任意序列，? 单字符） ----
function globToRegex(glob) {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** 一个具体 label 是否被某 glob 覆盖 */
function labelMatchesGlob(label, glob) {
  return globToRegex(glob).test(label);
}

/** 模板串（含 ${...}）推导出的「label 前缀」是否被某 glob 覆盖。
 *  模板 label 形如 `editor-${id}`，其所有可能值 = 前缀 + 任意后缀，
 *  用 前缀+SENTINEL 探一下 glob 即可（SENTINEL 不含正则特殊字符）。 */
const SENTINEL = '__sc_lint_sentinel__';
function templateMatchesGlob(prefix, glob) {
  return globToRegex(glob).test(prefix + SENTINEL);
}

// ---- 递归扫描 src 下所有 .ts/.tsx ----
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// ---- 提取：字面量标签 / 变量定义 / 变量或字面量形式的建窗与 getByLabel ----
const literalLabelRe = /new\s+(?:WebviewWindow|Window)\s*\(\s*['"]([^'"]+)['"]/g;
const templateLabelRe = /new\s+(?:WebviewWindow|Window)\s*\(\s*`([^`]*)`/g;
const constRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:['"]([^'"]+)['"]|`([^`]*)`)/g;
const varUseRe = /new\s+(?:WebviewWindow|Window)\s*\(\s*([A-Za-z_$][\w$]*)/g;
const getByLabelLiteralRe = /getByLabel\s*\(\s*['"]([^'"]+)['"]/g;
const getByLabelTemplateRe = /getByLabel\s*\(\s*`([^`]*)`/g;
const getByLabelVarRe = /getByLabel\s*\(\s*([A-Za-z_$][\w$]*)/g;

const files = walk(SRC_DIR);
const varDefs = new Map(); // name -> literal label (or template prefix)
const requiredLabels = new Set(); // 具体 label
const requiredPrefixes = new Set(); // 模板 label 静态前缀

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');

  // 变量定义：name = 'literal' 或 name = `template-${x}`
  let m;
  constRe.lastIndex = 0;
  while ((m = constRe.exec(src))) {
    const name = m[1];
    if (m[2] !== undefined) varDefs.set(name, { kind: 'literal', value: m[2] });
    else if (m[3] !== undefined) {
      const idx = m[3].indexOf('${');
      const prefix = idx >= 0 ? m[3].slice(0, idx) : m[3];
      varDefs.set(name, { kind: 'template', value: prefix });
    }
  }

  // 字面量建窗
  literalLabelRe.lastIndex = 0;
  while ((m = literalLabelRe.exec(src))) requiredLabels.add(m[1]);

  // 模板串建窗：`editor-${id}` → 前缀 editor-
  templateLabelRe.lastIndex = 0;
  while ((m = templateLabelRe.exec(src))) {
    const idx = m[1].indexOf('${');
    if (idx >= 0) requiredPrefixes.add(m[1].slice(0, idx));
  }

  // 变量建窗：new WebviewWindow(label)
  varUseRe.lastIndex = 0;
  while ((m = varUseRe.exec(src))) {
    const def = varDefs.get(m[1]);
    if (!def) continue; // 未解析到的变量：保守忽略（不误报），由人工审查
    if (def.kind === 'literal') requiredLabels.add(def.value);
    else requiredPrefixes.add(def.value);
  }

  // getByLabel 字面量 / 模板 / 变量（引用的窗口 label 也必须被能力覆盖）
  getByLabelLiteralRe.lastIndex = 0;
  while ((m = getByLabelLiteralRe.exec(src))) requiredLabels.add(m[1]);
  getByLabelTemplateRe.lastIndex = 0;
  while ((m = getByLabelTemplateRe.exec(src))) {
    const idx = m[1].indexOf('${');
    if (idx >= 0) requiredPrefixes.add(m[1].slice(0, idx));
  }
  getByLabelVarRe.lastIndex = 0;
  while ((m = getByLabelVarRe.exec(src))) {
    const def = varDefs.get(m[1]);
    if (!def) continue;
    if (def.kind === 'literal') requiredLabels.add(def.value);
    else requiredPrefixes.add(def.value);
  }
}

// ---- 解析 capabilities/*.json ----
const capFiles = fs.existsSync(CAP_DIR)
  ? fs.readdirSync(CAP_DIR).filter((f) => f.endsWith('.json'))
  : [];
const windowsGlobs = new Set();
const permissions = new Set();
for (const f of capFiles) {
  const cap = JSON.parse(fs.readFileSync(path.join(CAP_DIR, f), 'utf8'));
  (cap.windows || []).forEach((g) => windowsGlobs.add(g));
  (cap.permissions || []).forEach((p) => permissions.add(p));
}

// ---- 校验 ----
const errors = [];
const warnings = [];

function isCovered(label, prefixes) {
  for (const g of windowsGlobs) {
    if (labelMatchesGlob(label, g)) return true;
  }
  for (const p of prefixes) {
    for (const g of windowsGlobs) {
      if (templateMatchesGlob(p, g)) return true;
    }
  }
  return false;
}

for (const label of requiredLabels) {
  if (!isCovered(label, [])) {
    errors.push(`窗口 label "${label}" 未被任何 capability glob 覆盖（windows: [${[...windowsGlobs].join(', ')}]）`);
  }
}
for (const p of requiredPrefixes) {
  if (!isCovered('__never_matches__', [p])) {
    errors.push(`模板窗口 label 前缀 "${p}" 未被任何 capability glob 覆盖`);
  }
}

// 动态建窗权限
for (const perm of ['core:webview:allow-create-webview-window', 'core:window:allow-create']) {
  if (!permissions.has(perm)) {
    errors.push(`缺少动态建窗权限: ${perm}`);
  }
}

// ============================================================
// Phase 2: 前端命令调用 ↔ 后端命令注册 对等校验
// ------------------------------------------------------------
// 任何前端 invoke('<cmd>')（含 invoke<string>('...') 泛型形式）必须对应
// src-tauri/src/lib.rs `tauri::generate_handler!` 中注册的后端 #[tauri::command]。
// 漏注册 → 该命令在 macOS / Windows 上【一致地】被 Tauri 拒绝，
// 前端 .catch 静默吞 → 功能"看着在、点了没反应"，CI/真机都崩。
// 这把"命令注册漂移 / 拼写错位"在编译前拦下，直接服务
// "GitHub Actions 编译产物在两端都能正常构建运行、功能不被静默阉割"。
//
// 解析能力：
//  - 字面量：invoke('cmd') / invoke<string>('cmd') → 直接作为必需命令
//  - 三元：invoke(kind==='screen' ? 'capture_screen' : 'capture_window')
//          → 提取所有分支字面量（条件是否变量无关，结果集已知即视为静态必需）
//  - 无法静态解析的动态表达式（如 invoke(variable)）→ 仅告警，不误报
// ============================================================
function indexOfTopLevel(s, ch) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === ch) return i;
  }
  return -1;
}

// 从 invoke 首参表达式收集所有字符串字面量；static=true 表示所有叶子都是字面量。
function collectLiterals(s) {
  s = s.trim();
  const q = indexOfTopLevel(s, '?');
  if (q === -1) {
    const m = /^'((?:[^'\\]|\\.)*)'$/.exec(s);
    if (m) return { lits: [m[1]], static: true };
    return { lits: [], static: false };
  }
  const rest = s.slice(q + 1);
  const c = indexOfTopLevel(rest, ':');
  if (c === -1) return { lits: [], static: false };
  const a = collectLiterals(rest.slice(0, c).trim());
  const b = collectLiterals(rest.slice(c + 1).trim());
  return { lits: [...a.lits, ...b.lits], static: a.static && b.static };
}

// ---- 解析后端注册命令集（直接解析 lib.rs 的 generate_handler! 宏块，
//      取每条命令的末段路径作为命令名，兼容 commands::mod::fn 与
//      licensing::commands::fn 等任意深度的路径写法；语义上即“该命令是否真在
//      generate_handler! 中注册”）。用括号配平扫描，避免宏体内 #[cfg(...)] 的 ]
//      提前截断匹配） ----
const libRsPath = path.join(ROOT, 'src-tauri', 'src', 'lib.rs');
const libRs = fs.readFileSync(libRsPath, 'utf8');
const registeredCmds = new Set();
const ghStart = libRs.indexOf('generate_handler!');
if (ghStart !== -1) {
  const openIdx = libRs.indexOf('[', ghStart);
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < libRs.length; i++) {
    if (libRs[i] === '[') depth++;
    else if (libRs[i] === ']') {
      depth--;
      if (depth === 0) { closeIdx = i; break; }
    }
  }
  if (closeIdx !== -1) {
    const body = libRs.slice(openIdx + 1, closeIdx);
    for (const raw of body.split(',')) {
      // 去掉行内 // 注释与 #[cfg(...)] 属性，避免干扰命令名提取
      const entry = raw.replace(/\/\/.*$/, '').replace(/#\[[^\]]*\]/g, '').trim();
      if (!entry) continue;
      const segs = entry.split('::');
      const last = segs[segs.length - 1];
      if (/^[a-z_][a-z0-9_]*$/.test(last)) registeredCmds.add(last);
    }
  }
}

// ---- 解析前端所有 invoke 首参 ----
// 先建「变量 → 字面量三元」映射（支持 invoke(cmd) 这种经变量中转的调用），
// 再解析每个 invoke：字面量/三元字面量 → 直接必需；变量 → 查映射；其它 → 仅告警。
const invokeRe = /invoke(?:<[^>]*>)?\(\s*([^,)]+)/g;
const varLiteralRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+)/g;
const requiredCmds = new Set();
const dynamicInvokes = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');

  // 变量 → 字面量集合（仅当 RHS 是字面量或三元字面量时记录，条件是否变量无关）
  const varLiteralMap = new Map();
  let vm;
  varLiteralRe.lastIndex = 0;
  while ((vm = varLiteralRe.exec(src))) {
    const res = collectLiterals(vm[2].trim());
    if (res.lits.length) varLiteralMap.set(vm[1], res);
  }

  let m;
  invokeRe.lastIndex = 0;
  while ((m = invokeRe.exec(src))) {
    const arg = m[1].trim();
    // 情形 A：直接字面量 / 三元字面量
    const direct = collectLiterals(arg);
    if (direct.lits.length) {
      direct.lits.forEach((l) => requiredCmds.add(l));
      if (!direct.static) dynamicInvokes.push(arg);
      continue;
    }
    // 情形 B：变量（如 invoke(cmd)），查映射
    if (varLiteralMap.has(arg)) {
      const res = varLiteralMap.get(arg);
      res.lits.forEach((l) => requiredCmds.add(l));
      if (!res.static) dynamicInvokes.push(arg);
      continue;
    }
    // 情形 C：其它不可静态解析的动态表达式
    dynamicInvokes.push(arg);
  }
}

// ---- 校验：每个必需命令都必须已注册 ----
for (const cmd of requiredCmds) {
  if (!registeredCmds.has(cmd)) {
    errors.push(
      `前端调用了未注册的后端命令 "${cmd}"（lib.rs generate_handler! 缺失）。` +
        `该命令在 macOS/Windows 上都会被 Tauri 拒绝，功能将静默失效。`
    );
  }
}
if (dynamicInvokes.length) {
  warnings.push(
    `以下 invoke 首参为动态表达式（无法静态解析全部命令），已尽力提取字面量并校验；` +
      `请人工复核其命令名拼写：${dynamicInvokes.join('  |  ')}`
  );
}

// ---- 输出 ----
console.log('=== SnapCraft 跨平台能力(ACL)一致性 Lint ===');
console.log(`扫描源文件: ${files.length} 个 (.ts/.tsx)`);
console.log(`capability 文件: ${capFiles.join(', ') || '(无)'}`);
console.log(`运行时窗口 label 全集 (${requiredLabels.size} 具体 + ${requiredPrefixes.size} 模板前缀):`);
if (requiredLabels.size) console.log('  - ' + [...requiredLabels].sort().join('\n  - '));
if (requiredPrefixes.size) console.log('  (模板前缀) - ' + [...requiredPrefixes].sort().join(', '));
console.log(`capability windows globs: [${[...windowsGlobs].join(', ')}]`);

// Phase 2 汇总
console.log(`\n--- Phase 2: 前端命令 ↔ 后端注册 对等 ---`);
console.log(`前端 invoke 命令全集 (${requiredCmds.size} 个):`);
if (requiredCmds.size) console.log('  - ' + [...requiredCmds].sort().join('\n  - '));
console.log(`后端已注册命令数: ${registeredCmds.size}`);
if (warnings.length) {
  for (const w of warnings) console.warn('  ⚠️ ' + w);
}

if (errors.length) {
  console.error('\n❌ 发现兼容性缺口（将导致 Windows 真机动态窗口被 ACL 拒绝 / 命令未注册功能静默失效）：');
  for (const e of errors) console.error('  • ' + e);
  process.exit(1);
}

console.log('\n✅ 跨平台一致性通过：① 全部运行时窗口 label 均被 capability 覆盖、动态建窗权限齐全；' +
  '② 全部前端 invoke 命令均在后端注册（无静默失效的功能）。');
process.exit(0);
