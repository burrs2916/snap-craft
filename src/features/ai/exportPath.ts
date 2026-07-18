// 导出路径助手：把"默认保存目录记忆 + 智能文件名 + 路径消毒"集中起来。
// 调用方只需提供 ext 与可选 titleHint，其它全自动。
//
// 解决问题（按 ROI）：
//   ① 默认保存目录记忆：用户反复导出同一会话/同一类文件时无需每次重选目录。
//   ② 智能文件名：把首轮目标前 30 字做摘要，避免桌面一片 `snapcraft-ai-<timestamp>`。
//   ③ 跨平台路径消毒：Windows 反斜杠转 `+`，非法字符替换为 `_`。
//
// 设计原则：失败静默回退——目录记忆丢了不影响主流程。

import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

const LAST_DIR_KEY = 'snapcraft-ai-last-dir';
const DEFAULT_BASENAME = 'snapcraft-ai';
// Windows 文件名禁用字符
const ILLEGAL_RE = /[\\/:*?"<>|\u0000-\u001F]/g;

/** 从任意路径中提取目录部分。返回空串表示没有目录（裸文件名）。 */
function dirOf(p: string): string {
  if (!p) return '';
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i) : '';
}

/** 文件名消毒：去掉非法字符 + 截断过长部分。 */
export function sanitizeFilename(name: string, max = 40): string {
  const cleaned = (name || '').replace(ILLEGAL_RE, '_').trim();
  if (!cleaned) return '';
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/** 把"首轮目标"做成文件名前缀的友好摘要。 */
export function deriveFileHint(goal: string | undefined | null): string {
  if (!goal) return '';
  // 去掉首尾空白 + 合并换行
  const flat = String(goal).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return sanitizeFilename(flat, 30);
}

/** 读出上次使用的保存目录（可能为 null）。 */
function readLastDir(): string | null {
  try {
    return localStorage.getItem(LAST_DIR_KEY);
  } catch {
    return null;
  }
}

/** 写入本次保存目录，失败静默。 */
function writeLastDir(dir: string): void {
  if (!dir) return;
  try {
    localStorage.setItem(LAST_DIR_KEY, dir);
  } catch {
    /* localStorage 满/被禁用 → 静默 */
  }
}

export interface BuildDefaultPathOpts {
  ext: string; // 不含点，如 "docx"
  hint?: string; // 首轮目标，做摘要
  prefix?: string; // 命名前缀，默认 "snapcraft-ai"
  /** 是否加时间戳（默认 true；批量场景可关掉） */
  withTs?: boolean;
}

/** 生成 saveDialog 的 defaultPath：lastDir + sanitize(hint) + ts + ext */
export function buildDefaultPath(opts: BuildDefaultPathOpts): string {
  const { ext, hint = '', prefix = DEFAULT_BASENAME, withTs = true } = opts;
  const cleanExt = (ext || '').replace(/^\./, '').toLowerCase() || 'file';
  const baseCore = hint ? `${prefix}-${hint}` : prefix;
  const stamp = withTs ? `-${Date.now()}` : '';
  const fileName = `${baseCore}${stamp}.${cleanExt}`;
  const last = readLastDir();
  if (!last) return fileName;
  // 平台无关：直接用 "/" 拼接（saveDialog 在 Windows 也会自动归一）
  return `${last.replace(/[\\/]+$/, '')}/${fileName}`;
}

/** 选完路径后，记住它的目录部分。返回原路径。 */
export function rememberDirFromPath(path: string): string {
  if (!path) return path;
  const d = dirOf(path);
  if (d) writeLastDir(d);
  return path;
}

/**
 * 一步式：打开 saveDialog（已用记忆目录 + 智能文件名）→ 用户确认后自动记录目录 → 返回完整路径。
 * 失败/取消返回 null。调用方无需再处理 lastDir。
 */
export async function pickExportPath(opts: BuildDefaultPathOpts & { filters: { name: string; extensions: string[] }[] }): Promise<string | null> {
  const defaultPath = buildDefaultPath(opts);
  const path = await saveDialog({ defaultPath, filters: opts.filters });
  if (!path) return null;
  return rememberDirFromPath(path);
}

/** 在文件管理器（Finder/Explorer/Nautilus）中显示导出文件。 */
export async function revealInFolder(path: string): Promise<string | null> {
  if (!path) return null;
  try {
    await invoke('reveal_in_folder', { path });
    return null;
  } catch (e: any) {
    return e?.message ? String(e.message) : String(e);
  }
}
