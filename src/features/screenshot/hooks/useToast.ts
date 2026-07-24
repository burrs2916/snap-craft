// ===== Toast 通知 Hook =====
// 从 EnhancedScreenshotApp.tsx 提取的轻量通知系统：
// 成功/错误/信息三态 + 自动淡出 + 「在文件管理器中显示」按钮。
// 零外部依赖，可在任何组件中复用。

import { useCallback, useRef, useState } from 'react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastState {
  message: string | null;
  type: ToastType;
  /** 保存/导出成功后保留最近一次路径，toast 渲染"在访达中显示"按钮 */
  revealPath: string | null;
}

export interface UseToastReturn {
  toast: string | null;
  toastType: ToastType;
  revealPath: string | null;
  /** 弹出通知；keepMs 可覆盖默认停留时长 */
  flash: (msg: string, type?: ToastType, keepMs?: number) => void;
  /** 手动关闭当前通知 */
  dismiss: () => void;
  /** 外部设置「在文件管理器中显示」路径（与 useFileOperations 联动） */
  setRevealPath: (path: string | null) => void;
}

/**
 * 轻量 Toast 通知 Hook。
 *
 * 默认停留时长：error 5s（便于阅读原因）、info 2.6s、success 1.8s。
 * 传 keepMs 可覆盖（如保存成功 5s 给「在 Finder 中显示」按钮留出点击窗口）。
 */
export function useToast(): UseToastReturn {
  const [toast, setToast] = useState<string | null>(null);
  const [toastType, setToastType] = useState<ToastType>('success');
  const [revealPath, setRevealPath] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback(
    (msg: string, type: ToastType = 'success', keepMs?: number) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setToast(msg);
      setToastType(type);
      const ms = keepMs ?? (type === 'error' ? 5000 : type === 'info' ? 2600 : 1800);
      timerRef.current = setTimeout(() => {
        setToast(null);
        setRevealPath(null);
      }, ms);
    },
    [],
  );

  const dismiss = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast(null);
    setRevealPath(null);
  }, []);

  return { toast, toastType, revealPath, flash, dismiss, setRevealPath };
}
