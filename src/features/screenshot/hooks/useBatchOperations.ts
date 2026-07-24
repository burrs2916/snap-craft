// ===== 批量操作 Hook =====
// 从 EnhancedScreenshotApp.tsx 提取的批量 OCR + 批量 AI 队列逻辑。

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { cleanOcrText, chatOnce, markdownToDocx, useAiStore } from '../../ai';
import type { OcrResult } from '../types';

// ── 类型 ──
export interface BatchItem {
  id: string;
  time: string;
  text: string;
}

export interface AiBatchItem {
  id: string;
  time: string;
  text: string;
  error?: string;
}

export interface HistoryEntryLike {
  id: string;
  dataUrl: string;
  createdAt: string;
}

export interface UseBatchOperationsDeps {
  history: HistoryEntryLike[];
  flash: (msg: string, type?: 'success' | 'error' | 'info') => void;
  t: (key: string, vars?: Record<string, any>) => string;
}

export function useBatchOperations(deps: UseBatchOperationsDeps) {
  const { history, flash, t } = deps;

  // R4：多选状态
  const [selMode, setSelMode] = useState(false);
  const [selIds, setSelIds] = useState<string[]>([]);
  // 批量 OCR
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [showBatch, setShowBatch] = useState(false);
  // Phase 28：批量 Agent 队列
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBatchBusy, setAiBatchBusy] = useState(false);
  const [aiBatchItems, setAiBatchItems] = useState<AiBatchItem[]>([]);
  const [aiBatchDone, setAiBatchDone] = useState(0);
  const [aiBatchTotal, setAiBatchTotal] = useState(0);
  const [showAiBatch, setShowAiBatch] = useState(false);

  const toggleSel = (id: string) => {
    setSelIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  const selectAll = () => setSelIds(history.map((h) => h.id));
  const clearSel = () => {
    setSelIds([]);
    setSelMode(false);
    setShowBatch(false);
    setBatchItems([]);
  };

  // 批量 OCR
  const handleBatchOcr = async () => {
    if (selIds.length === 0) return;
    setBatchBusy(true);
    const items: BatchItem[] = [];
    let ok = 0;
    let fail = 0;
    for (const id of selIds) {
      const item = history.find((h) => h.id === id);
      if (!item) continue;
      try {
        const res = await invoke<OcrResult>('ocr_image', { imageData: item.dataUrl, lang: null });
        const txt = cleanOcrText(res?.text).trim();
        if (txt) {
          items.push({ id, time: new Date(item.createdAt).toLocaleString(), text: txt });
          ok++;
        } else {
          fail++;
        }
      } catch {
        fail++;
      }
    }
    setBatchBusy(false);
    setBatchItems(items);
    setShowBatch(true);
    flash(t('ocr.batchDone', { ok, fail }), fail > 0 && ok === 0 ? 'error' : 'success');
  };

  // 批量 AI
  const handleBatchAi = async () => {
    if (selIds.length === 0) return;
    const prompt = aiPrompt.trim();
    if (!prompt) { flash(t('ocr.batchAiPromptNeeded'), 'error'); return; }
    const cfg = useAiStore.getState().config;
    if (!cfg || !cfg.apiKey) { flash(t('ocr.batchAiNoKey'), 'error'); return; }
    setAiBatchBusy(true);
    setAiBatchTotal(selIds.length);
    setAiBatchDone(0);
    setShowAiBatch(true);
    setAiBatchItems([]);
    const items: AiBatchItem[] = [];
    let ok = 0;
    let fail = 0;
    for (let idx = 0; idx < selIds.length; idx++) {
      const id = selIds[idx];
      const item = history.find((h) => h.id === id);
      if (!item) { fail++; setAiBatchDone(idx + 1); continue; }
      const time = new Date(item.createdAt).toLocaleString();
      try {
        const text = await chatOnce({
          config: cfg,
          messages: [
            { role: 'system', content: 'You are the SnapCraft screenshot assistant. The user provides a screenshot and an instruction; follow the instruction to process the screenshot (recognize, summarize, translate, extract information, or generate a document) and reply in the same language as the instruction. Output only the result, do not repeat the instruction.' },
            { role: 'user', content: prompt, imageDataUrl: item.dataUrl },
          ],
        });
        const txt = (text || '').trim();
        items.push({ id, time, text: txt || t('ocr.batchAiEmpty') });
        if (txt) ok++; else fail++;
      } catch (e: any) {
        items.push({ id, time, text: '', error: e?.message || String(e) });
        fail++;
      }
      setAiBatchItems([...items]);
      setAiBatchDone(idx + 1);
    }
    setAiBatchBusy(false);
    flash(t('ocr.batchAiDone', { ok, fail }), fail > 0 && ok === 0 ? 'error' : 'success');
  };

  // 批量面板操作
  const copyBatchAll = async () => {
    try {
      await navigator.clipboard.writeText(batchItems.map((i) => i.text).join('\n\n'));
      flash(t('ocr.copied'), 'success');
    } catch {
      flash(t('ocr.copyFail'), 'error');
    }
  };

  const exportBatchTxt = async () => {
    const path = await save({ defaultPath: `ocr-batch-${Date.now()}.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (!path) return;
    try {
      await invoke('save_text_file', { content: batchItems.map((i) => i.text).join('\n\n'), filePath: path });
      flash(t('ocr.exported', { path }), 'success');
    } catch (e) {
      flash(t('ocr.exportFailed', { msg: String(e) }), 'error');
    }
  };

  const copyAiBatchAll = async () => {
    try {
      await navigator.clipboard.writeText(aiBatchItems.map((i) => (i.error ? i.error : i.text)).join('\n\n'));
      flash(t('ocr.copied'), 'success');
    } catch {
      flash(t('ocr.copyFail'), 'error');
    }
  };

  const exportAiBatchMd = async () => {
    const path = await save({ defaultPath: `ai-batch-${Date.now()}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!path) return;
    try {
      const md = aiBatchItems.map((it, idx) => `## ${t('ocr.batchShotHead', { n: idx + 1, time: it.time })}\n\n${it.error ? '> ' + it.error : it.text}`).join('\n\n');
      await invoke('save_text_file', { content: md, filePath: path });
      flash(t('ocr.exported', { path }), 'success');
    } catch (e) {
      flash(t('ocr.exportFailed', { msg: String(e) }), 'error');
    }
  };

  const exportAiBatchDocx = async () => {
    const path = await save({ defaultPath: `ai-batch-${Date.now()}.docx`, filters: [{ name: 'Word', extensions: ['docx'] }] });
    if (!path) return;
    try {
      const md = aiBatchItems.map((it, idx) => `## ${t('ocr.batchShotHead', { n: idx + 1, time: it.time })}\n\n${it.error ? '> ' + it.error : it.text}`).join('\n\n');
      const bytes = await markdownToDocx(md, { title: t('ocr.batchAiTitle'), theme: useAiStore.getState().config?.theme });
      await invoke('save_binary_file', { bytes: Array.from(bytes), filePath: path });
      flash(t('ocr.exported', { path }), 'success');
    } catch (e) {
      flash(t('ocr.exportFailed', { msg: String(e) }), 'error');
    }
  };

  return {
    selMode, setSelMode, selIds, toggleSel, selectAll, clearSel,
    batchBusy, batchItems, showBatch, setShowBatch, setBatchItems,
    handleBatchOcr, copyBatchAll, exportBatchTxt,
    aiPrompt, setAiPrompt, aiBatchBusy, aiBatchItems, aiBatchDone, aiBatchTotal,
    showAiBatch, setShowAiBatch, setAiBatchItems,
    handleBatchAi, copyAiBatchAll, exportAiBatchMd, exportAiBatchDocx,
  };
}
