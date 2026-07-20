//! Async Vision API — Future-based wrappers for `VNImageRequestHandler` and friends.
//!
//! Enable with `features = ["async"]`. Each wrapper dispatches the synchronous
//! Vision request on a background queue (via `DispatchQueue.global`) and returns
//! a `std::future::Future` that resolves when the request completes.
//!
//! ## Tier-2 note
//!
//! Multi-fire delegates, KVO, and continuous observation streams (e.g.
//! `VNVideoProcessor` frame-by-frame callbacks, optical-flow streaming) are
//! **not** included here — they follow a Stream pattern and belong in a
//! future Tier-2 module.
//!
//! ## Example
//!
//! ```rust,no_run
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! use apple_vision::async_api::AsyncRecognizeText;
//! use apple_vision::recognize_text::RecognitionLevel;
//!
//! let texts = AsyncRecognizeText::new(RecognitionLevel::Accurate, true)
//!     .recognize_in_path("/path/to/image.png")
//!     .await?;
//! for text in &texts {
//!     println!("{}", text.text);
//! }
//! # Ok(())
//! # }
//! ```

use std::{
    ffi::{c_void, CString},
    future::Future,
    panic::AssertUnwindSafe,
    path::{Path, PathBuf},
    pin::Pin,
    task::{Context, Poll},
};

use doom_fish_utils::completion::{error_from_cstr, AsyncCompletion, AsyncCompletionFuture};
use doom_fish_utils::panic_safe::log_callback_panic;

use crate::{error::VisionError, ffi};

#[cfg(feature = "coreml")]
use crate::classify::Classification;
#[cfg(feature = "coreml")]
use crate::coreml::{CoreMLFeatureValueObservation, CoreMLRequest};
#[cfg(feature = "detect_barcodes")]
use crate::detect_barcodes::DetectedBarcode;
#[cfg(feature = "detect_faces")]
use crate::detect_faces::DetectedFace;
use crate::human_body_pose_3d::HumanBodyPose3DObservation;
#[cfg(feature = "recognize_text")]
use crate::recognize_text::{RecognitionLevel, RecognizedText};
#[cfg(feature = "segmentation")]
use crate::segmentation::{SegmentationMask, SegmentationQuality};
use crate::trajectories::Trajectory;

enum FutureState<T> {
    Ready(Option<Result<T, VisionError>>),
    Pending(AsyncCompletionFuture<T>),
}

impl<T> FutureState<T> {
    const fn ready_err(error: VisionError) -> Self {
        Self::Ready(Some(Err(error)))
    }

    const fn pending(future: AsyncCompletionFuture<T>) -> Self {
        Self::Pending(future)
    }
}

impl<T: Unpin> Future for FutureState<T> {
    type Output = Result<T, VisionError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match self.as_mut().get_mut() {
            Self::Ready(result) => Poll::Ready(
                result
                    .take()
                    .expect("async Vision future polled after completion"),
            ),
            Self::Pending(future) => Pin::new(future)
                .poll(cx)
                .map(|result| result.map_err(VisionError::RequestFailed)),
        }
    }
}

fn path_to_cstring(path: impl AsRef<Path>) -> Result<CString, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    CString::new(path_str)
        .map_err(|error| VisionError::InvalidArgument(format!("path NUL byte: {error}")))
}

struct WorkerFuture<T> {
    inner: AsyncCompletionFuture<Result<T, VisionError>>,
}

impl<T> std::fmt::Debug for WorkerFuture<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerFuture").finish_non_exhaustive()
    }
}

impl<T> Future for WorkerFuture<T> {
    type Output = Result<T, VisionError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.inner).poll(cx).map(|result| {
            result.unwrap_or_else(|message| {
                Err(VisionError::Unknown {
                    code: ffi::status::UNKNOWN,
                    message,
                })
            })
        })
    }
}

