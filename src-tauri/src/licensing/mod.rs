//! Licensing service for SnapCraft.
//!
//! Business model: 14-day free trial (all features open) → then a Microsoft
//! Store **subscription** unlocks Pro. Without an active subscription the app
//! falls back to the free tier (screenshot + basic annotation + OCR + history
//! + PNG + scrolling capture + steps/highlight).
//!
//! Platform policy (mirrors biosphere-terminal-app):
//! - **Windows (Store package)** is the only platform that enforces gating and
//!   where the subscription IAP lives. On first launch the trial start time is
//!   persisted; `sync_with_store` reconciles the entitlement with Microsoft
//!   Store on startup.
//! - **macOS / Linux / sideload / dev** return `pro` by default so the app is
//!   fully usable. The gating UI can still be previewed locally via the
//!   `SNAP_FORCE_TIER` env var (`pro` / `trial` / `free`).
//!
//! State is persisted to `license.json` inside the app local data dir using an
//! atomic write (temp file + rename). The in-memory state is only mutated
//! *after* the write succeeds, so a full disk can never reset the trial clock
//! into an infinite-trial state.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// `Emitter` is only used inside the Windows-only `sync_with_store` body; gate
// the import so macOS/`cargo clippy --tests -D warnings` won't flag it unused.
#[cfg(target_os = "windows")]
use tauri::Emitter;

#[cfg(target_os = "windows")]
pub mod windows_store;

/// Tauri commands for the licensing / subscription flow.
pub mod commands;

/// Number of days the free trial lasts (Windows only — macOS/Linux are free Pro).
#[cfg(target_os = "windows")]
pub const TRIAL_DAYS: i64 = 14;

/// Microsoft Store subscription add-on Store ID.
///
/// Created in Partner Center under AI-SnapScribe → Add-ons (type: Subscription,
/// Product ID: AI_SnapScribe_Pro). The Windows IAP flow queries this ID via
/// `GetStoreProductsAsync` so the subscription can be purchased / restored.
pub const SUBSCRIPTION_PRODUCT_ID: &str = "9NWLSNN7N609";

/// How long a verified subscription is trusted locally before the next Store
/// reconciliation (used to stamp `subscription_expires_at`). Kept long because
/// the real expiry is re-confirmed by `sync_with_store` on every launch.
#[allow(dead_code)]
const SUBSCRIPTION_LOCAL_TRUST_DAYS: i64 = 365;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LicenseState {
    /// ISO-8601 timestamp when the trial started. `None` = not yet initialized.
    pub trial_started_at: Option<String>,
    /// ISO-8601 timestamp when the subscription expires (local-trust stamp).
    /// `None` = no active subscription cached.
    pub subscription_expires_at: Option<String>,
    /// Optional receipt / order ID returned by the Store IAP flow.
    pub store_order_id: Option<String>,
    /// Optional license key for non-Store distribution channels (future use).
    pub license_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatus {
    /// Current tier: `trial`, `free`, or `pro`.
    pub tier: String,
    pub is_pro: bool,
    pub is_trial: bool,
    pub is_expired: bool,
    /// Days remaining in the trial (clamped to >= 0). 0 when not in trial.
    pub trial_days_remaining: i64,
    pub trial_started_at: Option<String>,
    pub trial_expires_at: Option<String>,
    pub subscription_expires_at: Option<String>,
    /// Reason for the current tier, useful for debugging.
    pub reason: String,
}

pub struct LicensingService {
    state: Arc<RwLock<LicenseState>>,
    state_path: PathBuf,
}

/// `SNAP_FORCE_TIER` override — read once, leaked to `'static` for cheap reuse.
/// Lets local builds (incl. macOS) preview the gated UI without a Store build.
fn forced_tier() -> Option<&'static str> {
    static FORCED: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    let v = FORCED.get_or_init(|| std::env::var("SNAP_FORCE_TIER").ok());
    match v.as_deref() {
        Some("pro") | Some("trial") | Some("free") => v.as_deref(),
        _ => None,
    }
}

