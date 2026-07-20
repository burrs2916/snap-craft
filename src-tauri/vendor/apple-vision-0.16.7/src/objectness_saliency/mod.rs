#![allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
#![allow(clippy::too_long_first_doc_paragraph)]
//! `VNGenerateObjectnessBasedSaliencyImageRequest` — discrete object
//! regions an attention model thinks are salient.

use std::ffi::{CStr, CString};
use std::path::Path;
use std::ptr;

use crate::error::VisionError;
use crate::ffi;

/// One salient object region.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ObjectnessRegion {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub confidence: f32,
}

/// Detect objectness-based salient regions in the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError`] when the image fails to load or the
/// Vision request errors.
pub fn objectness_saliency(path: impl AsRef<Path>) -> Result<Vec<ObjectnessRegion>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let cpath = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;
    let mut rects_ptr: *mut ffi::SimpleRectRaw = ptr::null_mut();
    let mut count: isize = 0;
    let mut err: *mut std::ffi::c_char = ptr::null_mut();
    // SAFETY: all pointer arguments are valid stack locations or null-initialised out-params; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_objectness_saliency_in_path(cpath.as_ptr(), &mut rects_ptr, &mut count, &mut err)
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `take_err` copies and frees it.
        let msg = unsafe { take_err(err) };
        return Err(VisionError::RequestFailed(msg));
    }
    let mut out = Vec::with_capacity(count.max(0) as usize);
    for i in 0..count {
        // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
        let r = unsafe { rects_ptr.offset(i).read() };
        out.push(ObjectnessRegion {
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            confidence: r.confidence,
        });
    }
    if !rects_ptr.is_null() {
        // SAFETY: the pointer/count pair was allocated by the bridge and is freed exactly once here.
        unsafe { ffi::vn_simple_rects_free(rects_ptr, count) };
    }
    Ok(out)
}

/// Extract an error string from a bridge-allocated C string and free it.
///
/// # Safety
///
/// `p` must be either null or a valid null-terminated C string heap-allocated
/// (via `malloc`) by the Swift bridge. After this call `p` is invalid.
unsafe fn take_err(p: *mut std::ffi::c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    // SAFETY: the C string pointer is non-null (checked above) and valid for the duration of this borrow.
    let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    // SAFETY: `p` was malloc-allocated by the bridge and has not been freed yet.
    unsafe { libc::free(p.cast()) };
    s
}
