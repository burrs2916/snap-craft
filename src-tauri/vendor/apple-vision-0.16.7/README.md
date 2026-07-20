# vision

Safe Rust bindings for Apple's [Vision](https://developer.apple.com/documentation/vision) framework — on-device OCR, object detection, face landmarks, and other computer vision tasks on macOS.

> **Status:** v0.16.7 keeps the full Vision request surface, expands the Tier-1 `async_api` module to one-shot OCR / face / barcode / segmentation / Core ML / pose / trajectory workflows, and ships a fully-implemented `COVERAGE.md` + `COVERAGE_AUDIT.md` matrix plus a gold-standard multi-file Swift bridge.

## Quick start — OCR

```rust,no_run
use apple_vision::prelude::*;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let recognizer = TextRecognizer::new()
        .with_recognition_level(RecognitionLevel::Accurate)
        .with_language_correction(true);

    let observations = recognizer.recognize_in_path("screenshot.png")?;
    for obs in &observations {
        println!("[{:.2}] '{}'", obs.confidence, obs.text);
    }
    Ok(())
}
```

## Composes with the rest of the doom-fish stack

```text
screencapturekit-rs / capture ──► IOSurface / PNG ──► vision ──► text
                                                          │
                                                          ▼
                                                  foundation-models
                                                  ("summarise this")
```

## Feature flags

All request-type modules can be enabled independently, and the default feature set still enables the full Vision surface. v0.16.7 also carries an optional `async` feature for executor-agnostic `Future` wrappers around the Tier-1 one-shot request surface.

## Async API

Enable `async` plus the request features you need:

```toml
apple-vision = { version = "0.16.7", features = ["async", "recognize_text"] }
```

```rust,ignore
use apple_vision::async_api::AsyncRecognizeText;
use apple_vision::RecognitionLevel;

# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let texts = AsyncRecognizeText::new(RecognitionLevel::Accurate, true)
    .recognize_in_path("screenshot.png")
    .await?;
println!("found {} text observations", texts.len());
# Ok(())
# }
```

Tier-1 currently covers background-worker wrappers for OCR, face detection, barcode detection, person segmentation, `VNCoreMLRequest`, `VNDetectHumanBodyPose3DRequest`, and `VNDetectTrajectoriesRequest`. Multi-fire delegate / stream-style Vision APIs remain future Tier-2 work.

## Roadmap

- [x] Single-image Vision requests (OCR, faces, landmarks, pose, contours, saliency, segmentation, Core ML, and the rest of the stateless request surface)
- [x] Pairwise image-registration requests (`VNTranslationalImageRegistrationRequest`, `VNHomographicImageRegistrationRequest`)
- [x] Stateful tracking requests (`VNTrackObjectRequest`, `VNTrackRectangleRequest`, `VNTrackOpticalFlowRequest`, `VNTrackTranslationalImageRegistrationRequest`, `VNTrackHomographicImageRegistrationRequest`)
- [x] Header-audited request + observation coverage matrix (`COVERAGE.md`) with dedicated wrappers for every current request/observation type and a split Swift bridge (all bridge files stay under 500 lines)
- [x] Explicit `VNRequest` / `VNObservation` / request-handler / `VNVideoProcessor` wrappers for OCR pipelines, plus base request/observation helpers reused across the rest of the crate
- [x] Async API (Tier-1 `Future` wrappers for OCR, face detection, barcode detection, person segmentation, Core ML requests, human-body-pose 3D, and trajectory detection; Tier-2 stream/delegate surfaces still TBD)

## License

Licensed under either of [Apache-2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT) at your option.
