// src/features/ai/exportService.ts
// 共享多格式导出服务：消除 AIPanel.tsx 与 AiHistoryOverlay.tsx 中重复的导出管线。
//
// 此前两个组件各自实现了几乎相同的 7 格式导出逻辑（MD/TXT/HTML/DOCX/PPTX/XLSX/PDF），
// 包括：格式转换 → 路径选择 → 文件保存 → 历史记录。本服务将其统一提取，
// 各组件只需调用对应函数并处理 UI 反馈（成功提示 / 错误样式 / 加载状态）。
//
// 设计原则：
//   - 每个导出函数返回保存路径（null = 用户取消），异常由调用方捕获处理 UI 反馈。
//   - 不持有 React 状态，纯服务层。
//   - 向后兼容：AIPanel 的 sectionImages / frontImageBlockHtml 等高级特性通过 opts 传入。

import { invoke } from '@tauri-apps/api/core';
import type { DocxImage, DocThemeId } from '../aiTypes';
import { mdToHtml } from './markdownHtml';
import { markdownToDocx } from './markdownDocx';
import { markdownToPptx } from './markdownPptx';
import { buildZip, type ZipEntry } from './zipStore';
import { pickExportPath, deriveFileHint } from './exportPath';
import { pushExportHistory } from './exportHistory';
import { firstHeading, mdToPlainText, frontImageBlockHtml } from '../aiUtils';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { stripSnapMarkers, hasSnapMarkers } from '../aiPresets';
import { useLicenseStore } from '../../licensing/licenseStore';
import { useUpgradeDialogStore } from '../../licensing/upgradeDialogStore';

// ── 导出上下文：调用方组装，描述「要导出什么」 ──

export interface ExportContext {
  /** 原始 Markdown（可能含 <!--SNAP:k--> 标记） */
  markdown: string;
  /** 文档标题（封面 / 文件名前缀） */
  title: string;
  /** 副标题（用户需求 / 预设描述） */
  subtitle?: string;
  /** 文档主题 */
  theme: DocThemeId;
  /** 有序截图列表（用于图文报告内嵌） */
  images?: DocxImage[];
  /** 章节内嵌截图（与 SNAP 标记一一对应） */
  sectionImages?: DocxImage[];
  /** 文件名提示（来自首轮目标） */
  fileHint?: string;
  /** 目录标题文案 */
  tocTitle?: string;
  /** 是否使用章节内嵌模式（有 SNAP 标记时为 true） */
  useSections?: boolean;
}

/** 从 ExportContext 构建标准化的导出上下文（自动检测 SNAP 标记） */
export function resolveContext(ctx: ExportContext): ExportContext {
  const useSections = ctx.useSections ?? hasSnapMarkers(ctx.markdown);
  const sectionImages = useSections ? (ctx.sectionImages ?? ctx.images ?? []) : [];
  const flatImages = useSections ? [] : (ctx.images ?? []);
  return { ...ctx, useSections, sectionImages, images: flatImages };
}

// ── 文本格式导出（MD / TXT / HTML） ──

/**
 * 导出为 MD / TXT / HTML 文本格式。
 * @returns 保存路径，null 表示用户取消
 */
export async function exportText(
  ctx: ExportContext,
  fmt: 'md' | 'txt' | 'html',
): Promise<string | null> {
  const resolved = resolveContext(ctx);
  const md = stripSnapMarkers(resolved.markdown);

  let content: string;
  let ext: string;
  let filters: { name: string; extensions: string[] }[];

  switch (fmt) {
    case 'md':
      content = md;
      ext = 'md';
      filters = [{ name: 'Markdown', extensions: ['md'] }];
      break;
    case 'txt':
      content = mdToPlainText(md);
      ext = 'txt';
      filters = [{ name: 'Text', extensions: ['txt'] }];
      break;
    case 'html': {
      const htmlBody = mdToHtml(md, {
        title: resolved.title,
        subtitle: resolved.subtitle,
        theme: resolved.theme,
        sectionImages: resolved.sectionImages,
        tocTitle: resolved.tocTitle,
      });
      // 非章节模式时，在正文前插入截图块
      const imgBlock = !resolved.useSections && resolved.images?.length
        ? frontImageBlockHtml(resolved.images)
        : '';
      content = imgBlock
        ? htmlBody.replace('<main class="doc-main">', `<main class="doc-main">${imgBlock}`)
        : htmlBody;
      ext = 'html';
      filters = [{ name: 'HTML', extensions: ['html'] }];
      break;
    }
  }

  const path = await pickExportPath({
    ext,
    hint: resolved.fileHint || deriveFileHint(resolved.title),
    filters,
  });
  if (!path) return null;

  await invoke('save_text_file', { content, filePath: path });
  pushExportHistory({
    path,
    format: fmt,
    title: firstHeading(resolved.markdown) || resolved.title,
    time: Date.now(),
  });
  return path;
}

