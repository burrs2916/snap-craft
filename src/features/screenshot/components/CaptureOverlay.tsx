import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 从 URL 读取覆盖层模式与坐标参数（主窗口通过 query 传入，因覆盖层是独立 JS 上下文）
const params = new URLSearchParams(window.location.search);
const MODE: 'region' | 'window' = params.get('mode') === 'window' ? 'window' : 'region';
const PLATFORM = params.get('platform') || 'other';
const ORIGIN_X = Number(params.get('ox') || 0);
const ORIGIN_Y = Number(params.get('oy') || 0);

/**
 * 截图覆盖层：透明窗口，覆盖在主窗口之上（macOS 多屏时铺满所有显示器并集）。
 * - region：用户拖选矩形，确认后传给后端 capture_region（macOS 用 -R 全局坐标）。
 * - window：点击任意位置即隐藏覆盖层并取窗（后端 screencapture -w）。
 */
export const CaptureOverlay = () => {
  const [sel, setSel] = useState<Rect | null>(null);
  const [started, setStarted] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  // 已提交的选区：mouseup 时定型，避免确认按钮/双击的 mousedown 把 sel 重置成零尺寸导致 finish 提前返回
  const committedRef = useRef<Rect | null>(null);

  const closeSelf = useCallback(async () => {
    const w = getCurrentWindow();
    await w.close();
  }, []);

  // 把本地 CSS 坐标换算成后端需要的矩形
  const toBackendRect = (s: Rect) => {
    if (PLATFORM === 'macos') {
      // macOS：逻辑点（points），加上覆盖层全局原点即全局 Quartz 坐标
      return {
        x: Math.round(ORIGIN_X + s.x),
        y: Math.round(ORIGIN_Y + s.y),
        width: Math.round(s.w),
        height: Math.round(s.h),
      };
    }
    // 其他平台：设备像素 = CSS 像素 * dpr
    const dpr = window.devicePixelRatio || 1;
    return {
      x: Math.round(s.x * dpr),
      y: Math.round(s.y * dpr),
      width: Math.round(s.w * dpr),
      height: Math.round(s.h * dpr),
    };
  };

  const finish = useCallback(async () => {
    // 优先用当前 sel；若被确认按钮/双击的 mousedown 冲掉，则回退到已提交的选区
    const s = sel && sel.w >= 5 && sel.h >= 5 ? sel : committedRef.current;
    if (!s || s.w < 5 || s.h < 5) return;
    try {
      const dataUrl = await invoke<string>('capture_region', { rect: toBackendRect(s) });
      await emit('region-captured', dataUrl);
    } catch (e) {
      await emit('region-cancelled', String(e));
    } finally {
      await closeSelf();
    }
  }, [sel, closeSelf]);

  const cancel = useCallback(async () => {
    await emit('region-cancelled', 'cancelled');
    await closeSelf();
  }, [closeSelf]);

  // ===== 窗口模式：点击任意位置即隐藏覆盖层并取窗 =====
  const captureWindow = useCallback(async () => {
    const w = getCurrentWindow();
    await w.hide(); // 先隐藏，使后续点击落到目标窗口而非覆盖层
    try {
      const dataUrl = await invoke<string>('capture_window');
      await emit('region-captured', dataUrl);
    } catch (e) {
      await emit('region-cancelled', String(e));
    } finally {
      await closeSelf();
    }
  }, [closeSelf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
      if (e.key === 'Enter' && MODE === 'region') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel, finish]);

  const onDown = (e: React.MouseEvent) => {
    if (MODE === 'window') {
      // 窗口模式：点击即取窗（默认行为已阻止，避免文字选中）
      e.preventDefault();
      captureWindow();
      return;
    }
    setStarted(true);
    start.current = { x: e.clientX, y: e.clientY };
    setSel({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  };
  const onMove = (e: React.MouseEvent) => {
    if (MODE === 'window' || !start.current) return;
    const x = Math.min(start.current.x, e.clientX);
    const y = Math.min(start.current.y, e.clientY);
    const w = Math.abs(e.clientX - start.current.x);
    const h = Math.abs(e.clientY - start.current.y);
    setSel({ x, y, w, h });
  };
  const onUp = () => {
    if (sel && sel.w > 0 && sel.h > 0) committedRef.current = sel;
    start.current = null;
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        cursor: 'crosshair',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onDoubleClick={MODE === 'region' ? finish : undefined}
    >
      {MODE === 'region' && sel && sel.w > 0 && sel.h > 0 && (
        <>
          <div
            style={{
              position: 'fixed',
              left: sel.x,
              top: sel.y,
              width: sel.w,
              height: sel.h,
              border: '2px solid #ff3b30',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.4)',
              pointerEvents: 'none',
              borderRadius: 2,
            }}
          />
          <div
            style={{
              position: 'fixed',
              left: sel.x,
              top: Math.max(sel.y - 28, 4),
              background: 'rgba(0,0,0,0.75)',
              color: '#fff',
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: 12,
              fontFamily: 'monospace',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              transform: sel.y < 28 ? 'translateY(100%)' : 'none',
            }}
          >
            {Math.round(sel.w)} × {Math.round(sel.h)}
          </div>
        </>
      )}

      {!started && MODE === 'region' && (
        <div
          style={{
            position: 'fixed',
            top: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            color: '#fff',
            background: 'rgba(0,0,0,0.6)',
            padding: '8px 16px',
            borderRadius: 8,
            fontSize: 13,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          拖动选择区域 · Enter 确认 · Esc 取消
        </div>
      )}

      {MODE === 'window' && (
        <div
          style={{
            position: 'fixed',
            top: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            color: '#fff',
            background: 'rgba(0,0,0,0.6)',
            padding: '8px 16px',
            borderRadius: 8,
            fontSize: 13,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          点击要截取的应用窗口 · Esc 取消
        </div>
      )}

      {MODE === 'region' && sel && sel.w > 0 && sel.h > 0 && (
        <button
          onClick={finish}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: sel.x,
            top: Math.max(sel.y - 38, 4),
            background: '#ff3b30',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '6px 14px',
            fontSize: 13,
            cursor: 'pointer',
            pointerEvents: 'auto',
          }}
        >
          确认
        </button>
      )}
    </div>
  );
};

export default CaptureOverlay;
