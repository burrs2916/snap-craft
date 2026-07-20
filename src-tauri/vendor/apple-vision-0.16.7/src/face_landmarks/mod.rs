//! [`detect_face_landmarks_in_path`] — wraps `VNDetectFaceLandmarksRequest`.
//!
//! Returns each face's bounding box, optional roll/yaw/pitch, and the
//! detected landmark regions (eyes, eyebrows, nose, lips, pupils, …).
//! Each region is exposed as a list of normalised `(x, y)` points in
//! Vision's bottom-left coordinate system.

use core::ffi::c_char;
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::ffi;
use crate::recognize_text::BoundingBox;
use crate::request_base::{ImageBasedRequest, RequestRevisionProviding};
use crate::sdk::PointsClassification;

/// A 2-D point in Vision's normalised image space (`0.0..=1.0`,
/// bottom-left origin).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LandmarkPoint {
    pub x: f64,
    pub y: f64,
}

/// Mirrors `VNRequestFaceLandmarksConstellation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(usize)]
pub enum RequestFaceLandmarksConstellation {
    NotDefined = 0,
    Points65 = 1,
    Points76 = 2,
}

impl RequestFaceLandmarksConstellation {
    pub const ALL: &'static [Self] = &[Self::NotDefined, Self::Points65, Self::Points76];

    #[must_use]
    pub const fn as_raw(self) -> usize {
        self as usize
    }
}

/// Base `VNFaceLandmarkRegion` wrapper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaceLandmarkRegion {
    pub point_count: usize,
    pub request_revision: Option<usize>,
}

impl RequestRevisionProviding for FaceLandmarkRegion {
    fn request_revision(&self) -> Option<usize> {
        self.request_revision
    }
}

/// Dedicated `VNFaceLandmarkRegion2D` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct FaceLandmarkRegion2D {
    pub region: FaceLandmarkRegion,
    pub normalized_points: Vec<LandmarkPoint>,
    pub precision_estimates_per_point: Vec<f32>,
    pub points_classification: Option<PointsClassification>,
}

impl FaceLandmarkRegion2D {
    #[must_use]
    pub fn points_in_image_of_size(&self, image_size: (f64, f64)) -> Vec<LandmarkPoint> {
        self.normalized_points
            .iter()
            .map(|point| LandmarkPoint {
                x: point.x * image_size.0,
                y: point.y * image_size.1,
            })
            .collect()
    }
}

/// Base `VNFaceLandmarks` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct FaceLandmarks {
    pub confidence: f32,
    pub request_revision: Option<usize>,
}

impl RequestRevisionProviding for FaceLandmarks {
    fn request_revision(&self) -> Option<usize> {
        self.request_revision
    }
}

/// Dedicated `VNFaceLandmarks2D` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct FaceLandmarks2D {
    pub landmarks: FaceLandmarks,
    pub all_points: Option<FaceLandmarkRegion2D>,
    pub face_contour: Option<FaceLandmarkRegion2D>,
    pub left_eye: Option<FaceLandmarkRegion2D>,
    pub right_eye: Option<FaceLandmarkRegion2D>,
    pub left_eyebrow: Option<FaceLandmarkRegion2D>,
    pub right_eyebrow: Option<FaceLandmarkRegion2D>,
    pub nose: Option<FaceLandmarkRegion2D>,
    pub nose_crest: Option<FaceLandmarkRegion2D>,
    pub median_line: Option<FaceLandmarkRegion2D>,
    pub outer_lips: Option<FaceLandmarkRegion2D>,
    pub inner_lips: Option<FaceLandmarkRegion2D>,
    pub left_pupil: Option<FaceLandmarkRegion2D>,
    pub right_pupil: Option<FaceLandmarkRegion2D>,
}

/// Rust mirror of `VNFaceObservationAccepting`.
pub trait FaceObservationAccepting {
    fn input_face_observations(&self) -> &[BoundingBox];
}

/// Builder mirroring `VNDetectFaceLandmarksRequest`'s extra public surface.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FaceLandmarksRequest {
    image_based_request: ImageBasedRequest,
    constellation: Option<RequestFaceLandmarksConstellation>,
    input_face_observations: Vec<BoundingBox>,
}

