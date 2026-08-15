//! Microsoft Store In-App Purchase integration (subscription edition).
//!
//! Compiled for Windows only. Uses the `windows` crate (0.61)
//! `Windows.Services.Store` namespace bindings to implement subscription purchase and entitlement re-check.
//!
//! The only difference from biosphere (one-time purchase) is that this app sells a **Subscription**
//! type add-on, so `GetStoreProductsAsync`'s kind is passed as "Subscription",
//! but entitlement re-check and the purchase dialog are called exactly the same way.
//!
//! ## Prerequisites
//! 1. The app must be installed and run from the Microsoft Store as an MSIX package; sideload or dev mode
//!    yields `ERROR_NO_PACKAGE_IDENTITY (0x80073D54)`.
//! 2. AppxManifest must declare the `internetClient` capability (already declared in this project).
//! 3. The subscription add-on must first be submitted and certified in Partner Center (replace
//!    the `SUBSCRIPTION_PRODUCT_ID` placeholder).
//!
//! ## UI thread (why a dedicated thread is needed)
//! `StoreContext::GetDefault()` is **UI-thread bound** in WinRT and must be called on
//! a thread already initialized with `RoInitialize(RO_INIT_SINGLETHREADED)`, otherwise it throws
//! `0x80070578 (RPC_E_NO_UI_THREAD)`. A self-built dedicated UI thread (CoInitializeEx +
//! RoInitialize + message pump) solves this, same as biosphere-terminal-app.

use std::collections::HashSet;
use std::sync::{mpsc, OnceLock};
use std::thread;
use std::time::Duration;

use tauri::{async_runtime, AppHandle, Manager};

use windows::core::{Interface, HSTRING};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_SINGLETHREADED};
use windows::Win32::UI::Shell::IInitializeWithWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
};
use windows_collections::IIterable;

use super::SUBSCRIPTION_PRODUCT_ID;

/// IAP operation errors; the frontend receives them as strings.
#[derive(Debug)]
pub enum StoreIapError {
    /// The current process has no Package Identity (sideload / dev mode).
    NoPackageIdentity,
    /// The specified Store product was not found (wrong product ID or add-on not yet certified).
    ProductNotFound,
    /// The Store API call failed (user not signed in, config error, etc.).
    Api(String),
    /// The user cancelled the purchase in the Store dialog.
    UserCancelled,
    /// Network error.
    NetworkError(String),
    /// The purchase flow returned an unknown / abnormal status.
    UnexpectedStatus(String),
    /// Failed to dispatch the task to the UI thread.
    UiThreadDispatch(String),
}

impl std::fmt::Display for StoreIapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreIapError::NoPackageIdentity => write!(
                f,
                "App is not running as a Microsoft Store package. \
                Install from the Store before purchasing."
            ),
            StoreIapError::ProductNotFound => write!(
                f,
                "The subscription add-on was not found in the Microsoft Store. \
                It may still be in certification."
            ),
            StoreIapError::Api(msg) => write!(f, "Store API error: {}", msg),
            StoreIapError::UserCancelled => write!(f, "User cancelled the purchase"),
            StoreIapError::NetworkError(msg) => write!(f, "Network error: {}", msg),
            StoreIapError::UnexpectedStatus(s) => write!(f, "Unexpected purchase status: {}", s),
            StoreIapError::UiThreadDispatch(msg) => {
                write!(f, "Failed to dispatch Store call to UI thread: {}", msg)
            }
        }
    }
}

impl std::error::Error for StoreIapError {}

impl From<StoreIapError> for String {
    fn from(e: StoreIapError) -> Self {
        e.to_string()
    }
}

// ---------------------------------------------------------------------------
// Dedicated UI thread infrastructure
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
enum UiThreadInit {
    Ok,
    CoInitFailed(u32),
    RoInitFailed(u32),
}

type UiTask = Box<dyn FnOnce() + Send + 'static>;

