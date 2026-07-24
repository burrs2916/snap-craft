// ===== 截图历史管理 Hook =====
// 从 EnhancedScreenshotApp.tsx 提取的历史记录 CRUD + 搜索 + 持久化逻辑。
// 职责单一：只管历史数据的增删查改与搜索过滤，不涉及截图/编辑/AI 等功能。

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { convHash } from '../../ai/aiStore';
import { purgeAiDataForHash, purgeAllAiData } from '../../ai/lib/conversationIndex';

export interface HistoryEntry {
  id: string;
  dataUrl: string;
  createdAt: string;
  width: number;
  height: number;
  /** 来源：'capture'=本机截图，'clipboard'=剪贴板图片，'ai_edit'=AI 编辑烧录产物 */
  source?: 'capture' | 'clipboard' | 'ai_edit';
  /** OCR 识别结果（已落库），用于按文字搜索 */
  ocr_text?: string;
}

export interface UseHistoryReturn {
  history: HistoryEntry[];
  setHistory: React.Dispatch<React.SetStateAction<HistoryEntry[]>>;
  /** 按 OCR 文字 / 时间搜索过滤后的列表 */
  filteredHistory: HistoryEntry[];
  historySearch: string;
  setHistorySearch: (q: string) => void;
  /** 添加一条历史（前端 + 后端持久化） */
  addEntry: (entry: HistoryEntry) => Promise<void>;
  /** 删除单条历史 */
  deleteEntry: (id: string) => Promise<void>;
  /** 清空全部历史（含二次确认） */
  clearAll: (confirmMsg: string) => Promise<boolean>;
}

/**
 * 关闭某条历史对应的编辑窗（label = `editor-${id}`）。
 * 删除历史后若编辑窗仍开着，会成为孤儿窗口：关窗时回写已删除的 id 失败被吞掉，
 * 用户的编辑静默丢失且无任何提示。故删除时主动关闭对应编辑窗。
 */
async function closeEditorWindowById(id: string): Promise<void> {
  try {
    const win = await WebviewWindow.getByLabel(`editor-${id}`);
    if (win) await win.close();
  } catch {
    /* 窗口可能已关闭，忽略 */
  }
}

/** 关闭所有编辑窗（清空历史时用）。 */
async function closeAllEditorWindows(): Promise<void> {
  try {
    const wins = await WebviewWindow.getAll();
    await Promise.all(
      wins.filter((w) => w.label.startsWith('editor-')).map((w) => w.close().catch(() => {})),
    );
  } catch {
    /* ignore */
  }
}

/**
 * 截图历史管理 Hook。
 *
 * @param flash  通知回调（成功/失败提示）
 * @param t      i18n 翻译函数
 * @param onDeleted 删除后的额外回调（如清空当前编辑引用）
 */
export function useHistory(
  flash: (msg: string, type?: 'success' | 'error' | 'info') => void,
  t: (key: string, vars?: Record<string, any>) => string,
  onDeleted?: (id: string) => void,
): UseHistoryReturn {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historySearch, setHistorySearch] = useState('');

  // 始终指向最新 history，供 deleteEntry 查找 dataUrl（避免将 history 加入 deps）
  const historyRef = useRef(history);
  historyRef.current = history;

  // 搜索过滤：匹配 OCR 文字或时间
  const filteredHistory = (() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return history;
    return history.filter((h) => {
      const ocr = (h.ocr_text || '').toLowerCase();
      const time = new Date(h.createdAt).toLocaleString().toLowerCase();
      return ocr.includes(q) || time.includes(q);
    });
  })();

  // 启动时加载历史
  useEffect(() => {
    (async () => {
      try {
        const raw = (await invoke('get_history')) as any[];
        if (Array.isArray(raw)) {
          setHistory(
            raw.map((i) => ({
              id: i.id,
              dataUrl: i.data_url,
              createdAt: i.created_at,
              width: i.width,
              height: i.height,
              source: i.source === 'clipboard' ? 'clipboard' : i.source === 'ai_edit' ? 'ai_edit' : 'capture',
              ocr_text: i.ocr_text,
            })),
          );
        }
      } catch {
        /* 历史为空或读取失败，忽略 */
      }
    })();
  }, []);

  const addEntry = useCallback(async (entry: HistoryEntry) => {
    setHistory((h) => [entry, ...h]);
    try {
      await invoke('add_history', {
        item: {
          id: entry.id,
          data_url: entry.dataUrl,
          created_at: entry.createdAt,
          width: entry.width,
          height: entry.height,
          source: entry.source || 'capture',
        },
      });
    } catch {
      /* 持久化失败不阻断使用 */
    }
  }, []);

  const deleteEntry = useCallback(
    async (id: string) => {
      if (!id) return;
      try {
        // 先关闭对应编辑窗，避免删除后遗留孤儿窗口（其关窗回写会静默失败）
        await closeEditorWindowById(id);
        // 级联清除该截图关联的全部 AI localStorage 数据（对话/选择/记忆/fork/索引）
        const entry = historyRef.current.find((x) => x.id === id);
        if (entry) purgeAiDataForHash(convHash(entry.dataUrl));
        await invoke('delete_history', { id });
        setHistory((h) => h.filter((x) => x.id !== id));
        onDeleted?.(id);
        flash(t('toast.deleted'), 'success');
      } catch (e) {
        flash(t('toast.deleteFailed', { msg: String(e) }), 'error');
      }
    },
    [flash, t, onDeleted],
  );

  const clearAll = useCallback(
    async (confirmMsg: string): Promise<boolean> => {
      if (!window.confirm(confirmMsg)) return false;
      try {
        // 关闭所有编辑窗，避免清空后遗留孤儿窗口
        await closeAllEditorWindows();
        // 级联清除全部 AI localStorage 数据（所有截图的对话/选择/记忆/索引）
        purgeAllAiData();
        await invoke('clear_history');
        setHistory([]);
        flash(t('toast.historyCleared'), 'success');
        return true;
      } catch (e) {
        flash(t('toast.historyClearFailed', { msg: String(e) }), 'error');
        return false;
      }
    },
    [flash, t],
  );

  return {
    history,
    setHistory,
    filteredHistory,
    historySearch,
    setHistorySearch,
    addEntry,
    deleteEntry,
    clearAll,
  };
}