fn run_sync_on_worker<T, F>(work: F) -> WorkerFuture<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, VisionError> + Send + 'static,
{
    let (future, ctx) = AsyncCompletion::<Result<T, VisionError>>::create();
    let ctx = ctx as usize;
    std::thread::spawn(move || unsafe {
        AsyncCompletion::complete_ok(ctx as *mut c_void, work());
    });
    WorkerFuture { inner: future }
}

#[cfg(feature = "coreml")]
pub struct CoreMLClassifyFuture {
    inner: WorkerFuture<Vec<Classification>>,
}

#[cfg(feature = "coreml")]
impl std::fmt::Debug for CoreMLClassifyFuture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreMLClassifyFuture")
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "coreml")]
impl Future for CoreMLClassifyFuture {
    type Output = Result<Vec<Classification>, VisionError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.inner).poll(cx)
    }
}

#[cfg(feature = "coreml")]
pub struct CoreMLFeatureValueFuture {
    inner: WorkerFuture<Option<CoreMLFeatureValueObservation>>,
}

#[cfg(feature = "coreml")]
impl std::fmt::Debug for CoreMLFeatureValueFuture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreMLFeatureValueFuture")
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "coreml")]
impl Future for CoreMLFeatureValueFuture {
    type Output = Result<Option<CoreMLFeatureValueObservation>, VisionError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.inner).poll(cx)
    }
}

#[cfg(feature = "coreml")]
#[derive(Debug, Clone)]
pub struct AsyncCoreMLRequest {
    request: CoreMLRequest,
}

#[cfg(feature = "coreml")]
impl AsyncCoreMLRequest {
    #[must_use]
    pub const fn new(request: CoreMLRequest) -> Self {
        Self { request }
    }

    #[must_use]
    pub fn classify_in_path(&self, path: impl AsRef<Path>) -> CoreMLClassifyFuture {
        let request = self.request.clone();
        let path = path.as_ref().to_path_buf();
        CoreMLClassifyFuture {
            inner: run_sync_on_worker(move || request.classify(path.as_path())),
        }
    }

    #[must_use]
    pub fn feature_value_in_path(&self, path: impl AsRef<Path>) -> CoreMLFeatureValueFuture {
        let request = self.request.clone();
        let path = path.as_ref().to_path_buf();
        CoreMLFeatureValueFuture {
            inner: run_sync_on_worker(move || request.feature_value(path.as_path())),
        }
    }
}

pub struct DetectHumanBodyPose3DFuture {
    inner: WorkerFuture<Vec<HumanBodyPose3DObservation>>,
}

impl std::fmt::Debug for DetectHumanBodyPose3DFuture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DetectHumanBodyPose3DFuture")
            .finish_non_exhaustive()
    }
}

impl Future for DetectHumanBodyPose3DFuture {
    type Output = Result<Vec<HumanBodyPose3DObservation>, VisionError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.inner).poll(cx)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AsyncDetectHumanBodyPose3D;

impl AsyncDetectHumanBodyPose3D {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    #[must_use]
    pub fn detect_in_path(&self, path: impl AsRef<Path>) -> DetectHumanBodyPose3DFuture {
        let path = path.as_ref().to_path_buf();
        DetectHumanBodyPose3DFuture {
            inner: run_sync_on_worker(move || {
                crate::human_body_pose_3d::detect_human_body_pose_3d_observations(path.as_path())
            }),
        }
    }
}

pub struct DetectTrajectoriesFuture {
    inner: WorkerFuture<Vec<Trajectory>>,
}

impl std::fmt::Debug for DetectTrajectoriesFuture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DetectTrajectoriesFuture")
            .finish_non_exhaustive()
    }
}

impl Future for DetectTrajectoriesFuture {
    type Output = Result<Vec<Trajectory>, VisionError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.inner).poll(cx)
    }
}

#[derive(Debug, Clone)]
pub struct AsyncDetectTrajectories {
    trajectory_length: usize,
}

impl AsyncDetectTrajectories {
    #[must_use]
    pub const fn new(trajectory_length: usize) -> Self {
        Self { trajectory_length }
    }