fn ui_thread_tx() -> &'static mpsc::SyncSender<UiTask> {
    static TX: OnceLock<mpsc::SyncSender<UiTask>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel::<UiTask>(32);
        let (ready_tx, ready_rx) = mpsc::sync_channel::<()>(0);

        thread::Builder::new()
            .name("store-ui-thread".to_string())
            .spawn(move || ui_thread_main(rx, ready_tx))
            .expect("failed to spawn store UI thread");

        if ready_rx.recv_timeout(Duration::from_secs(5)).is_err() {
            clog!("licensing", "store-ui-thread did not signal ready within 5s");
        }
        tx
    })
}

/// Synchronously run `f` on the dedicated UI thread and bring back `Result<T, StoreIapError>`.
fn run_on_ui_thread<F, T>(
    app: &AppHandle,
    timeout: Option<Duration>,
    f: F,
) -> Result<T, StoreIapError>
where
    F: FnOnce(HWND) -> Result<T, StoreIapError> + Send + 'static,
    T: Send + 'static,
{
    let hwnd_isize: isize = match app.get_webview_window("main") {
        Some(win) => match win.hwnd() {
            Ok(h) => {
                let v = h.0 as isize;
                clog!("licensing", "main window HWND = 0x{:X}", v);
                v
            }
            Err(e) => {
                clog!("licensing", "failed to get HWND: {}", e);
                return Err(StoreIapError::UiThreadDispatch(format!("get HWND failed: {}", e)));
            }
        },
        None => {
            clog!("licensing", "main webview window not found");
            return Err(StoreIapError::UiThreadDispatch(
                "main webview window not found".to_string(),
            ));
        }
    };

    let (tx, rx) = mpsc::sync_channel::<Result<T, StoreIapError>>(1);
    let task: UiTask = Box::new(move || {
        let hwnd = HWND(hwnd_isize as *mut _);
        let result = f(hwnd);
        let _ = tx.send(result);
    });

    let dispatcher = ui_thread_tx();
    dispatcher
        .send(task)
        .map_err(|e| StoreIapError::UiThreadDispatch(format!("send: {}", e)))?;

    match timeout {
        None => rx
            .recv()
            .map_err(|e| StoreIapError::UiThreadDispatch(format!("recv: {}", e)))?,
        Some(dur) => match rx.recv_timeout(dur) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(StoreIapError::UiThreadDispatch(format!(
                "store-ui-thread did not return within {:?}",
                dur
            ))),
            Err(e) => Err(StoreIapError::UiThreadDispatch(format!("recv: {}", e))),
        },
    }
}

fn ui_thread_main(rx: mpsc::Receiver<UiTask>, ready_tx: mpsc::SyncSender<()>) {
    let com_hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let com_code = com_hr.0 as u32;
    let com_result = if com_hr.is_ok() {
        clog!("licensing", "store-ui-thread: CoInitializeEx(STA) ok (hr=0x{:08X})", com_code);
        UiThreadInit::Ok
    } else if com_code == 0x80010106 {
        clog!("licensing", "store-ui-thread: CoInitializeEx returned RPC_E_CHANGED_MODE; continuing");
        UiThreadInit::CoInitFailed(com_code)
    } else {
        clog!("licensing", "store-ui-thread: CoInitializeEx failed 0x{:08X}", com_code);
        UiThreadInit::CoInitFailed(com_code)
    };

    let ro_result = match unsafe { RoInitialize(RO_INIT_SINGLETHREADED) } {
        Ok(()) => {
            clog!("licensing", "store-ui-thread: RoInitialize(STA) ok");
            UiThreadInit::Ok
        }
        Err(e) => {
            let code = e.code().0 as u32;
            clog!(
                "licensing",
                "store-ui-thread: RoInitialize failed 0x{:08X}: {}",
                code,
                e.message()
            );
            UiThreadInit::RoInitFailed(code)
        }
    };

    let _ = ready_tx.send(());
    drop(ready_tx);

    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(task) => {
                pump_pending_messages();
                if matches!(com_result, UiThreadInit::Ok) && matches!(ro_result, UiThreadInit::Ok) {
                    task();
                } else {
                    clog!(
                        "licensing",
                        "store-ui-thread dropping task: init failed com={:?} ro={:?}",
                        com_result,
                        ro_result
                    );
                }
                pump_pending_messages();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                pump_pending_messages();
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                clog!("licensing", "store-ui-thread: dispatcher disconnected, exiting");
                break;
            }
        }
    }

    unsafe {
        RoUninitialize();
        if matches!(com_result, UiThreadInit::Ok) {
            CoUninitialize();
        }
    }
}

