//! Barcode detection via `VNDetectBarcodesRequest` (Vision v0.4).

use core::ffi::{c_char, c_void};
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::ffi;
use crate::recognize_text::BoundingBox;
use crate::sdk;

/// Public alias for `VNBarcodeSymbology`.
pub type BarcodeSymbology = sdk::BarcodeSymbology;

/// Public alias for `VNBarcodeCompositeType`.
pub type BarcodeCompositeType = sdk::BarcodeCompositeType;

/// One detected barcode.
#[derive(Debug, Clone, PartialEq)]
pub struct DetectedBarcode {
    /// The decoded payload (URL, text, contact data, …). May be empty
    /// if Vision couldn't decode it.
    pub payload: String,
    /// Apple's symbology identifier (e.g. `"VNBarcodeSymbologyQR"`,
    /// `"VNBarcodeSymbologyEAN13"`, `"VNBarcodeSymbologyAztec"`).
    pub symbology: String,
    /// Confidence in `0.0..=1.0`.
    pub confidence: f32,
    /// Normalised bounding box (origin at bottom-left, Vision convention).
    pub bounding_box: BoundingBox,
}

impl DetectedBarcode {
    #[must_use]
    pub fn symbology_kind(&self) -> Option<BarcodeSymbology> {
        BarcodeSymbology::from_str(&self.symbology)
    }
}

/// Detect every barcode in the image at `path`.
///
/// Supports QR, EAN-13/8, UPC-A/E, Code 128/39/93, Aztec, PDF417, `DataMatrix`, …
/// (the full Vision symbology set).
///
/// # Errors
///
/// See [`VisionError`].
pub fn detect_barcodes_in_path(
    path: impl AsRef<Path>,
) -> Result<Vec<DetectedBarcode>, VisionError> {
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
        ffi::vn_detect_barcodes_in_path(path_c.as_ptr(), &mut array, &mut count, &mut err_msg)
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
        return Err(unsafe { from_swift(status, err_msg) });
    }
    if array.is_null() || count == 0 {
        return Ok(Vec::new());
    }
    let typed = array.cast::<ffi::DetectedBarcodeRaw>();
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
        let raw = unsafe { &*typed.add(i) };
        let payload = if raw.payload.is_null() {
            String::new()
        } else {
            // SAFETY: the C string pointer is non-null (checked above) and valid for the duration of this borrow.
            unsafe { core::ffi::CStr::from_ptr(raw.payload) }
                .to_string_lossy()
                .into_owned()
        };
        let symbology = if raw.symbology.is_null() {
            String::new()
        } else {
            // SAFETY: the C string pointer is non-null (checked above) and valid for the duration of this borrow.
            unsafe { core::ffi::CStr::from_ptr(raw.symbology) }
                .to_string_lossy()
                .into_owned()
        };
        out.push(DetectedBarcode {
            payload,
            symbology,
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
    unsafe { ffi::vn_detected_barcodes_free(array, count) };
    Ok(out)
}