    #[must_use]
    pub fn detect_in_path(&self, path: impl AsRef<Path>) -> DetectTrajectoriesFuture {
        let path: PathBuf = path.as_ref().to_path_buf();
        let trajectory_length = self.trajectory_length;
        DetectTrajectoriesFuture {
            inner: run_sync_on_worker(move || {
                crate::trajectories::detect_trajectories(path.as_path(), trajectory_length)
            }),
        }
    }
}

// ============================================================================
// Text Recognition Future
// ============================================================================

/// Parse the raw text-recognition result coming from the Swift bridge.
///
/// Returns `Ok(results)` on success or `Err(message)` on any Swift-reported error.
/// Frees the Swift-owned `result` allocation before returning.
///
/// # Safety
///
/// `result` must be either null or a valid pointer to an `AsyncArrayResultRaw` struct
/// produced by the Swift bridge whose `array` field, when non-null, points to
/// `count` valid `RecognizedTextRaw` elements.  `error` must be either null or a
/// valid null-terminated C string owned by the bridge.
#[cfg(feature = "recognize_text")]
unsafe fn parse_text_result(
    result: *const c_void,
    error: *const i8,
) -> Result<Vec<RecognizedText>, String> {
    if !error.is_null() {
        // SAFETY: caller guarantees `error` is a valid C string when non-null.
        return Err(unsafe { error_from_cstr(error) });
    }
    if result.is_null() {
        return Err("text recognition returned null".into());
    }

    // SAFETY: caller guarantees `result` is a valid `AsyncArrayResultRaw` pointer.
    let raw = unsafe { &*(result.cast::<ffi::AsyncArrayResultRaw>()) };
    let texts = if raw.array.is_null() || raw.count == 0 {
        Vec::new()
    } else {
        let typed = raw.array.cast::<ffi::RecognizedTextRaw>();
        let mut out = Vec::with_capacity(raw.count);
        for index in 0..raw.count {
            // SAFETY: `typed` is valid for `raw.count` elements; `index` is in bounds.
            let entry = unsafe { &*typed.add(index) };
            let text = if entry.text.is_null() {
                String::new()
            } else {
                // SAFETY: `entry.text` is a valid C string when non-null.
                unsafe { std::ffi::CStr::from_ptr(entry.text) }
                    .to_string_lossy()
                    .into_owned()
            };
            out.push(RecognizedText {
                text,
                confidence: entry.confidence,
                bounding_box: crate::recognize_text::BoundingBox {
                    x: entry.bbox_x,
                    y: entry.bbox_y,
                    width: entry.bbox_w,
                    height: entry.bbox_h,
                },
            });
        }
        // SAFETY: `raw.array` and `raw.count` are the pair produced by the Swift bridge;
        // this is the unique call site that frees them.
        unsafe { ffi::vn_recognized_text_free(raw.array, raw.count) };
        out
    };

    // SAFETY: `result` is the non-null allocation produced by the Swift async bridge;
    // freeing here is safe because this is the unique call site for this allocation.
    unsafe { ffi::vn_async_array_result_free(result.cast_mut()) };
    Ok(texts)
}

/// `extern "C"` callback invoked by the Swift bridge when text recognition completes.
///
/// # Safety contract
///
/// Called from a Swift `DispatchQueue`; all pointer arguments follow the
/// Swift-bridge protocol documented on [`parse_text_result`].  The body is
/// wrapped in `catch_unwind` so that an unexpected Rust panic does not unwind
/// through the Swift/C ABI (which is undefined behaviour).  On panic the
/// future is completed with an error rather than left permanently pending.
#[cfg(feature = "recognize_text")]
extern "C" fn text_result_cb(result: *const c_void, error: *const i8, ctx: *mut c_void) {
    // SAFETY: `result` and `error` are valid for the duration of this call per
    // the Swift bridge contract. `AssertUnwindSafe` is correct here because the
    // raw pointers are not accessed after unwinding.
    let outcome =
        std::panic::catch_unwind(AssertUnwindSafe(|| unsafe { parse_text_result(result, error) }));
    match outcome {
        Ok(Ok(texts)) => {
            // SAFETY: `ctx` is the `Arc<AsyncCompletionInner<_>>` context from
            // `AsyncCompletion::create()`; it is valid and unconsumed at this point.
            unsafe { AsyncCompletion::complete_ok(ctx, texts) };
        }
        Ok(Err(msg)) => {
            // SAFETY: same as above.
            unsafe { AsyncCompletion::<Vec<RecognizedText>>::complete_err(ctx, msg) };
        }
        Err(payload) => {
            log_callback_panic("text_result_cb", payload.as_ref());
            // SAFETY: same as above.
            unsafe {
                AsyncCompletion::<Vec<RecognizedText>>::complete_err(
                    ctx,
                    "panic in Vision text_result_cb".into(),
                );
            };
        }
    }
}

