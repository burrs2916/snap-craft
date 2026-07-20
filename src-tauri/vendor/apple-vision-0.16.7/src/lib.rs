#![doc = include_str!("../README.md")]
//!
//! ---
//!
//! # API Documentation
//!
//! Safe Rust bindings for Apple's
//! [Vision](https://developer.apple.com/documentation/vision) framework —
//! OCR, object detection, face landmarks, and other on-device computer
//! vision tasks.
//!
//! v0.16.0 adds a Tier-1 `async_api` module for one-shot OCR / face / barcode /
//! segmentation requests while keeping the full audited Vision request surface
//! and the split Swift bridge / coverage matrix introduced in v0.15.x.

#![cfg_attr(docsrs, feature(doc_cfg))]

pub mod error;
pub mod ffi;
pub mod geometry;
pub mod recognized_points;
pub mod request_base;
pub mod sdk;

#[cfg(feature = "async")]
#[cfg_attr(docsrs, doc(cfg(feature = "async")))]
pub mod async_api;

#[cfg(feature = "recognize_text")]
#[cfg_attr(docsrs, doc(cfg(feature = "recognize_text")))]
pub mod recognize_text;

#[cfg(feature = "recognize_text")]
#[cfg_attr(docsrs, doc(cfg(feature = "recognize_text")))]
pub mod processing;

#[cfg(feature = "detect_faces")]
#[cfg_attr(docsrs, doc(cfg(feature = "detect_faces")))]
pub mod detect_faces;

#[cfg(feature = "detect_barcodes")]
#[cfg_attr(docsrs, doc(cfg(feature = "detect_barcodes")))]
pub mod detect_barcodes;

#[cfg(feature = "saliency")]
#[cfg_attr(docsrs, doc(cfg(feature = "saliency")))]
pub mod saliency;

#[cfg(feature = "face_landmarks")]
#[cfg_attr(docsrs, doc(cfg(feature = "face_landmarks")))]
pub mod face_landmarks;

#[cfg(feature = "body_pose")]
#[cfg_attr(docsrs, doc(cfg(feature = "body_pose")))]
pub mod body_pose;

#[cfg(feature = "hand_pose")]
#[cfg_attr(docsrs, doc(cfg(feature = "hand_pose")))]
pub mod hand_pose;

#[cfg(feature = "contours")]
#[cfg_attr(docsrs, doc(cfg(feature = "contours")))]
pub mod contours;

#[cfg(feature = "animals")]
#[cfg_attr(docsrs, doc(cfg(feature = "animals")))]
pub mod animals;

#[cfg(feature = "classify")]
#[cfg_attr(docsrs, doc(cfg(feature = "classify")))]
pub mod classify;

#[cfg(feature = "rectangles")]
#[cfg_attr(docsrs, doc(cfg(feature = "rectangles")))]
pub mod rectangles;

#[cfg(feature = "horizon")]
#[cfg_attr(docsrs, doc(cfg(feature = "horizon")))]
pub mod horizon;

#[cfg(feature = "feature_print")]
#[cfg_attr(docsrs, doc(cfg(feature = "feature_print")))]
pub mod feature_print;

#[cfg(feature = "humans")]
#[cfg_attr(docsrs, doc(cfg(feature = "humans")))]
pub mod humans;

#[cfg(feature = "aesthetics")]
#[cfg_attr(docsrs, doc(cfg(feature = "aesthetics")))]
pub mod aesthetics;

#[cfg(feature = "segmentation")]
#[cfg_attr(docsrs, doc(cfg(feature = "segmentation")))]
pub mod segmentation;

#[cfg(feature = "optical_flow")]
#[cfg_attr(docsrs, doc(cfg(feature = "optical_flow")))]
pub mod optical_flow;

#[cfg(feature = "coreml")]
#[cfg_attr(docsrs, doc(cfg(feature = "coreml")))]
pub mod coreml;

#[cfg(feature = "tracking")]
#[cfg_attr(docsrs, doc(cfg(feature = "tracking")))]
pub mod tracking;

// v0.13: new request types
pub mod animal_body_pose;
pub mod human_body_pose_3d;
pub mod objectness_saliency;
pub mod person_instance_mask;
pub mod registration;
pub mod text_rectangles;
pub mod trajectories;