fn pump_pending_messages() {
    unsafe {
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            let _ = DispatchMessageW(&msg);
        }
    }
}

// ---------------------------------------------------------------------------
// Store API entry point
// ---------------------------------------------------------------------------

fn hstring_iterable(values: &[&str]) -> IIterable<HSTRING> {
    let vec: Vec<HSTRING> = values.iter().map(|v| HSTRING::from(*v)).collect();
    IIterable::<HSTRING>::from(vec)
}

/// Triggers the Microsoft Store subscription purchase dialog.
pub async fn request_purchase_subscription(app: &AppHandle) -> Result<String, StoreIapError> {
    let app_clone = app.clone();
    async_runtime::spawn_blocking(move || {
        run_on_ui_thread(&app_clone, None, |hwnd| -> Result<String, StoreIapError> {
            clog!("licensing", "purchase: StoreContext::GetDefault start");
            let ctx = windows::Services::Store::StoreContext::GetDefault().map_err(classify_error)?;
            clog!("licensing", "purchase: StoreContext::GetDefault ok");
            associate_with_window(&ctx, hwnd)?;

            // The subscription add-on's kind is "Subscription" ("Durable" is for one-time purchases).
            let kinds = hstring_iterable(&["Subscription"]);
            let ids = hstring_iterable(&[SUBSCRIPTION_PRODUCT_ID]);
            let query_op = ctx.GetStoreProductsAsync(&kinds, &ids).map_err(classify_error)?;
            let query_result = query_op.get().map_err(classify_error)?;

            let products = query_result.Products().map_err(classify_error)?;
            let product = products
                .Lookup(&HSTRING::from(SUBSCRIPTION_PRODUCT_ID))
                .map_err(|_| StoreIapError::ProductNotFound)?;

            let purchase_op = product.RequestPurchaseAsync().map_err(classify_error)?;
            let result = purchase_op.get().map_err(classify_error)?;
            let status = result.Status().map_err(classify_error)?;

            match status {
                windows::Services::Store::StorePurchaseStatus::Succeeded
                | windows::Services::Store::StorePurchaseStatus::AlreadyPurchased => Ok(format!(
                    "store:{}:{}",
                    SUBSCRIPTION_PRODUCT_ID,
                    chrono::Utc::now().to_rfc3339()
                )),
                windows::Services::Store::StorePurchaseStatus::NotPurchased => {
                    Err(StoreIapError::UserCancelled)
                }
                windows::Services::Store::StorePurchaseStatus::NetworkError => Err(
                    StoreIapError::NetworkError("Could not reach the Microsoft Store".to_string()),
                ),
                windows::Services::Store::StorePurchaseStatus::ServerError => Err(StoreIapError::Api(
                    "Microsoft Store server error".to_string(),
                )),
                other => Err(StoreIapError::UnexpectedStatus(format!("{:?}", other))),
            }
        })
    })
    .await
    .map_err(|e| StoreIapError::Api(format!("blocking task panicked: {}", e)))?
}

