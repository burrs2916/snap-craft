import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { t, useI18n } from '../../../i18n';

/**
 * Windows / Linux 区域截图覆盖层（覆盖整个虚拟桌面）。
 *
 * macOS 走系统原生 screencapture -i，不使用本组件。
 * Windows 没有可被第三方调用的系统级交互截图 API，必须自建全屏覆盖层选区。
 *
 * 工作流：
 *  1. 覆盖层作为独立无边框置顶窗口，铺满【整个虚拟桌面】（所有屏并集）；
 *  2. 向后端取主屏底图铺作背景（多屏时仅主屏有底图，副屏区域为暗色蒙版，
 *     选区功能不受影响——真正截图由后端 xcap 按全局坐标裁取）；
 *  3. 用户在覆盖层上拖框，选中区域「挖空」暗色蒙版；
 *  4. 松开鼠标 → 换算成【全局物理像素】rect，emit 'region-selected'，主窗口再 invoke capture_region；
 *  5. Esc / 右键 → emit 'region-cancelled'。
 *
 * 坐标换算（关键修复）：
 *   全局物理像素 = 虚拟桌面原点(vx,vy) + 覆盖层内 CSS 局部坐标 × devicePixelRatio
 *   之前写死「主屏原点 0,0」→ 副屏 / 非零原点必然截错，本版通过 URL 传入 vx/vy 修正。
 *
 * 性能（P1-5）：拖动时用 ref + requestAnimationFrame 直接改选框 DOM 样式，
 *   不再每次 mousemove 触发 React 重渲染，大屏高频拖动不卡顿。
 */

interface Point {
  x: number;
  y: number;
}

