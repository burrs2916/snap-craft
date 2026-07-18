// Markdown → 真实 Word(.docx) 转换器（零后端，纯前端）
// 设计目标：把 AI 生成的 Markdown「完整文档 / 文案」落盘为可在 Word / WPS 直接打开的 .docx，
// 并把来源截图内嵌到文档开头（截图工具独有价值：文档自带可视化证据）。
//
// 参考 privdoc-ai 的 docx 导出思路（Document/Packer），但针对 SnapCraft 做了两点增强：
//  1) 输入是 Markdown 文本而非结构化 JSON → 需要一套轻量 Markdown 解析（标题/段落/列表/表格/代码/引用/强调）。
//  2) 内嵌截图 imageDataUrl（privdoc-ai 的导出不含图片）→ 用 docx ImageRun 把截图作为图块嵌入。
//
// 依赖：docx（已加入 package.json）。浏览器 / Tauri webview 中必须用 Packer.toArrayBuffer（非 toBuffer，
// 后者是 Node 专属 nodebuffer 模式，在 webview 中抛 "nodebuffer is not supported by this platform"）。

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  BorderStyle,
  WidthType,
  AlignmentType,
  ShadingType,
  Header,
  Footer,
  PageNumber,
  ExternalHyperlink,
} from 'docx';
import type { DocThemeId } from './markdownHtml';

export interface DocxImage {
  /** 截图 dataUrl（png/jpeg），将内嵌到文档 */
  dataUrl: string;
  /** 图注（可选） */
  caption?: string;
}

export interface MarkdownToDocxOptions {
  /** 文档标题（写入封面 + 正文首个 H1，可选） */
  title?: string;
  /** 副标题（封面下方，通常传用户需求 / 预设描述） */
  subtitle?: string;
  /** 内嵌截图列表（当前截图 + 附加截图），按顺序嵌入到正文之前 */
  images?: DocxImage[];
  /**
   * 章节内嵌截图：与 `<!--SNAP:k-->` 标记一一对应，按标记顺序把图片插入到对应章节前，
   * 实现「图文报告」的图文混排（截图工具独有价值）。提供该字段时，images 的前置整块嵌入会被跳过。
   */
  sectionImages?: DocxImage[];
  /** 是否内嵌图片（默认 true；关掉则只导出文字） */
  embedImages?: boolean;
  /** 文档主题（对齐 markdownHtml 的 5 套主题），用于封面与标题配色 */
  theme?: DocThemeId;
  /** 目录标题文案（默认「目录」） */
  tocTitle?: string;
  /** 封面日期（不传则取当天） */
  date?: string;
}

/** 主题 → 强调色（十六进制，不含 #），与 markdownHtml 的 5 套主题呼应 */
const THEME_ACCENT: Record<DocThemeId, string> = {
  modern: '4F46E5', // 靛蓝
  elegant: '8B6F4E', // 暖棕
  magazine: 'FF6B5E', // 珊瑚
  product: '7C3AED', // 紫
  tech: '06B6D4', // 青
};

/** 扫描 Markdown 生成目录（TOC）：标题 ≥4 个时自动生成，长文档更易导航（对齐 HTML 自动 TOC） */
function buildToc(md: string, tocTitle?: string): Paragraph[] {
  const lines = (md ?? '').replace(/\r\n/g, '\n').split('\n');
  const heads: { level: number; text: string }[] = [];
  let inCode = false;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (/^<!--\s*SNAP:\d+\s*-->$/.test(line.trim())) continue; // 跳过章节锚点
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) heads.push({ level: h[1].length, text: h[2].trim() });
  }
  if (heads.length < 4) return [];
  const paras: Paragraph[] = [
    new Paragraph({
      text: tocTitle || '目录',
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 80 },
    }),
  ];
  for (const hd of heads) {
    paras.push(
      new Paragraph({
        spacing: { before: 20, after: 20 },
        indent: { left: Math.min(6, hd.level - 1) * 280 },
        children: [new TextRun({ text: hd.text, size: 20, color: '333333' })],
      }),
    );
  }
  return paras;
}

