import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { useLicenseStore } from './licenseStore';
import { isTauri } from '../../shared/platform';

interface LicenseContextValue {
  /// Force-refresh the license status from the backend.
  refresh: () => Promise<void>;
}

const LicenseContext = createContext<LicenseContextValue | null>(null);

/// Top-level provider that bootstraps the license status on app startup and
/// re-fetches it whenever the main window regains focus, so purchases made in
/// the Microsoft Store popup are reflected immediately when the user returns.
export function LicenseProvider({ children }: { children: ReactNode }) {
  const refreshRef = useRef(useLicenseStore.getState().refresh);
  refreshRef.current = useLicenseStore.getState().refresh;

  useEffect(() => {
    refreshRef.current().catch(() => {
      /* swallowed: store already recorded the error */
    });

    if (!isTauri()) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    // Refresh when the window regains focus (Store purchase popup returns).
    (async () => {
      try {
        const win = getCurrentWindow();
        const handler = await win.onFocusChanged(({ payload: focused }) => {
          if (focused) {
            refreshRef.current().catch(() => {
              /* swallowed */
            });
          }
        });
        if (cancelled) handler();
        else unlisten = handler;
      } catch {
        /* non-Tauri environment */
      }
    })();

    // Listen for backend `license-changed` events (auto-unlock from Store).
    (async () => {
      try {
        const handler = await listen('license-changed', () => {
          refreshRef.current().catch(() => {
            /* swallowed */
          });
        });
        if (cancelled) handler();
        else unlisten = handler;
      } catch {
        /* non-Tauri environment */
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const value = useMemo<LicenseContextValue>(() => ({
    refresh: () => refreshRef.current(),
  }), []);

  return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>;
}

export function useLicenseContext(): LicenseContextValue {
  const ctx = useContext(LicenseContext);
  if (!ctx) {
    throw new Error('useLicenseContext must be used within a LicenseProvider');
  }
  return ctx;
}
