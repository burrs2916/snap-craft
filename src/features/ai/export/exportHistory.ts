// 导出历史持久化：记录最近 20 次成功导出（格式 / 路径 / 时间 / 标题），
// 让用户随时回看"导出了什么、在哪"，不因关闭应用而丢失。
// 纯前端 localStorage，零 Rust、零新依赖。
// PDF（打印式导出）不入库——无落盘路径，无法 revealInFolder。
//
// 与 exportPath.ts 的"目录记忆"互补：
//   - exportPath 记的是"上次保存到哪个目录"（影响下次默认路径）
//   - 本模块记的是"历史上导出过哪些文件"（供用户回顾与定位）

const KEY = 'snapcraft-ai-export-history';
const MAX = 20;

export interface ExportHistoryItem {
  /** 完整文件路径（用于 revealInFolder） */
  path: string;
  /** 扩展名（不含点）：docx | pptx | xlsx | html | md | txt | zip */
  format: string;
  /** 文档标题（首个一级标题 / 首轮目标），用于列表展示 */
  title: string;
  /** 导出时间戳（Date.now()） */
  time: number;
}

/** 读取全部导出历史（最新在前）。失败静默回退空数组。 */
export function listExportHistory(): ExportHistoryItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ExportHistoryItem[]) : [];
  } catch {
    return [];
  }
}

/**
 * 追加一条导出记录。自动去重（同路径只保留最新）+ 截断到最近 MAX 条。
 * 返回更新后的列表，调用方可直接用于刷新 UI。
 */
export function pushExportHistory(item: ExportHistoryItem): ExportHistoryItem[] {
  if (!item?.path) return listExportHistory();
  const next = [
    item,
    ...listExportHistory().filter((it) => it.path !== item.path),
  ].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* localStorage 满/被禁用 → 静默，不影响导出主流程 */
  }
  return next;
}

/** 清空全部导出历史。 */
export function clearExportHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}