/** 封面：强调色装饰条 + 大标题 + 副标题 + 日期（对齐 HTML 封面，让 docx 不再是朴素纯文本） */
function coverPage(title: string, accent: string, subtitle?: string, date?: string): Paragraph[] {
  const d = date || new Date().toISOString().slice(0, 10);
  return [
    new Paragraph({
      spacing: { before: 560, after: 120 },
      alignment: AlignmentType.CENTER,
      border: { bottom: { style: BorderStyle.SINGLE, size: 24, color: accent, space: 6 } },
      children: [new TextRun('')],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 140 },
      children: [new TextRun({ text: title, bold: true, size: 56, color: accent, font: CJK_FONT })],
    }),
    ...(subtitle
      ? [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 80 },
            children: [new TextRun({ text: subtitle, size: 24, color: '555555' })],
          }),
        ]
      : []),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: d, size: 20, color: '888888' })],
    }),
  ];
}

// ===== 行内样式解析（**粗体** / *斜体* / `代码` / [链接] / ~~删除线~~） =====
type InlineRun = TextRun | ExternalHyperlink;

type FontObj = { ascii: string; hAnsi: string; eastAsia: string };

function mkRun(text: string, font?: FontObj): TextRun {
  return font ? new TextRun({ text, font }) : new TextRun({ text });
}

// defaultFont：可选，给所有非代码 run 统一指定字体（表格单元格用 CJK_FONT 保证 CJK 不丢字）；
// 不传则仅用文档默认字体（正文段落即如此，避免改动既有渲染）。
function parseInline(text: string, accent: string, defaultFont?: FontObj): InlineRun[] {
  const runs: InlineRun[] = [];
  // 顺序：链接 → 粗体 → 斜体 → 行内代码 → 删除线
  const re =
    /(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(~~([^~]+)~~)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push(mkRun(text.slice(last, m.index), defaultFont));
    if (m[2] !== undefined) {
      // [text](url) 链接：用 ExternalHyperlink 保留可点击跳转
      runs.push(
        new ExternalHyperlink({
          link: m[3] as string,
          children: [new TextRun({ text: m[2], color: accent, underline: { type: 'single', color: accent }, font: defaultFont })],
        }),
      );
    } else if (m[5] !== undefined) runs.push(new TextRun({ text: m[5], bold: true, font: defaultFont }));
    else if (m[7] !== undefined) runs.push(new TextRun({ text: m[7], italics: true, font: defaultFont }));
    else if (m[9] !== undefined) runs.push(new TextRun({ text: m[9], font: 'Courier New' }));
    else if (m[11] !== undefined) runs.push(new TextRun({ text: m[11], strike: true, font: defaultFont }));
    last = re.lastIndex;
  }
  if (last < text.length) runs.push(mkRun(text.slice(last), defaultFont));
  return runs;
}

// 跨平台 CJK 字体对象：Latin 用 Calibri（全平台通用），East Asian 按平台选——
// macOS 主战场用系统自带的 PingFang SC，Windows 用 Microsoft YaHei，
// 避免 Word / WPS Mac 因缺失 "Microsoft YaHei" 而弹「字体缺失」并替换为陌生字体。
// 传对象（而非字符串）才能分别指定 ascii/eastAsia；docx 库对缺失的 eastAsia 会在打开端按默认 EA 字体兜底。
const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent || navigator.platform || '');
const CJK_FONT: { ascii: string; hAnsi: string; eastAsia: string } = {
  ascii: 'Calibri',
  hAnsi: 'Calibri',
  eastAsia: IS_MAC ? 'PingFang SC' : 'Microsoft YaHei',
};

// ===== dataUrl → 字节 + 真实尺寸（用于 ImageRun 的 transformation） =====
interface DecodedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
  type: string;
}

function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mimeMatch = /data:([^;]+)/.exec(meta);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

function loadImageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 600, h: img.naturalHeight || 400 });
    img.onerror = () => resolve({ w: 600, h: 400 });
    img.src = dataUrl;
  });
}

