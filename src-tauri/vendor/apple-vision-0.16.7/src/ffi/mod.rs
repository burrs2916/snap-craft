//! Raw FFI declarations matching the Swift bridge in
//! `swift-bridge/Sources/VisionBridge/*.swift`.

#![allow(missing_docs, non_camel_case_types, clippy::pub_underscore_fields)]

use core::ffi::{c_char, c_void};

/// Mirrors `VNRecognizedTextRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct RecognizedTextRaw {
    pub text: *mut c_char,
    pub confidence: f32,
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
}

/// Mirrors `VNRequestObservationRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct RequestObservationRaw {
    pub uuid: *mut c_char,
    pub text: *mut c_char,
    pub confidence: f32,
    pub has_time_range: bool,
    pub time_range_start_seconds: f64,
    pub time_range_duration_seconds: f64,
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
}

/// Mirrors `VNDetectedFaceRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct DetectedFaceRaw {
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
    pub confidence: f32,
    pub roll: f32,
    pub yaw: f32,
    pub pitch: f32,
}

/// Mirrors `VNDetectedBarcodeRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct DetectedBarcodeRaw {
    pub payload: *mut c_char,
    pub symbology: *mut c_char,
    pub confidence: f32,
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
}

/// Mirrors `VNSaliencyRegionRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct SaliencyRegionRaw {
    pub confidence: f32,
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
}

/// Mirrors `VNFaceLandmarksRaw` in the Swift bridge. Layout-compatible.
///
/// All `*_count` fields are NUMBER OF POINTS; each point buffer is an
/// interleaved `[x0, y0, x1, y1, …]` array of doubles, length
/// `count * 2`. A NULL pointer + 0 count means the region wasn't
/// produced for this face.
#[repr(C)]
pub struct FaceLandmarksRaw {
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
    pub confidence: f32,
    pub roll: f32,
    pub yaw: f32,
    pub pitch: f32,

    pub face_contour: *mut f64,
    pub face_contour_count: usize,
    pub left_eye: *mut f64,
    pub left_eye_count: usize,
    pub right_eye: *mut f64,
    pub right_eye_count: usize,
    pub left_eyebrow: *mut f64,
    pub left_eyebrow_count: usize,
    pub right_eyebrow: *mut f64,
    pub right_eyebrow_count: usize,
    pub nose: *mut f64,
    pub nose_count: usize,
    pub nose_crest: *mut f64,
    pub nose_crest_count: usize,
    pub median_line: *mut f64,
    pub median_line_count: usize,
    pub outer_lips: *mut f64,
    pub outer_lips_count: usize,
    pub inner_lips: *mut f64,
    pub inner_lips_count: usize,
    pub left_pupil: *mut f64,
    pub left_pupil_count: usize,
    pub right_pupil: *mut f64,
    pub right_pupil_count: usize,
}

/// Mirrors `VNPoseObservationRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct PoseObservationRaw {
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
    pub confidence: f32,
    pub joint_names: *mut *mut c_char,
    pub joint_xs: *mut f64,
    pub joint_ys: *mut f64,
    pub joint_confidences: *mut f32,
    pub joint_count: usize,
}

/// Mirrors `VNContourRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct ContourRaw {
    pub point_xs: *mut f64,
    pub point_ys: *mut f64,
    pub point_count: usize,
    pub child_count: isize,
    pub aspect_ratio: f32,
}

/// Mirrors `VNRecognizedAnimalRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct RecognizedAnimalRaw {
    pub identifier: *mut c_char,
    pub confidence: f32,
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
}

/// Mirrors `VNClassificationRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct ClassificationRaw {
    pub identifier: *mut c_char,
    pub confidence: f32,
}

/// Mirrors `VNRectangleObservationRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct RectangleObservationRaw {
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
    pub confidence: f32,
    pub tl_x: f64,
    pub tl_y: f64,
    pub tr_x: f64,
    pub tr_y: f64,
    pub bl_x: f64,
    pub bl_y: f64,
    pub br_x: f64,
    pub br_y: f64,
}