/// Future resolving to a `Vec<RecognizedText>`.
#[cfg(feature = "recognize_text")]
pub struct RecognizeTextFuture {
    inner: FutureState<Vec<RecognizedText>>,
}

#[cfg(feature = "recognize_text")]
impl std::fmt::Debug for RecognizeTextFuture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecognizeTextFuture")
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "recognize_text")]
impl Future for RecognizeTextFuture {
    type Output = Result<Vec<RecognizedText>, VisionError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.inner).poll(cx)
    }
}

/// Async wrapper for `VNRecognizeTextRequest`.
///
/// Runs text recognition on a background `DispatchQueue` and returns a
/// [`RecognizeTextFuture`] that resolves when the request completes.
#[cfg(feature = "recognize_text")]
#[derive(Debug, Clone)]
pub struct AsyncRecognizeText {
    recognition_level: RecognitionLevel,
    uses_language_correction: bool,
}

#[cfg(feature = "recognize_text")]
impl Default for AsyncRecognizeText {
    fn default() -> Self {
        Self::new(RecognitionLevel::Accurate, true)
    }
}

#[cfg(feature = "recognize_text")]
impl AsyncRecognizeText {
    #[must_use]
    pub const fn new(recognition_level: RecognitionLevel, uses_language_correction: bool) -> Self {
        Self {
            recognition_level,
            uses_language_correction,
        }
    }

    /// Recognize text in the image at `path` asynchronously.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError::RequestFailed`] if Vision fails, or
    /// [`VisionError::InvalidArgument`] if the path cannot be encoded.
    pub fn recognize_in_path(&self, path: impl AsRef<Path>) -> RecognizeTextFuture {
        match path_to_cstring(path) {
            Err(error) => RecognizeTextFuture {
                inner: FutureState::ready_err(error),
            },
            Ok(path_c) => {
                let (future, ctx) = AsyncCompletion::create();
                // SAFETY: `path_c` is a valid null-terminated C string for the duration of
                // this call. `text_result_cb` satisfies the callback contract: single-fire,
                // completes the context exactly once. `ctx` is the `Arc` context from
                // `AsyncCompletion::create()` cast to `*mut c_void`.
                unsafe {
                    ffi::vn_recognize_text_in_path_async(
                        path_c.as_ptr(),
                        self.recognition_level.as_raw(),
                        self.uses_language_correction,
                        text_result_cb,
                        ctx,
                    );
                };
                RecognizeTextFuture {
                    inner: FutureState::pending(future),
                }
            }
        }
    }
}

// ============================================================================
// Face Detection Future
// ============================================================================

