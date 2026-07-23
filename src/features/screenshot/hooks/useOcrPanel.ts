// ===== OCR 面板 Hook =====
// 从 EnhancedScreenshotApp.tsx 提取的全部 OCR 状态、副作用、回调。
// 父组件通过 deps 注入外部依赖，hook 返回完整 OCR 面板所需的一切。

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { cleanOcrText } from '../../ai/ocrClean';
import { useScreenshotStore } from '../store/screenshotStore';
import { openEditorWindow } from '../components/EditorWindow';
import type { OcrResult, OcrBlock, AnnotationObject } from '../types';
import {
  OCR_HIST_MAX,
  loadOcrPrefs,
  saveOcrPrefs,
  loadOcrHist,
  saveOcrHist,
  makeThumbDataUrl,
  ocrReadingOrder,
  ocrCleanText,
  ocrExtractEntities,
  ocrHighlightParts,
  type OcrLayout,
  type OcrExportFmt,
  type OcrHistItem,
  type OcrEntity,
} from '../utils/ocrUtils';
import { genAnnoId } from '../utils/helpers';

// ── 外部依赖接口 ──
export interface OcrPanelDeps {
  /** 当前编辑中的截图（dataUrl + 像素尺寸） */
  current: { dataUrl: string; width: number; height: number } | null;
  /** 平台标识：'macos' | 'windows' | 'linux' | '' */
  platform: string;
  /** toast 提示 */
  flash: (msg: string, type?: 'success' | 'error' | 'info') => void;
  /** i18n 翻译函数 */
  t: (key: string, vars?: Record<string, any>) => string;
  /** 画布 ref（flashRegion 用） */
  canvasRef: React.RefObject<any>;
  /** 添加标注到画布 */
  addAnnotation: (a: AnnotationObject) => void;
  /** 当前截图元数据（含 id，用于 OCR 落库） */
  currentScreenshot: any | null;
  setCurrentScreenshot: (s: any | null) => void;
  setCurrent: (c: { dataUrl: string; width: number; height: number } | null) => void;
  setCurrentView: React.Dispatch<React.SetStateAction<'home' | 'edit'>>;
  history: any[];
  setHistory: React.Dispatch<React.SetStateAction<any[]>>;
  resultBarTimerRef: React.MutableRefObject<any>;
  setLastShot: (s: any) => void;
}

