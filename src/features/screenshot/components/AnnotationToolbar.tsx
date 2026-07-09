import { useScreenshotStore } from '../store/screenshotStore';

const TOOLS = [
  { id: 'select', icon: '↖️', name: '选择' },
  { id: 'arrow', icon: '➡️', name: '箭头' },
  { id: 'line', icon: '📏', name: '直线' },
  { id: 'rectangle', icon: '⬜', name: '矩形' },
  { id: 'circle', icon: '⭕', name: '圆形' },
  { id: 'text', icon: '📝', name: '文字' },
  { id: 'freehand', icon: '✏️', name: '自由绘制' },
  { id: 'highlight', icon: '🖍️', name: '高亮' },
  { id: 'mosaic', icon: '🔲', name: '马赛克' },
  { id: 'number', icon: '🔢', name: '序号' },
];

// 主题感知的标注调色板
const COLORS = ['#ff3b30', '#007aff', '#34c759', '#ffcc00', '#ffffff', '#1d1d1f'];
const WIDTHS = [2, 4, 6, 8];

export const AnnotationToolbar = () => {
  const {
    activeTool,
    setActiveTool,
    selectedId,
    deleteAnnotation,
    setSelectedId,
    undo,
    redo,
    past,
    future,
    currentColor,
    setCurrentColor,
    currentStrokeWidth,
    setCurrentStrokeWidth,
  } = useScreenshotStore();

  const handleDelete = () => {
    if (selectedId) {
      deleteAnnotation(selectedId);
      setSelectedId(null);
    }
  };

  return (
    <div className="toolbar-center">
      {TOOLS.map((tool) => (
        <button
          key={tool.id}
          className={`tool-btn${activeTool === tool.id ? ' active' : ''}`}
          title={tool.name}
          aria-label={tool.name}
          aria-pressed={activeTool === tool.id}
          onClick={() => setActiveTool(tool.id)}
        >
          <span style={{ fontSize: '18px' }}>{tool.icon}</span>
        </button>
      ))}

      <div className="tool-divider" />

      {/* 颜色选择 */}
      <div className="swatch-group" role="group" aria-label="标注颜色">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`swatch${currentColor === c ? ' active' : ''}`}
            style={{ background: c }}
            title={c}
            aria-label={`颜色 ${c}`}
            aria-pressed={currentColor === c}
            onClick={() => setCurrentColor(c)}
          />
        ))}
      </div>

      <div className="tool-divider" />

      {/* 线宽选择 */}
      <div className="width-group" role="group" aria-label="线宽">
        {WIDTHS.map((w) => (
          <button
            key={w}
            className={`tool-btn${currentStrokeWidth === w ? ' active' : ''}`}
            title={`线宽 ${w}px`}
            aria-label={`线宽 ${w} 像素`}
            aria-pressed={currentStrokeWidth === w}
            onClick={() => setCurrentStrokeWidth(w)}
          >
            <span
              style={{
                display: 'block',
                width: '20px',
                borderTop: `${Math.max(1, w * 0.6)}px solid currentColor`,
              }}
            />
          </button>
        ))}
      </div>

      <div className="tool-divider" />

      <button
        className="tool-btn"
        title="撤销 (Ctrl/⌘+Z)"
        aria-label="撤销"
        disabled={past.length === 0}
        onClick={undo}
      >
        <span style={{ fontSize: '18px' }}>↶</span>
      </button>
      <button
        className="tool-btn"
        title="重做 (Ctrl/⌘+Shift+Z)"
        aria-label="重做"
        disabled={future.length === 0}
        onClick={redo}
      >
        <span style={{ fontSize: '18px' }}>↷</span>
      </button>

      <div className="tool-divider" />

      <button
        className="tool-btn"
        title="删除选中"
        aria-label="删除选中"
        disabled={!selectedId}
        onClick={handleDelete}
      >
        <span style={{ fontSize: '18px' }}>🗑️</span>
      </button>
    </div>
  );
};

export default AnnotationToolbar;
