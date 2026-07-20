//! Image feature print (`VNGenerateImageFeaturePrintRequest`) —
//! semantic image embedding for content-based similarity.

use core::ffi::c_char;
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::ffi;

/// A semantic image embedding produced by Apple's vision pipeline.
///
/// Distances between two prints (e.g. cosine or L2) measure
/// content similarity — useful for clustering, deduplication, and
/// content-based image search.
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::derive_partial_eq_without_eq)]
pub struct FeaturePrint {
    /// Underlying element type — `1 = Float32`, `2 = Float64`.
    pub element_type: i32,
    /// Vector dimensionality.
    pub element_count: usize,
    /// Raw element bytes (length = `element_count * 4` or `* 8`).
    pub data: Vec<u8>,
}

impl FeaturePrint {
    /// Decode the vector as `f32` (only valid when
    /// `element_type == 1`).
    #[must_use]
    pub fn as_f32(&self) -> Option<Vec<f32>> {
        if self.element_type != 1 {
            return None;
        }
        let mut out = Vec::with_capacity(self.element_count);
        for chunk in self.data.chunks_exact(4) {
            let arr: [u8; 4] = chunk.try_into().ok()?;
            out.push(f32::from_le_bytes(arr));
        }
        Some(out)
    }

    /// Decode the vector as `f64` (only valid when
    /// `element_type == 2`).
    #[must_use]
    pub fn as_f64(&self) -> Option<Vec<f64>> {
        if self.element_type != 2 {
            return None;
        }
        let mut out = Vec::with_capacity(self.element_count);
        for chunk in self.data.chunks_exact(8) {
            let arr: [u8; 8] = chunk.try_into().ok()?;
            out.push(f64::from_le_bytes(arr));
        }
        Some(out)
    }

    /// Compute Euclidean (L2) distance to another print. Smaller =
    /// more similar.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError::InvalidArgument`] if the two prints
    /// have different element types or counts.
    pub fn l2_distance(&self, other: &Self) -> Result<f64, VisionError> {
        if self.element_type != other.element_type || self.element_count != other.element_count {
            return Err(VisionError::InvalidArgument(
                "feature print element type / count mismatch".into(),
            ));
        }
        let sumsq: f64 = match self.element_type {
            1 => self
                .as_f32()
                .unwrap_or_default()
                .iter()
                .zip(other.as_f32().unwrap_or_default().iter())
                .map(|(a, b)| f64::from(a - b).powi(2))
                .sum(),
            2 => self
                .as_f64()
                .unwrap_or_default()
                .iter()
                .zip(other.as_f64().unwrap_or_default().iter())
                .map(|(a, b)| (a - b).powi(2))
                .sum(),
            _ => 0.0,
        };
        Ok(sumsq.sqrt())
    }
}

/// Generate a feature print for the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn generate_image_feature_print_in_path(
    path: impl AsRef<Path>,
) -> Result<Option<FeaturePrint>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let path_c = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;

    let mut raw = ffi::FeaturePrintRaw {
        element_type: 0,
        element_count: 0,
        bytes: ptr::null_mut(),
    };
    let mut err_msg: *mut c_char = ptr::null_mut();
    // SAFETY: all pointer arguments are valid stack locations or null-initialised out-params; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_generate_image_feature_print_in_path(path_c.as_ptr(), &mut raw, &mut err_msg)
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
        return Err(unsafe { from_swift(status, err_msg) });
    }
    if raw.bytes.is_null() || raw.element_count == 0 {
        return Ok(None);
    }
    let bytes_per_elem = match raw.element_type {
        1 => 4_usize,
        2 => 8_usize,
        _ => 0_usize,
    };
    let len = raw.element_count.saturating_mul(bytes_per_elem);
    // SAFETY: `raw.bytes` is valid for `len` bytes as guaranteed by the Swift bridge.
    let slice = unsafe { core::slice::from_raw_parts(raw.bytes.cast::<u8>(), len) };
    let data = slice.to_vec();
    // SAFETY: `raw` was populated by the bridge and has not been freed yet; unique free site.
    unsafe { ffi::vn_feature_print_free(&mut raw) };

    Ok(Some(FeaturePrint {
        element_type: raw.element_type,
        element_count: raw.element_count,
        data,
    }))
}