/// Queries the add-on entitlements owned by the current user (used for Restore / launch sync).
pub async fn get_user_owned_addons(app: &AppHandle) -> Result<HashSet<String>, StoreIapError> {
    let app_clone = app.clone();
    async_runtime::spawn_blocking(move || {
        run_on_ui_thread(&app_clone, Some(Duration::from_secs(60)), |hwnd| -> Result<HashSet<String>, StoreIapError> {
            clog!("licensing", "entitlement: StoreContext::GetDefault start");
            let ctx = windows::Services::Store::StoreContext::GetDefault().map_err(classify_error)?;
            clog!("licensing", "entitlement: StoreContext::GetDefault ok");
            associate_with_window(&ctx, hwnd)?;

            let app_license_op = ctx.GetAppLicenseAsync().map_err(classify_error)?;
            let app_license = app_license_op.get().map_err(classify_error)?;

            let mut owned = HashSet::new();
            let addon_licenses = app_license.AddOnLicenses().map_err(classify_error)?;
            let iter = addon_licenses.First().map_err(classify_error)?;
            loop {
                if !iter.HasCurrent().map_err(classify_error)? {
                    break;
                }
                let kvp = iter.Current().map_err(classify_error)?;
                let key = kvp.Key().map_err(classify_error)?.to_string();
                let license = kvp.Value().map_err(classify_error)?;
                if license.IsActive().map_err(classify_error)? {
                    if !key.is_empty() {
                        owned.insert(key);
                    }
                    if let Ok(token) = license.InAppOfferToken() {
                        let token_str = token.to_string();
                        if !token_str.is_empty() {
                            owned.insert(token_str);
                        }
                    }
                    if let Ok(sku) = license.SkuStoreId() {
                        let sku_str = sku.to_string();
                        if !sku_str.is_empty() {
                            owned.insert(sku_str);
                        }
                    }
                }
                iter.MoveNext().map_err(classify_error)?;
            }
            Ok(owned)
        })
    })
    .await
    .map_err(|e| StoreIapError::Api(format!("blocking task panicked: {}", e)))?
}

/// Verify whether the current user owns the subscription entitlement.
/// Only the exact subscription add-on (`SUBSCRIPTION_PRODUCT_ID`) unlocks Pro.
/// The previous loose check treated ANY active add-on as a subscription, which
/// would wrongly grant Pro once other paid add-ons are introduced; this is now
/// tightened to require a match against the subscription Product ID.
/// `get_user_owned_addons` inserts the Store ID / offer token / SKU id into the
/// set, so the exact match here resolves to the subscription add-on.
pub async fn verify_subscription_entitlement(app: &AppHandle) -> Result<bool, StoreIapError> {
    let owned = get_user_owned_addons(app).await?;
    if owned.is_empty() {
        return Ok(false);
    }
    if owned.contains(SUBSCRIPTION_PRODUCT_ID) {
        return Ok(true);
    }
    clog!(
        "licensing",
        "no active subscription matching {}; active add-on keys present: {:?}",
        SUBSCRIPTION_PRODUCT_ID,
        owned
    );
    Ok(false)
}

fn associate_with_window(
    ctx: &windows::Services::Store::StoreContext,
    hwnd: HWND,
) -> Result<(), StoreIapError> {
    clog!(
        "licensing",
        "IInitializeWithWindow::Initialize(hwnd=0x{:X}) start",
        hwnd.0 as isize
    );
    let init: IInitializeWithWindow = ctx.cast().map_err(|e| {
        clog!("licensing", "StoreContext.cast::<IInitializeWithWindow> failed: {}", e);
        classify_error(e)
    })?;
    unsafe { init.Initialize(hwnd) }.map_err(|e| {
        clog!(
            "licensing",
            "IInitializeWithWindow::Initialize failed 0x{:08X}: {}",
            e.code().0 as u32,
            e.message()
        );
        classify_error(e)
    })?;
    clog!("licensing", "IInitializeWithWindow::Initialize ok");
    Ok(())
}

fn classify_error(err: windows::core::Error) -> StoreIapError {
    let code = err.code().0 as u32;
    if code == 0x80073D54 {
        return StoreIapError::NoPackageIdentity;
    }
    if code == 0x80070578 {
        clog!(
            "licensing",
            "Got 0x80070578 (RPC_E_NO_UI_THREAD) — store-ui-thread \
            was supposed to be initialized as a WinRT UI thread but Store API \
            still says otherwise. Check CoInitializeEx / RoInitialize logs above."
        );
    }
    StoreIapError::Api(format!("HRESULT 0x{:08X}: {}", code, err.message()))
}
