#![allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
#![allow(clippy::too_long_first_doc_paragraph)]
//! `VNDetectAnimalBodyPoseRequest` — body-pose keypoints for cats,
//! dogs and similar quadrupeds. Available on macOS 14+.

use std::ffi::{CStr, CString};
use std::path::Path;
use std::ptr;

use crate::error::VisionError;
use crate::ffi;

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
    /// Mirrors `VNAnimalBodyPoseObservationJointName`.
    pub enum AnimalBodyPoseJointName {
        LeftEarTop => "animal_joint_left_ear_top",
        RightEarTop => "animal_joint_right_ear_top",
        LeftEarMiddle => "animal_joint_left_ear_middle",
        RightEarMiddle => "animal_joint_right_ear_middle",
        LeftEarBottom => "animal_joint_left_ear_bottom",
        RightEarBottom => "animal_joint_right_ear_bottom",
        LeftEye => "animal_joint_left_eye",
        RightEye => "animal_joint_right_eye",
        Nose => "animal_joint_nose",
        Neck => "animal_joint_heck",
        LeftFrontElbow => "animal_joint_left_front_elbow",
        RightFrontElbow => "animal_joint_right_front_elbow",
        LeftFrontKnee => "animal_joint_left_front_knee",
        RightFrontKnee => "animal_joint_right_front_knee",
        LeftFrontPaw => "animal_joint_left_front_paw",
        RightFrontPaw => "animal_joint_right_front_paw",
        LeftBackElbow => "animal_joint_left_back_elbow",
        RightBackElbow => "animal_joint_right_back_elbow",
        LeftBackKnee => "animal_joint_left_back_knee",
        RightBackKnee => "animal_joint_right_back_knee",
        LeftBackPaw => "animal_joint_left_back_paw",
        RightBackPaw => "animal_joint_right_back_paw",
        TailTop => "animal_joint_tail_top",
        TailMiddle => "animal_joint_tail_middle",
        TailBottom => "animal_joint_tail_bottom",
    }
}

string_enum! {
    /// Mirrors `VNAnimalBodyPoseObservationJointsGroupName`.
    pub enum AnimalBodyPoseJointGroupName {
        Head => "animal_joint_group_head",
        Trunk => "animal_joint_group_trunk",
        Forelegs => "animal_joint_group_gorelegs",
        Hindlegs => "animal_joint_group_hindlegs",
        Tail => "animal_joint_group_tail",
        All => "VNIPOAll",
    }
}

/// One labelled keypoint on a detected animal body.
#[derive(Debug, Clone, PartialEq)]
pub struct AnimalJoint {
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub confidence: f32,
}

impl AnimalJoint {
    #[must_use]
    pub fn joint_name(&self) -> Option<AnimalBodyPoseJointName> {
        AnimalBodyPoseJointName::from_str(&self.name)
    }
}

/// Detect quadruped body-pose keypoints in the image at `path`.
///
/// # Errors
///
/// Returns [`VisionError`] when the image fails to load or the
/// Vision request errors.
pub fn detect_animal_body_pose(path: impl AsRef<Path>) -> Result<Vec<AnimalJoint>, VisionError> {
    let path_str = path
        .as_ref()
        .to_str()
        .ok_or_else(|| VisionError::InvalidArgument("non-UTF-8 path".into()))?;
    let cpath = CString::new(path_str)
        .map_err(|e| VisionError::InvalidArgument(format!("path NUL byte: {e}")))?;
    let mut joints_ptr: *mut ffi::AnimalJointRaw = ptr::null_mut();
    let mut count: isize = 0;
    let mut err: *mut std::ffi::c_char = ptr::null_mut();
    // SAFETY: `cpath` is a valid C string; all out-pointers are valid stack locations.
    let status = unsafe {
        ffi::vn_detect_animal_body_pose_in_path(
            cpath.as_ptr(),
            &mut joints_ptr,
            &mut count,
            &mut err,
        )
    };
    if status != ffi::status::OK {
        // SAFETY: `err` is either null or a malloc'd C string from the bridge.
        let msg = unsafe { take_err(err) };
        return Err(VisionError::RequestFailed(msg));
    }
    let mut out = Vec::with_capacity(count.max(0) as usize);
    for i in 0..count {
        // SAFETY: `joints_ptr` is valid for `count` elements; `i` is in bounds.
        let j = unsafe { joints_ptr.offset(i).read() };
        let name = if j.name.is_null() {
            String::new()
        } else {
            // SAFETY: `j.name` is a valid C string when non-null.
            unsafe { CStr::from_ptr(j.name) }
                .to_string_lossy()
                .into_owned()
        };
        out.push(AnimalJoint {
            name,
            x: j.x,
            y: j.y,
            confidence: j.confidence,
        });
    }
    if !joints_ptr.is_null() {
        // SAFETY: `joints_ptr` and `count` are the bridge-allocated pair; unique free site.
        unsafe { ffi::vn_animal_joints_free(joints_ptr, count) };
    }
    Ok(out)
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
    // SAFETY: `p` is a valid C string per the function contract.
    let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    // SAFETY: `p` was malloc-allocated by the bridge and is not yet freed.
    unsafe { libc::free(p.cast()) };
    s
}
