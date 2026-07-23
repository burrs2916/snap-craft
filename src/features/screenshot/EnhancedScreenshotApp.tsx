import { useCallback, useEffect, useRef, useState, useMemo, type MouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
// Phase 18：OCR 文本清洗（去零宽字符/控制字符/重复字，避免污染 AI 视觉上下文）
import { cleanOcrText } from '../ai/ocrClean';
import { getCurrentWindow, LogicalSize, LogicalPosition } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { save } from '@tauri-apps/plugin-dialog';
import { AnnotationToolbar } from './components/AnnotationToolbar';
import AnnotationCanvas, { AnnotationCanvasHandle } from './components/AnnotationCanvas';
import { openEditorWindow, openClipboardOcrWindow } from './components/EditorWindow';
import { LanguageToggle } from '../../components/LanguageToggle';
import { useScreenshotStore } from './store/screenshotStore';
import type { OcrResult, OcrBlock, AnnotationObject } from './types';
import {
} from '../../ai-window/bridge';
import { useAiStore } from '../ai/aiStore';
import { useI18n, t } from '../../i18n';
import { stitchFrames, loadImage, type StitchFrame } from './utils/stitch';
import { useOcrPanel } from './hooks/useOcrPanel';
import { useBatchOperations } from './hooks/useBatchOperations';
import { useAiIntegration } from './hooks/useAiIntegration';
import { useScreenPermission } from './hooks/useScreenPermission';
import { BatchBar, BatchOcrPanel, AiBatchPanel } from './components/BatchOperations';
import { OcrPanel } from './components/OcrPanel';
import { clamp01, genAnnoId, normToPx, cropDataUrl, flog } from './utils/helpers';

/**
 * 平台兜底检测（不依赖 IPC）：当 `get_platform` 命令调用失败时，
 * 用 `navigator.userAgent` 判定平台，杜绝「失败回落到 macOS」导致
 * Windows / Linux 误走 macOS 专属分支（如快捷键提示 ⌘⇧、区域截屏走
 * screencapture -i 等）——这是跨平台对等（parity）的关键边界用例（R2）。
 * 返回值与 Rust `std::env::consts::OS` 一致：'macos' | 'windows' | 'linux'。
 */
function detectPlatformFromUA(): string {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  return 'linux';
}

// 截图前安全隐藏主窗口。
// ⚠️ macOS 原生全屏（绿灯/最大化）会把窗口放进独立的 Space（专属全屏空间）。
// 若此时直接 hide()，那块屏正在跑 Space 退出/过渡动画（短暂黑场），紧接着 screencapture
// 就会截到「过渡中的黑屏」——尤其是把工具窗口最大化放在第二屏、再截该屏时必现。
// 修复：hide 前若处于全屏/最大化，先退出该状态并等待 Space 过渡动画彻底结束，再 hide、再截图。
async function safeHideForCapture(win: ReturnType<typeof getCurrentWindow>): Promise<void> {
  let wasFullscreen = false;
  let wasMaximized = false;
  try {
    wasFullscreen = await win.isFullscreen();
  } catch { /* 某些平台无此 API，忽略 */ }
  try {
    wasMaximized = await win.isMaximized();
  } catch { /* ignore */ }

  if (wasFullscreen) {
    // ⚠️ macOS 26 崩溃修复：原方案 setFullscreen(false) + 固定延迟 + hide() 会 crash——
    // 全屏 Space 拆除期间 WebPageProxy 被释放，hide() 触发的 insets 派发解引用 null。
    // 修复：全屏态改用 setMinimized(true) 代替 hide()。
    //   minimize 是原子操作，macOS 内部处理全屏退出，不走 orderOut → 不触发 insets crash。
    //   minimize 后窗口完全不在屏幕上，截图不会截到自身。
    flog(`safeHide: 窗口处于原生全屏 → minimize (避免 hide() 触发 insets crash)`);
    try { await win.minimize(); } catch { /* ignore */ }
    // 等 minimize + Space 拆除完成
    await new Promise((r) => setTimeout(r, 600));
  } else if (wasMaximized) {
    flog(`safeHide: 窗口处于最大化 → 先取消最大化并等待重绘再隐藏`);
    try { await win.unmaximize(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 350));
    await win.hide();
  } else {
    await win.hide();
  }
  // 隐藏后再给屏幕合成器一点时间稳定
  if (wasFullscreen) {
    await new Promise((r) => setTimeout(r, 150));
  }
}

/* ── 顶栏线性图标（与标注工具栏同款描边风格，stroke=currentColor 跟随主题）── */
const TBIcon = ({ d }: { d: string }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: d }}
  />
);
const TB_PATHS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  pin: '<path d="M9 4h6l-1 5 3 3v2h-5v5l-1 2-1-2v-5H4v-2l3-3-1-5z"/>',
  save: '<path d="M12 3v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 20h14"/>',
  ocr: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h6M7 13h10M7 17h4"/>',
} as const;

type Theme = 'light' | 'dark' | 'system';

interface HistoryEntry {
  id: string;
  dataUrl: string;
  createdAt: string;
  width: number;
  height: number;
  // 来源：'capture'=本机截图，'clipboard'=从系统剪贴板读取的图片，'ai_edit'=AI 智能编辑烧录产物。
  // 用于历史网格角标区分，v4 起新增 ai_edit（独立持久化的 AI 编辑合成图）。
  source?: 'capture' | 'clipboard' | 'ai_edit';
  // OCR 识别结果（已落库），用于历史网格按 OCR 文字搜索。
  ocr_text?: string;
}

// macOS 显示器信息（list_displays 返回，全局逻辑点坐标）
interface DisplayInfo {
  id: number;
  is_main: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

// 按真实物理位置排序显示器：先按全局 x（左→右），x 相近时按 y（上→下）。
// 返回带统一序号 label 的数组——序号即用户看到的「显示器 N」，与卡片布局位置一致。
const orderDisplays = (displays: DisplayInfo[]): (DisplayInfo & { label: number })[] =>
  [...displays]
    .sort((a, b) => (Math.abs(a.x - b.x) > 40 ? a.x - b.x : a.y - b.y))
    .map((d, i) => ({ ...d, label: i + 1 }));

// 多屏选择器：居中弹窗，按真实相对位置铺放各屏缩略卡片，点选后由 pickDisplay 截取。
// 不遮挡真实屏幕内容——只在应用窗口内以缩略示意图呈现，安全直观。
const DisplayPicker = ({
  displays,
  onPick,
  onCancel,
}: {
  displays: DisplayInfo[];
  onPick: (id: number | null) => void;
  onCancel: () => void;
}) => {
  // 统一按物理位置排序 + 编号（左→右）
  const ordered = orderDisplays(displays);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  ordered.forEach((d) => {
    minX = Math.min(minX, d.x);
    minY = Math.min(minY, d.y);
    maxX = Math.max(maxX, d.x + d.width);
    maxY = Math.max(maxY, d.y + d.height);
  });
  const uw = maxX - minX;
  const uh = maxY - minY;
  return (
    <div className="permission-gate" style={{ zIndex: 60 }}>
      <div className="permission-card" style={{ maxWidth: 720 }}>
        <div className="permission-icon">🖥️</div>
        <div className="permission-title">{t('display.title')}</div>
        <div className="permission-text">
          {t('display.text', { n: ordered.length })}
        </div>
        <div
          className="display-picker-grid"
          style={{ aspectRatio: `${uw} / ${uh}`, position: 'relative', width: '100%' }}
        >
          {ordered.map((d) => (
            <button
              key={d.id}
              className="display-pick-card"
              onClick={() => onPick(d.id)}
              style={{
                left: `${((d.x - minX) / uw) * 100}%`,
                top: `${((d.y - minY) / uh) * 100}%`,
                width: `${(d.width / uw) * 100}%`,
                height: `${(d.height / uh) * 100}%`,
              }}
            >
              {d.is_main && <div className="display-pick-badge">{t('display.main')}</div>}
              <div className="display-pick-num">{d.label}</div>
              <div className="display-pick-res">
                {d.width} × {d.height}
                {d.scale >= 1.5 ? ' · Retina' : ''}
              </div>
            </button>
          ))}
        </div>
        <div className="permission-actions">
          <button className="permission-btn ghost" onClick={onCancel}>
            {t('display.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
};

// 历史缩略图：滚入视口才把 dataUrl 设为 src，避免一次性解码全部大图
const LazyHistoryThumb = ({ dataUrl, alt }: { dataUrl: string; alt: string }) => {
  const ref = useRef<HTMLImageElement>(null);
  const [src, setSrc] = useState('');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          setSrc(dataUrl);
          io.disconnect();
        }
      });
    });
    io.observe(el);
    return () => io.disconnect();
  }, [dataUrl]);
  return (
    <img
      ref={ref}
      src={src || undefined}
      alt={alt}
      loading="lazy"
      style={src ? undefined : { backgroundColor: 'var(--surface-strong)' }}
    />
  );
};


