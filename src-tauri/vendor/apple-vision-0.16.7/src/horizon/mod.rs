//! Horizon detection (`VNDetectHorizonRequest`).

use core::ffi::c_char;
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::ffi;

/// A simple affine transform matching the `VNHorizonObservation` transform
/// helpers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AffineTransform {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub tx: f64,
    pub ty: f64,
}

/// A dedicated `VNHorizonObservation` wrapper.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HorizonObservation {
    pub angle_radians: f64,
}

impl HorizonObservation {
    #[must_use]
    pub const fn new(angle_radians: f64) -> Self {
        Self { angle_radians }
    }

    #[must_use]
    pub fn transform(self) -> AffineTransform {
        self.transform_for_image(0.0, 0.0)
    }

    #[must_use]
    pub fn transform_for_image(self, width: f64, height: f64) -> AffineTransform {
        let theta = -self.angle_radians;
        let cos_theta = theta.cos();
        let sin_theta = theta.sin();
        let center_x = width / 2.0;
        let center_y = height / 2.0;
        AffineTransform {
            a: cos_theta,
            b: sin_theta,
            c: -sin_theta,
            d: cos_theta,
            tx: center_x - (center_x * cos_theta) + (center_y * sin_theta),
            ty: center_y - (center_x * sin_theta) - (center_y * cos_theta),
        }
    }
}

/// Detect a dedicated `VNHorizonObservation` wrapper in the image at `path`.
/// Returns `None` if Apple can't find a strong horizon.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn detect_horizon_observation_in_path(
    path: impl AsRef<Path>,
) -> Result<Option<HorizonObservation>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let path_c = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;

    let mut angle: f64 = 0.0;
    let mut has_value: bool = false;
    let mut err_msg: *mut c_char = ptr::null_mut();

    // SAFETY: all pointer arguments are valid stack locations or null-initialised out-params; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_detect_horizon_in_path(path_c.as_ptr(), &mut angle, &mut has_value, &mut err_msg)
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
        return Err(unsafe { from_swift(status, err_msg) });
    }
    Ok(has_value.then_some(HorizonObservation::new(angle)))
}

/// Detect the horizon angle (in radians) in the image at `path`.
/// Returns `None` if Apple can't find a strong horizon.
///
/// Positive values rotate the image clockwise to level the horizon.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn detect_horizon_in_path(path: impl AsRef<Path>) -> Result<Option<f64>, VisionError> {
    detect_horizon_observation_in_path(path)
        .map(|observation| observation.map(|obs| obs.angle_radians))
}
