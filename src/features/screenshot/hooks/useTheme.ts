// ===== 主题管理 Hook =====
// 从 EnhancedScreenshotApp.tsx 提取的主题切换逻辑：
// light / dark / system 三态，system 跟随系统 prefers-color-scheme。
// 持久化到 localStorage，切换时自动更新 document.documentElement[data-theme]。

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'snapcraft-theme';

export interface UseThemeReturn {
  theme: Theme;
  /** 循环切换：light → dark → system → light */
  cycleTheme: () => void;
  /** 直接设置主题 */
  setTheme: (t: Theme) => void;
  /** 当前主题图标 */
  themeIcon: string;
  /** 当前主题的 i18n 标签键 */
  themeLabelKey: string;
}

export function useTheme(): UseThemeReturn {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(STORAGE_KEY) as Theme) || 'system',
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, theme);
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

  const cycleTheme = useCallback(() => {
    setThemeState((t) => (t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light'));
  }, []);

  const themeIcon = theme === 'light' ? '☀️' : theme === 'dark' ? '🌙' : '🖥️';
  const themeLabelKey =
    theme === 'light' ? 'theme.light' : theme === 'dark' ? 'theme.dark' : 'theme.system';

  return { theme, cycleTheme, setTheme: setThemeState, themeIcon, themeLabelKey };
}
