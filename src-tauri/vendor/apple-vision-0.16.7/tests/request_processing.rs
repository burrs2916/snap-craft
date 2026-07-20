use std::fs;
use std::path::PathBuf;

use apple_vision::processing::_test_helper_render_text_video;
use apple_vision::recognize_text::_test_helper_render_text_png;
use apple_vision::{
    ComputeStage, ImageOption, ImageRequestHandler, RecognitionLevel, RecognizedTextCandidate,
    Request, RequestKind, RequestRevisionProviding, SequenceRequestHandler, VideoCadence,
    VideoProcessingOptions, VideoProcessor, VideoProcessorCadence, VideoProcessorFrameRateCadence,
    VideoProcessorTimeIntervalCadence,
};

fn fixtures_dir() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let dir = std::env::current_dir()?
        .join("target")
        .join("vision-test-fixtures")
        .join("request-processing");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn contains_text(observations: &[apple_vision::RecognizedTextObservation], needle: &str) -> bool {
    let needle = needle.to_ascii_uppercase();
    observations
        .iter()
        .any(|observation| observation.text.to_ascii_uppercase().contains(&needle))
}

#[test]
fn request_handlers_and_video_processor_smoke() -> Result<(), Box<dyn std::error::Error>> {
    let dir = fixtures_dir()?;
    let image_a = dir.join("vision.png");
    let image_b = dir.join("rust.png");
    let video = dir.join("vision-rust.mov");

    _test_helper_render_text_png("VISION", 960, 540, &image_a)?;
    _test_helper_render_text_png("RUST", 960, 540, &image_b)?;
    _test_helper_render_text_video("VISION", "RUST", 960, 540, 1, 2, &video)?;

    let request = Request::recognize_text()
        .with_recognition_level(RecognitionLevel::Accurate)
        .with_language_correction(true)
        .with_prefer_background_processing(true)
        .with_revision(2);
    assert_eq!(request.kind(), RequestKind::RecognizeText);
    assert_eq!(
        RequestRevisionProviding::request_revision(&request),
        Some(2)
    );
    assert_eq!(Request::supported_compute_stages(), ComputeStage::ALL);
    assert_eq!(
        ImageRequestHandler::supported_image_options(),
        ImageOption::ALL
    );

    let image_observations = ImageRequestHandler::new(&image_a).perform(&request)?;
    assert!(!image_observations.is_empty());
    assert!(contains_text(&image_observations, "VISION"));
    assert!(image_observations
        .iter()
        .all(|observation| !observation.observation.uuid.is_empty()));
    let plain_text = image_observations[0].as_recognized_text();
    assert!(plain_text.confidence >= 0.0);
    let candidate: RecognizedTextCandidate = image_observations[0].candidate();
    assert_eq!(candidate.text, plain_text.text);

    let mut sequence_handler = SequenceRequestHandler::new()?;
    let first_frame = sequence_handler.perform(&image_a, &request)?;
    let second_frame = sequence_handler.perform(&image_b, &request)?;
    assert!(contains_text(&first_frame, "VISION"));
    assert!(contains_text(&second_frame, "RUST"));

    let cadence = VideoProcessorFrameRateCadence {
        frames_per_second: 1,
    }
    .as_video_processor_cadence();
    assert_eq!(cadence.cadence, VideoCadence::FrameRate(1));
    let time_interval =
        VideoProcessorTimeIntervalCadence { seconds: 0.5 }.as_video_processor_cadence();
    assert_eq!(
        time_interval.cadence,
        VideoCadence::TimeIntervalSeconds(0.5)
    );
    let video_observations = VideoProcessor::new(&video).analyze(
        &request,
        VideoProcessingOptions::new()
            .with_video_processor_cadence(VideoProcessorCadence::frame_rate(1)),
    )?;
    assert!(!video_observations.is_empty());
    assert!(video_observations
        .iter()
        .all(|observation| !observation.observation.uuid.is_empty()));
    assert!(
        contains_text(&video_observations, "VISION") || contains_text(&video_observations, "RUST")
    );

    Ok(())
}