/// Parse the raw face-detection result from the Swift bridge.
///
/// # Safety
///
/// `result` must be either null or a valid `AsyncArrayResultRaw` pointer whose
/// `array` field, when non-null, points to `count` valid `DetectedFaceRaw`
/// elements.  `error` must be either null or a valid null-terminated C string.
#[cfg(feature = "detect_faces")]
unsafe fn parse_face_result(
    result: *const c_void,
    error: *const i8,
) -> Result<Vec<DetectedFace>, String> {
    if !error.is_null() {
        // SAFETY: caller guarantees `error` is a valid C string when non-null.
        return Err(unsafe { error_from_cstr(error) });
    }
    if result.is_null() {
        return Err("face detection returned null".into());
    }

    // SAFETY: caller guarantees `result` is a valid `AsyncArrayResultRaw` pointer.
    let raw = unsafe { &*(result.cast::<ffi::AsyncArrayResultRaw>()) };
    let faces = if raw.array.is_null() || raw.count == 0 {
        Vec::new()
    } else {
        let typed = raw.array.cast::<ffi::DetectedFaceRaw>();
        let mut out = Vec::with_capacity(raw.count);
        let nan_to_none = |value: f32| if value.is_nan() { None } else { Some(value) };
        for index in 0..raw.count {
            // SAFETY: `typed` is valid for `raw.count` elements; `index` is in bounds.
            let entry = unsafe { &*typed.add(index) };
            out.push(DetectedFace {
                bounding_box: crate::recognize_text::BoundingBox {
                    x: entry.bbox_x,
                    y: entry.bbox_y,
                    width: entry.bbox_w,
                    height: entry.bbox_h,
                },
                confidence: entry.confidence,
                roll: nan_to_none(entry.roll),
                yaw: nan_to_none(entry.yaw),
                pitch: nan_to_none(entry.pitch),
            });
        }
        // SAFETY: `raw.array` and `raw.count` are the pair produced by the Swift bridge;
        // this is the unique call site that frees them.
        unsafe { ffi::vn_detected_faces_free(raw.array, raw.count) };
        out
    };

    // SAFETY: `result` is the non-null allocation produced by the Swift async bridge.
    unsafe { ffi::vn_async_array_result_free(result.cast_mut()) };
    Ok(faces)
}

/// `extern "C"` callback invoked by the Swift bridge when face detection completes.
///
/// Wrapped in `catch_unwind`; on panic the future is resolved with an error.
#[cfg(feature = "detect_faces")]
extern "C" fn face_result_cb(result: *const c_void, error: *const i8, ctx: *mut c_void) {
    // SAFETY: `result` and `error` are valid for the duration of this call per the bridge
    // contract. `AssertUnwindSafe` is correct: raw pointers are not accessed after unwinding.
    let outcome =
        std::panic::catch_unwind(AssertUnwindSafe(|| unsafe { parse_face_result(result, error) }));
    match outcome {
        Ok(Ok(faces)) => {
            // SAFETY: `ctx` is the `Arc<AsyncCompletionInner<_>>` context from `AsyncCompletion::create()`.
            unsafe { AsyncCompletion::complete_ok(ctx, faces) };
        }
        Ok(Err(msg)) => {
            // SAFETY: same as above.
            unsafe { AsyncCompletion::<Vec<DetectedFace>>::complete_err(ctx, msg) };
        }
        Err(payload) => {
            log_callback_panic("face_result_cb", payload.as_ref());
            // SAFETY: same as above.
            unsafe {
                AsyncCompletion::<Vec<DetectedFace>>::complete_err(
                    ctx,
                    "panic in Vision face_result_cb".into(),
                );
            };
        }
    }
}

/// Future resolving to a `Vec<DetectedFace>`.
#[cfg(feature = "detect_faces")]
pub struct DetectFacesFuture {
    inner: FutureState<Vec<DetectedFace>>,
}

#[cfg(feature = "detect_faces")]
impl std::fmt::Debug for DetectFacesFuture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DetectFacesFuture").finish_non_exhaustive()
    }
}

#[cfg(feature = "detect_faces")]
impl Future for DetectFacesFuture {
    type Output = Result<Vec<DetectedFace>, VisionError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.inner).poll(cx)
    }
}

/// Async wrapper for `VNDetectFaceRectanglesRequest`.
#[cfg(feature = "detect_faces")]
#[derive(Debug, Clone, Copy, Default)]
pub struct AsyncDetectFaces;

