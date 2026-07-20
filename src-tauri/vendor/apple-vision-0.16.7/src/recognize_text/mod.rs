//! [`TextRecognizer`] — wraps `VNRecognizeTextRequest` for image-file OCR.

use core::ffi::c_char;
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::ffi;

/// Recognition strategy passed to Vision. `Fast` is real-time-friendly,
/// `Accurate` does layout analysis and is significantly slower.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
#[derive(Default)]
pub enum RecognitionLevel {
    Fast,
    #[default]
    Accurate,
}

impl RecognitionLevel {
    pub(crate) const fn as_raw(self) -> i32 {
        match self {
            Self::Fast => 0,
            Self::Accurate => 1,
        }
    }
}

/// Bounding box in normalised (0.0..=1.0) image coordinates with origin at
/// the bottom-left (Vision convention — flip `y` if you want top-left origin).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoundingBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// One recognised text observation.
#[derive(Debug, Clone, PartialEq)]
pub struct RecognizedText {
    pub text: String,
    /// Confidence in `0.0..=1.0`. `0` means Vision didn't report one.
    pub confidence: f32,
    pub bounding_box: BoundingBox,
}

impl RecognizedText {
    /// Clone this value into the dedicated `VNRecognizedText` wrapper.
    #[must_use]
    pub fn candidate(&self) -> RecognizedTextCandidate {
        self.clone().into()
    }
}

/// Dedicated `VNRecognizedText` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct RecognizedTextCandidate {
    pub text: String,
    pub confidence: f32,
    pub bounding_box: BoundingBox,
}

impl From<RecognizedText> for RecognizedTextCandidate {
    fn from(value: RecognizedText) -> Self {
        Self {
            text: value.text,
            confidence: value.confidence,
            bounding_box: value.bounding_box,
        }
    }
}

impl From<RecognizedTextCandidate> for RecognizedText {
    fn from(value: RecognizedTextCandidate) -> Self {
        Self {
            text: value.text,
            confidence: value.confidence,
            bounding_box: value.bounding_box,
        }
    }
}

/// OCR engine.
///
/// # Examples
///
/// ```rust,no_run
/// use apple_vision::recognize_text::{TextRecognizer, RecognitionLevel};
///
/// # fn main() -> Result<(), Box<dyn std::error::Error>> {
/// let recognizer = TextRecognizer::new()
///     .with_recognition_level(RecognitionLevel::Accurate)
///     .with_language_correction(true);
/// let observations = recognizer.recognize_in_path("screenshot.png")?;
/// for obs in &observations {
///     println!("{:.2} {:?}: {}", obs.confidence, obs.bounding_box, obs.text);
/// }
/// # Ok(())
/// # }
/// ```
#[derive(Debug, Clone)]
pub struct TextRecognizer {
    recognition_level: RecognitionLevel,
    uses_language_correction: bool,
}

impl Default for TextRecognizer {
    fn default() -> Self {
        Self::new()
    }
}

