//! Aesthetics scoring (`VNCalculateImageAestheticsScoresRequest`)
//! and face capture quality (`VNDetectFaceCaptureQualityRequest`).

use core::ffi::c_char;
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::ffi;
use crate::recognize_text::BoundingBox;

/// One image's aesthetics score. Higher = more visually appealing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AestheticsScores {
    /// Apple's overall aesthetics score in roughly `-1.0..=1.0`.
    pub overall_score: f32,
    /// True if Apple's model thinks the image is "utility" (e.g.
    /// screenshots, scanned documents) rather than expressive content.
    pub is_utility: bool,
}

/// Calculate Apple's image aesthetics scores (macOS 15+).
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn calculate_aesthetics_scores_in_path(
    path: impl AsRef<Path>,
) -> Result<Option<AestheticsScores>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let path_c = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;

    let mut raw = ffi::AestheticsScoresRaw {
        overall_score: 0.0,
        is_utility: false,
    };
    let mut has_value = false;
    let mut err_msg: *mut c_char = ptr::null_mut();
    // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_calculate_aesthetics_scores_in_path(
            path_c.as_ptr(),
            &mut raw,
            &mut has_value,
            &mut err_msg,
        )
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
        return Err(unsafe { from_swift(status, err_msg) });
    }
    Ok(if has_value {
        Some(AestheticsScores {
            overall_score: raw.overall_score,
            is_utility: raw.is_utility,
        })
    } else {
        None
    })
}

/// One face plus Apple's portrait-quality score (`0.0..=1.0`,
/// higher = better candidate for "best moment" selection).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceCaptureQuality {
    pub bounding_box: BoundingBox,
    pub confidence: f32,
    /// `Some(0.0..=1.0)` if Apple produced a score; `None` if the
    /// face was detected but quality couldn't be evaluated.
    pub capture_quality: Option<f32>,
}

/// Detect faces and grade each one's capture quality.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn detect_face_capture_quality_in_path(
    path: impl AsRef<Path>,
) -> Result<Vec<FaceCaptureQuality>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let path_c = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;

    let mut out_array: *mut core::ffi::c_void = ptr::null_mut();
    let mut out_count: usize = 0;
    let mut err_msg: *mut c_char = ptr::null_mut();

    // SAFETY: all pointer arguments are valid stack locations or null-initialised out-params; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_detect_face_capture_quality_in_path(
            path_c.as_ptr(),
            &mut out_array,
            &mut out_count,
            &mut err_msg,
        )
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
        return Err(unsafe { from_swift(status, err_msg) });
    }
    if out_array.is_null() || out_count == 0 {
        return Ok(Vec::new());
    }
    let typed = out_array.cast::<ffi::FaceQualityRaw>();
    let mut v = Vec::with_capacity(out_count);
    for i in 0..out_count {
        // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
        let r = unsafe { &*typed.add(i) };
        v.push(FaceCaptureQuality {
            bounding_box: BoundingBox {
                x: r.bbox_x,
                y: r.bbox_y,
                width: r.bbox_w,
                height: r.bbox_h,
            },
            confidence: r.confidence,
            capture_quality: if r.has_quality {
                Some(r.capture_quality)
            } else {
                None
            },
        });
    }
    // SAFETY: the pointer/count pair was allocated by the bridge and is freed exactly once here.
    unsafe { ffi::vn_face_quality_observations_free(out_array, out_count) };
    Ok(v)
}