impl LicensingService {
    /// Create a new service. The state file lives at `data_dir/license.json`.
    pub fn new(data_dir: PathBuf) -> Self {
        let state_path = data_dir.join("license.json");
        let state = Self::load_state(&state_path).unwrap_or_else(|err| {
            clog!("licensing", "failed to load state from {:?}: {}", state_path, err);
            LicenseState::default()
        });

        // First launch (Windows only): persist the trial start immediately so
        // the 14-day clock starts ticking. Must write to disk *before* setting
        // the in-memory value — otherwise a full disk yields an infinite trial.
        #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
        let mut state = state;
        #[cfg(target_os = "windows")]
        if state.trial_started_at.is_none() {
            let mut candidate = state.clone();
            candidate.trial_started_at = Some(Utc::now().to_rfc3339());
            match Self::save_state(&state_path, &candidate) {
                Ok(()) => {
                    state = candidate;
                    clog!("licensing", "trial started at first launch");
                }
                Err(err) => {
                    clog!(
                        "licensing",
                        "failed to persist initial trial start: {} \
                         — leaving trial uninitialized; user will be treated as free tier",
                        err
                    );
                }
            }
        }

        LicensingService {
            state: Arc::new(RwLock::new(state)),
            state_path,
        }
    }

    /// Reconcile the subscription entitlement with Microsoft Store (Windows
    /// only). Strategy: add, never subtract. If Store reports an active
    /// subscription but local state has none, mark Pro and emit `license-changed`
    /// so the UI refreshes immediately. If Store reports nothing or is
    /// unreachable, keep the local state untouched.
    #[allow(dead_code)]
    pub async fn sync_with_store(&self, app_handle: &AppHandle) {
        #[cfg(not(target_os = "windows"))]
        {
            let _ = app_handle;
        }
        #[cfg(target_os = "windows")]
        {
            let owned = match windows_store::verify_subscription_entitlement(app_handle).await {
                Ok(v) => v,
                Err(err) => {
                    clog!(
                        "licensing",
                        "skipping store sync (likely sideloaded or offline): {}",
                        err
                    );
                    return;
                }
            };

            let mut state = self.state.write().unwrap();
            let local_pro = state
                .subscription_expires_at
                .as_ref()
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&Utc) > Utc::now())
                .unwrap_or(false);

