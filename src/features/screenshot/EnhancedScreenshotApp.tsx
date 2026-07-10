import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
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
          你的 Mac 外接了 {displays.length} 块显示器，点选其中一块即可只截取该屏。
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
              <div className="display-pick-name">{d.is_main ? '主屏' : `显示器 ${i + 1}`}</div>
              <div className="display-pick-res">
                {d.width} × {d.height}
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
  // 权限检查中：platform 未确定或正在 check/request 期间，避免 UI 闪烁
  const [permissionChecking, setPermissionChecking] = useState(true);
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
    addAnnotation,
  } = useScreenshotStore();

  const canvasRef = useRef<AnnotationCanvasHandle>(null);
  // busy 的 ref 镜像：供 doCapture 防重入检查，避免 busy 作为 useCallback 依赖
  // 导致事件监听器在截图过程中频繁注销/重注册（会产生事件丢失竞态窗口）
  const busyRef = useRef(false);
  // 超时定时器 ref：正常完成截图后清理，避免堆积
  const overlayTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    window.setTimeout(() => setToast(null), type === 'error' ? 5000 : 1800);
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
          img.onerror = () => rej(new Error('截图数据解码失败'));
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
      setCurrentView('edit');
      // 截图后自动复制到剪贴板——用户截图最常见的目的就是粘贴
      try {
        await invoke('copy_to_clipboard', { image_data: dataUrl });
        flash('已复制到剪贴板', 'success');
      } catch {
        /* 自动复制失败不阻断使用，用户可手动复制 */
      }
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

  // ===== macOS 屏幕录制权限：启动预检 → 自动请求弹窗 → 延迟复检 → fallback 手动引导 =====
  // 设计原则：用户只需点一次"允许"，系统弹窗后自动检测授权结果，形成闭环
  useEffect(() => {
    if (platform !== 'macos') {
      setPermissionChecking(false);
      return;
    }
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const check = async (isFromFocus = false) => {
      if (isFromFocus) {
        // focus 防抖：快速切换窗口时不连续触发
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => check(false), 300);
        return;
      }
      try {
        const ok = await invoke<boolean>('check_screen_capture_access');
        if (ok) {
          setPermissionNeeded(false);
          setPermissionChecking(false);
          return;
        }
        // 没权限：非 dev 模式先尝试 request 弹窗（首次会弹系统对话框）
        if (!isDev) {
          const granted = await invoke<boolean>('request_screen_capture_access');
          if (granted) {
            // CGRequestScreenCaptureAccess 返回 true 不代表用户已经点了"允许"，
            // 可能是系统弹窗刚出现。延迟 1.5s 后重新检查（用户可能已操作完）
            setTimeout(() => check(false), 1500);
            return;
          }
          // 返回 false：用户拒绝或弹窗未出现。延迟再查一次（系统弹窗有时延迟返回）
          setTimeout(() => check(false), 1000);
          return;
        }
        // dev 模式：显示引导页（dev 不会出现在系统设置列表中）
        setPermissionChecking(false);
        setPermissionNeeded(true);
      } catch {
        setPermissionChecking(false);
        setPermissionNeeded(true);
      }
    };

    check();
    // 从系统设置返回后重新检测（防抖）
    const onFocus = () => check(true);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [platform, isDev]);

  // 一键打开「系统设置 → 屏幕录制」
  const openScreenRecordingSettings = useCallback(() => {
    invoke('open_screen_recording_settings').catch(() => {});
  }, []);

  // 手动重新检查权限（用户在系统设置中授权后点"已授权？刷新"触发）
  const recheckPermission = useCallback(async () => {
    setPermissionChecking(true);
    try {
      const ok = await invoke<boolean>('check_screen_capture_access');
      setPermissionNeeded(!ok);
      if (ok) {
        flash('权限已授予，可以开始截图了', 'success');
      } else {
        flash('仍未检测到权限，请确认已在系统设置中开启', 'error');
      }
    } catch {
      setPermissionNeeded(true);
    } finally {
      setPermissionChecking(false);
    }
  }, [flash]);

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
      try {
        new WebviewWindow('capture-overlay', opts as any);
      } catch (e) {
        // 覆盖层创建失败：恢复主窗口并报错，避免窗口永久隐藏
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
        setBusy(false);
        flash('截图覆盖层启动失败：' + String(e), 'error');
      }
    },
    [platform, displays, flash]
  );

  // 多屏选择器：点选具体显示器后执行全屏截取该屏
  const pickDisplay = useCallback(
    async (displayId: number | null) => {
      setShowDisplayPicker(false);
      // displayId === null 表示用户点了「取消」
      if (displayId === null) {
        flash('已取消截图', 'success');
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      const win = getCurrentWindow();
      await win.hide();
      try {
        const dataUrl = await invoke<string>('capture_screen', { display_id: displayId });
        await onCaptured(dataUrl);
      } catch (e) {
        const msg = String(e);
        if (msg.includes('屏幕录制') || msg.includes('permission') || msg.includes('denied') || msg.includes('not authorized')) {
          if (platform === 'macos') {
            invoke<boolean>('check_screen_capture_access').then((ok) => {
              if (!ok) setPermissionNeeded(true);
            });
          }
          return;
        }
        if (msg.includes('截图已取消') || msg.toLowerCase().includes('cancelled')) {
          flash('已取消截图', 'success');
        } else {
          flash('截图失败：' + msg, 'error');
        }
      } finally {
        await win.show();
        await win.setFocus();
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onCaptured, flash, platform, setPermissionNeeded]
  );

  const doCapture = useCallback(
    async (kind: 'screen' | 'region' | 'window') => {
      if (busyRef.current) return; // 防重入：用 ref 而非 state，避免作为 useCallback 依赖
      // macOS 多显示器：全屏截图先让用户选具体显示器
      if (kind === 'screen' && platform === 'macos' && displays.length > 1) {
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
        setShowDisplayPicker(true);
        return;
      }
      busyRef.current = true;
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
          // 超时保护：覆盖层 60 秒未返回结果则自动恢复主窗口，避免永久卡死
          overlayTimeoutRef.current = setTimeout(async () => {
            const overlay = await WebviewWindow.getByLabel('capture-overlay').catch(() => null);
            if (overlay) {
              try { await overlay.close(); } catch { /* ignore */ }
              const win = getCurrentWindow();
              await win.show();
              await win.setFocus();
              busyRef.current = false;
              setBusy(false);
              flash('截图超时已自动取消', 'error');
            }
          }, 60_000);
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
          flash('已取消截图', 'success');
        } else {
          flash('截图失败：' + msg, 'error');
        }
      } finally {
        if (!overlayOpened) {
          await win.show();
          await win.setFocus();
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [onCaptured, flash, platform, openRegionOverlay, setPermissionNeeded, displays]
  );

  // ===== 全局快捷键监听 =====
  // 依赖数组不含 doCapture（doCapture 用 busyRef 防重入，不再依赖 busy state），
  // 避免截图过程中 busy 变化导致监听器注销/重注册产生事件丢失竞态
  useEffect(() => {
    const cleanupOverlayTimeout = () => {
      if (overlayTimeoutRef.current) {
        clearTimeout(overlayTimeoutRef.current);
        overlayTimeoutRef.current = null;
      }
    };
    const restoreWindow = async () => {
      cleanupOverlayTimeout();
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
      busyRef.current = false;
      setBusy(false);
    };
    const un: Promise<UnlistenFn>[] = [
      listen('capture-screen', () => doCapture('screen')),
      listen('capture-region', () => doCapture('region')),
      listen('capture-window', () => doCapture('window')),
      // 覆盖层回传截图结果
      listen('region-captured', (e) => {
        const payload = e.payload as string;
        // 校验 payload 有效性：必须是 data URL 字符串
        if (!payload || typeof payload !== 'string' || payload.length < 100) {
          restoreWindow();
          flash('截图数据异常，请重试', 'error');
          return;
        }
        onCaptured(payload)
          .then(() => restoreWindow())
          .catch(async (err) => {
            await restoreWindow();
            flash('截图处理失败：' + String(err), 'error');
          });
      }),
      listen('region-cancelled', () => {
        restoreWindow();
        flash('已取消截图', 'success');
      }),
      listen('shortcut-register-failed', (e) => {
        flash(String(e.payload), 'error');
      }),
    ];
    return () => {
      un.forEach((p) => p.then((fn) => fn()));
      // 组件卸载时清理超时定时器，避免内存泄漏
      if (overlayTimeoutRef.current) {
        clearTimeout(overlayTimeoutRef.current);
        overlayTimeoutRef.current = null;
      }
    };
  }, [doCapture, onCaptured, flash]);

  // 保存 / 复制时若已标注，合并标注后导出（否则用原始截图）
  const getExportDataUrl = (): string => {
    if (annotations.length > 0 && canvasRef.current) {
      const merged = canvasRef.current.getMergedImageDataUrl();
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
      flash('已删除该截图', 'success');
    } catch (e) {
      flash('删除失败：' + String(e), 'error');
    }
  };

  // 清空全部历史：先二次确认，再清后端 + 前端状态，确保彻底清理
  const handleClearHistory = async () => {
    if (!window.confirm('确定清空全部截图历史？此操作不可恢复。')) return;
    try {
      await invoke('clear_history');
      setHistory([]);
      // 彻底清理：清空后不应残留任何已删截图的引用
      setCurrentScreenshot(null);
      setCurrent(null);
      if (currentView === 'edit') setCurrentView('home');
      flash('已清空全部历史', 'success');
    } catch (e) {
      flash('清空失败：' + String(e), 'error');
    }
  };

  const cycleTheme = () =>
    setTheme((t) => (t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light'));
  const themeIcon = theme === 'light' ? '☀️' : theme === 'dark' ? '🌙' : '🖥️';
  const themeLabel = theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统';

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
            <button className="toolbar-btn" onClick={handleCopy} title={`${modLabel}+C 复制`}>
              📋 复制
            </button>
            <button className="toolbar-btn save-btn" onClick={handleSave} title={`${modLabel}+S 保存`}>
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
            {history.length > 0 && (
              <button
                className="history-clear-btn"
                onClick={handleClearHistory}
                title="清空全部历史"
              >
                清空
              </button>
            )}
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
                    className="history-del-btn"
                    title="删除该截图"
                    aria-label="删除该截图"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteHistory(h.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        e.preventDefault();
                        handleDeleteHistory(h.id);
                      }
                    }}
                  >
                    🗑
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
      {permissionNeeded && (
        <div className="permission-gate">
          <div className="permission-card">
            <div className="permission-icon">📸</div>
            <div className="permission-title">需要屏幕录制权限</div>
            <div className="permission-text">
              {isDev ? (
                <>
                  当前以 <b>开发模式（dev .app）</b> 运行，已具备完整 .app 结构，
                  与正式版一样可直接授权屏幕录制。点一次「全屏截图」系统会弹出
                  授权请求（允许即可），或在下方打开系统设置找到{' '}
                  <b>SnapCraft（dev）</b> 打开开关，然后点「已授权？刷新」。
                </>
              ) : (
                <>
                  SnapCraft 需要「屏幕录制」权限才能截取屏幕。点击下方按钮打开系统设置，
                  在列表中找到 <b>SnapCraft</b> 并打开开关，然后返回点「已授权？刷新」即可。
                </>
              )}
            </div>
            <div className="permission-actions">
              <button className="permission-btn" onClick={openScreenRecordingSettings}>
                打开系统设置
              </button>
              <button className="permission-btn" onClick={recheckPermission} disabled={permissionChecking}>
                {permissionChecking ? '检查中…' : '已授权？刷新'}
              </button>
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
