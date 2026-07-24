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
import { markdownToXlsx } from './markdownXlsx';
import { buildZip, dataUrlToBytes, type ZipEntry } from './zipStore';
import { pickExportPath, deriveFileHint, baseNameOf } from './exportPath';
import { pushExportHistory } from './exportHistory';
import { firstHeading, mdToPlainText, printHtmlViaIframe, frontImageBlockHtml } from '../aiUtils';
import { stripSnapMarkers, hasSnapMarkers } from '../aiPresets';

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

export interface ExportResult {
  /** 保存路径（null = 用户取消） */
  path: string | null;
  /** 格式 */
  format: string;
}

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

/**
 * 导出为 XLSX (Excel)。
 */
export async function exportXlsx(
  ctx: ExportContext,
  sheetName?: string,
): Promise<string | null> {
  const resolved = resolveContext(ctx);
  const md = stripSnapMarkers(resolved.markdown);

  const bytes = markdownToXlsx(md, sheetName || resolved.title);

  const path = await pickExportPath({
    ext: 'xlsx',
    hint: resolved.fileHint || deriveFileHint(resolved.title),
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  });
  if (!path) return null;

  await invoke('save_binary_file', { bytes: Array.from(bytes), filePath: path });
  pushExportHistory({
    path,
    format: 'xlsx',
    title: firstHeading(resolved.markdown) || resolved.title,
    time: Date.now(),
  });
  return path;
}

// ── PDF（打印） ──

/**
 * 导出为 PDF（通过系统打印对话框）。
 * 返回 null 表示成功触发打印，返回字符串表示错误。
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

  return printHtmlViaIframe(html);
}

// ── ZIP 归档 ──

/**
 * 导出为 ZIP 归档（会话打包）。
 */
export async function exportZip(
  files: ZipEntry[],
  hint: string,
): Promise<string | null> {
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

export type ExportFormat = 'md' | 'txt' | 'html' | 'docx' | 'pptx' | 'xlsx' | 'pdf';

/**
 * 统一导出入口：按格式分发到对应导出函数。
 * @returns 保存路径（null = 用户取消），PDF 返回错误码或 null
 */
export async function exportAs(
  ctx: ExportContext,
  fmt: ExportFormat,
  sheetName?: string,
): Promise<string | null> {
  switch (fmt) {
    case 'md':
    case 'txt':
    case 'html':
      return exportText(ctx, fmt);
    case 'docx':
      return exportDocx(ctx);
    case 'pptx':
      return exportPptx(ctx);
    case 'xlsx':
      return exportXlsx(ctx, sheetName);
    case 'pdf':
      return exportPdf(ctx);
  }
}
