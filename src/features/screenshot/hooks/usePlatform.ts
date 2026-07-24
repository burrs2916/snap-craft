// ===== 平台检测 Hook =====
// 从 EnhancedScreenshotApp.tsx 提取的平台检测与沙箱判断逻辑。
// 统一写入本地 state 与全局 store，确保子组件（AnnotationToolbar 等）
// 读到的 store.platform 不为空串。

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { detectPlatform } from '../../../shared/platform';
import { useScreenshotStore } from '../store/screenshotStore';

export interface UsePlatformReturn {
  platform: string;
  isSandboxed: boolean;
  /** Windows 或 Linux（非 macOS） */
  isWinLike: boolean;
  /** 快捷键修饰符标签：macOS 用 ⌘，其余用 Ctrl */
  modLabel: string;
  /** Shift 键标签：Windows/Linux 用 "Shift"，macOS 用 ⇧ */
  shiftLabel: string;
}

export function usePlatform(): UsePlatformReturn {
  const [platform, setPlatform] = useState('');
  const [isSandboxed, setIsSandboxed] = useState(false);
  const setStorePlatform = useScreenshotStore((s) => s.setPlatform);

  useEffect(() => {
    invoke('get_platform')
      .then((p) => {
        setPlatform(p as string);
        setStorePlatform(p as string);
        if (p === 'macos') {
          invoke<boolean>('is_sandboxed').then(setIsSandboxed).catch(() => setIsSandboxed(false));
        }
      })
      .catch(() => {
        // IPC 失败时用 UA 兜底（不可回落到 'macos'，否则 Windows/Linux 走错分支）
        const fallback = detectPlatform();
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
  const shiftLabel = isWinLike ? 'Shift' : '⇧';

  return { platform, isSandboxed, isWinLike, modLabel, shiftLabel };
}
