//! Rectangle + document-segmentation detection.
//!
//! `VNDetectRectanglesRequest` finds quadrilaterals (signs, photos,
//! book pages); `VNDetectDocumentSegmentationRequest` finds full
//! document boundaries — both return the same observation shape.

use core::ffi::c_char;
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::face_landmarks::LandmarkPoint;
use crate::ffi;
use crate::recognize_text::BoundingBox;

/// A detected quadrilateral with axis-aligned bounding box plus
/// individual corner points (in normalised image coordinates,
/// bottom-left origin).
#[derive(Debug, Clone, PartialEq)]
pub struct RectangleObservation {
    pub bounding_box: BoundingBox,
    pub confidence: f32,
    pub top_left: LandmarkPoint,
    pub top_right: LandmarkPoint,
    pub bottom_left: LandmarkPoint,
    pub bottom_right: LandmarkPoint,
}

/// Optional tuning for `detect_rectangles_in_path`. Pass `default()`
/// to use Apple's defaults.
#[derive(Debug, Clone, Copy, Default)]
pub struct RectangleOptions {
    /// `0` ⇒ Apple default.
    pub max_observations: usize,
    /// `0` ⇒ Apple default.
    pub minimum_aspect_ratio: f32,
    /// `0` ⇒ Apple default.
    pub maximum_aspect_ratio: f32,
    /// `0` ⇒ Apple default (normalised size of smallest rectangle).
    pub minimum_size: f32,
    /// `0` ⇒ Apple default.
    pub minimum_confidence: f32,
}

/// Detect rectangles in the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn detect_rectangles_in_path(
    path: impl AsRef<Path>,
    options: RectangleOptions,
) -> Result<Vec<RectangleObservation>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let path_c = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;

    let mut out_array: *mut core::ffi::c_void = ptr::null_mut();
    let mut out_count: usize = 0;
    let mut err_msg: *mut c_char = ptr::null_mut();

    // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_detect_rectangles_in_path(
            path_c.as_ptr(),
            options.max_observations,
            options.minimum_aspect_ratio,
            options.maximum_aspect_ratio,
            options.minimum_size,
            options.minimum_confidence,
            &mut out_array,
            &mut out_count,
            &mut err_msg,
        )
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
        return Err(unsafe { from_swift(status, err_msg) });
    }
    // SAFETY: the pointer/count pair comes directly from the bridge and `collect_rects` consumes it exactly once.
    Ok(unsafe { collect_rects(out_array, out_count) })
}

/// Detect a full document's boundary in the image at `path`. Returns
/// at most one rectangle (the document outline).
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn detect_document_segmentation_in_path(
    path: impl AsRef<Path>,
) -> Result<Vec<RectangleObservation>, VisionError> {
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
        ffi::vn_detect_document_segmentation_in_path(
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
    // SAFETY: the pointer/count pair comes directly from the bridge and `collect_rects` consumes it exactly once.
    Ok(unsafe { collect_rects(out_array, out_count) })
}

/// Convert a bridge-allocated rectangle array into Rust-owned observations.
///
/// # Safety
///
/// `out_array` must be either null or point to `out_count` consecutive
/// `RectangleObservationRaw` elements allocated by the Swift bridge.
/// This function consumes that allocation and frees it exactly once.
unsafe fn collect_rects(
    out_array: *mut core::ffi::c_void,
    out_count: usize,
) -> Vec<RectangleObservation> {
    if out_array.is_null() || out_count == 0 {
        return Vec::new();
    }
    let typed = out_array.cast::<ffi::RectangleObservationRaw>();
    let mut v = Vec::with_capacity(out_count);
    for i in 0..out_count {
        // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
        let r = unsafe { &*typed.add(i) };
        v.push(RectangleObservation {
            bounding_box: BoundingBox {
                x: r.bbox_x,
                y: r.bbox_y,
                width: r.bbox_w,
                height: r.bbox_h,
            },
            confidence: r.confidence,
            top_left: LandmarkPoint {
                x: r.tl_x,
                y: r.tl_y,
            },
            top_right: LandmarkPoint {
                x: r.tr_x,
                y: r.tr_y,
            },
            bottom_left: LandmarkPoint {
                x: r.bl_x,
                y: r.bl_y,
            },
            bottom_right: LandmarkPoint {
                x: r.br_x,
                y: r.br_y,
            },
        });
    }
    // SAFETY: the pointer/count pair was allocated by the bridge and is freed exactly once here.
    unsafe { ffi::vn_rectangle_observations_free(out_array, out_count) };
    v
}
