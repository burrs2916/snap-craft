#![allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
#![allow(clippy::too_long_first_doc_paragraph)]
//! Stateful Vision tracking requests backed by retained Swift sessions.
//!
//! These wrappers keep the underlying Vision request alive across frames,
//! which is required for object / rectangle tracking and the sequence-based
//! optical-flow and image-registration trackers.

use core::ffi::{c_char, c_void};
use core::ptr;
use std::ffi::{CStr, CString};
use std::path::Path;

use crate::error::VisionError;
use crate::face_landmarks::LandmarkPoint;
use crate::ffi;
use crate::optical_flow::OpticalFlowAccuracy;
use crate::recognize_text::BoundingBox;
use crate::rectangles::RectangleObservation;
use crate::registration::{HomographicAlignment, TranslationalAlignment};

/// Public alias for `VNTrackOpticalFlowRequest.ComputationAccuracy`.
pub type TrackOpticalFlowRequestComputationAccuracy = OpticalFlowAccuracy;

/// Raw optical-flow pixel buffer copied out of Vision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpticalFlowFrame {
    pub width: usize,
    pub height: usize,
    pub bytes_per_row: usize,
    pub bytes: Vec<u8>,
}

impl OpticalFlowFrame {
    /// Borrow the copied raw pixel-buffer bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// Tracks a detected object's bounding box across a sequence of frames.
pub struct ObjectTracker {
    handle: *mut c_void,
}

/// Tracks a known rectangle observation across a sequence of frames.
pub struct RectangleTracker {
    handle: *mut c_void,
}

/// Tracks dense optical flow across a frame sequence.
pub struct OpticalFlowTracker {
    handle: *mut c_void,
}

/// Tracks translational image registration across frames.
pub struct TranslationalImageTracker {
    handle: *mut c_void,
}

/// Tracks homographic image registration across frames.
pub struct HomographicImageTracker {
    handle: *mut c_void,
}

impl ObjectTracker {
    /// Create a new object tracker seeded from `image_path` and `bbox`.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError`] if the image path is invalid, the image
    /// fails to load, or Vision rejects the tracking request.
    pub fn new(image_path: impl AsRef<Path>, bbox: BoundingBox) -> Result<Self, VisionError> {
        let image_c = path_to_cstring(image_path.as_ref(), "image path")?;
        let mut raw_bbox = ffi::SimpleRectRaw {
            x: bbox.x,
            y: bbox.y,
            w: bbox.width,
            h: bbox.height,
            confidence: 1.0,
            _pad: 0.0,
        };
        let mut handle: *mut c_void = ptr::null_mut();
        let mut err: *mut c_char = ptr::null_mut();
        // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_object_tracker_create(
                image_c.as_ptr(),
                ptr::addr_of_mut!(raw_bbox).cast(),
                &mut handle,
                &mut err,
            )
        };
        if status != ffi::status::OK {
            return Err(error_from_status(status, err));
        }
        ensure_handle(handle, "object tracker")?;
        Ok(Self { handle })
    }

    /// Track the object into `image_path` and return the updated bounding
    /// box.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError`] if the image path is invalid, the image
    /// fails to load, or Vision rejects the tracking request.
    pub fn track(&mut self, image_path: impl AsRef<Path>) -> Result<BoundingBox, VisionError> {
        let image_c = path_to_cstring(image_path.as_ref(), "image path")?;
        let mut raw_bbox = ffi::SimpleRectRaw {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
            confidence: 0.0,
            _pad: 0.0,
        };
        let mut err: *mut c_char = ptr::null_mut();
        // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_object_tracker_track(
                self.handle,
                image_c.as_ptr(),
                ptr::addr_of_mut!(raw_bbox).cast(),
                &mut err,
            )
        };
        if status != ffi::status::OK {
            return Err(error_from_status(status, err));
        }
        Ok(BoundingBox {
            x: raw_bbox.x,
            y: raw_bbox.y,
            width: raw_bbox.w,
            height: raw_bbox.h,
        })
    }
}