export const RegionOverlay = () => {
  const [bg, setBg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // 订阅语言事件：跟随主页面统一切换，弹窗自身不内置独立选择器
  useI18n();

  const startRef = useRef<Point | null>(null);
  const curRef = useRef<Point | null>(null);
  const rafRef = useRef<number | null>(null);
  // dpr 优先取自 URL（由主窗口按物理/逻辑折算时传入，保证与覆盖层窗口几何一致）；
  // 缺省回落到窗口自身 devicePixelRatio。用于「CSS 局部坐标 × dpr + 原点 = 全局物理像素」。
  const dprRef = useRef(window.devicePixelRatio || 1);

  // 虚拟桌面原点（物理像素），从 URL 读取；用于把局部坐标换算成全局物理像素
  const originRef = useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 });

  // 选框与清晰层 / 尺寸标签的 DOM 引用（直接改样式，避免 setState 重渲染）
  const boxRef = useRef<HTMLDivElement | null>(null);
  const clearRef = useRef<HTMLDivElement | null>(null);
  const clearImgRef = useRef<HTMLImageElement | null>(null);
  const sizeRef = useRef<HTMLSpanElement | null>(null);
  const hintRef = useRef<HTMLDivElement | null>(null);

  const log = (m: string) => { invoke('diag_log', { msg: `[region] ${m}` }).catch(() => {}); };

  const cancel = useCallback(() => {
    log('取消区域截图');
    emit('region-cancelled', {}).catch(() => {});
    getCurrentWindow().close().catch(() => {});
  }, []);

  // 读取 URL 上的虚拟桌面原点 + 载入主屏底图
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    originRef.current = {
      vx: Number(params.get('vx')) || 0,
      vy: Number(params.get('vy')) || 0,
    };
    // 与创建窗口时传入的 dpr 保持一致，确保「CSS×dpr+原点」换算与窗口实际定位对齐
    const urlDpr = Number(params.get('dpr'));
    if (urlDpr && urlDpr > 0) dprRef.current = urlDpr;
    log(`覆盖层挂载 dpr=${dprRef.current} inner=${window.innerWidth}x${window.innerHeight} 虚拟桌面原点=(${originRef.current.vx},${originRef.current.vy})`);
    invoke<string>('capture_screen', { displayId: null })
      .then((dataUrl) => {
        setBg(dataUrl);
        log(`底图载入成功 长度=${dataUrl.length}`);
      })
      .catch((e) => {
        setErr(String(e));
        log(`底图载入失败 ${String(e)}`);
      });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel]);

  // 用 ref 里的 start/cur 直接更新选框 DOM（不走 React 状态），rAF 合并高频 mousemove
  const paint = useCallback(() => {
    rafRef.current = null;
    const s = startRef.current;
    const c = curRef.current;
    if (!s || !c) return;
    const left = Math.min(s.x, c.x);
    const top = Math.min(s.y, c.y);
    const w = Math.abs(c.x - s.x);
    const h = Math.abs(c.y - s.y);
    const dpr = dprRef.current;

    if (boxRef.current) {
      boxRef.current.style.display = 'block';
      boxRef.current.style.left = `${left}px`;
      boxRef.current.style.top = `${top}px`;
      boxRef.current.style.width = `${w}px`;
      boxRef.current.style.height = `${h}px`;
    }
    if (clearRef.current) {
      clearRef.current.style.display = 'block';
      clearRef.current.style.left = `${left}px`;
      clearRef.current.style.top = `${top}px`;
      clearRef.current.style.width = `${w}px`;
      clearRef.current.style.height = `${h}px`;
    }
    if (clearImgRef.current) {
      clearImgRef.current.style.left = `${-left}px`;
      clearImgRef.current.style.top = `${-top}px`;
    }
    if (sizeRef.current) {
      // 展示的是最终截取的物理像素尺寸
      sizeRef.current.textContent = `${Math.round(w * dpr)} × ${Math.round(h * dpr)}`;
    }
  }, []);

  const schedulePaint = useCallback(() => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(paint);
  }, [paint]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button === 2) { cancel(); return; } // 右键取消
    if (e.button !== 0) return;
    startRef.current = { x: e.clientX, y: e.clientY };
    curRef.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
    if (hintRef.current) hintRef.current.style.display = 'none';
    schedulePaint();
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!startRef.current) return;
    curRef.current = { x: e.clientX, y: e.clientY };
    schedulePaint();
  };

  const onMouseUp = async () => {
    const s = startRef.current;
    const c = curRef.current;
    startRef.current = null;
    if (!s || !c) return;

    const left = Math.min(s.x, c.x);
    const top = Math.min(s.y, c.y);
    const w = Math.abs(c.x - s.x);
    const h = Math.abs(c.y - s.y);

    if (w < 5 || h < 5) {
      log(`选区过小 ${w}x${h}，忽略并继续`);
      setDragging(false);
      if (boxRef.current) boxRef.current.style.display = 'none';
      if (clearRef.current) clearRef.current.style.display = 'none';
      if (hintRef.current) hintRef.current.style.display = 'block';
      return;
    }

    // 全局物理像素 = 虚拟桌面原点 + 局部 CSS × dpr（修正：不再假设主屏 0,0）
    const dpr = dprRef.current;
    const { vx, vy } = originRef.current;
    const rect = {
      x: Math.round(vx + left * dpr),
      y: Math.round(vy + top * dpr),
      width: Math.round(w * dpr),
      height: Math.round(h * dpr),
    };
    log(`选区确定 CSS=(${left},${top},${w}x${h}) 原点=(${vx},${vy}) → 全局物理rect=(${rect.x},${rect.y},${rect.width}x${rect.height})`);

    try { await getCurrentWindow().hide(); } catch { /* ignore */ }
    emit('region-selected', rect).catch(() => {});
    getCurrentWindow().close().catch(() => {});
  };

  return (
    <div
      className="region-overlay"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {bg && <img className="region-overlay-bg" src={bg} alt="" draggable={false} />}
      <div className="region-overlay-mask" />

      {/* 清晰层（挖空）：始终渲染，用 display 控制显隐，避免拖动时反复挂载卸载 */}
      {bg && (
        <div ref={clearRef} className="region-overlay-clear" style={{ display: 'none' }}>
          <img ref={clearImgRef} src={bg} alt="" draggable={false} style={{ position: 'absolute' }} />
        </div>
      )}
      <div ref={boxRef} className="region-overlay-box" style={{ display: 'none' }}>
        <span ref={sizeRef} className="region-overlay-size" />
      </div>

      {!dragging && (
        <div ref={hintRef} className="region-overlay-hint">{t('overlay.regionHint')}</div>
      )}
      {err && <div className="region-overlay-err">{t('overlay.regionErr', { msg: err })}</div>}
    </div>
  );
};

export default RegionOverlay;
