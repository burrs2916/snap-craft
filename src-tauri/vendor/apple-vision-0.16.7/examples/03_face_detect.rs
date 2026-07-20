//! Smoke test for face detection. Verifies the plumbing on a blank image
//! (expected: 0 faces). For real face detection, point this at a portrait
//! photograph of your choosing.
//!
//! Run with: `cargo run --example 03_face_detect`
//! With a custom image: `cargo run --example 03_face_detect -- ~/Pictures/portrait.jpg`

use std::path::PathBuf;

use apple_vision::detect_faces::FaceDetector;
use apple_vision::recognize_text::_test_helper_render_text_png;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path: PathBuf = std::env::args().nth(1).map_or_else(
        || {
            let fixture_dir = std::env::current_dir()
                .expect("cwd")
                .join("target")
                .join("vision-example-fixtures")
                .join("03_face_detect");
            std::fs::create_dir_all(&fixture_dir).expect("fixture dir");

            // Default: render a blank "page" — face detection should
            // return zero faces on it. Verifies the API plumbing works.
            let path = fixture_dir.join("vision_face_smoke.png");
            _test_helper_render_text_png("", 320, 240, &path).expect("render");
            path
        },
        PathBuf::from,
    );
    println!("Detecting faces in: {}", path.display());

    let detector = FaceDetector::new();
    let faces = detector.detect_in_path(&path)?;
    println!("Found {} face(s):", faces.len());
    for (i, face) in faces.iter().enumerate() {
        println!(
            "  face {i}: bbox=({:.3}, {:.3}, {:.3} x {:.3}) confidence={:.2} roll={:?} yaw={:?} pitch={:?}",
            face.bounding_box.x,
            face.bounding_box.y,
            face.bounding_box.width,
            face.bounding_box.height,
            face.confidence,
            face.roll,
            face.yaw,
            face.pitch
        );
    }

    if std::env::args().nth(1).is_none() {
        // Default blank-image path: assert no faces (sanity check on plumbing).
        assert!(faces.is_empty(), "blank image should yield 0 faces");
        println!("\nOK Blank-image plumbing check passed (0 faces, as expected).");
        println!("    Run with `cargo run --example 03_face_detect -- <path-to-portrait.jpg>`");
        println!("    to test on a real face photo.");
    } else {
        println!("\nOK Face detection ran end-to-end.");
    }
    Ok(())
}
