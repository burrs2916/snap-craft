// ===== OCR 面板：纯工具函数与类型 =====
// 从 EnhancedScreenshotApp.tsx 提取，零 React / 零 Tauri 依赖。
// 包含：偏好/历史的 localStorage 读写、阅读顺序重排、搜索高亮、
// 实体提取、智能文本清洗、缩略图生成、格式化辅助。

import type { OcrBlock } from '../types';

// ── 常量 ──
export const OCR_PREF_KEY = 'snapcraft.ocr.prefs';
export const OCR_HIST_KEY = 'snapcraft.ocr.history';
// 5→50：扩容 10x，附缩略图后仍 < 5MB localStorage 限额（按 50*100KB 估算），零回归。
export const OCR_HIST_MAX = 50;

// ── 类型 ──
export interface OcrPrefs {
  lang: string;
  merge: boolean;
  autoCopy: boolean;
  // 'none' = 保留系统识别顺序（默认，零回归）；'reading' = 按版式坐标重排（多列/竖排）
  layout: OcrLayout;
  // 面板字号（px）：作用于结果文字，跨会话记住；默认 13 = 历史观感，零回归。
  fontSize: number;
  // 导出格式（txt/md/json/tsv）：跨会话记住上次选择，默认 'txt'。
  exportFmt: OcrExportFmt;
  // 智能实体提取（URL/邮箱/电话）：默认关（零回归），开启后从识别结果中一键提取可复制实体。
  extract: boolean;
  // 智能文本清洗（全半角归一 / 去 CJK 间空格 / 折叠空白）：默认关（零回归），
  // 开启后对「复制/导出文字」做安全规范化（不做字符猜测），提高中文截图取字后直贴文档的质量。
  clean: boolean;
}

// OCR 阅读顺序模式：'none' 保留 Vision/WinRT 原始读序；'reading' 按块坐标智能重排。
export type OcrLayout = 'none' | 'reading';
// OCR 导出格式：'txt' 纯文本 / 'md' Markdown / 'json' 带坐标 JSON / 'tsv' 带坐标 TSV。
export type OcrExportFmt = 'txt' | 'md' | 'json' | 'tsv';

// 智能实体提取结果
export interface OcrEntity {
  urls: string[];
  emails: string[];
  phones: string[];
}

export interface OcrHistItem {
  text: string;
  lang: string;
  ts: number;
  chars: number;
  // 来源截图缩略图（dataUrl，~10KB 缩到 80x60）。
  // 为空 = 来自剪贴板文字模式 / 或历史压缩前的旧记录；不影响核心识别回放。
  thumb?: string;
  // 来源截图 id（与 Rust history.json 同源）；点击可回放到该截图。
  sourceId?: string;
}

// ── 阅读顺序重排 ──
// 智能阅读顺序：按块坐标把乱序的识别结果重排为正常阅读顺序。
// - 横排多列：先按 x 把块聚成列（列间水平间隙明显大于列内行距），列内从上到下、列间从左到右。
// - 竖排（多数块高>宽）：列内从上到下、列间从右到左。
// 返回的是「原始块下标」的排序数组，ocrVisibleLines 仍用原下标索引 ocrEdits，编辑映射不破坏。
// 纯几何启发式、无平台/网络依赖；仅在用户开启「按版式重排」时调用，默认关闭不影响原行为。
export function ocrReadingOrder(blocks: OcrBlock[]): number[] {
  const idx = blocks.map((_, i) => i);
  if (blocks.length < 2) return idx;

  const vertCount = blocks.filter((b) => b.h > b.w * 1.2).length;
  const isVertical = vertCount > blocks.length / 2;

  if (isVertical) {
    // 竖排：同一（x 相近）列内按 y 从上到下；不同列按 x 从右到左。
    return [...idx].sort((a, b) => {
      const A = blocks[a];
      const B = blocks[b];
      const ax = A.x + A.w / 2;
      const bx = B.x + B.w / 2;
      const ay = A.y + A.h / 2;
      const by = B.y + B.h / 2;
      if (Math.abs(ax - bx) < (A.w + B.w) / 2) return ay - by; // 同列
      return bx - ax; // 不同列：右→左
    });
  }

  // 横排：按中心 x 排序后，依据相邻块水平间隙切分列。
  const byX = [...idx].sort(
    (a, b) => blocks[a].x + blocks[a].w / 2 - (blocks[b].x + blocks[b].w / 2)
  );
  const columns: number[][] = [];
  let cur: number[] = [byX[0]];
  for (let k = 1; k < byX.length; k++) {
    const prev = blocks[byX[k - 1]];
    const curB = blocks[byX[k]];
    const gap = curB.x + curB.w / 2 - (prev.x + prev.w / 2);
    const avgW = (prev.w + curB.w) / 2;
    if (gap > avgW * 0.6) {
      columns.push(cur);
      cur = [byX[k]];
    } else {
      cur.push(byX[k]);
    }
  }
  columns.push(cur);
  // 列内按 y 从上到下
  columns.forEach((col) => col.sort((a, b) => blocks[a].y - blocks[b].y));
  // 列间按起始 x 从左到右
  columns.sort((a, b) => blocks[a[0]].x - blocks[b[0]].x);
  return columns.flat();
}

