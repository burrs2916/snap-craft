import { useCallback } from 'react';
import type { ProFeature } from './licenseTypes';
import { useLicenseStore } from './licenseStore';
import { useUpgradeDialogStore } from './upgradeDialogStore';

/// Hook for gating Pro features. Returns the current license status and
/// helpers to check access and trigger the upgrade dialog.
///
/// Usage:
/// ```tsx
/// const { canUse, requireUpgrade } = useFeatureGate('ai');
/// if (!canUse) { requireUpgrade(); return; }
/// ```
export function useFeatureGate(feature: ProFeature) {
  const status = useLicenseStore((s) => s.status);
  const canUseFn = useLicenseStore((s) => s.canUse);
  const openDialog = useUpgradeDialogStore((s) => s.openDialog);

  const canUse = canUseFn(feature);

  const requireUpgrade = useCallback(() => {
    openDialog(feature);
  }, [feature, openDialog]);

  return {
    feature,
    canUse,
    status,
    isPro: status?.isPro ?? false,
    isTrial: status?.isTrial ?? false,
    isExpired: status?.isExpired ?? false,
    trialDaysRemaining: status?.trialDaysRemaining ?? 0,
    requireUpgrade,
  };
}
