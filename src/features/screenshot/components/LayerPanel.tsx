import { useScreenshotStore } from '../store/screenshotStore';

/**
 * 图层面板：编辑页侧栏。
 * - 列出所有图层（栈顶在上）
 * - 点击切换活动图层（新标注归到活动层）
 * - 显隐 / 锁定 / 删除（default 层不可删）
 * - 新建图层
 */
export const LayerPanel = () => {
  const { layers, activeLayerId, setActiveLayer, addLayer, updateLayer, deleteLayer } =
    useScreenshotStore();

  const newLayer = () => {
    const id = `layer-${Date.now()}`;
    addLayer({
      id,
      name: `图层 ${layers.length}`,
      visible: true,
      locked: false,
      objects: [],
    });
    setActiveLayer(id);
  };

  const itemStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 8px',
    borderRadius: 6,
    cursor: 'pointer',
    background: active ? 'var(--surface-strong, rgba(0,122,255,0.12))' : 'transparent',
    fontSize: 13,
  });

  const iconBtn: React.CSSProperties = {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: 2,
    fontSize: 14,
    opacity: 0.8,
  };

  return (
    <div
      style={{
        width: 180,
        flexShrink: 0,
        borderRight: '1px solid var(--border-tertiary, rgba(0,0,0,0.1))',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface-secondary, #fafafa)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 10px',
          fontWeight: 500,
          fontSize: 13,
          borderBottom: '1px solid var(--border-tertiary, rgba(0,0,0,0.08))',
        }}
      >
        <span>图层</span>
        <button onClick={newLayer} title="新建图层" style={iconBtn}>
          ＋
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 4 }}>
        {[...layers].reverse().map((l) => (
          <div
            key={l.id}
            style={itemStyle(l.id === activeLayerId)}
            onClick={() => setActiveLayer(l.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActiveLayer(l.id);
              }
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                updateLayer(l.id, { visible: !l.visible });
              }}
              title={l.visible ? '隐藏' : '显示'}
              style={iconBtn}
            >
              {l.visible ? '👁' : '—'}
            </button>
            <span style={{ flex: 1, opacity: l.visible ? 1 : 0.5 }}>{l.name}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                updateLayer(l.id, { locked: !l.locked });
              }}
              title={l.locked ? '解锁' : '锁定'}
              style={iconBtn}
            >
              {l.locked ? '🔒' : '🔓'}
            </button>
            {l.id !== 'default' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteLayer(l.id);
                }}
                title="删除"
                style={iconBtn}
              >
                🗑
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default LayerPanel;