// ── 搜索高亮 ──
// 把文字按搜索词切成高亮片段：大小写不敏感；不使用正则，避免特殊字符注入。
// 渲染时 hit=true 的片段用 <mark> 包裹。空查询返回单段（整段非命中，零渲染变化）。
export function ocrHighlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text, hit: false }];
  const lt = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: { text: string; hit: boolean }[] = [];
  let idx = 0;
  let at = lt.indexOf(ql, idx);
  while (at >= 0) {
    if (at > idx) out.push({ text: text.slice(idx, at), hit: false });
    out.push({ text: text.slice(at, at + q.length), hit: true });
    idx = at + q.length;
    at = lt.indexOf(ql, idx);
  }
  if (idx < text.length) out.push({ text: text.slice(idx), hit: false });
  return out;
}

// ── 智能实体提取 ──
// 从识别结果文本中按需提取 URL / 邮箱 / 电话号码，便于一键复制。
// 纯前端、无正则注入风险：每个类别用独立的安全正则 + 去重（Set）；不进入复制/导出/贴回数据链，
// 仅作为面板内的辅助视图（WYSIWYG：提取自当前可见/纳入集合文字，受搜索/置信度/勾选影响）。
// 返回已去重、按出现顺序保留的实体数组；未识别到则对应数组为空。
export function ocrExtractEntities(text: string): OcrEntity {
  const urls = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  if (!text) return { urls: [], emails: [], phones: [] };

  // URL：http(s):// 或 www. 开头，截到空白/引号/中文标点为止；去掉结尾可能的标点。
  const urlRe = /(?:https?:\/\/|www\.)[^\s<>"'」』）)】〗，。、；：！？]+/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    const u = m[0].replace(/[)\]】』」』）.,;:!?]+$/, '');
    if (u.length > 4) urls.add(u);
  }

  // 邮箱：标准 user@domain.tld 形态。
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  while ((m = emailRe.exec(text)) !== null) emails.add(m[0]);

  // 电话：7–14 位数字，可含空格/括号/连字符/点；过滤纯日期（YYYY-MM-DD 等）与过短/过长。
  const phoneRe = /(\+?\d[\d\s\-().]{5,}\d)/g;
  const isDate = (s: string) => /^\d{4}[-.\s]\d{1,2}[-.\s]\d{1,2}$/.test(s.trim());
  while ((m = phoneRe.exec(text)) !== null) {
    const p = m[0].trim();
    const digits = p.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 14) continue;
    if (isDate(p)) continue; // 避免把日期误判为电话
    // 必含分隔特征：国际号(+)、空格、括号，或含连字符/点（且非日期）；
    // 纯数字串仅接受 11 位（中国大陆手机号启发式），规避价格/编号等长数字误判。
    const ok =
      p.startsWith('+') ||
      /[\s()]/.test(p) ||
      /[-.]/.test(p) ||
      digits.length === 11;
    if (ok) phones.add(p);
  }

  return {
    urls: [...urls],
    emails: [...emails],
    phones: [...phones],
  };
}

