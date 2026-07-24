// ===== 截图捕获编排 Hook =====
// 从 EnhancedScreenshotApp.tsx 提取的截图核心流程：
// 全屏/区域/窗口截图分流、多屏选择、覆盖层管理、安全隐藏、延时倒计时。
// 职责：只管「怎么截」，不管「截完怎么展示/编辑/AI」。

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { DisplayInfo } from './useScrollCapture';
import { detectPlatform } from '../../../shared/platform';
import { flog } from '../utils/helpers';

// ── 安全隐藏：截图前隐藏主窗口 ──
// macOS 原生全屏（绿灯/最大化）会把窗口放进独立的 Space（专属全屏空间）。
// 若此时直接 hide()，那块屏正在跑 Space 退出/过渡动画（短暂黑场），紧接着 screencapture
// 就会截到「过渡中的黑屏」。修复：hide 前若处于全屏/最大化，先退出该状态并等待过渡动画结束。
async function safeHideForCapture(win: ReturnType<typeof getCurrentWindow>): Promise<void> {
  let wasFullscreen = false;
  let wasMaximized = false;
  try { wasFullscreen = await win.isFullscreen(); } catch { /* ignore */ }
  try { wasMaximized = await win.isMaximized(); } catch { /* ignore */ }

  if (wasFullscreen) {
    // macOS 26 崩溃修复：全屏态改用 setMinimized(true) 代替 hide()
    flog(`safeHide: 窗口处于原生全屏 → minimize (避免 hide() 触发 insets crash)`);
    try { await win.minimize(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 600));
  } else if (wasMaximized) {
    flog(`safeHide: 窗口处于最大化 → 先取消最大化并等待重绘再隐藏`);
    try { await win.unmaximize(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 350));
    await win.hide();
  } else {
    await win.hide();
  }
  if (wasFullscreen) {
    await new Promise((r) => setTimeout(r, 150));
  }
}

export interface UseCaptureDeps {
  platform: string;
  isSandboxed: boolean;
  flash: (msg: string, type?: 'success' | 'error' | 'info') => void;
  t: (key: string, vars?: Record<string, any>) => string;
  ensureCapturePermission: () => Promise<boolean>;
  setPermissionNeeded: (v: boolean) => void;
  onCaptured: (dataUrl: string) => Promise<void>;
  /** 滚动长截图进入回调（多屏选择器选中后用途为 scroll 时调用） */
  enterScrollMode?: (disp: DisplayInfo) => Promise<void>;
  /** 选屏器用途 ref（与 useScrollCapture 共享，'shot' | 'scroll'） */
  pickerPurposeRef: React.MutableRefObject<'shot' | 'scroll'>;
  /** 多屏选择器可见状态（提升到父组件以打破与 useScrollCapture 的循环依赖） */
  showDisplayPicker: boolean;
  setShowDisplayPicker: (v: boolean) => void;
}

export interface UseCaptureReturn {
  busy: boolean;
  displays: DisplayInfo[];
  captureDelay: number;
  setCaptureDelay: (s: number) => void;
  countdown: number | null;
  /** 触发截图（全屏/区域/窗口） */
  doCapture: (kind: 'screen' | 'region' | 'window') => Promise<void>;
  /** 多屏选择器：用户点选某块屏后执行截图 */
  pickDisplay: (displayId: number | null) => Promise<void>;
  /** 延时倒计时 */
  runCountdown: (secs: number) => Promise<void>;
}

