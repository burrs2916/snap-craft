#![allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
#![allow(clippy::too_long_first_doc_paragraph)]
//! `VNDetectHumanBodyPose3DRequest` — 3D human-body keypoints
//! (macOS 14+).

use std::ffi::{CStr, CString};
use std::path::Path;
use std::ptr;

use crate::error::VisionError;
use crate::ffi;
use crate::geometry::{Transform3D, VisionPoint3D};
use crate::recognized_points::{
    HumanBodyRecognizedPoint3D as DetailedHumanBodyRecognizedPoint3D, RecognizedPoint3D,
    RecognizedPoints3DObservation, VisionRecognizedPoint3D,
};

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
    /// Mirrors `VNHumanBodyPose3DObservationJointName`.
    pub enum HumanBodyPose3DJointName {
        Root => "human_root_3D",
        RightHip => "human_right_hip_3D",
        RightKnee => "human_right_knee_3D",
        RightAnkle => "human_right_ankle_3D",
        LeftHip => "human_left_hip_3D",
        LeftKnee => "human_left_knee_3D",
        LeftAnkle => "human_left_ankle_3D",
        Spine => "human_spine_3D",
        CenterShoulder => "human_center_shoulder_3D",
        CenterHead => "human_center_head_3D",
        TopHead => "human_top_head_3D",
        LeftShoulder => "human_left_shoulder_3D",
        LeftElbow => "human_left_elbow_3D",
        LeftWrist => "human_left_wrist_3D",
        RightShoulder => "human_right_shoulder_3D",
        RightElbow => "human_right_elbow_3D",
        RightWrist => "human_right_wrist_3D",
    }
}

string_enum! {
    /// Mirrors `VNHumanBodyPose3DObservationJointsGroupName`.
    pub enum HumanBodyPose3DJointGroupName {
        Head => "human_joint_group_head_3D",
        Torso => "human_joint_group_torso_3D",
        LeftArm => "human_joint_group_left_arm_3D",
        RightArm => "human_joint_group_right_arm_3D",
        LeftLeg => "human_joint_group_left_leg_3D",
        RightLeg => "human_joint_group_right_leg_3D",
        All => "VNIPOAll",
    }
}

/// One 3D body keypoint (joint).
#[derive(Debug, Clone, PartialEq)]
pub struct HumanJoint3D {
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub confidence: f32,
}

/// Mirrors `VNHumanBodyPose3DObservation.HeightEstimation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BodyHeightEstimation {
    Reference,
    Measured,
}

/// Public alias matching the SDK symbol spelling.
pub type HumanBodyPose3DObservationHeightEstimation = BodyHeightEstimation;

/// A dedicated `VNHumanBodyPose3DObservation` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct HumanBodyPose3DObservation {
    pub recognized_points: RecognizedPoints3DObservation,
    pub available_joint_names: Vec<String>,
    pub available_joint_group_names: Vec<String>,
    pub height_estimation: Option<BodyHeightEstimation>,
    pub body_height_meters: Option<f32>,
}

const SUPPORTED_JOINT_NAMES: &[&str] = &[
    HumanBodyPose3DJointName::Root.as_str(),
    HumanBodyPose3DJointName::RightHip.as_str(),
    HumanBodyPose3DJointName::RightKnee.as_str(),
    HumanBodyPose3DJointName::RightAnkle.as_str(),
    HumanBodyPose3DJointName::LeftHip.as_str(),
    HumanBodyPose3DJointName::LeftKnee.as_str(),
    HumanBodyPose3DJointName::LeftAnkle.as_str(),
    HumanBodyPose3DJointName::Spine.as_str(),
    HumanBodyPose3DJointName::CenterShoulder.as_str(),
    HumanBodyPose3DJointName::CenterHead.as_str(),
    HumanBodyPose3DJointName::TopHead.as_str(),
    HumanBodyPose3DJointName::LeftShoulder.as_str(),
    HumanBodyPose3DJointName::LeftElbow.as_str(),
    HumanBodyPose3DJointName::LeftWrist.as_str(),
    HumanBodyPose3DJointName::RightShoulder.as_str(),
    HumanBodyPose3DJointName::RightElbow.as_str(),
    HumanBodyPose3DJointName::RightWrist.as_str(),
];

