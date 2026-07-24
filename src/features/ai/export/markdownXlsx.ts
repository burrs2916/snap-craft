// Markdown → XLSX 转换器（零依赖核心用 xlsx 库；与 privdoc-ai 的 export.service.ts 对齐，
// 但本工具吃的是「AI 生成的 Markdown 文档」而非结构化 JSON，并优先把其中的表格变成可编辑 Excel）。
//
// 设计要点：
//  - 文档里出现的每张 GFM 表格 → 一个 sheet（sheet 名取该表上方最近的标题，否则「表N」）。
//  - 多张表 → 多 sheet（Sheet1/Sheet2… 由上方标题命名）。
//  - 若文档完全没有表格（纯叙述/要点），则回退为单个「内容」sheet：每个非空行（含标题行）作为一行，
//    保证任何 AI 结果都能导出成可用的 Excel，不会导出空文件。
//  - 截图工具的独有价值：先用「提取表格」预设把截图里的数据/表格抽成 Markdown 表，再一键导出 Excel，
//    得到可编辑的电子表格证据，而非只能看图片。

import * as XLSX from 'xlsx';
import { t } from '../../../i18n';

/** 行内 Markdown 强调/链接/代码剥离，得到干净单元格文本 */
function cleanCell(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>\s?/g, '')
    .trim();
}

/** 判断是否为 GFM 分隔行：| --- | :--: | ---: | */
function isSeparatorRow(line: string): boolean {
  const t = line.trim().replace(/^\||\|$/g, '');
  if (!t.includes('-')) return false;
  return t
    .split('|')
    .map((c) => c.trim())
    .every((c) => /^:?-{1,}:?$/.test(c));
}

/** 把一行 `| a | b |` 拆成单元格数组（兼容开头/结尾的 |） */
function splitRow(line: string): string[] {
  let s = line.trim();
  s = s.replace(/^\|/, '').replace(/\|$/, '');
  return s.split('|').map((c) => cleanCell(c));
}

interface ParsedSheet {
  name: string;
  rows: string[][]; // 含表头行
}

/**
 * 解析 Markdown，抽取所有表格（及标题上下文）；无表格则返回空。
 */
function extractTables(md: string): ParsedSheet[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const sheets: ParsedSheet[] = [];
  let lastHeading = '';
  let i = 0;
  let idx = 0;
  while (i < lines.length) {
    const line = lines[i];
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      lastHeading = cleanCell(heading[1]);
      i++;
      continue;
    }
    // 表格起始：当前行像表头，下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1]) && splitRow(line).length >= 1) {
      const header = splitRow(line);
      const rows: string[][] = [header];
      i += 2; // 跳过表头与分隔行
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = splitRow(lines[i]);
        if (cells.length >= 1) rows.push(cells);
        i++;
      }
      const name = (lastHeading || t('export.sheetTable', { n: ++idx })).slice(0, 31);
      sheets.push({ name, rows });
      continue;
    }
    i++;
  }
  return sheets;
}

/** 无表格时：把叙述/要点按行放入单个 sheet */
function extractProse(md: string): ParsedSheet {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const rows: string[][] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      rows.push([cleanCell(heading[1])]);
      continue;
    }
    // 列表项去前缀
    const li = line.replace(/^[-*+]\s+/, '• ').replace(/^\d+\.\s+/, '');
    rows.push([cleanCell(li)]);
  }
  return { name: t('export.sheetContent'), rows };
}

/** 把二维数组写成一个 worksheet（首行作为表头并加粗） */
function sheetFromRows(rows: string[][]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // SheetJS 社区版不支持单元格样式写入（.s 会被静默丢弃），
  // 表头与数据行视觉一致。如需"加粗+底色"请迁移到 exceljs（.xlsx 写样式是 Pro 专属能力）。
  // 列宽自适应（!cols，社区版支持）保留。
  if (rows.length > 0) {
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    // 列宽自适应（按内容最长字符，限制 8~60）
    const widths: XLSX.ColInfo[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      let max = 8;
      for (let r = range.s.r; r <= range.e.r; r++) {
        const v = ws[XLSX.utils.encode_cell({ r, c })]?.v;
        const text = v ? String(v) : '';
        // CJK / 全角字符在 Excel 中约占 2 个 wch 单位，按 1 计会导致中文列被 #### 截断
        let len = 0;
        for (const ch of text) len += /[⺀-鿿＀-￯぀-ヿ]/.test(ch) ? 2 : 1;
        if (len > max) max = len;
      }
      widths.push({ wch: Math.min(60, Math.max(8, max + 2)) });
    }
    ws['!cols'] = widths;
  }
  return ws;
}

/**
 * Markdown → XLSX (Uint8Array)
 * @param md 已剥离 SNAP 标记的 AI 输出 Markdown
 * @param title 文档标题（仅用于日志/兜底 sheet 名，可选）
 */
export function markdownToXlsx(md: string, title?: string): Uint8Array {
  const sheets = extractTables(md);
  const wb = XLSX.utils.book_new();
  if (sheets.length > 0) {
    for (const sh of sheets) {
      const name = sh.name.slice(0, 31) || t('export.sheetTable', { n: wb.SheetNames.length + 1 });
      XLSX.utils.book_append_sheet(wb, sheetFromRows(sh.rows), name);
    }
  } else {
    const prose = extractProse(md);
    XLSX.utils.book_append_sheet(wb, sheetFromRows(prose.rows), (title || prose.name).slice(0, 31));
  }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}
