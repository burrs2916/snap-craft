// src/features/ai/markdownPptx.ts
// 零依赖 PPTX 生成：手搓 store 模式 ZIP（CRC32，无任何第三方库）+ 最小可用 OOXML。
// 仅供 AI 助手模块「导出 PPT」使用。纯增量，不引入新依赖、不触碰 Rust。
//
// 设计取舍（MVP）：
// - 按 Markdown 的 # / ## 标题断页（每张标题 slide 一张），标题下正文渲染为文本框。
// - 支持：段落、无序列表(•)、有序列表(数字前缀)、引用(缩进灰斜体)、代码块(等宽)、表格行(降级等宽文本)。
// - 截图/图片首版不内嵌（OOXML media 关系复杂，留作后续增量）。AI 输出的文字要点/列表直接成演示稿。

import type { DocxImage } from './markdownDocx';
import type { DocThemeId } from './markdownHtml';

// 主题色与 DOCX / HTML 严格对齐：之前 PPTX 自带一套 6 主题（modern/classic/elegant/sunset/forest/rose），
// 但 UI 仅暴露 5 套（modern/elegant/magazine/product/tech），导致 magazine/product/tech 静默回退 modern
// → 用户选"杂志风"导出 PPTX 得到蓝色标题，与 HTML/DOCX 的珊瑚色不一致。
// 现在统一到 DocThemeId 五套，颜色值与 markdownDocx 的 THEME_ACCENT 一致。
const THEME_ACCENT: Record<DocThemeId, string> = {
  modern: '4F46E5', // 靛蓝
  elegant: '8B6F4E', // 暖棕
  magazine: 'FF6B5E', // 珊瑚
  product: '7C3AED', // 紫
  tech: '06B6D4', // 青
};

/** 从 dataUrl 头解析实际图片格式 → PPTX media 文件扩展名。
 *  修复前：无论 PNG/JPEG 都命名为 imageN.png，PowerPoint 严格模式会"文件已损坏"或图片不显示。
 *  修复后：按真实格式命名 + 在 [Content_Types].xml 中追加对应 Default 声明。
 *  默认回退 png（Tauri 截图实际就是 PNG）。 */
function mediaExtOfDataUrl(dataUrl: string): 'png' | 'jpeg' {
  if (!dataUrl) return 'png';
  const head = dataUrl.slice(0, 64).toLowerCase();
  if (head.startsWith('data:image/jpeg') || head.startsWith('data:image/jpg')) return 'jpeg';
  return 'png';
}

export interface MarkdownToPptxOptions {
  title?: string;
  subtitle?: string;
  /** 主题：与 DOCX / HTML 的 DocThemeId 对齐（modern/elegant/magazine/product/tech） */
  theme?: DocThemeId;
  // 图文报告：按 markdown 内 <!--SNAP:k--> 标记把对应截图嵌到对应幻灯片（对齐 docx 行为）。
  sectionImages?: DocxImage[];
  // 无标记时的兜底：把全部截图作为前置内嵌，放在第一张内容幻灯片（标题/正文之前）。
  images?: DocxImage[];
}

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- store 模式 ZIP（零依赖）----------
interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function zipStore(files: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // general flag: UTF-8 filename
    dv.setUint16(8, 0, true); // method: store
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    chunks.push(local, f.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, time, true);
    cdv.setUint16(14, date, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + f.data.length;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const centralOffset = offset;
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralOffset, true);
  edv.setUint16(20, 0, true);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of all) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

// ---------- 图片内嵌辅助（PPTX media 部件）----------
function base64ToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 从 dataUrl 头解码像素尺寸（PNG / JPEG），失败回退 16:9，用于按比例排布图片避免拉伸。
function dataUrlDims(dataUrl: string): { w: number; h: number } {
  try {
    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const w = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
      const h = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
      if (w && h) return { w, h };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let off = 2;
      while (off + 9 < bytes.length) {
        if (bytes[off] !== 0xff) {
          off++;
          continue;
        }
        const marker = bytes[off + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const h = (bytes[off + 5] << 8) | bytes[off + 6];
          const w = (bytes[off + 7] << 8) | bytes[off + 8];
          if (w && h) return { w, h };
        }
        const len = (bytes[off + 2] << 8) | bytes[off + 3];
        if (len < 2) break;
        off += 2 + len;
      }
    }
  } catch {
    /* 回退默认比例 */
  }
  return { w: 16, h: 9 };
}

