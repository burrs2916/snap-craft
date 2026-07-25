import { invoke } from '@tauri-apps/api/core';
import type { LicenseStatus } from './licenseTypes';

/// Fetch the current license status from the backend.
export function checkLicenseStatus(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('check_license_status');
}

/// Trigger the Microsoft Store subscription purchase flow (Windows Store build only).
export function purchaseSubscription(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('purchase_subscription');
}

/// Restore a previous subscription from the Microsoft Store.
export function restorePurchase(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('restore_purchase');
}

/// Reset the license state (debug builds only; production returns an error string).
export function resetLicense(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('reset_license');
}

/// Extend the trial by a number of days (debug builds only).
export function extendTrial(days: number): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('extend_trial', { days });
}

/// Return the configured Microsoft Store subscription add-on ID.
export function getSubscriptionProductId(): Promise<string> {
  return invoke<string>('get_subscription_product_id');
}
