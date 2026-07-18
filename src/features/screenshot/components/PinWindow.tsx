import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { t, useI18n } from '../../../i18n';

// 钉图浮窗：把某张截图钉在屏幕上的独立小窗口（无边框、置顶、可拖动）。
// 数据来源：从 URL 读 id → 调后端 get_history 找到对应图（避免通过 URL 传大 dataUrl）。
// 交互：拖动窗口移动；Esc / 双击 关闭；不遮挡全屏，只是一个可自由摆放的小浮窗。
// 诊断日志：写入后端 dev.log（tag=pin），不影响功能。fire-and-forget。
const plog = (msg: string) => {
  invoke('diag_log', { msg: `[pin] ${msg}` }).catch(() => {});
};

export const PinWindow = () => {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 订阅语言事件：主窗口切换语言时，本弹窗（独立 Tauri 窗口）通过跨窗口广播实时重渲染，
  // 自身不内置语言选择器，统一跟随主页面那一个事件源。
  useI18n();

  const close = useCallback(() => {
    plog('close() 调用 → 准备 getCurrentWindow().close()');
    const w = getCurrentWindow();
    plog(`close(): 当前窗口 label=${w.label}`);
    w.close()
      .then(() => plog('close(): window.close() resolved ✅'))
      .catch((err) => plog(`close(): window.close() REJECTED ❌ err=${String(err)}`));
  }, []);

  // 显式拖动：不依赖 data-tauri-drag-region 的自动注入检测（在 macOS 透明无边框窗口下常失效），
  // 改为在 mousedown 时手动调用 startDragging()，最可靠。点在关闭按钮上时不拖动。
  const startDrag = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    plog(`onMouseDown 触发: button=${e.button} target=<${target.tagName.toLowerCase()} class="${target.className}">`);
    if (e.button !== 0) {
      plog('startDrag: 非左键，忽略');
      return;
    }
    if (target.closest('.pin-window-close')) {
      plog('startDrag: 点在关闭按钮区域，不拖动');
      return; // 关闭按钮区域不触发拖动
    }
    const w = getCurrentWindow();
    plog(`startDrag: 调用 startDragging() 窗口 label=${w.label}`);
    w.startDragging()
      .then(() => plog('startDrag: startDragging() resolved ✅'))
      .catch((err) => plog(`startDrag: startDragging() REJECTED ❌ err=${String(err)}`));
  }, []);

  // 挂载诊断：确认 PinWindow 真的加载、窗口 label / 装饰状态
  useEffect(() => {
    (async () => {
      try {
        const w = getCurrentWindow();
        plog(`PinWindow 挂载: label=${w.label} hash=${window.location.hash}`);
        const [dec, size] = await Promise.all([
          w.isDecorated().catch((e) => `err:${String(e)}`),
          w.innerSize().catch((e) => `err:${String(e)}`),
        ]);
        plog(`PinWindow 窗口状态: decorated=${dec} innerSize=${JSON.stringify(size)}`);
      } catch (e) {
        plog(`PinWindow 挂载诊断异常: ${String(e)}`);
      }
    })();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    const id = params.get('id');
    const inline = params.get('inline'); // 兜底：小图可直接内联传（sessionStorage key）
    (async () => {
      // 优先从 sessionStorage 取（同源同 SPA，openPin 时写入），失败再查后端历史
      if (inline) {
        const cached = sessionStorage.getItem(inline);
        if (cached) { setDataUrl(cached); return; }
      }
      if (!id) { setError(t('pin.missing')); return; }
      try {
        const raw = (await invoke('get_history')) as any[];
        const item = Array.isArray(raw) ? raw.find((i) => i.id === id) : null;
        if (item?.data_url) setDataUrl(item.data_url);
        else setError(t('pin.notFound'));
      } catch (e) {
        setError(t('pin.readFailed', { msg: String(e) }));
      }
    })();
  }, []);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        plog('Esc 按下 → close()');
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
      <div
        className="pin-window"
        onMouseDown={startDrag}
        onDoubleClick={close}
        title={t('pin.title')}
      >
        {dataUrl ? (
          <img
            className="pin-window-img"
            src={dataUrl}
            alt={t('pin.alt')}
            draggable={false}
          />
        ) : (
          <div className="pin-window-msg">
            {error || t('pin.loading')}
          </div>
        )}
        <button
          className="pin-window-close"
          title={t('pin.closeTitle')}
          aria-label={t('pin.closeAria')}
          onMouseDown={(e) => { plog('关闭按钮 onMouseDown（阻止冒泡）'); e.stopPropagation(); }}
        onClick={(e) => {
          plog('关闭按钮 onClick');
          e.stopPropagation();
          close();
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
};

export default PinWindow;
