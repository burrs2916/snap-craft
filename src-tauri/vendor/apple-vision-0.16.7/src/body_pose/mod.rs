//! Human body pose detection (`VNDetectHumanBodyPoseRequest`).

use core::ffi::c_char;
use core::ptr;
use std::collections::HashMap;
use std::ffi::CString;
use std::path::Path;

use crate::error::{from_swift, VisionError};
use crate::ffi;
use crate::recognize_text::BoundingBox;
use crate::recognized_points::{
    RecognizedPoint, RecognizedPointsObservation, VisionRecognizedPoint,
};
use crate::request_base::NormalizedRect;

macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $( $variant:ident => $value:literal ),+ $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name {
            $( $variant ),+
        }

        impl $name {
            pub const ALL: &'static [Self] = &[
                $( Self::$variant ),+
            ];

            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $( Self::$variant => $value ),+
                }
            }

            #[allow(clippy::should_implement_trait)]
            #[must_use]
            pub fn from_str(value: &str) -> Option<Self> {
                match value {
                    $( $value => Some(Self::$variant), )+
                    _ => None,
                }
            }
        }
    };
}

string_enum! {
    /// Mirrors `VNHumanBodyPoseObservationJointName`.
    pub enum HumanBodyPoseJointName {
        Nose => "head_joint",
        LeftEye => "left_eye_joint",
        RightEye => "right_eye_joint",
        LeftEar => "left_ear_joint",
        RightEar => "right_ear_joint",
        LeftShoulder => "left_shoulder_1_joint",
        RightShoulder => "right_shoulder_1_joint",
        Neck => "neck_1_joint",
        LeftElbow => "left_forearm_joint",
        RightElbow => "right_forearm_joint",
        LeftWrist => "left_hand_joint",
        RightWrist => "right_hand_joint",
        LeftHip => "left_upLeg_joint",
        RightHip => "right_upLeg_joint",
        Root => "root",
        LeftKnee => "left_leg_joint",
        RightKnee => "right_leg_joint",
        LeftAnkle => "left_foot_joint",
        RightAnkle => "right_foot_joint",
    }
}

string_enum! {
    /// Mirrors `VNHumanBodyPoseObservationJointsGroupName`.
    pub enum HumanBodyPoseJointGroupName {
        Face => "VNBLKFACE",
        Torso => "VNBLKTORSO",
        LeftArm => "VNBLKLARM",
        RightArm => "VNBLKRARM",
        LeftLeg => "VNBLKLLEG",
        RightLeg => "VNBLKRLEG",
        All => "VNIPOAll",
    }
}

/// A single detected joint in normalised image coordinates
/// (`0.0..=1.0`, bottom-left origin).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JointPoint {
    pub x: f64,
    pub y: f64,
    pub confidence: f32,
}

/// One detected human body with its recognised joints.
///
/// `joints` keys use Apple's `VNHumanBodyPoseObservationJointName` raw values.
#[derive(Debug, Clone, PartialEq)]
pub struct DetectedBodyPose {
    pub bounding_box: BoundingBox,
    pub confidence: f32,
    pub joints: HashMap<String, JointPoint>,
}

/// A dedicated `VNHumanBodyPoseObservation` wrapper built on top of the generic
/// `VNRecognizedPointsObservation` surface.
#[derive(Debug, Clone, PartialEq)]
pub struct HumanBodyPoseObservation {
    pub recognized_points: RecognizedPointsObservation,
    pub available_joint_names: Vec<String>,
    pub available_joint_group_names: Vec<String>,
}

const SUPPORTED_JOINT_NAMES: &[&str] = &[
    HumanBodyPoseJointName::Nose.as_str(),
    HumanBodyPoseJointName::LeftEye.as_str(),
    HumanBodyPoseJointName::RightEye.as_str(),
    HumanBodyPoseJointName::LeftEar.as_str(),
    HumanBodyPoseJointName::RightEar.as_str(),
    HumanBodyPoseJointName::LeftShoulder.as_str(),
    HumanBodyPoseJointName::RightShoulder.as_str(),
    HumanBodyPoseJointName::Neck.as_str(),
    HumanBodyPoseJointName::LeftElbow.as_str(),
    HumanBodyPoseJointName::RightElbow.as_str(),
    HumanBodyPoseJointName::LeftWrist.as_str(),
    HumanBodyPoseJointName::RightWrist.as_str(),
    HumanBodyPoseJointName::LeftHip.as_str(),
    HumanBodyPoseJointName::RightHip.as_str(),
    HumanBodyPoseJointName::Root.as_str(),
    HumanBodyPoseJointName::LeftKnee.as_str(),
    HumanBodyPoseJointName::RightKnee.as_str(),
    HumanBodyPoseJointName::LeftAnkle.as_str(),
    HumanBodyPoseJointName::RightAnkle.as_str(),
];

const SUPPORTED_JOINT_GROUP_NAMES: &[&str] = &[
    HumanBodyPoseJointGroupName::Face.as_str(),
    HumanBodyPoseJointGroupName::Torso.as_str(),
    HumanBodyPoseJointGroupName::LeftArm.as_str(),
    HumanBodyPoseJointGroupName::RightArm.as_str(),
    HumanBodyPoseJointGroupName::LeftLeg.as_str(),
    HumanBodyPoseJointGroupName::RightLeg.as_str(),
    HumanBodyPoseJointGroupName::All.as_str(),
];

