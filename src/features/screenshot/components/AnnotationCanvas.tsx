import { Stage, Layer, Image as KonvaImage, Line, Arrow, Rect, Ellipse, Text, Group, Circle } from 'react-konva';
import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import Konva from 'konva';
import { invoke } from '@tauri-apps/api/core';
import { useScreenshotStore } from '../store/screenshotStore';
import { t } from '../../../i18n';
import type { AnnotationObject, AnnotationGeometry, Point } from '../types';

// 诊断日志：把编辑器渲染的详细信息写入 logs/dev.log（tag=diag，前缀 [canvas]）。
// best-effort，绝不阻断渲染。用于精确定位"点击编辑后弹出框渲染"是否正确。
const clog = (msg: string) => {
  invoke('diag_log', { msg: `[canvas] ${msg}` }).catch(() => {});
};

interface AnnotationCanvasProps {
  imageData: string;
  annotations: AnnotationObject[];
  onAnnotationAdd: (annotation: AnnotationObject) => void;
  activeTool: string | null;
  /** 裁剪确认：把当前图（含标注合并）裁剪为新图，回传给父组件替换编辑对象 */
  onCropped?: (dataUrl: string, width: number, height: number) => void;
  /** OCR 选区模式：开启时拖拽画布即框选区域，松手后裁出区域图回传 onRegionOcr（不创建标注） */
  ocrRegionMode?: boolean;
  /** OCR 选区结果回调：传入框选区域的 PNG dataURL（自然像素） */
  onRegionOcr?: (dataUrl: string) => void;
}

export interface AnnotationCanvasHandle {
  /** 把原图 + 所有标注合并导出为 PNG dataURL（自然分辨率，自动剔除选中高亮框） */
  getMergedImageDataUrl: () => Promise<string | null>;
  /**
   * AI 智能编辑「操作过程可视化」：在指定区域做一次脉冲高亮（约 1.4s 后自动销毁）。
   * rect 用 natural pixel 坐标（与标注一致，由 Stage scale 自动映射）。
   * 纯视觉层：不落 annotations、不进撤销历史、与 react 声明式 layer 隔离。
   * kind 决定配色语义：rect=画框(蓝/自定义) / redact=打码(警示红) / highlight=高亮(黄/自定义)。
   */
  flashRegion: (
    rect: { x: number; y: number; w: number; h: number },
    color?: string,
    kind?: 'rect' | 'redact' | 'highlight' | 'arrow',
  ) => void;
}

const genId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const ACCENT = '#007aff';

