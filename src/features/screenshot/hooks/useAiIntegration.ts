// ===== AI 集成 Hook =====
// 从 EnhancedScreenshotApp.tsx 提取的 AI 助手面板集成逻辑：
// 视觉同步、工具宿主、跨窗口桥接、编辑固化、文案回写。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { cleanOcrText } from '../../ai/ocrClean';
import {
  openAiWindow,
  pushAiContext,
  setupMainBridge,
  EVT_COMMIT,
  type AiContext,
} from '../../../ai-window/bridge';
import { createToolExecutor } from '../../ai/aiTools';
import type { AiToolHost, NormRect } from '../../ai/aiTools';
import type { OcrResult, AnnotationObject } from '../types';
import { clamp01, genAnnoId, normToPx, cropDataUrl } from '../utils/helpers';

// ── 外部依赖接口 ──
export interface AiIntegrationDeps {
  current: { dataUrl: string; width: number; height: number } | null;
  canvasRef: React.RefObject<any>;
  addAnnotation: (a: AnnotationObject) => void;
  clearAnnotations: () => void;
  annotations: any[];
  currentScreenshot: any | null;
  setCurrentScreenshot: (s: any) => void;
  currentColor: string;
  currentStrokeWidth: number;
  currentFontFamily: string;
  ocrLang: string;
  ocrResultRef: React.MutableRefObject<OcrResult | null>;
  ocrResult: OcrResult | null;
  flash: (msg: string, type?: 'success' | 'error' | 'info') => void;
  t: (key: string, vars?: Record<string, any>) => string;
  setHistory: React.Dispatch<React.SetStateAction<any[]>>;
}

