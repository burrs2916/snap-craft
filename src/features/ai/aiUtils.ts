// ===== AI 面板工具函数 =====
// 从 AIPanel.tsx 提取的纯工具函数，零 React 依赖。

// DocxImage 类型枢纽已移至 aiTypes.ts
import type { DocxImage } from './aiTypes';

/**
 * 通过隐藏 iframe 触发浏览器「打印 → 另存为 PDF」。
 * 打印前等待文档内全部 <img> 解码完成，避免图文报告 PDF 出现空白/截断；2.5s 兜底超时。
 * 返回 null 表示已触发打印；返回错误码字符串（如 'iframe'）表示失败。
 */
export function printHtmlViaIframe(html: string): Promise<string | null> {
  return new Promise((resolve) => {
    // 2026-07-24 修复挂起：外层 Promise 只靠 iframe.onload 驱动，若 onload 永不触发
    // （webview 打印子系统异常 / about:blank 竞态），Promise 不 settle → 导出按钮永久禁用。
    // 加顶层超时兜底，保证一定会 settle。
    let settled = false;
    const settle = (code: string | null, cleanupIframe: () => void) => {
      if (settled) return;
      settled = true;
      cleanupIframe();
      resolve(code);
    };
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.left = '-10000px';
    iframe.style.top = '0';
    iframe.style.width = '1000px';
    iframe.style.height = '10px';
    iframe.style.border = 'none';
    document.body.appendChild(iframe);
    const removeIframe = () => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };
    // 顶层 15s 超时：覆盖 onload 不触发的极端情况
    const topTimer = setTimeout(() => settle('timeout', removeIframe), 15000);
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) {
      clearTimeout(topTimer);
      settle('iframe', removeIframe);
      return;
    }
    doc.open();
    doc.write(html);
    doc.close();
    const finish = () => {
      clearTimeout(topTimer);
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch { /* 忽略打印异常 */ }
      setTimeout(removeIframe, 1000);
      settle(null, () => {});
    };
    iframe.onload = () => {
      const imgs = Array.from(doc.images) as HTMLImageElement[];
      if (imgs.length === 0) { finish(); return; }
      let pending = imgs.length;
      let done = false;
      const onImgSettled = () => {
        if (done) return;
        if (--pending === 0) { done = true; finish(); }
      };
      imgs.forEach((img) => {
        if (img.complete && img.naturalWidth > 0) {
          onImgSettled();
        } else {
          img.addEventListener('load', onImgSettled, { once: true });
          img.addEventListener('error', onImgSettled, { once: true });
        }
      });
      setTimeout(() => { if (!done) { done = true; finish(); } }, 2500);
    };
  });
}

/** 轻量 Markdown → 纯文本（用于「导出 .txt」），只剥离常见标记、保留可读结构 */
export function mdToPlainText(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*\|.+\|\s*$/gm, (m) => m.replace(/\|/g, ' ').trim())
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 文档统计：字数/行数/阅读时长（中文 300 字/分） */
export function docStats(md: string): { words: number; lines: number; minutes: number } {
  const plain = (md || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|.+\|\s*$/gm, (m) => m.replace(/\|/g, ' ').trim())
    .replace(/[*_~`]/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, '');
  const words = plain.length;
  const lines = (md || '').split('\n').filter((l) => l.trim().length > 0).length;
  const minutes = Math.max(1, Math.round(words / 300));
  return { words, lines, minutes };
}

/** 来源截图「前置整块」HTML：与 DOCX/PPTX/复制为富文本一致的顶部位置 */
export function frontImageBlockHtml(imgs: DocxImage[]): string {
  if (!imgs.length) return '';
  const fig = imgs
    .map(
      (im) =>
        `<figure class="doc-fig"><img class="doc-img" src="${im.dataUrl}" alt="" /><figcaption class="doc-cap">${im.caption ?? ''}</figcaption></figure>`,
    )
    .join('');
  return `<div class="doc-fig-block" style="max-width:820px;margin:0 auto;padding:6px 40px 0;box-sizing:border-box;">${fig}</div>`;
}

/** 取 Markdown 首个一级标题文本，用作导出封面标题 */
export function firstHeading(md: string): string | null {
  for (const raw of (md ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || /^<!--\s*SNAP:\d+\s*-->$/.test(line)) continue;
    const m = /^#\s+(.*)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/** 时间戳 → 紧凑本地时间（用于历史库列表） */
export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
