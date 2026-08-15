import { useMemo, useState, useEffect } from 'react';
import { createTheme, type Theme } from '@mui/material/styles';

/** 同步 app 的 data-theme(dark/light) 变化，供 MUI 主题切换。 */
export function useIsDark(): boolean {
  const get = () =>
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-theme') === 'dark';
  const [dark, setDark] = useState(get);
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(get()));
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

// MUI 不支持 CSS 变量字符串做 alpha/lighten 颜色运算，故调色板全部用具体色值。
// 以下值与 src/index.css 的主题变量保持一致（暗/亮两套）。
const DARK = {
  paper: '#1e1e1e',
  textPrimary: '#f5f5f7',
  textSecondary: '#86868b',
  divider: 'rgba(255, 255, 255, 0.1)',
} as const;

const LIGHT = {
  paper: '#ffffff',
  textPrimary: '#1d1d1f',
  textSecondary: '#6e6e73',
  divider: 'rgba(0, 0, 0, 0.12)',
} as const;

export function useAiTheme(): Theme {
  const isDark = useIsDark();
  return useMemo(() => {
    const c = isDark ? DARK : LIGHT;
    return createTheme({
      palette: {
        mode: isDark ? 'dark' : 'light',
        primary: { main: '#007aff', dark: '#0056cc', contrastText: '#ffffff' },
        secondary: { main: '#5856d6', contrastText: '#ffffff' },
        error: { main: '#ff3b30', contrastText: '#ffffff' },
        background: { paper: c.paper, default: 'transparent' },
        text: { primary: c.textPrimary, secondary: c.textSecondary },
        divider: c.divider,
      },
      shape: { borderRadius: 8 },
      typography: {
        fontFamily: 'inherit',
        fontSize: 12.5,
      },
      components: {
        MuiButton: {
          defaultProps: { disableElevation: true },
          styleOverrides: {
            root: { textTransform: 'none', borderRadius: 8, fontWeight: 500 },
          },
        },
        MuiChip: {
          styleOverrides: { root: { borderRadius: 8, fontWeight: 500 } },
        },
        MuiOutlinedInput: {
          styleOverrides: { root: { borderRadius: 8 } },
        },
      },
    });
  }, [isDark]);
}
