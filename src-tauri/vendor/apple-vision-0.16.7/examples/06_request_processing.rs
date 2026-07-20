//! Smoke test for the explicit `VNRequest` / handler / video-processor API.

use std::fs;
use std::path::PathBuf;

use apple_vision::processing::_test_helper_render_text_video;
use apple_vision::recognize_text::_test_helper_render_text_png;
use apple_vision::{
    ImageRequestHandler, RecognitionLevel, Request, SequenceRequestHandler, VideoCadence,
    VideoProcessingOptions, VideoProcessor,
};

fn fixtures() -> Result<(PathBuf, PathBuf, PathBuf), Box<dyn std::error::Error>> {
    let dir = std::env::current_dir()?
        .join("target")
        .join("vision-example-fixtures")
        .join("06_request_processing");
    fs::create_dir_all(&dir)?;

    let image_a = dir.join("vision.png");
    let image_b = dir.join("rust.png");
    let video = dir.join("vision-rust.mov");

    _test_helper_render_text_png("VISION", 960, 540, &image_a)?;
    _test_helper_render_text_png("RUST", 960, 540, &image_b)?;
    _test_helper_render_text_video("VISION", "RUST", 960, 540, 1, 2, &video)?;

    Ok((image_a, image_b, video))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (image_a, image_b, video) = fixtures()?;
    let request = Request::recognize_text()
        .with_recognition_level(RecognitionLevel::Accurate)
        .with_language_correction(true)
        .with_prefer_background_processing(true);

    println!("Image A: {}", image_a.display());
    println!("Image B: {}", image_b.display());
    println!("Video  : {}", video.display());

    let image_results = ImageRequestHandler::new(&image_a).perform(&request)?;
    println!(
        "\n✅ image request handler ({} observations)",
        image_results.len()
    );
    for observation in image_results.iter().take(3) {
        println!(
            "  [{}] '{}' uuid={} bbox=({:.3}, {:.3}, {:.3}, {:.3})",
            observation.observation.confidence,
            observation.text,
            observation.observation.uuid,
            observation.bounding_box.x,
            observation.bounding_box.y,
            observation.bounding_box.width,
            observation.bounding_box.height,
        );
    }

    let mut sequence_handler = SequenceRequestHandler::new()?;
    let first_frame = sequence_handler.perform(&image_a, &request)?;
    let second_frame = sequence_handler.perform(&image_b, &request)?;
    println!("\n✅ sequence request handler");
    println!("  frame 1 -> {} observations", first_frame.len());
    println!("  frame 2 -> {} observations", second_frame.len());

    let video_results = VideoProcessor::new(&video).analyze(
        &request,
        VideoProcessingOptions::new().with_cadence(VideoCadence::FrameRate(1)),
    )?;
    println!(
        "\n✅ video processor ({} observations)",
        video_results.len()
    );
    for observation in video_results.iter().take(5) {
        let time_range = observation.observation.time_range.map_or_else(
            || "n/a".to_string(),
            |range| {
                format!(
                    "{:.2}s + {:.2}s",
                    range.start_seconds, range.duration_seconds
                )
            },
        );
        println!(
            "  [{}] '{}' @ {} uuid={}",
            observation.observation.confidence,
            observation.text,
            time_range,
            observation.observation.uuid,
        );
    }

    Ok(())
}