#[cfg(feature = "detect_faces")]
impl AsyncDetectFaces {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Detect faces in the image at `path` asynchronously.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError::RequestFailed`] if Vision fails.
    pub fn detect_in_path(&self, path: impl AsRef<Path>) -> DetectFacesFuture {
        match path_to_cstring(path) {
            Err(error) => DetectFacesFuture {
                inner: FutureState::ready_err(error),
            },
            Ok(path_c) => {
                let (future, ctx) = AsyncCompletion::create();
                // SAFETY: `path_c` is a valid C string. `face_result_cb` satisfies the
                // single-fire callback contract and completes `ctx` exactly once.
                unsafe {
                    ffi::vn_detect_faces_in_path_async(path_c.as_ptr(), face_result_cb, ctx);
                };
                DetectFacesFuture {
                    inner: FutureState::pending(future),
                }
            }
        }
    }
}

// ============================================================================
// Barcode Detection Future
// ============================================================================

/// Parse the raw barcode-detection result from the Swift bridge.
///
/// # Safety
///
/// `result` must be either null or a valid `AsyncArrayResultRaw` pointer whose
/// `array` field, when non-null, points to `count` valid `DetectedBarcodeRaw`
/// elements.  `error` must be either null or a valid null-terminated C string.
#[cfg(feature = "detect_barcodes")]
unsafe fn parse_barcode_result(
    result: *const c_void,
    error: *const i8,
) -> Result<Vec<DetectedBarcode>, String> {
    if !error.is_null() {
        // SAFETY: caller guarantees `error` is a valid C string when non-null.
        return Err(unsafe { error_from_cstr(error) });
    }
    if result.is_null() {
        return Err("barcode detection returned null".into());
    }

    // SAFETY: caller guarantees `result` is a valid `AsyncArrayResultRaw` pointer.
    let raw = unsafe { &*(result.cast::<ffi::AsyncArrayResultRaw>()) };
    let barcodes = if raw.array.is_null() || raw.count == 0 {
        Vec::new()
    } else {
        let typed = raw.array.cast::<ffi::DetectedBarcodeRaw>();
        let mut out = Vec::with_capacity(raw.count);
        for index in 0..raw.count {
            // SAFETY: `typed` is valid for `raw.count` elements; `index` is in bounds.
            let entry = unsafe { &*typed.add(index) };
            let payload = if entry.payload.is_null() {
                String::new()
            } else {
                // SAFETY: `entry.payload` is a valid C string when non-null.
                unsafe { std::ffi::CStr::from_ptr(entry.payload) }
                    .to_string_lossy()
                    .into_owned()
            };
            let symbology = if entry.symbology.is_null() {
                String::new()
            } else {
                // SAFETY: `entry.symbology` is a valid C string when non-null.
                unsafe { std::ffi::CStr::from_ptr(entry.symbology) }
                    .to_string_lossy()
                    .into_owned()
            };
            out.push(DetectedBarcode {
                payload,
                symbology,
                confidence: entry.confidence,
                bounding_box: crate::recognize_text::BoundingBox {
                    x: entry.bbox_x,
                    y: entry.bbox_y,
                    width: entry.bbox_w,
                    height: entry.bbox_h,
                },
            });
        }
        // SAFETY: `raw.array` and `raw.count` are the Swift-bridge pair; unique free site.
        unsafe { ffi::vn_detected_barcodes_free(raw.array, raw.count) };
        out
    };

    // SAFETY: `result` is the non-null allocation produced by the Swift async bridge.
    unsafe { ffi::vn_async_array_result_free(result.cast_mut()) };
    Ok(barcodes)
}

/// `extern "C"` callback invoked by the Swift bridge when barcode detection completes.
///
/// Wrapped in `catch_unwind`; on panic the future is resolved with an error.
#[cfg(feature = "detect_barcodes")]
extern "C" fn barcode_result_cb(result: *const c_void, error: *const i8, ctx: *mut c_void) {
    // SAFETY: `result` and `error` are valid for the duration of this call per the bridge
    // contract. `AssertUnwindSafe` is correct: raw pointers are not accessed after unwinding.
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| unsafe {
        parse_barcode_result(result, error)
    }));
    match outcome {
        Ok(Ok(barcodes)) => {
            // SAFETY: `ctx` is the `Arc<AsyncCompletionInner<_>>` context from `AsyncCompletion::create()`.
            unsafe { AsyncCompletion::complete_ok(ctx, barcodes) };
        }
        Ok(Err(msg)) => {
            // SAFETY: same as above.
            unsafe { AsyncCompletion::<Vec<DetectedBarcode>>::complete_err(ctx, msg) };
        }
        Err(payload) => {
            log_callback_panic("barcode_result_cb", payload.as_ref());
            // SAFETY: same as above.
            unsafe {
                AsyncCompletion::<Vec<DetectedBarcode>>::complete_err(
                    ctx,
                    "panic in Vision barcode_result_cb".into(),
                );
            };
        }
    }
}

/// Future resolving to a `Vec<DetectedBarcode>`.
#[cfg(feature = "detect_barcodes")]
pub struct DetectBarcodesFuture {
    inner: FutureState<Vec<DetectedBarcode>>,
}

#[cfg(feature = "detect_barcodes")]
impl std::fmt::Debug for DetectBarcodesFuture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DetectBarcodesFuture")
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "detect_barcodes")]
impl Future for DetectBarcodesFuture {
    type Output = Result<Vec<DetectedBarcode>, VisionError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.inner).poll(cx)
    }
}

/// Async wrapper for `VNDetectBarcodesRequest`.
#[cfg(feature = "detect_barcodes")]
#[derive(Debug, Clone, Copy, Default)]
pub struct AsyncDetectBarcodes;

#[cfg(feature = "detect_barcodes")]
impl AsyncDetectBarcodes {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Detect barcodes in the image at `path` asynchronously.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError::RequestFailed`] if Vision fails.
    pub fn detect_in_path(&self, path: impl AsRef<Path>) -> DetectBarcodesFuture {
        match path_to_cstring(path) {
            Err(error) => DetectBarcodesFuture {
                inner: FutureState::ready_err(error),
            },
            Ok(path_c) => {
                let (future, ctx) = AsyncCompletion::create();
                // SAFETY: `path_c` is a valid C string. `barcode_result_cb` satisfies the
                // single-fire callback contract and completes `ctx` exactly once.
                unsafe {
                    ffi::vn_detect_barcodes_in_path_async(path_c.as_ptr(), barcode_result_cb, ctx);
                };
                DetectBarcodesFuture {
                    inner: FutureState::pending(future),
                }
            }
        }
    }
}

