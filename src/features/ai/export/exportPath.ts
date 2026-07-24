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
// 平台检测统一使用共享模块（消除各文件重复的 UA 判断）
import { pathSep } from '../../../shared/platform';

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

/**
 * 从任意路径中提取文件名（跨平台：同时兼容 `/` 与 `\` 分隔符）。
 *
 * ⚠️ 跨平台对等（R25）：此前 UI 多处用 `path.split('/').pop()` 取文件名，
 * 在 macOS/Linux（路径用 `/`）正常，但在 Windows（路径用 `\`，见 `buildDefaultPath`）
 * 因无 `/` 可切而原样返回整条路径——导致"导出成功"提示与导出历史列表在
 * Windows 上显示成 `C:\Users\X\Documents\SnapCraft-ai-123.docx` 整串，而非 `SnapCraft-ai-123.docx`。
 * 用正则同时切两种分隔符，两端行为严格一致、功能只增不减。
 */
export function baseNameOf(p: string): string {
  if (!p) return '';
  return p.split(/[\\/]/).pop() ?? p;
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
  // ⚠️ 跨平台对等修复（R23）：绝不能用 "/" 硬拼。
  // 之前 `last.replace(/[\\/]+$/, '') + "/" + fileName` 在 Windows 上会产出
  // 混合分隔符路径（如 `C:\Users\X\Documents/SnapCraft-ai-123.docx`）。
  // Windows 原生 Save 对话框按 `\` 解析默认路径，遇到 `/` 会忽略默认目录、
  // 丢失预填文件名，造成"每次导出都要重选目录"的 Windows 专属偏差。
  // 现按运行平台选分隔符：Windows 用 `\`、其余用 `/`，两端都给出规范路径。
  const sep = pathSep();
  return `${last.replace(/[\\/]+$/, '')}${sep}${fileName}`;
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
