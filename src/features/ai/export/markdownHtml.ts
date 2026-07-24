// 轻量 Markdown → 独立 HTML 转换器（零依赖）
// 用于「导出 HTML / 打印为 PDF」：把 AI 流式输出的 Markdown 渲染成一份
// 排版精致、带封面、CJK 字体正确、可直接 ⌘P 另存为 PDF 的完整文档。
//
// 参考 privdoc-ai 的「多格式导出」能力，但更进一步：提供多套**精美文档主题**
// （现代简约 / 雅致 / 杂志风 / 产品推广 / 科技风），让导出的文档像产品推广、
// 广告或插画文档一样美观——标题、章节、图文、引用、表格均经主题化排版。
//
// 覆盖常见块级/行内语法：标题、列表、代码块、表格、引用、分割线、
// 链接、粗体/斜体/删除线、行内代码、段落与换行。

// DocThemeId 类型枢纽已移至 aiTypes.ts（消除循环类型依赖），此处 re-export 保持向后兼容
import type { DocThemeId } from '../aiTypes';
export type { DocThemeId };

export interface DocThemeMeta {
  id: DocThemeId;
  /** 中文 / 英文显示名（UI 按当前语言取用） */
  name: { zh: string; en: string };
  /** 中文 / 英文一句话描述（UI tooltip） */
  desc: { zh: string; en: string };
}

export const DOC_THEMES: DocThemeMeta[] = [
  {
    id: 'modern',
    name: { zh: '现代简约', en: 'Modern' },
    desc: { zh: '清爽留白、靛蓝点缀，通用百搭', en: 'Clean whitespace with indigo accents' },
  },
  {
    id: 'elegant',
    name: { zh: '雅致衬线', en: 'Elegant' },
    desc: { zh: '暖纸底纹、衬线标题、典雅隽永', en: 'Warm paper, serif headings, refined' },
  },
  {
    id: 'magazine',
    name: { zh: '杂志风', en: 'Magazine' },
    desc: { zh: '大字报头、珊瑚强调、编辑感强', en: 'Bold masthead, coral accents, editorial' },
  },
  {
    id: 'product',
    name: { zh: '产品推广', en: 'Product' },
    desc: { zh: '渐变封面、卡片排版，广告级美观', en: 'Gradient cover, card layout, promo-grade' },
  },
  {
    id: 'tech',
    name: { zh: '科技风', en: 'Tech' },
    desc: { zh: '深色 hero、青色网格、极客质感', en: 'Dark hero, cyan grid, geeky' },
  },
];

const DOC_THEMES_BY_ID: Record<DocThemeId, DocThemeMeta> = DOC_THEMES.reduce(
  (acc, t) => {
    acc[t.id] = t;
    return acc;
  },
  {} as Record<DocThemeId, DocThemeMeta>,
);

export interface HtmlSectionImage {
  dataUrl: string;
  caption?: string;
}

export interface MdToHtmlOpts {
  /** 文档标题（显示在封面；传入后会抑制正文首个 # 标题，避免重复） */
  title?: string;
  /** 副标题（封面下方，通常传用户需求 / 预设描述，强化「这份文档是为谁而生」） */
  subtitle?: string;
  /** 章节内嵌截图（按 <!--SNAP:k--> 顺序对应） */
  sectionImages?: HtmlSectionImage[];
  /** 文档主题，默认 'modern' */
  theme?: DocThemeId;
  /** 目录（TOC）：传 true 始终生成；不传时仅当文档含 ≥3 个 H2 自动生成，长文档更易导航 */
  toc?: boolean;
  /** 目录标题文案（默认「目录」；英文界面传 "Contents"） */
  tocTitle?: string;
  /**
   * 只返回正文片段（out.join），不包裹 <!DOCTYPE>/<style>/<nav> 目录。
   * 用于「复制为富文本」：把渲染后的 HTML 作为 text/html 写入剪贴板，
   * 粘贴到 Word / 邮件 / 富文本编辑器时保留标题/列表/表格/引用等结构，
   * 而不是裸 Markdown 源码（带 **、| 等标记）。
   */
  fragment?: boolean;
}

