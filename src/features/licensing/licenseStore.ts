import { create } from 'zustand';
import type { LicenseStatus, LicenseTier, ProFeature } from './licenseTypes';
import {
  checkLicenseStatus,
  purchaseSubscription,
  restorePurchase,
  resetLicense,
} from './licensingService';
import { applyPreview, getPreviewTier, setPreviewTier, statusFromTier } from './licensePreview';
import { isWindows } from '../../shared/platform';

/// All Pro features gated by the license system. Keep in sync with
/// `ProFeature` in `licenseTypes.ts`.
export const PRO_FEATURES: ProFeature[] = ['ai', 'export_doc', 'redact'];

interface LicenseState {
  status: LicenseStatus | null;
  loading: boolean;
  error: string | null;
  previewTier: LicenseTier | null;
  /// Fetch the latest status from the backend.
  refresh: () => Promise<void>;
  /// Trigger the purchase flow. On Windows this calls the Store IAP API;
  /// on other platforms it falls back to a manual unlock for testing.
  purchase: () => Promise<void>;
  /// Restore previous purchases.
  restore: () => Promise<void>;
  /// Reset the license state (development/testing only).
  reset: () => Promise<void>;
  /// Clear the last error.
  clearError: () => void;
  /// Set a local preview tier (dev/testing aid; see licensePreview.ts).
  setPreview: (tier: LicenseTier | null) => void;
  /// Convenience selector: is the user allowed to use a Pro feature?
  canUse: (feature: ProFeature) => boolean;
}

/// Module-level in-flight marker for refresh() to avoid race conditions.
let refreshInFlight: Promise<void> | null = null;
/// Record whether we've attempted at least one load. canUse is optimistic
/// before the first load completes, then conservative if the backend is down.
let refreshAttempted = false;
/// purchase in progress flag — prevents a focus-triggered refresh from
/// overwriting the freshly written Pro status.
let purchaseInProgress = false;

const initialPreview = getPreviewTier();

export const useLicenseStore = create<LicenseState>((set, get) => ({
  status: initialPreview ? statusFromTier(initialPreview) : null,
  loading: false,
  error: null,
  previewTier: initialPreview,

  refresh: async () => {
    if (purchaseInProgress) return;
    if (refreshInFlight) return refreshInFlight;
    const run = async () => {
      set({ loading: true });
      try {
        const status = await checkLicenseStatus();
        set({ status: applyPreview(status), loading: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[license] refresh failed:', message);
        if (isWindows()) {
          // Windows 是付费平台：invoke 失败时不能 fail-open，否则试用到期后
          // 任何后端异常都会让用户白嫖 Pro。保留上一次已知状态；若从未成功
          // 拉取过（首次启动即失败），回退到 free/expired 锁定功能。
          const prev = get().status;
          if (!prev) {
            const locked: LicenseStatus = {
              tier: 'free',
              isPro: false,
              isTrial: false,
              isExpired: true,
              trialDaysRemaining: 0,
              trialStartedAt: null,
              trialExpiresAt: null,
              subscriptionExpiresAt: null,
              reason: 'Backend unreachable — Windows fail-closed',
            };
            set({ status: applyPreview(locked), loading: false });
          } else {
            set({ loading: false });
          }
        } else {
          // macOS/Linux：后端本就无条件返回 Pro，invoke 失败说明二进制未重编
          // 或命令未注册，锁死用户体验极差 → fail-open 放行。
          const fallback: LicenseStatus = {
            tier: 'pro',
            isPro: true,
            isTrial: false,
            isExpired: false,
            trialDaysRemaining: 0,
            trialStartedAt: null,
            trialExpiresAt: null,
            subscriptionExpiresAt: null,
            reason: 'Backend unreachable — fail-open Pro (non-Windows)',
          };
          set({ status: applyPreview(fallback), loading: false });
        }
      } finally {
        refreshAttempted = true;
      }
    };
    refreshInFlight = run().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  },

  purchase: async () => {
    purchaseInProgress = true;
    set({ loading: true, error: null });
    try {
      const status = await purchaseSubscription();
      set({ status: applyPreview(status), loading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
      throw err;
    } finally {
      purchaseInProgress = false;
    }
  },

  restore: async () => {
    set({ loading: true, error: null });
    try {
      const status = await restorePurchase();
      set({ status: applyPreview(status), loading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
      throw err;
    }
  },

  reset: async () => {
    set({ loading: true, error: null });
    try {
      const status = await resetLicense();
      set({ status: applyPreview(status), loading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
      throw err;
    }
  },

  clearError: () => set({ error: null }),

  setPreview: (tier) => {
    setPreviewTier(tier);
    const current = get().status;
    if (tier) {
      // 优先用合成状态（即使后端还没返回也立即生效），
      // 否则把预览叠加到已有真实状态上。
      set({ previewTier: tier, status: current ? applyPreview(current) : statusFromTier(tier) });
    } else {
      set({ previewTier: null });
      // 取消预览：重新拉一次真实状态
      get().refresh();
    }
  },

  canUse: (feature: ProFeature) => {
    void feature;
    const status = get().status;
    if (!status) {
      // 首次 refresh 尚未完成前乐观放行（避免 UI 闪烁）；
      // Windows 上若 refresh 已尝试过但 status 仍为 null（极端异常），锁定。
      if (isWindows() && refreshAttempted) return false;
      return true;
    }
    if (status.isPro) return true;
    if (status.isTrial) return true;
    return false;
  },
}));