// ── 二进制格式导出（DOCX / PPTX / XLSX） ──

/**
 * 导出为 DOCX (Word)。
 */
export async function exportDocx(ctx: ExportContext): Promise<string | null> {
  const resolved = resolveContext(ctx);
  const md = stripSnapMarkers(resolved.markdown);

  const bytes = await markdownToDocx(md, {
    title: resolved.title,
    subtitle: resolved.subtitle,
    theme: resolved.theme,
    tocTitle: resolved.tocTitle,
    sectionImages: resolved.sectionImages,
    images: resolved.images,
  });

  const path = await pickExportPath({
    ext: 'docx',
    hint: resolved.fileHint || deriveFileHint(resolved.title),
    filters: [{ name: 'Word', extensions: ['docx'] }],
  });
  if (!path) return null;

  await invoke('save_binary_file', { bytes: Array.from(bytes), filePath: path });
  pushExportHistory({
    path,
    format: 'docx',
    title: firstHeading(resolved.markdown) || resolved.title,
    time: Date.now(),
  });
  return path;
}

/**
 * 导出为 PPTX (PowerPoint)。
 */
export async function exportPptx(ctx: ExportContext): Promise<string | null> {
  const resolved = resolveContext(ctx);
  const md = stripSnapMarkers(resolved.markdown);

  const bytes = markdownToPptx(md, {
    title: resolved.title,
    subtitle: resolved.subtitle,
    theme: resolved.theme,
    sectionImages: resolved.sectionImages,
    images: resolved.images,
  });

  const path = await pickExportPath({
    ext: 'pptx',
    hint: resolved.fileHint || deriveFileHint(resolved.title),
    filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
  });
  if (!path) return null;

  await invoke('save_binary_file', { bytes: Array.from(bytes), filePath: path });
  pushExportHistory({
    path,
    format: 'pptx',
    title: firstHeading(resolved.markdown) || resolved.title,
    time: Date.now(),
  });
  return path;
}

// ── PDF（生成文件） ──

/**
 * 导出为 PDF（通过系统打印对话框）。
 * 成功返回 null（表示已触发打印）；失败 throw Error（由消费方 catch 统一处理）。
 * 2026-07-24 修复：旧版失败时返回错误码字符串，消费方只判 falsy/truthy，
 * 错误码被当成路径落进成功分支（弹"导出成功"、污染导出历史）。改为 throw。
 */