/// Mirrors `VNFeaturePrintRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct FeaturePrintRaw {
    pub element_type: i32,
    pub element_count: usize,
    pub bytes: *mut c_void,
}

/// Mirrors `VNHumanObservationRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct HumanObservationRaw {
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
    pub confidence: f32,
    pub upper_body_only: bool,
}

/// Mirrors `VNAestheticsScoresRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct AestheticsScoresRaw {
    pub overall_score: f32,
    pub is_utility: bool,
}

/// Mirrors `VNFaceQualityRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct FaceQualityRaw {
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
    pub confidence: f32,
    pub capture_quality: f32,
    pub has_quality: bool,
}

/// Mirrors `VNSegmentationMaskRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct SegmentationMaskRaw {
    pub width: usize,
    pub height: usize,
    pub bytes_per_row: usize,
    pub bytes: *mut c_void,
}

/// Result container for async array operations. Freed by `vn_async_array_result_free`.
#[repr(C)]
pub struct AsyncArrayResultRaw {
    pub array: *mut c_void,
    pub count: usize,
}

/// Result container for async segmentation operations. Freed by `vn_async_seg_result_free`.
#[repr(C)]
pub struct AsyncSegResultRaw {
    pub width: usize,
    pub height: usize,
    pub bytes_per_row: usize,
    pub bytes: *mut u8,
}

/// Mirrors `VNCoreMLFeatureValueRaw` in the Swift bridge. Layout-compatible.
#[repr(C)]
pub struct CoreMLFeatureValueRaw {
    pub feature_name: *mut c_char,
    pub type_name: *mut c_char,
    pub kind: i32,
    pub int64_value: i64,
    pub double_value: f64,
    pub string_value: *mut c_char,
    pub multi_array_shape: *mut usize,
    pub multi_array_shape_count: usize,
    pub multi_array_values: *mut f64,
    pub multi_array_value_count: usize,
}