impl HumanBodyPoseObservation {
    #[must_use]
    pub const fn supported_joint_name_keys() -> &'static [HumanBodyPoseJointName] {
        HumanBodyPoseJointName::ALL
    }

    #[must_use]
    pub const fn supported_joint_names() -> &'static [&'static str] {
        SUPPORTED_JOINT_NAMES
    }

    #[must_use]
    pub const fn supported_joint_group_name_keys() -> &'static [HumanBodyPoseJointGroupName] {
        HumanBodyPoseJointGroupName::ALL
    }

    #[must_use]
    pub const fn supported_joint_group_names() -> &'static [&'static str] {
        SUPPORTED_JOINT_GROUP_NAMES
    }

    #[must_use]
    pub fn recognized_point(
        &self,
        joint_name: HumanBodyPoseJointName,
    ) -> Option<VisionRecognizedPoint> {
        self.recognized_points.recognized_point(joint_name.as_str())
    }

    #[must_use]
    pub fn into_detected_body_pose(self) -> DetectedBodyPose {
        self.into()
    }
}

impl From<DetectedBodyPose> for HumanBodyPoseObservation {
    fn from(value: DetectedBodyPose) -> Self {
        let mut available_joint_names = value.joints.keys().cloned().collect::<Vec<_>>();
        available_joint_names.sort();
        Self {
            recognized_points: RecognizedPointsObservation {
                bounding_box: NormalizedRect::new(
                    value.bounding_box.x,
                    value.bounding_box.y,
                    value.bounding_box.width,
                    value.bounding_box.height,
                ),
                confidence: value.confidence,
                available_keys: available_joint_names.clone(),
                available_group_keys: Self::supported_joint_group_names()
                    .iter()
                    .map(|name| (*name).to_string())
                    .collect(),
                points: value
                    .joints
                    .iter()
                    .map(|(name, point)| {
                        (
                            name.clone(),
                            RecognizedPoint {
                                x: point.x,
                                y: point.y,
                                confidence: point.confidence,
                            },
                        )
                    })
                    .collect(),
            },
            available_joint_names,
            available_joint_group_names: Self::supported_joint_group_names()
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
        }
    }
}

impl From<HumanBodyPoseObservation> for DetectedBodyPose {
    fn from(value: HumanBodyPoseObservation) -> Self {
        Self {
            bounding_box: BoundingBox {
                x: value.recognized_points.bounding_box.x,
                y: value.recognized_points.bounding_box.y,
                width: value.recognized_points.bounding_box.width,
                height: value.recognized_points.bounding_box.height,
            },
            confidence: value.recognized_points.confidence,
            joints: value
                .recognized_points
                .points
                .into_iter()
                .map(|(name, point)| {
                    (
                        name,
                        JointPoint {
                            x: point.x,
                            y: point.y,
                            confidence: point.confidence,
                        },
                    )
                })
                .collect(),
        }
    }
}

/// Detect human body-pose observations in the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn detect_human_body_pose_observations_in_path(
    path: impl AsRef<Path>,
) -> Result<Vec<HumanBodyPoseObservation>, VisionError> {
    detect_human_body_pose_in_path(path).map(|poses| poses.into_iter().map(Into::into).collect())
}

/// Detect human body poses in the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn detect_human_body_pose_in_path(
    path: impl AsRef<Path>,
) -> Result<Vec<DetectedBodyPose>, VisionError> {
    // SAFETY: `run` validates the path and the supplied bridge function matches its expected contract.
    unsafe { run(path, ffi::vn_detect_human_body_pose_in_path) }
}

/// Call the supplied pose-detection bridge function and collect owned results.
///
/// # Safety
///
/// `f` must be a valid bridge function matching this signature and must
/// populate the out-parameters using the allocation contract expected by
/// [`collect`].
pub(crate) unsafe fn run(
    path: impl AsRef<Path>,
    f: unsafe extern "C" fn(
        *const c_char,
        *mut *mut core::ffi::c_void,
        *mut usize,
        *mut *mut c_char,
    ) -> i32,
) -> Result<Vec<DetectedBodyPose>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let path_c = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;

    let mut out_array: *mut core::ffi::c_void = ptr::null_mut();
    let mut out_count: usize = 0;
    let mut err_msg: *mut c_char = ptr::null_mut();
    let status = f(
        path_c.as_ptr(),
        &mut out_array,
        &mut out_count,
        &mut err_msg,
    );
    if status != ffi::status::OK {
        return Err(from_swift(status, err_msg));
    }
    Ok(collect(out_array, out_count))
}

/// Convert a bridge-allocated pose array into Rust-owned observations.
///
/// # Safety
///
/// `out_array` must be either null or point to `out_count` consecutive
/// `PoseObservationRaw` elements allocated by the Swift bridge. This
/// function consumes that allocation and frees it exactly once.
pub(crate) unsafe fn collect(
    out_array: *mut core::ffi::c_void,
    out_count: usize,
) -> Vec<DetectedBodyPose> {
    if out_array.is_null() || out_count == 0 {
        return Vec::new();
    }
    let typed = out_array.cast::<ffi::PoseObservationRaw>();
    let mut v = Vec::with_capacity(out_count);
    for i in 0..out_count {
        let raw = &*typed.add(i);
        let mut joints = HashMap::with_capacity(raw.joint_count);
        for j in 0..raw.joint_count {
            let name_ptr = *raw.joint_names.add(j);
            if name_ptr.is_null() {
                continue;
            }
            let name = core::ffi::CStr::from_ptr(name_ptr)
                .to_string_lossy()
                .into_owned();
            joints.insert(
                name,
                JointPoint {
                    x: *raw.joint_xs.add(j),
                    y: *raw.joint_ys.add(j),
                    confidence: *raw.joint_confidences.add(j),
                },
            );
        }
        v.push(DetectedBodyPose {
            bounding_box: BoundingBox {
                x: raw.bbox_x,
                y: raw.bbox_y,
                width: raw.bbox_w,
                height: raw.bbox_h,
            },
            confidence: raw.confidence,
            joints,
        });
    }
    ffi::vn_pose_observations_free(out_array, out_count);
    v
}