// ── Hook 返回值类型 ──
export interface OcrPanelState {
  // 核心状态
  ocrBusy: boolean;
  ocrResult: OcrResult | null;
  ocrResultRef: React.MutableRefObject<OcrResult | null>;
  ocrLang: string;
  ocrRegionMode: boolean;
  ocrEdits: Record<number, string>;
  ocrSearch: string;
  ocrConf: number;
  ocrMerge: boolean;
  ocrAutoCopy: boolean;
  ocrElapsed: number | null;
  ocrHistory: OcrHistItem[];
  ocrHistoryOpen: boolean;
  ocrLayout: OcrLayout;
  ocrExportFmt: OcrExportFmt;
  ocrExtract: boolean;
  ocrClean: boolean;
  ocrFontSize: number;
  ocrClipBusy: boolean;
  ocrSel: Record<number, boolean>;
  ocrLastImage: string | null;
  ocrSourceKind: 'image' | 'text' | null;
  ocrMatchIdx: number;
  ocrHoverLine: number | null;
  ocrRegionPick: boolean;
  ocrDrag: { x: number; y: number; w: number; h: number } | null;
  // refs
  ocrSearchRef: React.RefObject<HTMLInputElement>;
  ocrTextRef: React.RefObject<HTMLDivElement>;
  ocrActiveMarkRef: React.MutableRefObject<HTMLElement | null>;
  ocrWrapRef: React.RefObject<HTMLDivElement>;
  // setters（面板 JSX 需要直接操作）
  setOcrResult: React.Dispatch<React.SetStateAction<OcrResult | null>>;
  setOcrLang: React.Dispatch<React.SetStateAction<string>>;
  setOcrRegionMode: React.Dispatch<React.SetStateAction<boolean>>;
  setOcrEdits: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  setOcrSearch: React.Dispatch<React.SetStateAction<string>>;
  setOcrConf: React.Dispatch<React.SetStateAction<number>>;
  setOcrMerge: React.Dispatch<React.SetStateAction<boolean>>;
  setOcrAutoCopy: React.Dispatch<React.SetStateAction<boolean>>;
  setOcrHistoryOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setOcrLayout: React.Dispatch<React.SetStateAction<OcrLayout>>;
  setOcrExportFmt: React.Dispatch<React.SetStateAction<OcrExportFmt>>;
  setOcrExtract: React.Dispatch<React.SetStateAction<boolean>>;
  setOcrClean: React.Dispatch<React.SetStateAction<boolean>>;
  setOcrFontSize: React.Dispatch<React.SetStateAction<number>>;
  setOcrSel: React.Dispatch<React.SetStateAction<Record<number, boolean>>>;
  setOcrMatchIdx: React.Dispatch<React.SetStateAction<number>>;
  setOcrHoverLine: React.Dispatch<React.SetStateAction<number | null>>;
  setOcrRegionPick: React.Dispatch<React.SetStateAction<boolean>>;
  setOcrDrag: React.Dispatch<React.SetStateAction<{ x: number; y: number; w: number; h: number } | null>>;
  setOcrHistory: React.Dispatch<React.SetStateAction<OcrHistItem[]>>;
  // 回调
  runOcr: (imageData: string, langOverride?: string | null) => Promise<OcrResult | null>;
  handleOcr: () => void;
  handleLangChange: (v: string) => void;
  startOcrFromClipboard: () => Promise<void>;
  startOcrFromShot: (shot: { id: string; dataUrl: string; width: number; height: number }) => void;
  onRegionOcr: (dataUrl: string) => void;
  applyOcrAsAnnotations: () => void;
  redactOcrSel: () => void;
  highlightOcrSel: () => void;
  arrowOcrSel: () => void;
  handleExportOcr: () => Promise<void>;
  copyOcrAs: (fmt: 'json' | 'tsv') => Promise<void>;
  selectOcrText: () => void;
  onPreviewDown: (e: React.MouseEvent) => void;
  onPreviewMove: (e: React.MouseEvent) => void;
  onPreviewUp: () => void;
  // 派生计算
  ocrVisibleLines: () => { b: OcrBlock; i: number }[];
  ocrIncludedLines: () => { b: OcrBlock; i: number }[];
  ocrSelectedBlocks: () => { b: OcrBlock; i: number }[];
  ocrTextAt: (i: number, b: OcrBlock) => string;
  buildOcrExportContent: (fmt: OcrExportFmt) => string;
  focusOcrLine: (i: number) => void;
}

