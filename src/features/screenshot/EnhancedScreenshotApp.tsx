import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit, once, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { save } from '@tauri-apps/plugin-dialog';
import { AnnotationToolbar } from './components/AnnotationToolbar';
import AnnotationCanvas, { AnnotationCanvasHandle } from './components/AnnotationCanvas';
import { useScreenshotStore } from './store/screenshotStore';

type Theme = 'light' | 'dark' | 'system';

interface HistoryEntry {
  id: string;
  dataUrl: string;
  createdAt: string;
  width: number;
  height: number;
}

// macOS 显示器信息（list_displays 返回：逻辑点坐标 + 真实物理像素 + 缩放比）
interface DisplayInfo {
  id: number;
  is_main: boolean;
  x: number;
  y: number;
  width: number; // 逻辑点宽（系统设置里「看起来」的分辨率）
  height: number; // 逻辑点高
  scale: number; // 缩放比 = 物理像素 / 逻辑点
  physical_width: number; // 真实物理像素宽（截图实际抓到的像素数）
  physical_height: number; // 真实物理像素高
}

// 把缩放比格式化成「2×」/「1.5×」这类易读标签
const fmtScale = (s: number): string => {
  const r = Math.round(s * 100) / 100;
  return (Number.isInteger(r) ? `${r}` : r.toFixed(2)) + '×';
};