export const EnhancedScreenshotApp = () => {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('snapcraft-theme') as Theme) || 'system'
  );
  const [currentView, setCurrentView] = useState<'home' | 'edit'>('home');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historySearch, setHistorySearch] = useState('');
  // 历史搜索：匹配 OCR 文字（已落库）或时间；空查询返回全部。
  const filteredHistory = (() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return history;
    return history.filter((h) => {
      const ocr = (h.ocr_text || '').toLowerCase();
      const time = new Date(h.createdAt).toLocaleString().toLowerCase();
      return ocr.includes(q) || time.includes(q);
    });
  })();
  const [current, setCurrent] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastType, setToastType] = useState<'success' | 'error' | 'info'>('success');
  // v14-A P0-3：保存/导出成功后保留最近一次路径 5s，toast 渲染"在访达中显示"按钮
  // 与 flash 共享字符串窗口，零状态机改动：revealPath 与 toast 同时存在/清空
  const [revealPath, setRevealPath] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string>('');
  // macOS App Store 沙箱标记：沙箱内禁止 spawn 外部 screencapture，区域/窗口截图须走
  // 自建覆盖层（与 Windows/Linux 一致）而非系统原生 -i/-w。开发者 ID 构建为 false。
  const [isSandboxed, setIsSandboxed] = useState(false);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [showDisplayPicker, setShowDisplayPicker] = useState(false);
  // 选屏器用途：全屏截图('shot') 还是滚动长截图('scroll')——决定点选后走哪条流程
  const pickerPurposeRef = useRef<'shot' | 'scroll'>('shot');
  // 截图后轻量结果条：展示最近一张截图缩略图 + 快捷操作（复制/编辑/保存/钉图）。
  // 不再强制跳编辑器，用户想标注才点「编辑」。
  const [lastShot, setLastShot] = useState<{ id: string; dataUrl: string; width: number; height: number } | null>(null);
  // 延时截图：全屏截图前等待的秒数（0=立即）。用于等待菜单/悬浮态等瞬时 UI 就绪。
  const [captureDelay, setCaptureDelay] = useState(0);
  // 延时倒计时显示（秒），null 表示无倒计时进行中
  const [countdown, setCountdown] = useState<number | null>(null);
  // ===== 滚动长截图 =====
  // scrolling: 是否处于滚动捕获态（主窗口缩为角落控制条）
  // scrollFrames: 已捕获的帧 dataUrl 列表
  // scrollRect: 本次捕获的固定区域（该屏顶部条带，物理像素全局坐标）
  // scrollBusy: 单帧捕获中，防重入
  const [scrolling, setScrolling] = useState(false);
  const [scrollFrames, setScrollFrames] = useState<string[]>([]);
  const [scrollBusy, setScrollBusy] = useState(false);
  const scrollRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  // 进入滚动态前主窗口的尺寸/位置，退出时恢复
  const preScrollWinRef = useRef<{ w: number; h: number; x: number; y: number } | null>(null);
  const scrollBusyRef = useRef(false);
  // scrolling 的 ref 镜像：供全局快捷键监听器判断当前是否在滚动态（避免作为依赖重注册）
  const scrollingRef = useRef(false);
  useEffect(() => {
    scrollingRef.current = scrolling;
  }, [scrolling]);
  // 权限检查中：platform 未确定或正在 check/request 期间，避免 UI 闪烁
  // 前端构建模式：vite dev 提供前端时 import.meta.env.DEV 为 true。
  // 注意：此前 tauri dev 跑裸二进制、进不了 TCC；现已改为 start.sh dev
  // 把 dev 编译的二进制包成真正的 .app（Bundle ID com.snap-craft.app.dev，
  // 显示名「SnapCraft (dev)」），因此同样能进 TCC 列表、能授权屏幕录制，
  // 与 release 的权限流程完全一致。isDev 仅用于文案提示，不再决定"能否授权"。
  const isDev = (import.meta as any).env?.DEV === true;

  const {
    currentScreenshot,
    setCurrentScreenshot,
    clearAnnotations,
    annotations,
    activeTool,
    setActiveTool,
    addAnnotation,
    setPlatform: setStorePlatform,
    // OCR 贴回标注时复用当前文字样式默认值
    currentColor,
    currentFontFamily,
    currentBold,
    currentItalic,
    currentTextBg,
    currentBgColor,
    currentBgOpacity,
    currentTextStroke,
    currentStrokeWidth,
  } = useScreenshotStore();

  const canvasRef = useRef<AnnotationCanvasHandle>(null);
  // busy 的 ref 镜像：供 doCapture 防重入检查，避免 busy 作为 useCallback 依赖
  // 导致事件监听器在截图过程中频繁注销/重注册（会产生事件丢失竞态窗口）
  const busyRef = useRef(false);
  // 权限自动重试计数：防止 CGRequestScreenCaptureAccess 无限重试（最多自动请求 2 次）
  // 结果条自动淡出定时器
  const resultBarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // captureDelay 的 ref 镜像：供 doCapture 读取，避免延时变化导致全局快捷键监听器重注册
  const captureDelayRef = useRef(0);
  useEffect(() => {
    captureDelayRef.current = captureDelay;
  }, [captureDelay]);

  // 国际化：订阅语言变化，切换时本组件自动重渲染（t 为稳定模块级函数，供 JSX 与回调共用）
  useI18n();

  // ===== 主题：light / dark / system =====
  useEffect(() => {
    localStorage.setItem('snapcraft-theme', theme);
    const apply = () => {
      const resolved =
        theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : theme;
      document.documentElement.setAttribute('data-theme', resolved);
    };
    apply();
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme]);

  const flash = useCallback(
    (msg: string, type: 'success' | 'error' | 'info' = 'success', keepMs?: number) => {
      setToast(msg);
      setToastType(type);
      // 错误停留最久（5s）便于阅读原因；中性提示（info）适中（2.6s）；成功最短（1.8s）。
      // v14-A P0-3：成功 + keepMs 时延长到 5s，给 reveal 按钮留出点击窗口
      const ms = keepMs ?? (type === 'error' ? 5000 : type === 'info' ? 2600 : 1800);
      window.setTimeout(() => {
        setToast(null);
        setRevealPath(null);
      }, ms);
    },
    []
  );

  // ===== OCR 面板（提取到 useOcrPanel hook + OcrPanel 组件）=====
  const ocr = useOcrPanel({
    current, platform, flash, t, canvasRef, addAnnotation,
    currentScreenshot, setCurrentScreenshot, setCurrent, setCurrentView,
    history, setHistory, resultBarTimerRef, setLastShot,
  });
  const {
    ocrBusy, ocrResult, ocrResultRef, ocrLang, ocrRegionMode,
    ocrClipBusy, ocrLastImage, ocrSourceKind,
    setOcrResult, setOcrRegionMode, runOcr, handleOcr,
    startOcrFromClipboard, startOcrFromShot, onRegionOcr,
  } = ocr;

  // ===== 批量操作（提取到 useBatchOperations hook）=====
  const batch = useBatchOperations({ history, flash, t });
  const {
    selMode, setSelMode, selIds, toggleSel, selectAll, clearSel,
    showBatch, setShowBatch, showAiBatch, setShowAiBatch,
  } = batch;

  // ===== AI 集成（提取到 useAiIntegration hook）=====
  const ai = useAiIntegration({
    current, canvasRef, addAnnotation, clearAnnotations, annotations,
    currentScreenshot, setCurrentScreenshot,
    currentColor, currentStrokeWidth, currentFontFamily,
    ocrLang, ocrResultRef, ocrResult,
    flash, t, setHistory,
  });
  const { aiOpen, setAiOpen, aiVisionUrl, aiOcrText, refreshAiVision, commitAiEdit, applyAiToScreenshot, openAi } = ai;

  // ===== 权限管理（提取到 useScreenPermission hook）=====
  const perm = useScreenPermission({ platform, flash, t });
  const { permissionNeeded, permissionChecking, openScreenRecordingSettings, recheckPermission, ensureCapturePermission, setPermissionNeeded } = perm;


  // 延时倒计时：在主窗口仍可见时以覆盖层显示 N…1 的读秒，倒计时结束再真正截图。
  // 放在窗口隐藏之前跑，用户能看到读秒；结束后返回，调用方再 hide + 截图。
  const runCountdown = useCallback(async (secs: number) => {
    if (secs <= 0) return;
    for (let s = secs; s > 0; s--) {
      setCountdown(s);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCountdown(null);
  }, []);

  // ===== 启动加载历史记录 =====
  useEffect(() => {
    (async () => {
      try {
        const raw = (await invoke('get_history')) as any[];
        if (Array.isArray(raw)) {
          setHistory(
            raw.map((i) => ({
              id: i.id,
              dataUrl: i.data_url,
              createdAt: i.created_at,
              width: i.width,
              height: i.height,
              source: i.source === 'clipboard' ? 'clipboard' : 'capture',
            }))
          );
        }
      } catch {
        /* 历史为空或读取失败，忽略 */
      }
    })();
  }, []);

  const onCaptured = useCallback(
    async (dataUrl: string) => {
      flog(`onCaptured 收到截图数据: dataUrl长度=${dataUrl?.length ?? 0} 前缀=${(dataUrl || '').slice(0, 32)}`);
      const decT0 = performance.now();
      const { width, height } = await new Promise<{ width: number; height: number }>(
        (res, rej) => {
          const img = new Image();
          img.onload = () => res({ width: img.width, height: img.height });
          img.onerror = () => {
            flog(`❌ onCaptured 截图数据解码失败: dataUrl长度=${dataUrl?.length ?? 0}`);
            rej(new Error('截图数据解码失败'));
          };
          img.src = dataUrl;
        }
      );
      flog(
        `onCaptured 解码成功: 自然像素=${width}x${height} 解码耗时=${(performance.now() - decT0).toFixed(0)}ms DPR=${window.devicePixelRatio}`
      );
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date().toISOString();
      const entry: HistoryEntry = { id, dataUrl, createdAt, width, height, source: 'capture' };
      setHistory((h) => [entry, ...h]);
      try {
        await invoke('add_history', {
          item: { id, data_url: dataUrl, created_at: createdAt, width, height, source: 'capture' },
        });
      } catch {
        /* 持久化失败不阻断使用 */
      }
      // 截图后自动复制到剪贴板——用户截图最常见的目的就是粘贴
      try {
        await invoke('copy_to_clipboard', { imageData: dataUrl });
        flash(t('toast.doneCopied'), 'success');
      } catch {
        /* 自动复制失败不阻断使用，用户可手动复制 */
      }
      // 不再强制进编辑器：停在主页弹出轻量结果条（缩略图 + 复制/编辑/保存/钉图）。
      // 想标注再点「编辑」。结果条 6 秒后自动淡出。
      flog(`onCaptured 完成: 生成结果条 id=${id} 尺寸=${width}x${height}`);
      setLastShot({ id, dataUrl, width, height });
      if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current);
      resultBarTimerRef.current = setTimeout(() => setLastShot(null), 6000);
    },
    [flash]
  );

  // 结果条 / 历史项 → 进入编辑器标注
  const openEditor = useCallback(
    (shot: { id: string; dataUrl: string; width: number; height: number }) => {
      flog(
        `点击编辑→打开编辑器: id=${shot.id} 传入尺寸=${shot.width}x${shot.height} dataUrl长度=${shot.dataUrl?.length ?? 0}`
      );
      if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current);
      setLastShot(null);
      const createdAt = new Date().toISOString();
      setCurrent({ dataUrl: shot.dataUrl, width: shot.width, height: shot.height });
      setCurrentScreenshot({
        id: shot.id,
        filePath: '',
        dataUrl: shot.dataUrl,
        width: shot.width,
        height: shot.height,
        annotations: [],
        layers: [],
        createdAt,
        updatedAt: createdAt,
      });
      clearAnnotations();
      setCurrentView('edit');
      flog(`编辑器视图已切换(currentView=edit)，等待 AnnotationCanvas 渲染`);
    },
    [setCurrentScreenshot, clearAnnotations]
  );

  // 裁剪确认：用裁剪后的新图替换当前编辑对象，清空标注（标注已合并进新图）。
  const onCropped = useCallback(
    (dataUrl: string, width: number, height: number) => {
      const id = `${Date.now()}-crop`;
      const createdAt = new Date().toISOString();
      setCurrent({ dataUrl, width, height });
      setCurrentScreenshot({
        id,
        filePath: '',
        dataUrl,
        width,
        height,
        annotations: [],
        layers: [],
        createdAt,
        updatedAt: createdAt,
      });
      clearAnnotations();
      setActiveTool('select');
      flash(t('crop.done'), 'success');
    },
    [setCurrentScreenshot, clearAnnotations, setActiveTool, flash]
  );

  // ===== 平台检测（决定快捷键提示与区域截图方式）=====
  // 同时写入本地 state（本组件用）与全局 store（AnnotationToolbar 等子组件用），
  // 否则子组件读到的 store.platform 恒为空串，会错误退回 macOS 快捷键提示。
  useEffect(() => {
    invoke('get_platform')
      .then((p) => {
        setPlatform(p as string);
        setStorePlatform(p as string);
        // macOS 沙箱检测：App Store 构建为 true；开发者 ID 为 false。仅 macOS 查询（命令仅 macOS 注册）。
        if (p === 'macos') {
          invoke<boolean>('is_sandboxed').then(setIsSandboxed).catch(() => setIsSandboxed(false));
        }
      })
      .catch(() => {
        // ⚠️ 跨平台对等（R2）：IPC 失败时不可回落到 'macos'，
        // 否则 Windows / Linux 会错误走 macOS 专属分支。改用 UA 兜底判定。
        const fallback = detectPlatformFromUA();
        console.warn(`[platform] get_platform 调用失败，回落到 UA 判定: ${fallback}`);
        setPlatform(fallback);
        setStorePlatform(fallback);
        if (fallback === 'macos') {
          invoke<boolean>('is_sandboxed').then(setIsSandboxed).catch(() => setIsSandboxed(false));
        }
      });
  }, [setStorePlatform]);

  const isWinLike = platform === 'windows' || platform === 'linux';
  const modLabel = isWinLike ? 'Ctrl' : '⌘';
  // Shift 键标签：Windows/Linux 用文字 "Shift"，macOS 用符号 ⇧（与系统习惯一致）
  const shiftLabel = isWinLike ? 'Shift' : '⇧';

  // 加载显示器列表（多屏时全屏截图弹出选择器需要）。macOS/Windows 均支持多屏枚举。
  useEffect(() => {
    if (platform === '') return; // 平台未就绪时不查
    invoke<DisplayInfo[]>('list_displays')
      .then(setDisplays)
      .catch(() => setDisplays([]));
  }, [platform]);



  // 手动重新检查权限（用户在系统设置中授权后点"已授权？刷新"触发）

  // 截图前权限预检：窗口可见时触发系统授权弹窗（最可靠）。
  // ⚠️ 关键：必须在 win.hide() 之前检查——窗口隐藏后调 CGRequestScreenCaptureAccess，
  //    系统授权弹窗无法显示，用户会什么都看不到（连点截图无反应）。

  // ===== 滚动长截图：手动滚动 + 智能拼接 =====
  // 捕获区域 = 所选显示器的「整宽 × 顶部约 78% 高」固定条带。用户在其它位置滚动，
  // 按全局快捷键（⌘/Ctrl+Shift+4）或点控制条按钮捕一帧，完成后自动去重叠拼成长图。

  // 进入滚动捕获态：把主窗口缩为角落小控制条（不遮挡内容），记录捕获区域。
  const enterScrollMode = useCallback(
    async (disp: DisplayInfo) => {
      // 捕获条带：整屏宽，顶部起，高取屏高的 78%（留出底部让用户操作滚动）
      const stripH = Math.round(disp.height * 0.78);
      scrollRectRef.current = { x: disp.x, y: disp.y, width: disp.width, height: stripH };
      setScrollFrames([]);
      setScrolling(true);
      // 记录并缩小主窗口到该屏右下角作为控制条
      const win = getCurrentWindow();
      try {
        const sz = await win.innerSize();
        const ps = await win.outerPosition();
        const sf = await win.scaleFactor();
        preScrollWinRef.current = {
          w: sz.width / sf,
          h: sz.height / sf,
          x: ps.x / sf,
          y: ps.y / sf,
        };
        const barW = 340;
        const barH = 132;
        await win.setSize(new LogicalSize(barW, barH));
        // 停靠到该屏右下角（用逻辑坐标；控制条不遮挡将要滚动的主要区域）
        const px = disp.x + disp.width - barW - 24;
        const py = disp.y + disp.height - barH - 40;
        await win.setPosition(new LogicalPosition(px, py));
        await win.setAlwaysOnTop(true);
        await win.show();
        await win.setFocus();
      } catch {
        /* 窗口操作失败不阻断，仍可用 */
      }
    },
    []
  );

  // 捕获一帧：截固定区域，追加到帧列表
  const captureScrollFrame = useCallback(async () => {
    if (scrollBusyRef.current) return;
    const rect = scrollRectRef.current;
    if (!rect) return;
    scrollBusyRef.current = true;
    setScrollBusy(true);
    // 权限预检（macOS）
    if (!(await ensureCapturePermission())) {
      scrollBusyRef.current = false;
      setScrollBusy(false);
      return;
    }
    try {
      const dataUrl = await invoke<string>('capture_region_fixed', { rect });
      setScrollFrames((f) => [...f, dataUrl]);
      flash(t('toast.frameCaptured'), 'success');
    } catch (e) {
      const msg = String(e);
      if (msg.includes('屏幕录制') || msg.includes('permission') || msg.includes('denied') || msg.includes('not authorized')) {
        if (platform === 'macos') {
          invoke<boolean>('check_screen_capture_access').then((ok) => {
            if (!ok) setPermissionNeeded(true);
          });
        }
      } else {
        flash(t('toast.captureFailed', { msg }), 'error');
      }
    } finally {
      scrollBusyRef.current = false;
      setScrollBusy(false);
    }
  }, [ensureCapturePermission, flash, platform, setPermissionNeeded]);

  // 恢复主窗口尺寸/位置并退出滚动态
  const restoreMainWindow = useCallback(async () => {
    const win = getCurrentWindow();
    try {
      await win.setAlwaysOnTop(false);
      const p = preScrollWinRef.current;
      if (p) {
        await win.setSize(new LogicalSize(p.w, p.h));
        await win.setPosition(new LogicalPosition(p.x, p.y));
      }
      await win.show();
      await win.setFocus();
    } catch {
      /* ignore */
    }
    preScrollWinRef.current = null;
    setScrolling(false);
  }, []);

  // 完成：拼接所有帧 → 长图 → 走 onCaptured（进历史 + 结果条）
  const finishScrollCapture = useCallback(async () => {
    const frames = scrollFrames;
    await restoreMainWindow();
    if (frames.length === 0) {
      flash(t('toast.noFrames'), 'error');
      return;
    }
    if (frames.length === 1) {
      // 只有一帧，直接当普通截图
      await onCaptured(frames[0]);
      return;
    }
    try {
      const imgs = await Promise.all(frames.map((d) => loadImage(d)));
      const sframes: StitchFrame[] = imgs.map((img) => ({
        img,
        width: img.naturalWidth,
        height: img.naturalHeight,
      }));
      const { canvas, hadLowConfidence } = stitchFrames(sframes);
      const merged = canvas.toDataURL('image/png');
      await onCaptured(merged);
      if (hadLowConfidence) {
        flash(t('toast.stitchGap'), 'error');
      } else {
        flash(t('toast.stitched', { n: frames.length }), 'success');
      }
    } catch (e) {
      flash(t('toast.stitchFailed', { msg: String(e) }), 'error');
    }
  }, [scrollFrames, restoreMainWindow, onCaptured, flash]);

  // 取消滚动捕获：丢弃已捕获帧并恢复窗口
  const cancelScrollCapture = useCallback(async () => {
    setScrollFrames([]);
    await restoreMainWindow();
    flash(t('toast.scrollCancelled'), 'success');
  }, [restoreMainWindow, flash]);

  // 发起滚动长截图：多屏先选屏，单屏直接进入
  const startScrollCapture = useCallback(async () => {
    if (scrolling) return;
    let disp: DisplayInfo[] = [];
    try {
      disp = await invoke<DisplayInfo[]>('list_displays');
      if (disp.length > 0) setDisplays(disp);
    } catch {
      /* ignore */
    }
    if (disp.length > 1) {
      pickerPurposeRef.current = 'scroll';
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
      setShowDisplayPicker(true);
      return;
    }
    // 单屏（或枚举失败退回主屏）：构造一个默认屏信息
    const only =
      disp[0] || { id: 0, is_main: true, x: 0, y: 0, width: 1440, height: 900, scale: 1 };
    await enterScrollMode(only);
  }, [scrolling, enterScrollMode]);

  // 用户在选择器中点选某块屏后：关闭选择器 → 按用途走全屏截图或滚动长截图
  const pickDisplay = useCallback(
    async (displayId: number | null) => {
      setShowDisplayPicker(false);
      // displayId === null 表示取消
      if (displayId === null) {
        flog(`pickDisplay: 用户取消选屏`);
        flash(t('toast.cancelled'), 'success');
        return;
      }
      const picked = displays.find((d) => d.id === displayId);
      flog(
        `pickDisplay: 用户选中显示器 id=${displayId} 用途=${pickerPurposeRef.current} ` +
          (picked
            ? `主屏=${picked.is_main} 逻辑=${picked.width}x${picked.height} scale=${picked.scale} 全局坐标=(${picked.x},${picked.y})`
            : `(未在列表找到该屏元数据)`)
      );
      // 滚动长截图用途：进入滚动捕获态（不走下面的单帧全屏流程）
      if (pickerPurposeRef.current === 'scroll') {
        pickerPurposeRef.current = 'shot';
        const disp = displays.find((d) => d.id === displayId);
        if (disp) await enterScrollMode(disp);
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      // 权限预检：无权限则不隐藏窗口，直接触发授权弹窗 + 显示引导
      if (!(await ensureCapturePermission())) {
        busyRef.current = false;
        setBusy(false);
        return;
      }
      // 延时倒计时（窗口仍可见时读秒，结束后再隐藏截图）
      const delay = captureDelayRef.current;
      if (delay > 0) await runCountdown(delay);
      const win = getCurrentWindow();
      // ⚠️ 全屏/最大化时不能直接 hide（会截到 macOS Space 过渡黑场），走安全隐藏
      await safeHideForCapture(win);
      try {
        const invT0 = performance.now();
        const dataUrl = await invoke<string>('capture_screen', { displayId });
        flog(
          `pickDisplay: capture_screen(id=${displayId}) 返回 dataUrl长度=${dataUrl?.length ?? 0} invoke耗时=${(performance.now() - invT0).toFixed(0)}ms`
        );
        await onCaptured(dataUrl);
      } catch (e) {
        const msg = String(e);
        flog(`❌ pickDisplay: capture_screen(id=${displayId}) 抛错: ${msg}`);
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
        await win.show();
        await win.setFocus();
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onCaptured, flash, platform, setPermissionNeeded, ensureCapturePermission, runCountdown, displays, enterScrollMode]
  );

  // Windows/Linux 区域截图：打开覆盖【整个虚拟桌面】的全屏选区覆盖层（独立置顶无边框窗口）。
  // 选区结果通过 'region-selected' 事件回传（见下方监听），再真正 invoke capture_region。
  const openRegionOverlay = useCallback(async () => {
    try {
      const existing = await WebviewWindow.getByLabel('region-overlay').catch(() => null);
      if (existing) {
        try { await existing.setFocus(); } catch { /* ignore */ }
        return;
      }
      // 主窗口先隐藏，避免遮挡或被截入
      const main = getCurrentWindow();
      await main.hide();
      // 计算所有显示器的并集包围盒（虚拟桌面），覆盖层铺满整个虚拟桌面 → 支持任意屏拉框。
      // Windows/Linux 的 x/y/width/height 为物理像素、正坐标系。
      // ⚠️ 跨平台坐标一致性（HiDPI 关键修复）：Tauri WebviewWindow 的 x/y/width/height
      // 期望【逻辑像素】，而 list_displays 返回的是【物理像素】。若直接把物理值当逻辑值
      // 传入，在 DPR≠1 的 Windows（如 Surface / 4K 笔记本）上覆盖层会被放大 DPR 倍并错位，
      // 导致区域选框坐标整体偏移 → 截错位置。故创建窗口时按 dpr 折算为逻辑像素，
      // 并把 dpr 经 URL 传给覆盖层，使其内部「CSS局部 × dpr + 原点」换算与窗口定位保持一致。
      // DPR=1 时折算为恒等变换，零回归。
      const dpr = window.devicePixelRatio || 1;
      let vx = 0, vy = 0, vw = 0, vh = 0;
      try {
        const disp = await invoke<DisplayInfo[]>('list_displays');
        if (disp.length > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const d of disp) {
            minX = Math.min(minX, d.x);
            minY = Math.min(minY, d.y);
            maxX = Math.max(maxX, d.x + d.width);
            maxY = Math.max(maxY, d.y + d.height);
          }
          vx = minX; vy = minY;
          vw = maxX - minX; vh = maxY - minY;
        }
      } catch { /* ignore，退回让系统决定尺寸 */ }
      new WebviewWindow('region-overlay', {
        // 把虚拟桌面原点 + dpr 通过 URL 传给覆盖层，用于把 CSS 局部坐标换算成全局物理像素
        url: `/#region-overlay?vx=${vx}&vy=${vy}&vw=${vw}&vh=${vh}&dpr=${dpr}`,
        // 物理像素 → 逻辑像素（Tauri 窗口几何单位），HiDPI 下覆盖层才能精确铺满虚拟桌面
        x: Math.round(vx / dpr),
        y: Math.round(vy / dpr),
        width: Math.round(vw / dpr) || undefined,
        height: Math.round(vh / dpr) || undefined,
        transparent: true,
        decorations: false,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        fullscreen: false,
        focus: true,
      } as any);
    } catch (e) {
      flash(t('toast.openRegionFailed', { msg: String(e) }), 'error');
      try { await getCurrentWindow().show(); } catch { /* ignore */ }
    }
  }, [flash]);

  // Windows/Linux 窗口截图：打开覆盖整个虚拟桌面的窗口点选覆盖层。
  // 覆盖层枚举窗口画高亮框，用户点选后 emit 'window-picked' 带 window_id 回传。
  const openWindowOverlay = useCallback(async () => {
    try {
      const existing = await WebviewWindow.getByLabel('window-overlay').catch(() => null);
      if (existing) {
        try { await existing.setFocus(); } catch { /* ignore */ }
        return;
      }
      const main = getCurrentWindow();
      await main.hide();
      // 同 region-overlay：list_displays 返回物理像素，Tauri 窗口几何用逻辑像素，
      // 按 dpr 折算避免 HiDPI Windows 下覆盖层错位；dpr 经 URL 传给覆盖层保持换算一致。
      const dpr = window.devicePixelRatio || 1;
      let vx = 0, vy = 0, vw = 0, vh = 0;
      try {
        const disp = await invoke<DisplayInfo[]>('list_displays');
        if (disp.length > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const d of disp) {
            minX = Math.min(minX, d.x);
            minY = Math.min(minY, d.y);
            maxX = Math.max(maxX, d.x + d.width);
            maxY = Math.max(maxY, d.y + d.height);
          }
          vx = minX; vy = minY;
          vw = maxX - minX; vh = maxY - minY;
        }
      } catch { /* ignore */ }
      new WebviewWindow('window-overlay', {
        url: `/#window-overlay?vx=${vx}&vy=${vy}&vw=${vw}&vh=${vh}&dpr=${dpr}`,
        x: Math.round(vx / dpr),
        y: Math.round(vy / dpr),
        width: Math.round(vw / dpr) || undefined,
        height: Math.round(vh / dpr) || undefined,
        transparent: true,
        decorations: false,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        fullscreen: false,
        focus: true,
      } as any);
    } catch (e) {
      flash(t('toast.openWindowFailed', { msg: String(e) }), 'error');
      try { await getCurrentWindow().show(); } catch { /* ignore */ }
    }
  }, [flash]);

  const doCapture = useCallback(
    async (kind: 'screen' | 'region' | 'window') => {
      flog(`doCapture 触发: kind=${kind} platform=${platform} busy=${busyRef.current} delay=${captureDelayRef.current}`);
      if (busyRef.current) return; // 防重入：用 ref 而非 state，避免作为 useCallback 依赖
      // 多显示器：全屏截图先让用户选具体显示器（macOS 用 CGDisplayBounds、Windows 用 xcap 均支持按 id 截取）
      // 总是即时获取最新显示器列表（不依赖 displays 状态闭包值，避免旧值导致选择器不弹出）
      if (kind === 'screen') {
        let disp: DisplayInfo[] = [];
        try {
          disp = await invoke<DisplayInfo[]>('list_displays');
          if (disp.length > 0) setDisplays(disp);
        } catch { /* ignore，退回单屏 */ }
        flog(`doCapture(screen): 枚举到 ${disp.length} 块显示器${disp.length > 1 ? ' → 弹出选屏器' : ' → 直接截主屏'}`);
        if (disp.length > 1) {
          // 多屏：弹出居中选择器（不遮挡真实屏幕），用户点选后 pickDisplay 截取
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
          setShowDisplayPicker(true);
          return;
        }
      }
      busyRef.current = true;
      setBusy(true);
      // 区域截图分流：
      //  - macOS：走系统原生交互式 -i（下方统一 invoke capture_region）；
      //  - Windows/Linux：系统无可调用的交互截图 API，打开自建全屏覆盖层选区，
      //    选区完成后由 'region-selected' 事件回调真正 invoke capture_region。
      if (kind === 'region' && platform !== '' && (platform !== 'macos' || isSandboxed)) {
        busyRef.current = false;
        setBusy(false);
        await openRegionOverlay();
        return;
      }
      // 窗口截图分流：
      //  - macOS：走系统原生 -w 点窗（下方统一 invoke capture_window）；
      //  - Windows/Linux：打开窗口点选覆盖层，画高亮框让用户点选目标窗口，
      //    选中后由 'window-picked' 事件回调 invoke capture_window_by_id。
      if (kind === 'window' && platform !== '' && (platform !== 'macos' || isSandboxed)) {
        busyRef.current = false;
        setBusy(false);
        await openWindowOverlay();
        return;
      }
      // 权限预检：无权限则不隐藏窗口，直接触发授权弹窗 + 显示引导
      if (!(await ensureCapturePermission())) {
        busyRef.current = false;
        setBusy(false);
        return;
      }
      // 延时截图仅对全屏生效（区域/窗口是交互式，用户自己控制时机）。
      // 倒计时在窗口隐藏前跑，用户能看到读秒。
      if (kind === 'screen') {
        const delay = captureDelayRef.current;
        if (delay > 0) await runCountdown(delay);
      }
      const win = getCurrentWindow();
      // 隐藏自身窗口，避免截到工具界面（系统交互式截图 -i/-w 也不应把本工具截进去）
      // ⚠️ 全屏/最大化时走安全隐藏，先退出全屏等 Space 过渡结束，否则截到黑屏
      await safeHideForCapture(win);
      try {
        // 区域 / 窗口截图：直接交给 macOS 系统原生交互式截图。
        // region → 后端 screencapture -i（系统十字选区，等同 Cmd+Shift+4，
        //           自动支持跨屏拖选、空格切窗口模式、Esc 取消）。
        // window → 后端 screencapture -w（系统点窗取图）。
        // 系统 WindowServer 自行处理跨屏/负坐标/取消，比自建透明覆盖层可靠得多，
        // 且不自建任何遮挡真实屏幕的窗口。
        const cmd =
          kind === 'screen' ? 'capture_screen' : kind === 'region' ? 'capture_region' : 'capture_window';
        // capture_screen 需要 displayId=null（截主屏）；region/window 无需参数（后端走交互式）
        const args = kind === 'screen' ? { displayId: null } : {};
        const invT0 = performance.now();
        flog(`doCapture: invoke ${cmd} args=${JSON.stringify(args)}`);
        const dataUrl = await invoke<string>(cmd, args);
        flog(
          `doCapture: ${cmd} 返回 dataUrl长度=${dataUrl?.length ?? 0} invoke耗时=${(performance.now() - invT0).toFixed(0)}ms`
        );
        await onCaptured(dataUrl);
      } catch (e) {
        const msg = String(e);
        flog(`❌ doCapture(${kind}) 抛错: ${msg}`);
        // 权限被拒：自动重检权限状态，弹出引导页
        if (msg.includes('屏幕录制') || msg.includes('permission') || msg.includes('denied') || msg.includes('not authorized')) {
          if (platform === 'macos') {
            // 后台重检权限，若确实没权限则弹出引导页
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
        await win.show();
        await win.setFocus();
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onCaptured, flash, platform, isSandboxed, setPermissionNeeded, ensureCapturePermission, openRegionOverlay, openWindowOverlay, runCountdown]
  );

  // ===== 全局快捷键监听 =====
  // 依赖数组不含 doCapture（doCapture 用 busyRef 防重入，不再依赖 busy state），
  // 避免截图过程中 busy 变化导致监听器注销/重注册产生事件丢失竞态
  useEffect(() => {
    const un: Promise<UnlistenFn>[] = [
      listen('capture-screen', () => doCapture('screen')),
      listen('capture-region', () => doCapture('region')),
      listen('capture-window', () => doCapture('window')),
      listen('shortcut-register-failed', (e) => {
        flash(String(e.payload), 'error');
      }),
    ];
    return () => {
      un.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [doCapture, flash]);

  // ===== 滚动长截图：全局快捷键「捕获下一帧」监听 =====
  // 后端 ⌘/Ctrl+Shift+4 → emit 'capture-scroll-frame'。仅在滚动态响应，
  // 这样用户滚动时无需切回控制条即可连续捕帧。用 ref 判断状态，避免依赖 scrolling 重注册。
  const captureScrollFrameRef = useRef(captureScrollFrame);
  useEffect(() => {
    captureScrollFrameRef.current = captureScrollFrame;
  }, [captureScrollFrame]);
  useEffect(() => {
    const un = listen('capture-scroll-frame', () => {
      if (scrollingRef.current) captureScrollFrameRef.current();
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // ===== 区域截图覆盖层事件（Windows/Linux）=====
  // 覆盖层选区完成 → 收到全局物理像素 rect → 真正 invoke capture_region → 展示结果。
  // 覆盖层取消 → 恢复主窗口显示。
  useEffect(() => {
    const un: Promise<UnlistenFn>[] = [
      listen('region-selected', async (e) => {
        const rect = e.payload as { x: number; y: number; width: number; height: number };
        const main = getCurrentWindow();
        try {
          const dataUrl = await invoke<string>('capture_region', { rect });
          await onCaptured(dataUrl);
          await main.show();
          await main.setFocus();
        } catch (err) {
          const msg = String(err);
          if (msg.includes('取消') || msg.toLowerCase().includes('cancel')) {
            flash(t('toast.cancelled'), 'success');
          } else {
            flash(t('toast.captureFailed', { msg }), 'error');
          }
          try { await main.show(); await main.setFocus(); } catch { /* ignore */ }
        }
      }),
      listen('region-cancelled', async () => {
        const main = getCurrentWindow();
        try { await main.show(); await main.setFocus(); } catch { /* ignore */ }
      }),
      // 窗口点选覆盖层：收到 window_id → invoke capture_window_by_id → 展示结果
      listen('window-picked', async (e) => {
        const { windowId } = e.payload as { windowId: number };
        const main = getCurrentWindow();
        try {
          const dataUrl = await invoke<string>('capture_window_by_id', { windowId });
          await onCaptured(dataUrl);
          await main.show();
          await main.setFocus();
        } catch (err) {
          const msg = String(err);
          if (msg.includes('取消') || msg.toLowerCase().includes('cancel')) {
            flash(t('toast.cancelled'), 'success');
          } else {
            flash(t('toast.captureFailed', { msg }), 'error');
          }
          try { await main.show(); await main.setFocus(); } catch { /* ignore */ }
        }
      }),
      listen('window-cancelled', async () => {
        const main = getCurrentWindow();
        try { await main.show(); await main.setFocus(); } catch { /* ignore */ }
      }),
    ];
    return () => {
      un.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [onCaptured, flash]);

  // 保存 / 复制时若已标注，合并标注后导出（否则用原始截图）。
  // 标注含马赛克时合并是异步的（需在 2D canvas 上二次合成），故返回 Promise。
  const getExportDataUrl = async (): Promise<string> => {
    if (annotations.length > 0 && canvasRef.current) {
      const merged = await canvasRef.current.getMergedImageDataUrl();
      if (merged) return merged;
    }
    return current!.dataUrl;
  };

  const handleSave = async () => {
    if (!current) return;
    const path = await save({
      defaultPath: `snapcraft-${Date.now()}.png`,
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (!path) return;
    try {
      await invoke('save_screenshot', { imageData: await getExportDataUrl(), filePath: path });
      setRevealPath(path);
      flash(t('toast.savedWithReveal', { path }), 'success', 5000);
    } catch (e) {
      flash(t('toast.saveFailed', { msg: String(e) }), 'error');
    }
  };

  const handleCopy = async () => {
    if (!current) return;
    try {
      await invoke('copy_to_clipboard', { imageData: await getExportDataUrl() });
      flash(t('toast.copied'), 'success');
    } catch (e) {
      flash(t('toast.copyFailed', { msg: String(e) }), 'error');
    }
  };



  // 通用：直接对某张图（dataUrl）复制 / 保存，供结果条与历史项复用（不经编辑器）
  const copyDataUrl = useCallback(async (dataUrl: string) => {
    try {
      invoke('diag_log', { msg: `[clip] 前端 copyDataUrl: dataUrl长度=${dataUrl?.length ?? 0} 前缀=${(dataUrl || '').slice(0, 30)}` }).catch(() => {});
      if (!dataUrl || !dataUrl.startsWith('data:image')) {
        flash(t('toast.copyInvalid'), 'error');
        invoke('diag_log', { msg: `[clip] 前端 copyDataUrl 中止：dataUrl 非法` }).catch(() => {});
        return;
      }
      await invoke('copy_to_clipboard', { imageData: dataUrl });
      flash(t('toast.copied'), 'success');
    } catch (e) {
      invoke('diag_log', { msg: `[clip] 前端 copyDataUrl 失败: ${String(e)}` }).catch(() => {});
      flash(t('toast.copyFailed', { msg: String(e) }), 'error');
    }
  }, [flash]);

  const saveDataUrl = useCallback(async (dataUrl: string) => {
    const path = await save({
      defaultPath: `snapcraft-${Date.now()}.png`,
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (!path) return;
    try {
      await invoke('save_screenshot', { imageData: dataUrl, filePath: path });
      setRevealPath(path);
      flash(t('toast.savedWithReveal', { path }), 'success', 5000);
    } catch (e) {
      flash(t('toast.saveFailed', { msg: String(e) }), 'error');
    }
  }, [flash]);

  // 钉图：把某张截图钉在屏幕上——开一个无边框、置顶、可拖动的小浮窗（非全屏遮挡）。
  // 尺寸按图等比缩放并限制最大值，避免 4K 截图铺满屏幕；数据经 id 由钉图窗自行查后端历史。
  const pinShot = useCallback(async (shot: { id: string; dataUrl: string; width: number; height: number }) => {
    const MAX_W = 720;
    const MAX_H = 520;
    const ratio = Math.min(MAX_W / shot.width, MAX_H / shot.height, 1);
    const w = Math.max(80, Math.round(shot.width * ratio));
    const h = Math.max(60, Math.round(shot.height * ratio));
    const label = `pin-${shot.id}`;
    try {
      const existing = await WebviewWindow.getByLabel(label).catch(() => null);
      if (existing) {
        try { await existing.setFocus(); } catch { /* ignore */ }
        return;
      }
      new WebviewWindow(label, {
        title: t('pin.windowTitle'),
        url: `/#pin?id=${encodeURIComponent(shot.id)}`,
        width: w,
        height: h,
        // 稍微偏移，避免总是叠在同一位置
        x: 80 + Math.round(Math.random() * 60),
        y: 80 + Math.round(Math.random() * 60),
        transparent: true,
        decorations: false,
        alwaysOnTop: true,
        resizable: true,
        skipTaskbar: false,
        shadow: true,
      } as any);
      flash(t('toast.pinned'), 'success');
    } catch (e) {
      flash(t('toast.pinFailed', { msg: String(e) }), 'error');
    }
  }, [flash]);

  // 删除单条历史：后端按 id 移除并整体重写 history.json（图内联其中，删条目即删图，无孤儿文件）
  const handleDeleteHistory = async (id: string) => {
    if (!id) return;
    try {
      await invoke('delete_history', { id });
      // 同步清掉前端内存里的对应条目，避免界面残留已删的脏数据
      setHistory((h) => h.filter((x) => x.id !== id));
      // 若被删的正是编辑视图当前引用的那条，连带清空当前态，杜绝脏引用
      if (currentScreenshot?.id === id) {
        setCurrentScreenshot(null);
        setCurrent(null);
        if (currentView === 'edit') setCurrentView('home');
      }
      flash(t('toast.deleted'), 'success');
    } catch (e) {
      flash(t('toast.deleteFailed', { msg: String(e) }), 'error');
    }
  };

  // 清空全部历史：先二次确认，再清后端 + 前端状态，确保彻底清理
  const handleClearHistory = async () => {
    if (!window.confirm(t('history.clearConfirm'))) return;
    try {
      await invoke('clear_history');
      setHistory([]);
      // 彻底清理：清空后不应残留任何已删截图的引用
      setCurrentScreenshot(null);
      setCurrent(null);
      if (currentView === 'edit') setCurrentView('home');
      flash(t('toast.historyCleared'), 'success');
    } catch (e) {
      flash(t('toast.historyClearFailed', { msg: String(e) }), 'error');
    }
  };


  const cycleTheme = () =>
    setTheme((t) => (t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light'));
  const themeIcon = theme === 'light' ? '☀️' : theme === 'dark' ? '🌙' : '🖥️';
  const themeLabel = theme === 'light' ? t('theme.light') : theme === 'dark' ? t('theme.dark') : t('theme.system');

  const openHistory = (h: HistoryEntry) => {
    setCurrent({ dataUrl: h.dataUrl, width: h.width, height: h.height });
    setCurrentScreenshot({
      id: h.id,
      filePath: '',
      dataUrl: h.dataUrl,
      width: h.width,
      height: h.height,
      annotations: [],
      layers: [],
      createdAt: h.createdAt,
      updatedAt: h.createdAt,
    });
    clearAnnotations();
    setCurrentView('edit');
  };

  // ===== 编辑视图：⌘/Ctrl+S 保存、⌘/Ctrl+C 复制 =====
  useEffect(() => {
    if (currentView !== 'edit') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        // 只在没有选中文本时拦截，避免影响正常文本复制
        const sel = window.getSelection();
        if (!sel || sel.toString().length === 0) {
          e.preventDefault();
          handleCopy();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentView, current, annotations]);

  // ===== 编辑视图 =====
  if (currentView === 'edit' && current) {
    return (
      <div className="editor-view">
        <div className="editor-toolbar">
          <div className="toolbar-left">
            <button
              className="tbar-btn tbar-ghost back-btn"
              onClick={() => {
                setCurrent(null);
                setCurrentView('home');
              }}
            >
              <TBIcon d={TB_PATHS.back} />
              {t('editor.back')}
            </button>
            <div className="editor-info">
              <span className="editor-info-dim">{current.width} × {current.height}</span>
              <span className="editor-info-sep">·</span>
              <span>{t('editor.annotations', { n: annotations.length })}</span>
            </div>
          </div>
          <AnnotationToolbar />
          <div className="toolbar-right">
            <button className="tbar-icon-btn" title={t('editor.themeTitle', { label: themeLabel })} onClick={cycleTheme}>
              {themeIcon}
            </button>
            <div className="tbar-divider" />
            <button
              className="tbar-btn tbar-ghost"
              onClick={handleOcr}
              disabled={ocrBusy || ocrRegionMode}
              title={t('editor.ocrTitle')}
            >
              <TBIcon d={TB_PATHS.ocr} />
              {ocrBusy ? t('editor.ocrBusy') : t('editor.ocr')}
            </button>
            <button
              className={`tbar-btn tbar-ghost${ocrRegionMode ? ' active' : ''}`}
              onClick={() => setOcrRegionMode((v) => !v)}
              disabled={ocrBusy}
              title={t('ocr.regionTitle')}
            >
              <TBIcon d={TB_PATHS.ocr} />
              {t('ocr.region')}
            </button>
            <button
              className="tbar-btn tbar-ghost"
              onClick={() => openClipboardOcrWindow()}
              disabled={ocrBusy}
              title={t('ocr.clipTitle')}
            >
              📋 {t('ocr.clipboard')}
            </button>
            <button
              className={`tbar-btn tbar-ghost${aiOpen ? ' active' : ''}`}
              onClick={async () => {
                await ai.openAi();
              }}
              disabled={!current}
              title={t('ai.openAi')}
            >
              ✨ AI
            </button>
            <button className="tbar-btn tbar-ghost" onClick={handleCopy} title={t('editor.copyTitle', { mod: modLabel })}>
              <TBIcon d={TB_PATHS.copy} />
              {t('editor.copy')}
            </button>
            {currentScreenshot && (
              <button
                className="tbar-btn tbar-ghost"
                onClick={() => pinShot({ id: currentScreenshot.id, dataUrl: current.dataUrl, width: current.width, height: current.height })}
                title={t('editor.pinTitle')}
              >
                <TBIcon d={TB_PATHS.pin} />
                {t('editor.pin')}
              </button>
            )}
            <button className="tbar-btn tbar-primary save-btn" onClick={handleSave} title={t('editor.saveTitle', { mod: modLabel })}>
              <TBIcon d={TB_PATHS.save} />
              {t('editor.save')}
            </button>
          </div>
        </div>
        <div className="editor-canvas-area">
          <div className="editor-canvas">
            <AnnotationCanvas
              ref={canvasRef}
              imageData={current.dataUrl}
              annotations={annotations}
              onAnnotationAdd={addAnnotation}
              activeTool={activeTool}
              onCropped={onCropped}
              ocrRegionMode={ocrRegionMode}
              onRegionOcr={onRegionOcr}
            />
            {ocrRegionMode && (
              <div className="ocr-region-hint">
                <span>{t('ocr.regionHint')}</span>
                <button className="tbar-btn tbar-ghost" onClick={() => setOcrRegionMode(false)}>
                  {t('ocr.regionCancel')}
                </button>
              </div>
            )}
          </div>
        </div>
        {toast && (
          <div className={`toast toast-${toastType}`}>
            <span className="toast-icon">{toastType === 'error' ? '!' : toastType === 'info' ? 'ℹ' : '✓'}</span>
            <span className="toast-msg">{toast}</span>
            {revealPath && (
              <button
                className="toast-reveal-btn"
                onClick={() => invoke('reveal_in_folder', { path: revealPath })}
                title={t('toast.revealTitle')}
              >
                {t('toast.reveal')}
              </button>
            )}
          </div>
        )}
        <OcrPanel
          ocr={ocr}
          current={current}
          flash={flash}
          t={t}
          history={history}
          setCurrentScreenshot={setCurrentScreenshot}
        />
      </div>
    );
  }

  // ===== 滚动长截图控制条（主窗口已缩为角落小窗）=====
  if (scrolling) {
    const shiftK = isWinLike ? 'Shift' : '⇧';
    return (
      <div className="scroll-ctrl" data-tauri-drag-region>
        <div className="scroll-ctrl-head">
          <span className="scroll-ctrl-dot" />
          <span className="scroll-ctrl-title">{t('scroll.title')}</span>
          <span className="scroll-ctrl-count">{t('scroll.frames', { n: scrollFrames.length })}</span>
        </div>
        <div className="scroll-ctrl-hint">
          {t('scroll.hintPrefix')} <kbd className="kbd">{modLabel}</kbd><kbd className="kbd">{shiftK}</kbd><kbd className="kbd">4</kbd> {t('scroll.hintSuffix')}
        </div>
        <div className="scroll-ctrl-actions">
          <button
            className="scroll-ctrl-btn primary"
            onClick={captureScrollFrame}
            disabled={scrollBusy}
          >
            {scrollBusy ? t('scroll.captureBusy') : t('scroll.capture')}
          </button>
          <button
            className="scroll-ctrl-btn"
            onClick={finishScrollCapture}
            disabled={scrollBusy || scrollFrames.length === 0}
          >
            {t('scroll.finish')}
          </button>
          <button className="scroll-ctrl-btn ghost" onClick={cancelScrollCapture} disabled={scrollBusy}>
            {t('scroll.cancel')}
          </button>
        </div>
        {toast && (
          <div className={`toast toast-${toastType} scroll-ctrl-toast`}>
            <span className="toast-msg">{toast}</span>
          </div>
        )}
      </div>
    );
  }

  // ===== 主页视图 =====
  return (
    <div className="screenshot-app">
      <div className="topbar">
        <button className="theme-toggle" title={t('editor.themeTitle', { label: themeLabel })} onClick={cycleTheme}>
          {themeIcon}
        </button>
        <LanguageToggle />
      </div>

      <div className="home-view">
        <div style={{ textAlign: 'center' }}>
          <div className="app-title">SnapCraft</div>
          <div className="app-subtitle">{t('app.subtitle')}</div>
        </div>

        <div className="capture-actions">
          <div
            className="capture-card"
            role="button"
            tabIndex={0}
            aria-label={t('capture.screen.aria')}
            onClick={() => doCapture('screen')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                doCapture('screen');
              }
            }}
          >
            <div className="capture-card-icon">🖥️</div>
            <div className="capture-card-label">{t('capture.screen.label')}</div>
            <div className="capture-card-desc">
              <div className="capture-card-keys">
                <kbd className="kbd">{modLabel}</kbd>
                <kbd className="kbd">{shiftLabel}</kbd>
                <kbd className="kbd">S</kbd>
              </div>
              <span className="capture-card-desc-text">{t('capture.screen.desc')}</span>
            </div>
          </div>
          <div
            className="capture-card"
            role="button"
            tabIndex={0}
            aria-label={t('capture.region.aria')}
            onClick={() => doCapture('region')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                doCapture('region');
              }
            }}
          >
            <div className="capture-card-icon">✂️</div>
            <div className="capture-card-label">{t('capture.region.label')}</div>
            <div className="capture-card-desc">
              <div className="capture-card-keys">
                <kbd className="kbd">{modLabel}</kbd>
                <kbd className="kbd">{shiftLabel}</kbd>
                <kbd className="kbd">2</kbd>
              </div>
              <span className="capture-card-desc-text">{t('capture.region.desc')}</span>
            </div>
          </div>
          <div
            className="capture-card"
            role="button"
            tabIndex={0}
            aria-label={t('capture.window.aria')}
            onClick={() => doCapture('window')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                doCapture('window');
              }
            }}
          >
            <div className="capture-card-icon">🪟</div>
            <div className="capture-card-label">{t('capture.window.label')}</div>
            <div className="capture-card-desc">
              <div className="capture-card-keys">
                <kbd className="kbd">{modLabel}</kbd>
                <kbd className="kbd">{shiftLabel}</kbd>
                <kbd className="kbd">3</kbd>
              </div>
              <span className="capture-card-desc-text">{t('capture.window.desc')}</span>
            </div>
          </div>
          <div
            className="capture-card"
            role="button"
            tabIndex={0}
            aria-label={t('capture.scroll.aria')}
            onClick={startScrollCapture}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                startScrollCapture();
              }
            }}
          >
            <div className="capture-card-icon">📜</div>
            <div className="capture-card-label">{t('capture.scroll.label')}</div>
            <div className="capture-card-desc">
              <div className="capture-card-keys">
                <kbd className="kbd">{modLabel}</kbd>
                <kbd className="kbd">{shiftLabel}</kbd>
                <kbd className="kbd">4</kbd>
              </div>
              <span className="capture-card-desc-text">{t('capture.scroll.desc')}</span>
            </div>
          </div>
        </div>

        {/* 从剪贴板取字：读取系统剪贴板中的任意图片并识别文字（第四个 OCR 入口，
            覆盖「图片已复制但不在 SnapCraft 内」的场景）。与截图入口并列但独立，不影响其它功能。 */}
        <div className="home-secondary">
          <button
            className="home-sec-btn"
            onClick={() => openClipboardOcrWindow()}
            disabled={ocrBusy}
            title={t('ocr.clipTitle')}
          >
            📋 {t('ocr.clipboard')}
          </button>
        </div>

        {/* 延时截图：选一个延时后，全屏截图会先读秒再截，方便先展开菜单/悬浮态等瞬时 UI */}
        <div className="delay-bar" role="group" aria-label={t('home.delayLabel')}>
          <span className="delay-bar-label">⏱ {t('home.delayLabel')}</span>
          {[0, 3, 5].map((s) => (
            <button
              key={s}
              className={`delay-chip${captureDelay === s ? ' active' : ''}`}
              aria-pressed={captureDelay === s}
              onClick={() => setCaptureDelay(s)}
              title={s === 0 ? t('home.delayTitleOff') : t('home.delayTitleWait', { s })}
            >
              {s === 0 ? t('home.delayOff') : `${s}s`}
            </button>
          ))}
          <span className="delay-bar-hint">{t('home.delayOnlyFull')}</span>
        </div>

        {displays.length > 1 && (
          <div className="multi-display-hint">
            {t('home.multiDisplay', { n: displays.length })}
          </div>
        )}

        <div className="history-section">
          <div className="history-title">
            <span>📸</span>
            <span>{t('history.title')}</span>
            {history.length > 0 && (
              <>
                <button
                  className="history-clear-btn"
                  onClick={handleClearHistory}
                  title={t('history.clearTitle')}
                >
                  {t('history.clear')}
                </button>
                <button
                  className="history-sel-btn"
                  onClick={() => (selMode ? clearSel() : setSelMode(true))}
                  title={t('history.selectTitle')}
                >
                  {selMode ? t('history.selectDone') : t('history.select')}
                </button>
                {selMode && (
                  <button
                    className="history-sel-btn"
                    onClick={selectAll}
                    title={t('history.selectAllTitle')}
                  >
                    {t('history.selectAll')}
                  </button>
                )}
              </>
            )}
          </div>
          <div className="history-search-row">
            <input
              className="history-search-input"
              type="search"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              placeholder={t('history.searchPlaceholder')}
            />
            {historySearch && (
              <button className="history-search-clear" onClick={() => setHistorySearch('')} title={t('history.clear')}>✕</button>
            )}
          </div>

          {history.length === 0 ? (
            <div className="empty-history">
              <div className="empty-history-icon">📷</div>
              <div className="empty-history-text">{t('history.empty')}</div>
            </div>
          ) : filteredHistory.length === 0 ? (
            <div className="empty-history">
              <div className="empty-history-icon">🔍</div>
              <div className="empty-history-text">{t('history.noMatch')}</div>
            </div>
          ) : (
            <div className="history-grid">
              {filteredHistory.map((h) => (
                <div
                  key={h.id}
                  className={`history-item${selMode ? ' selecting' : ''}${selIds.includes(h.id) ? ' selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={t('history.viewAria', { time: new Date(h.createdAt).toLocaleString() })}
                  onClick={() => (selMode ? toggleSel(h.id) : openEditorWindow({ id: h.id, width: h.width, height: h.height }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selMode ? toggleSel(h.id) : openEditorWindow({ id: h.id, width: h.width, height: h.height });
                    }
                  }}
                >
                  {selMode && (
                    <div
                      className="history-item-check"
                      onClick={(e) => { e.stopPropagation(); toggleSel(h.id); }}
                    >
                      <input type="checkbox" checked={selIds.includes(h.id)} readOnly />
                    </div>
                  )}
                  <LazyHistoryThumb dataUrl={h.dataUrl} alt="screenshot" />
                  {h.source === 'clipboard' && (
                    <span className="history-item-badge" title={t('history.clipboardSourceTitle')}>
                      📋 {t('history.clipboardSource')}
                    </span>
                  )}
                  <div className="history-item-overlay">
                    <span>{new Date(h.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="history-item-actions">
                    <button
                      className="history-act-btn"
                      title={t('history.copyTitle')}
                      aria-label={t('history.copyAria')}
                      onClick={(e) => { e.stopPropagation(); copyDataUrl(h.dataUrl); }}
                    >
                      📋
                    </button>
                    <button
                      className="history-act-btn"
                      title={t('history.ocrTitle')}
                      aria-label={t('history.ocrAria')}
                      onClick={(e) => { e.stopPropagation(); startOcrFromShot(h); }}
                    >
                      🔍
                    </button>
                    <button
                      className="history-act-btn"
                      title={t('history.saveTitle')}
                      aria-label={t('history.saveAria')}
                      onClick={(e) => { e.stopPropagation(); saveDataUrl(h.dataUrl); }}
                    >
                      💾
                    </button>
                    <button
                      className="history-act-btn"
                      title={t('history.pinTitle')}
                      aria-label={t('history.pinAria')}
                      onClick={(e) => { e.stopPropagation(); pinShot(h); }}
                    >
                      📌
                    </button>
                    <button
                      className="history-act-btn danger"
                      title={t('history.deleteTitle')}
                      aria-label={t('history.deleteAria')}
                      onClick={(e) => { e.stopPropagation(); handleDeleteHistory(h.id); }}
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))}
            </div>
            )}
            {/* R4：批量取字操作条 */}
            {selMode && selIds.length > 0 && (
              <BatchBar batch={batch} t={t} />
            )}
          </div>
      </div>

      {/* R4：批量取字结果弹窗 */}

      <BatchOcrPanel batch={batch} flash={flash} t={t} />
      <AiBatchPanel batch={batch} flash={flash} t={t} />


      {showDisplayPicker && displays.length > 1 && (
        <DisplayPicker
          displays={displays}
          onPick={pickDisplay}
          onCancel={() => setShowDisplayPicker(false)}
        />
      )}

      {lastShot && (
        <div className="result-bar" role="dialog" aria-label={t('result.aria')}>
          <img className="result-bar-thumb" src={lastShot.dataUrl} alt={t('result.thumbAlt')} />
          <div className="result-bar-info">
            <div className="result-bar-title">{t('result.title')}</div>
            <div className="result-bar-sub">{t('result.sub', { w: lastShot.width, h: lastShot.height })}</div>
          </div>
          <div className="result-bar-actions">
            <button className="result-bar-btn" title={t('result.copyTitle')} onClick={() => copyDataUrl(lastShot.dataUrl)}>📋 {t('result.copy')}</button>
            <button className="result-bar-btn" title={t('result.ocrTitle')} onClick={() => startOcrFromShot(lastShot)}>🔍 {t('result.ocr')}</button>
            <button className="result-bar-btn" title={t('result.editTitle')} onClick={() => { if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current); setLastShot(null); openEditorWindow({ id: lastShot.id, width: lastShot.width, height: lastShot.height }); }}>✏️ {t('result.edit')}</button>
            <button className="result-bar-btn" title={t('result.saveTitle')} onClick={() => saveDataUrl(lastShot.dataUrl)}>💾 {t('result.save')}</button>
            <button className="result-bar-btn" title={t('result.pinTitle')} onClick={() => pinShot(lastShot)}>📌 {t('result.pin')}</button>
          </div>
          <button
            className="result-bar-close"
            title={t('result.close')}
            aria-label={t('result.close')}
            onClick={() => { if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current); setLastShot(null); }}
          >
            ✕
          </button>
        </div>
      )}

      {countdown !== null && (
        <div className="countdown-overlay" aria-live="assertive">
          <div className="countdown-num">{countdown}</div>
          <div className="countdown-text">{t('countdown.text')}</div>
        </div>
      )}

      {busy && countdown === null && (
        <div className="capturing-overlay">
          <div style={{ fontSize: '64px' }}>📷</div>
          <div className="capturing-text">{t('capturing.text')}</div>
        </div>
      )}
      {toast && (
        <div className={`toast toast-${toastType}`}>
          <span className="toast-icon">{toastType === 'error' ? '!' : toastType === 'info' ? 'ℹ' : '✓'}</span>
          <span className="toast-msg">{toast}</span>
          {revealPath && (
            <button
              className="toast-reveal-btn"
              onClick={() => invoke('reveal_in_folder', { path: revealPath })}
              title={t('toast.revealTitle')}
            >
              {t('toast.reveal')}
            </button>
          )}
        </div>
      )}
      {permissionNeeded && (
        <div className="permission-gate">
          <div className="permission-card">
            <div className="permission-icon">📸</div>
            <div className="permission-title">{t('permission.title')}</div>
            <div className="permission-text">
              {isDev ? (
                <>
                  {t('permission.dev1')}<b>{t('permission.devBadge')}</b>{t('permission.dev2')}
                  <b>{t('permission.devBrand')}</b>{t('permission.dev3')}
                </>
              ) : (
                <>
                  {t('permission.normal1')}<b>SnapCraft</b>{t('permission.normal2')}
                </>
              )}
            </div>
            <div className="permission-actions">
              <button className="permission-btn" onClick={openScreenRecordingSettings}>
                {t('permission.openSettings')}
              </button>
              <button className="permission-btn" onClick={recheckPermission} disabled={permissionChecking}>
                {permissionChecking ? t('permission.refreshing') : t('permission.refresh')}
              </button>
              <button
                className="permission-btn ghost"
                onClick={() => setPermissionNeeded(false)}
              >
                {t('permission.later')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EnhancedScreenshotApp;