// ---------- XML helpers ----------
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
function encStr(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---------- Markdown → slides ----------
interface SlideSpec {
  title: string;
  level: number;
  body: string[];
  // 本页要内嵌的图片（按出现顺序）：依赖 <!--SNAP:k--> 标记或整体前置兜底
  pics: PptxPic[];
}

// 单张幻灯片内的一张图：relId 指向本页 .rels 中的 media 关系，mediaName 为 ppt/media/image{n}.png
interface PptxPic {
  relId: string;
  mediaName: string;
  caption?: string;
  dataUrl?: string;
}

// 匹配 markdown 中的章节截图标记（与 docx 渲染器同一套约定）
const SNAP_RE = /^<!--\s*SNAP:(\d+)\s*-->$/;

function parseSlides(md: string): SlideSpec[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const slides: SlideSpec[] = [];
  let cur: SlideSpec | null = null;
  let body: string[] = [];
  const flush = () => {
    if (cur) {
      cur.body = body;
      slides.push(cur);
    }
    cur = null;
    body = [];
  };
  for (const line of lines) {
    const h = /^(#{1,2})\s+(.*)$/.exec(line.trim());
    if (h) {
      flush();
      cur = { title: h[2].trim(), level: h[1].length, body: [], pics: [] };
    } else {
      if (!cur) cur = { title: '', level: 0, body: [], pics: [] };
      body.push(line);
    }
  }
  flush();
  if (slides.length === 0) slides.push({ title: '', level: 0, body: [], pics: [] });
  return slides;
}

function renderBody(body: string[]): string {
  const paras: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  const flushCode = () => {
    const text = codeBuf.join('\n');
    codeBuf = [];
    inCode = false;
    paras.push(
      `<a:p><a:pPr marL="0" indent="0"/><a:r><a:rPr lang="zh-CN" sz="1800"><a:latin typeface="Consolas"/></a:rPr><a:t>${esc(text)}</a:t></a:r></a:p>`,
    );
  };
  for (const raw of body) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*```/.test(line)) {
      if (inCode) {
        flushCode();
        continue;
      }
      inCode = true;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (line.trim() === '') {
      paras.push('<a:p><a:pPr><a:spcBef><a:spcPts val="1200"/></a:spcBef></a:pPr></a:p>');
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      paras.push(
        `<a:p><a:pPr marL="365760" indent="-182880" algn="l"><a:buNone/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000" i="1"><a:solidFill><a:srgbClr val="6B7280"/></a:solidFill></a:rPr><a:t>${esc(quote[1])}</a:t></a:r></a:p>`,
      );
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      // GFM 任务清单 - [ ] / - [x]：用 ☑/☐ 字形呈现勾选态
      const tm = /^\[([ xX])\]\s+(.*)$/.exec(ul[1]);
      if (tm) {
        const mark = tm[1].toLowerCase() === 'x' ? '☑ ' : '☐ ';
        paras.push(
          `<a:p><a:pPr marL="365760" indent="-365760" algn="l"><a:buNone/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2400"/><a:t>${esc(mark + tm[2])}</a:t></a:r></a:p>`,
        );
      } else {
        paras.push(
          `<a:p><a:pPr marL="365760" indent="-365760" algn="l"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2400"/><a:t>${esc(ul[1])}</a:t></a:r></a:p>`,
        );
      }
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      paras.push(
        `<a:p><a:pPr marL="365760" indent="-365760" algn="l"><a:buNone/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2400"/><a:t>${esc(line.trim())}</a:t></a:r></a:p>`,
      );
      continue;
    }
    if (line.includes('|')) {
      paras.push(
        `<a:p><a:pPr marL="91440" indent="0"/><a:r><a:rPr lang="zh-CN" sz="1800"><a:latin typeface="Consolas"/></a:rPr><a:t>${esc(line.trim())}</a:t></a:r></a:p>`,
      );
      continue;
    }
    paras.push(
      `<a:p><a:pPr algn="l"/><a:r><a:rPr lang="zh-CN" sz="2400"/><a:t>${esc(line)}</a:t></a:r></a:p>`,
    );
  }
  if (inCode) flushCode();
  if (paras.length === 0) paras.push('<a:p><a:pPr/></a:p>');
  return paras.join('');
}

