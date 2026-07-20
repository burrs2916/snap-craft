//! Edge contour detection (`VNDetectContoursRequest`).

use core::ffi::c_char;
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::face_landmarks::LandmarkPoint;
use crate::ffi;

/// A single closed contour, represented as an ordered list of points
/// in normalised image coordinates.
#[derive(Debug, Clone, PartialEq)]
pub struct Contour {
    /// Vertices in path order, normalised to `0.0..=1.0`.
    pub points: Vec<LandmarkPoint>,
    /// Number of child (nested) contours inside this one.
    pub child_count: isize,
    /// Bounding-box width / height of this contour.
    pub aspect_ratio: f32,
}

/// Public alias for the dedicated `VNContour` wrapper.
pub type VisionContour = Contour;

/// A dedicated `VNContoursObservation` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct ContoursObservation {
    pub contour_count: usize,
    pub top_level_contour_count: usize,
    pub top_level_contours: Vec<Contour>,
}

impl ContoursObservation {
    #[must_use]
    pub fn into_top_level_contours(self) -> Vec<Contour> {
        self.top_level_contours
    }
}

/// Options for `detect_contours_in_path`.
#[derive(Debug, Clone, Copy)]
pub struct ContourOptions {
    /// `0.0..=1.0` — Apple's per-pixel contrast adjustment before
    /// detection. Default 2.0 in the SDK; we mirror that.
    pub contrast_adjustment: f32,
    /// If `true`, look for dark shapes against a light background.
    /// If `false`, light shapes against a dark background.
    pub detects_dark_on_light: bool,
}

impl Default for ContourOptions {
    fn default() -> Self {
        Self {
            contrast_adjustment: 2.0,
            detects_dark_on_light: true,
        }
    }
}

/// Detect a dedicated `VNContoursObservation` wrapper in the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn detect_contours_observation_in_path(
    path: impl AsRef<Path>,
    options: ContourOptions,
) -> Result<ContoursObservation, VisionError> {
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
        ffi::vn_detect_contours_in_path(
            path_c.as_ptr(),
            options.contrast_adjustment,
            options.detects_dark_on_light,
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
        return Ok(ContoursObservation {
            contour_count: 0,
            top_level_contour_count: 0,
            top_level_contours: Vec::new(),
        });
    }
    let typed = out_array.cast::<ffi::ContourRaw>();
    let mut v = Vec::with_capacity(out_count);
    for i in 0..out_count {
        // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
        let raw = unsafe { &*typed.add(i) };
        let mut pts = Vec::with_capacity(raw.point_count);
        for k in 0..raw.point_count {
            // SAFETY: the point buffer is valid for the reported coordinates; this index is in bounds.
            let x = unsafe { *raw.point_xs.add(k) };
            // SAFETY: the point buffer is valid for the reported coordinates; this index is in bounds.
            let y = unsafe { *raw.point_ys.add(k) };
            pts.push(LandmarkPoint { x, y });
        }
        v.push(Contour {
            points: pts,
            child_count: raw.child_count,
            aspect_ratio: raw.aspect_ratio,
        });
    }
    // SAFETY: the pointer/count pair was allocated by the bridge and is freed exactly once here.
    unsafe { ffi::vn_contours_free(out_array, out_count) };
    let contour_count = v
        .iter()
        .map(|contour| usize::try_from(contour.child_count).unwrap_or_default())
        .sum::<usize>()
        + v.len();
    Ok(ContoursObservation {
        contour_count,
        top_level_contour_count: v.len(),
        top_level_contours: v,
    })
}

/// Detect top-level contours in the image at `path`.
///
/// Only the outermost (top-level) contours are returned directly; use
/// [`detect_contours_observation_in_path`] for the dedicated
/// `VNContoursObservation` wrapper.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn detect_contours_in_path(
    path: impl AsRef<Path>,
    options: ContourOptions,
) -> Result<Vec<Contour>, VisionError> {
    detect_contours_observation_in_path(path, options)
        .map(ContoursObservation::into_top_level_contours)
}
