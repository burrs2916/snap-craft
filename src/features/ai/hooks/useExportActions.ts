// src/features/ai/hooks/useExportActions.ts
// 统一导出操作 Hook：封装 exportService + UI 反馈状态。
// 消除 AIPanel.tsx 与 AiHistoryOverlay.tsx 中重复的 7 格式导出管线代码。
//
// 使用方式：
//   const exportActions = useExportActions();
//   await exportActions.exportAs(ctx, 'docx');
//   // exportActions.exporting / exportMsg / exportErr 驱动 UI 反馈

import { useState, useCallback, useEffect } from 'react';
import {
  exportAs,
  exportZip,
  buildPreviewHtml,
  buildRichTextHtml,
  type ExportContext,
  type ExportFormat,
} from '../export/exportService';
import { revealInFolder, baseNameOf } from '../export/exportPath';
import { listExportHistory, clearExportHistory, type ExportHistoryItem } from '../export/exportHistory';
import { t, isTauri } from '../../../i18n';
import { invoke } from '@tauri-apps/api/core';
import type { ZipEntry } from '../export/zipStore';

const LAST_EXPORT_KEY = 'snapcraft-ai-last-exported-path';

export interface ExportActionsState {
  /** 是否正在导出中 */
  exporting: boolean;
  /** 导出反馈消息（成功/失败） */
  exportMsg: string | null;
  /** 是否为错误消息 */
  exportErr: boolean;
  /** 上一次成功导出的文件路径 */
  lastExportedPath: string | null;
  /** 应用内预览 HTML（null = 未打开） */
  previewHtml: string | null;
}

export interface ExportActionsApi extends ExportActionsState {
  /** 统一导出入口：按格式分发，自动处理 UI 反馈 */
  doExport: (ctx: ExportContext, fmt: ExportFormat, sheetName?: string) => Promise<void>;
  /** 导出 ZIP 归档 */
  doExportZip: (files: ZipEntry[], hint: string) => Promise<void>;
  /** 预览文档（Tauri 内 iframe / 浏览器新标签） */
  doPreview: (ctx: ExportContext) => void;
  /** 复制为富文本到剪贴板 */
  doCopyRich: (ctx: ExportContext, plainText: string) => Promise<boolean>;
  /** 在 Finder/Explorer 中显示上次导出文件 */
  revealExported: (path?: string | null) => Promise<void>;
  /** 用系统默认应用打开已导出文件 */
  openExported: (path: string) => Promise<void>;
  /** 关闭预览层 */
  closePreview: () => void;
  /** 清除导出消息 */
  clearMsg: () => void;
  /** 设置导出路径（外部调用方同步） */
  setLastExportedPath: (path: string) => void;
  /** 获取导出历史列表 */
  getExportHistory: () => ExportHistoryItem[];
  /** 清除导出历史 */
  doClearExportHistory: () => void;
}

export function useExportActions(): ExportActionsApi {
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportErr, setExportErr] = useState(false);
  const [lastExportedPath, setLastExportedPathState] = useState<string | null>(() => {
    try { return localStorage.getItem(LAST_EXPORT_KEY); } catch { return null; }
  });
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  // 持久化 lastExportedPath
  useEffect(() => {
    try {
      if (lastExportedPath) localStorage.setItem(LAST_EXPORT_KEY, lastExportedPath);
      else localStorage.removeItem(LAST_EXPORT_KEY);
    } catch { /* 忽略 */ }
  }, [lastExportedPath]);

  // 成功消息 4s 自动消失（错误消息保留）
  useEffect(() => {
    if (!exportMsg || exportErr) return;
    const timer = setTimeout(() => setExportMsg(null), 4000);
    return () => clearTimeout(timer);
  }, [exportMsg, exportErr]);

  const setLastExportedPath = useCallback((path: string) => {
    setLastExportedPathState(path);
  }, []);

  const doExport = useCallback(async (ctx: ExportContext, fmt: ExportFormat, sheetName?: string) => {
    if (exporting) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const path = await exportAs(ctx, fmt, sheetName);
      if (!path) {
        // 用户取消或 PDF 打印式导出
        if (fmt === 'pdf') {
          setExportMsg(t('ai.exportPdfHint'));
          setExportErr(false);
        }
        return;
      }
      const name = baseNameOf(path);
      setExportMsg(t('ai.exportOk', { path: name }));
      setExportErr(false);
      setLastExportedPathState(path);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setExportMsg(t('ai.exportFail', { msg }));
      setExportErr(true);
    } finally {
      setExporting(false);
    }
  }, [exporting]);

  const doExportZip = useCallback(async (files: ZipEntry[], hint: string) => {
    if (exporting) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const path = await exportZip(files, hint);
      if (!path) return;
      const name = baseNameOf(path);
      setExportMsg(t('ai.exportOk', { path: name }));
      setExportErr(false);
      setLastExportedPathState(path);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setExportMsg(t('ai.exportFail', { msg }));
      setExportErr(true);
    } finally {
      setExporting(false);
    }
  }, [exporting]);

  const doPreview = useCallback((ctx: ExportContext) => {
    setExportMsg(null);
    try {
      const html = buildPreviewHtml(ctx);
      if (isTauri()) {
        setPreviewHtml(html);
        return;
      }
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank');
      if (!win) {
        setExportMsg(t('ai.previewBlocked'));
        setExportErr(true);
        return;
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setExportMsg(t('ai.exportFail', { msg }));
      setExportErr(true);
    }
  }, []);

  const doCopyRich = useCallback(async (ctx: ExportContext, plainText: string): Promise<boolean> => {
    try {
      const html = buildRichTextHtml(ctx);
      const htmlBlob = new Blob([html], { type: 'text/html' });
      const textBlob = new Blob([plainText], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': htmlBlob,
          'text/plain': textBlob,
        }),
      ]);
      return true;
    } catch {
      return false;
    }
  }, []);

  const revealExported = useCallback(async (path?: string | null) => {
    const target = path || lastExportedPath;
    if (!target) return;
    try {
      await revealInFolder(target);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setExportMsg(t('ai.exportFail', { msg }));
      setExportErr(true);
    }
  }, [lastExportedPath]);

  const openExported = useCallback(async (path: string) => {
    if (!path) return;
    try {
      await invoke('open_external', { target: path });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setExportMsg(t('ai.exportFail', { msg }));
      setExportErr(true);
    }
  }, []);

  const closePreview = useCallback(() => setPreviewHtml(null), []);
  const clearMsg = useCallback(() => { setExportMsg(null); setExportErr(false); }, []);
  const getExportHistory = useCallback(() => listExportHistory(), []);
  const doClearExportHistory = useCallback(() => clearExportHistory(), []);

  return {
    exporting,
    exportMsg,
    exportErr,
    lastExportedPath,
    previewHtml,
    doExport,
    doExportZip,
    doPreview,
    doCopyRich,
    revealExported,
    openExported,
    closePreview,
    clearMsg,
    setLastExportedPath,
    getExportHistory,
    doClearExportHistory,
  };
}
