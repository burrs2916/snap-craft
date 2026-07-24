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

/** 当前是否 Linux */
export function isLinux(): boolean {
  return detectPlatform() === 'linux';
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

/** 跨平台 CJK 字体族字符串（用于 CSS font-family） */
export function cjkFontFamily(): string {
  return isMac()
    ? '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif'
    : '"Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif';
}

/** 快捷键修饰符显示：macOS 用 ⌘，其余用 Ctrl */
export function shortcutMod(): string {
  return isMac() ? '⌘' : 'Ctrl';
}

/** 快捷键修饰符显示（完整形式）：macOS 用 Command，其余用 Ctrl */
export function shortcutModFull(): string {
  return isMac() ? 'Command' : 'Ctrl';
}

// ── 2026-07-23 平台兼容性增强 ──

/**
 * 路径规范化：统一为正斜杠（Tauri 后端 Rust 侧两种分隔符都能处理，
 * 但前端 JS 字符串比较/拼接时混用 \ 和 / 会导致路径不匹配）。
 * 仅在需要「显示给用户」或「传给 Rust 后端」时调用。
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * 从路径中提取文件名（兼容 Windows 反斜杠和 Unix 正斜杠）。
 */
export function baseName(p: string): string {
  const normalized = normalizePath(p);
  const parts = normalized.split('/');
  return parts[parts.length - 1] || p;
}

/**
 * 从路径中提取目录部分（兼容双平台分隔符）。
 */
export function dirName(p: string): string {
  const normalized = normalizePath(p);
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(0, idx) : '.';
}

/**
 * 文件名净化：移除 Windows 不允许的字符（\ / : * ? " < > |）
 * 以及控制字符，确保生成的文件名在双平台都合法。
 * macOS 仅禁止 / 和 :，但为跨平台一致性统一按 Windows 最严格标准。
 */
export function sanitizeFileName(name: string, fallback = 'document'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200); // Windows MAX_PATH 安全余量
  return cleaned || fallback;
}

/**
 * 行尾规范化：统一为 \n（内部处理用）。
 * Windows 记事本等编辑器需要 \r\n 才能正确换行，
 * 但 Tauri 的 save_text_file 后端已处理此转换。
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * 判断键盘事件是否包含平台对应的「主修饰键」：
 * macOS 用 metaKey (⌘)，Windows/Linux 用 ctrlKey。
 * 用于统一快捷键处理逻辑，避免散落各处的 platform 判断。
 */
export function isPrimaryModifier(e: KeyboardEvent | React.KeyboardEvent): boolean {
  return isMac() ? e.metaKey : e.ctrlKey;
}

/**
 * 获取平台对应的「用户文档」目录提示（用于 UI 文案）。
 * macOS: ~/Documents, Windows: C:\Users\<name>\Documents
 */
export function documentsDirHint(): string {
  return isMac() ? '~/Documents' : '%USERPROFILE%\\Documents';
}

/**
 * 平台对应的「在文件管理器中显示」操作名称。
 * macOS: "在 Finder 中显示", Windows: "在资源管理器中显示"
 */
export function revealActionLabel(): string {
  return isMac() ? 'Finder' : 'Explorer';
}