// 共享 Markdown 解析工具（消除 5 处重复）
import { escHtml, splitRow, slugify, inlineToHtml } from '../../../shared/markdownParse';
import { t } from '../../../i18n';

// 向后兼容别名
const esc = escHtml;
const inline = inlineToHtml;

// ===================== 主题样式 =====================

const COMMON =
  '* { box-sizing: border-box; }' +
  'img { max-width: 100%; }' +
  'a { text-decoration: none; }' +
  // 目录（TOC）：自动生成的文档导航，跨主题统一风格、随主题色高亮
  'html { scroll-behavior: smooth; }' +
  '.doc-toc { max-width: 820px; margin: 22px auto 0; padding: 18px 26px; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 14px; }' +
  '.doc-toc-title { font-weight: 700; font-size: 14px; margin: 0 0 10px; color: #111; letter-spacing: .02em; }' +
  '.doc-toc ol, .doc-toc ul { list-style: none; margin: 0; padding: 0; }' +
  '.doc-toc li { margin: 7px 0; line-height: 1.5; }' +
  '.doc-toc a { color: #374151; text-decoration: none; }' +
  '.doc-toc a:hover { color: #4f46e5; text-decoration: underline; }' +
  '.doc-toc-l3 { padding-left: 20px; font-size: .92em; }' +
  // 2026-07-24 排版增强：跨主题统一的表格/代码/引用优化
  '.doc-main table { border-spacing: 0; }' +
  '.doc-main td, .doc-main th { vertical-align: top; }' +
  // 表格数字列右对齐（数据类文档更专业）
  '.doc-main td:nth-child(n+2):not(:last-child) { text-align: right; font-variant-numeric: tabular-nums; }' +
  // 代码块优化：更好的可读性与打印适配
  '.doc-main pre { line-height: 1.55; tab-size: 2; }' +
  '.doc-main pre code { white-space: pre-wrap; word-break: break-word; }' +
  // 引用块内段落间距收紧
  '.doc-main blockquote p { margin: .4em 0; }' +
  // 列表项内段落间距收紧
  '.doc-main li p { margin: .3em 0; }' +
  // 强调文本微调：加粗词间距
  '.doc-main strong { font-weight: 700; letter-spacing: .01em; }' +
  // 打印优化：避免标题孤行、图片截断
  '@media print {' +
  '  .doc-toc { page-break-inside: avoid; }' +
  '  .doc-main h2, .doc-main h3, .doc-main h4 { page-break-after: avoid; }' +
  '  .doc-main p, .doc-main li { orphans: 3; widows: 3; }' +
  '}';

