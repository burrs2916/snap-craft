// ===== 文件操作 Hook =====
// 从 EnhancedScreenshotApp.tsx 提取的保存/复制/钉图操作。
// 职责：只管「把截图数据输出到外部」（文件/剪贴板/钉图浮窗），
// 不涉及截图捕获、编辑、AI 等功能。

import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

export interface UseFileOperationsDeps {
  flash: (msg: string, type?: 'success' | 'error' | 'info', keepMs?: number) => void;
  t: (key: string, vars?: Record<string, any>) => string;
  /** 设置「在文件管理器中显示」路径（与 toast 联动） */
  setRevealPath?: (path: string | null) => void;
}

export interface UseFileOperationsReturn {
  /** 复制 dataUrl 到系统剪贴板 */
  copyDataUrl: (dataUrl: string) => Promise<void>;
  /** 保存 dataUrl 到用户选择的路径 */
  saveDataUrl: (dataUrl: string) => Promise<void>;
  /** 钉图：把截图钉在屏幕上（无边框置顶浮窗） */
  pinShot: (shot: { id: string; dataUrl: string; width: number; height: number }) => Promise<void>;
}

export function useFileOperations(deps: UseFileOperationsDeps): UseFileOperationsReturn {
  const { flash, t, setRevealPath } = deps;

  const copyDataUrl = useCallback(
    async (dataUrl: string) => {
      try {
        invoke('diag_log', { msg: `[clip] 前端 copyDataUrl: dataUrl长度=${dataUrl?.length ?? 0}` }).catch(() => {});
        if (!dataUrl || !dataUrl.startsWith('data:image')) {
          flash(t('toast.copyInvalid'), 'error');
          return;
        }
        await invoke('copy_to_clipboard', { imageData: dataUrl });
        flash(t('toast.copied'), 'success');
      } catch (e) {
        invoke('diag_log', { msg: `[clip] 前端 copyDataUrl 失败: ${String(e)}` }).catch(() => {});
        flash(t('toast.copyFailed', { msg: String(e) }), 'error');
      }
    },
    [flash, t],
  );

  const saveDataUrl = useCallback(
    async (dataUrl: string) => {
      const path = await save({
        defaultPath: `snapcraft-${Date.now()}.png`,
        filters: [{ name: 'PNG Image', extensions: ['png'] }],
      });
      if (!path) return;
      try {
        await invoke('save_screenshot', { imageData: dataUrl, filePath: path });
        setRevealPath?.(path);
        flash(t('toast.savedWithReveal', { path }), 'success', 5000);
      } catch (e) {
        flash(t('toast.saveFailed', { msg: String(e) }), 'error');
      }
    },
    [flash, t, setRevealPath],
  );

  const pinShot = useCallback(
    async (shot: { id: string; dataUrl: string; width: number; height: number }) => {
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
    },
    [flash, t],
  );

  return { copyDataUrl, saveDataUrl, pinShot };
}
