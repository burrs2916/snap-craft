import type { ReactNode } from 'react';
import { useState, useCallback } from 'react';
import { useScreenshotStore } from '../store/screenshotStore';
import { useI18n, t } from '../../../i18n';
import { useLicenseStore } from '../../licensing/licenseStore';
import { useUpgradeDialogStore } from '../../licensing/upgradeDialogStore';

/* ── 统一线性图标（stroke=currentColor，跟随主题与选中态）────────── */
const Icon = ({ children }: { children: ReactNode }) => (
  <svg
    width="19"
    height="19"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const ICONS: Record<string, ReactNode> = {
  select: <path d="M5 3l6 15 2.2-6.2L19 9.5 5 3z" />,
  arrow: (
    <>
      <path d="M5 12h13" />
      <path d="M12.5 6.5L19 12l-6.5 5.5" />
    </>
  ),
  line: <path d="M5 19L19 5" />,
  rectangle: <rect x="4" y="6" width="16" height="12" rx="2" />,
  circle: <circle cx="12" cy="12" r="8" />,
  text: (
    <>
      <path d="M6 6h12" />
      <path d="M12 6v13" />
      <path d="M9.5 19h5" />
    </>
  ),
  freehand: (
    <>
      <path d="M4 20c2-.4 3.5-1 5-2.5L18 8.5 15.5 6 6.5 15C5 16.5 4.4 18 4 20z" />
      <path d="M14 7.5L16.5 10" />
    </>
  ),
  mosaic: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <path d="M4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16" strokeWidth="1.2" />
      <rect x="4" y="4" width="5.3" height="5.3" fill="currentColor" stroke="none" opacity="0.9" />
      <rect x="14.6" y="9.3" width="5.4" height="5.3" fill="currentColor" stroke="none" opacity="0.9" />
      <rect x="9.3" y="14.6" width="5.3" height="5.4" fill="currentColor" stroke="none" opacity="0.9" />
    </>
  ),
  step: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="10"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
      >
        1
      </text>
    </>
  ),
  crop: (
    <>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M2 6h14a2 2 0 0 1 2 2v14" />
    </>
  ),
  highlight: (
    <>
      <path d="M4 20h16" strokeWidth="2.4" opacity="0.5" />
      <path d="M5 14.5l7-9 4 3-7 9-4.5.8L5 14.5z" />
      <path d="M12 5.5l4 3" />
    </>
  ),
  undo: (
    <>
      <path d="M8 8L3.5 12 8 16" />
      <path d="M3.5 12H14a5.5 5.5 0 0 1 0 11h-3" />
    </>
  ),
  redo: (
    <>
      <path d="M16 8l4.5 4L16 16" />
      <path d="M20.5 12H10a5.5 5.5 0 0 0 0 11h3" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4.5h6V7" />
      <path d="M6.5 7l1 13h9l1-13" />
      <path d="M10 11v6M14 11v6" strokeWidth="1.4" />
    </>
  ),
};

const TOOLS = [
  { id: 'select', hint: '1' },
  { id: 'arrow', hint: '2' },
  { id: 'line', hint: '3' },
  { id: 'rectangle', hint: '4' },
  { id: 'circle', hint: '5' },
  { id: 'text', hint: '6' },
  { id: 'freehand', hint: '7' },
  { id: 'highlight', hint: '8' },
  { id: 'mosaic', hint: '9' },
  { id: 'step', hint: '0' },
  { id: 'crop', hint: 'C' },
];

// 主题感知的标注调色板：漂亮常用的系统色（覆盖红/橙/黄/绿/青/蓝/紫/粉/黑白）
const COLORS = [
  '#ff3b30', // 红
  '#ff9500', // 橙
  '#ffcc00', // 黄
  '#34c759', // 绿
  '#00c7be', // 青
  '#30b0c7', // 蓝绿
  '#007aff', // 蓝
  '#5856d6', // 靛
  '#af52de', // 紫
  '#ff2d55', // 粉
  '#ffffff', // 白
  '#1d1d1f', // 黑
];
const WIDTHS = [2, 4, 6, 8];

