import { Stage, Layer, Image as KonvaImage, Line, Rect, Ellipse, Text } from 'react-konva';
import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import type Konva from 'konva';
import { useScreenshotStore } from '../store/screenshotStore';
import type { AnnotationObject, AnnotationGeometry, Point } from '../types';

interface AnnotationCanvasProps {
  imageData: string;
  annotations: AnnotationObject[];
  onAnnotationAdd: (annotation: AnnotationObject) => void;
  activeTool: string | null;
}

export interface AnnotationCanvasHandle {
  /** 把原图 + 所有标注合并导出为 PNG dataURL（自然分辨率，自动剔除选中高亮框） */
  getMergedImageDataUrl: () => string | null;
}

const genId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const ACCENT = '#007aff';

const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(({
  imageData,
  annotations,
  onAnnotationAdd,
  activeTool,
}: AnnotationCanvasProps, ref) => {
  const stageRef = useRef<Konva.Stage | null>(null);
  const layerRef = useRef<Konva.Layer | null>(null);
  const shapeRefs = useRef<Record<string, Konva.Node | null>>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const committedRef = useRef(false);
  const selBoxRef = useRef<Konva.Rect | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [draft, setDraft] = useState<{ type: AnnotationGeometry['type']; points: Point[] } | null>(null);
  const [selBox, setSelBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [editing, setEditing] = useState<{ x: number; y: number; id?: string; text?: string } | null>(null);
  const [imageError, setImageError] = useState(false);

  const {
    selectedId,
    setSelectedId,
    updateAnnotation,
    deleteAnnotation,
    undo,
    redo,
    currentColor,
    currentStrokeWidth,
  } = useScreenshotStore();

  useEffect(() => {
    if (!imageData) return;
    const img = new Image();
    img.onload = () => { setImage(img); setImageError(false); };
    // 损坏 dataUrl 时给错误态，否则永远"加载中…"无反馈
    img.onerror = () => { setImage(null); setImageError(true); };
    img.src = imageData;
  }, [imageData]);

  // 测量容器尺寸，供画布自适应缩放（4K 截图不再溢出容器）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
  useEffect(() => {
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
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId) {
          // Backspace 在 Tauri webview 可能触发后退导航，必须拦截
          e.preventDefault();
          deleteAnnotation(selectedId);
          setSelectedId(null);
        }
      } else if (e.key === 'Escape') {
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, deleteAnnotation, setSelectedId, undo, redo]);

  // 提交画布内文字（Enter 或失焦触发），用 ref 防止重复提交
  // 若带 id 则是编辑已有文字（走 updateAnnotation），否则新增（走 onAnnotationAdd）
  const commitText = (value: string, pos: { x: number; y: number }, id?: string) => {
    if (committedRef.current) return;
    committedRef.current = true;
    const t = value.trim();
    if (t) {
      if (id) {
        updateAnnotation(id, {
          geometry: { type: 'text', points: [{ x: pos.x, y: pos.y }], text: t, fontSize: 22 },
        });
      } else {
        onAnnotationAdd({
          id: genId(),
          geometry: { type: 'text', points: [{ x: pos.x, y: pos.y }], text: t, fontSize: 22 },
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

  const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (!image || !activeTool) return;
    const stage = e.target.getStage();
    if (!stage) return;
    const pos = stage.getRelativePointerPosition();
    if (!pos) return;

    if (activeTool === 'select') {
      if (e.target === stage) setSelectedId(null);
      return;
    }

    if (activeTool === 'text') {
      // 画布内文字输入框，替代原生 window.prompt
      committedRef.current = false;
      setEditing({ x: pos.x, y: pos.y });
      return;
    }

    if (activeTool === 'freehand') {
      setDraft({ type: 'freehand', points: [pos] });
    } else {
      setDraft({ type: activeTool as AnnotationGeometry['type'], points: [pos, pos] });
    }
  };

  const handleMouseMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (!draft) return;
    const stage = e.target.getStage();
    if (!stage) return;
    const pos = stage.getRelativePointerPosition();
    if (!pos) return;
    if (draft.type === 'freehand') {
      setDraft({ type: 'freehand', points: [...draft.points, pos] });
    } else {
      setDraft({ type: draft.type, points: [draft.points[0], pos] });
    }
  };

  const handleMouseUp = () => {
    if (!draft) return;
    const pts = draft.points;
    let ok = false;
    if (draft.type === 'freehand') ok = pts.length >= 2;
    else {
      const [a, b] = pts;
      ok = Math.abs(b.x - a.x) >= 3 || Math.abs(b.y - a.y) >= 3;
    }
    if (ok) {
      onAnnotationAdd({
        id: genId(),
        geometry: { type: draft.type, points: pts },
        layerId: 'default',
        color: currentColor,
        lineWidth: currentStrokeWidth,
        opacity: 1,
        properties: {},
      });
    }
    setDraft(null);
  };

  const handleDragEnd = (e: Konva.KonvaEventObject<DragEvent>, ann: AnnotationObject) => {
    const node = e.target;
    const dx = node.x();
    const dy = node.y();
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    const shifted = ann.geometry.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    updateAnnotation(ann.id, { geometry: { ...ann.geometry, points: shifted } });
    node.position({ x: 0, y: 0 });
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
          onDragEnd: (ev: Konva.KonvaEventObject<DragEvent>) => handleDragEnd(ev, ann),
          onDragMove: (ev: Konva.KonvaEventObject<DragEvent>) => updateSelBox(ev.target),
          opacity: ann.opacity,
        };

    switch (ann.geometry.type) {
      case 'arrow':
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
            {...(ann.geometry.type === 'arrow' ? { arrow: true, pointerLength: 12, pointerWidth: 10 } : {})}
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
        return (
          <Text
            {...baseProps}
            x={ann.geometry.points[0].x}
            y={ann.geometry.points[0].y}
            text={ann.geometry.text || ''}
            fontSize={ann.geometry.fontSize || 22}
            fill={ann.color}
            onDblClick={(ev) => {
              ev.cancelBubble = true;
              // 重置提交锁，否则首次新建后 commitText 直接 return，编辑内容丢失
              committedRef.current = false;
              setEditing({ x: ann.geometry.points[0].x, y: ann.geometry.points[0].y, id: ann.id, text: ann.geometry.text || '' });
            }}
            onDblTap={(ev) => {
              ev.cancelBubble = true;
              committedRef.current = false;
              setEditing({ x: ann.geometry.points[0].x, y: ann.geometry.points[0].y, id: ann.id, text: ann.geometry.text || '' });
            }}
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
      default:
        return null;
    }
  };

  const PAD = 16;
  const measured = box.w > 0 && box.h > 0;
  const scale =
    image && measured
      ? Math.min((box.w - PAD) / image.width, (box.h - PAD) / image.height, 1)
      : 1;

  // 暴露合并导出能力：原图 + 标注 → PNG（自然分辨率，自动剔除选中高亮框）
  useImperativeHandle(
    ref,
    () => ({
      getMergedImageDataUrl: () => {
        const stage = stageRef.current;
        const layer = layerRef.current;
        if (!stage || !layer) return null;
        const sb = selBoxRef.current;
        if (sb) sb.hide();
        layer.batchDraw();
        let url: string | null = null;
        try {
          // pixelRatio 抵消 stage 的 fit 缩放，导出原图分辨率
          url = stage.toDataURL({ pixelRatio: 1 / scale, mimeType: 'image/png' });
        } finally {
          if (sb) {
            sb.show();
            layer.batchDraw();
          }
        }
        return url;
      },
    }),
    [scale]
  );

  if (imageError) return <div className="canvas-loading">图片加载失败（数据可能损坏）</div>;
  if (!image) return <div className="canvas-loading">加载中…</div>;

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

  // 画布内文字输入框：把自然坐标按 scale 映射到 wrapper 内的屏幕坐标
  const textEditor = editing
    ? (() => {
        const offX = (box.w - dispW) / 2;
        const offY = (box.h - dispH) / 2;
        return (
          <textarea
            autoFocus
            defaultValue={editing?.text ?? ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitText((e.target as HTMLTextAreaElement).value, editing, editing.id);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(null);
              }
            }}
            onBlur={(e) => commitText(e.target.value, editing, editing.id)}
            style={{
              position: 'absolute',
              left: offX + editing.x * scale,
              top: offY + editing.y * scale,
              width: 220,
              minHeight: 30,
              fontSize: 22 * scale,
              lineHeight: 1.25,
              color: currentColor,
              background: 'var(--surface-solid)',
              border: `1px solid ${currentColor}`,
              borderRadius: 6,
              padding: '2px 6px',
              outline: 'none',
              zIndex: 10,
              resize: 'both',
              fontFamily: 'inherit',
            }}
          />
        );
      })()
    : null;

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
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
          <KonvaImage image={image} />
        </Layer>
        <Layer ref={layerRef}>
          {annotations.map((ann) => renderShape(ann, false))}
          {draft && renderShape(draftAnn, true)}
          {selBox && (
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
        </Layer>
      </Stage>
      {textEditor}
      </div>
  );
});

AnnotationCanvas.displayName = 'AnnotationCanvas';

export { AnnotationCanvas };
export default AnnotationCanvas;
