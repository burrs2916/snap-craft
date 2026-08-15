//! Tauri commands for the licensing / subscription flow.

use super::{LicenseStatus, LicensingService, SUBSCRIPTION_PRODUCT_ID};
use std::sync::Arc;
use tauri::{AppHandle, State};

/// Return the current license status (trial / free / pro).
#[tauri::command]
pub async fn check_license_status(
    service: State<'_, Arc<LicensingService>>,
) -> Result<LicenseStatus, String> {
    let status = service.status().await;
    clog!(
        "[licensing]",
        "check_license_status -> tier={} isPro={} isTrial={} isExpired={}",
        status.tier,
        status.is_pro,
        status.is_trial,
        status.is_expired
    );
    Ok(status)
}

/// Triggers the Microsoft Store subscription purchase flow (only available in the Windows Store build).
#[tauri::command]
pub async fn purchase_subscription(
    service: State<'_, Arc<LicensingService>>,
    app_handle: AppHandle,
) -> Result<LicenseStatus, String> {
    #[cfg(target_os = "windows")]
    {
        use crate::licensing::windows_store;
        let order_id = windows_store::request_purchase_subscription(&app_handle)
            .await
            .map_err(String::from)?;
        // Optimistically unlock on a confirmed purchase, then reconcile against
        // the Store entitlement so a lying/misleading purchase status can't
        // wrongly grant Pro (hazard 3). The refresh branch preserves the
        // purchase order_id; only a genuine "no entitlement" revokes.
        service.unlock_subscription(Some(order_id)).await?;
        service.sync_with_store(&app_handle).await;
        service.status().await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (service, app_handle);
        Err("In-app purchase is only available on the Windows Microsoft Store build.".to_string())
    }
}

/// Restore previous purchases from Microsoft Store.
#[tauri::command]
pub async fn restore_purchase(
    service: State<'_, Arc<LicensingService>>,
    app_handle: AppHandle,
) -> Result<LicenseStatus, String> {
    #[cfg(target_os = "windows")]
    {
        use crate::licensing::windows_store;
        let owned = windows_store::verify_subscription_entitlement(&app_handle)
            .await
            .map_err(String::from)?;
        if owned {
            let order_id = format!(
                "store-restore:{}:{}",
                SUBSCRIPTION_PRODUCT_ID,
                chrono::Utc::now().to_rfc3339()
            );
            service.unlock_subscription(Some(order_id)).await
        } else {
            Err("No active subscription found on this Microsoft account.".to_string())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (service, app_handle);
        Err("Restore Purchase is only available on the Windows Microsoft Store build.".to_string())
    }
}

/// Reset the license state. Only exposed in debug builds.
#[tauri::command]
pub async fn reset_license(
    service: State<'_, Arc<LicensingService>>,
) -> Result<LicenseStatus, String> {
    #[cfg(debug_assertions)]
    {
        service.reset().await
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = service;
        Err("reset_license is disabled in production builds.".to_string())
    }
}

/// Extend the trial by a number of days. Only exposed in debug builds.
#[tauri::command]
pub async fn extend_trial(
    days: i64,
    service: State<'_, Arc<LicensingService>>,
) -> Result<LicenseStatus, String> {
    #[cfg(debug_assertions)]
    {
        service.extend_trial(days).await
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (days, service);
        Err("extend_trial is disabled in production builds.".to_string())
    }
}

/// Return the configured Microsoft Store subscription add-on ID.
#[tauri::command]
pub fn get_subscription_product_id() -> String {
    SUBSCRIPTION_PRODUCT_ID.to_string()
}
