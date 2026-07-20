//! Tests for the `async_api` module.
//!
//! These tests require the `async` feature plus the relevant per-request
//! features. Run with: `cargo test --all-features`

#![cfg(feature = "async")]

#[cfg(feature = "recognize_text")]
#[test]
fn async_recognize_text_nonexistent_path() {
    let result = pollster::block_on(async {
        apple_vision::async_api::AsyncRecognizeText::default()
            .recognize_in_path("/this/path/does/not/exist.png")
            .await
    });
    assert!(result.is_err(), "expected error for nonexistent path");
}

#[cfg(feature = "detect_faces")]
#[test]
fn async_detect_faces_nonexistent_path() {
    let result = pollster::block_on(async {
        apple_vision::async_api::AsyncDetectFaces::new()
            .detect_in_path("/nonexistent/image.jpg")
            .await
    });
    assert!(result.is_err());
}

#[cfg(feature = "detect_barcodes")]
#[test]
fn async_detect_barcodes_nonexistent_path() {
    let result = pollster::block_on(async {
        apple_vision::async_api::AsyncDetectBarcodes::new()
            .detect_in_path("/nonexistent/image.jpg")
            .await
    });
    assert!(result.is_err());
}

#[cfg(feature = "segmentation")]
#[test]
fn async_person_segmentation_nonexistent_path() {
    let result = pollster::block_on(async {
        apple_vision::async_api::AsyncPersonSegmentation::default()
            .generate_in_path("/nonexistent/image.jpg")
            .await
    });
    assert!(result.is_err());
}

#[cfg(feature = "recognize_text")]
#[test]
fn async_recognize_text_invalid_path_nul() {
    let result = pollster::block_on(async {
        apple_vision::async_api::AsyncRecognizeText::default()
            .recognize_in_path("path/with\0nul")
            .await
    });
    assert!(result.is_err());
}
