//! Optical flow generation (`VNGenerateOpticalFlowRequest`).
//!
//! Apple's optical flow request runs over **two** frames (A and B)
//! and returns a per-pixel displacement field describing how pixels
//! in A moved to land in B. Raw `CVPixelBuffer` bytes are copied into
//! a [`SegmentationMask`] for easy transport.
//!
//! Trajectory detection (`VNDetectTrajectoriesRequest`) is intentionally
//! deferred — it's a `VNStatefulRequest` that requires feeding many
//! frames into the same request instance over time, which doesn't fit
//! the synchronous one-shot request pattern this crate uses.

use core::ffi::c_char;
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::ffi;
use crate::request_base::PixelBufferObservation;
use crate::segmentation::SegmentationMask;

/// `VNGenerateOpticalFlowRequest.ComputationAccuracy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpticalFlowAccuracy {
    Low = 0,
    Medium = 1,
    High = 2,
    VeryHigh = 3,
}

/// Compute the optical flow between `path_a` (start) and `path_b`
/// (end). Returns raw flow bytes wrapped in a [`SegmentationMask`].
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn generate_optical_flow_in_paths(
    path_a: impl AsRef<Path>,
    path_b: impl AsRef<Path>,
    accuracy: OpticalFlowAccuracy,
) -> Result<Option<SegmentationMask>, VisionError> {
    let a_str = path_a
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path A".into()))?;
    let b_str = path_b
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path B".into()))?;
    let a_c = CString::new(a_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path A NUL byte: {e}")))?;
    let b_c = CString::new(b_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path B NUL byte: {e}")))?;

    let mut raw = ffi::SegmentationMaskRaw {
        width: 0,
        height: 0,
        bytes_per_row: 0,
        bytes: ptr::null_mut(),
    };
    let mut has_value = false;
    let mut err_msg: *mut c_char = ptr::null_mut();
    // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_generate_optical_flow_in_paths(
            a_c.as_ptr(),
            b_c.as_ptr(),
            accuracy as i32,
            &mut raw,
            &mut has_value,
            &mut err_msg,
        )
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
        return Err(unsafe { from_swift(status, err_msg) });
    }
    if !has_value || raw.bytes.is_null() {
        return Ok(None);
    }
    let len = raw.height.saturating_mul(raw.bytes_per_row);
    // SAFETY: `raw.bytes` is valid for `len` bytes as guaranteed by the Swift bridge.
    let slice = unsafe { core::slice::from_raw_parts(raw.bytes.cast::<u8>(), len) };
    let bytes = slice.to_vec();
    // SAFETY: `raw` was populated by the bridge and has not been freed yet; unique free site.
    unsafe { ffi::vn_segmentation_mask_free(&mut raw) };
    Ok(Some(SegmentationMask {
        width: raw.width,
        height: raw.height,
        bytes_per_row: raw.bytes_per_row,
        bytes,
    }))
}

/// Compute the optical flow and wrap the result as a generic
/// `VNPixelBufferObservation`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn generate_optical_flow_observation_in_paths(
    path_a: impl AsRef<Path>,
    path_b: impl AsRef<Path>,
    accuracy: OpticalFlowAccuracy,
) -> Result<Option<PixelBufferObservation>, VisionError> {
    generate_optical_flow_in_paths(path_a, path_b, accuracy)
        .map(|mask| mask.map(PixelBufferObservation::from))
}
