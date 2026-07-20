//! Animal recognition (`VNRecognizeAnimalsRequest`).
//!
//! Currently the SDK supports `"Dog"` and `"Cat"` identifiers.

use core::ffi::c_char;
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::ffi;
use crate::recognize_text::BoundingBox;
use crate::sdk;

/// Public alias for `VNAnimalIdentifier`.
pub type AnimalIdentifier = sdk::AnimalIdentifier;

/// One detected animal.
#[derive(Debug, Clone, PartialEq)]
pub struct RecognizedAnimal {
    /// Apple's identifier string — e.g. `"Dog"`, `"Cat"`.
    pub identifier: String,
    pub confidence: f32,
    pub bounding_box: BoundingBox,
}

impl RecognizedAnimal {
    #[must_use]
    pub fn identifier_kind(&self) -> Option<AnimalIdentifier> {
        AnimalIdentifier::from_str(&self.identifier)
    }
}

/// Recognise animals in the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn recognize_animals_in_path(
    path: impl AsRef<Path>,
) -> Result<Vec<RecognizedAnimal>, VisionError> {
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
        ffi::vn_recognize_animals_in_path(
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
    if out_array.is_null() || out_count == 0 {
        return Ok(Vec::new());
    }
    let typed = out_array.cast::<ffi::RecognizedAnimalRaw>();
    let mut v = Vec::with_capacity(out_count);
    for i in 0..out_count {
        // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
        let raw = unsafe { &*typed.add(i) };
        let identifier = if raw.identifier.is_null() {
            String::new()
        } else {
            // SAFETY: the C string pointer is non-null (checked above) and valid for the duration of this borrow.
            unsafe { core::ffi::CStr::from_ptr(raw.identifier) }
                .to_string_lossy()
                .into_owned()
        };
        v.push(RecognizedAnimal {
            identifier,
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
    unsafe { ffi::vn_recognized_animals_free(out_array, out_count) };
    Ok(v)
}
