//! Smoke test: render "HELLO WORLD" into a PNG via the Swift test helper,
//! then OCR it with the Vision framework. Verifies the full Rust → C FFI →
//! Swift → Vision → results-back-to-Rust path end-to-end.
//!
//! Run with: `cargo run --example 01_ocr_smoke`

use std::path::PathBuf;

use apple_vision::prelude::*;
use apple_vision::recognize_text::_test_helper_render_text_png;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let fixture_dir = std::env::current_dir()?
        .join("target")
        .join("vision-example-fixtures")
        .join("01_ocr_smoke");
    std::fs::create_dir_all(&fixture_dir)?;
    let png_path: PathBuf = fixture_dir.join("vision_ocr_smoke.png");

    // Render a known string into a PNG so OCR has something to find.
    let target_text = "HELLO WORLD";
    _test_helper_render_text_png(target_text, 480, 120, &png_path)?;
    println!("Rendered '{target_text}' to {}", png_path.display());

    let recognizer = TextRecognizer::new()
        .with_recognition_level(RecognitionLevel::Accurate)
        .with_language_correction(true);

    let observations = recognizer.recognize_in_path(&png_path)?;
    println!("Got {} observations:", observations.len());
    for obs in &observations {
        println!(
            "  [{:.2}] '{}' bbox=({:.3}, {:.3}, {:.3} x {:.3})",
            obs.confidence,
            obs.text,
            obs.bounding_box.x,
            obs.bounding_box.y,
            obs.bounding_box.width,
            obs.bounding_box.height
        );
    }

    // Confirm the recognized text contains the expected words. Vision may
    // produce one observation per text line, or split words across multiple
    // observations depending on layout — we just look for the substring.
    let combined = observations
        .iter()
        .map(|o| o.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        combined.contains("HELLO") || combined.to_uppercase().contains("HELLO"),
        "expected 'HELLO' in OCR output, got: {combined:?}"
    );
    println!("\nOK Vision OCR returned the expected text");
    Ok(())
}