export function useAiIntegration(deps: AiIntegrationDeps) {
  const {
    current, canvasRef, addAnnotation, clearAnnotations, annotations,
    currentScreenshot, setCurrentScreenshot,
    currentColor, currentStrokeWidth, currentFontFamily,
    ocrLang, ocrResultRef, ocrResult,
    flash, t, setHistory,
  } = deps;

  // ===== 状态 =====
  const [aiOpen, setAiOpen] = useState(false);
  const [aiVisionUrl, setAiVisionUrl] = useState(current?.dataUrl ?? '');
  const [aiOcrText, setAiOcrText] = useState<string>('');

  // ===== AI 文案回写 =====
  const applyAiToScreenshot = (text: string) => {
    if (!current) return;
    const W = current.width, H = current.height;
    if (!W || !H || W <= 0 || H <= 0) { flash(t('ai.applyZero'), 'error'); return; }
    const clean = (text || '').trim();
    if (!clean) return;
    const fs = Math.max(14, Math.min(24, Math.round(W / 40)));
    addAnnotation({
      id: genAnnoId(),
      geometry: {
        type: 'text', points: [{ x: 16, y: 16 }], text: clean, fontSize: fs,
        fontFamily: currentFontFamily, bold: false, italic: false, align: 'left',
        bg: true, bgColor: '#1d1d1f', bgOpacity: 0.72, stroke: false,
      },
      layerId: 'default', color: currentColor, lineWidth: currentStrokeWidth, opacity: 1, properties: {},
    });
    flash(t('ai.applied'), 'success');
  };

  // ===== 视觉同步 =====
  const refreshAiVision = useCallback(async () => {
    const fallback = current?.dataUrl ?? '';
    const rawOcr = ocrResultRef.current?.text ?? '';
    try {
      const merged = canvasRef.current ? await canvasRef.current.getMergedImageDataUrl() : null;
      const visionUrl = merged || fallback;
      setAiVisionUrl(visionUrl);
      if (merged && merged !== fallback) {
        try {
          const res = await invoke<OcrResult>('ocr_image', { imageData: merged, lang: ocrLang === 'auto' ? null : ocrLang });
          const cleanedText = cleanOcrText(res?.text);
          setAiOcrText(cleanedText || rawOcr);
        } catch { setAiOcrText(rawOcr); }
      } else {
        setAiOcrText(rawOcr);
      }
    } catch {
      setAiVisionUrl(fallback);
      setAiOcrText(rawOcr);
    }
  }, [current?.dataUrl, ocrLang]);

  // ===== 打码产物提示 refs =====
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const redactCountRef = useRef(0);
  const redactTimerRef = useRef<number | null>(null);
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;

  // ===== 工具宿主 =====
  const currentColorRef = useRef(currentColor);
  const currentStrokeWidthRef = useRef(currentStrokeWidth);
  const currentFontFamilyRef = useRef(currentFontFamily);
  useEffect(() => { currentColorRef.current = currentColor; }, [currentColor]);
  useEffect(() => { currentStrokeWidthRef.current = currentStrokeWidth; }, [currentStrokeWidth]);
  useEffect(() => { currentFontFamilyRef.current = currentFontFamily; }, [currentFontFamily]);

  const aiTools: AiToolHost = useMemo(
    () => ({
      getImageSize: () =>
        current?.width && current?.height ? { width: current.width, height: current.height } : null,
      drawRectangle: (r, opts) => {
        const W = current?.width ?? 0, H = current?.height ?? 0;
        if (!W || !H) return '(无图)';
        const { x, y, w, h } = normToPx(r, W, H);
        addAnnotation({
          id: genAnnoId(),
          geometry: { type: 'rectangle', points: [{ x, y }, { x: x + w, y: y + h }] },
          layerId: 'default', color: opts?.color || currentColorRef.current,
          lineWidth: currentStrokeWidthRef.current, opacity: 1, properties: {},
        });
        if (opts?.label) {
          addAnnotation({
            id: genAnnoId(),
            geometry: {
              type: 'text', points: [{ x, y: Math.max(0, y - 18) }], text: opts.label,
              fontSize: Math.max(12, Math.round(H / 45)), fontFamily: currentFontFamilyRef.current,
              bold: false, italic: false, align: 'left', bg: true, bgColor: '#1d1d1f', bgOpacity: 0.78, stroke: false,
            },
            layerId: 'default', color: opts?.color || currentColorRef.current, lineWidth: 1, opacity: 1, properties: {},
          });
        }
        canvasRef.current?.flashRegion({ x, y, w, h }, opts?.color || currentColorRef.current, 'rect');
        return `(${x},${y})-(${x + w},${y + h})`;
      },
      redactArea: (r, mode, strength) => {
        const W = current?.width ?? 0, H = current?.height ?? 0;
        if (!W || !H) return '(无图)';
        const { x, y, w, h } = normToPx(r, W, H);
        const s = Math.max(1, Math.min(20, Number(strength) || 12));
        const geom: AnnotationObject['geometry'] =
          mode === 'black'
            ? { type: 'mosaic', points: [{ x, y }, { x: x + w, y: y + h }], maskMode: 'brush', solid: true, brushSize: Math.max(8, Math.round(w / 2)), blur: false, strength: s }
            : { type: 'mosaic', points: [{ x, y }, { x: x + w, y: y + h }], blur: mode === 'blur', strength: s };
        addAnnotation({
          id: genAnnoId(), geometry: geom, layerId: 'default',
          color: mode === 'black' ? '#000000' : currentColor,
          lineWidth: currentStrokeWidthRef.current, opacity: 1, properties: {},
        });
        canvasRef.current?.flashRegion({ x, y, w, h }, undefined, 'redact');
        redactCountRef.current += 1;
        if (redactTimerRef.current) window.clearTimeout(redactTimerRef.current);
        redactTimerRef.current = window.setTimeout(() => {
          const n = redactCountRef.current;
          redactCountRef.current = 0;
          flashRef.current?.(`已打码 ${n} 处，可保存 / 复制`, 'success');
        }, 700);
        return `(${x},${y})-(${x + w},${y + h})`;
      },
      highlightRect: (r, color) => {
        const W = current?.width ?? 0, H = current?.height ?? 0;
        if (!W || !H) return '(无图)';
        const { x, y, w, h } = normToPx(r, W, H);
        addAnnotation({
          id: genAnnoId(),
          geometry: { type: 'highlight', points: [{ x, y }, { x: x + w, y: y + h }] },
          layerId: 'default', color: color || '#FFE600',
          lineWidth: currentStrokeWidthRef.current, opacity: 0.45, properties: {},
        });
        canvasRef.current?.flashRegion({ x, y, w, h }, color || '#FFE600', 'highlight');
        return `(${x},${y})-(${x + w},${y + h})`;
      },
      drawArrow: (from, to, opts) => {
        const W = current?.width ?? 0, H = current?.height ?? 0;
        if (!W || !H) return '(无图)';
        const fx = clamp01(from.x) * W, fy = clamp01(from.y) * H;
        const tx = clamp01(to.x) * W, ty = clamp01(to.y) * H;
        const color = opts?.color || '#0a84ff';
        addAnnotation({
          id: genAnnoId(),
          geometry: { type: 'arrow', points: [{ x: fx, y: fy }, { x: tx, y: ty }] },
          layerId: 'default', color, lineWidth: currentStrokeWidthRef.current, opacity: 1, properties: {},
        });
        if (opts?.label) {
          addAnnotation({
            id: genAnnoId(),
            geometry: {
              type: 'text', points: [{ x: tx, y: Math.max(0, ty - 6) }], text: opts.label,
              fontSize: Math.max(12, Math.round(H / 45)), fontFamily: currentFontFamilyRef.current,
              bold: false, italic: false, align: 'left', bg: true, bgColor: '#1d1d1f', bgOpacity: 0.78, stroke: false,
            },
            layerId: 'default', color, lineWidth: 1, opacity: 1, properties: {},
          });
        }
        const bx = Math.min(fx, tx), by = Math.min(fy, ty);
        canvasRef.current?.flashRegion({ x: bx, y: by, w: Math.abs(tx - fx), h: Math.abs(ty - fy) }, color, 'arrow');
        return `(${fx.toFixed(0)},${fy.toFixed(0)})→(${tx.toFixed(0)},${ty.toFixed(0)})`;
      },
      drawCallout: (anchor, label, opts) => {
        const W = current?.width ?? 0, H = current?.height ?? 0;
        if (!W || !H) return '(无图)';
        const ax = clamp01(anchor.x) * W, ay = clamp01(anchor.y) * H;
        const lx = clamp01(label.x) * W, ly = clamp01(label.y) * H;
        const color = opts?.color || currentColorRef.current || '#0a84ff';
        addAnnotation({
          id: genAnnoId(),
          geometry: {
            type: 'callout', points: [{ x: ax, y: ay }, { x: lx, y: ly }],
            text: opts?.text || '', fontSize: 20,
            fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
            bold: false, italic: false, align: 'center', bg: true, bgColor: '#1d1d1f', bgOpacity: 0.92, stroke: true,
          },
          layerId: 'default', color, lineWidth: currentStrokeWidthRef.current, opacity: 1, properties: {},
        });
        const bw = 170, bh = 72;
        canvasRef.current?.flashRegion({ x: lx - bw / 2, y: ly - bh / 2, w: bw, h: bh }, color, 'rect');
        return `锚点(${ax.toFixed(0)},${ay.toFixed(0)})→气泡(${lx.toFixed(0)},${ly.toFixed(0)}) 文字「${opts?.text || ''}」`;
      },
      summarizeRegion: async (r) => {
        const W = current?.width ?? 0, H = current?.height ?? 0;
        if (!W || !H) return '(无图)';
        const { x, y, w, h } = normToPx(r, W, H);
        const crop = await cropDataUrl(current?.dataUrl ?? '', x, y, Math.max(1, w), Math.max(1, h));
        try {
          const res = await invoke<OcrResult>('ocr_image', { imageData: crop, lang: ocrLang === 'auto' ? null : ocrLang });
          return cleanOcrText(res?.text).trim() || '(该区域未识别到文字)';
        } catch (e: any) {
          return `(识别失败：${e?.message ?? e})`;
        }
      },
    }),
    [current, addAnnotation, ocrLang],
  );

  // ===== 固化 AI 编辑产物 =====
  const commitAiEdit = useCallback(async () => {
    if (!currentScreenshot || annotationsRef.current.length === 0) return;
    const merged = canvasRef.current ? await canvasRef.current.getMergedImageDataUrl() : null;
    if (!merged) return;
    setCurrentScreenshot({ ...currentScreenshot, dataUrl: merged, updatedAt: new Date().toISOString() });
    clearAnnotations();
    flash('已固化编辑产物，可继续编辑或保存', 'success');
    try {
      const aid = `ai-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const aAt = new Date().toISOString();
      const aW = currentScreenshot.width, aH = currentScreenshot.height;
      const aEntry = { id: aid, dataUrl: merged, createdAt: aAt, width: aW, height: aH, source: 'ai_edit' as const };
      setHistory((h) => [aEntry, ...h].slice(0, 100));
      await invoke('add_history', { item: { id: aid, data_url: merged, created_at: aAt, width: aW, height: aH, source: 'ai_edit' } });
    } catch { /* 持久化失败不阻断 */ }
  }, [currentScreenshot, setCurrentScreenshot, clearAnnotations, flash, setHistory]);
  const commitAiEditRef = useRef(commitAiEdit);
  commitAiEditRef.current = commitAiEdit;

  // ===== 跨窗口桥接 =====
  const ctxRef = useRef<AiContext | null>(null);
  useEffect(() => {
    ctxRef.current = current
      ? { dataUrl: current.dataUrl, visionUrl: aiVisionUrl, ocrText: aiOcrText, width: current.width, height: current.height }
      : null;
  });

  const execTool = useMemo(() => createToolExecutor(aiTools), [aiTools]);

  useEffect(() => {
    let handles: { unlisten: (() => void)[] } | null = null;
    setupMainBridge({
      getCtx: () => ctxRef.current,
      execTool: (name, args) => execTool(name, args),
      onClosed: () => setAiOpen(false),
      onApply: (text) => applyAiToScreenshot(text),
      onRefresh: () => { void refreshAiVision(); },
      onCommit: () => commitAiEditRef.current(),
    }).then((h) => { handles = h; });
    return () => { handles?.unlisten.forEach((u) => u()); };
  }, [execTool]);

  // 推送上下文给已打开的 AI 窗口
  useEffect(() => {
    const c = ctxRef.current;
    if (aiOpen && c?.dataUrl) { void pushAiContext(c); }
  }, [aiVisionUrl, aiOcrText, current?.dataUrl]);

  // 切换截图时重置 AI 视觉
  useEffect(() => { setAiVisionUrl(current?.dataUrl ?? ''); }, [current]);
  // OCR 结果变化时同步
  useEffect(() => { setAiOcrText(ocrResult?.text ?? ''); }, [ocrResult]);

  // 打开 AI 窗口
  const openAi = async () => {
    const w = await openAiWindow(ctxRef.current);
    if (w) setAiOpen(true);
  };

  return {
    aiOpen, setAiOpen, aiVisionUrl, aiOcrText,
    refreshAiVision, commitAiEdit, applyAiToScreenshot, aiTools, openAi,
  };
}
