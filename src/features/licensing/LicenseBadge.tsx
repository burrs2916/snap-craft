import { useLicenseStore } from './licenseStore';
import { useUpgradeDialogStore } from './upgradeDialogStore';
import { t } from '../../i18n';

/// Small persistent badge showing the current license tier. Clicking it opens
/// the upgrade dialog. Positioned via CSS (`.license-badge` is fixed).
export function LicenseBadge() {
  const status = useLicenseStore((s) => s.status);
  const openDialog = useUpgradeDialogStore((s) => s.openDialog);
  if (!status) return null;

  if (status.isPro) {
    return (
      <button className="license-badge license-badge-pro" onClick={() => openDialog()}>
        {t('license.proBadge')}
      </button>
    );
  }
  if (status.isTrial) {
    return (
      <button
        className="license-badge license-badge-trial"
        onClick={() => openDialog()}
        title={t('license.upgrade.headlineTrial', { trialDaysLeft: status.trialDaysRemaining })}
      >
        {t('license.trialBadge')} · {status.trialDaysRemaining}d
      </button>
    );
  }
  return (
    <button className="license-badge license-badge-free" onClick={() => openDialog()}>
      {t('license.freeBadge')}
    </button>
  );
}