const THEME_CSS: Record<DocThemeId, string> = {
  modern: `
:root { color-scheme: light; }
body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif; color:#1d1d1f; background:#fff; line-height:1.75; font-size:15px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.doc-main { max-width:820px; margin:0 auto; padding:8px 40px 56px; counter-reset:h2; }
.doc-cover-modern { max-width:820px; margin:0 auto; padding:40px 40px 26px; }
.doc-cover-bar { width:48px; height:5px; border-radius:3px; background:linear-gradient(90deg,#4f46e5,#06b6d4); margin-bottom:18px; }
.doc-title { font-size:30px; line-height:1.25; font-weight:800; letter-spacing:-.01em; margin:0 0 10px; color:#111; }
.doc-sub { margin:0; color:#6b7280; font-size:14px; }
.doc-main h2 { counter-increment:h2; font-size:22px; font-weight:700; margin:1.7em 0 .6em; padding-left:14px; border-left:4px solid #4f46e5; color:#111; }
.doc-main h2::before { content:"0" counter(h2) "  "; color:#4f46e5; font-weight:800; }
.doc-main h3 { font-size:18px; font-weight:700; margin:1.4em 0 .5em; color:#1f2937; }
.doc-main h4 { font-size:16px; font-weight:700; margin:1.3em 0 .5em; }
.doc-main h5,.doc-main h6 { font-size:14px; font-weight:700; margin:1.2em 0 .4em; color:#374151; }
.doc-main p { margin:.8em 0; }
.doc-main a { color:#4f46e5; }
.doc-main a:hover { text-decoration:underline; }
.doc-main ul,.doc-main ol { margin:.8em 0; padding-left:1.6em; }
.doc-main li { margin:.3em 0; }
.doc-main code { background:#f3f4f6; border-radius:5px; padding:.15em .4em; font-family:"SFMono-Regular",Menlo,Consolas,monospace; font-size:.88em; color:#be185d; }
.doc-main pre { background:#0f172a; color:#e2e8f0; border-radius:12px; padding:16px 18px; overflow:auto; }
.doc-main pre code { background:none; color:inherit; padding:0; font-size:.85em; }
.doc-main blockquote { margin:1em 0; padding:14px 18px; background:#f8fafc; border-left:4px solid #4f46e5; border-radius:0 10px 10px 0; color:#374151; }
.doc-main hr { border:none; border-top:1px solid #e5e7eb; margin:1.8em 0; }
.doc-main table { border-collapse:collapse; width:100%; margin:1em 0; font-size:.95em; overflow:hidden; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,.06); }
.doc-main th,.doc-main td { border:1px solid #e5e7eb; padding:9px 13px; text-align:left; }
.doc-main th { background:#4f46e5; color:#fff; font-weight:600; }
.doc-main tr:nth-child(even) td { background:#f9fafb; }
.doc-fig { margin:1.4em 0; text-align:center; }
.doc-img { max-width:100%; border-radius:12px; box-shadow:0 8px 24px rgba(15,23,42,.12); border:1px solid #eee; }
.doc-cap { font-size:12px; color:#9ca3af; margin-top:8px; }
.doc-footer { text-align:center; color:#9ca3af; font-size:12px; padding:24px; }
@media print { .doc-main { padding:0; max-width:none; } .doc-main pre,.doc-main blockquote,.doc-main table,.doc-fig { page-break-inside:avoid; } }
.doc-main li.md-task { list-style:none; margin-left:-1.25em; }
.doc-main li.md-task input { margin-right:.45em; vertical-align:-1px; }
`,

  elegant: `
:root { color-scheme: light; }
body { margin:0; font-family:"Noto Serif SC",Georgia,"Songti SC","Times New Roman",serif; color:#2b2620; background:#faf8f3; line-height:1.85; font-size:15.5px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.doc-main { max-width:760px; margin:0 auto; padding:12px 44px 60px; }
.doc-cover-elegant { text-align:center; max-width:760px; margin:0 auto; padding:54px 44px 30px; }
.doc-cover-elegant .doc-title { font-size:32px; font-weight:600; letter-spacing:.04em; margin:0; color:#1c1917; }
.doc-cover-elegant .doc-rule { width:64px; height:2px; background:#b59410; margin:18px auto; }
.doc-cover-elegant .doc-sub { color:#8a8175; font-size:14px; margin:14px 0 0; font-style:italic; }
.doc-main > p:first-of-type::first-letter { font-size:3.2em; float:left; line-height:.9; padding:6px 10px 0 0; color:#b59410; font-weight:600; }
.doc-main h1 { font-size:27px; font-weight:600; margin:1.5em 0 .5em; color:#1c1917; }
.doc-main h2 { font-size:23px; font-weight:600; margin:1.6em 0 .6em; padding-bottom:.3em; border-bottom:1px solid #e7e0d2; color:#1c1917; }
.doc-main h3 { font-size:19px; font-weight:600; margin:1.4em 0 .5em; }
.doc-main h4 { font-size:16px; font-weight:600; margin:1.3em 0 .5em; }
.doc-main p { margin:.9em 0; }
.doc-main a { color:#9a7b12; border-bottom:1px solid #d8c9a0; }
.doc-main blockquote { margin:1.1em 0; padding:.6em 1.2em; color:#5c554b; background:#f3efe4; border-left:3px solid #b59410; font-style:italic; }
.doc-main code { background:#efe9dc; border-radius:4px; padding:.12em .4em; font-family:"SFMono-Regular",Menlo,monospace; font-size:.85em; color:#8a5a00; }
.doc-main pre { background:#262017; color:#f3ead2; border-radius:10px; padding:16px 18px; overflow:auto; }
.doc-main pre code { background:none; color:inherit; padding:0; }
.doc-main ul,.doc-main ol { padding-left:1.7em; }
.doc-main table { border-collapse:collapse; width:100%; margin:1em 0; }
.doc-main th,.doc-main td { border:1px solid #e0d8c6; padding:9px 13px; text-align:left; }
.doc-main th { background:#f3efe4; font-weight:600; }
.doc-fig { margin:1.4em 0; text-align:center; }
.doc-img { max-width:100%; border-radius:6px; border:1px solid #e0d8c6; box-shadow:0 6px 18px rgba(0,0,0,.08); }
.doc-cap { font-size:12px; color:#a89c87; margin-top:8px; font-style:italic; }
.doc-footer { text-align:center; color:#b3a890; font-size:12px; padding:28px; font-style:italic; }
@media print { .doc-main { padding:0; max-width:none; } .doc-main pre,.doc-main blockquote,.doc-main table,.doc-fig { page-break-inside:avoid; } }
.doc-main li.md-task { list-style:none; margin-left:-1.25em; }
.doc-main li.md-task input { margin-right:.45em; vertical-align:-1px; }
`,

  magazine: `
:root { color-scheme: light; }
body { margin:0; font-family:"Helvetica Neue",-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; color:#1a1a1a; background:#fff; line-height:1.7; font-size:15px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.doc-main { max-width:780px; margin:0 auto; padding:10px 40px 56px; counter-reset:h2; }
.doc-cover-magazine { max-width:780px; margin:0 auto; padding:44px 40px 24px; border-bottom:3px solid #e8553a; }
.doc-kicker { text-transform:uppercase; letter-spacing:.18em; font-size:11px; font-weight:700; color:#e8553a; margin:0 0 10px; }
.doc-cover-magazine .doc-title { font-size:38px; line-height:1.1; font-weight:800; letter-spacing:-.02em; margin:0 0 10px; color:#111; }
.doc-cover-magazine .doc-sub { color:#555; font-size:15px; margin:0; font-style:italic; }
.doc-main h1 { font-size:28px; font-weight:800; margin:1.4em 0 .5em; color:#111; }
.doc-main h2 { counter-increment:h2; font-size:24px; font-weight:800; margin:1.5em 0 .5em; padding-left:16px; border-left:6px solid #e8553a; color:#111; }
.doc-main h2::before { content:counter(h2,decimal-leading-zero) "  "; color:#e8553a; font-weight:800; }
.doc-main h3 { font-size:19px; font-weight:700; margin:1.3em 0 .5em; }
.doc-main h4 { font-size:16px; font-weight:700; margin:1.2em 0 .5em; }
.doc-main p { margin:.85em 0; }
.doc-main a { color:#e8553a; }
.doc-main blockquote { position:relative; margin:1.3em 0; padding:18px 24px; background:#fff7f4; color:#3a2a25; font-size:18px; font-style:italic; border-radius:8px; }
.doc-main blockquote::before { content:"\\201C"; position:absolute; left:8px; top:-6px; font-size:54px; color:#e8553a; opacity:.35; font-family:Georgia,serif; }
.doc-main code { background:#f4f4f4; border-radius:4px; padding:.15em .4em; font-family:"SFMono-Regular",Menlo,monospace; font-size:.85em; color:#c0392b; }
.doc-main pre { background:#1a1a1a; color:#f0f0f0; border-radius:10px; padding:16px 18px; overflow:auto; }
.doc-main pre code { background:none; color:inherit; padding:0; }
.doc-main ul,.doc-main ol { padding-left:1.6em; }
.doc-main li { margin:.35em 0; }
.doc-main table { border-collapse:collapse; width:100%; margin:1em 0; }
.doc-main th { background:#1a1a1a; color:#fff; padding:10px 13px; text-align:left; font-weight:700; }
.doc-main td { border:1px solid #e5e5e5; padding:9px 13px; }
.doc-fig { margin:1.5em 0; text-align:center; }
.doc-img { width:100%; border-radius:4px; }
.doc-cap { font-size:12px; color:#999; margin-top:8px; font-style:italic; }
.doc-footer { text-align:center; color:#aaa; font-size:12px; padding:24px; letter-spacing:.05em; }
@media print { .doc-main { padding:0; max-width:none; } .doc-main pre,.doc-main blockquote,.doc-main table,.doc-fig { page-break-inside:avoid; } }
.doc-main li.md-task { list-style:none; margin-left:-1.25em; }
.doc-main li.md-task input { margin-right:.45em; vertical-align:-1px; }
`,

  product: `
:root { color-scheme: light; }
body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:#1f2937; background:#fff; line-height:1.75; font-size:15px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.doc-cover-product { background:linear-gradient(135deg,#6d28d9 0%,#2563eb 55%,#0ea5e9 100%); color:#fff; padding:64px 48px 56px; }
.doc-cover-inner { max-width:820px; margin:0 auto; }
.doc-cover-product .doc-kicker { text-transform:uppercase; letter-spacing:.16em; font-size:12px; font-weight:600; opacity:.85; margin:0 0 14px; }
.doc-cover-product .doc-title { font-size:40px; line-height:1.15; font-weight:800; letter-spacing:-.02em; margin:0 0 14px; }
.doc-cover-product .doc-sub { font-size:16px; opacity:.92; margin:0 0 22px; max-width:640px; }
.doc-cover-product .doc-badge { display:inline-block; background:rgba(255,255,255,.18); border:1px solid rgba(255,255,255,.35); color:#fff; font-size:12px; font-weight:600; padding:6px 14px; border-radius:999px; }
.doc-main { max-width:820px; margin:0 auto; padding:32px 48px 56px; counter-reset:h2; }
.doc-main h1 { font-size:28px; font-weight:800; margin:1.4em 0 .5em; color:#111827; }
.doc-main h2 { counter-increment:h2; font-size:23px; font-weight:800; margin:1.6em 0 .6em; color:#1e3a8a; display:flex; align-items:center; gap:10px; }
.doc-main h2::before { content:counter(h2,decimal-leading-zero); background:linear-gradient(135deg,#6d28d9,#2563eb); color:#fff; font-size:13px; font-weight:700; width:26px; height:26px; border-radius:8px; display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; }
.doc-main h3 { font-size:19px; font-weight:700; margin:1.4em 0 .5em; color:#374151; }
.doc-main h4 { font-size:16px; font-weight:700; margin:1.3em 0 .5em; }
.doc-main p { margin:.85em 0; }
.doc-main a { color:#2563eb; font-weight:600; }
.doc-main ul,.doc-main ol { padding-left:1.6em; }
.doc-main li { margin:.35em 0; }
.doc-main blockquote { margin:1.2em 0; padding:16px 20px; background:linear-gradient(135deg,#eef2ff,#f0f9ff); border-left:4px solid #6366f1; border-radius:0 12px 12px 0; color:#3730a3; }
.doc-main code { background:#eef2ff; border-radius:5px; padding:.15em .4em; font-family:"SFMono-Regular",Menlo,monospace; font-size:.85em; color:#4338ca; }
.doc-main pre { background:#0f172a; color:#e2e8f0; border-radius:12px; padding:16px 18px; overflow:auto; }
.doc-main pre code { background:none; color:inherit; padding:0; }
.doc-main table { border-collapse:collapse; width:100%; margin:1em 0; font-size:.95em; border-radius:10px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,.06); }
.doc-main th { background:#2563eb; color:#fff; padding:10px 13px; text-align:left; font-weight:700; }
.doc-main td { border:1px solid #e5e7eb; padding:9px 13px; }
.doc-main tr:nth-child(even) td { background:#f8fafc; }
.doc-fig { margin:1.5em 0; text-align:center; }
.doc-img { max-width:100%; border-radius:14px; box-shadow:0 12px 30px rgba(37,99,235,.18); border:1px solid #e0e7ff; }
.doc-cap { font-size:12px; color:#94a3b8; margin-top:8px; }
.doc-footer { text-align:center; color:#94a3b8; font-size:12px; padding:28px; }
@media print { .doc-main { padding:0 48px; } .doc-cover-product { padding:40px 48px; } .doc-main pre,.doc-main blockquote,.doc-main table,.doc-fig { page-break-inside:avoid; } }
`,

  tech: `
:root { color-scheme: light; }
body { margin:0; font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:#0f172a; background:#fff; line-height:1.7; font-size:15px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.doc-cover-tech { background:#0f172a; color:#e2e8f0; padding:60px 48px 52px; position:relative; overflow:hidden; }
.doc-cover-tech::before { content:""; position:absolute; inset:0; background-image:linear-gradient(rgba(34,211,238,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(34,211,238,.07) 1px,transparent 1px); background-size:28px 28px; pointer-events:none; }
.doc-cover-inner { position:relative; max-width:820px; margin:0 auto; }
.doc-cover-tech .doc-kicker { font-family:"SFMono-Regular",Menlo,Consolas,monospace; color:#22d3ee; font-size:13px; letter-spacing:.05em; margin:0 0 14px; }
.doc-cover-tech .doc-title { font-size:36px; line-height:1.2; font-weight:800; margin:0 0 12px; color:#f8fafc; }
.doc-cover-tech .doc-sub { color:#94a3b8; font-size:15px; margin:0; font-family:"SFMono-Regular",Menlo,monospace; }
.doc-main { max-width:820px; margin:0 auto; padding:30px 48px 56px; counter-reset:h2; }
.doc-main h1 { font-size:27px; font-weight:800; margin:1.4em 0 .5em; color:#0f172a; }
.doc-main h2 { counter-increment:h2; font-size:22px; font-weight:700; margin:1.6em 0 .6em; color:#0e7490; padding:10px 14px; background:#ecfeff; border-left:4px solid #06b6d4; border-radius:0 8px 8px 0; }
.doc-main h2::before { content:"\\00A7" counter(h2) "  "; color:#06b6d4; font-weight:700; font-family:"SFMono-Regular",Menlo,monospace; }
.doc-main h3 { font-size:18px; font-weight:700; margin:1.4em 0 .5em; color:#155e75; }
.doc-main h4 { font-size:16px; font-weight:700; margin:1.3em 0 .5em; }
.doc-main p { margin:.85em 0; }
.doc-main a { color:#0891b2; }
.doc-main code { background:#0f172a; color:#67e8f9; border-radius:4px; padding:.15em .5em; font-family:"SFMono-Regular",Menlo,monospace; font-size:.85em; }
.doc-main pre { background:#0f172a; color:#67e8f9; border-radius:10px; padding:16px 18px; overflow:auto; font-family:"SFMono-Regular",Menlo,monospace; }
.doc-main pre code { background:none; color:inherit; padding:0; }
.doc-main blockquote { margin:1.2em 0; padding:14px 18px; background:#f0fdfa; border-left:4px solid #06b6d4; color:#134e4a; border-radius:0 8px 8px 0; }
.doc-main ul,.doc-main ol { padding-left:1.6em; }
.doc-main li { margin:.35em 0; }
.doc-main table { border-collapse:collapse; width:100%; margin:1em 0; font-size:.95em; }
.doc-main th { background:#0f172a; color:#67e8f9; padding:10px 13px; text-align:left; font-family:"SFMono-Regular",Menlo,monospace; font-size:13px; }
.doc-main td { border:1px solid #e2e8f0; padding:9px 13px; }
.doc-main tr:nth-child(even) td { background:#f8fafc; }
.doc-fig { margin:1.5em 0; text-align:center; }
.doc-img { max-width:100%; border-radius:12px; border:1px solid #e2e8f0; box-shadow:0 10px 26px rgba(15,23,42,.12); }
.doc-cap { font-size:12px; color:#94a3b8; margin-top:8px; font-family:"SFMono-Regular",Menlo,monospace; }
.doc-footer { text-align:center; color:#94a3b8; font-size:12px; padding:28px; font-family:"SFMono-Regular",Menlo,monospace; }
@media print { .doc-main { padding:0 48px; } .doc-cover-tech { padding:40px 48px; } .doc-main pre,.doc-main blockquote,.doc-main table,.doc-fig { page-break-inside:avoid; } }
`,
};

