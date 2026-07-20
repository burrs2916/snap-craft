//! Human hand pose detection (`VNDetectHumanHandPoseRequest`).
//!
//! Re-uses [`crate::body_pose::DetectedBodyPose`] / [`JointPoint`] as the
//! result shape — only the joint names differ (Apple's
//! `VNHumanHandPoseObservationJointName`: `"wrist_joint"`,
//! `"thumb_tip_joint"`, `"index_pip_joint"`, …).

use core::ffi::c_char;
use core::ptr;
use std::ffi::CString;
use std::path::Path;

use crate::body_pose::{collect, DetectedBodyPose};
pub use crate::body_pose::{DetectedBodyPose as DetectedHandPose, JointPoint};
use crate::error::{from_swift, VisionError};
use crate::ffi;
use crate::recognized_points::{RecognizedPointsObservation, VisionRecognizedPoint};

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
    /// Mirrors `VNHumanHandPoseObservationJointName`.
    pub enum HumanHandPoseJointName {
        Wrist => "VNHLKWRI",
        ThumbCmc => "VNHLKTCMC",
        ThumbMp => "VNHLKTMP",
        ThumbIp => "VNHLKTIP",
        ThumbTip => "VNHLKTTIP",
        IndexMcp => "VNHLKIMCP",
        IndexPip => "VNHLKIPIP",
        IndexDip => "VNHLKIDIP",
        IndexTip => "VNHLKITIP",
        MiddleMcp => "VNHLKMMCP",
        MiddlePip => "VNHLKMPIP",
        MiddleDip => "VNHLKMDIP",
        MiddleTip => "VNHLKMTIP",
        RingMcp => "VNHLKRMCP",
        RingPip => "VNHLKRPIP",
        RingDip => "VNHLKRDIP",
        RingTip => "VNHLKRTIP",
        LittleMcp => "VNHLKPMCP",
        LittlePip => "VNHLKPPIP",
        LittleDip => "VNHLKPDIP",
        LittleTip => "VNHLKPTIP",
    }
}

string_enum! {
    /// Mirrors `VNHumanHandPoseObservationJointsGroupName`.
    pub enum HumanHandPoseJointGroupName {
        Thumb => "VNHLRKT",
        IndexFinger => "VNHLRKI",
        MiddleFinger => "VNHLRKM",
        RingFinger => "VNHLRKR",
        LittleFinger => "VNHLRKP",
        All => "VNIPOAll",
    }
}

/// The `VNChirality` reported by `VNHumanHandPoseObservation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HandChirality {
    Unknown,
    Left,
    Right,
}

/// A dedicated `VNHumanHandPoseObservation` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct HumanHandPoseObservation {
    pub recognized_points: RecognizedPointsObservation,
    pub available_joint_names: Vec<String>,
    pub available_joint_group_names: Vec<String>,
    pub chirality: HandChirality,
}

const SUPPORTED_JOINT_NAMES: &[&str] = &[
    HumanHandPoseJointName::Wrist.as_str(),
    HumanHandPoseJointName::ThumbCmc.as_str(),
    HumanHandPoseJointName::ThumbMp.as_str(),
    HumanHandPoseJointName::ThumbIp.as_str(),
    HumanHandPoseJointName::ThumbTip.as_str(),
    HumanHandPoseJointName::IndexMcp.as_str(),
    HumanHandPoseJointName::IndexPip.as_str(),
    HumanHandPoseJointName::IndexDip.as_str(),
    HumanHandPoseJointName::IndexTip.as_str(),
    HumanHandPoseJointName::MiddleMcp.as_str(),
    HumanHandPoseJointName::MiddlePip.as_str(),
    HumanHandPoseJointName::MiddleDip.as_str(),
    HumanHandPoseJointName::MiddleTip.as_str(),
    HumanHandPoseJointName::RingMcp.as_str(),
    HumanHandPoseJointName::RingPip.as_str(),
    HumanHandPoseJointName::RingDip.as_str(),
    HumanHandPoseJointName::RingTip.as_str(),
    HumanHandPoseJointName::LittleMcp.as_str(),
    HumanHandPoseJointName::LittlePip.as_str(),
    HumanHandPoseJointName::LittleDip.as_str(),
    HumanHandPoseJointName::LittleTip.as_str(),
];

