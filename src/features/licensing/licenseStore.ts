import { create } from 'zustand';
import type { LicenseStatus, LicenseTier, ProFeature } from './licenseTypes';
import {
  checkLicenseStatus,
  purchaseSubscription,
  restorePurchase,
  resetLicense,
} from './licensingService';
import { applyPreview, getPreviewTier, setPreviewTier, statusFromTier } from './licensePreview';

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
        console.warn('[license] refresh failed (fail-open → Pro):', message);
        // Fail-open：invoke 失败时回退到 Pro，避免锁死全部功能。
        // 后端是本进程内的 Rust 命令，不可达说明二进制未重编译或命令未注册，
        // 此时锁死用户体验极差；macOS/Linux 后端本就无条件返回 Pro。
        const fallback: LicenseStatus = {
          tier: 'pro',
          isPro: true,
          isTrial: false,
          isExpired: false,
          trialDaysRemaining: 0,
          trialStartedAt: null,
          trialExpiresAt: null,
          subscriptionExpiresAt: null,
          reason: 'Backend unreachable — fail-open Pro',
        };
        set({ status: applyPreview(fallback), loading: false });
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
    // Fail-open：status 为 null（后端尚未响应或不可达）时放行，
    // 避免异步时序或 invoke 失败导致用户被锁。
    if (!status) return true;
    if (status.isPro) return true;
    if (status.isTrial) return true;
    return false;
  },
}));