impl TextRecognizer {
    /// Construct with the Vision defaults: accurate mode + language
    /// correction enabled.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            recognition_level: RecognitionLevel::Accurate,
            uses_language_correction: true,
        }
    }

    #[must_use]
    pub const fn with_recognition_level(mut self, level: RecognitionLevel) -> Self {
        self.recognition_level = level;
        self
    }

    #[must_use]
    pub const fn with_language_correction(mut self, enabled: bool) -> Self {
        self.uses_language_correction = enabled;
        self
    }

    /// Recognise text in the image at `path`. Supports any format
    /// CoreGraphics' `ImageIO` can read (PNG, JPEG, HEIC, TIFF, ...).
    ///
    /// Returns observations in Vision's natural ordering (top-down,
    /// left-to-right after layout analysis).
    ///
    /// # Errors
    ///
    /// Returns [`VisionError::InvalidArgument`] if `path` contains an
    /// interior NUL byte, [`VisionError::ImageLoadFailed`] if the image
    /// can't be read, or [`VisionError::RequestFailed`] if Vision rejects
    /// the request.
    pub fn recognize_in_path(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<Vec<RecognizedText>, VisionError> {
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
            ffi::vn_recognize_text_in_path(
                path_c.as_ptr(),
                self.recognition_level.as_raw(),
                self.uses_language_correction,
                &mut out_array,
                &mut out_count,
                &mut err_msg,
            )
        };
        if status != ffi::status::OK {
            // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
            return Err(unsafe { from_swift(status, err_msg) });
        }

        // Empty result is success (no text detected).
        if out_array.is_null() || out_count == 0 {
            return Ok(Vec::new());
        }

        let typed_array = out_array.cast::<ffi::RecognizedTextRaw>();
        let mut results = Vec::with_capacity(out_count);
        for i in 0..out_count {
            // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
            let raw = unsafe { &*typed_array.add(i) };
            let text = if raw.text.is_null() {
                String::new()
            } else {
                // SAFETY: the C string pointer is non-null (checked above) and valid for the duration of this borrow.
                unsafe { core::ffi::CStr::from_ptr(raw.text) }
                    .to_string_lossy()
                    .into_owned()
            };
            results.push(RecognizedText {
                text,
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
        unsafe { ffi::vn_recognized_text_free(out_array, out_count) };
        Ok(results)
    }

    /// Recognise text in a [`CVPixelBuffer`](apple_cf::cv::CVPixelBuffer)
    /// directly, without a PNG round-trip. This is the zero-copy path for
    /// live capture pipelines (screencapturekit / videotoolbox decoder /
    /// `AVCaptureSession`).
    ///
    /// # Errors
    ///
    /// Returns [`VisionError::RequestFailed`] if Vision rejects the buffer
    /// (e.g. unsupported pixel format).
    pub fn recognize_in_pixel_buffer(
        &self,
        pixel_buffer: &apple_cf::cv::CVPixelBuffer,
    ) -> Result<Vec<RecognizedText>, VisionError> {
        let mut out_array: *mut core::ffi::c_void = ptr::null_mut();
        let mut out_count: usize = 0;
        let mut err_msg: *mut c_char = ptr::null_mut();
        // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_recognize_text_in_pixel_buffer(
                pixel_buffer.as_ptr(),
                self.recognition_level.as_raw(),
                self.uses_language_correction,
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

        let typed_array = out_array.cast::<ffi::RecognizedTextRaw>();
        let mut results = Vec::with_capacity(out_count);
        for i in 0..out_count {
            // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
            let raw = unsafe { &*typed_array.add(i) };
            let text = if raw.text.is_null() {
                String::new()
            } else {
                // SAFETY: the C string pointer is non-null (checked above) and valid for the duration of this borrow.
                unsafe { core::ffi::CStr::from_ptr(raw.text) }
                    .to_string_lossy()
                    .into_owned()
            };
            results.push(RecognizedText {
                text,
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
        unsafe { ffi::vn_recognized_text_free(out_array, out_count) };
        Ok(results)
    }
}

#[doc(hidden)]
/// Test helper used by the smoke test — renders `text` to a PNG so OCR can
/// be exercised without bundling fixture files. Not part of the stable API.
pub fn _test_helper_render_text_png(
    text: &str,
    width: i32,
    height: i32,
    path: &Path,
) -> Result<(), VisionError> {
    let text_c = CString::new(text).map_err(|e| VisionError::InvalidArgument(e.to_string()))?;
    let path_c = CString::new(path.to_string_lossy().as_ref())
        .map_err(|e| VisionError::InvalidArgument(e.to_string()))?;
    // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_test_helper_render_text_png(text_c.as_ptr(), width, height, path_c.as_ptr())
    };
    if status != ffi::status::OK {
        return Err(VisionError::Unknown {
            code: status,
            message: "render helper failed".into(),
        });
    }
    Ok(())
}