const SUPPORTED_JOINT_GROUP_NAMES: &[&str] = &[
    HumanBodyPose3DJointGroupName::Head.as_str(),
    HumanBodyPose3DJointGroupName::Torso.as_str(),
    HumanBodyPose3DJointGroupName::LeftArm.as_str(),
    HumanBodyPose3DJointGroupName::RightArm.as_str(),
    HumanBodyPose3DJointGroupName::LeftLeg.as_str(),
    HumanBodyPose3DJointGroupName::RightLeg.as_str(),
    HumanBodyPose3DJointGroupName::All.as_str(),
];

impl HumanBodyPose3DObservation {
    #[must_use]
    pub const fn supported_joint_name_keys() -> &'static [HumanBodyPose3DJointName] {
        HumanBodyPose3DJointName::ALL
    }

    #[must_use]
    pub const fn supported_joint_names() -> &'static [&'static str] {
        SUPPORTED_JOINT_NAMES
    }

    #[must_use]
    pub const fn supported_joint_group_name_keys() -> &'static [HumanBodyPose3DJointGroupName] {
        HumanBodyPose3DJointGroupName::ALL
    }

    #[must_use]
    pub const fn supported_joint_group_names() -> &'static [&'static str] {
        SUPPORTED_JOINT_GROUP_NAMES
    }

    #[must_use]
    pub fn recognized_point(
        &self,
        joint_name: HumanBodyPose3DJointName,
    ) -> Option<VisionRecognizedPoint3D> {
        self.recognized_points.recognized_point(joint_name.as_str())
    }

    #[must_use]
    pub fn into_joints(self) -> Vec<HumanJoint3D> {
        self.into()
    }
}

impl From<Vec<HumanJoint3D>> for HumanBodyPose3DObservation {
    fn from(value: Vec<HumanJoint3D>) -> Self {
        let mut available_joint_names = value
            .iter()
            .map(|joint| joint.name.clone())
            .collect::<Vec<_>>();
        available_joint_names.sort();
        let available_joint_group_names = Self::supported_joint_group_names()
            .iter()
            .map(|name| (*name).to_string())
            .collect::<Vec<_>>();
        Self {
            recognized_points: RecognizedPoints3DObservation {
                confidence: 1.0,
                available_keys: available_joint_names.clone(),
                available_group_keys: available_joint_group_names.clone(),
                points: value
                    .iter()
                    .map(|joint| {
                        (
                            joint.name.clone(),
                            RecognizedPoint3D {
                                x: joint.x,
                                y: joint.y,
                                z: joint.z,
                                confidence: joint.confidence,
                            },
                        )
                    })
                    .collect(),
            },
            available_joint_names,
            available_joint_group_names,
            height_estimation: None,
            body_height_meters: None,
        }
    }
}

impl From<HumanBodyPose3DObservation> for Vec<HumanJoint3D> {
    fn from(value: HumanBodyPose3DObservation) -> Self {
        value
            .recognized_points
            .points
            .into_iter()
            .map(|(name, point)| HumanJoint3D {
                name,
                x: point.x,
                y: point.y,
                z: point.z,
                confidence: point.confidence,
            })
            .collect()
    }
}

/// Detect 3D body-pose keypoints in the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError`] when the image fails to load or the
/// Vision request errors.
pub fn detect_human_body_pose_3d(path: impl AsRef<Path>) -> Result<Vec<HumanJoint3D>, VisionError> {
    detect_human_body_recognized_points_3d(path).map(|points| {
        points
            .into_iter()
            .map(|point| HumanJoint3D {
                name: point.recognized_point.identifier,
                x: point.recognized_point.point.x(),
                y: point.recognized_point.point.y(),
                z: point.recognized_point.point.z(),
                confidence: point.recognized_point.confidence,
            })
            .collect()
    })
}