impl RectangleTracker {
    /// Create a new rectangle tracker seeded from `image_path` and the
    /// known rectangle observation for that frame.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError`] if the image path is invalid, the image
    /// fails to load, or Vision rejects the tracking request.
    pub fn new(
        image_path: impl AsRef<Path>,
        rect_observation: &RectangleObservation,
    ) -> Result<Self, VisionError> {
        let image_c = path_to_cstring(image_path.as_ref(), "image path")?;
        let mut raw = rectangle_to_raw(rect_observation);
        let mut handle: *mut c_void = ptr::null_mut();
        let mut err: *mut c_char = ptr::null_mut();
        // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_rectangle_tracker_create(
                image_c.as_ptr(),
                ptr::addr_of_mut!(raw).cast(),
                &mut handle,
                &mut err,
            )
        };
        if status != ffi::status::OK {
            return Err(error_from_status(status, err));
        }
        ensure_handle(handle, "rectangle tracker")?;
        Ok(Self { handle })
    }

    /// Track the rectangle into `image_path` and return the updated
    /// rectangle observation.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError`] if the image path is invalid, the image
    /// fails to load, or Vision rejects the tracking request.
    pub fn track(
        &mut self,
        image_path: impl AsRef<Path>,
    ) -> Result<RectangleObservation, VisionError> {
        let image_c = path_to_cstring(image_path.as_ref(), "image path")?;
        let mut raw = ffi::RectangleObservationRaw {
            bbox_x: 0.0,
            bbox_y: 0.0,
            bbox_w: 0.0,
            bbox_h: 0.0,
            confidence: 0.0,
            tl_x: 0.0,
            tl_y: 0.0,
            tr_x: 0.0,
            tr_y: 0.0,
            bl_x: 0.0,
            bl_y: 0.0,
            br_x: 0.0,
            br_y: 0.0,
        };
        let mut err: *mut c_char = ptr::null_mut();
        // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_rectangle_tracker_track(
                self.handle,
                image_c.as_ptr(),
                ptr::addr_of_mut!(raw).cast(),
                &mut err,
            )
        };
        if status != ffi::status::OK {
            return Err(error_from_status(status, err));
        }
        Ok(rectangle_from_raw(&raw))
    }
}

impl OpticalFlowTracker {
    /// The computation-accuracy values exposed by `VNTrackOpticalFlowRequest`.
    #[must_use]
    pub const fn supported_computation_accuracies(
    ) -> &'static [TrackOpticalFlowRequestComputationAccuracy] {
        &[
            TrackOpticalFlowRequestComputationAccuracy::Low,
            TrackOpticalFlowRequestComputationAccuracy::Medium,
            TrackOpticalFlowRequestComputationAccuracy::High,
            TrackOpticalFlowRequestComputationAccuracy::VeryHigh,
        ]
    }

    /// Create a new optical-flow tracker seeded with the reference image.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError`] if the image path is invalid, the image
    /// fails to load, or Vision rejects the tracking request.
    pub fn new(reference_path: impl AsRef<Path>) -> Result<Self, VisionError> {
        let image_c = path_to_cstring(reference_path.as_ref(), "reference path")?;
        let mut handle: *mut c_void = ptr::null_mut();
        let mut err: *mut c_char = ptr::null_mut();
        let status =
            // SAFETY: all pointer arguments are valid stack locations or null-initialised out-params; strings are valid C strings for the duration of the call.
            unsafe { ffi::vn_optical_flow_tracker_create(image_c.as_ptr(), &mut handle, &mut err) };
        if status != ffi::status::OK {
            return Err(error_from_status(status, err));
        }
        ensure_handle(handle, "optical-flow tracker")?;
        Ok(Self { handle })
    }

    /// Track optical flow into `image_path` and return the copied raw
    /// pixel-buffer bytes.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError`] if the image path is invalid, the image
    /// fails to load, or Vision rejects the tracking request.
    pub fn track(&mut self, image_path: impl AsRef<Path>) -> Result<OpticalFlowFrame, VisionError> {
        let image_c = path_to_cstring(image_path.as_ref(), "image path")?;
        let mut raw = ffi::SegmentationMaskRaw {
            width: 0,
            height: 0,
            bytes_per_row: 0,
            bytes: ptr::null_mut(),
        };
        let mut err: *mut c_char = ptr::null_mut();
        // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_optical_flow_tracker_track(
                self.handle,
                image_c.as_ptr(),
                ptr::addr_of_mut!(raw).cast(),
                &mut err,
            )
        };
        if status != ffi::status::OK {
            return Err(error_from_status(status, err));
        }
        let frame = copy_mask(&raw);
        // SAFETY: `raw` was populated by the bridge and has not been freed yet; unique free site.
        unsafe { ffi::vn_segmentation_mask_free(ptr::addr_of_mut!(raw).cast()) };
        Ok(frame)
    }
}

