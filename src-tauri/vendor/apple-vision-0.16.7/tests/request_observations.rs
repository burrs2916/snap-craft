use std::fs;
use std::path::PathBuf;

use apple_vision::recognize_text::_test_helper_render_text_png;
use apple_vision::ContourOptions;
use apple_vision::{
    detect_contours_observation_in_path, detect_horizon_observation_in_path,
    detect_human_body_pose_3d_observations, detect_human_body_pose_observations_in_path,
    detect_human_hand_pose_observations_in_path, element_type_size,
    image_point_for_normalized_point, normalized_identity_rect, normalized_point_for_image_point,
    vision_version_number, AnimalBodyPoseJointGroupName, AnimalBodyPoseJointName, AnimalIdentifier,
    AnimalJoint, BarcodeCompositeType, BarcodeSymbology, BoundingBox, ComputeStage,
    CoreMLImageCropAndScaleOption, CoreMLModel, CoreMLRequest, ElementType, FaceLandmarksRequest,
    FaceObservationAccepting, HumanBodyPose3DJointGroupName, HumanBodyPose3DJointName,
    HumanBodyPoseJointGroupName, HumanBodyPoseJointName, HumanBodyRecognizedPoint3D,
    HumanHandPoseJointGroupName, HumanHandPoseJointName, ImageAlignmentObservation,
    ImageBasedRequest, ImageCropAndScaleOption, ImageOption, ImageRegistrationRequest,
    NormalizedRect, PixelBufferObservation, PointsClassification, RecognizedPoint3DGroupKey,
    RecognizedPointGroupKey, RequestFaceLandmarksConstellation, RequestProgress,
    RequestProgressProviding, RequestRevisionProviding, StatefulRequest, TargetedImageRequest,
    TextRectanglesRequest, TrackOpticalFlowRequestComputationAccuracy, TrackingLevel,
    TrackingRequest, Transform3D, TranslationalAlignment, VisionCircle, VisionContour,
    VisionDetectedPoint, VisionErrorCode, VisionGeometryUtils, VisionPoint, VisionRecognizedPoint,
    VisionRecognizedPoint3D, VisionVector, VISION_ERROR_DOMAIN,
};

fn fixtures_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = std::env::current_dir()?
        .join("target")
        .join("vision-test-fixtures")
        .join("request-observations");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[test]
