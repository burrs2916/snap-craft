//! Attention-based saliency detection via `VNGenerateAttentionBasedSaliencyImageRequest`.

use core::ffi::{c_char, c_void};
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::ffi;
use crate::recognize_text::BoundingBox;

/// One salient region in the input image.
#[derive(Debug, Clone, PartialEq)]
pub struct SalientRegion {
    /// Confidence in `0.0..=1.0`.
    pub confidence: f32,
    /// Normalised bounding box (origin at bottom-left, Vision convention).
    pub bounding_box: BoundingBox,
}

/// Detect every attention-based salient region in the image at `path`.
///
/// Saliency identifies areas a viewer is likely to look at first — useful
/// for smart-cropping thumbnails, gaze-guided image previews, etc.
///
/// # Errors
///
/// See [`VisionError`].
pub fn attention_saliency_in_path(
    path: impl AsRef<Path>,
) -> Result<Vec<SalientRegion>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let path_c = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;

    let mut array: *mut c_void = ptr::null_mut();
    let mut count: usize = 0;
    let mut err_msg: *mut c_char = ptr::null_mut();

    // SAFETY: all pointer arguments are valid stack locations or null-initialised out-params; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_attention_saliency_in_path(path_c.as_ptr(), &mut array, &mut count, &mut err_msg)
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
        return Err(unsafe { from_swift(status, err_msg) });
    }
    if array.is_null() || count == 0 {
        return Ok(Vec::new());
    }
    let typed = array.cast::<ffi::SaliencyRegionRaw>();
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
        let raw = unsafe { &*typed.add(i) };
        out.push(SalientRegion {
            confidence: raw.confidence,
            bounding_box: BoundingBox {
                x: raw.bbox_x,
                y: raw.bbox_y,
                width: raw.bbox_w,
                height: raw.bbox_h,
            },
        });
    }
    // SAFETY: the pointer/count pair was allocated by the bridge and is freed exactly once here.
    unsafe { ffi::vn_saliency_regions_free(array, count) };
    Ok(out)
}