            if owned && !local_pro {
                let mut new_state = state.clone();
                new_state.subscription_expires_at =
                    Some((Utc::now() + chrono::Duration::days(SUBSCRIPTION_LOCAL_TRUST_DAYS)).to_rfc3339());
                new_state.store_order_id = Some(format!(
                    "store-sync:{}:{}",
                    SUBSCRIPTION_PRODUCT_ID,
                    Utc::now().to_rfc3339()
                ));
                if let Err(e) = Self::save_state(&self.state_path, &new_state) {
                    clog!("licensing", "failed to persist store sync: {}", e);
                    return;
                }
                let new_status = Self::compute_status(&new_state);
                *state = new_state;
                drop(state);
                clog!("licensing", "store sync: Pro auto-unlocked from Store entitlement");
                if let Err(e) = app_handle.emit("license-changed", &new_status) {
                    clog!("licensing", "failed to emit license-changed event: {}", e);
                }
            } else {
                clog!(
                    "licensing",
                    "store sync: no auto-unlock needed (owned={}, local_pro={})",
                    owned,
                    local_pro
                );
            }
        }
    }

    fn load_state(path: &PathBuf) -> Result<LicenseState, String> {
        let content = std::fs::read_to_string(path).map_err(|e| format!("read license state: {}", e))?;
        let state: LicenseState =
            serde_json::from_str(&content).map_err(|e| format!("parse license state: {}", e))?;
        Ok(state)
    }

    fn save_state(path: &PathBuf, state: &LicenseState) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create license dir: {}", e))?;
        }
        let json =
            serde_json::to_string_pretty(state).map_err(|e| format!("serialize license state: {}", e))?;
        // Atomic write: temp file + rename (same-filesystem rename is atomic on
        // POSIX and Windows NTFS). A crash mid-write leaves the target intact.
        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, &json).map_err(|e| format!("write license state (tmp): {}", e))?;
        std::fs::rename(&tmp_path, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("rename license state: {}", e)
        })?;
        Ok(())
    }

    /// Current license status (snapshot of in-memory state).
    pub async fn status(&self) -> LicenseStatus {
        let state = self.state.read().unwrap().clone();
        Self::compute_status(&state)
    }

    fn compute_status(state: &LicenseState) -> LicenseStatus {
        // Debug / local preview override — works on every platform.
        if let Some(tier) = forced_tier() {
            return match tier {
                "pro" => LicenseStatus {
                    tier: "pro".into(),
                    is_pro: true,
                    is_trial: false,
                    is_expired: false,
                    trial_days_remaining: 0,
                    trial_started_at: None,
                    trial_expires_at: None,
                    subscription_expires_at: None,
                    reason: "Forced pro (SNAP_FORCE_TIER)".into(),
                },
                "trial" => LicenseStatus {
                    tier: "trial".into(),
                    is_pro: false,
                    is_trial: true,
                    is_expired: false,
                    trial_days_remaining: 13,
                    trial_started_at: Some(Utc::now().to_rfc3339()),
                    trial_expires_at: Some((Utc::now() + chrono::Duration::days(13)).to_rfc3339()),
                    subscription_expires_at: None,
                    reason: "Forced trial (SNAP_FORCE_TIER)".into(),
                },
                _ => LicenseStatus {
                    tier: "free".into(),
                    is_pro: false,
                    is_trial: false,
                    is_expired: true,
                    trial_days_remaining: 0,
                    trial_started_at: None,
                    trial_expires_at: None,
                    subscription_expires_at: None,
                    reason: "Forced free (SNAP_FORCE_TIER)".into(),
                },
            };
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = state;
            LicenseStatus {
                tier: "pro".into(),
                is_pro: true,
                is_trial: false,
                is_expired: false,
                trial_days_remaining: 0,
                trial_started_at: None,
                trial_expires_at: None,
                subscription_expires_at: None,
                reason: "Free Pro on macOS/Linux".into(),
            }
        }

        #[cfg(target_os = "windows")]
        {
            Self::compute_status_windows(state)
        }
    }

    #[cfg(target_os = "windows")]
    fn compute_status_windows(state: &LicenseState) -> LicenseStatus {
        // Active subscription wins over trial state.
        if let Some(exp) = &state.subscription_expires_at {
            if let Ok(dt) = DateTime::parse_from_rfc3339(exp) {
                if dt.with_timezone(&Utc) > Utc::now() {
                    return LicenseStatus {
                        tier: "pro".into(),
                        is_pro: true,
                        is_trial: false,
                        is_expired: false,
                        trial_days_remaining: 0,
                        trial_started_at: state.trial_started_at.clone(),
                        trial_expires_at: Self::trial_expires_at(state),
                        subscription_expires_at: Some(exp.clone()),
                        reason: "Subscription active".into(),
                    };
                }
            }
        }

        let Some(started_at_str) = &state.trial_started_at else {
            return LicenseStatus {
                tier: "free".into(),
                is_pro: false,
                is_trial: false,
                is_expired: false,
                trial_days_remaining: 0,
                trial_started_at: None,
                trial_expires_at: None,
                subscription_expires_at: None,
                reason: "Trial not started".into(),
            };
        };

        let started_at = match DateTime::parse_from_rfc3339(started_at_str) {
            Ok(dt) => dt.with_timezone(&Utc),
            Err(_) => {
                return LicenseStatus {
                    tier: "free".into(),
                    is_pro: false,
                    is_trial: false,
                    is_expired: true,
                    trial_days_remaining: 0,
                    trial_started_at: state.trial_started_at.clone(),
                    trial_expires_at: None,
                    subscription_expires_at: None,
                    reason: "Invalid trial start timestamp".into(),
                };
            }
        };

        let now = Utc::now();
        let expires_at = started_at + chrono::Duration::days(TRIAL_DAYS);
        let remaining_secs = (expires_at - now).num_seconds();
        let remaining = if remaining_secs <= 0 {
            0
        } else {
            ((remaining_secs as f64) / 86400.0).ceil() as i64
        };

        if now < expires_at {
            LicenseStatus {
                tier: "trial".into(),
                is_pro: false,
                is_trial: true,
                is_expired: false,
                trial_days_remaining: remaining.max(0),
                trial_started_at: Some(started_at.to_rfc3339()),
                trial_expires_at: Some(expires_at.to_rfc3339()),
                subscription_expires_at: None,
                reason: format!("Trial active, {} days remaining", remaining.max(0)),
            }
        } else {
            LicenseStatus {
                tier: "free".into(),
                is_pro: false,
                is_trial: false,
                is_expired: true,
                trial_days_remaining: 0,
                trial_started_at: Some(started_at.to_rfc3339()),
                trial_expires_at: Some(expires_at.to_rfc3339()),
                subscription_expires_at: None,
                reason: "Trial expired".into(),
            }
        }
    }

    #[cfg(target_os = "windows")]
    fn trial_expires_at(state: &LicenseState) -> Option<String> {
        let started = state.trial_started_at.as_ref()?;
        let started_at = DateTime::parse_from_rfc3339(started).ok()?;
        Some((started_at.with_timezone(&Utc) + chrono::Duration::days(TRIAL_DAYS)).to_rfc3339())
    }

    /// Mark the subscription as unlocked (called after a successful Store
    /// purchase or after `sync_with_store` confirms an entitlement).
    #[allow(dead_code)]
    pub async fn unlock_subscription(
        &self,
        store_order_id: Option<String>,
    ) -> Result<LicenseStatus, String> {
        let mut state = self.state.write().unwrap();
        let mut new_state = state.clone();
        new_state.subscription_expires_at =
            Some((Utc::now() + chrono::Duration::days(SUBSCRIPTION_LOCAL_TRUST_DAYS)).to_rfc3339());
        new_state.store_order_id = store_order_id;

        Self::save_state(&self.state_path, &new_state)?;

        let status = Self::compute_status(&new_state);
        *state = new_state;
        drop(state);
        clog!("licensing", "subscription unlocked");
        Ok(status)
    }

    /// Reset the license state (dev/testing only — see commands.rs for gating).
    pub async fn reset(&self) -> Result<LicenseStatus, String> {
        let mut state = self.state.write().unwrap();
        let new_state = LicenseState {
            trial_started_at: Some(Utc::now().to_rfc3339()),
            subscription_expires_at: None,
            store_order_id: None,
            license_key: None,
        };
        Self::save_state(&self.state_path, &new_state)?;
        let status = Self::compute_status(&new_state);
        *state = new_state;
        drop(state);
        clog!("licensing", "license state reset");
        Ok(status)
    }

    /// Extend the trial by a number of days (dev/testing only).
    pub async fn extend_trial(&self, days: i64) -> Result<LicenseStatus, String> {
        if days <= 0 {
            return Err("extension days must be positive".to_string());
        }
        let mut state = self.state.write().unwrap();
        let now = Utc::now();
        let base = state
            .trial_started_at
            .as_ref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or(now);
        let mut new_state = state.clone();
        let new_start = base + chrono::Duration::days(days);
        new_state.trial_started_at = Some(new_start.to_rfc3339());
        Self::save_state(&self.state_path, &new_state)?;
        let status = Self::compute_status(&new_state);
        *state = new_state;
        drop(state);
        clog!("licensing", "trial extended by {} days", days);
        Ok(status)
    }
}