/// Detect detailed `VNHumanBodyRecognizedPoint3D` wrappers in the image at
/// `path`.
///
/// # Errors
///
/// Returns [`VisionError`] when the image fails to load or the Vision request
/// errors.
pub fn detect_human_body_recognized_points_3d(
    path: impl AsRef<Path>,
) -> Result<Vec<DetailedHumanBodyRecognizedPoint3D>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let cpath = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;
    let mut joints_ptr: *mut ffi::HumanJoint3DRaw = ptr::null_mut();
    let mut count: isize = 0;
    let mut err: *mut std::ffi::c_char = ptr::null_mut();
    // SAFETY: all pointer arguments are valid stack locations or null-initialised out-params; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_detect_human_body_pose_3d_in_path(
            cpath.as_ptr(),
            &mut joints_ptr,
            &mut count,
            &mut err,
        )
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `take_err` copies and frees it.
        let msg = unsafe { take_err(err) };
        return Err(VisionError::RequestFailed(msg));
    }

    let mut out = Vec::with_capacity(count.max(0) as usize);
    for index in 0..count {
        // SAFETY: the pointer is valid for the reported element count; the index is in bounds.
        let row = unsafe { &*joints_ptr.offset(index) };
        let identifier = copy_string(row.name);
        let parent_joint = copy_optional_string(row.parent_joint);
        let recognized_point = VisionRecognizedPoint3D::new(
            identifier,
            VisionPoint3D::from_xyz(row.x, row.y, row.z),
            row.confidence,
        );
        out.push(DetailedHumanBodyRecognizedPoint3D::new(
            recognized_point,
            Transform3D::from_translation(row.local_x, row.local_y, row.local_z),
            parent_joint,
        ));
    }
    if !joints_ptr.is_null() {
        // SAFETY: the pointer/count pair was allocated by the bridge and is freed exactly once here.
        unsafe { ffi::vn_human_joints_3d_free(joints_ptr, count) };
    }
    Ok(out)
}

/// Detect dedicated `VNRecognizedPoints3DObservation` /
/// `VNHumanBodyPose3DObservation` wrappers in the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError`] when the image fails to load or the Vision request
/// errors.
pub fn detect_human_body_pose_3d_observations(
    path: impl AsRef<Path>,
) -> Result<Vec<HumanBodyPose3DObservation>, VisionError> {
    detect_human_body_pose_3d(path).map(|joints| {
        if joints.is_empty() {
            Vec::new()
        } else {
            vec![HumanBodyPose3DObservation::from(joints)]
        }
    })
}

fn copy_string(pointer: *mut std::ffi::c_char) -> String {
    if pointer.is_null() {
        String::new()
    } else {
        // SAFETY: the C string pointer is non-null (checked above) and valid for the duration of this borrow.
        unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned()
    }
}

fn copy_optional_string(pointer: *mut std::ffi::c_char) -> Option<String> {
    if pointer.is_null() {
        None
    } else {
        // SAFETY: the C string pointer is non-null (checked above) and valid for the duration of this borrow.
        let value = unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }
}

/// Extract an error string from a bridge-allocated C string and free it.
///
/// # Safety
///
/// `p` must be either null or a valid null-terminated C string heap-allocated
/// (via `malloc`) by the Swift bridge. After this call `p` is invalid.
unsafe fn take_err(p: *mut std::ffi::c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    // SAFETY: the C string pointer is non-null (checked above) and valid for the duration of this borrow.
    let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    // SAFETY: `p` was malloc-allocated by the bridge and has not been freed yet.
    unsafe { libc::free(p.cast()) };
    s
}
