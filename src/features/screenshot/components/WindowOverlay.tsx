import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { t, useI18n } from '../../../i18n';

/**
 * Windows / Linux 窗口截图覆盖层（覆盖整个虚拟桌面）。
 *
 * macOS 走系统原生 screencapture -w 点窗，不使用本组件。
 * Windows 没有可被第三方调用的系统级点窗 API，自建覆盖层：枚举所有窗口画高亮框，
 * 鼠标悬停高亮命中最上层窗口，点击 → emit 'window-picked' 带 windowId，
 * 主窗口再 invoke capture_window_by_id 截取该窗口。
 *
 * 这替换了之前「后端抓枚举列表第一个窗口」的假实现——那种做法用户根本无法选窗口。
 *
 * 坐标换算：窗口列表为全局物理像素；覆盖层内局部 CSS = (全局物理 - 虚拟桌面原点) / dpr。
 */

interface WinInfo {
  id: number;
  title: string;
  appName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

// 后端 WindowInfo 是 snake_case 序列化（serde 默认），前端做一次归一
interface RawWin {
  id: number;
  title: string;
  app_name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

export const WindowOverlay = () => {
  const [bg, setBg] = useState<string | null>(null);
  const [wins, setWins] = useState<WinInfo[]>([]);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 订阅语言事件：跟随主页面统一切换，弹窗自身不内置独立选择器
  useI18n();

  const dprRef = useRef(window.devicePixelRatio || 1);
  const originRef = useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 });

  const log = (m: string) => { invoke('diag_log', { msg: `[winovl] ${m}` }).catch(() => {}); };

  const cancel = useCallback(() => {
    log('取消窗口截图');
    emit('window-cancelled', {}).catch(() => {});
    getCurrentWindow().close().catch(() => {});
  }, []);

  // 载入底图 + 窗口列表；读取虚拟桌面原点
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    originRef.current = {
      vx: Number(params.get('vx')) || 0,
      vy: Number(params.get('vy')) || 0,
    };
    log(`覆盖层挂载 dpr=${dprRef.current} inner=${window.innerWidth}x${window.innerHeight} 原点=(${originRef.current.vx},${originRef.current.vy})`);

    invoke<string>('capture_screen', { displayId: null })
      .then((dataUrl) => setBg(dataUrl))
      .catch((e) => setErr(String(e)));

    invoke<RawWin[]>('list_windows')
      .then((raw) => {
        const list = raw.map((w) => ({
          id: w.id,
          title: w.title,
          appName: w.app_name,
          x: w.x,
          y: w.y,
          width: w.width,
          height: w.height,
          z: w.z,
        }));
        setWins(list);
        log(`窗口列表载入 共 ${list.length} 个`);
      })
      .catch((e) => {
        setErr(String(e));
        log(`窗口列表载入失败 ${String(e)}`);
      });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel]);

  // 全局物理像素 → 覆盖层局部 CSS 像素
  const toLocal = useCallback((w: WinInfo) => {
    const dpr = dprRef.current;
    const { vx, vy } = originRef.current;
    return {
      left: (w.x - vx) / dpr,
      top: (w.y - vy) / dpr,
      width: w.width / dpr,
      height: w.height / dpr,
    };
  }, []);

  // 窗口列表按 z 降序（前台在前）；命中检测取第一个包含光标的窗口（即最上层）
  const sorted = useMemo(() => [...wins].sort((a, b) => b.z - a.z), [wins]);

  const onMouseMove = (e: React.MouseEvent) => {
    const cx = e.clientX;
    const cy = e.clientY;
    let hit: number | null = null;
    for (const w of sorted) {
      const r = toLocal(w);
      if (cx >= r.left && cx < r.left + r.width && cy >= r.top && cy < r.top + r.height) {
        hit = w.id;
        break;
      }
    }
    if (hit !== hoverId) setHoverId(hit);
  };

  const onClick = async () => {
    if (hoverId == null) return;
    const win = wins.find((w) => w.id === hoverId);
    log(`点选窗口 id=${hoverId} title=${win?.title ?? ''}`);
    try { await getCurrentWindow().hide(); } catch { /* ignore */ }
    emit('window-picked', { windowId: hoverId }).catch(() => {});
    getCurrentWindow().close().catch(() => {});
  };

  const hover = hoverId != null ? wins.find((w) => w.id === hoverId) : null;
  const hoverRect = hover ? toLocal(hover) : null;

  return (
    <div
      className="region-overlay window-overlay"
      onMouseMove={onMouseMove}
      onMouseDown={(e) => { if (e.button === 2) cancel(); }}
      onClick={onClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      {bg && <img className="region-overlay-bg" src={bg} alt="" draggable={false} />}
      <div className="region-overlay-mask" />

      {/* 高亮命中窗口：挖空清晰层 + 高亮描边 + 标题 */}
      {hover && hoverRect && bg && (
        <>
          <div
            className="region-overlay-clear"
            style={{ left: hoverRect.left, top: hoverRect.top, width: hoverRect.width, height: hoverRect.height }}
          >
            <img
              src={bg}
              alt=""
              draggable={false}
              style={{ position: 'absolute', left: -hoverRect.left, top: -hoverRect.top }}
            />
          </div>
          <div
            className="region-overlay-box window-overlay-box"
            style={{ left: hoverRect.left, top: hoverRect.top, width: hoverRect.width, height: hoverRect.height }}
          >
            <span className="window-overlay-title">
              {hover.appName || hover.title || t('overlay.windowFallback')} · {Math.round(hover.width)}×{Math.round(hover.height)}
            </span>
          </div>
        </>
      )}

      {!hover && (
        <div className="region-overlay-hint">{t('overlay.windowHint')}</div>
      )}
      {err && <div className="region-overlay-err">{t('overlay.windowErr', { msg: err })}</div>}
    </div>
  );
};

export default WindowOverlay;
