// src/features/ai/themeConstants.ts
// 统一文档主题常量：确保 HTML / DOCX / PPTX / XLSX / PDF 五种导出格式的主题色严格一致。
//
// 此前各导出器各自定义 THEME_ACCENT 映射（markdownHtml / markdownDocx / markdownPptx），
// 虽然值相同但分散维护，新增主题或调整颜色时容易遗漏。本文件集中管理。

import type { DocThemeId } from '../aiTypes';

/** 主题强调色（十六进制，不含 #）—— 所有格式共用 */
export const THEME_ACCENT: Record<DocThemeId, string> = {
  modern: '4F46E5',   // 靛蓝
  elegant: '8B6F4E',  // 暖棕
  magazine: 'FF6B5E', // 珊瑚
  product: '7C3AED',  // 紫
  tech: '06B6D4',     // 青
};

/** 主题浅底色（用于表格斑马纹、引用块背景等） */
export const THEME_LIGHT_BG: Record<DocThemeId, string> = {
  modern: 'F8FAFC',
  elegant: 'F3EFE4',
  magazine: 'FFF7F4',
  product: 'EEF2FF',
  tech: 'F0FDFA',
};