pub use error::VisionError;
pub use geometry::{
    element_type_size, image_point_for_face_landmark_point, image_point_for_normalized_point,
    image_point_for_normalized_point_using_region_of_interest, image_rect_for_normalized_rect,
    image_rect_for_normalized_rect_using_region_of_interest,
    normalized_face_bounding_box_point_for_landmark_point, normalized_identity_rect,
    normalized_point_for_image_point, normalized_point_for_image_point_using_region_of_interest,
    normalized_rect_for_image_rect, normalized_rect_for_image_rect_using_region_of_interest,
    normalized_rect_is_identity_rect, Transform3D, VisionCircle, VisionGeometryUtils, VisionPoint,
    VisionPoint3D, VisionVector,
};
pub use recognized_points::{
    HumanBodyRecognizedPoint3D, RecognizedPoint, RecognizedPoint3D, RecognizedPoints3DObservation,
    RecognizedPointsObservation, VisionDetectedPoint, VisionRecognizedPoint,
    VisionRecognizedPoint3D,
};
pub use request_base::{
    ImageAlignmentObservation, ImageBasedRequest, ImageRegistrationRequest, NormalizedRect,
    PixelBufferObservation, RequestProgress, RequestProgressHandler, RequestProgressProviding,
    RequestRevisionProviding, StatefulRequest, TargetedImageRequest, TrackingLevel,
    TrackingRequest,
};
pub use sdk::{
    vision_version_number, AnimalIdentifier, BarcodeCompositeType, BarcodeSymbology, ComputeStage,
    ElementType, ImageCropAndScaleOption, ImageOption, PointsClassification,
    RecognizedPoint3DGroupKey, RecognizedPointGroupKey, VisionErrorCode, VISION_ERROR_DOMAIN,
};

#[cfg(feature = "recognize_text")]
pub use processing::{
    ImageRequestHandler, Observation, RecognizedTextObservation, Request, RequestKind,
    SequenceRequestHandler, TimeRange, VideoCadence, VideoProcessingOptions, VideoProcessor,
    VideoProcessorCadence, VideoProcessorFrameRateCadence, VideoProcessorRequestProcessingOptions,
    VideoProcessorTimeIntervalCadence,
};

#[cfg(feature = "recognize_text")]
pub use recognize_text::{
    BoundingBox, RecognitionLevel, RecognizedText, RecognizedTextCandidate, TextRecognizer,
};

#[cfg(feature = "detect_faces")]
pub use detect_faces::{DetectedFace, FaceDetector};

#[cfg(feature = "detect_barcodes")]
pub use detect_barcodes::{
    detect_barcodes_in_path, BarcodeCompositeType as DetectedBarcodeCompositeType,
    BarcodeSymbology as DetectedBarcodeSymbology, DetectedBarcode,
};

#[cfg(feature = "saliency")]
pub use saliency::{attention_saliency_in_path, SalientRegion};

#[cfg(feature = "face_landmarks")]
pub use face_landmarks::{
    detect_face_landmarks_in_path, FaceLandmarkRegion, FaceLandmarkRegion2D, FaceLandmarks,
    FaceLandmarks2D, FaceLandmarksRequest, FaceObservationAccepting, FaceWithLandmarks,
    LandmarkPoint, RequestFaceLandmarksConstellation,
};

#[cfg(feature = "body_pose")]
pub use body_pose::{
    detect_human_body_pose_in_path, detect_human_body_pose_observations_in_path, DetectedBodyPose,
    HumanBodyPoseJointGroupName, HumanBodyPoseJointName, HumanBodyPoseObservation, JointPoint,
};

#[cfg(feature = "hand_pose")]
pub use hand_pose::{
    detect_human_hand_pose_in_path, detect_human_hand_pose_observations_in_path, DetectedHandPose,
    HandChirality, HumanHandPoseJointGroupName, HumanHandPoseJointName, HumanHandPoseObservation,
};

#[cfg(feature = "contours")]
pub use contours::{
    detect_contours_in_path, detect_contours_observation_in_path, Contour, ContourOptions,
    ContoursObservation, VisionContour,
};

#[cfg(feature = "animals")]
pub use animals::{
    recognize_animals_in_path, AnimalIdentifier as RecognizedAnimalIdentifier, RecognizedAnimal,
};

#[cfg(feature = "classify")]
pub use classify::{classify_image_in_path, Classification};

#[cfg(feature = "rectangles")]
pub use rectangles::{
    detect_document_segmentation_in_path, detect_rectangles_in_path, RectangleObservation,
    RectangleOptions,
};

#[cfg(feature = "horizon")]
pub use horizon::{
    detect_horizon_in_path, detect_horizon_observation_in_path, AffineTransform, HorizonObservation,
};

#[cfg(feature = "feature_print")]
pub use feature_print::{generate_image_feature_print_in_path, FeaturePrint};

#[cfg(feature = "humans")]
pub use humans::{detect_human_rectangles_in_path, DetectedHuman};

#[cfg(feature = "aesthetics")]
pub use aesthetics::{
    calculate_aesthetics_scores_in_path, detect_face_capture_quality_in_path, AestheticsScores,
    FaceCaptureQuality,
};

