// ===== 屏幕录制权限管理 Hook =====
// macOS 屏幕录制权限：启动预检 → 自动请求弹窗 → 延迟复检 → fallback 手动引导。

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface ScreenPermissionDeps {
  platform: string;
  flash: (msg: string, type?: 'success' | 'error' | 'info') => void;
  t: (key: string, vars?: Record<string, any>) => string;
}

export function useScreenPermission(deps: ScreenPermissionDeps) {
  const { platform, flash, t } = deps;

  const [permissionNeeded, setPermissionNeeded] = useState(false);
  const [permissionChecking, setPermissionChecking] = useState(true);
  const permissionRetryRef = useRef(0);

  // 启动预检
  useEffect(() => {
    if (platform !== 'macos') {
      setPermissionChecking(false);
      return;
    }
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const check = async (isFromFocus = false) => {
      if (isFromFocus) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => check(false), 300);
        return;
      }
      try {
        const ok = await invoke<boolean>('check_screen_capture_access');
        if (ok) {
          setPermissionNeeded(false);
          setPermissionChecking(false);
          permissionRetryRef.current = 0;
          return;
        }
        if (permissionRetryRef.current < 2) {
          permissionRetryRef.current += 1;
          await invoke<boolean>('request_screen_capture_access');
          setTimeout(() => check(false), 2000);
          return;
        }
        setPermissionChecking(false);
        setPermissionNeeded(true);
      } catch {
        setPermissionChecking(false);
        setPermissionNeeded(true);
      }
    };

    const initialTimer = setTimeout(() => check(false), 1500);
    const onFocus = () => check(true);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (debounceTimer) clearTimeout(debounceTimer);
      clearTimeout(initialTimer);
    };
  }, [platform]);

  const openScreenRecordingSettings = useCallback(() => {
    invoke('open_screen_recording_settings').catch(() => {});
  }, []);

  const recheckPermission = useCallback(async () => {
    setPermissionChecking(true);
    try {
      const ok = await invoke<boolean>('check_screen_capture_access');
      setPermissionNeeded(!ok);
      if (ok) {
        permissionRetryRef.current = 0;
        flash(t('toast.granted'), 'success');
      } else {
        flash(t('toast.notGranted'), 'error');
      }
    } catch {
      setPermissionNeeded(true);
    } finally {
      setPermissionChecking(false);
    }
  }, [flash, t]);

  // 截图前权限预检：窗口可见时触发系统授权弹窗
  const ensureCapturePermission = useCallback(async (): Promise<boolean> => {
    if (platform !== 'macos') return true;
    const ok = await invoke<boolean>('check_screen_capture_access');
    if (ok) return true;
    await invoke<boolean>('request_screen_capture_access');
    setPermissionNeeded(true);
    return false;
  }, [platform]);

  return {
    permissionNeeded, setPermissionNeeded,
    permissionChecking,
    openScreenRecordingSettings,
    recheckPermission,
    ensureCapturePermission,
  };
}
