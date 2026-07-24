// src/shared/platform.ts
// 统一平台检测与跨平台工具函数。
//
// 此前平台检测代码散落在多个文件中，各自用不同方式判断平台：
//   - exportPath.ts: isWindows() via navigator.userAgent
//   - markdownDocx.ts: IS_MAC via navigator.userAgent
//   - i18n/index.ts: isTauri() via window.__TAURI_INTERNALS__
//   - EnhancedScreenshotApp.tsx: detectPlatformFromUA()
//   - AnnotationToolbar.tsx: platform from store
//
// 本模块将所有平台检测逻辑集中到一处，消除重复、确保一致性。
// 所有函数均为纯函数，无副作用，可在任何模块中安全导入。

/** 支持的桌面平台 */
export type Platform = 'macos' | 'windows' | 'linux';

/**
 * 检测当前运行平台（基于 navigator.userAgent）。
 * 在 Tauri webview 中 UA 稳定可读，与后端 std::env::consts::OS 判定一致。
 */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = navigator.userAgent || '';
  if (/Mac|iPhone|iPad|iPod/i.test(ua)) return 'macos';
  if (/Windows/i.test(ua)) return 'windows';
  return 'linux';
}

/** 当前是否 macOS */
export function isMac(): boolean {
  return detectPlatform() === 'macos';
}

/** 当前是否 Windows */
export function isWindows(): boolean {
  return detectPlatform() === 'windows';
}

/** 当前是否运行在 Tauri 运行时（区分 vite dev 纯前端预览） */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
}

/** 当前平台的路径分隔符：Windows 用反斜杠，其余用正斜杠 */
export function pathSep(): string {
  return isWindows() ? '\\' : '/';
}

/**
 * 跨平台 CJK 字体配置。
 * macOS 用系统自带的 PingFang SC，Windows 用 Microsoft YaHei，
 * 避免 Word / WPS 因缺失字体而弹「字体缺失」对话框。
 */
export function cjkFont(): { ascii: string; hAnsi: string; eastAsia: string } {
  return {
    ascii: 'Calibri',
    hAnsi: 'Calibri',
    eastAsia: isMac() ? 'PingFang SC' : 'Microsoft YaHei',
  };
}
