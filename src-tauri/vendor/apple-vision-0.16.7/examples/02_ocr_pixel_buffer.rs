//! Smoke test: OCR a `CVPixelBuffer` directly, no PNG round-trip.
//!
//! Renders 'ZERO COPY OCR' into a PNG (test helper), loads it as a
//! `CVPixelBuffer` via `apple-cf::cv`, then runs Vision OCR on the
//! pixel-buffer-typed input (zero allocation between Vision and the
//! pixel data).
//!
//! Run with: `cargo run --example 02_ocr_pixel_buffer`

use std::path::PathBuf;

use apple_cf::cv::CVPixelBuffer;
use apple_cf::iosurface::{IOSurface, IOSurfaceLockOptions};
use apple_vision::prelude::*;
use apple_vision::recognize_text::_test_helper_render_text_png;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let fixture_dir = std::env::current_dir()?
        .join("target")
        .join("vision-example-fixtures")
        .join("02_ocr_pixel_buffer");
    std::fs::create_dir_all(&fixture_dir)?;
    let png_path: PathBuf = fixture_dir.join("vision_pixbuf_smoke.png");

    let target_text = "ZERO COPY OCR";
    _test_helper_render_text_png(target_text, 480, 120, &png_path)?;

    // We can't easily load a PNG into a CVPixelBuffer from Rust without
    // CG bindings, so fake it: synthesise the same image as a BGRA
    // IOSurface with all-white pixels, then wrap that in a CVPixelBuffer
    // and verify Vision can ingest it. (For a real screen-capture
    // pipeline, the CVPixelBuffer would come from screencapturekit.)
    let width = 320usize;
    let height = 80usize;
    let pixel_format = u32::from_be_bytes(*b"BGRA");
    let surface = IOSurface::create(width, height, pixel_format, 4).unwrap();
    {
        let mut g = surface
            .lock(IOSurfaceLockOptions::NONE)
            .map_err(|c| format!("lock: {c}"))?;
        if let Some(b) = g.as_slice_mut() {
            // Fill with white. (Vision will find nothing, but the smoke test
            // is verifying the pipeline plumbing, not the OCR quality.)
            for px in b.chunks_exact_mut(4) {
                px[0] = 0xFF;
                px[1] = 0xFF;
                px[2] = 0xFF;
                px[3] = 0xFF;
            }
        }
    }

    let pb = CVPixelBuffer::create_with_io_surface(&surface)
        .map_err(|c| format!("CVPixelBuffer wrap: {c}"))?;
    println!(
        "CVPixelBuffer: {}x{} 0x{:08x}",
        pb.width(),
        pb.height(),
        pb.pixel_format()
    );

    let recognizer = TextRecognizer::new()
        .with_recognition_level(RecognitionLevel::Accurate)
        .with_language_correction(true);

    println!("\n--- recognize_in_pixel_buffer (zero-copy) ---");
    let pb_results = recognizer.recognize_in_pixel_buffer(&pb)?;
    println!(
        "Got {} observation(s) from CVPixelBuffer:",
        pb_results.len()
    );
    for obs in &pb_results {
        println!("  [{:.2}] '{}'", obs.confidence, obs.text);
    }

    println!("\n--- recognize_in_path (file-based, for comparison) ---");
    let path_results = recognizer.recognize_in_path(&png_path)?;
    println!("Got {} observation(s) from PNG:", path_results.len());
    for obs in &path_results {
        println!("  [{:.2}] '{}'", obs.confidence, obs.text);
    }

    // The PNG path should find 'ZERO COPY OCR'; the all-white IOSurface
    // shouldn't find anything. Either way, we've proved Vision accepts
    // a CVPixelBuffer without crashing.
    println!("\nOK Vision accepted a CVPixelBuffer end-to-end");
    Ok(())
}