#[allow(clippy::too_many_lines)]
fn request_and_observation_wrappers_smoke() -> Result<(), Box<dyn std::error::Error>> {
    let dir = fixtures_dir()?;
    let image = dir.join("vision.png");
    _test_helper_render_text_png("VISION", 960, 540, &image)?;

    let image_based = ImageBasedRequest::new()
        .with_region_of_interest(NormalizedRect::new(0.1, 0.1, 0.8, 0.8))
        .with_prefer_background_processing(true)
        .with_uses_cpu_only(true)
        .with_revision(1);
    assert!((image_based.region_of_interest().unwrap().width - 0.8).abs() < f64::EPSILON);

    let targeted = TargetedImageRequest::new(&image);
    assert_eq!(targeted.targeted_image_path(), image.as_path());

    let stateful = StatefulRequest::new()
        .with_frame_analysis_spacing_seconds(0.5)
        .with_minimum_latency_frame_count(2);
    assert_eq!(stateful.minimum_latency_frame_count(), 2);

    let tracking = TrackingRequest::new()
        .with_tracking_level(TrackingLevel::Accurate)
        .with_last_frame(true)
        .with_input_observation(NormalizedRect::new(0.2, 0.2, 0.4, 0.4));
    assert!(tracking.is_last_frame());

    let registration = ImageRegistrationRequest::new(&image);
    assert_eq!(
        registration.targeted_image_request().targeted_image_path(),
        image.as_path()
    );
    assert_eq!(
        RequestRevisionProviding::request_revision(&registration),
        None
    );

    let progress = RequestProgress::new().with_indeterminate(true);
    assert!(RequestProgressProviding::is_indeterminate(&progress));
    assert!(RequestProgressProviding::progress_handler(&progress).is_none());
    assert_eq!(RequestRevisionProviding::request_revision(&stateful), None);
    assert_eq!(
        RequestRevisionProviding::request_revision(&image_based),
        Some(1)
    );

    let face_request = FaceLandmarksRequest::new()
        .with_image_based_request(image_based.clone())
        .with_constellation(RequestFaceLandmarksConstellation::Points65)
        .with_input_face_observations(vec![BoundingBox {
            x: 0.2,
            y: 0.2,
            width: 0.4,
            height: 0.4,
        }]);
    assert!(FaceLandmarksRequest::supports_constellation(
        3,
        RequestFaceLandmarksConstellation::Points76
    ));
    assert_eq!(
        face_request.constellation(),
        Some(RequestFaceLandmarksConstellation::Points65)
    );
    assert_eq!(
        FaceObservationAccepting::input_face_observations(&face_request).len(),
        1
    );

    let request = TextRectanglesRequest::new()
        .with_image_based_request(image_based.clone())
        .with_report_character_boxes(true);
    let text_observations = request.perform(&image)?;
    assert!(!text_observations.is_empty());

    let contours = detect_contours_observation_in_path(&image, ContourOptions::default())?;
    assert_eq!(
        contours.top_level_contour_count,
        contours.top_level_contours.len()
    );
    if let Some(contour) = contours.top_level_contours.first() {
        let contour_alias: VisionContour = contour.clone();
        assert_eq!(contour_alias.points, contour.points);
    }

    let horizon = detect_horizon_observation_in_path(&image)?;
    if let Some(observation) = horizon {
        let transform = observation.transform_for_image(960.0, 540.0);
        assert!(transform.a.is_finite());
    }

    let _body_poses = detect_human_body_pose_observations_in_path(&image)?;
    let _hand_poses = detect_human_hand_pose_observations_in_path(&image, 2)?;
    let _body_poses_3d = detect_human_body_pose_3d_observations(&image)?;

    let coreml_request = CoreMLRequest::new("model.mlmodel")
        .with_model(CoreMLModel::new("model.mlmodel").with_input_image_feature_name("image"))
        .with_image_based_request(image_based)
        .with_image_crop_and_scale_option(CoreMLImageCropAndScaleOption::ScaleFit);
    assert_eq!(
        coreml_request.image_crop_and_scale_option(),
        CoreMLImageCropAndScaleOption::ScaleFit
    );
    assert_eq!(
        coreml_request.model().input_image_feature_name(),
        Some("image")
    );

    let pixel_buffer =
        PixelBufferObservation::new(2, 2, 2, vec![0, 1, 2, 3]).with_feature_name("mask");
    assert_eq!(pixel_buffer.as_bytes(), &[0, 1, 2, 3]);
    assert_eq!(pixel_buffer.feature_name.as_deref(), Some("mask"));

    let alignment =
        ImageAlignmentObservation::translational(TranslationalAlignment { tx: 0.0, ty: 0.0 });
    match alignment {
        ImageAlignmentObservation::Translational(value) => {
            assert!(value.tx.abs() < f64::EPSILON);
        }
        ImageAlignmentObservation::Homographic(_) => unreachable!(),
    }

    Ok(())
}