impl FaceLandmarksRequest {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            image_based_request: ImageBasedRequest::new(),
            constellation: None,
            input_face_observations: Vec::new(),
        }
    }

    #[must_use]
    pub const fn with_image_based_request(
        mut self,
        image_based_request: ImageBasedRequest,
    ) -> Self {
        self.image_based_request = image_based_request;
        self
    }

    #[must_use]
    pub const fn with_constellation(
        mut self,
        constellation: RequestFaceLandmarksConstellation,
    ) -> Self {
        self.constellation = Some(constellation);
        self
    }

    #[must_use]
    pub fn with_input_face_observations(
        mut self,
        input_face_observations: Vec<BoundingBox>,
    ) -> Self {
        self.input_face_observations = input_face_observations;
        self
    }

    #[must_use]
    pub const fn image_based_request(&self) -> &ImageBasedRequest {
        &self.image_based_request
    }

    #[must_use]
    pub const fn constellation(&self) -> Option<RequestFaceLandmarksConstellation> {
        self.constellation
    }

    #[must_use]
    pub const fn supports_constellation(
        request_revision: usize,
        constellation: RequestFaceLandmarksConstellation,
    ) -> bool {
        matches!(
            (request_revision, constellation),
            (_, RequestFaceLandmarksConstellation::NotDefined)
                | (1 | 2, RequestFaceLandmarksConstellation::Points65)
                | (
                    3,
                    RequestFaceLandmarksConstellation::Points65
                        | RequestFaceLandmarksConstellation::Points76,
                )
        )
    }
}

impl FaceObservationAccepting for FaceLandmarksRequest {
    fn input_face_observations(&self) -> &[BoundingBox] {
        &self.input_face_observations
    }
}

impl RequestRevisionProviding for FaceLandmarksRequest {
    fn request_revision(&self) -> Option<usize> {
        self.image_based_request.revision()
    }
}

/// One face plus its detected landmarks. Any region with no points
/// detected is returned as an empty `Vec`.
#[derive(Debug, Clone, PartialEq)]
pub struct FaceWithLandmarks {
    pub bounding_box: BoundingBox,
    pub confidence: f32,
    pub roll: Option<f32>,
    pub yaw: Option<f32>,
    pub pitch: Option<f32>,
    pub face_contour: Vec<LandmarkPoint>,
    pub left_eye: Vec<LandmarkPoint>,
    pub right_eye: Vec<LandmarkPoint>,
    pub left_eyebrow: Vec<LandmarkPoint>,
    pub right_eyebrow: Vec<LandmarkPoint>,
    pub nose: Vec<LandmarkPoint>,
    pub nose_crest: Vec<LandmarkPoint>,
    pub median_line: Vec<LandmarkPoint>,
    pub outer_lips: Vec<LandmarkPoint>,
    pub inner_lips: Vec<LandmarkPoint>,
    pub left_pupil: Vec<LandmarkPoint>,
    pub right_pupil: Vec<LandmarkPoint>,
}

impl FaceWithLandmarks {
    #[must_use]
    pub fn landmarks_2d(&self) -> FaceLandmarks2D {
        let all_points = [
            &self.face_contour,
            &self.left_eye,
            &self.right_eye,
            &self.left_eyebrow,
            &self.right_eyebrow,
            &self.nose,
            &self.nose_crest,
            &self.median_line,
            &self.outer_lips,
            &self.inner_lips,
            &self.left_pupil,
            &self.right_pupil,
        ]
        .into_iter()
        .flat_map(|region| region.iter().copied())
        .collect::<Vec<_>>();

        FaceLandmarks2D {
            landmarks: FaceLandmarks {
                confidence: self.confidence,
                request_revision: None,
            },
            all_points: region_from_points(&all_points),
            face_contour: region_from_points(&self.face_contour),
            left_eye: region_from_points(&self.left_eye),
            right_eye: region_from_points(&self.right_eye),
            left_eyebrow: region_from_points(&self.left_eyebrow),
            right_eyebrow: region_from_points(&self.right_eyebrow),
            nose: region_from_points(&self.nose),
            nose_crest: region_from_points(&self.nose_crest),
            median_line: region_from_points(&self.median_line),
            outer_lips: region_from_points(&self.outer_lips),
            inner_lips: region_from_points(&self.inner_lips),
            left_pupil: region_from_points(&self.left_pupil),
            right_pupil: region_from_points(&self.right_pupil),
        }
    }
}