// ---------- GFM 表格 → 真实 PPTX 表格（graphicFrame）----------
// 此前 PPTX 导出把表格当成含 | 的普通文本行渲染（裸管道符号），
// 而 docx/html/预览都能渲染真表格——属「所见≠所得」。现把表格块拆成独立的
// <p:graphicFrame>，与正文 <p:sp> 在 spTree 中上下堆叠，才是合法 OOXML。
type BodyBlock =
  | { type: 'text'; lines: string[] }
  | { type: 'table'; header: string[]; aligns: string[]; rows: string[][] };

function isTableSep(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && /^[\s|:\-]+$/.test(t) && t.includes('-');
}
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}
function alignOf(cell: string): 'l' | 'r' | 'ctr' | '' {
  const t = cell.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'ctr';
  if (right) return 'r';
  if (left) return 'l';
  return '';
}

/** 把正文拆成「文本块」与「表格块」，表格块后续渲染为独立 graphicFrame */
function parseBodyBlocks(body: string[]): BodyBlock[] {
  const blocks: BodyBlock[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) {
      blocks.push({ type: 'text', lines: cur });
      cur = [];
    }
  };
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    const next = body[i + 1];
    // GFM 表格起始：当前行含 | 且下一行是分隔行（仅 | : - 与空白，且含 -）
    if (line.includes('|') && next && isTableSep(next)) {
      flush();
      const header = splitRow(line);
      const aligns = splitRow(next).map(alignOf);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < body.length && body[j].includes('|') && body[j].trim() !== '') {
        rows.push(splitRow(body[j]));
        j++;
      }
      blocks.push({ type: 'table', header, aligns, rows });
      i = j - 1; // 跳过已消费的表格行
    } else {
      cur.push(line);
    }
  }
  flush();
  return blocks;
}