#[test]
fn sdk_geometry_and_pose_wrappers_smoke() {
    assert_eq!(AnimalIdentifier::Dog.as_str(), "Dog");
    assert_eq!(BarcodeSymbology::Qr.as_str(), "VNBarcodeSymbologyQR");
    assert_eq!(BarcodeCompositeType::Gs1TypeA.as_raw(), 2);
    assert_eq!(ComputeStage::Main.as_str(), "VNComputeStageMain");
    assert_eq!(ImageOption::Properties.as_str(), "VNImageOptionProperties");
    assert_eq!(RecognizedPointGroupKey::All.as_str(), "VNIPOAll");
    assert_eq!(RecognizedPoint3DGroupKey::All.as_str(), "VNIPOAll");
    assert_eq!(
        ImageCropAndScaleOption::ScaleFillRotate90Ccw.as_raw(),
        0x102
    );
    assert_eq!(ElementType::Float32.size_in_bytes(), 4);
    assert_eq!(element_type_size(ElementType::Float64), 8);
    assert_eq!(PointsClassification::ClosedPath.as_raw(), 2);
    assert_eq!(VisionErrorCode::Timeout.as_raw(), 20);
    assert_eq!(
        TrackOpticalFlowRequestComputationAccuracy::VeryHigh as i32,
        3
    );
    assert_eq!(VISION_ERROR_DOMAIN, "com.apple.Vision");
    assert!(vision_version_number().is_finite());

    let point = VisionPoint::new(0.25, 0.75);
    let moved = point.apply_vector(VisionVector::new(0.25, -0.25));
    assert_eq!(moved, VisionPoint::new(0.5, 0.5));
    let image_point = image_point_for_normalized_point(point, 200, 100);
    let normalized = normalized_point_for_image_point(image_point, 200, 100);
    assert!((normalized.x - point.x).abs() < 0.01);
    assert!((normalized.y - point.y).abs() < 0.01);
    assert!(normalized_identity_rect().width.is_finite());

    let circle = VisionCircle::new(VisionPoint::zero(), 2.0);
    assert!(circle.contains_point(VisionPoint::new(1.0, 0.0)));
    let polygon = [
        VisionPoint::new(0.0, 0.0),
        VisionPoint::new(2.0, 0.0),
        VisionPoint::new(2.0, 2.0),
        VisionPoint::new(0.0, 2.0),
    ];
    assert_eq!(
        VisionGeometryUtils::calculate_area(&polygon, false),
        Some(4.0)
    );
    assert_eq!(
        VisionGeometryUtils::calculate_perimeter(&polygon),
        Some(8.0)
    );
    assert!(VisionGeometryUtils::bounding_circle_for_points(&polygon).is_some());

    let detected = VisionDetectedPoint::new(VisionPoint::new(0.1, 0.2), 0.9);
    let recognized = VisionRecognizedPoint::new("joint", detected);
    assert!((recognized.point.confidence - 0.9).abs() < f32::EPSILON);
    let recognized_3d = VisionRecognizedPoint3D::new(
        "root",
        apple_vision::VisionPoint3D::from_xyz(1.0, 2.0, 3.0),
        0.8,
    );
    let human_point = HumanBodyRecognizedPoint3D::new(
        recognized_3d,
        Transform3D::from_translation(0.1, 0.2, 0.3),
        Some(HumanBodyPose3DJointName::Root.as_str().to_string()),
    );
    assert_eq!(human_point.parent_joint.as_deref(), Some("human_root_3D"));

    assert_eq!(HumanBodyPoseJointName::Nose.as_str(), "head_joint");
    assert_eq!(HumanBodyPoseJointGroupName::All.as_str(), "VNIPOAll");
    assert_eq!(HumanHandPoseJointName::Wrist.as_str(), "VNHLKWRI");
    assert_eq!(HumanHandPoseJointGroupName::Thumb.as_str(), "VNHLRKT");
    assert_eq!(
        HumanBodyPose3DJointName::CenterHead.as_str(),
        "human_center_head_3D"
    );
    assert_eq!(
        HumanBodyPose3DJointGroupName::Head.as_str(),
        "human_joint_group_head_3D"
    );
    assert_eq!(AnimalBodyPoseJointName::Neck.as_str(), "animal_joint_heck");
    assert_eq!(
        AnimalBodyPoseJointGroupName::Forelegs.as_str(),
        "animal_joint_group_gorelegs"
    );
    let animal_joint = AnimalJoint {
        name: AnimalBodyPoseJointName::LeftEarTop.as_str().to_string(),
        x: 0.0,
        y: 0.0,
        confidence: 1.0,
    };
    assert_eq!(
        animal_joint.joint_name(),
        Some(AnimalBodyPoseJointName::LeftEarTop)
    );
}
