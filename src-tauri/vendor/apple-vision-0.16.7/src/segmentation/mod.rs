//! Segmentation mask generation —
//! `VNGeneratePersonSegmentationRequest` and
//! `VNGenerateForegroundInstanceMaskRequest`.
//!
//! Both produce a grayscale `CVPixelBuffer` mask; this module copies
//! it into a Rust-owned `Vec<u8>` so callers don't need a `CoreVideo`
//! dependency. Mask values are 8-bit (`0` = background, `255` =
//! foreground). For instance masks, pixel values index into a list
//! of detected instances (`1..=instance_count`).

use core::ffi::c_char;
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::ffi;
use crate::request_base::PixelBufferObservation;

/// Apple person-segmentation quality.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentationQuality {
    Fast = 0,
    Balanced = 1,
    Accurate = 2,
}

/// A single grayscale mask in row-major byte order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentationMask {
    pub width: usize,
    pub height: usize,
    pub bytes_per_row: usize,
    pub bytes: Vec<u8>,
}

/// A foreground-instance mask plus the number of distinct instances
/// the model identified. Pixel values are `0` for background and
/// `1..=instance_count` for each detected instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceMask {
    pub mask: SegmentationMask,
    pub instance_count: usize,
}

/// A dedicated `VNInstanceMaskObservation` wrapper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceMaskObservation {
    pub pixel_buffer_observation: PixelBufferObservation,
    pub instance_count: usize,
}

impl InstanceMaskObservation {
    #[must_use]
    pub fn into_instance_mask(self) -> InstanceMask {
        self.into()
    }
}

impl From<SegmentationMask> for PixelBufferObservation {
    fn from(value: SegmentationMask) -> Self {
        Self::new(value.width, value.height, value.bytes_per_row, value.bytes)
    }
}

impl From<InstanceMask> for InstanceMaskObservation {
    fn from(value: InstanceMask) -> Self {
        Self {
            pixel_buffer_observation: value.mask.into(),
            instance_count: value.instance_count,
        }
    }
}

impl From<InstanceMaskObservation> for InstanceMask {
    fn from(value: InstanceMaskObservation) -> Self {
        Self {
            mask: SegmentationMask {
                width: value.pixel_buffer_observation.width,
                height: value.pixel_buffer_observation.height,
                bytes_per_row: value.pixel_buffer_observation.bytes_per_row,
                bytes: value.pixel_buffer_observation.bytes,
            },
            instance_count: value.instance_count,
        }
    }
}

/// Generate a person/body silhouette mask for the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn generate_person_segmentation_in_path(
    path: impl AsRef<Path>,
    quality: SegmentationQuality,
) -> Result<Option<SegmentationMask>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let path_c = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;

    let mut raw = ffi::SegmentationMaskRaw {
        width: 0,
        height: 0,
        bytes_per_row: 0,
        bytes: ptr::null_mut(),
    };
    let mut has_value = false;
    let mut err_msg: *mut c_char = ptr::null_mut();
    // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_generate_person_segmentation_in_path(
            path_c.as_ptr(),
            quality as i32,
            &mut raw,
            &mut has_value,
            &mut err_msg,
        )
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
        return Err(unsafe { from_swift(status, err_msg) });
    }
    if !has_value || raw.bytes.is_null() {
        return Ok(None);
    }
    let mask = take_raw(&mut raw);
    Ok(Some(mask))
}

/// Generate an instance segmentation mask of all foreground objects
/// in the image at `path` (macOS 14+).
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn generate_foreground_instance_mask_in_path(
    path: impl AsRef<Path>,
) -> Result<Option<InstanceMask>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let path_c = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;

    let mut raw = ffi::SegmentationMaskRaw {
        width: 0,
        height: 0,
        bytes_per_row: 0,
        bytes: ptr::null_mut(),
    };
    let mut instance_count: usize = 0;
    let mut has_value = false;
    let mut err_msg: *mut c_char = ptr::null_mut();
    // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_generate_foreground_instance_mask_in_path(
            path_c.as_ptr(),
            &mut raw,
            &mut instance_count,
            &mut has_value,
            &mut err_msg,
        )
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
        return Err(unsafe { from_swift(status, err_msg) });
    }
    if !has_value || raw.bytes.is_null() {
        return Ok(None);
    }
    let mask = take_raw(&mut raw);
    Ok(Some(InstanceMask {
        mask,
        instance_count,
    }))
}

/// Generate a dedicated `VNInstanceMaskObservation` wrapper for the image at
/// `path`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn generate_foreground_instance_mask_observation_in_path(
    path: impl AsRef<Path>,
) -> Result<Option<InstanceMaskObservation>, VisionError> {
    generate_foreground_instance_mask_in_path(path)
        .map(|mask| mask.map(InstanceMaskObservation::from))
}

fn take_raw(raw: &mut ffi::SegmentationMaskRaw) -> SegmentationMask {
    let len = raw.height.saturating_mul(raw.bytes_per_row);
    // SAFETY: `raw.bytes` is valid for `len` bytes as guaranteed by the Swift bridge.
    let slice = unsafe { core::slice::from_raw_parts(raw.bytes.cast::<u8>(), len) };
    let bytes = slice.to_vec();
    // SAFETY: the pointer/count pair was allocated by the bridge and is freed exactly once here.
    unsafe { ffi::vn_segmentation_mask_free(raw) };
    SegmentationMask {
        width: raw.width,
        height: raw.height,
        bytes_per_row: raw.bytes_per_row,
        bytes,
    }
}