export function useOcrPanel(deps: OcrPanelDeps): OcrPanelState {
  const {
    current, platform, flash, t, canvasRef, addAnnotation,
    currentScreenshot, setCurrentScreenshot, setCurrent, setCurrentView,
    history, setHistory, resultBarTimerRef, setLastShot,
  } = deps;

  // store 样式值（贴回标注用）
  const {
    currentColor, currentStrokeWidth, currentFontFamily,
    currentBold, currentItalic, currentTextBg,
    currentBgColor, currentBgOpacity, currentTextStroke,
  } = useScreenshotStore();

  // ===== 状态 =====
  const ocrPrefs0 = loadOcrPrefs();
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  const ocrResultRef = useRef<OcrResult | null>(null);
  ocrResultRef.current = ocrResult;
  const [ocrLang, setOcrLang] = useState<string>(ocrPrefs0.lang);
  const [ocrRegionMode, setOcrRegionMode] = useState(false);
  const [ocrEdits, setOcrEdits] = useState<Record<number, string>>({});
  const [ocrSearch, setOcrSearch] = useState('');
  const [ocrConf, setOcrConf] = useState(0);
  const [ocrMerge, setOcrMerge] = useState<boolean>(ocrPrefs0.merge);
  const [ocrAutoCopy, setOcrAutoCopy] = useState<boolean>(ocrPrefs0.autoCopy);
  const [ocrElapsed, setOcrElapsed] = useState<number | null>(null);
  const [ocrHistory, setOcrHistory] = useState<OcrHistItem[]>(loadOcrHist());
  const [ocrHistoryOpen, setOcrHistoryOpen] = useState(false);
  const [ocrLayout, setOcrLayout] = useState<OcrLayout>(ocrPrefs0.layout || 'none');
  const [ocrExportFmt, setOcrExportFmt] = useState<OcrExportFmt>(ocrPrefs0.exportFmt);
  const [ocrExtract, setOcrExtract] = useState<boolean>(ocrPrefs0.extract);
  const [ocrClean, setOcrClean] = useState<boolean>(ocrPrefs0.clean);
  const [ocrFontSize, setOcrFontSize] = useState<number>(ocrPrefs0.fontSize);
  const [ocrClipBusy, setOcrClipBusy] = useState(false);
  const ocrClipBusyRef = useRef(false);
  const [ocrSel, setOcrSel] = useState<Record<number, boolean>>({});
  const [ocrLastImage, setOcrLastImage] = useState<string | null>(null);
  const [ocrSourceKind, setOcrSourceKind] = useState<'image' | 'text' | null>(null);
  const ocrSearchRef = useRef<HTMLInputElement>(null);
  const [ocrMatchIdx, setOcrMatchIdx] = useState(0);
  const ocrTextRef = useRef<HTMLDivElement>(null);
  const ocrActiveMarkRef = useRef<HTMLElement | null>(null);
  const [ocrHoverLine, setOcrHoverLine] = useState<number | null>(null);
  const [ocrRegionPick, setOcrRegionPick] = useState(false);
  const [ocrDrag, setOcrDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const ocrWrapRef = useRef<HTMLDivElement>(null);
  const ocrDragStart = useRef<{ x: number; y: number } | null>(null);

  // ===== 副作用 =====
  // 偏好持久化
  useEffect(() => {
    saveOcrPrefs({ lang: ocrLang, merge: ocrMerge, autoCopy: ocrAutoCopy, layout: ocrLayout, fontSize: ocrFontSize, exportFmt: ocrExportFmt, extract: ocrExtract, clean: ocrClean });
  }, [ocrLang, ocrMerge, ocrAutoCopy, ocrLayout, ocrFontSize, ocrExportFmt, ocrExtract, ocrClean]);
  // 历史持久化
  useEffect(() => {
    saveOcrHist(ocrHistory);
  }, [ocrHistory]);
  // ref 镜像（避免 runOcr 频繁重建）
  const ocrAutoCopyRef = useRef(ocrAutoCopy);
  const ocrMergeRef = useRef(ocrMerge);
  useEffect(() => { ocrAutoCopyRef.current = ocrAutoCopy; }, [ocrAutoCopy]);
  useEffect(() => { ocrMergeRef.current = ocrMerge; }, [ocrMerge]);
  // 面板快捷键：Esc 关闭 / Cmd+F 聚焦搜索
  useEffect(() => {
    if (ocrResult === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOcrResult(null);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        ocrSearchRef.current?.focus();
        ocrSearchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ocrResult]);
  // 搜索词变化 → 命中序号归零
  useEffect(() => { setOcrMatchIdx(0); }, [ocrSearch]);
  // 当前命中变更 → 滚动到可视区域
  useEffect(() => {
    ocrActiveMarkRef.current?.scrollIntoView({ block: 'nearest' });
  }, [ocrMatchIdx, ocrSearch]);

  // ===== 核心回调 =====
  const runOcr = useCallback(
    async (imageData: string, langOverride?: string | null) => {
      if (ocrBusy) return null;
      setOcrBusy(true);
      setOcrElapsed(null);
      setOcrLastImage(imageData);
      setOcrSourceKind('image');
      const t0 = performance.now();
      const used = langOverride !== undefined ? langOverride : ocrLang === 'auto' ? null : ocrLang;
      try {
        const res = await invoke<OcrResult>('ocr_image', { imageData, lang: used });
        const cleanedText = cleanOcrText(res?.text);
        const cleanedBlocks = (res?.blocks ?? []).map((b) => ({ ...b, text: cleanOcrText(b.text) }));
        const cleaned: OcrResult = { text: cleanedText, blocks: cleanedBlocks };
        const elapsed = Math.round(performance.now() - t0);
        setOcrEdits({});
        setOcrSearch('');
        setOcrConf(0);
        setOcrSel({});
        setOcrRegionPick(false);
        setOcrDrag(null);
        setOcrResult(cleaned);
        setOcrElapsed(elapsed);
        if (current) {
          const sourceId = currentScreenshot?.id ?? '';
          const plain = cleanedBlocks.map((b) => b.text).join('\n');
          const histThumb = makeThumbDataUrl(current.dataUrl, 80, 60);
          const histSourceId = sourceId || undefined;
          setOcrHistory((h) =>
            [{ text: plain, lang: used ?? 'auto', ts: Date.now(), chars: plain.length, thumb: histThumb, sourceId: histSourceId }, ...h].slice(0, OCR_HIST_MAX)
          );
          if (sourceId) {
            try {
              await invoke('set_screenshot_ocr_full', { id: sourceId, ocrText: cleanedText, ocrBlocksJson: JSON.stringify(cleanedBlocks) });
            } catch (e) {
              console.warn('[OCR] 持久化 ocr_blocks 失败:', e);
            }
          }
        }
        if (ocrAutoCopyRef.current) {
          const txt = cleanedBlocks.map((b) => b.text).join(ocrMergeRef.current ? ' ' : '\n');
          try {
            await navigator.clipboard.writeText(txt);
            flash(t('ocr.autoCopied'), 'success');
          } catch {
            flash(t('ocr.copyFailed'), 'error');
          }
        }
        return res;
      } catch (e) {
        const msg = String(e);
        if (msg.includes('未识别到文字')) {
          flash(t('toast.ocrNone'), 'error');
        } else {
          flash(t('toast.ocrFailed', { msg }), 'error');
        }
        return null;
      } finally {
        setOcrBusy(false);
      }
    },
    [ocrBusy, ocrLang, flash, t, current, currentScreenshot]
  );

  // 取某块当前文字：优先内联修正
  const ocrTextAt = (i: number, b: OcrBlock): string =>
    ocrEdits[i] !== undefined ? ocrEdits[i] : b.text;

  // 全文框全选
  const selectOcrText = () => {
    const el = ocrTextRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel) return;
    const r = document.createRange();
    r.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(r);
  };

  // 可见行（搜索 + 置信度过滤）
  const ocrVisibleLines = useCallback((): { b: OcrBlock; i: number }[] => {
    if (!ocrResult) return [];
    const q = ocrSearch.trim().toLowerCase();
    const pass = (conf: number) => ocrConf <= 0 || conf <= 0 || conf * 100 >= ocrConf;
    const order = ocrLayout === 'reading' ? ocrReadingOrder(ocrResult.blocks) : ocrResult.blocks.map((_, i) => i);
    return order
      .map((i) => ({ b: ocrResult.blocks[i], i }))
      .filter(({ b, i }) => {
        if (q && !ocrTextAt(i, b).toLowerCase().includes(q)) return false;
        if (!pass(b.confidence)) return false;
        return true;
      });
  }, [ocrResult, ocrSearch, ocrConf, ocrEdits, ocrLayout]);

  // 纳入集合（可见 + 勾选）
  const ocrIncludedLines = useCallback((): { b: OcrBlock; i: number }[] => {
    const vis = ocrVisibleLines();
    const anySel = vis.some(({ i }) => ocrSel[i]);
    if (!anySel) return vis;
    return vis.filter(({ i }) => ocrSel[i]);
  }, [ocrVisibleLines, ocrSel]);

  // 严格已勾选集合
  const ocrSelectedBlocks = useCallback((): { b: OcrBlock; i: number }[] => {
    const vis = ocrVisibleLines();
    const anySel = vis.some(({ i }) => ocrSel[i]);
    if (!anySel) return [];
    return vis.filter(({ i }) => ocrSel[i]);
  }, [ocrVisibleLines, ocrSel]);

  // 语言切换
  const handleLangChange = (v: string) => {
    setOcrLang(v);
    if (platform !== '' && platform !== 'macos' && current && !ocrBusy) {
      runOcr(current.dataUrl, v === 'auto' ? null : v);
    }
  };

  // 导出内容组装
  const buildOcrExportContent = (fmt: OcrExportFmt): string => {
    const vis = ocrIncludedLines();
    if (fmt === 'json') {
      const arr = vis.map(({ b, i }) => ({
        text: ocrTextAt(i, b),
        x: +b.x.toFixed(5), y: +b.y.toFixed(5),
        w: +b.w.toFixed(5), h: +b.h.toFixed(5),
        confidence: +b.confidence.toFixed(3),
      }));
      return JSON.stringify(arr, null, 2);
    }
    if (fmt === 'tsv') {
      const esc = (s: string) => s.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
      const head = 'text\tx\ty\tw\th\tconfidence';
      const rows = vis.map(({ b, i }) =>
        [esc(ocrTextAt(i, b)), b.x.toFixed(5), b.y.toFixed(5), b.w.toFixed(5), b.h.toFixed(5), b.confidence.toFixed(3)].join('\t')
      );
      return [head, ...rows].join('\n');
    }
    const bodyRaw = vis.map(({ b, i }) => ocrTextAt(i, b)).join(ocrMerge ? ' ' : '\n');
    const body = ocrClean ? ocrCleanText(bodyRaw) : bodyRaw;
    return fmt === 'md' ? `# SnapCraft OCR\n\n${body}\n` : body;
  };

  // 导出到文件
  const handleExportOcr = async () => {
    const fmt = ocrExportFmt;
    const lines = ocrIncludedLines();
    if (lines.length === 0) { flash(t('ocr.exportEmpty'), 'error'); return; }
    const content = buildOcrExportContent(fmt);
    if (!content.trim()) { flash(t('ocr.exportEmpty'), 'error'); return; }
    const ext = fmt === 'txt' ? 'txt' : fmt === 'md' ? 'md' : fmt === 'json' ? 'json' : 'tsv';
    const name = fmt === 'txt' ? 'Text' : fmt === 'md' ? 'Markdown' : fmt === 'json' ? 'JSON' : 'TSV';
    const path = await save({ defaultPath: `snapcraft-ocr-${Date.now()}.${ext}`, filters: [{ name, extensions: [ext] }] });
    if (!path) return;
    try {
      await invoke('save_text_file', { content, filePath: path });
      flash(t('ocr.exported', { path }), 'success');
    } catch (e) {
      flash(t('ocr.exportFailed', { msg: String(e) }), 'error');
    }
  };

  const handleOcr = () => {
    if (!current) return;
    runOcr(current.dataUrl);
  };

  // 结果条/历史网格「取字」→ 独立编辑窗
  const startOcrFromShot = (shot: { id: string; dataUrl: string; width: number; height: number }) => {
    if (!shot?.dataUrl) return;
    if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current);
    setLastShot(null);
    openEditorWindow({ id: shot.id, width: shot.width, height: shot.height, autoOcr: true });
  };

  // 取图片尺寸
  const getImageDims = (dataUrl: string): Promise<{ w: number; h: number }> =>
    new Promise((res) => {
      const img = new Image();
      img.onload = () => res({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
      img.onerror = () => res({ w: 0, h: 0 });
      img.src = dataUrl;
    });

  // 文字卡片渲染
  const makeTextCardDataUrl = (text: string): Promise<string> =>
    new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(''); return; }
      const W = 920, pad = 44, fontSize = 20, lineH = 30, maxW = W - pad * 2;
      const font = `${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif`;
      ctx.font = font;
      const lines: string[] = [];
      for (const para of text.split(/\n/)) {
        if (para === '') { lines.push(''); continue; }
        let cur = '';
        for (const ch of para) {
          const test = cur + ch;
          if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = ch; }
          else cur = test;
        }
        if (cur) lines.push(cur);
      }
      const MAX_LINES = 240;
      const over = lines.length > MAX_LINES;
      const shown = over ? [...lines.slice(0, MAX_LINES), `…（共 ${lines.length} 行）`] : lines;
      const H = Math.max(360, shown.length * lineH + pad * 2);
      canvas.width = W; canvas.height = H;
      ctx.font = font;
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#f4f4f7'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#c7c7d1'; ctx.fillRect(0, 0, 6, H);
      ctx.fillStyle = '#1d1d1f';
      for (let i = 0; i < shown.length; i++) ctx.fillText(shown[i], pad, pad + i * lineH);
      resolve(canvas.toDataURL('image/png'));
    });

  // 从剪贴板取字
  const startOcrFromClipboard = async () => {
    if (ocrClipBusyRef.current || ocrBusy) return;
    ocrClipBusyRef.current = true;
    setOcrClipBusy(true);
    try {
      let text: string | null = null;
      try {
        const t2 = await invoke<string>('read_clipboard_text');
        if (t2 && t2.trim().length > 0) text = t2;
      } catch { /* 无文字 */ }

      if (text) {
        try {
          const card = await makeTextCardDataUrl(text);
          const dim = await getImageDims(card);
          setCurrentScreenshot(null);
          setCurrent({ dataUrl: card, width: dim.w || 920, height: dim.h || 360 });
          setCurrentView('edit');
          setOcrEdits({}); setOcrSearch(''); setOcrConf(0);
          setOcrSel({}); setOcrRegionPick(false); setOcrDrag(null);
          setOcrResult({ text, blocks: [{ text, x: 0, y: 0, w: 1, h: 1, confidence: 1 }] });
          setOcrLastImage(card);
          setOcrSourceKind('text');
          flash(t('ocr.clipTextMode'), 'success');
        } catch {
          flash(t('ocr.clipTextRenderFailed'), 'error');
        }
        return;
      }

      const dataUrl = await invoke<string>('read_clipboard_image');
      if (!dataUrl || !dataUrl.startsWith('data:image')) {
        flash(t('ocr.clipEmptyNeutral'), 'info');
        return;
      }
      const dim = await getImageDims(dataUrl);
      const cid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const cAt = new Date().toISOString();
      const entry = { id: cid, dataUrl, createdAt: cAt, width: dim.w, height: dim.h, source: 'clipboard' as const };
      setHistory((h) => [entry, ...h]);
      try {
        await invoke('add_history', { item: { id: cid, data_url: dataUrl, created_at: cAt, width: dim.w, height: dim.h, source: 'clipboard' } });
      } catch { /* 持久化失败不阻断 */ }
      setCurrent({ dataUrl, width: dim.w, height: dim.h });
      setCurrentScreenshot({ id: cid, filePath: '', dataUrl, width: dim.w, height: dim.h, annotations: [], layers: [], createdAt: cAt, updatedAt: cAt });
      setCurrentView('edit');
      await runOcr(dataUrl);
    } catch (e) {
      const msg = String(e);
      const isArboardRaw = /not available in the requested format|clipboard contents were not available|was not available|读取剪贴板文件失败/i.test(msg);
      if (isArboardRaw) flash(t('ocr.clipEmptyNeutral'), 'info');
      else if (msg.includes('ERR_EMPTY')) flash(t('ocr.clipEmptyNeutral'), 'info');
      else if (msg.includes('ERR_TEXT_NOT_IMAGE')) flash(t('ocr.clipTextOnly'), 'info');
      else if (msg.includes('ERR_NO_IMG_FILE')) flash(t('ocr.clipNoImgFile'), 'error');
      else if (msg.includes('ERR_BAD_IMG_FILE')) flash(t('ocr.clipBadImgFile'), 'error');
      else if (msg.includes('ERR_ZERO_SIZE')) flash(t('ocr.clipZero'), 'error');
      else if (msg.includes('没有图片') || /no image/i.test(msg)) flash(t('ocr.clipEmptyNeutral'), 'info');
      else flash(t('ocr.clipFailed', { msg }), 'error');
    } finally {
      ocrClipBusyRef.current = false;
      setOcrClipBusy(false);
    }
  };

  // 选区 OCR
  const onRegionOcr = (dataUrl: string) => {
    setOcrRegionMode(false);
    runOcr(dataUrl);
  };

  // 贴回标注
  const applyOcrAsAnnotations = () => {
    if (!ocrResult || !current) return;
    const W = current.width, H = current.height;
    if (!W || !H || W <= 0 || H <= 0) { flash(t('ocr.appliedZero'), 'error'); return; }
    let n = 0;
    ocrIncludedLines().forEach(({ b, i }) => {
      const txt = (ocrTextAt(i, b) || '').trim();
      if (!txt) return;
      const px = Math.max(0, Math.round(b.x * W));
      const py = Math.max(0, Math.round(b.y * H));
      const fs = Math.min(240, Math.max(10, Math.round(b.h * H)));
      addAnnotation({
        id: genAnnoId(),
        geometry: {
          type: 'text', points: [{ x: px, y: py }], text: txt, fontSize: fs,
          fontFamily: currentFontFamily, bold: currentBold, italic: currentItalic,
          align: 'left', bg: currentTextBg, bgColor: currentBgColor,
          bgOpacity: currentBgOpacity, stroke: currentTextStroke,
        },
        layerId: 'default', color: currentColor, lineWidth: currentStrokeWidth, opacity: 1, properties: {},
      });
      n += 1;
    });
    setOcrResult(null);
    if (n > 0) flash(t('ocr.applied', { n }), 'success');
  };

  // 选区→打码
  const redactOcrSel = () => {
    if (!ocrResult || !current) return;
    const sel = ocrSelectedBlocks();
    if (!sel.length) { flash(t('ocr.selNeeded'), 'error'); return; }
    const W = current.width, H = current.height;
    if (!W || !H || W <= 0 || H <= 0) { flash(t('ocr.appliedZero'), 'error'); return; }
    let n = 0;
    sel.forEach(({ b }) => {
      const x = Math.max(0, Math.round(b.x * W));
      const y = Math.max(0, Math.round(b.y * H));
      const w = Math.max(1, Math.round(b.w * W));
      const h = Math.max(1, Math.round(b.h * H));
      addAnnotation({
        id: genAnnoId(),
        geometry: { type: 'mosaic', points: [{ x, y }, { x: x + w, y: y + h }], maskMode: 'brush', solid: true, brushSize: Math.max(8, Math.round(w / 2)), blur: false, strength: 12 },
        layerId: 'default', color: currentColor, lineWidth: currentStrokeWidth, opacity: 1, properties: {},
      });
      canvasRef.current?.flashRegion({ x, y, w, h }, undefined, 'redact');
      n += 1;
    });
    if (n > 0) flash(t('ocr.redacted', { n }), 'success');
  };

  // 选区→高亮
  const highlightOcrSel = () => {
    if (!ocrResult || !current) return;
    const sel = ocrSelectedBlocks();
    if (!sel.length) { flash(t('ocr.selNeeded'), 'error'); return; }
    const W = current.width, H = current.height;
    if (!W || !H || W <= 0 || H <= 0) { flash(t('ocr.appliedZero'), 'error'); return; }
    let n = 0;
    const hl = '#FFE600';
    sel.forEach(({ b }) => {
      const x = Math.max(0, Math.round(b.x * W));
      const y = Math.max(0, Math.round(b.y * H));
      const w = Math.max(1, Math.round(b.w * W));
      const h = Math.max(1, Math.round(b.h * H));
      addAnnotation({
        id: genAnnoId(),
        geometry: { type: 'highlight', points: [{ x, y }, { x: x + w, y: y + h }] },
        layerId: 'default', color: hl, lineWidth: currentStrokeWidth, opacity: 0.45, properties: {},
      });
      canvasRef.current?.flashRegion({ x, y, w, h }, hl, 'highlight');
      n += 1;
    });
    if (n > 0) flash(t('ocr.highlighted', { n }), 'success');
  };

  // 选区→箭头
  const arrowOcrSel = () => {
    if (!ocrResult || !current) return;
    const sel = ocrSelectedBlocks();
    if (!sel.length) { flash(t('ocr.selNeeded'), 'error'); return; }
    const W = current.width, H = current.height;
    if (!W || !H || W <= 0 || H <= 0) { flash(t('ocr.appliedZero'), 'error'); return; }
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    sel.forEach(({ b }) => {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    });
    const tx = ((minX + maxX) / 2) * W;
    const ty = ((minY + maxY) / 2) * H;
    const fx = Math.max(0, minX - 0.12) * W;
    const fy = ty;
    addAnnotation({
      id: genAnnoId(),
      geometry: { type: 'arrow', points: [{ x: fx, y: fy }, { x: tx, y: ty }] },
      layerId: 'default', color: '#0a84ff', lineWidth: currentStrokeWidth, opacity: 1, properties: {},
    });
    canvasRef.current?.flashRegion({ x: minX * W, y: minY * H, w: (maxX - minX) * W, h: (maxY - minY) * H }, '#0a84ff', 'arrow');
    flash(t('ocr.arrowed', { n: sel.length }), 'success');
  };

  // 预览框拖拽
  const ocrPct = (e: React.MouseEvent): { x: number; y: number } => {
    const wrap = ocrWrapRef.current;
    if (!wrap) return { x: 0, y: 0 };
    const r = wrap.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    return { x: Math.min(100, Math.max(0, x)), y: Math.min(100, Math.max(0, y)) };
  };
  const onPreviewDown = (e: React.MouseEvent) => {
    if (!ocrRegionPick) return;
    const p = ocrPct(e);
    ocrDragStart.current = p;
    setOcrDrag({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onPreviewMove = (e: React.MouseEvent) => {
    const s = ocrDragStart.current;
    if (!s) return;
    const p = ocrPct(e);
    setOcrDrag({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const onPreviewUp = () => {
    const s = ocrDragStart.current;
    const d = ocrDrag;
    ocrDragStart.current = null;
    setOcrDrag(null);
    if (!s || !d || d.w < 2 || d.h < 2) return;
    if (!ocrResult) return;
    const sel: Record<number, boolean> = {};
    ocrResult.blocks.forEach((b, i) => {
      if (b.x < d.x + d.w && b.x + b.w > d.x && b.y < d.y + d.h && b.y + b.h > d.y) sel[i] = true;
    });
    setOcrSel(sel);
    setOcrRegionPick(false);
  };

  // 结构化复制
  const copyOcrAs = async (fmt: 'json' | 'tsv') => {
    if (ocrIncludedLines().length === 0) { flash(t('ocr.exportEmpty'), 'error'); return; }
    const content = buildOcrExportContent(fmt);
    if (!content.trim()) { flash(t('ocr.exportEmpty'), 'error'); return; }
    try {
      await navigator.clipboard.writeText(content);
      flash(t('ocr.copied'), 'success');
    } catch {
      flash(t('ocr.copyFailed'), 'error');
    }
  };

  // 缩略图点击联动
  const focusOcrLine = (i: number) => {
    setOcrHoverLine(i);
    try {
      const el = document.querySelector(`[data-ocr-idx="${i}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    } catch { /* 忽略 */ }
  };

  return {
    ocrBusy, ocrResult, ocrResultRef, ocrLang, ocrRegionMode, ocrEdits,
    ocrSearch, ocrConf, ocrMerge, ocrAutoCopy, ocrElapsed, ocrHistory,
    ocrHistoryOpen, ocrLayout, ocrExportFmt, ocrExtract, ocrClean,
    ocrFontSize, ocrClipBusy, ocrSel, ocrLastImage, ocrSourceKind,
    ocrMatchIdx, ocrHoverLine, ocrRegionPick, ocrDrag,
    ocrSearchRef, ocrTextRef, ocrActiveMarkRef, ocrWrapRef,
    setOcrResult, setOcrLang, setOcrRegionMode, setOcrEdits, setOcrSearch,
    setOcrConf, setOcrMerge, setOcrAutoCopy, setOcrHistoryOpen, setOcrLayout,
    setOcrExportFmt, setOcrExtract, setOcrClean, setOcrFontSize, setOcrSel,
    setOcrMatchIdx, setOcrHoverLine, setOcrRegionPick, setOcrDrag, setOcrHistory,
    runOcr, handleOcr, handleLangChange, startOcrFromClipboard, startOcrFromShot,
    onRegionOcr, applyOcrAsAnnotations, redactOcrSel, highlightOcrSel, arrowOcrSel,
    handleExportOcr, copyOcrAs, selectOcrText, onPreviewDown, onPreviewMove, onPreviewUp,
    ocrVisibleLines, ocrIncludedLines, ocrSelectedBlocks, ocrTextAt,
    buildOcrExportContent, focusOcrLine,
  };
}
