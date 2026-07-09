import { useEffect, useState, useCallback } from 'react';
import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface PinData {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * 钉图窗口：独立置顶透明窗口，把截图"钉"在桌面最前。
 * - 整个顶部条可拖动窗口（data-tauri-drag-region）
 * - 滚轮缩放（0.2x ~ 4x）
 * - 双击图片 / ESC / ✕ 关闭
 *
 * 数据通过事件握手传输（避免 dataUrl 塞进 URL 超长）：
 * pin 窗口 mount → emit('pin-ready') → 主窗口收到后 emit('pin-data') → pin 窗口 listen 显示。
 */
export const PinnedWindow = () => {
  const [data, setData] = useState<PinData | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const win = getCurrentWindow();
    let un: UnlistenFn | undefined;
    (async () => {
      un = await listen<PinData>('pin-data', (e) => {
        setData(e.payload);
      });
      // 通知主窗口已就绪，可以发图片数据（避免 emit 早于 listen 的竞态）
      await emit('pin-ready', { label: win.label });
    })();
    return () => {
      if (un) un();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        getCurrentWindow().close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const close = useCallback(async () => {
    await getCurrentWindow().close();
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    setScale((s) =>
      Math.max(0.2, Math.min(4, +(s * (e.deltaY < 0 ? 1.1 : 0.9)).toFixed(3)))
    );
  }, []);

  if (!data) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          color: '#888',
          fontSize: 13,
        }}
      >
        加载中…
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'transparent',
      }}
    >
      <div
        data-tauri-drag-region
        style={{
          height: 28,
          background: 'rgba(0,0,0,0.55)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px',
          cursor: 'grab',
        }}
      >
        <span style={{ color: '#fff', fontSize: 12, userSelect: 'none' }}>
          📌 已钉图 · 滚轮缩放 · 双击关闭
        </span>
        <button
          onClick={close}
          title="关闭"
          aria-label="关闭"
          style={{
            background: 'rgba(255,255,255,0.15)',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            width: 20,
            height: 20,
            cursor: 'pointer',
            fontSize: 12,
            padding: 0,
            lineHeight: '20px',
          }}
        >
          ✕
        </button>
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onWheel={onWheel}
        onDoubleClick={close}
      >
        <img
          src={data.dataUrl}
          alt="pinned screenshot"
          draggable={false}
          style={{
            width: data.width * scale,
            height: data.height * scale,
            display: 'block',
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
};

export default PinnedWindow;
