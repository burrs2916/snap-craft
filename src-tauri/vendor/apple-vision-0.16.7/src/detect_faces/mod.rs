//! [`FaceDetector`] — wraps `VNDetectFaceRectanglesRequest`.

use core::ffi::c_char;
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::ffi;
use crate::recognize_text::BoundingBox;

/// One detected face.
#[derive(Debug, Clone, PartialEq)]
pub struct DetectedFace {
    /// Bounding box in normalised image coordinates (origin bottom-left).
    pub bounding_box: BoundingBox,
    /// Detection confidence in `0.0..=1.0`.
    pub confidence: f32,
    /// Face roll in radians; `None` if not reported by the request revision.
    pub roll: Option<f32>,
    pub yaw: Option<f32>,
    pub pitch: Option<f32>,
}

/// Face detector wrapper around `VNDetectFaceRectanglesRequest`.
#[derive(Debug, Clone, Copy, Default)]
pub struct FaceDetector;

impl FaceDetector {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Detect faces in the image at `path`.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
    pub fn detect_in_path(&self, path: impl AsRef<Path>) -> Result<Vec<DetectedFace>, VisionError> {
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
            ffi::vn_detect_faces_in_path(
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
        Self::collect(out_array, out_count)
    }

    /// Detect faces in a [`CVPixelBuffer`](apple_cf::cv::CVPixelBuffer).
    ///
    /// # Errors
    ///
    /// See [`detect_in_path`](Self::detect_in_path).
    pub fn detect_in_pixel_buffer(
        &self,
        pixel_buffer: &apple_cf::cv::CVPixelBuffer,
    ) -> Result<Vec<DetectedFace>, VisionError> {
        let mut out_array: *mut core::ffi::c_void = ptr::null_mut();
        let mut out_count: usize = 0;
        let mut err_msg: *mut c_char = ptr::null_mut();
        // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_detect_faces_in_pixel_buffer(
                pixel_buffer.as_ptr(),
                &mut out_array,
                &mut out_count,
                &mut err_msg,
            )
        };
        if status != ffi::status::OK {
            // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
            return Err(unsafe { from_swift(status, err_msg) });
        }
        Self::collect(out_array, out_count)
    }

    #[allow(clippy::unnecessary_wraps)]
    fn collect(
        out_array: *mut core::ffi::c_void,
        out_count: usize,
    ) -> Result<Vec<DetectedFace>, VisionError> {
        if out_array.is_null() || out_count == 0 {
            return Ok(Vec::new());
        }
        let typed_array = out_array.cast::<ffi::DetectedFaceRaw>();
        let mut results = Vec::with_capacity(out_count);
        for i in 0..out_count {
            // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
            let raw = unsafe { &*typed_array.add(i) };
            let nan_to_none = |v: f32| if v.is_nan() { None } else { Some(v) };
            results.push(DetectedFace {
                bounding_box: BoundingBox {
                    x: raw.bbox_x,
                    y: raw.bbox_y,
                    width: raw.bbox_w,
                    height: raw.bbox_h,
                },
                confidence: raw.confidence,
                roll: nan_to_none(raw.roll),
                yaw: nan_to_none(raw.yaw),
                pitch: nan_to_none(raw.pitch),
            });
        }
        // SAFETY: the pointer/count pair was allocated by the bridge and is freed exactly once here.
        unsafe { ffi::vn_detected_faces_free(out_array, out_count) };
        Ok(results)
    }
}
