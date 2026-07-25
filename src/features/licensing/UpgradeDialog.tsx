import { useCallback, useMemo, useState } from 'react';
import { useLicenseStore, PRO_FEATURES } from './licenseStore';
import { useUpgradeDialogStore } from './upgradeDialogStore';
import { t } from '../../i18n';
import type { ProFeature } from './licenseTypes';

/// Microsoft Store listing URL for AI-SnapScribe (used for the
/// "Buy on Microsoft Store" fallback when in-app IAP is unavailable).
const STORE_LISTING_URL = 'https://apps.microsoft.com/detail/9NW4XBK1G0B5';

export function UpgradeDialog() {
  const open = useUpgradeDialogStore((s) => s.open);
  const triggerFeature = useUpgradeDialogStore((s) => s.triggerFeature);
  const closeDialog = useUpgradeDialogStore((s) => s.closeDialog);
  const status = useLicenseStore((s) => s.status);
  const purchase = useLicenseStore((s) => s.purchase);
  const restore = useLicenseStore((s) => s.restore);
  const loading = useLicenseStore((s) => s.loading);
  const error = useLicenseStore((s) => s.error);
  const clearError = useLicenseStore((s) => s.clearError);

  const [purchasing, setPurchasing] = useState(false);

  const handleClose = useCallback(() => {
    clearError();
    closeDialog();
  }, [clearError, closeDialog]);

  const handlePurchase = useCallback(async () => {
    setPurchasing(true);
    try {
      await purchase();
      handleClose();
    } catch {
      /* error is recorded in the store and shown below */
    } finally {
      setPurchasing(false);
    }
  }, [purchase, handleClose]);

  const handleRestore = useCallback(async () => {
    setPurchasing(true);
    try {
      await restore();
      handleClose();
    } catch {
      /* swallowed */
    } finally {
      setPurchasing(false);
    }
  }, [restore, handleClose]);

  const isStoreUnavailableError = useMemo(() => {
    if (!error) return false;
    const lower = error.toLowerCase();
    return (
      lower.includes('not running as a microsoft store package') ||
      lower.includes('no_package_identity') ||
      lower.includes('0x80073d54') ||
      lower.includes('only available on the windows microsoft store build')
    );
  }, [error]);

  const trialDaysLeft = status?.trialDaysRemaining ?? 0;
  const isTrial = status?.isTrial ?? false;
  const isExpired = status?.isExpired ?? false;

  const headline = useMemo(() => {
    if (isTrial && trialDaysLeft > 0) {
      return t('license.upgrade.headlineTrial', { trialDaysLeft });
    }
    if (isExpired) {
      return t('license.upgrade.headlineExpired');
    }
    return t('license.upgrade.headlineDefault');
  }, [isTrial, trialDaysLeft, isExpired]);

  const subheadline = useMemo(() => {
    if (triggerFeature) {
      return t('license.upgrade.subheadlineFeature', {
        feature: t(`license.feature.${triggerFeature}`),
      });
    }
    return t('license.upgrade.subheadlineDefault');
  }, [triggerFeature]);

  if (!open) return null;

  return (
    <div className="license-dialog-overlay" onClick={handleClose}>
      <div
        className="license-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('license.upgrade.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="license-dialog-header">
          <div className="license-dialog-title">
            <span className="license-dialog-spark" aria-hidden="true">
              ✨
            </span>
            {t('license.upgrade.title')}
          </div>
          <button className="license-dialog-close" onClick={handleClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="license-dialog-body">
          <div className="license-dialog-headline">{headline}</div>
          <div className="license-dialog-sub">{subheadline}</div>

          <div className="license-dialog-divider" />

          <div className="license-dialog-features-label">
            {t('license.upgrade.featuresLabel')}
          </div>
          <div className="license-dialog-features">
            {PRO_FEATURES.map((feature: ProFeature) => (
              <div className="license-feature-row" key={feature}>
                <span className="license-feature-check" aria-hidden="true">
                  ✓
                </span>
                <span className="license-feature-name">{t(`license.feature.${feature}`)}</span>
                {triggerFeature === feature && (
                  <span className="license-feature-required">
                    {t('license.upgrade.requiredChip')}
                  </span>
                )}
              </div>
            ))}
          </div>

          {error && !isStoreUnavailableError && (
            <div className="license-dialog-error">{error}</div>
          )}
          {isStoreUnavailableError && (
            <div className="license-dialog-hint">
              {t('license.upgrade.sideloadHint')}
            </div>
          )}

          <div className="license-dialog-actions">
            {!isStoreUnavailableError && (
              <button
                className="license-upgrade-btn license-upgrade-btn-lg"
                disabled={loading || purchasing}
                onClick={handlePurchase}
              >
                {purchasing
                  ? t('license.upgrade.processing')
                  : t('license.upgrade.cta')}
              </button>
            )}
            {isStoreUnavailableError && (
              <a
                className="license-upgrade-btn license-upgrade-btn-lg"
                href={STORE_LISTING_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('license.upgrade.buyOnStore')}
              </a>
            )}
            <button
              className="license-dialog-text-btn"
              disabled={loading || purchasing}
              onClick={handleRestore}
            >
              {t('license.upgrade.restore')}
            </button>
            {!isStoreUnavailableError && (
              <a
                className="license-dialog-text-btn"
                href={STORE_LISTING_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('license.upgrade.viewOnStore')}
              </a>
            )}
          </div>

          <div className="license-dialog-disclaimer">{t('license.upgrade.disclaimer')}</div>
        </div>
      </div>
    </div>
  );
}