export async function exportPdf(ctx: ExportContext): Promise<string | null> {
  const resolved = resolveContext(ctx);
  const md = stripSnapMarkers(resolved.markdown);

  const htmlBody = mdToHtml(md, {
    title: resolved.title,
    subtitle: resolved.subtitle,
    theme: resolved.theme,
    sectionImages: resolved.sectionImages,
    tocTitle: resolved.tocTitle,
  });
  const imgBlock = !resolved.useSections && resolved.images?.length
    ? frontImageBlockHtml(resolved.images)
    : '';
  const html = imgBlock
    ? htmlBody.replace('<main class="doc-main">', `<main class="doc-main">${imgBlock}`)
    : htmlBody;

  const path = await pickExportPath({
    ext: 'pdf',
    hint: resolved.fileHint || deriveFileHint(resolved.title),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (!path) return null;

  // 在屏幕外渲染完整文档，再用 html2canvas 截图生成 PDF（中文由浏览器排版栅格化，无需嵌入字体）
  const canvas = await renderHtmlToCanvas(html);
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgW = pageW;
  const imgH = (canvas.height * imgW) / canvas.width;

  const imgData = canvas.toDataURL('image/jpeg', 0.92);
  let heightLeft = imgH;
  let position = 0;
  pdf.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
  heightLeft -= pageH;
  while (heightLeft > 0) {
    position -= pageH;
    pdf.addPage();
    pdf.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
    heightLeft -= pageH;
  }

  const ab = pdf.output('arraybuffer');
  await invoke('save_binary_file', {
    bytes: Array.from(new Uint8Array(ab)),
    filePath: path,
  });
  pushExportHistory({
    path,
    format: 'pdf',
    title: firstHeading(resolved.markdown) || resolved.title,
    time: Date.now(),
  });
  return path;
}

/**
 * 把完整文档 HTML 渲染进屏幕外容器并截图成 canvas。
 * 仅捕获 .doc-page 卡片（去掉外边距/阴影/圆角，铺满 A4 宽度），中文由浏览器排版栅格化。
 */
async function renderHtmlToCanvas(html: string): Promise<HTMLCanvasElement> {
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;

  const host = document.createElement('div');
  host.setAttribute('data-pdf-render', '1');
  host.style.cssText =
    'position:fixed;left:-10000px;top:0;width:794px;background:#fff;';
  if (styleMatch) {
    const style = document.createElement('style');
    style.textContent =
      // 捕获时让卡片铺满容器宽度，去掉屏幕态的外边距/阴影/圆角
      '.doc-page{max-width:none!important;margin:0!important;border-radius:0!important;box-shadow:none!important;}' +
      styleMatch[1];
    host.appendChild(style);
  }
  host.insertAdjacentHTML('beforeend', body);
  document.body.appendChild(host);

  try {
    const imgs = Array.from(host.querySelectorAll('img'));
    await Promise.all(
      imgs.map(
        (img) =>
          new Promise<void>((resolve) => {
            if (img.complete && img.naturalWidth > 0) return resolve();
            img.onload = () => resolve();
            img.onerror = () => resolve();
            setTimeout(resolve, 1500);
          }),
      ),
    );
    // 等字体/布局稳定
    await new Promise((r) => setTimeout(r, 120));

    const card = host.querySelector('.doc-page') as HTMLElement | null;
    const target = card ?? host;
    const canvas = await html2canvas(target, {
      scale: 2,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      windowWidth: 794,
    });
    return canvas;
  } finally {
    if (host.parentNode) host.parentNode.removeChild(host);
  }
}

// ── ZIP 归档 ──

/**
 * 导出为 ZIP 归档（会话打包）。
 */
export async function exportZip(
  files: ZipEntry[],
  hint: string,
): Promise<string | null> {
  // 付费门禁：打包导出 AI 生成的文档属于 Pro 功能，试用结束后需订阅。
  // 与 exportAs 同策略（fail-closed），无权限时弹出升级弹窗并返回 null。
  if (!useLicenseStore.getState().canUse('export_doc')) {
    useUpgradeDialogStore.getState().openDialog('export_doc');
    return null;
  }
  const bytes = buildZip(files);

  const path = await pickExportPath({
    ext: 'zip',
    hint: deriveFileHint(hint),
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });
  if (!path) return null;

  await invoke('save_binary_file', { bytes: Array.from(bytes), filePath: path });
  pushExportHistory({
    path,
    format: 'zip',
    title: hint,
    time: Date.now(),
  });
  return path;
}

// ── 富文本 / 预览 HTML 构建 ──

/**
 * 构建「复制为富文本」的 HTML 片段（fragment 模式，不含 <!DOCTYPE>）。
 */
export function buildRichTextHtml(ctx: ExportContext): string {
  const resolved = resolveContext(ctx);
  const md = stripSnapMarkers(resolved.markdown);

  const fragment = mdToHtml(md, {
    fragment: true,
    theme: resolved.theme,
    sectionImages: resolved.sectionImages,
  });

  // 非章节模式时，在片段前插入截图
  if (!resolved.useSections && resolved.images?.length) {
    const imgBlock = frontImageBlockHtml(resolved.images);
    return imgBlock + fragment;
  }
  return fragment;
}

/**
 * 构建完整预览 HTML（含 <!DOCTYPE>、主题样式、封面）。
 */
export function buildPreviewHtml(ctx: ExportContext): string {
  const resolved = resolveContext(ctx);
  const md = stripSnapMarkers(resolved.markdown);

  const htmlBody = mdToHtml(md, {
    title: resolved.title,
    subtitle: resolved.subtitle,
    theme: resolved.theme,
    sectionImages: resolved.sectionImages,
    tocTitle: resolved.tocTitle,
  });

  const imgBlock = !resolved.useSections && resolved.images?.length
    ? frontImageBlockHtml(resolved.images)
    : '';
  return imgBlock
    ? htmlBody.replace('<main class="doc-main">', `<main class="doc-main">${imgBlock}`)
    : htmlBody;
}

// ── 统一导出入口（按格式分发） ──

export type ExportFormat = 'md' | 'txt' | 'html' | 'docx' | 'pptx' | 'pdf';

/**
 * 统一导出入口：按格式分发到对应导出函数。
 * @returns 保存路径（null = 用户取消）
 */
export async function exportAs(
  ctx: ExportContext,
  fmt: ExportFormat,
  sheetName?: string,
): Promise<string | null> {
  // 付费门禁：AI 生成的文档（含 MD/TXT/HTML/DOCX/PPTX/PDF）试用结束后需订阅。
  // 无权限时弹出升级弹窗，并返回 null（等同用户取消，不触发错误提示）。
  if (!useLicenseStore.getState().canUse('export_doc')) {
    useUpgradeDialogStore.getState().openDialog('export_doc');
    return null;
  }
  switch (fmt) {
    case 'md':
    case 'txt':
    case 'html':
      return exportText(ctx, fmt);
    case 'docx':
      return exportDocx(ctx);
    case 'pptx':
      return exportPptx(ctx);
    case 'pdf':
      return exportPdf(ctx);
  }
}
