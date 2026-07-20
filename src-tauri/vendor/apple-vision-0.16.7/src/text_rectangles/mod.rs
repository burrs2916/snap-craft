#![allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
#![allow(clippy::too_long_first_doc_paragraph)]
//! `VNDetectTextRectanglesRequest` — text-region detection (no OCR).

use std::ffi::CString;
use std::path::Path;
use std::ptr;

use crate::error::{from_swift, VisionError};
use crate::ffi;
use crate::request_base::{ImageBasedRequest, NormalizedRect};

/// A detected text rectangle in normalised (0..1) image coordinates,
/// origin bottom-left (Vision convention).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub confidence: f32,
}

/// A dedicated `VNTextObservation` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct TextObservation {
    pub bounding_box: NormalizedRect,
    pub confidence: f32,
    pub character_boxes: Vec<NormalizedRect>,
}

impl TextObservation {
    #[must_use]
    pub fn into_text_rect(self) -> TextRect {
        TextRect {
            x: self.bounding_box.x,
            y: self.bounding_box.y,
            w: self.bounding_box.width,
            h: self.bounding_box.height,
            confidence: self.confidence,
        }
    }
}

impl From<TextObservation> for TextRect {
    fn from(value: TextObservation) -> Self {
        value.into_text_rect()
    }
}

/// Builder for `VNDetectTextRectanglesRequest`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TextRectanglesRequest {
    image_based: ImageBasedRequest,
    report_character_boxes: bool,
}

impl TextRectanglesRequest {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            image_based: ImageBasedRequest::new(),
            report_character_boxes: false,
        }
    }

    #[must_use]
    pub const fn with_image_based_request(mut self, image_based: ImageBasedRequest) -> Self {
        self.image_based = image_based;
        self
    }

    #[must_use]
    pub const fn with_report_character_boxes(mut self, report_character_boxes: bool) -> Self {
        self.report_character_boxes = report_character_boxes;
        self
    }

    #[must_use]
    pub const fn image_based_request(&self) -> &ImageBasedRequest {
        &self.image_based
    }

    #[must_use]
    pub const fn report_character_boxes(&self) -> bool {
        self.report_character_boxes
    }

    /// Perform the request against `path` and return dedicated `VNTextObservation`
    /// wrappers.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError`] if the image cannot be loaded or Vision rejects
    /// the request.
    pub fn perform(&self, path: impl AsRef<Path>) -> Result<Vec<TextObservation>, VisionError> {
        let path_str = path
            .as_ref()
            .to_str()
            .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
        let cpath = CString::new(path_str)
            .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;
        let mut observations_ptr: *mut ffi::TextObservationRaw = ptr::null_mut();
        let mut count: usize = 0;
        let mut err = ptr::null_mut();
        let roi = self.image_based.region_of_interest();
        // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_detect_text_observations_in_path(
                cpath.as_ptr(),
                self.report_character_boxes,
                roi.map_or(0.0, |rect| rect.x),
                roi.map_or(0.0, |rect| rect.y),
                roi.map_or(1.0, |rect| rect.width),
                roi.map_or(1.0, |rect| rect.height),
                roi.is_some(),
                self.image_based.prefer_background_processing(),
                self.image_based.uses_cpu_only(),
                self.image_based.revision().unwrap_or_default(),
                self.image_based.revision().is_some(),
                &mut observations_ptr,
                &mut count,
                &mut err,
            )
        };
        if status != ffi::status::OK {
            // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
            return Err(unsafe { from_swift(status, err) });
        }
        if observations_ptr.is_null() || count == 0 {
            return Ok(Vec::new());
        }
        let mut out = Vec::with_capacity(count);
        for index in 0..count {
            // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
            let raw = unsafe { &*observations_ptr.add(index) };
            let mut character_boxes = Vec::with_capacity(raw.character_box_count);
            for char_index in 0..raw.character_box_count {
                // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
                let character_box = unsafe { &*raw.character_boxes.add(char_index) };
                character_boxes.push(NormalizedRect::new(
                    character_box.x,
                    character_box.y,
                    character_box.w,
                    character_box.h,
                ));
            }
            out.push(TextObservation {
                bounding_box: NormalizedRect::new(raw.bbox_x, raw.bbox_y, raw.bbox_w, raw.bbox_h),
                confidence: raw.confidence,
                character_boxes,
            });
        }
        // SAFETY: the pointer/count pair was allocated by the bridge and is freed exactly once here.
        unsafe { ffi::vn_text_observations_free(observations_ptr.cast(), count) };
        Ok(out)
    }
}

/// Detect dedicated `VNTextObservation` wrappers in the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError`] if the image fails to load or the Vision request
/// errors.
pub fn detect_text_observations(
    path: impl AsRef<Path>,
    report_character_boxes: bool,
) -> Result<Vec<TextObservation>, VisionError> {
    TextRectanglesRequest::new()
        .with_report_character_boxes(report_character_boxes)
        .perform(path)
}

/// Detect text-region rectangles in the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError`] when the image fails to load or the Vision request
/// errors.
pub fn detect_text_rectangles(
    path: impl AsRef<Path>,
    report_character_boxes: bool,
) -> Result<Vec<TextRect>, VisionError> {
    detect_text_observations(path, report_character_boxes)
        .map(|observations| observations.into_iter().map(Into::into).collect())
}
