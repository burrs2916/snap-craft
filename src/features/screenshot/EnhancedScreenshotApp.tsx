// ===== 主应用组件（架构解耦重构版） =====
// 2026-07-24 重构：将业务逻辑提取到独立 hooks，本组件仅负责「编排 + 渲染」。
//
// 提取的 hooks：
//   useTheme        → 主题管理（light/dark/system）
//   useToast        → 通知系统（flash/revealPath）
//   useHistory      → 历史记录 CRUD + 搜索
//   usePlatform     → 平台检测 + 沙箱判断
//   useCapture      → 截图捕获编排（全屏/区域/窗口/多屏/覆盖层）
//   useFileOperations → 保存/复制/钉图
//   useOcrPanel     → OCR 面板（已有）
//   useBatchOperations → 批量操作（已有）
//   useAiIntegration → AI 集成（已有）
//   useScreenPermission → 权限管理（已有）
//   useScrollCapture → 滚动长截图（已有）

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AnnotationToolbar } from './components/AnnotationToolbar';
import AnnotationCanvas, { AnnotationCanvasHandle } from './components/AnnotationCanvas';
import { openEditorWindow, openClipboardOcrWindow } from './components/EditorWindow';
import { LanguageToggle } from '../../shared/components/LanguageToggle';
import { useScreenshotStore } from './store/screenshotStore';
import { useI18n, t } from '../../i18n';
import { useOcrPanel } from './hooks/useOcrPanel';
import { useBatchOperations } from './hooks/useBatchOperations';
import { useAiIntegration } from './hooks/useAiIntegration';
import { useScreenPermission } from './hooks/useScreenPermission';
import { useScrollCapture, type DisplayInfo } from './hooks/useScrollCapture';
import { BatchBar, BatchOcrPanel, AiBatchPanel } from './components/BatchOperations';
import { OcrPanel } from './components/OcrPanel';
import { flog } from './utils/helpers';

// ── 提取的 hooks ──
import { useTheme } from './hooks/useTheme';
import { useToast } from './hooks/useToast';
import { useHistory, type HistoryEntry } from './hooks/useHistory';
import { usePlatform } from './hooks/usePlatform';
import { useCapture } from './hooks/useCapture';
import { useFileOperations } from './hooks/useFileOperations';

/* ── 顶栏线性图标 ── */
const TBIcon = ({ d }: { d: string }) => (
  <svg
    width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" dangerouslySetInnerHTML={{ __html: d }}
  />
);
const TB_PATHS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  pin: '<path d="M9 4h6l-1 5 3 3v2h-5v5l-1 2-1-2v-5H4v-2l3-3-1-5z"/>',
  save: '<path d="M12 3v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 20h14"/>',
  ocr: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h6M7 13h10M7 17h4"/>',
} as const;

// 按真实物理位置排序显示器
const orderDisplays = (displays: DisplayInfo[]): (DisplayInfo & { label: number })[] =>
  [...displays]
    .sort((a, b) => (Math.abs(a.x - b.x) > 40 ? a.x - b.x : a.y - b.y))
    .map((d, i) => ({ ...d, label: i + 1 }));

// 多屏选择器
const DisplayPicker = ({
  displays, onPick, onCancel,
}: {
  displays: DisplayInfo[];
  onPick: (id: number | null) => void;
  onCancel: () => void;
}) => {
  const ordered = orderDisplays(displays);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ordered.forEach((d) => {
    minX = Math.min(minX, d.x); minY = Math.min(minY, d.y);
    maxX = Math.max(maxX, d.x + d.width); maxY = Math.max(maxY, d.y + d.height);
  });
  const uw = maxX - minX, uh = maxY - minY;
  return (
    <div className="permission-gate" style={{ zIndex: 60 }}>
      <div className="permission-card" style={{ maxWidth: 720 }}>
        <div className="permission-icon">🖥️</div>
        <div className="permission-title">{t('display.title')}</div>
        <div className="permission-text">{t('display.text', { n: ordered.length })}</div>
        <div className="display-picker-grid" style={{ aspectRatio: `${uw} / ${uh}`, position: 'relative', width: '100%' }}>
          {ordered.map((d) => (
            <button key={d.id} className="display-pick-card" onClick={() => onPick(d.id)}
              style={{
                left: `${((d.x - minX) / uw) * 100}%`, top: `${((d.y - minY) / uh) * 100}%`,
                width: `${(d.width / uw) * 100}%`, height: `${(d.height / uh) * 100}%`,
              }}>
              {d.is_main && <div className="display-pick-badge">{t('display.main')}</div>}
              <div className="display-pick-num">{d.label}</div>
              <div className="display-pick-res">{d.width} × {d.height}{d.scale >= 1.5 ? ' · Retina' : ''}</div>
            </button>
          ))}
        </div>
        <div className="permission-actions">
          <button className="permission-btn ghost" onClick={onCancel}>{t('display.cancel')}</button>
        </div>
      </div>
    </div>
  );
};