export function useCapture(deps: UseCaptureDeps): UseCaptureReturn {
  const {
    platform, isSandboxed, flash, t,
    ensureCapturePermission, setPermissionNeeded, onCaptured, enterScrollMode,
    pickerPurposeRef, showDisplayPicker, setShowDisplayPicker,
  } = deps;

  const [busy, setBusy] = useState(false);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [captureDelay, setCaptureDelay] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);

  const busyRef = useRef(false);
  const captureDelayRef = useRef(0);

  useEffect(() => { captureDelayRef.current = captureDelay; }, [captureDelay]);

  // 加载显示器列表
  useEffect(() => {
    if (platform === '') return;
    invoke<DisplayInfo[]>('list_displays')
      .then(setDisplays)
      .catch(() => setDisplays([]));
  }, [platform]);

  // 延时倒计时
  const runCountdown = useCallback(async (secs: number) => {
    if (secs <= 0) return;
    for (let s = secs; s > 0; s--) {
      setCountdown(s);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCountdown(null);
  }, []);

  // Windows/Linux 区域截图覆盖层
  const openRegionOverlay = useCallback(async () => {
    try {
      const existing = await WebviewWindow.getByLabel('region-overlay').catch(() => null);
      if (existing) {
        try { await existing.setFocus(); } catch { /* ignore */ }
        return;
      }
      const main = getCurrentWindow();
      await main.hide();
      const dpr = window.devicePixelRatio || 1;
      let vx = 0, vy = 0, vw = 0, vh = 0;
      try {
        const disp = await invoke<DisplayInfo[]>('list_displays');
        if (disp.length > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const d of disp) {
            minX = Math.min(minX, d.x); minY = Math.min(minY, d.y);
            maxX = Math.max(maxX, d.x + d.width); maxY = Math.max(maxY, d.y + d.height);
          }
          vx = minX; vy = minY; vw = maxX - minX; vh = maxY - minY;
        }
      } catch { /* ignore */ }
      new WebviewWindow('region-overlay', {
        url: `/#region-overlay?vx=${vx}&vy=${vy}&vw=${vw}&vh=${vh}&dpr=${dpr}`,
        x: Math.round(vx / dpr), y: Math.round(vy / dpr),
        width: Math.round(vw / dpr) || undefined, height: Math.round(vh / dpr) || undefined,
        transparent: true, decorations: false, alwaysOnTop: true,
        resizable: false, skipTaskbar: true, fullscreen: false, focus: true,
      } as any);
    } catch (e) {
      flash(t('toast.openRegionFailed', { msg: String(e) }), 'error');
      try { await getCurrentWindow().show(); } catch { /* ignore */ }
    }
  }, [flash, t]);

  // Windows/Linux 窗口截图覆盖层
  const openWindowOverlay = useCallback(async () => {
    try {
      const existing = await WebviewWindow.getByLabel('window-overlay').catch(() => null);
      if (existing) {
        try { await existing.setFocus(); } catch { /* ignore */ }
        return;
      }
      const main = getCurrentWindow();
      await main.hide();
      const dpr = window.devicePixelRatio || 1;
      let vx = 0, vy = 0, vw = 0, vh = 0;
      try {
        const disp = await invoke<DisplayInfo[]>('list_displays');
        if (disp.length > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const d of disp) {
            minX = Math.min(minX, d.x); minY = Math.min(minY, d.y);
            maxX = Math.max(maxX, d.x + d.width); maxY = Math.max(maxY, d.y + d.height);
          }
          vx = minX; vy = minY; vw = maxX - minX; vh = maxY - minY;
        }
      } catch { /* ignore */ }
      new WebviewWindow('window-overlay', {
        url: `/#window-overlay?vx=${vx}&vy=${vy}&vw=${vw}&vh=${vh}&dpr=${dpr}`,
        x: Math.round(vx / dpr), y: Math.round(vy / dpr),
        width: Math.round(vw / dpr) || undefined, height: Math.round(vh / dpr) || undefined,
        transparent: true, decorations: false, alwaysOnTop: true,
        resizable: false, skipTaskbar: true, fullscreen: false, focus: true,
      } as any);
    } catch (e) {
      flash(t('toast.openWindowFailed', { msg: String(e) }), 'error');
      try { await getCurrentWindow().show(); } catch { /* ignore */ }
    }
  }, [flash, t]);

  // 多屏选择器：用户点选后执行截图
  const pickDisplay = useCallback(
    async (displayId: number | null) => {
      setShowDisplayPicker(false);
      if (displayId === null) {
        flog(`pickDisplay: 用户取消选屏`);
        flash(t('toast.cancelled'), 'success');
        return;
      }
      const picked = displays.find((d) => d.id === displayId);
      flog(
        `pickDisplay: 用户选中显示器 id=${displayId} 用途=${pickerPurposeRef.current} ` +
        (picked
          ? `主屏=${picked.is_main} 逻辑=${picked.width}x${picked.height} scale=${picked.scale}`
          : `(未在列表找到该屏元数据)`)
      );
      // 滚动长截图用途
      if (pickerPurposeRef.current === 'scroll') {
        pickerPurposeRef.current = 'shot';
        const disp = displays.find((d) => d.id === displayId);
        if (disp && enterScrollMode) await enterScrollMode(disp);
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      if (!(await ensureCapturePermission())) {
        busyRef.current = false;
        setBusy(false);
        return;
      }
      const delay = captureDelayRef.current;
      if (delay > 0) await runCountdown(delay);
      const win = getCurrentWindow();
      await safeHideForCapture(win);
      try {
        const dataUrl = await invoke<string>('capture_screen', { displayId });
        await onCaptured(dataUrl);
      } catch (e) {
        const msg = String(e);
        if (msg.includes('屏幕录制') || msg.includes('permission') || msg.includes('denied') || msg.includes('not authorized')) {
          if (platform === 'macos') {
            invoke<boolean>('check_screen_capture_access').then((ok) => {
              if (!ok) setPermissionNeeded(true);
            });
          }
          return;
        }
        if (msg.includes('截图已取消') || msg.toLowerCase().includes('cancelled')) {
          flash(t('toast.cancelled'), 'success');
        } else {
          flash(t('toast.captureFailed', { msg }), 'error');
        }
      } finally {
        await win.show();
        await win.setFocus();
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onCaptured, flash, t, platform, setPermissionNeeded, ensureCapturePermission, runCountdown, displays, enterScrollMode],
  );

  // 核心截图流程
  const doCapture = useCallback(
    async (kind: 'screen' | 'region' | 'window') => {
      flog(`doCapture 触发: kind=${kind} platform=${platform} busy=${busyRef.current} delay=${captureDelayRef.current}`);
      if (busyRef.current) return;

      // 多显示器：全屏截图先让用户选具体显示器
      if (kind === 'screen') {
        let disp: DisplayInfo[] = [];
        try {
          disp = await invoke<DisplayInfo[]>('list_displays');
          if (disp.length > 0) setDisplays(disp);
        } catch { /* ignore */ }
        flog(`doCapture(screen): 枚举到 ${disp.length} 块显示器${disp.length > 1 ? ' → 弹出选屏器' : ' → 直接截主屏'}`);
        if (disp.length > 1) {
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
          setShowDisplayPicker(true);
          return;
        }
      }

      busyRef.current = true;
      setBusy(true);

      // 区域截图分流：macOS 走系统原生 -i；Windows/Linux 走自建覆盖层
      if (kind === 'region' && platform !== '' && (platform !== 'macos' || isSandboxed)) {
        busyRef.current = false;
        setBusy(false);
        await openRegionOverlay();
        return;
      }
      // 窗口截图分流：macOS 走系统原生 -w；Windows/Linux 走窗口点选覆盖层
      if (kind === 'window' && platform !== '' && (platform !== 'macos' || isSandboxed)) {
        busyRef.current = false;
        setBusy(false);
        await openWindowOverlay();
        return;
      }

      if (!(await ensureCapturePermission())) {
        busyRef.current = false;
        setBusy(false);
        return;
      }

      if (kind === 'screen') {
        const delay = captureDelayRef.current;
        if (delay > 0) await runCountdown(delay);
      }

      const win = getCurrentWindow();
      await safeHideForCapture(win);
      try {
        const cmd = kind === 'screen' ? 'capture_screen' : kind === 'region' ? 'capture_region' : 'capture_window';
        const args = kind === 'screen' ? { displayId: null } : {};
        const dataUrl = await invoke<string>(cmd, args);
        await onCaptured(dataUrl);
      } catch (e) {
        const msg = String(e);
        if (msg.includes('屏幕录制') || msg.includes('permission') || msg.includes('denied') || msg.includes('not authorized')) {
          if (platform === 'macos') {
            invoke<boolean>('check_screen_capture_access').then((ok) => {
              if (!ok) setPermissionNeeded(true);
            });
          }
          return;
        }
        if (msg.includes('截图已取消') || msg.toLowerCase().includes('cancelled')) {
          flash(t('toast.cancelled'), 'success');
        } else {
          flash(t('toast.captureFailed', { msg }), 'error');
        }
      } finally {
        await win.show();
        await win.setFocus();
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onCaptured, flash, t, platform, isSandboxed, setPermissionNeeded, ensureCapturePermission, openRegionOverlay, openWindowOverlay, runCountdown],
  );

  return {
    busy,
    displays,
    captureDelay,
    setCaptureDelay,
    countdown,
    doCapture,
    pickDisplay,
    runCountdown,
  };
}