const SUPPORTED_JOINT_GROUP_NAMES: &[&str] = &[
    HumanHandPoseJointGroupName::Thumb.as_str(),
    HumanHandPoseJointGroupName::IndexFinger.as_str(),
    HumanHandPoseJointGroupName::MiddleFinger.as_str(),
    HumanHandPoseJointGroupName::RingFinger.as_str(),
    HumanHandPoseJointGroupName::LittleFinger.as_str(),
    HumanHandPoseJointGroupName::All.as_str(),
];

impl HumanHandPoseObservation {
    #[must_use]
    pub const fn supported_joint_name_keys() -> &'static [HumanHandPoseJointName] {
        HumanHandPoseJointName::ALL
    }

    #[must_use]
    pub const fn supported_joint_names() -> &'static [&'static str] {
        SUPPORTED_JOINT_NAMES
    }

    #[must_use]
    pub const fn supported_joint_group_name_keys() -> &'static [HumanHandPoseJointGroupName] {
        HumanHandPoseJointGroupName::ALL
    }

    #[must_use]
    pub const fn supported_joint_group_names() -> &'static [&'static str] {
        SUPPORTED_JOINT_GROUP_NAMES
    }

    #[must_use]
    pub fn recognized_point(
        &self,
        joint_name: HumanHandPoseJointName,
    ) -> Option<VisionRecognizedPoint> {
        self.recognized_points.recognized_point(joint_name.as_str())
    }

    #[must_use]
    pub fn into_detected_hand_pose(self) -> DetectedHandPose {
        self.into()
    }
}

impl From<DetectedHandPose> for HumanHandPoseObservation {
    fn from(value: DetectedHandPose) -> Self {
        let body = crate::body_pose::HumanBodyPoseObservation::from(value);
        Self {
            recognized_points: body.recognized_points,
            available_joint_names: body.available_joint_names,
            available_joint_group_names: Self::supported_joint_group_names()
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
            chirality: HandChirality::Unknown,
        }
    }
}

impl From<HumanHandPoseObservation> for DetectedHandPose {
    fn from(value: HumanHandPoseObservation) -> Self {
        crate::body_pose::HumanBodyPoseObservation {
            recognized_points: value.recognized_points,
            available_joint_names: value.available_joint_names,
            available_joint_group_names: value.available_joint_group_names,
        }
        .into()
    }
}

/// Detect up to `max_hands` (use `0` for "no limit") in the image at
/// `path`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn detect_human_hand_pose_in_path(
    path: impl AsRef<Path>,
    max_hands: usize,
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
    // SAFETY: all pointer arguments are valid stack locations or null-initialised out-params; strings are valid C strings for the duration of the call.
    let status = unsafe {
        ffi::vn_detect_human_hand_pose_in_path(
            path_c.as_ptr(),
            max_hands,
            &mut out_array,
            &mut out_count,
            &mut err_msg,
        )
    };
    if status != ffi::status::OK {
        // SAFETY: the error pointer is either null or a bridge-allocated C string; `from_swift` frees it.
        return Err(unsafe { from_swift(status, err_msg) });
    }
    // SAFETY: the pointer/count pair comes directly from the bridge and `collect` consumes it exactly once.
    Ok(unsafe { collect(out_array, out_count) })
}

/// Detect dedicated `VNHumanHandPoseObservation` wrappers in the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError::ImageLoadFailed`] / [`VisionError::RequestFailed`].
pub fn detect_human_hand_pose_observations_in_path(
    path: impl AsRef<Path>,
    max_hands: usize,
) -> Result<Vec<HumanHandPoseObservation>, VisionError> {
    detect_human_hand_pose_in_path(path, max_hands)
        .map(|poses| poses.into_iter().map(Into::into).collect())
}