/** 渲染单个 GFM 表格块为合法 OOXML <a:tbl>，含边框与表头底色 */
function renderTableBlock(
  blk: Extract<BodyBlock, { type: 'table' }>,
): { xml: string; h: number; w: number } {
  const colCount = Math.max(blk.header.length, ...blk.rows.map((r) => r.length), 1);
  const norm = (cells: string[]): string[] => {
    const out = cells.slice(0, colCount);
    while (out.length < colCount) out.push('');
    return out;
  };
  const header = norm(blk.header);
  const aligns = blk.aligns.slice(0, colCount);
  while (aligns.length < colCount) aligns.push('');
  const rows = blk.rows.map(norm);

  const totalW = 7944000;
  const colW = Math.floor(totalW / colCount);
  const cellXml = (text: string, align: string, head: boolean): string => {
    const algn = align === 'l' ? 'l' : align === 'r' ? 'r' : align === 'ctr' ? 'ctr' : 'l';
    const fill = head ? '<a:solidFill><a:srgbClr val="4F46E5"/></a:solidFill>' : '';
    const txColor = head ? '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>' : '';
    return (
      `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>` +
      `<a:p><a:pPr algn="${algn}"/>` +
      `<a:r><a:rPr lang="zh-CN" sz="1400">${txColor}</a:rPr><a:t>${esc(text)}</a:t></a:r>` +
      `</a:p></a:txBody>` +
      `<a:tcPr marL="45720" marR="45720" marT="22860" marB="22860">${fill}` +
      `<a:lnL w="6350" cap="flat"><a:solidFill><a:srgbClr val="D0D0D0"/></a:solidFill></a:lnL>` +
      `<a:lnR w="6350" cap="flat"><a:solidFill><a:srgbClr val="D0D0D0"/></a:solidFill></a:lnR>` +
      `<a:lnT w="6350" cap="flat"><a:solidFill><a:srgbClr val="D0D0D0"/></a:solidFill></a:lnT>` +
      `<a:lnB w="6350" cap="flat"><a:solidFill><a:srgbClr val="D0D0D0"/></a:solidFill></a:lnB>` +
      `</a:tcPr></a:tc>`
    );
  };
  const rowXml = (cells: string[], head: boolean): string =>
    `<a:tr h="360000">` + cells.map((c, ci) => cellXml(c, aligns[ci] ?? '', head)).join('') + `</a:tr>`;
  const grid = Array.from({ length: colCount }, () => `<a:gridCol w="${colW}"/>`).join('');
  const tbl =
    `<p:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `<a:tbl><a:tblPr firstRow="1"><a:tableStyleId>{5C22544A-E7B7-4C9A-B9C9-1A7C8C3D4E5F}</a:tableStyleId></a:tblPr>` +
    `<a:tblGrid>${grid}</a:tblGrid>` +
    rowXml(header, true) +
    rows.map((r) => rowXml(r, false)).join('') +
    `</a:tbl></a:graphicData></p:graphic>`;
  const h = (rows.length + 1) * 360000 + 40000;
  return { xml: tbl, h, w: totalW };
}

// 计算单张幻灯片内所有图片的排布（按真实宽高比 + 可用区域按比例缩放，避免拉伸/重叠）。
// 返回每个 pic 的 { x, y, cx, cy }（EMU）以及本页 body 文本框应收缩到的底部 y 上限。
function layoutPics(
  pics: PptxPic[],
  dataUrlOf: (p: PptxPic) => string,
): { boxes: { x: number; y: number; cx: number; cy: number }[]; bodyBottom: number } {
  const SLIDE_W = 9144000;
  const MARGIN_X = 600000;
  const TOP = 400000;
  const TITLE_BOTTOM = 1550000; // 标题区底部
  const BOTTOM = 6680000; // 页脚安全线
  const GAP = 120000;
  const availW = SLIDE_W - MARGIN_X * 2;

  if (pics.length === 0) return { boxes: [], bodyBottom: BOTTOM };

  const naturals = pics.map((p) => dataUrlDims(dataUrlOf(p)));
  let boxes = naturals.map(({ w, h }) => {
    const cx = availW;
    const cy = Math.round((cx * h) / w);
    return { x: MARGIN_X, y: 0, cx, cy };
  });
  // 若总高超出可用区，整体等比缩放
  const availH = BOTTOM - TITLE_BOTTOM;
  const totalH = boxes.reduce((s, b) => s + b.cy, 0) + GAP * (pics.length - 1);
  if (totalH > availH) {
    const k = availH / totalH;
    boxes = boxes.map((b) => ({ ...b, cx: Math.round(b.cx * k), cy: Math.round(b.cy * k) }));
  }
  // 顺序堆叠：标题下方起始，逐张下移
  let y = TITLE_BOTTOM;
  boxes = boxes.map((b) => {
    const box = { ...b, y };
    y += b.cy + GAP;
    return box;
  });
  return { boxes, bodyBottom: TITLE_BOTTOM };
}

function buildPicXml(pic: PptxPic, box: { x: number; y: number; cx: number; cy: number }, id: number): string {
  const captionXml = pic.caption
    ? `<p:sp>
        <p:nvSpPr><p:cNvPr id="${id + 1}" name="Cap"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y + box.cy + 20000}"/><a:ext cx="${box.cx}" cy="300000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" lIns="45720" tIns="22860" rIns="45720" bIns="22860" anchor="t"/>
          <a:lstStyle/>
          <a:p><a:pPr algn="l"/><a:r><a:rPr lang="zh-CN" sz="1400" i="1"><a:solidFill><a:srgbClr val="6B7280"/></a:solidFill></a:rPr><a:t>${esc(pic.caption)}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>`
    : '';
  return `<p:pic>
      <p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr><a:blip r:embed="${pic.relId}"/></p:nvPr></p:nvPicPr>
      <p:blipFill><a:blip r:embed="${pic.relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
    </p:pic>${captionXml}`;
}

function buildSlideXml(
  slide: SlideSpec,
  accent: string,
  dataUrlOf: (p: PptxPic) => string,
): string {
  const titleXml = slide.title
    ? `<a:p><a:pPr algn="l"/><a:r><a:rPr lang="zh-CN" sz="4400" b="1"><a:solidFill><a:srgbClr val="${accent}"/></a:solidFill></a:rPr><a:t>${esc(slide.title)}</a:t></a:r></a:p>`
    : '';
  const titleShape = slide.title
    ? `<p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="600000" y="400000"/><a:ext cx="7944000" cy="1100000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="t"/>
          <a:lstStyle/>
          ${titleXml}
        </p:txBody>
      </p:sp>`
    : '';
  // 有图时把内容起点下移到图片区下方；无图时沿用原整页正文区
  const { boxes, bodyBottom } = layoutPics(slide.pics, dataUrlOf);
  const startY = slide.pics.length ? Math.min(bodyBottom + 140000, 6100000) : 1700000;
  // 把正文拆成「文本块 / 表格块」，分别渲染为 <p:sp> 与 <p:graphicFrame>，自上而下堆叠
  const blocks = parseBodyBlocks(slide.body);
  let y = startY;
  let shapeId = 100; // 与 title(2) / pic(10+) 错开，避免 id 冲突
  const bodyShapes: string[] = [];
  for (const blk of blocks) {
    if (blk.type === 'text') {
      const nonEmpty = blk.lines.filter((l) => l.trim() !== '').length;
      const h = Math.max(300000, nonEmpty * 360000 + 120000);
      bodyShapes.push(`<p:sp>
        <p:nvSpPr><p:cNvPr id="${shapeId}" name="Body${shapeId}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="600000" y="${y}"/><a:ext cx="7944000" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="t"/>
          <a:lstStyle/>
          ${renderBody(blk.lines)}
        </p:txBody>
      </p:sp>`);
      y += h + 140000;
      shapeId++;
    } else {
      const { xml, h, w } = renderTableBlock(blk);
      bodyShapes.push(`<p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="${shapeId}" name="Table${shapeId}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="600000" y="${y}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm>
        ${xml}
      </p:graphicFrame>`);
      y += h + 180000;
      shapeId++;
    }
  }
  const bodyShape = bodyShapes.join('');
  const picXml = slide.pics
    .map((p, i) => buildPicXml(p, boxes[i], 10 + i * 2))
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${titleShape}
      ${bodyShape}
      ${picXml}
    </p:spTree>
  </p:cSld>
</p:sld>`;
}

