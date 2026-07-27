// ===== 截图捕获编排 Hook =====
// 从 EnhancedScreenshotApp.tsx 提取的截图核心流程：
// 全屏/区域/窗口截图分流、多屏选择、覆盖层管理、安全隐藏、延时倒计时。
// 职责：只管「怎么截」，不管「截完怎么展示/编辑/AI」。

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { DisplayInfo } from './useScrollCapture';
import { flog } from '../utils/helpers';

// ── 安全隐藏：截图前隐藏主窗口 ──
// macOS 原生全屏（绿灯）会把窗口放进独立的 Space（专属全屏空间）。
// ⚠️ 黑屏根因：原生全屏 Space 的进入/退出都有一段过渡动画（黑场）。此前用 minimize()
// 退出全屏，但最小化并不清除全屏态——restore 时 unminimize() 会**重新进入全屏 Space**
// 触发第二次黑场，且关闭时又走全屏分支退出一次 → 用户看到「截取黑屏 + 关闭黑屏」。
// ✅ 正确修法：用 setFullscreen(false) 把全屏窗**彻底降级为普通窗口**（不再保留全屏态），
// 等 Space 退出过渡动画结束后（~800ms）再 hide()；截后恢复时**绝不再重进全屏**。
// 这样既躲开 hide() 在全屏态的 insets crash（macOS 26），又根除三次 Space 过渡黑场。
async function safeHideForCapture(win: ReturnType<typeof getCurrentWindow>): Promise<{ wasFullscreen: boolean }> {
  let wasFullscreen = false;
  let wasMaximized = false;
  try { wasFullscreen = await win.isFullscreen(); } catch { /* ignore */ }
  try { wasMaximized = await win.isMaximized(); } catch { /* ignore */ }

  if (wasFullscreen) {
    // 全屏 → 降级为普通窗口（关键：彻底丢掉全屏态，避免恢复时重进全屏 Space 黑场）。
    flog(`safeHide: 窗口处于原生全屏 → setFullscreen(false) 降级为普通窗口（规避 Space 过渡黑屏）`);
    try { await win.setFullscreen(false); } catch { /* ignore */ }
    // 全屏退出动画约 400~1000ms，等足以免 hide() 时仍处过渡黑场。
    await new Promise((r) => setTimeout(r, 800));
    try { await win.hide(); } catch { /* ignore */ }
  } else if (wasMaximized) {
    flog(`safeHide: 窗口处于最大化 → 先取消最大化并等待重绘再隐藏`);
    try { await win.unmaximize(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 350));
    await win.hide();
  } else {
    await win.hide();
  }
  return { wasFullscreen };
}

// 截图结束后恢复窗口可见性，与 safeHideForCapture 配对。
// ✅ 关键：截后【不再重新进入全屏】。wasFullscreen 的窗口已在 safeHide 阶段被
// setFullscreen(false) 降级为普通窗口，若这里再 fullscreen()/unminimize() 会重新进入
// 全屏 Space 触发黑场（用户反馈「截取黑屏 + 关闭黑屏」的真因）。直接 show+focus 以
// 普通窗口态恢复即可，全屏态有意不恢复，彻底规避黑屏。
async function restoreAfterCapture(
  win: ReturnType<typeof getCurrentWindow>,
  _wasFullscreen: boolean,
): Promise<void> {
  try { await win.show(); } catch { /* ignore */ }
  try { await win.setFocus(); } catch { /* ignore */ }
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
        // 取消也要复位用途：否则上一次滚动选屏的 'scroll' 残留，
        // 下一次普通全屏截图会被误路由成滚动长截图。
        pickerPurposeRef.current = 'shot';
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
      const hider = await safeHideForCapture(win);
      const wasFullscreen = hider?.wasFullscreen ?? false;
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
        if (hider) await restoreAfterCapture(win, wasFullscreen);
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
      const hider = await safeHideForCapture(win);
      const wasFullscreen = hider?.wasFullscreen ?? false;
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
        if (hider) await restoreAfterCapture(win, wasFullscreen);
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
