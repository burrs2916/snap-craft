import type { LicenseStatus, LicenseTier } from './licenseTypes';

/// Local-only preview override, stored in localStorage.
///
/// 用途：在 macOS / 纯浏览器（无 Windows Store 二进制）下也能预览各档门禁效果，
/// 无需真去 Partner Center 买订阅。设置方式（浏览器控制台）：
///   localStorage.setItem('snapcraft_license_preview', 'free')  // 预览锁定
///   localStorage.setItem('snapcraft_license_preview', 'trial') // 预览试用
///   localStorage.removeItem('snapcraft_license_preview')       // 恢复后端真实状态
///
/// 该覆盖仅影响前端展示，不改变 Rust 侧真实许可证状态；生产环境真实商店版
/// 由后端 entitlement 决定，不读取此值。
const KEY = 'snapcraft_license_preview';

export function getPreviewTier(): LicenseTier | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'pro' || v === 'trial' || v === 'free') return v;
  } catch {
    /* localStorage 不可用时忽略 */
  }
  return null;
}

export function setPreviewTier(tier: LicenseTier | null): void {
  try {
    if (tier) localStorage.setItem(KEY, tier);
    else localStorage.removeItem(KEY);
  } catch {
    /* 忽略写入失败 */
  }
}

/// 由单档生成一个合成状态（用于无后端 / 预览态直接驱动 UI）。
export function statusFromTier(tier: LicenseTier): LicenseStatus {
  if (tier === 'pro') {
    return {
      tier: 'pro',
      isPro: true,
      isTrial: false,
      isExpired: false,
      trialDaysRemaining: 0,
      trialStartedAt: null,
      trialExpiresAt: null,
      subscriptionExpiresAt: null,
      reason: 'Preview pro',
    };
  }
  if (tier === 'trial') {
    return {
      tier: 'trial',
      isPro: false,
      isTrial: true,
      isExpired: false,
      trialDaysRemaining: 13,
      trialStartedAt: new Date().toISOString(),
      trialExpiresAt: new Date(Date.now() + 13 * 86400_000).toISOString(),
      subscriptionExpiresAt: null,
      reason: 'Preview trial',
    };
  }
  return {
    tier: 'free',
    isPro: false,
    isTrial: false,
    isExpired: true,
    trialDaysRemaining: 0,
    trialStartedAt: null,
    trialExpiresAt: null,
    subscriptionExpiresAt: null,
    reason: 'Preview free',
  };
}

/// 把预览档叠加到真实状态之上（预览优先）。
export function applyPreview(status: LicenseStatus | null): LicenseStatus | null {
  const p = getPreviewTier();
  if (!p || !status) return status;
  if (p === 'pro') {
    return { ...status, tier: 'pro', isPro: true, isTrial: false, isExpired: false };
  }
  if (p === 'trial') {
    return {
      ...status,
      tier: 'trial',
      isPro: false,
      isTrial: true,
      isExpired: false,
      trialDaysRemaining: 13,
    };
  }
  return {
    ...status,
    tier: 'free',
    isPro: false,
    isTrial: false,
    isExpired: true,
    trialDaysRemaining: 0,
  };
}