extern "C" {
    pub fn vn_string_free(s: *mut c_char);

    pub fn vn_recognize_text_in_path(
        path: *const c_char,
        recognition_level: i32,
        uses_language_correction: bool,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_recognize_text_in_pixel_buffer(
        pixel_buffer: *mut c_void,
        recognition_level: i32,
        uses_language_correction: bool,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_recognized_text_free(array: *mut c_void, count: usize);

    pub fn vn_image_request_handler_perform_text_request(
        image_path: *const c_char,
        recognition_level: i32,
        uses_language_correction: bool,
        prefer_background_processing: bool,
        uses_cpu_only: bool,
        revision: usize,
        has_revision: bool,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_sequence_request_handler_create(
        out_handle: *mut *mut c_void,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_sequence_request_handler_perform_text_request(
        handle: *mut c_void,
        image_path: *const c_char,
        recognition_level: i32,
        uses_language_correction: bool,
        prefer_background_processing: bool,
        uses_cpu_only: bool,
        revision: usize,
        has_revision: bool,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_sequence_request_handler_free(handle: *mut c_void);

    pub fn vn_video_processor_analyze_text_request(
        video_path: *const c_char,
        recognition_level: i32,
        uses_language_correction: bool,
        prefer_background_processing: bool,
        uses_cpu_only: bool,
        revision: usize,
        has_revision: bool,
        cadence_kind: i32,
        cadence_value: f64,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_request_observations_free(array: *mut c_void, count: usize);

    pub fn vn_detect_faces_in_path(
        path: *const c_char,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_detect_faces_in_pixel_buffer(
        pixel_buffer: *mut c_void,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_detected_faces_free(array: *mut c_void, count: usize);

    pub fn vn_detect_barcodes_in_path(
        path: *const c_char,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_detected_barcodes_free(array: *mut c_void, count: usize);

    pub fn vn_attention_saliency_in_path(
        path: *const c_char,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_saliency_regions_free(array: *mut c_void, count: usize);

    pub fn vn_detect_face_landmarks_in_path(
        path: *const c_char,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_face_landmarks_free(array: *mut c_void, count: usize);

    pub fn vn_detect_human_body_pose_in_path(
        path: *const c_char,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_detect_human_hand_pose_in_path(
        path: *const c_char,
        max_hands: usize,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_pose_observations_free(array: *mut c_void, count: usize);

    pub fn vn_detect_contours_in_path(
        path: *const c_char,
        contrast_adjustment: f32,
        detects_dark_on_light: bool,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_contours_free(array: *mut c_void, count: usize);

    pub fn vn_recognize_animals_in_path(
        path: *const c_char,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_recognized_animals_free(array: *mut c_void, count: usize);

    pub fn vn_classify_image_in_path(
        path: *const c_char,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;
    pub fn vn_classifications_free(array: *mut c_void, count: usize);

    pub fn vn_detect_rectangles_in_path(
        path: *const c_char,
        max_observations: usize,
        minimum_aspect_ratio: f32,
        maximum_aspect_ratio: f32,
        minimum_size: f32,
        minimum_confidence: f32,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_detect_document_segmentation_in_path(
        path: *const c_char,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_rectangle_observations_free(array: *mut c_void, count: usize);

    pub fn vn_detect_horizon_in_path(
        path: *const c_char,
        out_angle: *mut f64,
        out_has_value: *mut bool,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_generate_image_feature_print_in_path(
        path: *const c_char,
        out_feature: *mut FeaturePrintRaw,
        out_error_message: *mut *mut c_char,
    ) -> i32;
    pub fn vn_feature_print_free(feature: *mut FeaturePrintRaw);

    pub fn vn_detect_human_rectangles_in_path(
        path: *const c_char,
        upper_body_only: bool,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;
    pub fn vn_human_observations_free(array: *mut c_void, count: usize);

    pub fn vn_calculate_aesthetics_scores_in_path(
        path: *const c_char,
        out_scores: *mut AestheticsScoresRaw,
        out_has_value: *mut bool,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_detect_face_capture_quality_in_path(
        path: *const c_char,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_face_quality_observations_free(array: *mut c_void, count: usize);

    pub fn vn_generate_person_segmentation_in_path(
        path: *const c_char,
        quality_level: i32,
        out_mask: *mut SegmentationMaskRaw,
        out_has_value: *mut bool,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_generate_foreground_instance_mask_in_path(
        path: *const c_char,
        out_mask: *mut SegmentationMaskRaw,
        out_instance_count: *mut usize,
        out_has_value: *mut bool,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_segmentation_mask_free(mask: *mut SegmentationMaskRaw);

    pub fn vn_generate_optical_flow_in_paths(
        path_a: *const c_char,
        path_b: *const c_char,
        computation_accuracy: i32,
        out_mask: *mut SegmentationMaskRaw,
        out_has_value: *mut bool,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_coreml_classify_in_path(
        path: *const c_char,
        model_path: *const c_char,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_coreml_request_classify_in_path(
        path: *const c_char,
        model_path: *const c_char,
        input_image_feature_name: *const c_char,
        has_input_image_feature_name: bool,
        image_crop_and_scale_option: i32,
        roi_x: f64,
        roi_y: f64,
        roi_w: f64,
        roi_h: f64,
        has_region_of_interest: bool,
        prefer_background_processing: bool,
        uses_cpu_only: bool,
        revision: usize,
        has_revision: bool,
        out_array: *mut *mut c_void,
        out_count: *mut usize,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_coreml_feature_value_in_path(
        path: *const c_char,
        model_path: *const c_char,
        input_image_feature_name: *const c_char,
        has_input_image_feature_name: bool,
        image_crop_and_scale_option: i32,
        roi_x: f64,
        roi_y: f64,
        roi_w: f64,
        roi_h: f64,
        has_region_of_interest: bool,
        prefer_background_processing: bool,
        uses_cpu_only: bool,
        revision: usize,
        has_revision: bool,
        out_feature: *mut CoreMLFeatureValueRaw,
        out_has_value: *mut bool,
        out_error_message: *mut *mut c_char,
    ) -> i32;

    pub fn vn_coreml_feature_value_free(feature: *mut CoreMLFeatureValueRaw);

    // ---- async API ----
    pub fn vn_async_array_result_free(ptr: *mut c_void);
    pub fn vn_async_seg_result_free(ptr: *mut c_void);

    pub fn vn_recognize_text_in_path_async(
        path: *const c_char,
        recognition_level: i32,
        uses_language_correction: bool,
        cb: extern "C" fn(*const c_void, *const i8, *mut c_void),
        ctx: *mut c_void,
    );
    pub fn vn_detect_faces_in_path_async(
        path: *const c_char,
        cb: extern "C" fn(*const c_void, *const i8, *mut c_void),
        ctx: *mut c_void,
    );
    pub fn vn_detect_barcodes_in_path_async(
        path: *const c_char,
        cb: extern "C" fn(*const c_void, *const i8, *mut c_void),
        ctx: *mut c_void,
    );
    pub fn vn_generate_person_segmentation_async(
        path: *const c_char,
        quality_level: i32,
        cb: extern "C" fn(*const c_void, *const i8, *mut c_void),
        ctx: *mut c_void,
    );

    pub fn vn_test_helper_render_text_png(
        text: *const c_char,
        width: i32,
        height: i32,
        output_path: *const c_char,
    ) -> i32;

    pub fn vn_test_helper_render_text_video(
        first_text: *const c_char,
        second_text: *const c_char,
        width: i32,
        height: i32,
        fps: i32,
        frames_per_text: i32,
        output_path: *const c_char,
    ) -> i32;
}

// ===== v0.13 missing requests =====

/// Mirrors `VNAnimalJointRaw` in the Swift bridge.
#[repr(C)]
pub struct AnimalJointRaw {
    pub name: *mut c_char,
    pub x: f64,
    pub y: f64,
    pub confidence: f32,
    pub _pad: f32,
}

/// Mirrors `VNHumanJoint3DRaw`.
#[repr(C)]
pub struct HumanJoint3DRaw {
    pub name: *mut c_char,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub confidence: f32,
    pub local_x: f32,
    pub local_y: f32,
    pub local_z: f32,
    pub parent_joint: *mut c_char,
}

/// Mirrors `VNSimpleRectRaw`.
#[repr(C)]
pub struct SimpleRectRaw {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub confidence: f32,
    pub _pad: f32,
}

/// Mirrors `VNTextObservationRaw`.
#[repr(C)]
pub struct TextObservationRaw {
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
    pub confidence: f32,
    pub _pad: f32,
    pub character_boxes: *mut SimpleRectRaw,
    pub character_box_count: usize,
}

/// Mirrors `VNTrajectoryRaw`.
#[repr(C)]
pub struct TrajectoryRaw {
    pub detected_x: f64,
    pub detected_y: f64,
    pub projected_x: f64,
    pub projected_y: f64,
    pub equation_a: f64,
    pub equation_b: f64,
    pub equation_c: f64,
    pub confidence: f32,
    pub _pad: f32,
}

/// Mirrors `VNTranslationalAlignmentRaw`.
#[repr(C)]
pub struct TranslationalAlignmentRaw {
    pub tx: f64,
    pub ty: f64,
}

/// Mirrors `VNHomographicAlignmentRaw` (3×3 row-major matrix).
#[repr(C)]
pub struct HomographicAlignmentRaw {
    pub m00: f32,
    pub m01: f32,
    pub m02: f32,
    pub m10: f32,
    pub m11: f32,
    pub m12: f32,
    pub m20: f32,
    pub m21: f32,
    pub m22: f32,
    pub _pad: f32,
}

extern "C" {
    pub fn vn_detect_animal_body_pose_in_path(
        path: *const c_char,
        out_joints: *mut *mut AnimalJointRaw,
        out_count: *mut isize,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_animal_joints_free(ptr: *mut AnimalJointRaw, count: isize);

    pub fn vn_detect_human_body_pose_3d_in_path(
        path: *const c_char,
        out_joints: *mut *mut HumanJoint3DRaw,
        out_count: *mut isize,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_human_joints_3d_free(ptr: *mut HumanJoint3DRaw, count: isize);

    pub fn vn_detect_text_rectangles_in_path(
        path: *const c_char,
        reports_character_boxes: bool,
        out_rects: *mut *mut SimpleRectRaw,
        out_count: *mut isize,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_detect_text_observations_in_path(
        path: *const c_char,
        reports_character_boxes: bool,
        roi_x: f64,
        roi_y: f64,
        roi_w: f64,
        roi_h: f64,
        has_region_of_interest: bool,
        prefer_background_processing: bool,
        uses_cpu_only: bool,
        revision: usize,
        has_revision: bool,
        out_observations: *mut *mut TextObservationRaw,
        out_count: *mut usize,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_text_observations_free(ptr: *mut c_void, count: usize);
    pub fn vn_objectness_saliency_in_path(
        path: *const c_char,
        out_rects: *mut *mut SimpleRectRaw,
        out_count: *mut isize,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_simple_rects_free(ptr: *mut SimpleRectRaw, count: isize);

    pub fn vn_person_instance_mask_in_path(
        path: *const c_char,
        out_width: *mut isize,
        out_height: *mut isize,
        out_bytes_per_row: *mut isize,
        out_data: *mut *mut u8,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_mask_buffer_free(ptr: *mut u8, size: isize);

    pub fn vn_detect_trajectories_in_path(
        path: *const c_char,
        trajectory_length: isize,
        out_trajectories: *mut *mut TrajectoryRaw,
        out_count: *mut isize,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_trajectories_free(ptr: *mut TrajectoryRaw, count: isize);

    pub fn vn_register_translational_in_paths(
        target_path: *const c_char,
        floating_path: *const c_char,
        out: *mut TranslationalAlignmentRaw,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_register_homographic_in_paths(
        target_path: *const c_char,
        floating_path: *const c_char,
        out: *mut HomographicAlignmentRaw,
        out_err: *mut *mut c_char,
    ) -> i32;
}

// ===== tracking requests =====

extern "C" {
    pub fn vn_object_tracker_create(
        initial_path: *const c_char,
        initial_bbox: *mut c_void,
        out_handle: *mut *mut c_void,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_object_tracker_track(
        handle: *mut c_void,
        next_path: *const c_char,
        out_bbox: *mut c_void,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_object_tracker_release(handle: *mut c_void);

    pub fn vn_rectangle_tracker_create(
        initial_path: *const c_char,
        initial_observation: *mut c_void,
        out_handle: *mut *mut c_void,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_rectangle_tracker_track(
        handle: *mut c_void,
        next_path: *const c_char,
        out_observation: *mut c_void,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_rectangle_tracker_release(handle: *mut c_void);

    pub fn vn_optical_flow_tracker_create(
        reference_path: *const c_char,
        out_handle: *mut *mut c_void,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_optical_flow_tracker_track(
        handle: *mut c_void,
        next_path: *const c_char,
        out_mask: *mut c_void,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_optical_flow_tracker_release(handle: *mut c_void);

    pub fn vn_translational_image_tracker_create(
        reference_path: *const c_char,
        out_handle: *mut *mut c_void,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_translational_image_tracker_track(
        handle: *mut c_void,
        next_path: *const c_char,
        out_alignment: *mut c_void,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_translational_image_tracker_release(handle: *mut c_void);

    pub fn vn_homographic_image_tracker_create(
        reference_path: *const c_char,
        out_handle: *mut *mut c_void,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_homographic_image_tracker_track(
        handle: *mut c_void,
        next_path: *const c_char,
        out_alignment: *mut c_void,
        out_err: *mut *mut c_char,
    ) -> i32;
    pub fn vn_homographic_image_tracker_release(handle: *mut c_void);
}

pub mod status {
    pub const OK: i32 = 0;
    pub const INVALID_ARGUMENT: i32 = -1;
    pub const IMAGE_LOAD_FAILED: i32 = -2;
    pub const REQUEST_FAILED: i32 = -3;
    pub const UNKNOWN: i32 = -99;
}

// silence unused
const _: () = {
    let _ = core::mem::size_of::<*mut c_void>();
};