impl TranslationalImageTracker {
    /// Create a new translational-registration tracker seeded with the
    /// reference image.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError`] if the image path is invalid, the image
    /// fails to load, or Vision rejects the tracking request.
    pub fn new(reference_path: impl AsRef<Path>) -> Result<Self, VisionError> {
        let image_c = path_to_cstring(reference_path.as_ref(), "reference path")?;
        let mut handle: *mut c_void = ptr::null_mut();
        let mut err: *mut c_char = ptr::null_mut();
        // SAFETY: all pointer arguments are valid stack locations or null-initialised out-params; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_translational_image_tracker_create(image_c.as_ptr(), &mut handle, &mut err)
        };
        if status != ffi::status::OK {
            return Err(error_from_status(status, err));
        }
        ensure_handle(handle, "translational tracker")?;
        Ok(Self { handle })
    }

    /// Track the translational alignment into `image_path`.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError`] if the image path is invalid, the image
    /// fails to load, or Vision rejects the tracking request.
    pub fn track(
        &mut self,
        image_path: impl AsRef<Path>,
    ) -> Result<TranslationalAlignment, VisionError> {
        let image_c = path_to_cstring(image_path.as_ref(), "image path")?;
        let mut raw = ffi::TranslationalAlignmentRaw { tx: 0.0, ty: 0.0 };
        let mut err: *mut c_char = ptr::null_mut();
        // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_translational_image_tracker_track(
                self.handle,
                image_c.as_ptr(),
                ptr::addr_of_mut!(raw).cast(),
                &mut err,
            )
        };
        if status != ffi::status::OK {
            return Err(error_from_status(status, err));
        }
        Ok(TranslationalAlignment {
            tx: raw.tx,
            ty: raw.ty,
        })
    }
}

impl HomographicImageTracker {
    /// Create a new homographic-registration tracker seeded with the
    /// reference image.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError`] if the image path is invalid, the image
    /// fails to load, or Vision rejects the tracking request.
    pub fn new(reference_path: impl AsRef<Path>) -> Result<Self, VisionError> {
        let image_c = path_to_cstring(reference_path.as_ref(), "reference path")?;
        let mut handle: *mut c_void = ptr::null_mut();
        let mut err: *mut c_char = ptr::null_mut();
        // SAFETY: all pointer arguments are valid stack locations or null-initialised out-params; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_homographic_image_tracker_create(image_c.as_ptr(), &mut handle, &mut err)
        };
        if status != ffi::status::OK {
            return Err(error_from_status(status, err));
        }
        ensure_handle(handle, "homographic tracker")?;
        Ok(Self { handle })
    }

    /// Track the homographic alignment into `image_path`.
    ///
    /// # Errors
    ///
    /// Returns [`VisionError`] if the image path is invalid, the image
    /// fails to load, or Vision rejects the tracking request.
    pub fn track(
        &mut self,
        image_path: impl AsRef<Path>,
    ) -> Result<HomographicAlignment, VisionError> {
        let image_c = path_to_cstring(image_path.as_ref(), "image path")?;
        let mut raw = ffi::HomographicAlignmentRaw {
            m00: 0.0,
            m01: 0.0,
            m02: 0.0,
            m10: 0.0,
            m11: 0.0,
            m12: 0.0,
            m20: 0.0,
            m21: 0.0,
            m22: 0.0,
            _pad: 0.0,
        };
        let mut err: *mut c_char = ptr::null_mut();
        // SAFETY: all pointer arguments are valid stack locations or bridge-owned handles; strings are valid C strings for the duration of the call.
        let status = unsafe {
            ffi::vn_homographic_image_tracker_track(
                self.handle,
                image_c.as_ptr(),
                ptr::addr_of_mut!(raw).cast(),
                &mut err,
            )
        };
        if status != ffi::status::OK {
            return Err(error_from_status(status, err));
        }
        Ok(HomographicAlignment {
            matrix: [
                [raw.m00, raw.m01, raw.m02],
                [raw.m10, raw.m11, raw.m12],
                [raw.m20, raw.m21, raw.m22],
            ],
        })
    }
}

macro_rules! impl_tracker_drop {
    ($tracker:ident, $release:path) => {
        impl Drop for $tracker {
            fn drop(&mut self) {
                if !self.handle.is_null() {
                    // SAFETY: `self.handle` is a live bridge-owned handle and this drop path releases it exactly once.
                    unsafe { $release(self.handle) };
                    self.handle = ptr::null_mut();
                }
            }
        }
    };
}