#[cfg(feature = "segmentation")]
pub use segmentation::{
    generate_foreground_instance_mask_in_path,
    generate_foreground_instance_mask_observation_in_path, generate_person_segmentation_in_path,
    InstanceMask, InstanceMaskObservation, SegmentationMask, SegmentationQuality,
};

#[cfg(feature = "optical_flow")]
pub use optical_flow::{
    generate_optical_flow_in_paths, generate_optical_flow_observation_in_paths, OpticalFlowAccuracy,
};

#[cfg(feature = "coreml")]
pub use coreml::{
    coreml_classify_in_path, coreml_feature_value_in_path, CoreMLFeatureValue,
    CoreMLFeatureValueObservation, CoreMLImageCropAndScaleOption, CoreMLModel, CoreMLRequest,
};

pub use animal_body_pose::{
    detect_animal_body_pose, AnimalBodyPoseJointGroupName, AnimalBodyPoseJointName, AnimalJoint,
};
pub use human_body_pose_3d::{
    detect_human_body_pose_3d, detect_human_body_pose_3d_observations,
    detect_human_body_recognized_points_3d, BodyHeightEstimation, HumanBodyPose3DJointGroupName,
    HumanBodyPose3DJointName, HumanBodyPose3DObservation,
    HumanBodyPose3DObservationHeightEstimation, HumanJoint3D,
};
pub use objectness_saliency::{objectness_saliency, ObjectnessRegion};
pub use person_instance_mask::{person_instance_mask, PersonInstanceMask};
pub use registration::{
    register_homographic, register_homographic_observation, register_translational,
    register_translational_observation, HomographicAlignment, TranslationalAlignment,
};
pub use text_rectangles::{
    detect_text_observations, detect_text_rectangles, TextObservation, TextRect,
    TextRectanglesRequest,
};
pub use trajectories::{detect_trajectories, Trajectory};

#[cfg(feature = "tracking")]
pub use tracking::{
    HomographicImageTracker, ObjectTracker, OpticalFlowFrame, OpticalFlowTracker, RectangleTracker,
    TrackOpticalFlowRequestComputationAccuracy, TranslationalImageTracker,
};