// ── 智能文本清洗 ──
// 对识别结果做「安全规范化」，提高中文截图取字后直贴文档的质量。
// 仅做可逆的格式整理，绝不做 1→l / O→0 之类的字符猜测（避免误导）。
// 步骤：① NFKC 全半角归一（全角字母/数字/括号/全角空格→半角）②去 CJK/Kana 之间的多余空格
// （OCR 常见逐字空格）③折叠连续空白为单空格 ④逐行去尾随空白 ⑤>=3 连续换行折叠为单空行。
// 纯前端、无平台/网络依赖；仅在用户开启「智能清洗」时调用，默认关闭不进入任何数据链。
function isCJKChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x3000 && c <= 0x30ff) || // CJK 符号/标点 + 平假名 + 片假名
    (c >= 0x3400 && c <= 0x9fff) || // CJK 扩展 A + 基本汉字
    (c >= 0xf900 && c <= 0xfaff) || // 兼容汉字
    (c >= 0xff66 && c <= 0xff9f)    // 半角片假名
  );
}
function removeSpacesBetweenCJK(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      const prev = out.length ? out[out.length - 1] : '';
      const next = s[i + 1] ?? '';
      // 仅当两个相邻字符都是 CJK/Kana 时才跳过中间的空格（英文单词内空格保留）
      if (prev && next && isCJKChar(prev) && isCJKChar(next)) continue;
    }
    out.push(ch);
  }
  return out.join('');
}
export function ocrCleanText(text: string): string {
  if (!text) return text;
  let s = text.normalize('NFKC');            // 全半角归一
  s = removeSpacesBetweenCJK(s);             // 去 CJK 间逐字空格
  s = s.replace(/[ \t]+/g, ' ');             // 折叠连续空白
  s = s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n'); // 逐行去尾随空白
  s = s.replace(/\n{3,}/g, '\n\n');          // 折叠多余空行
  return s;
}

// ── 缩略图生成 ──
// 生成小尺寸缩略图 dataUrl（用于 OCR 历史项左侧缩略图，零依赖）。
// 失败返回空串（不抛错，不影响识别主流程）。
export function makeThumbDataUrl(src: string, w: number, h: number): string {
  if (!src) return '';
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    const img = new Image();
    // 同步取：用完即弃；dataUrl 同源，无需 crossOrigin
    img.src = src;
    // 注意：调用方需在 onload 后再读取，但本函数被用于 push 时已识别完成；
    // 真实场景下用 getMergedImageDataUrl → 已渲染 canvas，img.complete 几乎必为 true
    // ——若为 false，drawImage 静默失败，返回空串兜底。
    try {
      ctx.drawImage(img, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.7);
    } catch {
      return '';
    }
  } catch {
    return '';
  }
}

// ── localStorage 读写 ──
export function loadOcrPrefs(): OcrPrefs {
  const def: OcrPrefs = { lang: 'auto', merge: false, autoCopy: false, layout: 'none', fontSize: 14, exportFmt: 'txt', extract: false, clean: false };
  try {
    const raw = localStorage.getItem(OCR_PREF_KEY);
    if (raw) return { ...def, ...(JSON.parse(raw) as Partial<OcrPrefs>) };
  } catch {
    /* ignore */
  }
  return def;
}
export function saveOcrPrefs(p: OcrPrefs) {
  try {
    localStorage.setItem(OCR_PREF_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
export function loadOcrHist(): OcrHistItem[] {
  try {
    const raw = localStorage.getItem(OCR_HIST_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v as OcrHistItem[];
    }
  } catch {
    /* ignore */
  }
  return [];
}
export function saveOcrHist(h: OcrHistItem[]) {
  try {
    localStorage.setItem(OCR_HIST_KEY, JSON.stringify(h));
  } catch {
    /* ignore */
  }
}

// ── 格式化辅助 ──
// 历史项语言短标签（与地区无关，避免依赖运行时 i18n）
export function ocrLangTag(lang: string): string {
  if (lang === 'zh-Hans') return '中';
  if (lang === 'en-US') return 'EN';
  if (lang === 'ja-JP') return '日';
  return 'A';
}
export function fmtOcrTime(ts: number): string {
  try {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return '';
  }
}