// ============================================================================
// Person Segmentation Future
// ============================================================================

/// Parse the raw person-segmentation result from the Swift bridge.
///
/// # Safety
///
/// `result` must be either null or a valid `AsyncSegResultRaw` pointer whose
/// `bytes` field, when non-null, points to at least `height * bytes_per_row` bytes.
/// `error` must be either null or a valid null-terminated C string.
#[cfg(feature = "segmentation")]
unsafe fn parse_seg_result(
    result: *const c_void,
    error: *const i8,
) -> Result<SegmentationMask, String> {
    if !error.is_null() {
        // SAFETY: caller guarantees `error` is a valid C string when non-null.
        return Err(unsafe { error_from_cstr(error) });
    }
    if result.is_null() {
        return Err("segmentation returned null".into());
    }

    // SAFETY: caller guarantees `result` is a valid `AsyncSegResultRaw` pointer.
    let raw = unsafe { &*(result.cast::<ffi::AsyncSegResultRaw>()) };
    if raw.bytes.is_null() {
        // SAFETY: `result` is the non-null allocation produced by the Swift async bridge.
        unsafe { ffi::vn_async_seg_result_free(result.cast_mut()) };
        return Err("segmentation bytes were null".into());
    }

    let len = raw.height.saturating_mul(raw.bytes_per_row);
    // SAFETY: `raw.bytes` is valid for `len` bytes as guaranteed by the Swift bridge.
    let bytes = unsafe { core::slice::from_raw_parts(raw.bytes, len) }.to_vec();
    let mask = SegmentationMask {
        width: raw.width,
        height: raw.height,
        bytes_per_row: raw.bytes_per_row,
        bytes,
    };

    // SAFETY: `result` is the non-null allocation produced by the Swift async bridge;
    // unique free site.
    unsafe { ffi::vn_async_seg_result_free(result.cast_mut()) };
    Ok(mask)
}

