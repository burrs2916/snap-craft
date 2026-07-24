// src/shared/markdownParse.ts
// 共享 Markdown 解析工具函数。
//
// 此前 splitRow / isTableSep / alignOf / inline 等解析逻辑在以下文件中重复实现：
//   - markdownHtml.ts (splitRow, inline, esc)
//   - markdownDocx.ts (splitCells, isSeparatorRow, parseAlign, parseInline)
//   - markdownPptx.ts (splitRow, isTableSep, alignOf, esc)
//   - markdownXlsx.ts (splitRow)
//   - aiMarkdown.tsx (splitRow, table parsing)
//
// 本模块提取公共解析逻辑，各导出器只需导入复用，消除 5 处重复。

/** HTML/XML 转义 */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** XML 转义（含单引号，用于 OOXML） */
export function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 拆分 GFM 表格行为单元格数组。
 * 兼容 `| a | b |` 和 `a | b` 两种写法。
 */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** 判断一行是否为 GFM 表格分隔行（如 `| :--- | ---: |`） */
export function isTableSep(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && /^[\s|:\-]+$/.test(t) && t.includes('-');
}

/** 判断一行是否为 GFM 表格数据行（含 | 且非分隔行） */
export function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.includes('|') && !isTableSep(t);
}

/**
 * 行内 Markdown 样式 → HTML 转换。
 * 覆盖：行内代码、粗体、斜体、删除线、链接。
 */
export function inlineToHtml(raw: string): string {
  let s = escHtml(raw);
  // 行内代码
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 粗体
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 斜体（避免误伤 **）
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  // 删除线
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // 链接 [文本](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

/** 匹配章节截图标记 <!--SNAP:k--> */
export const SNAP_MARKER_RE = /^<!--\s*SNAP:(\d+)\s*-->$/;

/** 把标题文本转成稳定、URL 安全的锚点 id（保留 CJK） */
export function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'h';
}
