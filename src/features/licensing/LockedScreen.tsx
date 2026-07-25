import type { ProFeature } from './licenseTypes';
import { useUpgradeDialogStore } from './upgradeDialogStore';
import { t } from '../../i18n';

interface LockedScreenProps {
  feature: ProFeature;
  /// Optional custom message shown below the feature name.
  message?: string;
}

/// Full-area placeholder shown when a Pro feature is locked. Renders a lock
/// icon, the feature name, and an "Upgrade to Pro" button that opens the
/// upgrade dialog.
export function LockedScreen({ feature, message }: LockedScreenProps) {
  const openDialog = useUpgradeDialogStore((s) => s.openDialog);

  return (
    <div className="license-locked">
      <div className="license-locked-icon" aria-hidden="true">
        🔒
      </div>
      <div className="license-locked-title">{t('license.locked.title')}</div>
      <div className="license-locked-desc">{message ?? t(`license.locked.desc.${feature}`)}</div>
      <button className="license-upgrade-btn" onClick={() => openDialog(feature)}>
        {t('license.locked.upgrade')}
      </button>
    </div>
  );
}
