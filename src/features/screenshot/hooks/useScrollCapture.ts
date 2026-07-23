// ===== 滚动长截图 Hook =====
// 从 EnhancedScreenshotApp.tsx 提取的滚动捕获子系统：
// 进入滚动态 → 逐帧捕获 → 智能拼接 → 退出。

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize, LogicalPosition } from '@tauri-apps/api/window';
import { stitchFrames, loadImage, type StitchFrame } from '../utils/stitch';

export interface DisplayInfo {
  id: number;
  is_main: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface UseScrollCaptureDeps {
  platform: string;
  flash: (msg: string, type?: 'success' | 'error' | 'info') => void;
  t: (key: string, vars?: Record<string, any>) => string;
  ensureCapturePermission: () => Promise<boolean>;
  setPermissionNeeded: (v: boolean) => void;
  onCaptured: (dataUrl: string) => Promise<void>;
  setDisplays: (d: DisplayInfo[]) => void;
  setShowDisplayPicker: (v: boolean) => void;
  pickerPurposeRef: React.MutableRefObject<string>;
}

export function useScrollCapture(deps: UseScrollCaptureDeps) {
  const {
    platform, flash, t, ensureCapturePermission, setPermissionNeeded,
    onCaptured, setDisplays, setShowDisplayPicker, pickerPurposeRef,
  } = deps;

  const [scrolling, setScrolling] = useState(false);
  const [scrollFrames, setScrollFrames] = useState<string[]>([]);
  const [scrollBusy, setScrollBusy] = useState(false);
  const scrollRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const preScrollWinRef = useRef<{ w: number; h: number; x: number; y: number } | null>(null);
  const scrollBusyRef = useRef(false);
  const scrollingRef = useRef(false);
  useEffect(() => { scrollingRef.current = scrolling; }, [scrolling]);

  // 进入滚动捕获态
  const enterScrollMode = useCallback(async (disp: DisplayInfo) => {
    const stripH = Math.round(disp.height * 0.78);
    scrollRectRef.current = { x: disp.x, y: disp.y, width: disp.width, height: stripH };
    setScrollFrames([]);
    setScrolling(true);
    const win = getCurrentWindow();
    try {
      const sz = await win.innerSize();
      const ps = await win.outerPosition();
      const sf = await win.scaleFactor();
      preScrollWinRef.current = { w: sz.width / sf, h: sz.height / sf, x: ps.x / sf, y: ps.y / sf };
      const barW = 340, barH = 132;
      await win.setSize(new LogicalSize(barW, barH));
      const px = disp.x + disp.width - barW - 24;
      const py = disp.y + disp.height - barH - 40;
      await win.setPosition(new LogicalPosition(px, py));
      await win.setAlwaysOnTop(true);
      await win.show();
      await win.setFocus();
    } catch { /* 窗口操作失败不阻断 */ }
  }, []);

  // 捕获一帧
  const captureScrollFrame = useCallback(async () => {
    if (scrollBusyRef.current) return;
    const rect = scrollRectRef.current;
    if (!rect) return;
    scrollBusyRef.current = true;
    setScrollBusy(true);
    if (!(await ensureCapturePermission())) {
      scrollBusyRef.current = false;
      setScrollBusy(false);
      return;
    }
    try {
      const dataUrl = await invoke<string>('capture_region_fixed', { rect });
      setScrollFrames((f) => [...f, dataUrl]);
      flash(t('toast.frameCaptured'), 'success');
    } catch (e) {
      const msg = String(e);
      if (msg.includes('屏幕录制') || msg.includes('permission') || msg.includes('denied') || msg.includes('not authorized')) {
        if (platform === 'macos') {
          invoke<boolean>('check_screen_capture_access').then((ok) => { if (!ok) setPermissionNeeded(true); });
        }
      } else {
        flash(t('toast.captureFailed', { msg }), 'error');
      }
    } finally {
      scrollBusyRef.current = false;
      setScrollBusy(false);
    }
  }, [ensureCapturePermission, flash, platform, setPermissionNeeded]);

  // 恢复主窗口
  const restoreMainWindow = useCallback(async () => {
    const win = getCurrentWindow();
    try {
      await win.setAlwaysOnTop(false);
      const p = preScrollWinRef.current;
      if (p) {
        await win.setSize(new LogicalSize(p.w, p.h));
        await win.setPosition(new LogicalPosition(p.x, p.y));
      }
      await win.show();
      await win.setFocus();
    } catch { /* ignore */ }
    preScrollWinRef.current = null;
    setScrolling(false);
  }, []);

  // 完成拼接
  const finishScrollCapture = useCallback(async () => {
    const frames = scrollFrames;
    await restoreMainWindow();
    if (frames.length === 0) { flash(t('toast.noFrames'), 'error'); return; }
    if (frames.length === 1) { await onCaptured(frames[0]); return; }
    try {
      const imgs = await Promise.all(frames.map((d) => loadImage(d)));
      const sframes: StitchFrame[] = imgs.map((img) => ({ img, width: img.naturalWidth, height: img.naturalHeight }));
      const { canvas, hadLowConfidence } = stitchFrames(sframes);
      const merged = canvas.toDataURL('image/png');
      await onCaptured(merged);
      if (hadLowConfidence) flash(t('toast.stitchGap'), 'error');
      else flash(t('toast.stitched', { n: frames.length }), 'success');
    } catch (e) {
      flash(t('toast.stitchFailed', { msg: String(e) }), 'error');
    }
  }, [scrollFrames, restoreMainWindow, onCaptured, flash]);

  // 取消
  const cancelScrollCapture = useCallback(async () => {
    setScrollFrames([]);
    await restoreMainWindow();
    flash(t('toast.scrollCancelled'), 'success');
  }, [restoreMainWindow, flash]);

  // 发起滚动长截图
  const startScrollCapture = useCallback(async () => {
    if (scrolling) return;
    let disp: DisplayInfo[] = [];
    try {
      disp = await invoke<DisplayInfo[]>('list_displays');
      if (disp.length > 0) setDisplays(disp);
    } catch { /* ignore */ }
    if (disp.length > 1) {
      pickerPurposeRef.current = 'scroll';
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
      setShowDisplayPicker(true);
      return;
    }
    const only = disp[0] || { id: 0, is_main: true, x: 0, y: 0, width: 1440, height: 900, scale: 1 };
    await enterScrollMode(only);
  }, [scrolling, enterScrollMode]);

  return {
    scrolling, scrollFrames, scrollBusy, scrollingRef,
    enterScrollMode, captureScrollFrame, restoreMainWindow,
    finishScrollCapture, cancelScrollCapture, startScrollCapture,
  };
}