/// Copy a bridge-allocated landmark buffer into Rust-owned points.
///
/// # Safety
///
/// `ptr` must be either null or valid for `n * 2` consecutive `f64` values
/// arranged as `(x, y)` pairs for the duration of this call.
unsafe fn copy_region(ptr: *mut f64, n: usize) -> Vec<LandmarkPoint> {
    if ptr.is_null() || n == 0 {
        return Vec::new();
    }
    let mut v = Vec::with_capacity(n);
    for i in 0..n {
        // SAFETY: the point buffer is valid for the reported coordinates; this index is in bounds.
        let x = unsafe { *ptr.add(i * 2) };
        // SAFETY: the point buffer is valid for the reported coordinates; this index is in bounds.
        let y = unsafe { *ptr.add(i * 2 + 1) };
        v.push(LandmarkPoint { x, y });
    }
    v
}

fn region_from_points(points: &[LandmarkPoint]) -> Option<FaceLandmarkRegion2D> {
    if points.is_empty() {
        None
    } else {
        Some(FaceLandmarkRegion2D {
            region: FaceLandmarkRegion {
                point_count: points.len(),
                request_revision: None,
            },
            normalized_points: points.to_vec(),
            precision_estimates_per_point: Vec::new(),
            points_classification: None,
        })
    }
}

/// Detect faces and their landmark regions in the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] or
/// [`VisionError::RequestFailed`] on Apple-side failures.
pub fn detect_face_landmarks_in_path(
    path: impl AsRef<Path>,
) -> Result<Vec<FaceWithLandmarks>, VisionError> {
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
        ffi::vn_detect_face_landmarks_in_path(
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
    let typed = out_array.cast::<ffi::FaceLandmarksRaw>();
    let mut faces = Vec::with_capacity(out_count);
    for i in 0..out_count {
        // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
        let raw = unsafe { &*typed.add(i) };
        faces.push(FaceWithLandmarks {
            bounding_box: BoundingBox {
                x: raw.bbox_x,
                y: raw.bbox_y,
                width: raw.bbox_w,
                height: raw.bbox_h,
            },
            confidence: raw.confidence,
            roll: if raw.roll.is_nan() {
                None
            } else {
                Some(raw.roll)
            },
            yaw: if raw.yaw.is_nan() {
                None
            } else {
                Some(raw.yaw)
            },
            pitch: if raw.pitch.is_nan() {
                None
            } else {
                Some(raw.pitch)
            },
            // SAFETY: the region pointer/count pair comes from the current bridge row and is valid for the reported length.
            face_contour: unsafe { copy_region(raw.face_contour, raw.face_contour_count) },
            // SAFETY: the region pointer/count pair comes from the current bridge row and is valid for the reported length.
            left_eye: unsafe { copy_region(raw.left_eye, raw.left_eye_count) },
            // SAFETY: the region pointer/count pair comes from the current bridge row and is valid for the reported length.
            right_eye: unsafe { copy_region(raw.right_eye, raw.right_eye_count) },
            // SAFETY: the region pointer/count pair comes from the current bridge row and is valid for the reported length.
            left_eyebrow: unsafe { copy_region(raw.left_eyebrow, raw.left_eyebrow_count) },
            // SAFETY: the region pointer/count pair comes from the current bridge row and is valid for the reported length.
            right_eyebrow: unsafe { copy_region(raw.right_eyebrow, raw.right_eyebrow_count) },
            // SAFETY: the region pointer/count pair comes from the current bridge row and is valid for the reported length.
            nose: unsafe { copy_region(raw.nose, raw.nose_count) },
            // SAFETY: the region pointer/count pair comes from the current bridge row and is valid for the reported length.
            nose_crest: unsafe { copy_region(raw.nose_crest, raw.nose_crest_count) },
            // SAFETY: the region pointer/count pair comes from the current bridge row and is valid for the reported length.
            median_line: unsafe { copy_region(raw.median_line, raw.median_line_count) },
            // SAFETY: the region pointer/count pair comes from the current bridge row and is valid for the reported length.
            outer_lips: unsafe { copy_region(raw.outer_lips, raw.outer_lips_count) },
            // SAFETY: the region pointer/count pair comes from the current bridge row and is valid for the reported length.
            inner_lips: unsafe { copy_region(raw.inner_lips, raw.inner_lips_count) },
            // SAFETY: the region pointer/count pair comes from the current bridge row and is valid for the reported length.
            left_pupil: unsafe { copy_region(raw.left_pupil, raw.left_pupil_count) },
            // SAFETY: the region pointer/count pair comes from the current bridge row and is valid for the reported length.
            right_pupil: unsafe { copy_region(raw.right_pupil, raw.right_pupil_count) },
        });
    }
    // SAFETY: the pointer/count pair was allocated by the bridge and is freed exactly once here.
    unsafe { ffi::vn_face_landmarks_free(out_array, out_count) };
    Ok(faces)
}
