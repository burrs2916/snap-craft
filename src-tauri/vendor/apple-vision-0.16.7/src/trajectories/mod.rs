#![allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
#![allow(clippy::too_long_first_doc_paragraph)]
//! `VNDetectTrajectoriesRequest` — parabolic-trajectory detection.

use std::ffi::{CStr, CString};
use std::path::Path;
use std::ptr;

use crate::error::VisionError;
use crate::ffi;

/// A single detected trajectory.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Trajectory {
    pub detected_x: f64,
    pub detected_y: f64,
    pub projected_x: f64,
    pub projected_y: f64,
    /// Coefficients of the parabola `y = a x² + b x + c`.
    pub equation_a: f64,
    pub equation_b: f64,
    pub equation_c: f64,
    pub confidence: f32,
}

/// Detect parabolic trajectories in the image at `path`. The
/// Vision sequence handler analyses up to `trajectory_length` frames
/// internally; with a single call this returns trajectories detected
/// across that synthetic sequence.
///
/// # Errors
///
/// Returns [`VisionError`] when the image fails to load or the
/// Vision request errors.
pub fn detect_trajectories(
    path: impl AsRef<Path>,
    trajectory_length: usize,
) -> Result<Vec<Trajectory>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let cpath = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;
    let mut traj_ptr: *mut ffi::TrajectoryRaw = ptr::null_mut();
    let mut count: isize = 0;
    let mut err: *mut std::ffi::c_char = ptr::null_mut();
    // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_detect_trajectories_in_path(
            cpath.as_ptr(),
            trajectory_length as isize,
            &mut traj_ptr,
            &mut count,
            &mut err,
        )
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `take_err` copies and frees it.
        let msg = unsafe { take_err(err) };
        return Err(VisionError::RequestFailed(msg));
    }
    let mut out = Vec::with_capacity(count.max(0) as usize);
    for i in 0..count {
        // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
        let t = unsafe { traj_ptr.offset(i).read() };
        out.push(Trajectory {
            detected_x: t.detected_x,
            detected_y: t.detected_y,
            projected_x: t.projected_x,
            projected_y: t.projected_y,
            equation_a: t.equation_a,
            equation_b: t.equation_b,
            equation_c: t.equation_c,
            confidence: t.confidence,
        });
    }
    if !traj_ptr.is_null() {
        // SAFETY: the pointer/count pair was allocated by the bridge and is freed exactly once here.
        unsafe { ffi::vn_trajectories_free(traj_ptr, count) };
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
