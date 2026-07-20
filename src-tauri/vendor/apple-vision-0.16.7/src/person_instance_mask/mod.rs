#![allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
#![allow(clippy::too_long_first_doc_paragraph)]
//! `VNGeneratePersonInstanceMaskRequest` — per-person instance mask
//! (macOS 14+).

use std::ffi::{CStr, CString};
use std::path::Path;
use std::ptr;

use crate::error::VisionError;
use crate::ffi;

/// A returned 8-bit grayscale mask.
pub struct PersonInstanceMask {
    pub width: usize,
    pub height: usize,
    pub bytes_per_row: usize,
    data: *mut u8,
}

impl PersonInstanceMask {
    /// Row-major byte view into the mask buffer.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8] {
        // SAFETY: `self.data` is a valid, non-null pointer to `bytes_per_row * height` bytes
        // allocated by the Swift bridge. The lifetime of the slice is tied to `&self`, so it
        // cannot outlive the allocation.
        unsafe { core::slice::from_raw_parts(self.data, self.bytes_per_row * self.height) }
    }
}

impl Drop for PersonInstanceMask {
    fn drop(&mut self) {
        if !self.data.is_null() {
            let size = (self.bytes_per_row * self.height) as isize;
            // SAFETY: `self.data` is the pointer returned by the Swift bridge and has not
            // been freed yet; `size` matches the allocation size. This is the unique drop site.
            unsafe { ffi::vn_mask_buffer_free(self.data, size) };
            self.data = ptr::null_mut();
        }
    }
}

// SAFETY: `PersonInstanceMask` owns a heap-allocated buffer from the Swift bridge.
// The buffer is not aliased elsewhere; transferring ownership across thread boundaries
// is safe.  Shared references do not mutate the buffer, so `Sync` also holds.
unsafe impl Send for PersonInstanceMask {}
unsafe impl Sync for PersonInstanceMask {}

/// Generate a person-instance mask for the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError`] when the image fails to load or the
/// Vision request errors.
pub fn person_instance_mask(
    path: impl AsRef<Path>,
) -> Result<Option<PersonInstanceMask>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let cpath = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;
    let mut w: isize = 0;
    let mut h: isize = 0;
    let mut bpr: isize = 0;
    let mut data: *mut u8 = ptr::null_mut();
    let mut err: *mut std::ffi::c_char = ptr::null_mut();
    // SAFETY: All pointer arguments are either null or valid out-parameters
    // populated by the Swift bridge on return.
    let status = unsafe {
        ffi::vn_person_instance_mask_in_path(
            cpath.as_ptr(),
            &mut w,
            &mut h,
            &mut bpr,
            &mut data,
            &mut err,
        )
    };
    if status != ffi::status::OK {
        // SAFETY: `err` is either null or a malloc'd C string produced by the bridge.
        let msg = unsafe { take_err(err) };
        return Err(VisionError::RequestFailed(msg));
    }
    if data.is_null() {
        return Ok(None);
    }
    Ok(Some(PersonInstanceMask {
        width: w.max(0) as usize,
        height: h.max(0) as usize,
        bytes_per_row: bpr.max(0) as usize,
        data,
    }))
}

/// Extract an error string from a bridge-allocated C string and free it.
///
/// # Safety
///
/// `p` must be either null or a pointer to a valid null-terminated C string
/// that was heap-allocated by the Swift bridge (i.e., by `malloc`).
/// After this call `p` is invalid; the caller must not use it again.
unsafe fn take_err(p: *mut std::ffi::c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    // SAFETY: `p` is a valid C string per the function contract.
    let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    // SAFETY: `p` was malloc-allocated by the bridge and has not been freed yet.
    unsafe { libc::free(p.cast()) };
    s
}