async function dataUrlToImageRun(dataUrl: string): Promise<Paragraph[]> {
  try {
    const { bytes, mime } = decodeDataUrl(dataUrl);
    const { w, h } = await loadImageSize(dataUrl);
    // 约束最大宽度 600px，按比例缩放高度，避免超出页宽
    const MAX_W = 600;
    const scale = w > MAX_W ? MAX_W / w : 1;
    const width = Math.round(w * scale);
    const height = Math.round(h * scale);
    // docx 库的 ImageRun 仅支持 png/jpg/gif/bmp；WebP/SVG 不在此列。
    // 修复前：错标为 'png' → Word 按 PNG 解码失败 → 图片不显示或"无法显示链接的图片"。
    // 修复后：遇到不支持的格式直接跳过该图（console.warn 提示），避免静默错图。
    const typeMap: Record<string, 'png' | 'jpg' | 'gif' | 'bmp'> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/gif': 'gif',
      'image/bmp': 'bmp',
    };
    if (!typeMap[mime]) {
      // WebP / SVG / 其他不支持的格式：跳过该图，避免 Word 报错
      console.warn(`[docx] 不支持的图片格式 ${mime}，已跳过该图（docx 仅支持 png/jpg/gif/bmp）`);
      return [];
    }
    const type = typeMap[mime];
    return [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 40 },
        children: [
          new ImageRun({
            data: bytes,
            type,
            transformation: { width, height },
          }),
        ],
      }),
    ];
  } catch {
    return [];
  }
}

// ===== 表格解析 =====
function isTableRow(line: string): boolean {
  return line.trim().startsWith('|') && line.trim().endsWith('|') && line.includes('|', 1);
}

function splitCells(line: string): string[] {
  const t = line.trim();
  // 去掉首尾竖线，按 | 切分
  const inner = t.slice(1, t.endsWith('|') ? -1 : undefined);
  return inner.split('|').map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^[\s|:-]+$/.test(line) && line.includes('-');
}

// 解析 GFM 分隔行的对齐：`:---` 左、`---:` 右、`:---:` 居中、纯 `---` 左（start）
function parseAlign(cell: string) {
  const t = cell.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return AlignmentType.CENTER;
  if (right) return AlignmentType.RIGHT;
  return AlignmentType.LEFT;
}

// separator：GFM 分隔行（如 `| :--- | :---: | ---: |`），由 caller 单独传入（caller 收集时已跳过该行）；
// 用于推导每列对齐。rows = [表头, ...数据行]（不含分隔行）。
function buildTable(rows: string[], accent: string, separator?: string): Table {
  const thinBorder = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' };
  const borders = {
    top: thinBorder,
    bottom: thinBorder,
    left: thinBorder,
    right: thinBorder,
  };
  const headerCells = splitCells(rows[0]);
  const colCount = headerCells.length;
  const aligns = separator ? splitCells(separator).map(parseAlign) : [];
  const tableRows = rows.map((rowLine, ri) => {
    const cells = splitCells(rowLine);
    const isHeader = ri === 0;
    return new TableRow({
      tableHeader: isHeader, // 标准 <w:tblHeader/>：跨页自动重复表头（全平台兼容，不绑特定 Word 版本）
      children: cells.map((c, ci) => {
        const align = aligns[ci] ?? AlignmentType.LEFT;
        const shading = isHeader
          ? { type: ShadingType.CLEAR, fill: 'E8EAF6', color: 'auto' }
          : ri % 2 === 1
            ? { type: ShadingType.CLEAR, fill: 'F4F5F9', color: 'auto' }
            : undefined;
        return new TableCell({
          width: { size: Math.floor(9000 / colCount), type: WidthType.DXA },
          shading,
          borders,
          children: [
            new Paragraph({
              alignment: align,
              spacing: { before: 40, after: 40 },
              // 表头保持纯文本加粗（稳健）；数据单元格解析内联 **粗体**/`代码` 等并统一 CJK 字体
              children: isHeader
                ? [new TextRun({ text: c, bold: true, size: 20, font: CJK_FONT })]
                : parseInline(c, accent, CJK_FONT),
            }),
          ],
        });
      }),
    });
  });
  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    borders,
    rows: tableRows,
  });
}