impl_tracker_drop!(ObjectTracker, ffi::vn_object_tracker_release);
impl_tracker_drop!(RectangleTracker, ffi::vn_rectangle_tracker_release);
impl_tracker_drop!(OpticalFlowTracker, ffi::vn_optical_flow_tracker_release);
impl_tracker_drop!(
    TranslationalImageTracker,
    ffi::vn_translational_image_tracker_release
);
impl_tracker_drop!(
    HomographicImageTracker,
    ffi::vn_homographic_image_tracker_release
);

fn path_to_cstring(path: &Path, label: &str) -> Result<CString, VisionError> {
    let path_str = path
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument(format!("non-UTF-8 {label}")))?;
    CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("{label} NUL byte: {e}")))
}

const fn rectangle_to_raw(rect: &RectangleObservation) -> ffi::RectangleObservationRaw {
    ffi::RectangleObservationRaw {
        bbox_x: rect.bounding_box.x,
        bbox_y: rect.bounding_box.y,
        bbox_w: rect.bounding_box.width,
        bbox_h: rect.bounding_box.height,
        confidence: rect.confidence,
        tl_x: rect.top_left.x,
        tl_y: rect.top_left.y,
        tr_x: rect.top_right.x,
        tr_y: rect.top_right.y,
        bl_x: rect.bottom_left.x,
        bl_y: rect.bottom_left.y,
        br_x: rect.bottom_right.x,
        br_y: rect.bottom_right.y,
    }
}

const fn rectangle_from_raw(raw: &ffi::RectangleObservationRaw) -> RectangleObservation {
    RectangleObservation {
        bounding_box: BoundingBox {
            x: raw.bbox_x,
            y: raw.bbox_y,
            width: raw.bbox_w,
            height: raw.bbox_h,
        },
        confidence: raw.confidence,
        top_left: LandmarkPoint {
            x: raw.tl_x,
            y: raw.tl_y,
        },
        top_right: LandmarkPoint {
            x: raw.tr_x,
            y: raw.tr_y,
        },
        bottom_left: LandmarkPoint {
            x: raw.bl_x,
            y: raw.bl_y,
        },
        bottom_right: LandmarkPoint {
            x: raw.br_x,
            y: raw.br_y,
        },
    }
}

fn copy_mask(raw: &ffi::SegmentationMaskRaw) -> OpticalFlowFrame {
    if raw.bytes.is_null() {
        return OpticalFlowFrame {
            width: raw.width,
            height: raw.height,
            bytes_per_row: raw.bytes_per_row,
            bytes: Vec::new(),
        };
    }
    let len = raw.height.saturating_mul(raw.bytes_per_row);
    // SAFETY: `raw.bytes` is valid for `len` bytes as guaranteed by the Swift bridge.
    let bytes = unsafe { core::slice::from_raw_parts(raw.bytes.cast::<u8>(), len) }.to_vec();
    OpticalFlowFrame {
        width: raw.width,
        height: raw.height,
        bytes_per_row: raw.bytes_per_row,
        bytes,
    }
}

fn ensure_handle(handle: *mut c_void, tracker_name: &str) -> Result<(), VisionError> {
    if handle.is_null() {
        return Err(VisionError::Unknown {
            code: ffi::status::UNKNOWN,
            message: format!("{tracker_name} returned a null handle"),
        });
    }
    Ok(())
}

fn error_from_status(status: i32, err: *mut c_char) -> VisionError {
    // SAFETY: the error pointer is either null or a bridge-allocated C string; `take_err` copies and frees it.
    let message = unsafe { take_err(err) };
    match status {
        ffi::status::IMAGE_LOAD_FAILED => VisionError::ImageLoadFailed(message),
        ffi::status::REQUEST_FAILED => VisionError::RequestFailed(message),
        ffi::status::INVALID_ARGUMENT => VisionError::InvalidArgument(message),
        code => VisionError::Unknown { code, message },
    }
}

/// Extract an error string from a bridge-allocated C string and free it.
///
/// # Safety
///
/// `p` must be either null or a valid null-terminated C string heap-allocated
/// (via `malloc`) by the Swift bridge. After this call `p` is invalid.
unsafe fn take_err(p: *mut c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    // SAFETY: the C string pointer is non-null (checked above) and valid for the duration of this borrow.
    let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    // SAFETY: `p` was malloc-allocated by the bridge and has not been freed yet.
    unsafe { libc::free(p.cast()) };
    s
}