/// `extern "C"` callback invoked by the Swift bridge when person segmentation completes.
///
/// Wrapped in `catch_unwind`; on panic the future is resolved with an error.
#[cfg(feature = "segmentation")]
extern "C" fn seg_result_cb(result: *const c_void, error: *const i8, ctx: *mut c_void) {
    // SAFETY: `result` and `error` are valid for the duration of this call per the bridge
    // contract. `AssertUnwindSafe` is correct: raw pointers are not accessed after unwinding.
    let outcome =
        std::panic::catch_unwind(AssertUnwindSafe(|| unsafe { parse_seg_result(result, error) }));
    match outcome {
        Ok(Ok(mask)) => {
            // SAFETY: `ctx` is the `Arc<AsyncCompletionInner<_>>` context from `AsyncCompletion::create()`.
            unsafe { AsyncCompletion::complete_ok(ctx, mask) };
        }
        Ok(Err(msg)) => {
            // SAFETY: same as above.
            unsafe { AsyncCompletion::<SegmentationMask>::complete_err(ctx, msg) };
        }
        Err(payload) => {
            log_callback_panic("seg_result_cb", payload.as_ref());
            // SAFETY: same as above.
            unsafe {
                AsyncCompletion::<SegmentationMask>::complete_err(
                    ctx,
                    "panic in Vision seg_result_cb".into(),
                );
            };
        }
    }
}

/// Future resolving to a `SegmentationMask`.
#[cfg(feature = "segmentation")]
pub struct PersonSegmentationFuture {
    inner: FutureState<SegmentationMask>,
}

#[cfg(feature = "segmentation")]
impl std::fmt::Debug for PersonSegmentationFuture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PersonSegmentationFuture")
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "segmentation")]
impl Future for PersonSegmentationFuture {
    type Output = Result<SegmentationMask, VisionError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.inner).poll(cx)
    }
}

/// Async wrapper for `VNGeneratePersonSegmentationRequest`.
#[cfg(feature = "segmentation")]
#[derive(Debug, Clone, Copy)]
pub struct AsyncPersonSegmentation {
    quality: SegmentationQuality,
}

#[cfg(feature = "segmentation")]
impl Default for AsyncPersonSegmentation {
    fn default() -> Self {
        Self::new(SegmentationQuality::Balanced)
    }
}

#[cfg(feature = "segmentation")]
impl AsyncPersonSegmentation {
    #[must_use]
    pub const fn new(quality: SegmentationQuality) -> Self {
        Self { quality }
    }

    /// Generate a person segmentation mask for the image at `path` asynchronously.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError::RequestFailed`] if Vision fails.
    pub fn generate_in_path(&self, path: impl AsRef<Path>) -> PersonSegmentationFuture {
        match path_to_cstring(path) {
            Err(error) => PersonSegmentationFuture {
                inner: FutureState::ready_err(error),
            },
            Ok(path_c) => {
                let (future, ctx) = AsyncCompletion::create();
                // SAFETY: `path_c` is a valid C string. `seg_result_cb` satisfies the
                // single-fire callback contract and completes `ctx` exactly once.
                // `self.quality as i32` is always a valid quality-level enum value.
                unsafe {
                    ffi::vn_generate_person_segmentation_async(
                        path_c.as_ptr(),
                        self.quality as i32,
                        seg_result_cb,
                        ctx,
                    );
                };
                PersonSegmentationFuture {
                    inner: FutureState::pending(future),
                }
            }
        }
    }
}