// 多屏选择器：点选具体显示器后由 pickDisplay 执行截取
const DisplayPicker = ({
  displays,
  onPick,
  onCancel,
}: {
  displays: DisplayInfo[];
  onPick: (id: number | null) => void;
  onCancel: () => void;
}) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  displays.forEach((d) => {
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
        <div className="permission-title">选择要截取的显示器</div>
        <div className="permission-text">
          你的 Mac 外接了 {displays.length} 块显示器。每张卡片标注了「真实物理像素 ·
          缩放比」，点选后将以该屏的原生分辨率截图。
        </div>
        <div
          className="display-picker-grid"
          style={{ aspectRatio: `${uw} / ${uh}`, position: 'relative', width: '100%' }}
        >
          {displays.map((d, i) => (
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
              <div className="display-pick-name">
                {d.is_main ? '主屏' : `显示器 ${i + 1}`}
                <span className="display-pick-scale">{fmtScale(d.scale)}</span>
              </div>
              <div className="display-pick-res">
                {d.physical_width} × {d.physical_height}
              </div>
              <div className="display-pick-sub">
                逻辑 {d.width} × {d.height}
              </div>
            </button>
          ))}
        </div>
        <div className="permission-actions">
          <button className="permission-btn ghost" onClick={onCancel}>
            取消
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
  const [current, setCurrent] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastType, setToastType] = useState<'success' | 'error'>('success');
  const [platform, setPlatform] = useState<string>('');
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [showDisplayPicker, setShowDisplayPicker] = useState(false);
  const [permissionNeeded, setPermissionNeeded] = useState(false);
  // 截图后快捷选择栏：截完不直接进编辑，先弹一排（复制/钉图/保存/编辑/重截）
  const [capturedPreview, setCapturedPreview] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const [lastCaptureKind, setLastCaptureKind] = useState<'screen' | 'region' | 'window'>('screen');
  // 开发模式（tauri dev）跑的是裸二进制，macOS 不会把它列入 TCC「屏幕录制」列表，
  // 因此无法在系统设置里出现/授权；只有 build 出的 .app 才会被系统登记到权限列表。
  const isDev = (import.meta as any).env?.DEV === true;

  // 让本窗口对截屏「隐形」：避免工具自身被截进画面
  // （mac 用 NSWindow.sharingType=.none，Windows 用 WDA_EXCLUDEFROMCAPTURE）
  useEffect(() => {
    invoke('apply_window_stealth', { label: getCurrentWindow().label }).catch(() => {});
  }, []);

  const {
    setCurrentScreenshot,
    clearAnnotations,
    annotations,
    activeTool,
    addAnnotation,
  } = useScreenshotStore();

  const canvasRef = useRef<AnnotationCanvasHandle>(null);

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

  const flash = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToast(msg);
    setToastType(type);
    window.setTimeout(() => setToast(null), 1800);
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
      const { width, height } = await new Promise<{ width: number; height: number }>(
        (res, rej) => {
          const img = new Image();
          img.onload = () => res({ width: img.width, height: img.height });
          // 损坏 dataUrl 时 reject，否则 Promise 永挂 → 主窗口永久隐藏 + busy 卡死
          img.onerror = () => rej(new Error('截图数据损坏，无法解码'));
          img.src = dataUrl;
        }
      );
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date().toISOString();
      const entry: HistoryEntry = { id, dataUrl, createdAt, width, height };
      setHistory((h) => [entry, ...h]);
      try {
        await invoke('add_history', {
          item: { id, data_url: dataUrl, created_at: createdAt, width, height },
        });
      } catch {
        /* 持久化失败不阻断使用 */
      }
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
      // 不直接进编辑页：先弹快捷选择栏（复制/钉图/保存/编辑/重截），用户选「编辑」才进编辑器
      setCapturedPreview({ dataUrl, width, height });
    },
    [setCurrentScreenshot, clearAnnotations]
  );

  // ===== 平台检测（决定快捷键提示与区域截图方式）=====
  useEffect(() => {
    invoke('get_platform')
      .then((p) => setPlatform(p as string))
      .catch(() => setPlatform('macos'));
  }, []);

  const modLabel = platform === 'windows' || platform === 'linux' ? 'Ctrl' : '⌘';

  // macOS：加载显示器列表（多屏选择 + 覆盖层跨屏铺满需要）
  useEffect(() => {
    if (platform !== 'macos') return;
    invoke<DisplayInfo[]>('list_displays')
      .then(setDisplays)
      .catch(() => setDisplays([]));
  }, [platform]);

  // ===== macOS 屏幕录制权限：启动预检 + 从系统设置返回后自动复检 =====
  useEffect(() => {
    if (platform !== 'macos') return;
    const check = async () => {
      try {
        const ok = await invoke<boolean>('check_screen_capture_access');
        setPermissionNeeded(!ok);
      } catch {
        /* 检测失败不阻断使用 */
      }
    };
    check();
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [platform]);

  // 一键打开「系统设置 → 屏幕录制」，用户开启后返回即可
  const openScreenRecordingSettings = useCallback(() => {
    invoke('open_screen_recording_settings').catch(() => {});
  }, []);

  // 打开透明覆盖层：region（拖选）/ window（点击取窗）。
  // macOS 多屏：覆盖层铺满所有显示器并集，并把全局原点 (ox,oy) 传给覆盖层，
  // 以便把本地 CSS 坐标换算成 screencapture -R 需要的全局逻辑点。
  const openRegionOverlay = useCallback(
    async (mode: 'region' | 'window') => {
      const isMac = platform === 'macos';
      let ox = 0;
      let oy = 0;
      const q = new URLSearchParams({ mode, platform: isMac ? 'macos' : 'other' });
      const opts: Record<string, unknown> = {
        title: 'SnapCraft 截图选择',
        transparent: true,
        decorations: false,
        alwaysOnTop: true,
        resizable: false,
        visible: true,
      };
      if (isMac && displays.length > 0) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        displays.forEach((d) => {
          minX = Math.min(minX, d.x);
          minY = Math.min(minY, d.y);
          maxX = Math.max(maxX, d.x + d.width);
          maxY = Math.max(maxY, d.y + d.height);
        });
        ox = minX;
        oy = minY;
        opts.x = minX;
        opts.y = minY;
        opts.width = maxX - minX;
        opts.height = maxY - minY;
      } else {
        opts.fullscreen = true;
      }
      q.set('ox', String(ox));
      q.set('oy', String(oy));
      opts.url = `/#capture-overlay?${q.toString()}`;
      // 若上次覆盖层未正常关闭，先清掉再开，避免重复窗口
      const existing = await WebviewWindow.getByLabel('capture-overlay');
      if (existing) {
        try {
          await existing.close();
        } catch {
          /* ignore */
        }
      }
      new WebviewWindow('capture-overlay', opts as any);
    },
    [platform, displays]
  );

  // 选屏后直接抓取该屏整屏画面。颜色已修（NoneSkipLast + 强制 alpha255 + Y 翻转）；
  // 多屏走几何矩形 CGWindowListCreateImage，精确对应选中屏，不会截到主屏。
  // 注：曾尝试「选屏→覆盖层→拖选」交互，但 Tauri WebviewWindow 在多屏下的窗口坐标系
  // 与 CoreGraphics 全局坐标不一致，覆盖层会错位并把主窗口状态搞乱（主页面乱跳），
  // 故回退到稳定的直接抓取。覆盖层式区域选择待后续用更可靠的坐标方案再迭代。
  const pickDisplay = useCallback(
    async (displayId: number | null) => {
      setShowDisplayPicker(false);
      if (busy) return;
      setBusy(true);
      const win = getCurrentWindow();
      await win.hide();
      try {
        const dataUrl = await invoke<string>('capture_screen', { display_id: displayId });
        await onCaptured(dataUrl);
      } catch (e) {
        const msg = String(e);
        if (msg.includes('屏幕录制')) {
          setPermissionNeeded(true);
          return;
        }
        if (!msg.includes('截图已取消') && !msg.toLowerCase().includes('cancelled')) {
          flash('截图失败：' + msg, 'error');
        }
      } finally {
        await win.show();
        await win.setFocus();
        setBusy(false);
      }
    },
    [onCaptured, flash, busy, setPermissionNeeded]
  );

  const doCapture = useCallback(
    async (kind: 'screen' | 'region' | 'window') => {
      if (busy) return; // 防止 busy 期间（窗口隐藏前）重复点击 / 快捷键再次触发
      setLastCaptureKind(kind);
      // macOS 多显示器：全屏截图先让用户选具体显示器
      if (kind === 'screen' && platform === 'macos' && displays.length > 1) {
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
        setShowDisplayPicker(true);
        return;
      }
      setBusy(true);
      const win = getCurrentWindow();
      // 隐藏自身窗口，避免截到工具界面
      await win.hide();
      let overlayOpened = false;
      try {
        // 区域 / 窗口截图走应用内透明覆盖层（macOS 用非交互 -R / -w，绕开焦点坑）
        if (kind === 'region' || (kind === 'window' && platform === 'macos')) {
          await openRegionOverlay(kind);
          overlayOpened = true;
          // 兜底：覆盖层若崩溃/不发事件，30s 后强制恢复主窗口，避免永久隐藏 + busy 卡死
          window.setTimeout(() => {
            getCurrentWindow().show();
            setBusy(false);
          }, 30000);
          return; // 结果由 region-captured / region-cancelled 事件收尾
        }
        // Windows / Linux 窗口截图 / 全屏（单屏或主屏）
        const dataUrl = await invoke<string>(
          kind === 'screen' ? 'capture_screen' : 'capture_window',
          kind === 'screen' ? { display_id: null } : {}
        );
        await onCaptured(dataUrl);
      } catch (e) {
        const msg = String(e);
        // 权限被拒：弹出引导页，不再用吓人的技术报错
        if (msg.includes('屏幕录制')) {
          setPermissionNeeded(true);
          return;
        }
        if (!msg.includes('截图已取消') && !msg.toLowerCase().includes('cancelled')) {
          flash('截图失败：' + msg, 'error');
        }
      } finally {
        if (!overlayOpened) {
          await win.show();
          await win.setFocus();
          setBusy(false);
        }
      }
    },
    [onCaptured, flash, platform, openRegionOverlay, busy, setPermissionNeeded, displays]
  );

  // ===== 全局快捷键监听 =====
  useEffect(() => {
    const un: Promise<UnlistenFn>[] = [
      listen('capture-screen', () => doCapture('screen')),
      listen('capture-region', () => doCapture('region')),
      listen('capture-window', () => doCapture('window')),
      // Windows / Linux 区域截图由覆盖层回传结果
      listen('region-captured', (e) => {
        const win = getCurrentWindow();
        onCaptured(e.payload as string).then(() => {
          win.show();
          win.setFocus();
          setBusy(false);
        });
      }),
      listen('region-cancelled', () => {
        const win = getCurrentWindow();
        win.show();
        win.setFocus();
        setBusy(false);
      }),
    ];
    return () => {
      un.forEach((p) => p.then((fn) => fn()));
    };
  }, [doCapture, onCaptured]);

  // 保存 / 复制时若已标注，合并标注后导出（否则用原始截图）
  const getExportDataUrl = (): string => {
    if (annotations.length > 0 && canvasRef.current) {
      const merged = canvasRef.current.getMergedImageDataUrl();
      if (merged) return merged;
      // 合并失败（stage/layer 未就绪）静默回退原图会让标注丢失，这里明确提示
      flash('标注合并失败，已导出原图（标注未包含）', 'error');
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
      await invoke('save_screenshot', { image_data: getExportDataUrl(), file_path: path });
      flash('已保存到 ' + path, 'success');
    } catch (e) {
      flash('保存失败：' + String(e), 'error');
    }
  };

  const handleCopy = async () => {
    if (!current) return;
    try {
      await invoke('copy_to_clipboard', { image_data: getExportDataUrl() });
      flash('已复制到剪贴板', 'success');
    } catch (e) {
      flash('复制失败：' + String(e), 'error');
    }
  };

  // 钉图到桌面：通用版，接受任意 dataUrl（编辑页按钮 + 快捷栏都用它）
  const pinImage = useCallback(async (dataUrl: string, width: number, height: number) => {
    const label = `pin-${Date.now()}`;
    const w = Math.min(width, 1400);
    const h = Math.min(height, 900) + 28;
    let pinWin: WebviewWindow | null = null;
    // 握手：pin 窗口 mount 后 emit('pin-ready')，主窗口收到再 emit('pin-data')，避免竞态
    const un = await once<{ label: string }>('pin-ready', async (e) => {
      if (e.payload?.label === label && pinWin) {
        await pinWin.emit('pin-data', { dataUrl, width, height });
        un();
      }
    });
    pinWin = new WebviewWindow(label, {
      title: 'SnapCraft 钉图',
      url: '/#pin',
      width: w,
      height: h,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      resizable: true,
      skipTaskbar: true,
      center: true,
      // macOS 透明窗口需要 private API；Tauri 2.11 类型未暴露该字段，运行时支持
      macOSPrivateApi: true,
    } as any);
  }, []);

  const pinToDesktop = useCallback(async () => {
    if (!current) return;
    await pinImage(getExportDataUrl(), current.width, current.height);
  }, [current, getExportDataUrl, pinImage]);

  const cycleTheme = () =>
    setTheme((t) => (t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light'));
  const themeIcon = theme === 'light' ? '☀️' : theme === 'dark' ? '🌙' : '🖥️';
  const themeLabel = theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统';

  // 快捷选择栏按钮统一样式
  const cabBtn = {
    background: 'rgba(255,255,255,0.12)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 13,
    whiteSpace: 'nowrap',
  } as const;

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

  // 删除一条历史截图：本地立即移除（响应快）+ 后端持久化（防刷新复活）
  const deleteHistory = useCallback(async (id: string) => {
    setHistory((h) => h.filter((x) => x.id !== id));
    try {
      await invoke('delete_history', { id });
    } catch {
      /* 本地已删，忽略后端错误 */
    }
  }, []);

  // ===== 编辑视图 =====
  if (currentView === 'edit' && current) {
    return (
      <div className="editor-view">
        <div className="editor-toolbar">
          <div className="toolbar-left">
            <button
              className="toolbar-btn back-btn"
              onClick={() => {
                setCurrent(null);
                setCurrentView('home');
              }}
            >
              ← 返回
            </button>
            <div className="editor-info">
              <span className="editor-info-dim">{current.width} × {current.height}</span>
              <span className="editor-info-sep">·</span>
              <span>{annotations.length} 个标注</span>
            </div>
          </div>
          <AnnotationToolbar />
          <div className="toolbar-right">
            <button className="theme-toggle" title={`主题：${themeLabel}`} onClick={cycleTheme}>
              {themeIcon}
            </button>
            <button className="toolbar-btn" onClick={handleCopy}>
              📋 复制
            </button>
            <button className="toolbar-btn" onClick={pinToDesktop} title="钉到桌面（置顶显示，可拖动缩放）">
              📌 钉图
            </button>
            <button className="toolbar-btn save-btn" onClick={handleSave}>
              💾 保存
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
            />
          </div>
        </div>
        {toast && (
          <div className={`toast toast-${toastType}`}>
            <span className="toast-icon">{toastType === 'error' ? '!' : '✓'}</span>
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
        <button className="theme-toggle" title={`主题：${themeLabel}`} onClick={cycleTheme}>
          {themeIcon}
        </button>
      </div>

      <div className="home-view">
        <div style={{ textAlign: 'center' }}>
          <div className="app-title">SnapCraft</div>
          <div className="app-subtitle">智能截屏工具</div>
        </div>

        <div className="capture-actions">
          <div
            className="capture-card"
            role="button"
            tabIndex={0}
            aria-label="全屏截图"
            onClick={() => doCapture('screen')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                doCapture('screen');
              }
            }}
          >
            <div className="capture-card-icon">🖥️</div>
            <div className="capture-card-label">全屏截图</div>
            <div className="capture-card-desc">
              <kbd className="kbd">{modLabel}</kbd>
              <kbd className="kbd">⇧</kbd>
              <kbd className="kbd">S</kbd>
              <span>截取整个屏幕</span>
            </div>
          </div>
          <div
            className="capture-card"
            role="button"
            tabIndex={0}
            aria-label="区域截图"
            onClick={() => doCapture('region')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                doCapture('region');
              }
            }}
          >
            <div className="capture-card-icon">✂️</div>
            <div className="capture-card-label">区域截图</div>
            <div className="capture-card-desc">
              <kbd className="kbd">{modLabel}</kbd>
              <kbd className="kbd">⇧</kbd>
              <kbd className="kbd">2</kbd>
              <span>选择区域</span>
            </div>
          </div>
          <div
            className="capture-card"
            role="button"
            tabIndex={0}
            aria-label="窗口截图"
            onClick={() => doCapture('window')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                doCapture('window');
              }
            }}
          >
            <div className="capture-card-icon">🪟</div>
            <div className="capture-card-label">窗口截图</div>
            <div className="capture-card-desc">
              <kbd className="kbd">{modLabel}</kbd>
              <kbd className="kbd">⇧</kbd>
              <kbd className="kbd">3</kbd>
              <span>指定窗口</span>
            </div>
          </div>
        </div>

        {platform === 'macos' && displays.length > 1 && (
          <div className="multi-display-hint">
            检测到 {displays.length} 块显示器 · 全屏截图时会让你选择具体屏幕
          </div>
        )}

        <div className="history-section">
          <div className="history-title">
            <span>📸</span>
            <span>历史截图</span>
          </div>
          {history.length === 0 ? (
            <div className="empty-history">
              <div className="empty-history-icon">📷</div>
              <div className="empty-history-text">暂无截图，点击上方按钮开始截图</div>
            </div>
          ) : (
            <div className="history-grid">
              {history.map((h) => (
                <div
                  key={h.id}
                  className="history-item"
                  style={{ position: 'relative' }}
                  role="button"
                  tabIndex={0}
                  aria-label={`查看截图 ${new Date(h.createdAt).toLocaleString()}`}
                  onClick={() => openHistory(h)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openHistory(h);
                    }
                  }}
                >
                  <LazyHistoryThumb dataUrl={h.dataUrl} alt="screenshot" />
                  <div className="history-item-overlay">
                    <span>{new Date(h.createdAt).toLocaleString()}</span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteHistory(h.id);
                    }}
                    title="删除此截图"
                    aria-label="删除此截图"
                    style={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      width: 26,
                      height: 26,
                      borderRadius: 6,
                      border: 'none',
                      background: 'rgba(0,0,0,0.65)',
                      color: '#fff',
                      fontSize: 14,
                      cursor: 'pointer',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      zIndex: 5,
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showDisplayPicker && displays.length > 1 && (
        <DisplayPicker
          displays={displays}
          onPick={pickDisplay}
          onCancel={() => setShowDisplayPicker(false)}
        />
      )}

      {busy && (
        <div className="capturing-overlay">
          <div style={{ fontSize: '64px' }}>📷</div>
          <div className="capturing-text">正在截图…</div>
        </div>
      )}
      {toast && (
        <div className={`toast toast-${toastType}`}>
          <span className="toast-icon">{toastType === 'error' ? '!' : '✓'}</span>
          <span className="toast-msg">{toast}</span>
        </div>
      )}
      {capturedPreview && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'rgba(28,28,30,0.92)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            padding: '10px 14px',
            borderRadius: 14,
            boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
            zIndex: 80,
            border: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          <img
            src={capturedPreview.dataUrl}
            alt="captured"
            style={{ height: 48, borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)' }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={async () => {
                try {
                  await invoke('copy_to_clipboard', { image_data: capturedPreview.dataUrl });
                  flash('已复制', 'success');
                } catch (e) {
                  flash('复制失败：' + String(e), 'error');
                }
              }}
              style={cabBtn}
            >
              📋 复制
            </button>
            <button
              onClick={() => pinImage(capturedPreview.dataUrl, capturedPreview.width, capturedPreview.height)}
              style={cabBtn}
            >
              📌 钉图
            </button>
            <button
              onClick={async () => {
                const p = await save({
                  defaultPath: `snapcraft-${Date.now()}.png`,
                  filters: [{ name: 'PNG Image', extensions: ['png'] }],
                });
                if (!p) return;
                try {
                  await invoke('save_screenshot', { image_data: capturedPreview.dataUrl, file_path: p });
                  flash('已保存', 'success');
                } catch (e) {
                  flash('保存失败：' + String(e), 'error');
                }
              }}
              style={cabBtn}
            >
              💾 保存
            </button>
            <button
              onClick={() => {
                setCapturedPreview(null);
                setCurrentView('edit');
              }}
              style={cabBtn}
            >
              ✏️ 编辑
            </button>
            <button
              onClick={() => {
                setCapturedPreview(null);
                doCapture(lastCaptureKind);
              }}
              style={cabBtn}
            >
              🔄 重截
            </button>
            <button
              onClick={() => setCapturedPreview(null)}
              title="丢弃"
              aria-label="丢弃"
              style={{ ...cabBtn, width: 32, padding: 0 }}
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {permissionNeeded && (
        <div className="permission-gate">
          <div className="permission-card">
            <div className="permission-icon">📸</div>
            <div className="permission-title">需要屏幕录制权限</div>
            {isDev ? (
              <div className="permission-text">
                当前以 <b>开发模式</b>（<code className="kbd">tauri dev</code>）运行，macOS 不会把
                SnapCraft 列入「屏幕录制」权限列表，所以这里无法直接授权。请执行{' '}
                <code className="kbd">pnpm tauri build</code> 并运行打包好的{' '}
                <b>SnapCraft.app</b>，系统才会登记本应用，届时按提示一键授权即可。
              </div>
            ) : (
              <div className="permission-text">
                SnapCraft 需要「屏幕录制」权限才能为你截图。点击下方按钮打开系统设置，
                在列表中找到 <b>SnapCraft</b> 并打开开关即可，无需其他操作。
              </div>
            )}
            <div className="permission-actions">
              {!isDev && (
                <button className="permission-btn" onClick={openScreenRecordingSettings}>
                  打开系统设置
                </button>
              )}
              <button
                className="permission-btn ghost"
                onClick={() => setPermissionNeeded(false)}
              >
                稍后再说
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EnhancedScreenshotApp;