/// Common imports.
pub mod prelude {
    pub use crate::animal_body_pose::{
        detect_animal_body_pose, AnimalBodyPoseJointGroupName, AnimalBodyPoseJointName, AnimalJoint,
    };
    #[cfg(feature = "animals")]
    pub use crate::animals::{
        recognize_animals_in_path, AnimalIdentifier as RecognizedAnimalIdentifier, RecognizedAnimal,
    };
    #[cfg(feature = "body_pose")]
    pub use crate::body_pose::{
        detect_human_body_pose_in_path, detect_human_body_pose_observations_in_path,
        DetectedBodyPose, HumanBodyPoseJointGroupName, HumanBodyPoseJointName,
        HumanBodyPoseObservation, JointPoint,
    };
    #[cfg(feature = "classify")]
    pub use crate::classify::{classify_image_in_path, Classification};
    #[cfg(feature = "contours")]
    pub use crate::contours::{
        detect_contours_in_path, detect_contours_observation_in_path, Contour, ContourOptions,
        ContoursObservation, VisionContour,
    };
    #[cfg(feature = "coreml")]
    pub use crate::coreml::{
        coreml_classify_in_path, coreml_feature_value_in_path, CoreMLFeatureValue,
        CoreMLFeatureValueObservation, CoreMLImageCropAndScaleOption, CoreMLModel, CoreMLRequest,
    };
    #[cfg(feature = "detect_barcodes")]
    pub use crate::detect_barcodes::{
        detect_barcodes_in_path, BarcodeCompositeType as DetectedBarcodeCompositeType,
        BarcodeSymbology as DetectedBarcodeSymbology, DetectedBarcode,
    };
    #[cfg(feature = "detect_faces")]
    pub use crate::detect_faces::{DetectedFace, FaceDetector};
    pub use crate::error::VisionError;
    #[cfg(feature = "face_landmarks")]
    pub use crate::face_landmarks::{
        detect_face_landmarks_in_path, FaceLandmarkRegion, FaceLandmarkRegion2D, FaceLandmarks,
        FaceLandmarks2D, FaceLandmarksRequest, FaceObservationAccepting, FaceWithLandmarks,
        LandmarkPoint, RequestFaceLandmarksConstellation,
    };
    #[cfg(feature = "feature_print")]
    pub use crate::feature_print::{generate_image_feature_print_in_path, FeaturePrint};
    pub use crate::geometry::{
        element_type_size, image_point_for_face_landmark_point, image_point_for_normalized_point,
        image_point_for_normalized_point_using_region_of_interest, image_rect_for_normalized_rect,
        image_rect_for_normalized_rect_using_region_of_interest,
        normalized_face_bounding_box_point_for_landmark_point, normalized_identity_rect,
        normalized_point_for_image_point,
        normalized_point_for_image_point_using_region_of_interest, normalized_rect_for_image_rect,
        normalized_rect_for_image_rect_using_region_of_interest, normalized_rect_is_identity_rect,
        Transform3D, VisionCircle, VisionGeometryUtils, VisionPoint, VisionPoint3D, VisionVector,
    };
    #[cfg(feature = "hand_pose")]
    pub use crate::hand_pose::{
        detect_human_hand_pose_in_path, detect_human_hand_pose_observations_in_path,
        DetectedHandPose, HandChirality, HumanHandPoseJointGroupName, HumanHandPoseJointName,
        HumanHandPoseObservation,
    };
    #[cfg(feature = "horizon")]
    pub use crate::horizon::{
        detect_horizon_in_path, detect_horizon_observation_in_path, AffineTransform,
        HorizonObservation,
    };
    pub use crate::human_body_pose_3d::{
        detect_human_body_pose_3d, detect_human_body_pose_3d_observations,
        detect_human_body_recognized_points_3d, BodyHeightEstimation,
        HumanBodyPose3DJointGroupName, HumanBodyPose3DJointName, HumanBodyPose3DObservation,
        HumanBodyPose3DObservationHeightEstimation, HumanJoint3D,
    };
    #[cfg(feature = "humans")]
    pub use crate::humans::{detect_human_rectangles_in_path, DetectedHuman};
    #[cfg(feature = "optical_flow")]
    pub use crate::optical_flow::{
        generate_optical_flow_in_paths, generate_optical_flow_observation_in_paths,
        OpticalFlowAccuracy,
    };
    #[cfg(feature = "recognize_text")]
    pub use crate::processing::{
        ImageRequestHandler, Observation, RecognizedTextObservation, Request, RequestKind,
        SequenceRequestHandler, TimeRange, VideoCadence, VideoProcessingOptions, VideoProcessor,
        VideoProcessorCadence, VideoProcessorFrameRateCadence,
        VideoProcessorRequestProcessingOptions, VideoProcessorTimeIntervalCadence,
    };
    #[cfg(feature = "recognize_text")]
    pub use crate::recognize_text::{
        BoundingBox, RecognitionLevel, RecognizedText, RecognizedTextCandidate, TextRecognizer,
    };
    pub use crate::recognized_points::{
        HumanBodyRecognizedPoint3D, RecognizedPoint, RecognizedPoint3D,
        RecognizedPoints3DObservation, RecognizedPointsObservation, VisionDetectedPoint,
        VisionRecognizedPoint, VisionRecognizedPoint3D,
    };
    #[cfg(feature = "rectangles")]
    pub use crate::rectangles::{
        detect_document_segmentation_in_path, detect_rectangles_in_path, RectangleObservation,
        RectangleOptions,
    };
    pub use crate::registration::{
        register_homographic, register_homographic_observation, register_translational,
        register_translational_observation, HomographicAlignment, TranslationalAlignment,
    };
    pub use crate::request_base::{
        ImageAlignmentObservation, ImageBasedRequest, ImageRegistrationRequest, NormalizedRect,
        PixelBufferObservation, RequestProgress, RequestProgressHandler, RequestProgressProviding,
        RequestRevisionProviding, StatefulRequest, TargetedImageRequest, TrackingLevel,
        TrackingRequest,
    };
    #[cfg(feature = "saliency")]
    pub use crate::saliency::{attention_saliency_in_path, SalientRegion};
    pub use crate::sdk::{
        vision_version_number, AnimalIdentifier, BarcodeCompositeType, BarcodeSymbology,
        ComputeStage, ElementType, ImageCropAndScaleOption, ImageOption, PointsClassification,
        RecognizedPoint3DGroupKey, RecognizedPointGroupKey, VisionErrorCode, VISION_ERROR_DOMAIN,
    };
    #[cfg(feature = "segmentation")]
    pub use crate::segmentation::{
        generate_foreground_instance_mask_in_path,
        generate_foreground_instance_mask_observation_in_path,
        generate_person_segmentation_in_path, InstanceMask, InstanceMaskObservation,
        SegmentationMask, SegmentationQuality,
    };
    pub use crate::text_rectangles::{
        detect_text_observations, detect_text_rectangles, TextObservation, TextRect,
        TextRectanglesRequest,
    };
    #[cfg(feature = "tracking")]
    pub use crate::tracking::{
        HomographicImageTracker, ObjectTracker, OpticalFlowFrame, OpticalFlowTracker,
        RectangleTracker, TrackOpticalFlowRequestComputationAccuracy, TranslationalImageTracker,
    };
}