function coverHtml(theme: DocThemeId, title: string, subtitle: string): string {
  const sub = subtitle ? `<p class="doc-sub">${subtitle}</p>` : '';
  switch (theme) {
    case 'product':
      return (
        `<header class="doc-cover doc-cover-product"><div class="doc-cover-inner">` +
        `<p class="doc-kicker">SnapCraft AI</p>` +
        `<h1 class="doc-title">${title}</h1>` +
        sub +
        `<div class="doc-badge">AI Generated</div>` +
        `</div></header>`
      );
    case 'tech':
      return (
        `<header class="doc-cover doc-cover-tech"><div class="doc-cover-inner">` +
        `<p class="doc-kicker">// SnapCraft AI</p>` +
        `<h1 class="doc-title">${title}</h1>` +
        sub +
        `</div></header>`
      );
    case 'magazine':
      return (
        `<header class="doc-cover doc-cover-magazine">` +
        `<p class="doc-kicker">SnapCraft AI</p>` +
        `<h1 class="doc-title">${title}</h1>` +
        sub +
        `</header>`
      );
    case 'elegant':
      return (
        `<header class="doc-cover doc-cover-elegant">` +
        `<h1 class="doc-title">${title}</h1>` +
        `<div class="doc-rule"></div>` +
        sub +
        `</header>`
      );
    case 'modern':
    default:
      return (
        `<header class="doc-cover doc-cover-modern">` +
        `<div class="doc-cover-bar"></div>` +
        `<h1 class="doc-title">${title}</h1>` +
        sub +
        `</header>`
      );
  }
}