// ---------- 固定 OOXML 模板（标准 ECMA 结构）----------
const THEME_TEMPLATE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="__ACCENT__"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office">
      <a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
        <a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
        <a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
        <a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>
        <a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`;

const SLIDE_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles>
    <p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400" b="1"/></a:lvl1pPr></p:titleStyle>
    <p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr><a:lvl2pPr><a:defRPr sz="2000"/></a:lvl2pPr></p:bodyStyle>
    <p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>
  </p:txStyles>
</p:sldMaster>`;

const SLIDE_LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
  </p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

const SLIDE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;

const SLIDE_LAYOUT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;

const SLIDE_MASTER_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const PRES_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;

// PPTX 文档属性（core.xml）：此前标题/时间被硬编码为 "SnapCraft AI" / 固定日期，
// 导致每份导出文件在 PowerPoint「文件信息」里都显示错的时间与标题（典型假实现）。
// 现改为按真实文档标题 + 导出时刻写入。
function coreXml(title: string, nowIso: string): string {
  const safeTitle = title && title.trim() ? title.trim() : 'SnapCraft AI 演示文稿';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${esc(safeTitle)}</dc:title>
  <dc:creator>SnapCraft</dc:creator>
  <cp:lastModifiedBy>SnapCraft</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:modified>
</cp:coreProperties>`;
}

function appXml(n: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>SnapCraft AI</Application>
  <Slides>${n}</Slides>
</Properties>`;
}

function themeXml(accent: string): string {
  return THEME_TEMPLATE.replace('__ACCENT__', accent);
}