// 文字尺寸量测：用离屏 canvas 2D 上下文以「真实渲染字体」测量每行宽度，
// 得到与 Konva/浏览器渲染一致的字宽，从而让文字底衬框精确包裹全部文字（不溢出也不短缺）。
// 全局复用同一个离屏 canvas，避免反复创建。
let _measureCtx: CanvasRenderingContext2D | null = null;
function measureTextWidth(
  line: string,
  fontSize: number,
  bold: boolean,
  italic: boolean,
  fontFamily: string
): number {
  if (!_measureCtx) {
    const c = document.createElement('canvas');
    _measureCtx = c.getContext('2d');
  }
  if (!_measureCtx) {
    // 极端兜底：无 canvas 时用粗略估算
    return Math.max(1, (line || ' ').length) * fontSize * 0.6;
  }
  const font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontSize}px ${fontFamily}`;
  _measureCtx.font = font;
  return _measureCtx.measureText(line || ' ').width;
}

// 量测整段文字（含多行）的像素尺寸，供底衬 Rect 精确包裹使用
function measureTextBlock(
  text: string,
  fontSize: number,
  bold: boolean,
  italic: boolean,
  fontFamily: string
): { width: number; height: number; lineWidths: number[] } {
  const lines = (text || ' ').split('\n');
  const lineWidths = lines.map((l) => measureTextWidth(l, fontSize, bold, italic, fontFamily));
  const padX = fontSize * 0.35;
  const padY = fontSize * 0.3;
  const width = Math.max(...lineWidths, 0) + padX * 2;
  const height = lines.length * fontSize * 1.3 + padY * 2;
  return { width, height, lineWidths };
}

// #RRGGBB / #RGB → {r,g,b}，解析失败兜底深色
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = (hex || '').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return { r: 29, g: 29, b: 31 };
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return { r: 29, g: 29, b: 31 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// 底衬色 + 透明度 → rgba，支持半透明底衬
function bgFill(bgColor: string, opacity: number): string {
  const { r, g, b } = hexToRgb(bgColor);
  const a = Math.max(0, Math.min(1, opacity));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// 文字描边色：按文字填充色亮度自动选对比色，保证在亮底/暗底截图上都清晰可读
function contrastStroke(fill: string): string {
  const { r, g, b } = hexToRgb(fill);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? 'rgba(0, 0, 0, 0.55)' : 'rgba(255, 255, 255, 0.92)';
}

// 引线终点：从气泡中心指向锚点的射线与气泡矩形边界的交点（引线不穿入气泡内部）。
// 用于 callout 标注——锚点在要说明的要素上，气泡在旁边留白处，引线自然连到气泡边缘。
function leaderHit(bx: number, by: number, bw: number, bh: number, ax: number, ay: number) {
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const dx = ax - cx;
  const dy = ay - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = bw / 2;
  const hh = bh / 2;
  const sx = Math.abs(dx) < 1e-6 ? Infinity : hw / Math.abs(dx);
  const sy = Math.abs(dy) < 1e-6 ? Infinity : hh / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(({
  imageData,
  annotations,
  onAnnotationAdd,
  activeTool,
  onCropped,
  ocrRegionMode = false,
  onRegionOcr,
}: AnnotationCanvasProps, ref) => {
  const stageRef = useRef<Konva.Stage | null>(null);
  const layerRef = useRef<Konva.Layer | null>(null);
  // AI 操作可视化层：命令式 add/remove 脉冲高亮节点，与 react 声明式 layer 完全隔离
  const flashLayerRef = useRef<Konva.Layer | null>(null);
  const shapeRefs = useRef<Record<string, Konva.Node | null>>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const committedRef = useRef(false);
  // 文字输入框 ref：用 rAF 延迟聚焦，避开「点击打开手势」立刻夺焦导致 blur 的竞态
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 输入法合成标记：合成（选词）期间为 true，避免 Enter 误提交吞掉中文候选
  const composingRef = useRef(false);
  // 重聚焦守卫：toolbar select/color 交互后延迟重聚焦 textarea，若用户已点击别处则取消
  const refocusRef = useRef(false);
  // 拖动起点：dragStart 记录节点原始位置，dragEnd 用「当前-起点」算位移量，
  // 这样无论形状节点是否自带 x/y 绝对坐标（矩形/圆/高亮/马赛克），位移量都正确，不会多算原始位置。
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const selBoxRef = useRef<Konva.Rect | null>(null);
  const handlesRef = useRef<Konva.Group | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  // 打码底图缓存：按「模式(马赛克/模糊)+强度」生成整图处理版，各打码块从中裁剪对应区域，
  // 保证打码像素与原图对齐、且相同参数复用同一底图（避免每帧重算）。
  const maskCacheRef = useRef<{ src: string; map: Map<string, HTMLCanvasElement> }>({ src: '', map: new Map() });
  // bump 用于在惰性生成新底图后触发一次重渲染
  const [, setMaskTick] = useState(0);
  const [draft, setDraft] = useState<{ type: AnnotationGeometry['type']; points: Point[] } | null>(null);
  const [selBox, setSelBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  // 正在通过控制点调整尺寸的标注（拖动过程中的实时点，拖动结束才提交到 store）
  const [resizing, setResizing] = useState<{ id: string; points: Point[] } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [editing, setEditing] = useState<{ x: number; y: number; id?: string; text?: string } | null>(null);

  // 文字输入框聚焦：仅在「本次编辑会话」打开时聚焦一次（editKey 由 新建/编辑的 id 与落点决定，
  // 打字过程 editing.text 变化不会改变 editKey，故不会每键重聚焦导致光标跳动）。
  // 编辑已有文字时自动全选，方便用户直接替换内容。
  const editKey = editing ? `${editing.id ?? 'new'}:${editing.x}:${editing.y}` : null;
  const editingIsExisting = !!editing?.id;
  useEffect(() => {
    if (!editKey) return;
    const id = requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      if (editingIsExisting) {
        ta.select();
      }
      clog(`文本输入: rAF 聚焦 textarea 完成 (existing=${editingIsExisting})`);
    });
    return () => cancelAnimationFrame(id);
  }, [editKey, editingIsExisting]);
  // 裁剪：拖拽出的裁剪区（自然像素坐标）。存在时叠加半透明遮罩 + 确认/取消。
  // cropRectRef 同步最新值，供 handleMouseUp 判断尺寸（避免闭包过期拿到旧值误清空）。
  // cropDragging 是 state（非 ref）：拖拽结束时触发 re-render，让确认条条件 !cropDragging 生效。
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const cropRectRef = useRef<typeof cropRect>(cropRect);
  cropRectRef.current = cropRect;
  const [cropDragging, setCropDragging] = useState(false);
  const cropDraggingRef = useRef(false);
  const cropStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const {
    selectedId,
    setSelectedId,
    updateAnnotation,
    deleteAnnotation,
    undo,
    redo,
    currentColor,
    currentStrokeWidth,
    setActiveTool,
    updateStyle,
    currentFontSize,
    currentBold,
    currentItalic,
    currentAlign,
    currentFontFamily,
    currentTextBg,
    currentBgColor,
    currentBgOpacity,
    currentTextStroke,
    maskBlur,
    maskStrength,
    maskSolid,
    maskBrushSize,
  } = useScreenshotStore();

  useEffect(() => {
    if (!imageData) {
      clog(`图片加载跳过: imageData 为空`);
      return;
    }
    clog(
      `开始加载图片到编辑器: imageData长度=${imageData.length} 前缀=${imageData.slice(0, 32)} DPR=${window.devicePixelRatio}`
    );
    const t0 = performance.now();
    const img = new Image();
    img.onload = () => {
      clog(
        `图片解码完成: 自然像素=${img.width}x${img.height} naturalW/H=${img.naturalWidth}x${img.naturalHeight} 耗时=${(performance.now() - t0).toFixed(0)}ms`
      );
      setImage(img);
    };
    img.onerror = () => {
      clog(`❌ 图片解码失败: imageData长度=${imageData.length} 前缀=${imageData.slice(0, 48)}`);
    };
    img.src = imageData;
  }, [imageData]);

  // 惰性生成/复用某个「模式+强度」的整图打码底图。图片变化时清空缓存。
  const getMaskCanvas = (blur: boolean, strength: number): HTMLCanvasElement | null => {
    if (!image) return null;
    const cache = maskCacheRef.current;
    if (cache.src !== imageData) {
      cache.src = imageData;
      cache.map = new Map();
    }
    const st = Math.max(2, Math.round(strength));
    const key = `${blur ? 'b' : 'm'}:${st}`;
    const hit = cache.map.get(key);
    if (hit) return hit;

    const w = image.width;
    const h = image.height;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d');
    if (!octx) return null;

    if (blur) {
      // 高斯模糊：用 canvas filter 一次性模糊整图（半径 = 强度）
      octx.filter = `blur(${st}px)`;
      octx.drawImage(image, 0, 0);
      octx.filter = 'none';
    } else {
      // 马赛克：缩小再无平滑放大 → 块状。块大小 = 强度
      const sw = Math.max(1, Math.round(w / st));
      const sh = Math.max(1, Math.round(h / st));
      const small = document.createElement('canvas');
      small.width = sw;
      small.height = sh;
      const sctx = small.getContext('2d');
      if (!sctx) return null;
      sctx.drawImage(image, 0, 0, sw, sh);
      octx.imageSmoothingEnabled = false;
      octx.drawImage(small, 0, 0, sw, sh, 0, 0, w, h);
    }
    cache.map.set(key, out);
    return out;
  };

  // 图片变化时清空打码底图缓存
  useEffect(() => {
    maskCacheRef.current = { src: '', map: new Map() };
    setMaskTick((t) => t + 1);
  }, [imageData]);

  // 测量容器尺寸，供画布自适应缩放（4K 截图不再溢出容器）
  // 依赖 image：组件在 image 未就绪时会提前 return loading div（见下方 if (!image)），
  // 此时挂 wrapRef 的真实容器尚未进入 DOM。必须等 image 就绪、容器渲染出来后重跑本 effect，
  // 否则 box 永远停在 0×0 → scale 退回 1.0 → 4K 图按原始像素 1:1 溢出容器（截不全/缩放错）。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) {
      clog(`容器测量跳过: wrapRef 为空（image 未就绪，等待重跑）`);
      return;
    }
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      clog(`容器测量: clientWidth=${w} clientHeight=${h} (offsetW/H=${el.offsetWidth}x${el.offsetHeight})`);
      setBox({ w, h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [image]);

  const updateSelBox = (node: Konva.Node) => {
    const layer = layerRef.current;
    if (!layer || !node) return;
    const b = node.getClientRect({ relativeTo: layer });
    setSelBox({ x: b.x, y: b.y, width: b.width, height: b.height });
  };

  // 选中态变化时刷新高亮框
  useEffect(() => {
    if (!selectedId) {
      setSelBox(null);
      return;
    }
    const node = shapeRefs.current[selectedId];
    if (node) updateSelBox(node);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, annotations]);

  // Delete / Backspace 删除选中，Esc 取消选中；Ctrl/⌘+Z 撤销、+Shift 重做
  // 数字键 1-7 切换标注工具；[ / ] 调节线宽
  useEffect(() => {
    const TOOL_KEYS: Record<string, string> = {
      '1': 'select',
      '2': 'arrow',
      '3': 'line',
      '4': 'rectangle',
      '5': 'circle',
      '6': 'text',
      '7': 'freehand',
      '8': 'highlight',
      '9': 'mosaic',
      '0': 'step',
      'c': 'crop',
      'C': 'crop',
    };
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      // 输入框聚焦时交给浏览器原生处理（文字删除 / 撤销），不拦截
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      // ⌘/Ctrl+S 保存、⌘/Ctrl+C 复制——交给编辑器顶层处理，这里不拦截
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S' || e.key === 'c' || e.key === 'C')) {
        return;
      }
      // 数字键切换工具
      if (TOOL_KEYS[e.key]) {
        e.preventDefault();
        setActiveTool(TOOL_KEYS[e.key]);
        return;
      }
      // [ / ] 调节线宽（选中标注时同步更新其线宽）
      if (e.key === '[') {
        e.preventDefault();
        const nw = Math.max(2, currentStrokeWidth - 2);
        updateStyle({ currentStrokeWidth: nw });
        if (selectedId) updateAnnotation(selectedId, { lineWidth: nw });
        return;
      }
      if (e.key === ']') {
        e.preventDefault();
        const nw = Math.min(8, currentStrokeWidth + 2);
        updateStyle({ currentStrokeWidth: nw });
        if (selectedId) updateAnnotation(selectedId, { lineWidth: nw });
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) {
          deleteAnnotation(selectedId);
          setSelectedId(null);
        }
      } else if (e.key === 'Escape') {
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, deleteAnnotation, setSelectedId, undo, redo, setActiveTool, updateStyle, currentStrokeWidth, updateAnnotation]);

  // 离开裁剪工具（且非 OCR 选区模式）时清空未确认的裁剪框
  useEffect(() => {
    if (activeTool !== 'crop' && !ocrRegionMode && cropRect) {
      setCropRect(null);
      cropDraggingRef.current = false;
      setCropDragging(false);
    }
    // 编辑中的文字：切换工具时先提交（避免文字丢失）
    if (activeTool !== 'text' && editing && !committedRef.current) {
      const ta = taRef.current;
      if (ta) {
        commitText(ta.value, { x: editing.x, y: editing.y }, editing.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool]);

  // 提交画布内文字（Enter 或失焦触发），用 ref 防止重复提交
  // 若带 id 则是编辑已有文字（走 updateAnnotation），否则新增（走 onAnnotationAdd）
  const commitText = (value: string, pos: { x: number; y: number }, id?: string) => {
    if (committedRef.current) {
      clog(`文本提交: 已提交过，重复调用被跳过(防重入) id=${id ?? '(新建)'} value长度=${value.length}`);
      return;
    }
    committedRef.current = true;
    const t = value.trim();
    clog(`文本提交: 长度=${value.length} trim后长度=${t.length} id=${id ?? '(新建)'} 空=${!t} 值前20="${(value || '').slice(0, 20)}"`);
    if (t) {
      if (id) {
        // 编辑已有文字：从 annotations 取最新 geometry（用户可能在编辑期间通过工具栏改了样式，
        // 那些改动已通过 updateAnnotation 写入 store，这里必须读最新的而非闭包旧的）
        const existing = annotations.find((a) => a.id === id);
        const g = existing?.geometry;
        updateAnnotation(id, {
          geometry: {
            type: 'text',
            points: [{ x: pos.x, y: pos.y }],
            text: t,
            fontSize: g?.fontSize ?? currentFontSize,
            fontFamily: g?.fontFamily ?? currentFontFamily,
            bold: g?.bold ?? currentBold,
            italic: g?.italic ?? currentItalic,
            align: g?.align ?? currentAlign,
            bg: g?.bg ?? currentTextBg,
            bgColor: g?.bgColor ?? currentBgColor,
            bgOpacity: g?.bgOpacity ?? currentBgOpacity,
            stroke: g?.stroke ?? currentTextStroke,
          },
          color: existing?.color ?? currentColor,
        });
      } else {
        onAnnotationAdd({
          id: genId(),
          geometry: {
            type: 'text',
            points: [{ x: pos.x, y: pos.y }],
            text: t,
            fontSize: currentFontSize,
            fontFamily: currentFontFamily,
            bold: currentBold,
            italic: currentItalic,
            align: currentAlign,
            bg: currentTextBg,
            bgColor: currentBgColor,
            bgOpacity: currentBgOpacity,
            stroke: currentTextStroke,
          },
          layerId: 'default',
          color: currentColor,
          lineWidth: currentStrokeWidth,
          opacity: 1,
          properties: {},
        });
      }
    }
    setEditing(null);
  };

  // 编辑态时，document 级 mousedown 监听：
  // 点击工具栏控件（按钮/select/滑块/color input）时，textarea 的 onBlur 会先触发 relatedTarget 逻辑
  // 把焦点拉回 textarea；但某些控件（如原生 select 下拉）可能不触发 relatedTarget。
  // 此监听器作为兜底：若 mousedown 落在 toolbar 内但 editing 仍存活，不做任何事（toolbar 交互优先）；
  // 若落在 textarea 外且不在 toolbar 内，则触发 blur -> onBlur 提交。
  useEffect(() => {
    if (!editing) return;
    const onDocDown = (e: MouseEvent) => {
      const tgt = e.target as HTMLElement;
      // 点击 textarea 自身：不管
      if (tgt === taRef.current) return;
      // 点击工具栏内：不拦截，让 onBlur 的 relatedTarget 逻辑处理
      if (tgt.closest('.toolbar-center') || tgt.closest('.tool-tip-float')) return;
      // 点击其他地方：textarea 会自然 blur -> onBlur 提交
    };
    document.addEventListener('mousedown', onDocDown, true);
    return () => document.removeEventListener('mousedown', onDocDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (!image) return;
    const stage = e.target.getStage();
    if (!stage) return;
    const pos = stage.getRelativePointerPosition();
    if (!pos) return;

    // OCR 选区模式：拖拽即框选区域，松手裁图回传（不创建标注）。
    // 复用 cropRect / cropStartRef 机，与裁剪工具同一套拖拽逻辑。
    if (ocrRegionMode) {
      cropDraggingRef.current = true;
      setCropDragging(true);
      cropStartRef.current = { x: pos.x, y: pos.y };
      setCropRect({ x: pos.x, y: pos.y, w: 0, h: 0 });
      return;
    }

    if (!activeTool) return;

    if (activeTool === 'select') {
      if (e.target === stage) setSelectedId(null);
      return;
    }

    if (activeTool === 'text') {
      // 若已有编辑中的文字（用户在编辑中又点画布其他位置），先提交旧的再开新的
      if (editing && !committedRef.current) {
        const ta = taRef.current;
        if (ta) {
          commitText(ta.value, { x: editing.x, y: editing.y }, editing.id);
        }
      }
      committedRef.current = false;
      setEditing({ x: pos.x, y: pos.y });
      clog(`文本工具: 落点开始输入 pos=(${pos.x.toFixed(0)},${pos.y.toFixed(0)}) box=${box.w}x${box.h} scale=${scale.toFixed(3)}`);
      return;
    }

    if (activeTool === 'step') {
      // 序号标注：单击落点即放一个自增编号的圆。编号 = 现有序号最大值 + 1，
      // 天然兼容撤销/重做（删除后再放会复用空缺号，符合直觉）。
      const maxNum = annotations.reduce(
        (m, a) => (a.geometry.type === 'step' ? Math.max(m, a.geometry.stepNumber || 0) : m),
        0
      );
      const stepId = genId();
      onAnnotationAdd({
        id: stepId,
        geometry: { type: 'step', points: [pos], stepNumber: maxNum + 1 },
        layerId: 'default',
        color: currentColor,
        lineWidth: currentStrokeWidth,
        opacity: 1,
        properties: {},
      });
      setSelectedId(stepId);
      return;
    }

    if (activeTool === 'crop') {
      // 裁剪：拖拽出裁剪框（自然像素坐标）。记录固定起点，move 时以起点+当前点算矩形。
      cropDraggingRef.current = true;
      setCropDragging(true);
      cropStartRef.current = { x: pos.x, y: pos.y };
      setCropRect({ x: pos.x, y: pos.y, w: 0, h: 0 });
      return;
    }

    // 画笔模式（freehand 或 mosaic+brush）：拖拽路径
    if (activeTool === 'freehand' || (activeTool === 'mosaic' && maskSolid)) {
      setDraft({ type: 'freehand', points: [pos] });
    } else {
      setDraft({ type: activeTool as AnnotationGeometry['type'], points: [pos, pos] });
    }
  };

  const handleMouseMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = e.target.getStage();
    if (!stage) return;
    const pos = stage.getRelativePointerPosition();
    if (!pos) return;
    // 裁剪框拖拽中
    if (cropDraggingRef.current) {
      const s = cropStartRef.current;
      const x = Math.min(s.x, pos.x);
      const y = Math.min(s.y, pos.y);
      const w = Math.abs(pos.x - s.x);
      const h = Math.abs(pos.y - s.y);
      setCropRect({ x, y, w, h });
      return;
    }
    if (!draft) return;
    if (draft.type === 'freehand') {
      setDraft({ type: 'freehand', points: [...draft.points, pos] });
    } else {
      setDraft({ type: draft.type, points: [draft.points[0], pos] });
    }
  };

  const handleMouseUp = () => {
    if (cropDraggingRef.current) {
      cropDraggingRef.current = false;
      setCropDragging(false); // 触发 re-render，让确认条条件 !cropDragging 生效
      // OCR 选区模式：松手即裁出区域图回传，不创建标注（用 ref 取最新值避免闭包过期）
      const cr = cropRectRef.current;
      if (ocrRegionMode && onRegionOcr && image && cr && cr.w >= 8 && cr.h >= 8) {
        const cw = Math.round(cr.w);
        const ch = Math.round(cr.h);
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(image, cr.x, cr.y, cr.w, cr.h, 0, 0, cw, ch);
          const dataUrl = canvas.toDataURL('image/png');
          onRegionOcr(dataUrl);
        }
        setCropRect(null);
        return;
      }
      // 太小的裁剪框视为取消：用 ref 取最新值，避免闭包过期拿到旧值（w/h 还是 0）误清空
      if (cr && (cr.w < 8 || cr.h < 8)) {
        setCropRect(null);
      }
      return;
    }
    if (!draft) return;
    const pts = draft.points;
    let ok = false;
    if (draft.type === 'freehand') ok = pts.length >= 2;
    else {
      const [a, b] = pts;
      ok = Math.abs(b.x - a.x) >= 3 || Math.abs(b.y - a.y) >= 3;
    }
    if (ok) {
      let geom: AnnotationGeometry;
      if (draft.type === 'mosaic') {
        if (maskSolid) {
          // 画笔涂黑：用 freehand 路径 + solid 标记
          geom = {
            type: 'mosaic',
            points: pts,
            maskMode: 'brush',
            solid: true,
            brushSize: maskBrushSize,
            blur: maskBlur,
            strength: maskStrength,
          };
        } else {
          // 矩形打码
          geom = { type: 'mosaic', points: pts, blur: maskBlur, strength: maskStrength };
        }
      } else {
        geom = { type: draft.type, points: pts };
      }
      const newId = genId();
      onAnnotationAdd({
        id: newId,
        geometry: geom,
        layerId: 'default',
        color: currentColor,
        lineWidth: currentStrokeWidth,
        opacity: 1,
        properties: {},
      });
      // 画完立即选中新标注：这样紧接着点调色板/线宽就能直接改它的颜色与粗细，
      // 无需先切到「选择」工具再点一次（这是之前「颜色改不了」的根因）。
      setSelectedId(newId);
    }
    setDraft(null);
  };

  const handleDragEnd = (e: Konva.KonvaEventObject<DragEvent>, ann: AnnotationObject) => {
    const node = e.target;
    // 位移量 = 当前节点位置 - 拖拽起点。节点起点在 onDragStart 记录。
    // 线/箭头/自由笔/文字(原点0,0)起点为0→delta=node.x()；矩形/圆/高亮/马赛克带x/y绝对坐标→delta=当前-原始，避免多算原始位置。
    const dx = node.x() - dragStartRef.current.x;
    const dy = node.y() - dragStartRef.current.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    const shifted = ann.geometry.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    updateAnnotation(ann.id, { geometry: { ...ann.geometry, points: shifted } });
    node.position({ x: 0, y: 0 });
    // 拖拽结束后刷新选中框（annotations 变化触发 effect，但 rAF 同步更及时）
    requestAnimationFrame(() => {
      const n = shapeRefs.current[ann.id];
      if (n) updateSelBox(n);
    });
  };

  const renderShape = (ann: AnnotationObject, isDraft: boolean) => {
    const baseProps = isDraft
      ? {}
      : {
          name: ann.id,
          ref: (el: Konva.Node | null) => {
            shapeRefs.current[ann.id] = el;
          },
          draggable: activeTool === 'select',
          onClick: (ev: Konva.KonvaEventObject<MouseEvent>) => {
            if (activeTool === 'select') {
              ev.cancelBubble = true;
              setSelectedId(ann.id);
            }
          },
          onTap: (ev: Konva.KonvaEventObject<Event>) => {
            if (activeTool === 'select') {
              ev.cancelBubble = true;
              setSelectedId(ann.id);
            }
          },
          onDragStart: (ev: Konva.KonvaEventObject<DragEvent>) => {
            dragStartRef.current = { x: ev.target.x(), y: ev.target.y() };
          },
          onDragEnd: (ev: Konva.KonvaEventObject<DragEvent>) => handleDragEnd(ev, ann),
          onDragMove: (ev: Konva.KonvaEventObject<DragEvent>) => updateSelBox(ev.target),
          opacity: ann.opacity,
        };

    switch (ann.geometry.type) {
      case 'arrow': {
        // 箭头必须用 Konva 的 <Arrow> 组件（<Line> 没有 arrow 属性，只会画成普通线）。
        // 箭头头随线宽放大，fill=描边色 → 实心箭头；只取首尾两点画直箭头。
        const flat = ann.geometry.points.flatMap((p) => [p.x, p.y]);
        const head = Math.max(10, ann.lineWidth * 3.2);
        return (
          <Arrow
            {...baseProps}
            points={flat}
            stroke={ann.color}
            fill={ann.color}
            strokeWidth={ann.lineWidth}
            lineCap="round"
            lineJoin="round"
            pointerLength={head}
            pointerWidth={head * 0.9}
          />
        );
      }
      case 'callout': {
        // 文字标注气泡：引线(锚点→气泡)+锚点圆点+圆角气泡(带底衬)+文字。
        // 全部挂在原点 Group、子元素绝对定位，与 text/step 一致 → 拖动位移即位移量，
        // 与 handleDragEnd 约定兼容；气泡经 Konva 渲染，合并导出自动捕获，无需改导出路径。
        const [anchor, label] = ann.geometry.points;
        const text = ann.geometry.text || '';
        const fs = ann.geometry.fontSize || 20;
        const ff = ann.geometry.fontFamily || currentFontFamily;
        const bold = !!ann.geometry.bold;
        const italic = !!ann.geometry.italic;
        const align = ann.geometry.align || 'center';
        const bgColor = ann.geometry.bgColor || currentBgColor;
        const bgOpacity = ann.geometry.bgOpacity ?? currentBgOpacity;
        const hasStroke = !!ann.geometry.stroke;
        const fontStyle = `${bold ? 'bold' : ''}${italic ? ' italic' : ''}`.trim() || 'normal';
        const strokeColor = hasStroke ? contrastStroke(ann.color) : undefined;
        const strokeW = hasStroke ? Math.max(0.8, fs * 0.1) : 0;
        const m = measureTextBlock(text, fs, bold, italic, ff);
        const padX = fs * 0.5;
        const padY = fs * 0.4;
        const bubbleW = m.width + padX * 2;
        const bubbleH = m.height + padY * 2;
        const bx = label.x - bubbleW / 2;
        const by = label.y - bubbleH / 2;
        const hit = leaderHit(bx, by, bubbleW, bubbleH, anchor.x, anchor.y);
        return (
          <Group {...baseProps}>
            <Line
              points={[anchor.x, anchor.y, hit.x, hit.y]}
              stroke={ann.color}
              strokeWidth={ann.lineWidth}
              lineCap="round"
            />
            <Circle x={anchor.x} y={anchor.y} radius={Math.max(3, ann.lineWidth * 1.5)} fill={ann.color} />
            <Rect
              x={bx}
              y={by}
              width={bubbleW}
              height={bubbleH}
              cornerRadius={Math.min(14, bubbleH / 2)}
              fill={bgFill(bgColor, bgOpacity)}
              stroke={ann.color}
              strokeWidth={1.5}
            />
            <Text
              x={bx + padX}
              y={by + padY}
              width={m.width}
              align={align}
              text={text}
              fontSize={fs}
              fontFamily={ff}
              fontStyle={fontStyle}
              fill={ann.color}
              stroke={strokeColor}
              strokeWidth={strokeW}
              lineHeight={1.3}
              listening={false}
            />
          </Group>
        );
      }
      case 'line': {
        const flat = ann.geometry.points.flatMap((p) => [p.x, p.y]);
        return (
          <Line
            {...baseProps}
            points={flat}
            stroke={ann.color}
            strokeWidth={ann.lineWidth}
            lineCap="round"
            lineJoin="round"
          />
        );
      }
      case 'rectangle': {
        const [a, b] = ann.geometry.points;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x);
        const h = Math.abs(b.y - a.y);
        return (
          <Rect
            {...baseProps}
            x={x}
            y={y}
            width={w}
            height={h}
            stroke={ann.color}
            strokeWidth={ann.lineWidth}
            cornerRadius={4}
          />
        );
      }
      case 'circle': {
        const [a, b] = ann.geometry.points;
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        const rx = Math.abs(b.x - a.x) / 2;
        const ry = Math.abs(b.y - a.y) / 2;
        return (
          <Ellipse
            {...baseProps}
            x={cx}
            y={cy}
            radiusX={rx}
            radiusY={ry}
            stroke={ann.color}
            strokeWidth={ann.lineWidth}
          />
        );
      }
      case 'text': {
        const fs = ann.geometry.fontSize || 22;
        const ff = ann.geometry.fontFamily || currentFontFamily;
        const px = ann.geometry.points[0].x;
        const py = ann.geometry.points[0].y;
        const hasBg = !!ann.geometry.bg;
        const bold = !!ann.geometry.bold;
        const italic = !!ann.geometry.italic;
        const align = ann.geometry.align || 'left';
        const bgColor = ann.geometry.bgColor || currentBgColor;
        const bgOpacity = ann.geometry.bgOpacity ?? currentBgOpacity;
        const hasStroke = !!ann.geometry.stroke;
        const text = ann.geometry.text || '';
        // 字体样式串（Konva 与 canvas 通用）：normal / bold / italic / italic bold
        const fontStyle = `${bold ? 'bold' : ''}${italic ? ' italic' : ''}`.trim() || 'normal';
        // 描边：按文字色亮度自动选对比轮廓色，宽度随字号缩放，保证任意截图背景下都清晰
        const strokeColor = hasStroke ? contrastStroke(ann.color) : undefined;
        const strokeW = hasStroke ? Math.max(0.8, fs * 0.1) : 0;
        const openEdit = (ev: Konva.KonvaEventObject<Event>) => {
          ev.cancelBubble = true;
          committedRef.current = false;
          clog(`文本编辑(双击): 进入编辑已有文字 id=${ann.id} 原文字长度=${text.length} 原文字前20="${(text || '').slice(0, 20)}"`);
          setEditing({ x: px, y: py, id: ann.id, text });
        };
        // 有背景底时用 Group 包一层：底衬 Rect + 文字。Group 保持原点、子元素绝对定位，
        // 与 handleDragEnd「node 位移即位移量」约定一致（同 step）。
        // 仅用 onDblClick（桌面端），不加 onDblTap 避免双触发。
        if (hasBg) {
          // 用离屏 canvas 以真实渲染字体量测文字尺寸，底衬框精确包裹全部文字
          const m = measureTextBlock(text, fs, bold, italic, ff);
          const padX = fs * 0.35;
          const padY = fs * 0.3;
          return (
            <Group {...baseProps} onDblClick={openEdit}>
              <Rect
                x={px - padX}
                y={py - padY}
                width={m.width}
                height={m.height}
                fill={bgFill(bgColor, bgOpacity)}
                cornerRadius={4}
                listening={false}
              />
              <Text
                x={px}
                y={py}
                width={m.width}
                align={align}
                text={text}
                fontSize={fs}
                fontFamily={ff}
                fontStyle={fontStyle}
                fill={ann.color}
                stroke={strokeColor}
                strokeWidth={strokeW}
                lineHeight={1.3}
                listening={false}
              />
            </Group>
          );
        }
        // 无背景：同样量测以设定 width，使对齐（左/中/右）对多行文字也生效
        const m2 = measureTextBlock(text, fs, bold, italic, ff);
        return (
          <Text
            {...baseProps}
            x={px}
            y={py}
            width={m2.width}
            align={align}
            text={text}
            fontSize={fs}
            fontFamily={ff}
            fontStyle={fontStyle}
            fill={ann.color}
            stroke={strokeColor}
            strokeWidth={strokeW}
            lineHeight={1.3}
            onDblClick={openEdit}
          />
        );
      }
      case 'freehand': {
        const flat = ann.geometry.points.flatMap((p) => [p.x, p.y]);
        return (
          <Line
            {...baseProps}
            points={flat}
            stroke={ann.color}
            strokeWidth={ann.lineWidth}
            lineCap="round"
            lineJoin="round"
            tension={0.4}
          />
        );
      }
      case 'highlight': {
        // 高亮笔：半透明色块矩形（模拟荧光笔），用 multiply 混合让底图透出
        const [a, b] = ann.geometry.points;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x);
        const h = Math.abs(b.y - a.y);
        return (
          <Rect
            {...baseProps}
            x={x}
            y={y}
            width={w}
            height={h}
            fill={ann.color}
            opacity={ann.opacity * 0.35}
            globalCompositeOperation="multiply"
          />
        );
      }
      case 'mosaic': {
        const isSolid = !!ann.geometry.solid;
        const isBrush = ann.geometry.maskMode === 'brush';

        // 涂黑遮挡：用纯色填充区域，最彻底的信息遮挡
        if (isSolid) {
          if (isBrush) {
            // 画笔涂黑：沿路径画粗线
            const flat = ann.geometry.points.flatMap((p) => [p.x, p.y]);
            const brushR = ann.geometry.brushSize ?? 20;
            return (
              <Line
                {...baseProps}
                points={flat}
                stroke={ann.color}
                strokeWidth={brushR * 2}
                lineCap="round"
                lineJoin="round"
                tension={0.4}
              />
            );
          }
          // 矩形涂黑
          const [a, b] = ann.geometry.points;
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          const w = Math.abs(b.x - a.x);
          const h = Math.abs(b.y - a.y);
          return (
            <Rect
              {...baseProps}
              x={x}
              y={y}
              width={w}
              height={h}
              fill={ann.color}
            />
          );
        }

        // 画笔打码（非涂黑）：沿路径用打码底图像素填充
        if (isBrush) {
          const pts = ann.geometry.points;
          if (pts.length < 2) return null;
          const brushR = ann.geometry.brushSize ?? 20;
          const blur = !!ann.geometry.blur;
          const st = ann.geometry.strength ?? maskStrength;
          const maskCanvas = getMaskCanvas(blur, st);
          if (!maskCanvas) return null;
          // 用 Path 沿路径裁剪打码底图：每个点画一个圆形裁剪块
          // Konva 不支持复杂裁剪路径，改用多个 KonvaImage 圆形裁剪拼接
          // 性能优化：合并相邻点（间隔大于半径才画新块）
          const filtered: Point[] = [];
          for (const p of pts) {
            const last = filtered[filtered.length - 1];
            if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= brushR * 0.5) {
              filtered.push(p);
            }
          }
          return (
            <Group {...baseProps}>
              {filtered.map((p, i) => {
                const cx = p.x - brushR;
                const cy = p.y - brushR;
                const sz = brushR * 2;
                return (
                  <KonvaImage
                    key={i}
                    image={maskCanvas}
                    x={cx}
                    y={cy}
                    width={sz}
                    height={sz}
                    crop={{ x: cx, y: cy, width: sz, height: sz }}
                    listening={false}
                  />
                );
              })}
            </Group>
          );
        }

        // 矩形打码（原有逻辑）
        const [a, b] = ann.geometry.points;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x);
        const h = Math.abs(b.y - a.y);
        const maskCanvas =
          w > 0 && h > 0
            ? getMaskCanvas(!!ann.geometry.blur, ann.geometry.strength ?? maskStrength)
            : null;
        if (maskCanvas && w > 0 && h > 0) {
          return (
            <KonvaImage
              {...baseProps}
              image={maskCanvas}
              x={x}
              y={y}
              width={w}
              height={h}
              crop={{ x, y, width: w, height: h }}
            />
          );
        }
        return (
          <Rect
            {...baseProps}
            x={x}
            y={y}
            width={w}
            height={h}
            fill="rgba(128,128,128,0.9)"
          />
        );
      }
      case 'step': {
        // 序号标注：实心圆 + 居中白色数字。圆半径随线宽轻微放大，保证不同线宽下都清晰。
        // Group 保持在原点(x/y=0)，子元素用绝对坐标定位——这样拖动时 node.x()/y() 从 0 起算，
        // 与 handleDragEnd 的「node 位移即位移量」约定一致（同 Line/freehand，避免坐标翻倍）。
        const [c] = ann.geometry.points;
        const r = 14 + ann.lineWidth * 1.5;
        const num = ann.geometry.stepNumber ?? 1;
        const fontSize = r * 1.05;
        return (
          <Group {...baseProps}>
            <Circle x={c.x} y={c.y} radius={r} fill={ann.color} />
            <Text
              x={c.x}
              y={c.y}
              text={String(num)}
              fontSize={fontSize}
              fontStyle="bold"
              fill="#ffffff"
              width={r * 2}
              height={r * 2}
              offsetX={r}
              offsetY={r}
              align="center"
              verticalAlign="middle"
              listening={false}
            />
          </Group>
        );
      }
      default:
        return null;
    }
  };

  const PAD = 8;
  const measured = box.w > 0 && box.h > 0;
  const rawScale =
    image && measured
      ? Math.min((box.w - PAD) / image.width, (box.h - PAD) / image.height, 1)
      : 1;
  // 防御：scale 必须为正数，容器尺寸异常时退回 1
  const scale = rawScale > 0 ? rawScale : 1;

  // 诊断：输出编辑器最终渲染参数（图像自然像素 / 容器 / fit缩放 / 实际显示尺寸）。
  // 依赖变化才打，避免每帧刷屏。这是判断"弹框渲染是否正确"的关键快照。
  useEffect(() => {
    if (!image) {
      clog(`渲染参数: image 尚未就绪（等待解码），box=${box.w}x${box.h} measured=${measured}`);
      return;
    }
    const dW = image.width * scale;
    const dH = image.height * scale;
    clog(
      `渲染参数快照: 图像自然=${image.width}x${image.height} 容器box=${box.w}x${box.h} measured=${measured} ` +
        `rawScale=${rawScale.toFixed(4)} scale=${scale.toFixed(4)} 显示尺寸=${dW.toFixed(0)}x${dH.toFixed(0)} ` +
        `是否缩放=${scale < 1 ? '是(缩小)' : '否(1:1)'} 溢出容器=${dW > box.w || dH > box.h ? '⚠️是' : '否'}`
    );
  }, [image, box.w, box.h, scale, rawScale, measured]);

  // 合并导出：原图 + 标注 → PNG dataURL（自然分辨率，自动剔除选中高亮框与手柄）。
  // 马赛克/模糊用 2D canvas 二次合成，保证导出与所见一致。裁剪与「保存/复制」共用此函数。
  const mergeToDataUrl = (): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      const stage = stageRef.current;
      const layer = layerRef.current;
      if (!stage || !layer || !image) {
        resolve(null);
        return;
      }
      const sb = selBoxRef.current;
      const hg = handlesRef.current;
      if (sb) sb.hide();
      if (hg) hg.hide();
      layer.batchDraw();
      let url: string | null = null;
      try {
        // pixelRatio 抵消 stage 的 fit 缩放，导出原图分辨率
        url = stage.toDataURL({ pixelRatio: 1 / scale, mimeType: 'image/png' });
      } finally {
        if (sb) sb.show();
        if (hg) hg.show();
        layer.batchDraw();
      }

      // 仅在有马赛克/模糊/涂黑标注时才做二次合成
      const mosaics = annotations.filter(
        (a) => a.geometry.type === 'mosaic' && a.geometry.points && a.geometry.points.length >= 2
      );
      if (!url || mosaics.length === 0) {
        resolve(url);
        return;
      }

      const base = new Image();
      base.onload = () => {
        const out = document.createElement('canvas');
        out.width = image.width;
        out.height = image.height;
        const ctx = out.getContext('2d');
        if (!ctx) {
          resolve(url);
          return;
        }
        // 先画 Konva 导出的底图（已含原图与全部矢量标注）
        ctx.drawImage(base, 0, 0, image.width, image.height);
        let pending = mosaics.length;
        const finish = () => resolve(out.toDataURL('image/png'));
        mosaics.forEach((ann) => {
          const pts = ann.geometry.points as Point[];
          const isSolid = !!ann.geometry.solid;
          const isBrush = ann.geometry.maskMode === 'brush';

          if (isSolid && isBrush) {
            // 画笔涂黑：沿路径画粗线
            ctx.strokeStyle = ann.color;
            ctx.lineWidth = (ann.geometry.brushSize ?? 20) * 2;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
              ctx.lineTo(pts[i].x, pts[i].y);
            }
            ctx.stroke();
          } else if (isBrush) {
            // 画笔打码：沿路径用打码底图圆形裁剪填充
            const blur = !!ann.geometry.blur;
            const st = ann.geometry.strength ?? maskStrength;
            const maskCanvas = getMaskCanvas(blur, st);
            const brushR = ann.geometry.brushSize ?? 20;
            if (maskCanvas) {
              for (const p of pts) {
                const cx = p.x - brushR;
                const cy = p.y - brushR;
                const sz = brushR * 2;
                ctx.drawImage(maskCanvas, cx, cy, sz, sz, cx, cy, sz, sz);
              }
            }
          } else {
            // 矩形打码
            const x = Math.min(pts[0].x, pts[1].x);
            const y = Math.min(pts[0].y, pts[1].y);
            const w = Math.abs(pts[1].x - pts[0].x);
            const h = Math.abs(pts[1].y - pts[0].y);
            if (isSolid) {
              ctx.fillStyle = ann.color;
              ctx.fillRect(x, y, w, h);
            } else if (w > 0 && h > 0) {
              const maskCanvas = getMaskCanvas(!!ann.geometry.blur, ann.geometry.strength ?? maskStrength);
              if (maskCanvas) {
                ctx.drawImage(maskCanvas, x, y, w, h, x, y, w, h);
              } else {
                ctx.fillStyle = 'rgba(128,128,128,0.9)';
                ctx.fillRect(x, y, w, h);
              }
            }
          }
          if (--pending === 0) finish();
        });
      };
      base.onerror = () => resolve(url);
      base.src = url;
    });
  };

  // 暴露合并导出能力（保存/复制用）
  // AI 操作过程可视化：在指定 natural-pixel 区域画一次脉冲高亮环，约 1.4s 后自动销毁。
  // 纯视觉层：不写 annotations、不进撤销历史、与 react 声明式 layer 隔离（独立 flashLayer）。
  const flashRegion = (
    rect: { x: number; y: number; w: number; h: number },
    color?: string,
    kind: 'rect' | 'redact' | 'highlight' | 'arrow' = 'rect',
  ) => {
    const layer = flashLayerRef.current;
    if (!layer) return;
    // 打码反馈用中性主题蓝（与箭头工具同色），避免刺眼红，符合「中性主题色」偏好
    const stroke =
      kind === 'redact'
        ? '#0a84ff'
        : kind === 'highlight'
          ? color || '#FFE600'
          : color || ACCENT;
    const fill =
      kind === 'redact'
        ? 'rgba(10,132,255,0.05)'
        : kind === 'highlight'
          ? bgFill(color || '#FFE600', 0.22)
          : bgFill(color || (kind === 'arrow' ? '#0a84ff' : ACCENT), 0.12);
    const group = new Konva.Group({ x: rect.x, y: rect.y });
    const ring = new Konva.Rect({
      x: 0,
      y: 0,
      width: rect.w,
      height: rect.h,
      stroke,
      strokeWidth: 2,
      cornerRadius: 4,
      fill,
      opacity: 0,
    });
    group.add(ring);
    layer.add(group);
    layer.batchDraw();
    const DUR = 1400;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / DUR);
      // 进入脉冲：0~0.25 快速亮起并轻微放大；0.25~1 缓慢淡出并维持微放大
      let op: number;
      let sc: number;
      if (p < 0.25) {
        op = p / 0.25;
        sc = 1 + 0.04 * (p / 0.25);
      } else {
        op = 1 - (p - 0.25) / 0.75;
        sc = 1.04;
      }
      ring.opacity(op);
      group.scaleX(sc);
      group.scaleY(sc);
      layer.batchDraw();
      if (p < 1) requestAnimationFrame(tick);
      else {
        group.destroy();
        layer.batchDraw();
      }
    };
    requestAnimationFrame(tick);
  };

  useImperativeHandle(
    ref,
    () => ({
      getMergedImageDataUrl: mergeToDataUrl,
      flashRegion,
    }),
    // image / annotations 变化时要刷新闭包，避免导出时拿到旧的引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scale, image, annotations]
  );

  // 应用裁剪：把当前图（含所有标注合并）按 cropRect 裁出新图，回传父组件替换编辑对象。
  const applyCrop = async () => {
    if (!cropRect || !image) return;
    const cx = Math.max(0, Math.round(cropRect.x));
    const cy = Math.max(0, Math.round(cropRect.y));
    const cw = Math.min(image.width - cx, Math.round(cropRect.w));
    const ch = Math.min(image.height - cy, Math.round(cropRect.h));
    if (cw < 1 || ch < 1) {
      setCropRect(null);
      return;
    }
    clog(`裁剪应用: 区域=(${cx},${cy},${cw}x${ch}) 原图=${image.width}x${image.height}`);
    const merged = await mergeToDataUrl();
    if (!merged) {
      setCropRect(null);
      return;
    }
    const src = new Image();
    src.onload = () => {
      const out = document.createElement('canvas');
      out.width = cw;
      out.height = ch;
      const ctx = out.getContext('2d');
      if (!ctx) {
        setCropRect(null);
        return;
      }
      ctx.drawImage(src, cx, cy, cw, ch, 0, 0, cw, ch);
      const url = out.toDataURL('image/png');
      setCropRect(null);
      onCropped?.(url, cw, ch);
      clog(`裁剪完成: 新图=${cw}x${ch}`);
    };
    src.onerror = () => setCropRect(null);
    src.src = merged;
  };

  if (!image) return <div className="canvas-loading">{t('canvas.loading')}</div>;

  const draftAnn: AnnotationObject = draft
    ? {
        id: '__draft',
        geometry: { type: draft.type, points: draft.points },
        layerId: 'default',
        color: currentColor,
        lineWidth: currentStrokeWidth,
        opacity: 1,
        properties: {},
      }
    : (null as unknown as AnnotationObject);

  const dispW = image ? image.width * scale : 0;
  const dispH = image ? image.height * scale : 0;

  // 画布内文字输入框：把自然坐标按 scale 映射到 wrapper 内的屏幕坐标。
  // 关键点：
  //  - 位置零偏移：textarea 的 left/top/padding 与 Konva 渲染的 Rect+Text 完全对齐；
  //  - 受控输入：value 绑定 editing.text，确保中文正常落字；
  //  - IME 安全：输入法合成期间不拦截 Enter；
  //  - onBlur 安全提交：toolbar 交互时不提交、延迟拉回焦点；其他失焦才提交；
  //  - 最小尺寸：新建空文字时给足够大的初始框（不是只量一个空格的宽度）。
  const textEditor = editing
    ? (() => {
        const offX = (box.w - dispW) / 2;
        const offY = (box.h - dispH) / 2;
        const ed = editing.id ? annotations.find((a) => a.id === editing.id) : undefined;
        const efs = ed?.geometry.fontSize ?? currentFontSize;
        const ebold = ed ? !!ed.geometry.bold : currentBold;
        const eitalic = ed ? !!ed.geometry.italic : currentItalic;
        const ealign = ed?.geometry.align ?? currentAlign;
        const efont = ed?.geometry.fontFamily ?? currentFontFamily;
        const ebg = ed ? !!ed.geometry.bg : currentTextBg;
        const ebgColor = ed?.geometry.bgColor ?? currentBgColor;
        const ebgOpacity = ed?.geometry.bgOpacity ?? currentBgOpacity;
        const eStroke = ed ? !!ed.geometry.stroke : currentTextStroke;
        const textColor = ed?.color ?? currentColor;
        const liveText = editing.text ?? '';
        const m = measureTextBlock(liveText || ' ', efs, ebold, eitalic, efont);
        const padX = efs * 0.35;
        const padY = efs * 0.3;
        // 最小宽度：给 8 个中文字宽的初始空间，打字后随内容自适应
        const minW = efs * 8;
        const tw = Math.max(m.width, minW) * scale;
        const th = Math.max(m.height, efs * 1.3 + padY * 2) * scale;
        return (
          <textarea
            ref={taRef}
            value={liveText}
            placeholder={t('canvas.textPlaceholder')}
            onChange={(e) => setEditing((s) => (s ? { ...s, text: e.target.value } : s))}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(e) => {
              const ta = e.target as HTMLTextAreaElement;
              if (e.key === 'Enter' && !e.shiftKey) {
                if (composingRef.current || (e.nativeEvent as any).isComposing || e.keyCode === 229) return;
                e.preventDefault();
                commitText(ta.value, { x: editing.x, y: editing.y }, editing.id);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                committedRef.current = true;
                refocusRef.current = false;
                setEditing(null);
              }
            }}
            onBlur={(e) => {
              const rt = e.relatedTarget as HTMLElement | null;
              const goToToolbar = rt && (rt.closest('.toolbar-center') || rt.closest('.tool-tip-float'));
              if (goToToolbar) {
                // 焦点转到工具栏：不提交，延迟拉回焦点。
                // 用 ref 标记，若用户在 rAF 前点击了别处（editing 已变），则取消拉回。
                refocusRef.current = true;
                requestAnimationFrame(() => {
                  if (refocusRef.current && taRef.current && document.contains(taRef.current)) {
                    taRef.current.focus();
                  }
                  refocusRef.current = false;
                });
                return;
              }
              refocusRef.current = false;
              const ta = e.target as HTMLTextAreaElement;
              commitText(ta.value, { x: editing.x, y: editing.y }, editing.id);
            }}
            style={{
              position: 'absolute',
              left: offX + (editing.x - padX) * scale,
              top: offY + (editing.y - padY) * scale,
              width: tw,
              height: th,
              fontSize: efs * scale,
              fontWeight: ebold ? 700 : 400,
              fontStyle: eitalic ? 'italic' : 'normal',
              fontFamily: efont,
              textAlign: ealign,
              lineHeight: 1.3,
              color: textColor,
              // 开启背景时用底衬色（含透明度，覆盖整个输入框，所见即所得）；否则用编辑器实体底色
              background: ebg ? bgFill(ebgColor, ebgOpacity) : 'var(--surface-solid)',
              // 描边：开启时用与渲染一致的自动对比色轮廓，保证编辑预览与最终渲染一致
              WebkitTextStroke: eStroke ? `${Math.max(0.8, efs * 0.1 * scale).toFixed(2)}px ${contrastStroke(textColor)}` : '0',
              border: `1.5px solid ${ACCENT}80`,
              borderRadius: 4,
              padding: `${padY * scale}px ${padX * scale}px`,
              boxSizing: 'border-box',
              outline: 'none',
              overflow: 'hidden',
              resize: 'none',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              zIndex: 10,
            }}
          />
        );
      })()
    : null;

  // 控制点手柄：选中「矩形/圆/马赛克/高亮」显示 4 角，「直线/箭头」显示 2 端点。
  // 拖动手柄直接改对应的点；freehand/text/step 无手柄。手柄尺寸抵消画布缩放，视觉恒定。
  const selectedAnn =
    activeTool === 'select' && selectedId ? annotations.find((a) => a.id === selectedId) : undefined;

  const resizeHandles = (() => {
    if (!selectedAnn) return null;
    const g = selectedAnn.geometry;
    // resize 进行中用实时点
    const pts = resizing && resizing.id === selectedAnn.id ? resizing.points : g.points;
    const hr = 5 / scale; // 手柄半径（自然像素，抵消缩放）

    // 提交实时点到 store（拖动结束）
    const commit = (points: Point[]) => {
      updateAnnotation(selectedAnn.id, { geometry: { ...g, points } });
      setResizing(null);
    };

    // 边框对角两点型（rectangle/circle/mosaic/highlight）：4 角手柄
    if (g.type === 'rectangle' || g.type === 'circle' || g.type === 'mosaic' || g.type === 'highlight') {
      const [a, b] = pts;
      const x0 = Math.min(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const x1 = Math.max(a.x, b.x);
      const y1 = Math.max(a.y, b.y);
      const corners: { key: string; x: number; y: number }[] = [
        { key: 'tl', x: x0, y: y0 },
        { key: 'tr', x: x1, y: y0 },
        { key: 'bl', x: x0, y: y1 },
        { key: 'br', x: x1, y: y1 },
      ];
      return corners.map((c) => (
        <Circle
          key={c.key}
          x={c.x}
          y={c.y}
          radius={hr}
          fill="#ffffff"
          stroke={ACCENT}
          strokeWidth={1.5 / scale}
          draggable
          onMouseDown={(ev) => {
            ev.cancelBubble = true;
          }}
          onDragMove={(ev) => {
            ev.cancelBubble = true;
            const nx = ev.target.x();
            const ny = ev.target.y();
            // 固定对角，另一角随手柄移动 → 重建两点
            const fixedX = c.key === 'tl' || c.key === 'bl' ? x1 : x0;
            const fixedY = c.key === 'tl' || c.key === 'tr' ? y1 : y0;
            setResizing({ id: selectedAnn.id, points: [{ x: fixedX, y: fixedY }, { x: nx, y: ny }] });
          }}
          onDragEnd={(ev) => {
            ev.cancelBubble = true;
            const nx = ev.target.x();
            const ny = ev.target.y();
            const fixedX = c.key === 'tl' || c.key === 'bl' ? x1 : x0;
            const fixedY = c.key === 'tl' || c.key === 'tr' ? y1 : y0;
            commit([{ x: fixedX, y: fixedY }, { x: nx, y: ny }]);
          }}
        />
      ));
    }

    // 两端点型（line/arrow/callout）：2 端点手柄（callout = 锚点 + 气泡中心）
    if (g.type === 'line' || g.type === 'arrow' || g.type === 'callout') {
      return pts.map((p, i) => (
        <Circle
          key={i}
          x={p.x}
          y={p.y}
          radius={hr}
          fill="#ffffff"
          stroke={ACCENT}
          strokeWidth={1.5 / scale}
          draggable
          onMouseDown={(ev) => {
            ev.cancelBubble = true;
          }}
          onDragMove={(ev) => {
            ev.cancelBubble = true;
            const next = pts.map((q, j) => (j === i ? { x: ev.target.x(), y: ev.target.y() } : q));
            setResizing({ id: selectedAnn.id, points: next });
          }}
          onDragEnd={(ev) => {
            ev.cancelBubble = true;
            const next = pts.map((q, j) => (j === i ? { x: ev.target.x(), y: ev.target.y() } : q));
            commit(next);
          }}
        />
      ));
    }

    return null;
  })();

  return (
    <div
      ref={wrapRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: activeTool === 'crop' ? 'crosshair' : undefined,
      }}
    >
      <Stage
        width={dispW}
        height={dispH}
        scaleX={scale}
        scaleY={scale}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        ref={stageRef}
      >
        <Layer>
          {/* 背景截图不接收事件：点击图片区域时事件落到 stage，从而「点击空白处可取消选中」 */}
          <KonvaImage image={image} listening={false} />
        </Layer>
        <Layer ref={layerRef}>
          {annotations.map((ann) => {
            // 正在通过控制点调整的标注：用实时点覆盖渲染
            const eff =
              resizing && resizing.id === ann.id
                ? { ...ann, geometry: { ...ann.geometry, points: resizing.points } }
                : ann;
            return renderShape(eff, false);
          })}
          {draft && renderShape(draftAnn, true)}
          {selBox && !resizing && (
            <Rect
              ref={selBoxRef}
              x={selBox.x}
              y={selBox.y}
              width={selBox.width}
              height={selBox.height}
              stroke={ACCENT}
              strokeWidth={1.5}
              dash={[6, 4]}
              listening={false}
            />
          )}
          {resizeHandles && <Group ref={handlesRef}>{resizeHandles}</Group>}
        </Layer>
        {/* 裁剪遮罩层：裁剪框外部压暗，框内清晰，框边高亮虚线 */}
        {cropRect && (
          <Layer listening={false}>
            {/* 四周压暗（上/下/左/右） */}
            <Rect x={0} y={0} width={image.width} height={cropRect.y} fill="rgba(0,0,0,0.5)" />
            <Rect
              x={0}
              y={cropRect.y + cropRect.h}
              width={image.width}
              height={Math.max(0, image.height - cropRect.y - cropRect.h)}
              fill="rgba(0,0,0,0.5)"
            />
            <Rect x={0} y={cropRect.y} width={cropRect.x} height={cropRect.h} fill="rgba(0,0,0,0.5)" />
            <Rect
              x={cropRect.x + cropRect.w}
              y={cropRect.y}
              width={Math.max(0, image.width - cropRect.x - cropRect.w)}
              height={cropRect.h}
              fill="rgba(0,0,0,0.5)"
            />
            {/* 裁剪框边 */}
            <Rect
              x={cropRect.x}
              y={cropRect.y}
              width={cropRect.w}
              height={cropRect.h}
              stroke={ACCENT}
              strokeWidth={1.5 / scale}
              dash={[6 / scale, 4 / scale]}
            />
          </Layer>
        )}
        {/* AI 操作可视化层：命令式 add/remove 脉冲高亮，常驻空 layer，不影响标注/撤销 */}
        <Layer ref={flashLayerRef} listening={false} />
      </Stage>
      {textEditor}
      {/* 裁剪确认条：拖出裁剪框且有效尺寸且拖拽已结束时显示，浮在裁剪框下方居中 */}
      {cropRect && cropRect.w >= 8 && cropRect.h >= 8 && !cropDragging && !ocrRegionMode && (() => {
        const offX = (box.w - dispW) / 2;
        const offY = (box.h - dispH) / 2;
        const left = offX + (cropRect.x + cropRect.w / 2) * scale;
        const top = offY + (cropRect.y + cropRect.h) * scale + 10;
        return (
          <div
            className="crop-confirm-bar"
            style={{
              position: 'absolute',
              left,
              top,
              transform: 'translateX(-50%)',
              display: 'flex',
              gap: 8,
              zIndex: 20,
              background: 'var(--surface-solid)',
              border: '1px solid var(--border-soft)',
              borderRadius: 10,
              padding: '6px 8px',
              boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
            }}
          >
            <span style={{ alignSelf: 'center', fontSize: 12, opacity: 0.7, padding: '0 4px' }}>
              {Math.round(cropRect.w)}×{Math.round(cropRect.h)}
            </span>
            <button className="crop-btn crop-cancel" onClick={() => setCropRect(null)}>
              {t('crop.cancel')}
            </button>
            <button className="crop-btn crop-apply" onClick={applyCrop}>
              {t('crop.apply')}
            </button>
          </div>
        );
      })()}
      </div>
  );
});

AnnotationCanvas.displayName = 'AnnotationCanvas';

export { AnnotationCanvas };
export default AnnotationCanvas;