function wrapDoc(body: string, opts: MdToHtmlOpts, toc: string): string {
  const theme: DocThemeId = opts.theme && DOC_THEMES_BY_ID[opts.theme] ? opts.theme : 'modern';
  const title = opts.title ? esc(opts.title) : 'SnapCraft AI';
  const subtitle = opts.subtitle ? esc(opts.subtitle) : '';
  const cover = opts.title ? coverHtml(theme, title, subtitle) : '';
  const dateStr = new Date().toISOString().slice(0, 10);
  const css = THEME_CSS[theme];
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
${COMMON}
${css}
</style>
</head>
<body>
${cover}
${toc}
<main class="doc-main">
${body}
</main>
<footer class="doc-footer">${t('export.htmlFooter', { date: dateStr })}</footer>
</body>
</html>`;
}

export function mdToHtml(md: string, opts?: MdToHtmlOpts): string {
  const lines = (md ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const headings: { level: number; text: string; id: string }[] = [];
  let hSeq = 0;
  let i = 0;
  // 传入 title（封面）时，仅跳过与之同名的首个 # 标题；AI 自拟标题会被保留（不再静默吞掉）
  let firstH1Skipped = false;

  while (i < lines.length) {
    const line = lines[i];

    // 章节内嵌截图锚点：<!--SNAP:k--> → 在该章节前插入第 k 张截图（图文报告混排）
    const marker = /^<!--\s*SNAP:(\d+)\s*-->$/.exec(line.trim());
    if (marker && opts?.sectionImages && opts.sectionImages.length) {
      const idx = parseInt(marker[1], 10) - 1;
      const img = opts.sectionImages[idx];
      if (img) {
        out.push(
          `<figure class="doc-fig">` +
            `<img class="doc-img" src="${img.dataUrl}" alt="" />` +
            (img.caption ? `<figcaption class="doc-cap">${esc(img.caption)}</figcaption>` : '') +
            `</figure>`,
        );
      }
      i += 1;
      continue;
    }

    // 代码块 ```
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结束 ```
      out.push(
        `<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 分割线
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      out.push('<hr/>');
      i++;
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      const txt = h[2];
      // 封面已带标题时，仅当正文首个 H1 与封面标题同名才跳过，避免重复；否则保留 H1
      if (lvl === 1 && opts?.title && !firstH1Skipped && txt.trim() === String(opts.title).trim()) {
        firstH1Skipped = true;
        i++;
        continue;
      }
      // 为 H2/H3 生成锚点 id 并收集进目录（H1 通常即封面标题，不入目录）
      let idAttr = '';
      if (lvl <= 3) {
        const id = slugify(txt) + (hSeq ? `-${hSeq}` : '');
        hSeq++;
        idAttr = ` id="${id}"`;
        headings.push({ level: lvl, text: txt, id });
      }
      out.push(`<h${lvl}${idAttr}>${inline(txt)}</h${lvl}>`);
      i++;
      continue;
    }

    // 引用（连续）
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      lines[i + 1].includes('-') &&
      /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])
    ) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const t = c.trim();
        const l = t.startsWith(':');
        const r = t.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitRow(lines[i]);
        rows.push(
          '<tr>' +
            cells
              .map(
                (c, idx) =>
                  `<td${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${inline(c)}</td>`,
              )
              .join('') +
            '</tr>',
        );
        i++;
      }
      out.push(
        '<table><thead><tr>' +
          head
            .map(
              (c, idx) =>
                `<th${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${inline(c)}</th>`,
            )
            .join('') +
          '</tr></thead><tbody>' +
          rows.join('') +
          '</tbody></table>',
      );
      continue;
    }

    // 无序列表（含 GFM 任务清单 - [ ] / - [x]：PRD 验收清单、bug/meeting 行动项等）
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(lines[i]);
        if (m) {
          const checked = m[1].toLowerCase() === 'x' ? ' checked' : '';
          buf.push('<li class="md-task"><input type="checkbox" disabled' + checked + '/> ' + inline(m[2]) + '</li>');
        } else {
          buf.push('<li>' + inline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>');
        }
        i++;
      }
      out.push('<ul>' + buf.join('') + '</ul>');
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push('<li>' + inline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>');
        i++;
      }
      out.push('<ol>' + buf.join('') + '</ol>');
      continue;
    }

    // 段落：聚合到空行或下一块级元素之前
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|>\s?|```|\s*[-*+]\s+|\s*\d+\.\s+)/.test(lines[i]) &&
      !/^(\s*[-*_]){3,}\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push('<p>' + buf.map(inline).join('<br/>') + '</p>');
  }

  // 目录（TOC）：显式 toc:true 始终生成；否则仅当文档含 ≥3 个 H2 自动生成，避免短文档多出一块
  const showToc = (opts?.toc ?? false) || headings.filter((x) => x.level === 2).length >= 3;
  const tocHtml =
    showToc && headings.length
      ? `<nav class="doc-toc"><div class="doc-toc-title">${esc(opts?.tocTitle || '目录')}</div><ul>` +
        headings
          .map(
            (x) =>
              `<li class="doc-toc-l${x.level}"><a href="#${x.id}">${esc(x.text)}</a></li>`,
          )
          .join('') +
        `</ul></nav>`
      : '';

  // 「复制为富文本」：只取正文片段，交给调用方自行包裹/写入剪贴板
  if (opts?.fragment) return out.join('\n');

  return wrapDoc(out.join('\n'), opts ?? {}, tocHtml);
}
