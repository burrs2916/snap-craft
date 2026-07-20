//! Human-rectangle detection (`VNDetectHumanRectanglesRequest`) —
//! lightweight person bounding boxes without joint skeletons.

use core::ffi::c_char;
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::ffi;
use crate::recognize_text::BoundingBox;

/// One detected person.
#[derive(Debug, Clone, PartialEq)]
pub struct DetectedHuman {
    pub bounding_box: BoundingBox,
    pub confidence: f32,
    /// `true` if the detection was constrained to upper body only.
    pub upper_body_only: bool,
}

/// Detect humans in the image at `path`. Set `upper_body_only=true`
/// for selfie / chest-up framing (macOS 12+); set to `false` for
/// full-body detection.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn detect_human_rectangles_in_path(
    path: impl AsRef<Path>,
    upper_body_only: bool,
) -> Result<Vec<DetectedHuman>, VisionError> {
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
        ffi::vn_detect_human_rectangles_in_path(
            path_c.as_ptr(),
            upper_body_only,
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
    let typed = out_array.cast::<ffi::HumanObservationRaw>();
    let mut v = Vec::with_capacity(out_count);
    for i in 0..out_count {
        // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
        let r = unsafe { &*typed.add(i) };
        v.push(DetectedHuman {
            bounding_box: BoundingBox {
                x: r.bbox_x,
                y: r.bbox_y,
                width: r.bbox_w,
                height: r.bbox_h,
            },
            confidence: r.confidence,
            upper_body_only: r.upper_body_only,
        });
    }
    // SAFETY: the pointer/count pair was allocated by the bridge and is freed exactly once here.
    unsafe { ffi::vn_human_observations_free(out_array, out_count) };
    Ok(v)
}