// 可选字体：跨平台通用字体族（macOS / Windows / 通用 Web 安全字体 + 中文 + 手书体）
// value 为直接写入 CSS font-family / Konva fontFamily 的字体栈；每个栈都带安全兜底，
// 某字体本机未安装时自动回退到下一款，绝不出现「无字体可渲染」的空白。
// labelKey 指向 i18n 的 font.* 词条：字体显示名随界面语言切换（中文环境显示
// 「苹方 / 微软雅黑」，英文环境显示「PingFang / Microsoft YaHei」），value 不变。
const FONTS: { id: string; labelKey: string; value: string }[] = [
  { id: 'system', labelKey: 'font.system', value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
  { id: 'pingfang', labelKey: 'font.pingfang', value: "'PingFang SC', 'Helvetica Neue', 'Microsoft YaHei', sans-serif" },
  { id: 'yahei', labelKey: 'font.yahei', value: "'Microsoft YaHei', 'PingFang SC', 'Heiti SC', sans-serif" },
  { id: 'kaiti', labelKey: 'font.kaiti', value: "'Kaiti SC', 'STKaiti', KaiTi, 'PingFang SC', serif" },
  { id: 'heiti', labelKey: 'font.heiti', value: "'STHeiti', 'Heiti SC', 'SimHei', 'PingFang SC', sans-serif" },
  { id: 'fangsong', labelKey: 'font.fangsong', value: "FangSong, STFangsong, 'FangSong_GB2312', 'Songti SC', serif" },
  { id: 'aria', labelKey: 'font.arial', value: "Arial, 'Helvetica Neue', Helvetica, sans-serif" },
  { id: 'verdana', labelKey: 'font.verdana', value: "Verdana, Geneva, 'Segoe UI', sans-serif" },
  { id: 'trebuchet', labelKey: 'font.trebuchet', value: "'Trebuchet MS', 'Segoe UI', Verdana, sans-serif" },
  { id: 'optima', labelKey: 'font.optima', value: "Optima, 'Optima Nova', 'Segoe UI', sans-serif" },
  { id: 'georgia', labelKey: 'font.georgia', value: "Georgia, 'Times New Roman', 'Songti SC', serif" },
  { id: 'palatino', labelKey: 'font.palatino', value: "Palatino, 'Palatino Linotype', 'Book Antiqua', Georgia, serif" },
  { id: 'times', labelKey: 'font.times', value: "'Times New Roman', SimSun, 'Songti SC', serif" },
  { id: 'courier', labelKey: 'font.courier', value: "'Courier New', 'SF Mono', Consolas, monospace" },
  { id: 'menlo', labelKey: 'font.menlo', value: "Menlo, Monaco, 'Courier New', Consolas, monospace" },
  { id: 'impact', labelKey: 'font.impact', value: "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif" },
  { id: 'comic', labelKey: 'font.comic', value: "'Comic Sans MS', 'Chalkboard SE', cursive" },
  { id: 'script', labelKey: 'font.script', value: "'Snell Roundhand', 'Brush Script MT', 'STKaiti', cursive" },
];

// 对齐图标（左 / 中 / 右）
const ALIGN_ICONS: Record<'left' | 'center' | 'right', ReactNode> = {
  left: (
    <>
      <path d="M4 6h16" />
      <path d="M4 10h10" />
      <path d="M4 14h16" />
      <path d="M4 18h10" />
    </>
  ),
  center: (
    <>
      <path d="M4 6h16" />
      <path d="M7 10h10" />
      <path d="M4 14h16" />
      <path d="M7 18h10" />
    </>
  ),
  right: (
    <>
      <path d="M4 6h16" />
      <path d="M10 10h10" />
      <path d="M4 14h16" />
      <path d="M10 18h10" />
    </>
  ),
};

// 浮层 tooltip 的状态：用 position:fixed 渲染到工具栏之外，
// 从而不受 .toolbar-center 的 overflow 裁剪影响（否则横向滚动容器会裁掉向上弹出的提示）。
type TipState = { name: string; hint?: string; x: number; y: number } | null;

export const AnnotationToolbar = () => {
  useI18n(); // 订阅语言变化，切换时自动重渲染
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
    currentStrokeWidth,
    updateAnnotation,
    platform,
    annotations,
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
    updateStyle,
  } = useScreenshotStore();

  // 当前选中标注（用于上下文控件回显/联动）
  const selected = selectedId ? annotations.find((a) => a.id === selectedId) : undefined;
  const selType = selected?.geometry.type;

  // 上下文控件的显示条件：按当前工具或选中标注类型决定
  const showTextCtl = activeTool === 'text' || selType === 'text';
  const showMaskCtl = activeTool === 'mosaic' || selType === 'mosaic';

  // 文字样式：优先反映选中标注的真实值，否则用全局默认
  const fontSizeVal = selType === 'text' ? (selected?.geometry.fontSize ?? currentFontSize) : currentFontSize;
  const boldVal = selType === 'text' ? !!selected?.geometry.bold : currentBold;
  const italicVal = selType === 'text' ? !!selected?.geometry.italic : currentItalic;
  const alignVal = selType === 'text' ? (selected?.geometry.align ?? currentAlign) : currentAlign;
  const fontVal = selType === 'text' ? (selected?.geometry.fontFamily ?? currentFontFamily) : currentFontFamily;
  const bgVal = selType === 'text' ? !!selected?.geometry.bg : currentTextBg;
  const bgColorVal = selType === 'text' ? (selected?.geometry.bgColor ?? currentBgColor) : currentBgColor;
  const bgOpacityVal = selType === 'text' ? (selected?.geometry.bgOpacity ?? currentBgOpacity) : currentBgOpacity;
  const strokeVal = selType === 'text' ? !!selected?.geometry.stroke : currentTextStroke;
  // 打码：优先反映选中标注
  const blurVal = selType === 'mosaic' ? !!selected?.geometry.blur : maskBlur;
  const strengthVal = selType === 'mosaic' ? (selected?.geometry.strength ?? maskStrength) : maskStrength;
  const solidVal = selType === 'mosaic' ? !!selected?.geometry.solid : maskSolid;
  const brushSizeVal = selType === 'mosaic' ? (selected?.geometry.brushSize ?? maskBrushSize) : maskBrushSize;

  // 更新文字样式：同步全局默认 + 选中标注 geometry
  const applyFontSize = (s: number) => {
    updateStyle({ currentFontSize: s });
    if (selType === 'text' && selected) {
      updateAnnotation(selected.id, { geometry: { ...selected.geometry, fontSize: s } });
    }
  };
  const applyBold = (b: boolean) => {
    updateStyle({ currentBold: b });
    if (selType === 'text' && selected) {
      updateAnnotation(selected.id, { geometry: { ...selected.geometry, bold: b } });
    }
  };
  const applyItalic = (b: boolean) => {
    updateStyle({ currentItalic: b });
    if (selType === 'text' && selected) {
      updateAnnotation(selected.id, { geometry: { ...selected.geometry, italic: b } });
    }
  };
  const applyAlign = (a: 'left' | 'center' | 'right') => {
    updateStyle({ currentAlign: a });
    if (selType === 'text' && selected) {
      updateAnnotation(selected.id, { geometry: { ...selected.geometry, align: a } });
    }
  };
  const applyFont = (f: string) => {
    updateStyle({ currentFontFamily: f });
    if (selType === 'text' && selected) {
      updateAnnotation(selected.id, { geometry: { ...selected.geometry, fontFamily: f } });
    }
  };
  const applyTextBg = (b: boolean) => {
    updateStyle({ currentTextBg: b });
    if (selType === 'text' && selected) {
      updateAnnotation(selected.id, { geometry: { ...selected.geometry, bg: b } });
    }
  };
  const applyBgColor = (c: string) => {
    updateStyle({ currentBgColor: c });
    if (selType === 'text' && selected) {
      updateAnnotation(selected.id, { geometry: { ...selected.geometry, bgColor: c } });
    }
  };
  const applyBgOpacity = (n: number) => {
    updateStyle({ currentBgOpacity: n });
    if (selType === 'text' && selected) {
      updateAnnotation(selected.id, { geometry: { ...selected.geometry, bgOpacity: n } });
    }
  };
  const applyTextStroke = (b: boolean) => {
    updateStyle({ currentTextStroke: b });
    if (selType === 'text' && selected) {
      updateAnnotation(selected.id, { geometry: { ...selected.geometry, stroke: b } });
    }
  };
  // 更新打码设置：同步全局默认 + 选中标注 geometry
  const applyBlur = (b: boolean) => {
    updateStyle({ maskBlur: b });
    if (selType === 'mosaic' && selected) {
      updateAnnotation(selected.id, { geometry: { ...selected.geometry, blur: b } });
    }
  };
  const applyStrength = (s: number) => {
    updateStyle({ maskStrength: s });
    if (selType === 'mosaic' && selected) {
      updateAnnotation(selected.id, { geometry: { ...selected.geometry, strength: s } });
    }
  };
  // v14 修复：涂黑 / 笔刷大小此前有状态与 canvas 逻辑但工具栏无控件（死功能），现暴露
  const applySolid = (b: boolean) => {
    updateStyle({ maskSolid: b });
    if (selType === 'mosaic' && selected) {
      updateAnnotation(selected.id, { geometry: { ...selected.geometry, solid: b } });
    }
  };
  const applyBrushSize = (s: number) => {
    updateStyle({ maskBrushSize: s });
    if (selType === 'mosaic' && selected) {
      updateAnnotation(selected.id, { geometry: { ...selected.geometry, brushSize: s } });
    }
  };

  // 快捷键提示按平台显示：Windows/Linux 用 Ctrl+Z / Ctrl+Shift+Z，macOS 用 ⌘Z / ⇧⌘Z
  const isWinLike = platform === 'windows' || platform === 'linux';
  const undoHint = isWinLike ? 'Ctrl+Z' : '⌘Z';
  const redoHint = isWinLike ? 'Ctrl+Shift+Z' : '⇧⌘Z';

  // 付费门禁：马赛克 / 打码属于 Pro 功能；免费/试用结束态下锁定该工具。
  // 使用 store 的 canUse（平台感知：Windows fail-closed，macOS/Linux fail-open）。
  const licenseStatus = useLicenseStore((s) => s.status);
  const canUseFn = useLicenseStore((s) => s.canUse);
  void licenseStatus; // 订阅 status 确保状态变化时重渲染
  const canRedact = canUseFn('redact');
  const openUpgrade = useUpgradeDialogStore((s) => s.openDialog);

  const [tip, setTip] = useState<TipState>(null);

  // 鼠标进入按钮：读取按钮位置，在其正下方定位提示浮层
  // （工具栏贴在窗口顶部，往上弹会被顶栏/窗口边缘遮住，故改为向下弹到画布区域）
  const showTip = useCallback((e: React.MouseEvent, name: string, hint?: string) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTip({ name, hint, x: r.left + r.width / 2, y: r.bottom });
  }, []);
  const hideTip = useCallback(() => setTip(null), []);

  const handleDelete = () => {
    if (selectedId) {
      deleteAnnotation(selectedId);
      setSelectedId(null);
    }
  };

  // 选中标注时改颜色：同步更新选中标注的颜色，而非仅影响新建标注
  const handleColorChange = (c: string) => {
    updateStyle({ currentColor: c });
    if (selectedId) {
      updateAnnotation(selectedId, { color: c });
    }
  };

  // 选中标注时改线宽：同步更新选中标注的线宽
  const handleWidthChange = (w: number) => {
    updateStyle({ currentStrokeWidth: w });
    if (selectedId) {
      updateAnnotation(selectedId, { lineWidth: w });
    }
  };

  return (
    <>
      <div className="toolbar-center" role="toolbar" aria-label={t('tool.aria')}>
        {/* 绘制工具 */}
        <div className="tool-section">
          <div className="tool-group" role="group" aria-label={t('tool.groupDraw')}>
            {TOOLS.map((tool) => (
              <button
                key={tool.id}
                className={`tool-btn${activeTool === tool.id ? ' active' : ''}${
                  tool.id === 'mosaic' && !canRedact ? ' tool-btn-locked' : ''
                }`}
                aria-label={`${t('tool.' + tool.id)} (${tool.hint})`}
                aria-pressed={activeTool === tool.id}
                onMouseEnter={(e) => showTip(e, t('tool.' + tool.id), tool.hint)}
                onMouseLeave={hideTip}
                onClick={() => {
                  if (tool.id === 'mosaic' && !canRedact) {
                    openUpgrade('redact');
                    return;
                  }
                  setActiveTool(tool.id);
                }}
              >
                <Icon>{ICONS[tool.id]}</Icon>
              </button>
            ))}
          </div>
          <div className="tool-divider" />
        </div>

        {/* 颜色 */}
        <div className="tool-section">
          <div className="swatch-group" role="group" aria-label={t('tool.groupColor')}>
            {COLORS.map((c) => (
              <button
                key={c}
                className={`swatch${currentColor === c ? ' active' : ''}`}
                style={{ background: c }}
                aria-label={t('tool.colorAria', { c })}
                aria-pressed={currentColor === c}
                onMouseEnter={(e) => showTip(e, t('tool.groupColor'))}
                onMouseLeave={hideTip}
                onClick={() => handleColorChange(c)}
              />
            ))}
            {/* 自定义取色：原生颜色面板，可选取任意颜色 */}
            <label
              className="swatch swatch-custom"
              title={t('tool.customColor')}
              onMouseEnter={(e) => showTip(e, t('tool.customColor'))}
              onMouseLeave={hideTip}
            >
              <input
                type="color"
                value={currentColor}
                onChange={(e) => handleColorChange(e.target.value)}
                aria-label={t('tool.customColor')}
              />
            </label>
          </div>
          <div className="tool-divider" />
        </div>

        {/* 线宽（[ / ] 调节） */}
        <div className="tool-section">
          <div className="width-group" role="group" aria-label={t('tool.groupWidth')}>
            {WIDTHS.map((w) => (
              <button
                key={w}
                className={`tool-btn width-btn${currentStrokeWidth === w ? ' active' : ''}`}
                aria-label={t('tool.widthAria', { w })}
                aria-pressed={currentStrokeWidth === w}
                onMouseEnter={(e) => showTip(e, t('tool.widthAria', { w }), '[ ]')}
                onMouseLeave={hideTip}
                onClick={() => handleWidthChange(w)}
              >
                <span className="width-dot" style={{ width: `${w + 4}px`, height: `${w + 4}px` }} />
              </button>
            ))}
          </div>
          <div className="tool-divider" />
        </div>

        {/* 上下文控件：文字样式（选中文字或激活文字工具时显示） */}
        {showTextCtl && (
          <div className="tool-section">
            <div className="ctx-group" role="group" aria-label={t('tool.groupText')}>
              {/* 字体选择 */}
              <select
                className="ctx-select"
                value={fontVal}
                onChange={(e) => applyFont(e.target.value)}
                aria-label={t('tool.font')}
                title={t('tool.font')}
                onMouseEnter={(e) => showTip(e, t('tool.font'))}
                onMouseLeave={hideTip}
                style={{ fontFamily: fontVal }}
              >
                {FONTS.map((f) => (
                  <option key={f.id} value={f.value} style={{ fontFamily: f.value }}>
                    {t(f.labelKey)}
                  </option>
                ))}
              </select>
              <div className="ctx-field">
                <span className="ctx-label">{t('tool.fontSize')}</span>
                <input
                  type="range"
                  min={12}
                  max={72}
                  step={2}
                  value={fontSizeVal}
                  onChange={(e) => applyFontSize(Number(e.target.value))}
                  className="ctx-range"
                  aria-label={t('tool.fontSize')}
                />
                <span className="ctx-value">{fontSizeVal}</span>
              </div>
              <button
                className={`ctx-toggle${boldVal ? ' active' : ''}`}
                aria-label={t('tool.bold')}
                aria-pressed={boldVal}
                onMouseEnter={(e) => showTip(e, t('tool.bold'))}
                onMouseLeave={hideTip}
                onClick={() => applyBold(!boldVal)}
              >
                <span style={{ fontWeight: 800 }}>B</span>
              </button>
              <button
                className={`ctx-toggle${italicVal ? ' active' : ''}`}
                aria-label={t('tool.italic')}
                aria-pressed={italicVal}
                onMouseEnter={(e) => showTip(e, t('tool.italic'))}
                onMouseLeave={hideTip}
                onClick={() => applyItalic(!italicVal)}
              >
                <span style={{ fontStyle: 'italic', fontWeight: 600 }}>I</span>
              </button>
              {/* 描边：自动对比色轮廓，保证文字在任意截图背景上都清晰可读 */}
              <button
                className={`ctx-toggle${strokeVal ? ' active' : ''}`}
                aria-label={t('tool.textStroke')}
                aria-pressed={strokeVal}
                onMouseEnter={(e) => showTip(e, t('tool.textStroke'))}
                onMouseLeave={hideTip}
                onClick={() => applyTextStroke(!strokeVal)}
              >
                <span
                  style={{
                    fontWeight: 800,
                    color: strokeVal ? undefined : 'var(--text)',
                    WebkitTextStroke: strokeVal ? '1.5px var(--accent)' : '1.5px var(--text-sub)',
                    textShadow: strokeVal ? '0 0 1px #fff' : 'none',
                  }}
                >
                  S
                </span>
              </button>
              {/* 对齐：左 / 中 / 右 */}
              <div className="ctx-align-group" role="group" aria-label={t('tool.align')}>
                {(['left', 'center', 'right'] as const).map((a) => (
                  <button
                    key={a}
                    className={`ctx-align-btn${alignVal === a ? ' active' : ''}`}
                    aria-label={t('tool.align' + a.charAt(0).toUpperCase() + a.slice(1))}
                    aria-pressed={alignVal === a}
                    onMouseEnter={(e) => showTip(e, t('tool.align' + a.charAt(0).toUpperCase() + a.slice(1)))}
                    onMouseLeave={hideTip}
                    onClick={() => applyAlign(a)}
                  >
                    <Icon>{ALIGN_ICONS[a]}</Icon>
                  </button>
                ))}
              </div>
              <button
                className={`ctx-toggle${bgVal ? ' active' : ''}`}
                aria-label={t('tool.textBg')}
                aria-pressed={bgVal}
                onMouseEnter={(e) => showTip(e, t('tool.textBg'))}
                onMouseLeave={hideTip}
                onClick={() => applyTextBg(!bgVal)}
              >
                <span className="ctx-bg-icon">A</span>
              </button>
              {/* 背景色取色（bg 开启时可用，任意颜色） */}
              <label
                className={`ctx-color-btn${bgVal ? '' : ' disabled'}`}
                title={t('tool.bgColor')}
                onMouseEnter={(e) => showTip(e, t('tool.bgColor'))}
                onMouseLeave={hideTip}
                style={{ background: bgColorVal }}
              >
                <input
                  type="color"
                  value={bgColorVal}
                  disabled={!bgVal}
                  onChange={(e) => applyBgColor(e.target.value)}
                  aria-label={t('tool.bgColor')}
                  tabIndex={bgVal ? 0 : -1}
                />
              </label>
              {/* 背景透明度（bg 开启时可用）：让底衬支持半透明，覆盖在截图上不突兀 */}
              <div className={`ctx-field${bgVal ? '' : ' disabled'}`}>
                <span className="ctx-label">{t('tool.bgOpacity')}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(bgOpacityVal * 100)}
                  disabled={!bgVal}
                  onChange={(e) => applyBgOpacity(Number(e.target.value) / 100)}
                  className="ctx-range"
                  aria-label={t('tool.bgOpacity')}
                  style={{ opacity: bgVal ? 1 : 0.4 }}
                />
                <span className="ctx-value">{Math.round(bgOpacityVal * 100)}</span>
              </div>
            </div>
            <div className="tool-divider" />
          </div>
        )}

        {/* 上下文控件：打码设置（选中马赛克或激活马赛克工具时显示） */}
        {showMaskCtl && (
          <div className="tool-section">
            <div className="ctx-group" role="group" aria-label={t('tool.maskGroup')}>
              <button
                className={`ctx-mode${!blurVal && !solidVal ? ' active' : ''}`}
                aria-label={t('tool.mosaicMode')}
                aria-pressed={!blurVal && !solidVal}
                onMouseEnter={(e) => showTip(e, t('tool.mosaicMode'))}
                onMouseLeave={hideTip}
                onClick={() => { applyBlur(false); applySolid(false); }}
              >
                {t('tool.mosaicMode')}
              </button>
              <button
                className={`ctx-mode${blurVal && !solidVal ? ' active' : ''}`}
                aria-label={t('tool.blurMode')}
                aria-pressed={blurVal && !solidVal}
                onMouseEnter={(e) => showTip(e, t('tool.blurMode'))}
                onMouseLeave={hideTip}
                onClick={() => { applyBlur(true); applySolid(false); }}
              >
                {t('tool.blurMode')}
              </button>
              <button
                className={`ctx-mode${solidVal ? ' active' : ''}`}
                aria-label={t('tool.solidMode')}
                aria-pressed={solidVal}
                onMouseEnter={(e) => showTip(e, t('tool.solidMode'))}
                onMouseLeave={hideTip}
                onClick={() => { applySolid(true); applyBlur(false); }}
              >
                {t('tool.solidMode')}
              </button>
              <div className="ctx-field">
                <span className="ctx-label">{t('tool.strength')}</span>
                <input
                  type="range"
                  min={4}
                  max={40}
                  step={2}
                  value={strengthVal}
                  onChange={(e) => applyStrength(Number(e.target.value))}
                  className="ctx-range"
                  aria-label={t('tool.strength')}
                />
                <span className="ctx-value">{strengthVal}</span>
              </div>
              {solidVal && (
                <div className="ctx-field">
                  <span className="ctx-label">{t('tool.brushSize')}</span>
                  <input
                    type="range"
                    min={5}
                    max={60}
                    step={1}
                    value={brushSizeVal}
                    onChange={(e) => applyBrushSize(Number(e.target.value))}
                    className="ctx-range"
                    aria-label={t('tool.brushSize')}
                  />
                  <span className="ctx-value">{brushSizeVal}</span>
                </div>
              )}
            </div>
            <div className="tool-divider" />
          </div>
        )}

        {/* 操作 */}
        <div className="tool-section">
          <div className="tool-group" role="group" aria-label={t('tool.undo')}>
            <button
              className="tool-btn"
              aria-label={t('tool.undo')}
              disabled={past.length === 0}
              onMouseEnter={(e) => showTip(e, t('tool.undo'), undoHint)}
              onMouseLeave={hideTip}
              onClick={undo}
            >
              <Icon>{ICONS.undo}</Icon>
            </button>
            <button
              className="tool-btn"
              aria-label={t('tool.redo')}
              disabled={future.length === 0}
              onMouseEnter={(e) => showTip(e, t('tool.redo'), redoHint)}
              onMouseLeave={hideTip}
              onClick={redo}
            >
              <Icon>{ICONS.redo}</Icon>
            </button>
            <button
              className="tool-btn danger"
              aria-label={t('tool.delete')}
              disabled={!selectedId}
              onMouseEnter={(e) => showTip(e, t('tool.delete'), '⌫')}
              onMouseLeave={hideTip}
              onClick={handleDelete}
            >
              <Icon>{ICONS.trash}</Icon>
            </button>
          </div>
        </div>
      </div>

      {/* JS 定位的浮层提示：fixed 定位，渲染在工具栏容器之外，不被 overflow 裁剪 */}
      {tip && (
        <div
          className="tool-tip-float"
          style={{ left: tip.x, top: tip.y }}
          role="tooltip"
        >
          <span className="tool-tip-name">{tip.name}</span>
          {tip.hint && <span className="tool-tip-key">{tip.hint}</span>}
        </div>
      )}
    </>
  );
};

export default AnnotationToolbar;