// ===== 主转换 =====
export async function markdownToDocx(
  markdown: string,
  opts: MarkdownToDocxOptions = {},
): Promise<Uint8Array> {
  const {
    title,
    images = [],
    sectionImages,
    embedImages = true,
    theme = 'modern',
    tocTitle,
    date,
  } = opts;
  const accent = THEME_ACCENT[theme] ?? THEME_ACCENT.modern;
  const children: (Paragraph | Table)[] = [];

  // 0) 封面（仅当提供标题，对齐 HTML 封面）+ 自动目录（标题 ≥4 时生成，与 HTML 自动 TOC 一致）
  if (title) {
    children.push(...coverPage(title, accent, opts.subtitle, date));
  }
  const toc = buildToc(markdown, tocTitle);
  if (toc.length) children.push(...toc);

  // 1) 前置整块内嵌截图（截图工具独有：文档自带可视化证据）
  //    仅当未使用「章节内嵌」(sectionImages) 时才整块放到正文前，避免重复。
  if (embedImages && images.length && (!sectionImages || sectionImages.length === 0)) {
    for (const img of images) {
      const paras = await dataUrlToImageRun(img.dataUrl);
      children.push(...paras);
      if (img.caption) {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 160 },
            children: [new TextRun({ text: img.caption, italics: true, size: 18, color: '888888' })],
          }),
        );
      }
    }
  }

  // 2) 解析 Markdown 正文
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let listBuffer: { ordered: boolean; text: string; checked?: boolean }[] = [];
  // 若已作为封面渲染标题，则正文中与之同名的首个 H1 跳过，避免重复
  let firstH1Skipped = false;

  const flushList = () => {
    if (!listBuffer.length) return;
    const ordered = listBuffer[0].ordered;
    let n = 0;
    for (const item of listBuffer) {
      if (ordered) n += 1;
      const isTask = item.checked !== undefined;
      // GFM 任务清单用 ☑/☐ 字形呈现勾选态（Word 全版本兼容，无需内容控件）
      const prefixText = isTask ? (item.checked ? '☑ ' : '☐ ') : ordered ? `${n}. ` : '';
      const prefix = prefixText ? new TextRun({ text: prefixText, bold: true }) : undefined;
      children.push(
        new Paragraph({
          bullet: ordered || isTask ? undefined : { level: 0 },
          spacing: { before: 20, after: 20 },
          children: prefix ? [prefix, ...parseInline(item.text, accent)] : parseInline(item.text, accent),
        }),
      );
    }
    listBuffer = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // 章节内嵌截图锚点：<!--SNAP:k--> → 在对应章节前插入第 k 张截图（图文报告）
    const marker = /^<!--\s*SNAP:(\d+)\s*-->$/.exec(line.trim());
    if (marker && sectionImages && sectionImages.length) {
      const idx = parseInt(marker[1], 10) - 1;
      const img = sectionImages[idx];
      if (img) {
        const paras = await dataUrlToImageRun(img.dataUrl);
        children.push(...paras);
        if (img.caption) {
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 160 },
              children: [new TextRun({ text: img.caption, italics: true, size: 18, color: '888888' })],
            }),
          );
        }
      }
      i += 1;
      continue;
    }

    // 代码块
    if (/^```/.test(line.trim())) {
      flushList();
      const lang = line.trim().slice(3).trim();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束 ```
      children.push(
        new Paragraph({
          spacing: { before: 80, after: 80 },
          shading: { type: ShadingType.CLEAR, fill: 'F4F4F4', color: 'auto' },
          children: [new TextRun({ text: code.join('\n'), font: 'Courier New', size: 20 })],
        }),
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      flushList();
      i += 1;
      continue;
    }

    // 分隔线
    if (/^(\s*[-*_]\s*){3,}$/.test(line) && /^[-*_\s]+$/.test(line)) {
      flushList();
      children.push(
        new Paragraph({
          spacing: { before: 60, after: 60 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'DDDDDD', space: 1 } },
          children: [new TextRun('')],
        }),
      );
      i += 1;
      continue;
    }

    // 表格
    if (isTableRow(line) && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      flushList();
      const tableLines = [line];
      const separator = lines[i + 1]; // GFM 分隔行（:---/:---:/---:），单独传给 buildTable 推导列对齐
      i += 2; // 跳过表头与分隔行
      while (i < lines.length && isTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      children.push(buildTable(tableLines, accent, separator));
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      const level = h[1].length;
      const text = h[2].trim();
      // 封面已渲染标题时，跳过与之同名的首个 H1，避免重复
      if (title && !firstH1Skipped && level === 1 && text === title) {
        firstH1Skipped = true;
        i += 1;
        continue;
      }
      const map: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
        1: HeadingLevel.HEADING_1,
        2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3,
        4: HeadingLevel.HEADING_4,
        5: HeadingLevel.HEADING_5,
        6: HeadingLevel.HEADING_6,
      };
      const headingSizes: Record<number, number> = { 1: 40, 2: 32, 3: 26, 4: 22, 5: 20, 6: 20 };
      const headBorder: any = {};
      if (level === 1 || level === 2) {
        headBorder.left = { style: BorderStyle.SINGLE, size: 18, color: accent, space: 8 };
      }
      if (level === 2 || level === 3) {
        headBorder.bottom = { style: BorderStyle.SINGLE, size: 6, color: accent, space: 4 };
      }
      children.push(
        new Paragraph({
          heading: map[level],
          spacing: { before: level <= 2 ? 200 : 120, after: 80 },
          border: headBorder,
          children: [
            new TextRun({ text, color: accent, bold: level <= 2, size: headingSizes[level] }),
          ],
        }),
      );
      i += 1;
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      flushList();
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      children.push(
        new Paragraph({
          spacing: { before: 60, after: 60 },
          indent: { left: 240 },
          border: { left: { style: BorderStyle.SINGLE, size: 18, color: accent, space: 8 } },
          shading: { type: ShadingType.CLEAR, fill: 'F7F8FA', color: 'auto' },
          children: [new TextRun({ text: quote.join('\n'), italics: true, color: '444444' })],
        }),
      );
      continue;
    }

    // 无序列表（含 GFM 任务清单 - [ ] / - [x]：PRD 验收清单、bug/meeting 行动项等）
    const ul = /^[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      const tm = /^\[([ xX])\]\s+(.*)$/.exec(ul[1]);
      if (tm) {
        listBuffer.push({ ordered: false, text: tm[2], checked: tm[1].toLowerCase() === 'x' });
      } else {
        listBuffer.push({ ordered: false, text: ul[1] });
      }
      i += 1;
      continue;
    }
    // 有序列表
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      listBuffer.push({ ordered: true, text: ol[1] });
      i += 1;
      continue;
    }

    // 普通段落（合并连续非空、非特殊行）
    flushList();
    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^[-*+]\s/.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i]) &&
      !/^```/.test(lines[i].trim()) &&
      !isTableRow(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    children.push(
      new Paragraph({
        spacing: { before: 40, after: 80 },
        children: parseInline(para.join(' '), accent),
      }),
    );
  }
  flushList();

  const headerText = title || 'SnapCraft AI';
  const header = new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E5E7EB', space: 2 } },
        children: [new TextRun({ text: headerText, size: 16, color: '9CA3AF', font: CJK_FONT })],
      }),
    ],
  });
  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'E5E7EB', space: 2 } },
        children: [
          new TextRun({ text: '第 ', size: 16, color: '9CA3AF' }),
          new TextRun({ children: [PageNumber.CURRENT] }),
          new TextRun({ text: ' / ', size: 16, color: '9CA3AF' }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
          new TextRun({ text: ' 页', size: 16, color: '9CA3AF' }),
        ],
      }),
    ],
  });

  const doc = new Document({
    // 文件属性（Word「文件信息」面板）：docx 库默认 creator/lastModifiedBy 为 "Un-named"、
    // title 空白，导致文档属性失真。这里写入真实标题与应用名，created/modified 由库默认填导出时刻。
    title: title && title.trim() ? title.trim() : 'SnapCraft AI 文档',
    creator: 'SnapCraft',
    lastModifiedBy: 'SnapCraft',
    description: opts.subtitle && opts.subtitle.trim() ? opts.subtitle.trim() : undefined,
    sections: [
      {
        properties: {},
        headers: { default: header },
        footers: { default: footer },
        children,
      },
    ],
  });

  // ⚠️ 浏览器 / Tauri webview 环境：必须用 toArrayBuffer（内部走 JSZip 的 arraybuffer 模式，
  // pako 用 uint8array 压缩），绝不能用 toBuffer——后者是 Node 专属（nodebuffer 模式），
  // 在 webview 中直接抛 "nodebuffer is not supported by this platform"。
  const ab = await Packer.toArrayBuffer(doc);
  return new Uint8Array(ab);
}
