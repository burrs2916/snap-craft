// src/features/ai/themeConstants.ts
// 统一文档主题常量：确保 HTML / DOCX / PPTX / XLSX / PDF 五种导出格式的主题色严格一致。
//
// 此前各导出器各自定义 THEME_ACCENT 映射（markdownHtml / markdownDocx / markdownPptx），
// 虽然值相同但分散维护，新增主题或调整颜色时容易遗漏。本文件集中管理。
//
// 2026-07-23 增强：新增排版常量（字号/行高/间距），确保所有导出格式的视觉一致性。

import type { DocThemeId } from '../aiTypes';

/** 主题强调色（十六进制，不含 #）—— 所有格式共用 */
export const THEME_ACCENT: Record<DocThemeId, string> = {
  modern: '4F46E5',   // 靛蓝
  elegant: '8B6F4E',  // 暖棕
  magazine: 'FF6B5E', // 珊瑚
  product: '7C3AED',  // 紫
  tech: '06B6D4',     // 青
};

/** 主题强调色（含 # 前缀，用于 CSS） */
export const THEME_ACCENT_CSS: Record<DocThemeId, string> = {
  modern: '#4F46E5',
  elegant: '#8B6F4E',
  magazine: '#FF6B5E',
  product: '#7C3AED',
  tech: '#06B6D4',
};

/** 主题浅底色（用于表格斑马纹、引用块背景等） */
export const THEME_LIGHT_BG: Record<DocThemeId, string> = {
  modern: 'F8FAFC',
  elegant: 'F3EFE4',
  magazine: 'FFF7F4',
  product: 'EEF2FF',
  tech: 'F0FDFA',
};

/** 主题表头底色（用于表格表头） */
export const THEME_TABLE_HEADER: Record<DocThemeId, string> = {
  modern: '4F46E5',
  elegant: 'F3EFE4',
  magazine: '1A1A1A',
  product: '2563EB',
  tech: '0F172A',
};

/** 主题表头文字色 */
export const THEME_TABLE_HEADER_TEXT: Record<DocThemeId, string> = {
  modern: 'FFFFFF',
  elegant: '2B2620',
  magazine: 'FFFFFF',
  product: 'FFFFFF',
  tech: '67E8F9',
};

// ── 排版常量（2026-07-23 新增）──
// 所有导出格式共用的字号/行高/间距，确保 DOCX/HTML/PPTX 视觉一致。

/** 正文字号（pt，用于 DOCX；HTML 按 1pt ≈ 1.333px 换算） */
export const TYPO_BODY_SIZE = 11;
/** 正文行高倍数 */
export const TYPO_LINE_HEIGHT = 1.6;
/** 段后间距（pt） */
export const TYPO_PARA_SPACING = 8;

/** 标题字号层级（pt）：H1 > H2 > H3 > H4 */
export const TYPO_HEADING_SIZES: Record<number, number> = {
  1: 24,
  2: 18,
  3: 14,
  4: 12,
};

/** 标题字重（DOCX bold / HTML font-weight） */
export const TYPO_HEADING_WEIGHT = 700;

/** 标题段前间距（pt）——让章节之间有呼吸感 */
export const TYPO_HEADING_SPACE_BEFORE: Record<number, number> = {
  1: 0,
  2: 16,
  3: 12,
  4: 8,
};

/** 标题段后间距（pt） */
export const TYPO_HEADING_SPACE_AFTER: Record<number, number> = {
  1: 12,
  2: 8,
  3: 6,
  4: 4,
};

/** 页面边距（pt，用于 DOCX/PDF）：上下 2.54cm ≈ 72pt，左右 3.17cm ≈ 90pt */
export const PAGE_MARGIN = { top: 72, bottom: 72, left: 90, right: 90 };

/** 封面页标题字号（pt） */
export const COVER_TITLE_SIZE = 28;
/** 封面页副标题字号（pt） */
export const COVER_SUBTITLE_SIZE = 14;

// ── 主题描述（UI 展示用）──
// 注意：主题的显示名与描述统一由 markdownHtml.ts 的 DOC_THEMES 管理，
// 此处不再重复定义 THEME_LABELS，避免两处维护导致名称漂移。

/** 获取主题强调色（安全回退到 modern） */
export function accentOf(theme?: DocThemeId): string {
  return THEME_ACCENT[theme ?? 'modern'] ?? THEME_ACCENT.modern;
}

/** 获取主题强调色 CSS 值（含 #） */
export function accentCssOf(theme?: DocThemeId): string {
  return THEME_ACCENT_CSS[theme ?? 'modern'] ?? THEME_ACCENT_CSS.modern;
}