function buildPresentationXml(n: number): string {
  let sldIds = '';
  for (let i = 0; i < n; i++) {
    sldIds += `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${sldIds}</p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}

function buildPresentationRels(n: number): string {
  let rels = `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slides/slideMaster1.xml"/>`;
  for (let i = 0; i < n; i++) {
    rels += `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function buildContentTypes(n: number, usedJpeg = false): string {
  let slideOverrides = '';
  for (let i = 0; i < n; i++) {
    slideOverrides += `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  }
  // 按需追加 jpeg 默认声明：仅有 png 截图时不加，避免 [Content_Types].xml 冗余。
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>${usedJpeg ? '\n  <Default Extension="jpeg" ContentType="image/jpeg"/>' : ''}
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${slideOverrides}
</Types>`;
}

// ---------- 入口 ----------
export function markdownToPptx(markdown: string, opts: MarkdownToPptxOptions = {}): Uint8Array {
  const accent = THEME_ACCENT[opts.theme ?? 'modern'] ?? THEME_ACCENT.modern;
  const slides = parseSlides(markdown);
  if (opts.title && slides.length && !slides[0].title) {
    slides[0] = { ...slides[0], title: opts.title };
  }
  const n = slides.length;
  const files: ZipEntry[] = [];

  files.push({ name: 'ppt/theme/theme1.xml', data: encStr(themeXml(accent)) });
  files.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: encStr(SLIDE_MASTER) });
  files.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: encStr(SLIDE_MASTER_RELS) });
  files.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: encStr(SLIDE_LAYOUT) });
  files.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: encStr(SLIDE_LAYOUT_RELS) });

  // 图文报告：把 <!--SNAP:k--> 标记对应的截图内嵌到相应幻灯片；无标记时把全部截图前置到第一张幻灯片。
  const sectionImages = opts.sectionImages ?? [];
  const fallbackImages = opts.images ?? [];
  const useMarkers = sectionImages.length > 0 && slides.some((s) => s.body.some((l) => SNAP_RE.test(l.trim())));
  let mediaCounter = 0;
  const mediaNameOfIdx = new Map<number, string>();

  for (const slide of slides) {
    const pics: PptxPic[] = [];
    // 默认保留原正文；仅在有 SNAP 标记时剥离标记行，或在有兜底截图时前置内嵌。
    // 此前 newBody 初始为 []，当「无标记且无非报告截图」时既不清标记也不加图，
    // 却仍执行 slide.body = newBody，导致纯文档（无图）导出 PPT 正文被整体清空——典型空实现。
    let newBody: string[];
    if (useMarkers) {
      newBody = [];
      for (const line of slide.body) {
          const m = SNAP_RE.exec(line.trim());
          if (m) {
            // 与 docx 渲染器一致：SNAP 标记 k 为 1 基序号（aiPresets 约定「从 1 开始」），
            // 但 sectionImages 是 0 基数组，必须 -1 对齐，否则会错图（且首图永远用不到）。
            const idx = parseInt(m[1], 10) - 1;
            const img = sectionImages[idx];
          if (img) {
            let mediaName = mediaNameOfIdx.get(idx);
            if (!mediaName) {
              mediaCounter++;
              const ext = mediaExtOfDataUrl(img.dataUrl);
              mediaName = `image${mediaCounter}.${ext}`;
              mediaNameOfIdx.set(idx, mediaName);
              files.push({ name: `ppt/media/${mediaName}`, data: base64ToBytes(img.dataUrl) });
            }
            pics.push({ relId: '', mediaName, caption: img.caption, dataUrl: img.dataUrl });
          }
          continue; // 标记行本身不渲染为文本
        }
        newBody.push(line);
      }
    } else {
      newBody = slide.body; // 无标记、无截图：保持原正文
      if (fallbackImages.length && slide === slides[0]) {
        // 兜底：无标记时把全部截图前置内嵌到第一张内容幻灯片
        for (const img of fallbackImages) {
          mediaCounter++;
          const ext = mediaExtOfDataUrl(img.dataUrl);
          const mediaName = `image${mediaCounter}.${ext}`;
          files.push({ name: `ppt/media/${mediaName}`, data: base64ToBytes(img.dataUrl) });
          pics.push({ relId: '', mediaName, caption: img.caption, dataUrl: img.dataUrl });
        }
      }
    }
    slide.body = newBody;
    slide.pics = pics;
  }

  for (let i = 0; i < n; i++) {
    const slide = slides[i];
    let rels = `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`;
    slide.pics.forEach((p, k) => {
      const relId = `rId${k + 2}`;
      p.relId = relId;
      rels += `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${p.mediaName}"/>`;
    });
    const slideRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
    files.push({ name: `ppt/slides/slide${i + 1}.xml`, data: encStr(buildSlideXml(slide, accent, (p) => p.dataUrl ?? '')) });
    files.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: encStr(slideRels) });
  }

  files.push({ name: 'ppt/presentation.xml', data: encStr(buildPresentationXml(n)) });
  files.push({ name: 'ppt/_rels/presentation.xml.rels', data: encStr(buildPresentationRels(n)) });
  files.push({ name: 'ppt/presProps.xml', data: encStr(PRES_PROPS) });
  // 是否写入过 jpeg media：仅当实际有 jpeg 截图时才在 [Content_Types].xml 追加 jpeg 默认声明
  const usedJpeg = files.some((f) => f.name.startsWith('ppt/media/') && /\.jpe?g$/.test(f.name));
  files.push({ name: '[Content_Types].xml', data: encStr(buildContentTypes(n, usedJpeg)) });
  files.push({ name: '_rels/.rels', data: encStr(ROOT_RELS) });
  files.push({ name: 'docProps/core.xml', data: encStr(coreXml(opts.title ?? '', new Date().toISOString().split('.')[0] + 'Z')) });
  files.push({ name: 'docProps/app.xml', data: encStr(appXml(n)) });

  return zipStore(files);
}