// 历史缩略图：滚入视口才解码
const LazyHistoryThumb = ({ dataUrl, alt }: { dataUrl: string; alt: string }) => {
  const ref = useRef<HTMLImageElement>(null);
  const [src, setSrc] = useState('');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { setSrc(dataUrl); io.disconnect(); }
      });
    });
    io.observe(el);
    return () => io.disconnect();
  }, [dataUrl]);
  return (
    <img ref={ref} src={src || undefined} alt={alt} loading="lazy"
      style={src ? undefined : { backgroundColor: 'var(--surface-strong)' }} />
  );
};

export const EnhancedScreenshotApp = () => {
  // ===== 提取的 hooks =====
  const { theme, cycleTheme, themeIcon, themeLabelKey } = useTheme();
  const { toast, toastType, revealPath, flash, setRevealPath } = useToast();
  const { platform, isSandboxed, isWinLike, modLabel, shiftLabel } = usePlatform();

  const [currentView, setCurrentView] = useState<'home' | 'edit'>('home');
  const [current, setCurrent] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const [lastShot, setLastShot] = useState<{ id: string; dataUrl: string; width: number; height: number } | null>(null);
  const resultBarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 多屏选择器状态（提升到组件级以打破 useCapture ↔ useScrollCapture 循环依赖）
  const [showDisplayPicker, setShowDisplayPicker] = useState(false);

  // 截图隐藏自身窗口：行为已固化为「永远隐藏 SnapCraft 自身窗口」（不截到自己），
  // 不再暴露开关。后端 hide_self_in_capture 默认 true 提供硬保证（见 src-tauri store）。

  // 标注 store（需在 onHistoryDeleted 之前初始化，因其依赖 currentScreenshot）
  const canvasRef = useRef<AnnotationCanvasHandle>(null);
  const {
    currentScreenshot, setCurrentScreenshot, clearAnnotations, annotations,
    activeTool, setActiveTool, addAnnotation,
    currentColor, currentFontFamily, currentBold, currentItalic,
    currentTextBg, currentBgColor, currentBgOpacity, currentTextStroke, currentStrokeWidth,
  } = useScreenshotStore();

  // 历史管理
  const onHistoryDeleted = useCallback((id: string) => {
    if (currentScreenshot?.id === id) {
      setCurrentScreenshot(null);
      setCurrent(null);
      if (currentView === 'edit') setCurrentView('home');
    }
  }, [currentScreenshot?.id, currentView, setCurrentScreenshot]);
  const history = useHistory(flash, t, onHistoryDeleted);
  const {
    history: historyList, setHistory, filteredHistory,
    historySearch, setHistorySearch, addEntry, deleteEntry, clearAll,
  } = history;

  // 截图捕获（pickerPurposeRef 与 useScrollCapture 共享）
  const pickerPurposeRef = useRef<'shot' | 'scroll'>('shot');

  // 截图后回调：解码 → 入历史 → 自动复制 → 结果条
  const onCaptured = useCallback(
    async (dataUrl: string) => {
      flog(`onCaptured 收到截图数据: dataUrl长度=${dataUrl?.length ?? 0}`);
      const { width, height } = await new Promise<{ width: number; height: number }>(
        (res, rej) => {
          const img = new Image();
          img.onload = () => res({ width: img.width, height: img.height });
          img.onerror = () => rej(new Error('截图数据解码失败'));
          img.src = dataUrl;
        },
      );
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date().toISOString();
      const entry: HistoryEntry = { id, dataUrl, createdAt, width, height, source: 'capture' };
      await addEntry(entry);
      // 自动复制到剪贴板
      try {
        await invoke('copy_to_clipboard', { imageData: dataUrl });
        flash(t('toast.doneCopied'), 'success');
      } catch { /* 自动复制失败不阻断 */ }
      // 结果条
      setLastShot({ id, dataUrl, width, height });
      if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current);
      resultBarTimerRef.current = setTimeout(() => setLastShot(null), 6000);
    },
    [addEntry, flash, t],
  );

  // ── 权限管理（无外部 hook 依赖，最先初始化） ──
  const perm = useScreenPermission({ platform, flash, t });
  const { permissionNeeded, permissionChecking, openScreenRecordingSettings, recheckPermission, ensureCapturePermission, setPermissionNeeded } = perm;

  // ── 滚动长截图（依赖 perm，需在 capture 之前初始化） ──
  // enterScrollMode 通过 ref 暴露给 useCapture，打破循环依赖
  const enterScrollModeRef = useRef<(disp: DisplayInfo) => Promise<void>>(async () => {});
  const scroll = useScrollCapture({
    platform, flash, t, ensureCapturePermission, setPermissionNeeded,
    onCaptured, setDisplays: () => {}, setShowDisplayPicker, pickerPurposeRef,
  });
  const {
    scrolling, scrollFrames, scrollBusy, scrollingRef,
    enterScrollMode, captureScrollFrame, restoreMainWindow,
    finishScrollCapture, cancelScrollCapture, startScrollCapture,
  } = scroll;
  // 保持 ref 同步（scroll 每次渲染可能产生新闭包）
  enterScrollModeRef.current = enterScrollMode;

  // ── 截图捕获（依赖 perm + scroll.enterScrollMode via ref） ──
  const capture = useCapture({
    platform, isSandboxed, flash, t,
    ensureCapturePermission: () => perm.ensureCapturePermission(),
    setPermissionNeeded: (v) => perm.setPermissionNeeded(v),
    onCaptured,
    enterScrollMode: (disp) => enterScrollModeRef.current(disp),
    pickerPurposeRef,
    showDisplayPicker, setShowDisplayPicker,
  });
  const {
    busy, displays,
    captureDelay, setCaptureDelay, countdown, doCapture, pickDisplay,
  } = capture;

  // 文件操作（setRevealPath 与 useToast 联动，保存后显示「在 Finder 中显示」按钮）
  const fileOps = useFileOperations({ flash, t, setRevealPath });
  const { copyDataUrl, saveDataUrl, pinShot } = fileOps;

  // OCR 面板
  const ocr = useOcrPanel({
    current, platform, flash, t, canvasRef, addAnnotation,
    currentScreenshot, setCurrentScreenshot, setCurrent, setCurrentView,
    history: historyList, setHistory, resultBarTimerRef, setLastShot,
  });
  const {
    ocrBusy, ocrResult, ocrResultRef, ocrLang, ocrRegionMode,
    ocrClipBusy, ocrLastImage, ocrSourceKind,
    setOcrResult, setOcrRegionMode, runOcr, handleOcr,
    startOcrFromClipboard, startOcrFromShot, onRegionOcr,
  } = ocr;

  // 批量操作
  const batch = useBatchOperations({ history: historyList, flash, t });
  const { selMode, setSelMode, selIds, toggleSel, selectAll, clearSel, showBatch, setShowBatch, showAiBatch, setShowAiBatch } = batch;

  // AI 集成
  const ai = useAiIntegration({
    current, canvasRef, addAnnotation, clearAnnotations, annotations,
    currentScreenshot, setCurrentScreenshot,
    currentColor, currentStrokeWidth, currentFontFamily,
    ocrLang, ocrResultRef, ocrResult,
    flash, t, setHistory,
  });
  const { aiOpen, setAiOpen, aiVisionUrl, aiOcrText, refreshAiVision, commitAiEdit, applyAiToScreenshot, openAi } = ai;

  // 国际化
  useI18n();

  // 前端构建模式
  const isDev = (import.meta as any).env?.DEV === true;

  // ===== 编辑器操作 =====
  const openEditor = useCallback(
    (shot: { id: string; dataUrl: string; width: number; height: number }) => {
      if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current);
      setLastShot(null);
      const createdAt = new Date().toISOString();
      setCurrent({ dataUrl: shot.dataUrl, width: shot.width, height: shot.height });
      setCurrentScreenshot({
        id: shot.id, filePath: '', dataUrl: shot.dataUrl,
        width: shot.width, height: shot.height,
        annotations: [], layers: [], createdAt, updatedAt: createdAt,
      });
      clearAnnotations();
      setCurrentView('edit');
    },
    [setCurrentScreenshot, clearAnnotations],
  );

  const onCropped = useCallback(
    (dataUrl: string, width: number, height: number) => {
      const id = `${Date.now()}-crop`;
      const createdAt = new Date().toISOString();
      setCurrent({ dataUrl, width, height });
      setCurrentScreenshot({
        id, filePath: '', dataUrl, width, height,
        annotations: [], layers: [], createdAt, updatedAt: createdAt,
      });
      clearAnnotations();
      setActiveTool('select');
      flash(t('crop.done'), 'success');
    },
    [setCurrentScreenshot, clearAnnotations, setActiveTool, flash, t],
  );

  // 保存/复制时合并标注
  const getExportDataUrl = async (): Promise<string> => {
    if (annotations.length > 0 && canvasRef.current) {
      const merged = await canvasRef.current.getMergedImageDataUrl();
      if (merged) return merged;
    }
    return current!.dataUrl;
  };

  const handleSave = async () => {
    if (!current) return;
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      defaultPath: `snapcraft-${Date.now()}.png`,
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (!path) return;
    try {
      await invoke('save_screenshot', { imageData: await getExportDataUrl(), filePath: path });
      flash(t('toast.savedWithReveal', { path }), 'success', 5000);
    } catch (e) {
      flash(t('toast.saveFailed', { msg: String(e) }), 'error');
    }
  };

  const handleCopy = async () => {
    if (!current) return;
    try {
      await invoke('copy_to_clipboard', { imageData: await getExportDataUrl() });
      flash(t('toast.copied'), 'success');
    } catch (e) {
      flash(t('toast.copyFailed', { msg: String(e) }), 'error');
    }
  };

  // ===== 全局快捷键监听 =====
  useEffect(() => {
    const un: Promise<UnlistenFn>[] = [
      listen('capture-screen', () => doCapture('screen')),
      listen('capture-region', () => doCapture('region')),
      listen('capture-window', () => doCapture('window')),
      listen('shortcut-register-failed', (e) => { flash(String(e.payload), 'error'); }),
    ];
    return () => { un.forEach((p) => p.then((fn) => fn()).catch(() => {})); };
  }, [doCapture, flash]);

  // 滚动长截图：全局快捷键「捕获下一帧」
  const captureScrollFrameRef = useRef(captureScrollFrame);
  useEffect(() => { captureScrollFrameRef.current = captureScrollFrame; }, [captureScrollFrame]);
  useEffect(() => {
    const un = listen('capture-scroll-frame', () => {
      if (scrollingRef.current) captureScrollFrameRef.current();
    });
    return () => { un.then((fn) => fn()); };
  }, []);

  // ===== 区域/窗口覆盖层事件（Windows/Linux）=====
  useEffect(() => {
    const un: Promise<UnlistenFn>[] = [
      listen('region-selected', async (e) => {
        const rect = e.payload as { x: number; y: number; width: number; height: number };
        const main = getCurrentWindow();
        try {
          const dataUrl = await invoke<string>('capture_region', { rect });
          await onCaptured(dataUrl);
          await main.show(); await main.setFocus();
        } catch (err) {
          const msg = String(err);
          if (msg.includes('取消') || msg.toLowerCase().includes('cancel')) flash(t('toast.cancelled'), 'success');
          else flash(t('toast.captureFailed', { msg }), 'error');
          try { await main.show(); await main.setFocus(); } catch { /* ignore */ }
        }
      }),
      listen('region-cancelled', async () => {
        const main = getCurrentWindow();
        try { await main.show(); await main.setFocus(); } catch { /* ignore */ }
      }),
      listen('window-picked', async (e) => {
        const { windowId } = e.payload as { windowId: number };
        const main = getCurrentWindow();
        try {
          const dataUrl = await invoke<string>('capture_window_by_id', { windowId });
          await onCaptured(dataUrl);
          await main.show(); await main.setFocus();
        } catch (err) {
          const msg = String(err);
          if (msg.includes('取消') || msg.toLowerCase().includes('cancel')) flash(t('toast.cancelled'), 'success');
          else flash(t('toast.captureFailed', { msg }), 'error');
          try { await main.show(); await main.setFocus(); } catch { /* ignore */ }
        }
      }),
      listen('window-cancelled', async () => {
        const main = getCurrentWindow();
        try { await main.show(); await main.setFocus(); } catch { /* ignore */ }
      }),
    ];
    return () => { un.forEach((p) => p.then((fn) => fn()).catch(() => {})); };
  }, [onCaptured, flash, t]);

  // ===== 编辑视图快捷键 =====
  useEffect(() => {
    if (currentView !== 'edit') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); handleSave(); }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        const sel = window.getSelection();
        if (!sel || sel.toString().length === 0) { e.preventDefault(); handleCopy(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentView, current, annotations]);

  // ===== 编辑视图 =====
  if (currentView === 'edit' && current) {
    return (
      <div className="editor-view">
        <div className="editor-toolbar">
          <div className="toolbar-left">
            <button className="tbar-btn tbar-ghost back-btn" onClick={() => { setCurrent(null); setCurrentView('home'); }}>
              <TBIcon d={TB_PATHS.back} />{t('editor.back')}
            </button>
            <div className="editor-info">
              <span className="editor-info-dim">{current.width} × {current.height}</span>
              <span className="editor-info-sep">·</span>
              <span>{t('editor.annotations', { n: annotations.length })}</span>
            </div>
          </div>
          <AnnotationToolbar />
          <div className="toolbar-right">
            <button className="tbar-icon-btn" title={t('editor.themeTitle', { label: t(themeLabelKey) })} onClick={cycleTheme}>{themeIcon}</button>
            <div className="tbar-divider" />
            <button className="tbar-btn tbar-ghost" onClick={handleOcr} disabled={ocrBusy || ocrRegionMode} title={t('editor.ocrTitle')}>
              <TBIcon d={TB_PATHS.ocr} />{ocrBusy ? t('editor.ocrBusy') : t('editor.ocr')}
            </button>
            <button className={`tbar-btn tbar-ghost${ocrRegionMode ? ' active' : ''}`} onClick={() => setOcrRegionMode((v) => !v)} disabled={ocrBusy} title={t('ocr.regionTitle')}>
              <TBIcon d={TB_PATHS.ocr} />{t('ocr.region')}
            </button>
            <button className="tbar-btn tbar-ghost" onClick={() => openClipboardOcrWindow()} disabled={ocrBusy} title={t('ocr.clipTitle')}>📋 {t('ocr.clipboard')}</button>
            <button className={`tbar-btn tbar-ghost${aiOpen ? ' active' : ''}`} onClick={async () => { await openAi(); }} disabled={!current} title={t('ai.openAi')}>✨ AI</button>
            <button className="tbar-btn tbar-ghost" onClick={handleCopy} title={t('editor.copyTitle', { mod: modLabel })}>
              <TBIcon d={TB_PATHS.copy} />{t('editor.copy')}
            </button>
            {currentScreenshot && (
              <button className="tbar-btn tbar-ghost" onClick={() => pinShot({ id: currentScreenshot.id, dataUrl: current.dataUrl, width: current.width, height: current.height })} title={t('editor.pinTitle')}>
                <TBIcon d={TB_PATHS.pin} />{t('editor.pin')}
              </button>
            )}
            <button className="tbar-btn tbar-primary save-btn" onClick={handleSave} title={t('editor.saveTitle', { mod: modLabel })}>
              <TBIcon d={TB_PATHS.save} />{t('editor.save')}
            </button>
          </div>
        </div>
        <div className="editor-canvas-area">
          <div className="editor-canvas">
            <AnnotationCanvas ref={canvasRef} imageData={current.dataUrl} annotations={annotations}
              onAnnotationAdd={addAnnotation} activeTool={activeTool} onCropped={onCropped}
              ocrRegionMode={ocrRegionMode} onRegionOcr={onRegionOcr} />
            {ocrRegionMode && (
              <div className="ocr-region-hint">
                <span>{t('ocr.regionHint')}</span>
                <button className="tbar-btn tbar-ghost" onClick={() => setOcrRegionMode(false)}>{t('ocr.regionCancel')}</button>
              </div>
            )}
          </div>
        </div>
        {toast && (
          <div className={`toast toast-${toastType}`}>
            <span className="toast-icon">{toastType === 'error' ? '!' : toastType === 'info' ? 'ℹ' : '✓'}</span>
            <span className="toast-msg">{toast}</span>
            {revealPath && (
              <button className="toast-reveal-btn" onClick={() => invoke('reveal_in_folder', { path: revealPath })} title={t('toast.revealTitle')}>{t('toast.reveal')}</button>
            )}
          </div>
        )}
        <OcrPanel ocr={ocr} current={current} flash={flash} t={t} history={historyList} setCurrentScreenshot={setCurrentScreenshot} />
      </div>
    );
  }

  // ===== 滚动长截图控制条 =====
  if (scrolling) {
    return (
      <div className="scroll-ctrl" data-tauri-drag-region>
        <div className="scroll-ctrl-head">
          <span className="scroll-ctrl-dot" />
          <span className="scroll-ctrl-title">{t('scroll.title')}</span>
          <span className="scroll-ctrl-count">{t('scroll.frames', { n: scrollFrames.length })}</span>
        </div>
        <div className="scroll-ctrl-hint">
          {t('scroll.hintPrefix')} <kbd className="kbd">{modLabel}</kbd><kbd className="kbd">{shiftLabel}</kbd><kbd className="kbd">4</kbd> {t('scroll.hintSuffix')}
        </div>
        <div className="scroll-ctrl-actions">
          <button className="scroll-ctrl-btn primary" onClick={captureScrollFrame} disabled={scrollBusy}>
            {scrollBusy ? t('scroll.captureBusy') : t('scroll.capture')}
          </button>
          <button className="scroll-ctrl-btn" onClick={finishScrollCapture} disabled={scrollBusy || scrollFrames.length === 0}>{t('scroll.finish')}</button>
          <button className="scroll-ctrl-btn ghost" onClick={cancelScrollCapture} disabled={scrollBusy}>{t('scroll.cancel')}</button>
        </div>
        {toast && (
          <div className={`toast toast-${toastType} scroll-ctrl-toast`}><span className="toast-msg">{toast}</span></div>
        )}
      </div>
    );
  }

  // ===== 主页视图 =====
  return (
    <div className="screenshot-app">
      <div className="topbar">
        <button className="theme-toggle" title={t('editor.themeTitle', { label: t(themeLabelKey) })} onClick={cycleTheme}>{themeIcon}</button>
        <LanguageToggle />
      </div>

      <div className="home-view">
        <div style={{ textAlign: 'center' }}>
          <div className="app-title">SnapCraft</div>
          <div className="app-subtitle">{t('app.subtitle')}</div>
        </div>

        <div className="capture-actions">
          {([
            { kind: 'screen' as const, icon: '🖥️', labelKey: 'capture.screen.label', descKey: 'capture.screen.desc', ariaKey: 'capture.screen.aria', key: 'S' },
            { kind: 'region' as const, icon: '✂️', labelKey: 'capture.region.label', descKey: 'capture.region.desc', ariaKey: 'capture.region.aria', key: '2' },
            { kind: 'window' as const, icon: '🪟', labelKey: 'capture.window.label', descKey: 'capture.window.desc', ariaKey: 'capture.window.aria', key: '3' },
          ]).map((c) => (
            <div key={c.kind} className="capture-card" role="button" tabIndex={0} aria-label={t(c.ariaKey)}
              onClick={() => doCapture(c.kind)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doCapture(c.kind); } }}>
              <div className="capture-card-icon">{c.icon}</div>
              <div className="capture-card-label">{t(c.labelKey)}</div>
              <div className="capture-card-desc">
                <div className="capture-card-keys"><kbd className="kbd">{modLabel}</kbd><kbd className="kbd">{shiftLabel}</kbd><kbd className="kbd">{c.key}</kbd></div>
                <span className="capture-card-desc-text">{t(c.descKey)}</span>
              </div>
            </div>
          ))}
          <div className="capture-card" role="button" tabIndex={0} aria-label={t('capture.scroll.aria')}
            onClick={startScrollCapture}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startScrollCapture(); } }}>
            <div className="capture-card-icon">📜</div>
            <div className="capture-card-label">{t('capture.scroll.label')}</div>
            <div className="capture-card-desc">
              <div className="capture-card-keys"><kbd className="kbd">{modLabel}</kbd><kbd className="kbd">{shiftLabel}</kbd><kbd className="kbd">4</kbd></div>
              <span className="capture-card-desc-text">{t('capture.scroll.desc')}</span>
            </div>
          </div>
        </div>

        <div className="home-secondary">
          <button className="home-sec-btn" onClick={() => openClipboardOcrWindow()} disabled={ocrBusy} title={t('ocr.clipTitle')}>📋 {t('ocr.clipboard')}</button>
        </div>

        <div className="delay-bar" role="group" aria-label={t('home.delayLabel')}>
          <span className="delay-bar-label">⏱ {t('home.delayLabel')}</span>
          {[0, 3, 5].map((s) => (
            <button key={s} className={`delay-chip${captureDelay === s ? ' active' : ''}`} aria-pressed={captureDelay === s}
              onClick={() => setCaptureDelay(s)} title={s === 0 ? t('home.delayTitleOff') : t('home.delayTitleWait', { s })}>
              {s === 0 ? t('home.delayOff') : `${s}s`}
            </button>
          ))}
          <span className="delay-bar-hint">{t('home.delayOnlyFull')}</span>
        </div>

        {displays.length > 1 && <div className="multi-display-hint">{t('home.multiDisplay', { n: displays.length })}</div>}

        <div className="history-section">
          <div className="history-title">
            <span>📸</span><span>{t('history.title')}</span>
            {historyList.length > 0 && (
              <>
                <button className="history-clear-btn" onClick={() => clearAll(t('history.clearConfirm'))} title={t('history.clearTitle')}>{t('history.clear')}</button>
                <button className="history-sel-btn" onClick={() => (selMode ? clearSel() : setSelMode(true))} title={t('history.selectTitle')}>
                  {selMode ? t('history.selectDone') : t('history.select')}
                </button>
                {selMode && <button className="history-sel-btn" onClick={selectAll} title={t('history.selectAllTitle')}>{t('history.selectAll')}</button>}
              </>
            )}
          </div>
          <div className="history-search-row">
            <input className="history-search-input" type="search" value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} placeholder={t('history.searchPlaceholder')} />
            {historySearch && <button className="history-search-clear" onClick={() => setHistorySearch('')} title={t('history.clear')}>✕</button>}
          </div>

          {historyList.length === 0 ? (
            <div className="empty-history"><div className="empty-history-icon">📷</div><div className="empty-history-text">{t('history.empty')}</div></div>
          ) : filteredHistory.length === 0 ? (
            <div className="empty-history"><div className="empty-history-icon">🔍</div><div className="empty-history-text">{t('history.noMatch')}</div></div>
          ) : (
            <div className="history-grid">
              {filteredHistory.map((h) => (
                <div key={h.id} className={`history-item${selMode ? ' selecting' : ''}${selIds.includes(h.id) ? ' selected' : ''}`}
                  role="button" tabIndex={0} aria-label={t('history.viewAria', { time: new Date(h.createdAt).toLocaleString() })}
                  onClick={() => (selMode ? toggleSel(h.id) : openEditorWindow({ id: h.id, width: h.width, height: h.height }))}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selMode ? toggleSel(h.id) : openEditorWindow({ id: h.id, width: h.width, height: h.height }); } }}>
                  {selMode && (
                    <div className="history-item-check" onClick={(e) => { e.stopPropagation(); toggleSel(h.id); }}>
                      <input type="checkbox" checked={selIds.includes(h.id)} readOnly />
                    </div>
                  )}
                  <LazyHistoryThumb dataUrl={h.dataUrl} alt="screenshot" />
                  {h.source === 'clipboard' && <span className="history-item-badge" title={t('history.clipboardSourceTitle')}>📋 {t('history.clipboardSource')}</span>}
                  <div className="history-item-overlay"><span>{new Date(h.createdAt).toLocaleString()}</span></div>
                  <div className="history-item-actions">
                    <button className="history-act-btn" title={t('history.copyTitle')} aria-label={t('history.copyAria')} onClick={(e) => { e.stopPropagation(); copyDataUrl(h.dataUrl); }}>📋</button>
                    <button className="history-act-btn" title={t('history.ocrTitle')} aria-label={t('history.ocrAria')} onClick={(e) => { e.stopPropagation(); startOcrFromShot(h); }}>🔍</button>
                    <button className="history-act-btn" title={t('history.saveTitle')} aria-label={t('history.saveAria')} onClick={(e) => { e.stopPropagation(); saveDataUrl(h.dataUrl); }}>💾</button>
                    <button className="history-act-btn" title={t('history.pinTitle')} aria-label={t('history.pinAria')} onClick={(e) => { e.stopPropagation(); pinShot(h); }}>📌</button>
                    <button className="history-act-btn danger" title={t('history.deleteTitle')} aria-label={t('history.deleteAria')} onClick={(e) => { e.stopPropagation(); deleteEntry(h.id); }}>🗑</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {selMode && selIds.length > 0 && <BatchBar batch={batch} t={t} />}
        </div>
      </div>

      <BatchOcrPanel batch={batch} flash={flash} t={t} />
      <AiBatchPanel batch={batch} flash={flash} t={t} />

      {showDisplayPicker && displays.length > 1 && (
        <DisplayPicker displays={displays} onPick={pickDisplay} onCancel={() => setShowDisplayPicker(false)} />
      )}

      {lastShot && (
        <div className="result-bar" role="dialog" aria-label={t('result.aria')}>
          <img className="result-bar-thumb" src={lastShot.dataUrl} alt={t('result.thumbAlt')} />
          <div className="result-bar-info">
            <div className="result-bar-title">{t('result.title')}</div>
            <div className="result-bar-sub">{t('result.sub', { w: lastShot.width, h: lastShot.height })}</div>
          </div>
          <div className="result-bar-actions">
            <button className="result-bar-btn" title={t('result.copyTitle')} onClick={() => copyDataUrl(lastShot.dataUrl)}>📋 {t('result.copy')}</button>
            <button className="result-bar-btn" title={t('result.ocrTitle')} onClick={() => startOcrFromShot(lastShot)}>🔍 {t('result.ocr')}</button>
            <button className="result-bar-btn" title={t('result.editTitle')} onClick={() => { if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current); setLastShot(null); openEditorWindow({ id: lastShot.id, width: lastShot.width, height: lastShot.height }); }}>✏️ {t('result.edit')}</button>
            <button className="result-bar-btn" title={t('result.saveTitle')} onClick={() => saveDataUrl(lastShot.dataUrl)}>💾 {t('result.save')}</button>
            <button className="result-bar-btn" title={t('result.pinTitle')} onClick={() => pinShot(lastShot)}>📌 {t('result.pin')}</button>
          </div>
          <button className="result-bar-close" title={t('result.close')} aria-label={t('result.close')}
            onClick={() => { if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current); setLastShot(null); }}>✕</button>
        </div>
      )}

      {countdown !== null && (
        <div className="countdown-overlay" aria-live="assertive">
          <div className="countdown-num">{countdown}</div>
          <div className="countdown-text">{t('countdown.text')}</div>
        </div>
      )}

      {busy && countdown === null && (
        <div className="capturing-overlay">
          <div style={{ fontSize: '64px' }}>📷</div>
          <div className="capturing-text">{t('capturing.text')}</div>
        </div>
      )}

      {toast && (
        <div className={`toast toast-${toastType}`}>
          <span className="toast-icon">{toastType === 'error' ? '!' : toastType === 'info' ? 'ℹ' : '✓'}</span>
          <span className="toast-msg">{toast}</span>
          {revealPath && (
            <button className="toast-reveal-btn" onClick={() => invoke('reveal_in_folder', { path: revealPath })} title={t('toast.revealTitle')}>{t('toast.reveal')}</button>
          )}
        </div>
      )}

      {permissionNeeded && (
        <div className="permission-gate">
          <div className="permission-card">
            <div className="permission-icon">📸</div>
            <div className="permission-title">{t('permission.title')}</div>
            <div className="permission-text">
              {isDev ? (
                <>{t('permission.dev1')}<b>{t('permission.devBadge')}</b>{t('permission.dev2')}<b>{t('permission.devBrand')}</b>{t('permission.dev3')}</>
              ) : (
                <>{t('permission.normal1')}<b>SnapCraft</b>{t('permission.normal2')}</>
              )}
            </div>
            <div className="permission-actions">
              <button className="permission-btn" onClick={openScreenRecordingSettings}>{t('permission.openSettings')}</button>
              <button className="permission-btn" onClick={recheckPermission} disabled={permissionChecking}>
                {permissionChecking ? t('permission.refreshing') : t('permission.refresh')}
              </button>
              <button className="permission-btn ghost" onClick={() => setPermissionNeeded(false)}>{t('permission.later')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EnhancedScreenshotApp;
