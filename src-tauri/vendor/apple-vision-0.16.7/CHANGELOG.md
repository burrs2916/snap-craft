# Changelog

## [0.16.7] - 2026-05-20

- Phase 32 completeness + async sweep.
- Added executor-agnostic async wrappers for `VNCoreMLRequest`, `VNDetectHumanBodyPose3DRequest`, and `VNDetectTrajectoriesRequest`.
- Refreshed the coverage docs against `MacOSX26.5.sdk`.

## [0.16.6] - 2026-05-20

- Widen `doom-fish-utils` dependency bound to `<0.4` so the 0.3.x SPSC-ring release resolves cleanly. No source changes.

## [0.16.5] - 2026-05-19

- Bump MSRV from 1.70 to 1.76 to match fleet baseline.

## [0.16.4] - 2026-05-18

- Widen doom-fish-utils version bound to `<0.3` so 0.2.x resolves.

## [0.16.3] - 2026-05-18

- Widen apple-cf version bound to `<0.10` so 0.9.x resolves.

All notable changes to this project will be documented in this file.

## [0.16.2] - 2026-06-16

### Fixed

- **Panic safety (UB fix)**: All four `extern "C"` async callbacks (`text_result_cb`,
  `face_result_cb`, `barcode_result_cb`, `seg_result_cb`) in `async_api` were missing
  panic guards. A Rust panic unwinding through the Swift/C ABI boundary is undefined
  behaviour. Each callback is now wrapped in `std::panic::catch_unwind`; on panic the
  corresponding `AsyncCompletion` future is resolved with an error rather than left
  permanently pending.
- **SAFETY comments**: Added `// SAFETY:` comments to every `unsafe { … }` block and
  `# Safety` doc sections to every `unsafe fn` across the entire crate.
- **`unsafe impl Send/Sync for PersonInstanceMask`**: Added SAFETY rationale explaining
  the type owns its buffer exclusively and shared references are read-only.
- **Cargo.toml**: Updated `apple-cf` to `>=0.7, <0.9` with a local `path` dep so
  Cargo resolves it from the monorepo and avoids a `multiple_crate_versions` lint
  violation from the transitive registry dep.

## [0.16.1] - 2026-06-16

### Fixed

- Added `#available(macOS 26.0, *)` guard around `MLMultiArrayDataType.int8`
  in `copyMultiArrayValues` inside `SegmentationOpticalFlowCoreML.swift`.
  `MLMultiArrayDataTypeInt8` is only present in the macOS 26 SDK; the guard
  allows the bridge to compile with older SDKs (macos-15 / Xcode 16) while
  still handling `int8` multi-arrays correctly at runtime on macOS 26+.

## [0.16.0] - 2026-05-17

### Added (Tier-1 async API)

- Added `async_api` behind the new `async` feature, with executor-agnostic `Future` wrappers for text recognition, face detection, barcode detection, and person segmentation.
- Added DispatchQueue-backed Swift bridge thunks plus async result-container FFI declarations for the four one-shot Tier-1 Vision operations.
- Added async smoke examples `07_async_recognize_text` through `10_async_segmentation` and `tests/async_api_tests.rs`.
- Added the shared `doom-fish-utils` completion dependency plus `pollster` for async examples/tests.

## [0.15.3] - 2026-05-17

### Added (audit-gap completion)

- Added dedicated SDK wrapper modules **`sdk`** and **`geometry`**, covering the remaining public Vision constants / enums / helpers audited from `MacOSX26.2.sdk`: `AnimalIdentifier`, `BarcodeSymbology`, `BarcodeCompositeType`, `ComputeStage`, `ImageOption`, `ImageCropAndScaleOption`, `ElementType`, `PointsClassification`, `VisionErrorCode`, `VISION_ERROR_DOMAIN`, `vision_version_number`, `VisionPoint`, `VisionVector`, `VisionCircle`, `VisionPoint3D`, `VisionGeometryUtils`, and the `VNUtils` free-function family.
- Added explicit wrappers for the remaining landmark / recognized-point / protocol surfaces: `VisionDetectedPoint`, `VisionRecognizedPoint`, `VisionRecognizedPoint3D`, `HumanBodyRecognizedPoint3D`, `FaceLandmarkRegion`, `FaceLandmarkRegion2D`, `FaceLandmarks`, `FaceLandmarks2D`, `FaceLandmarksRequest`, `RequestFaceLandmarksConstellation`, `FaceObservationAccepting`, `RequestProgress`, `RequestProgressProviding`, and `RequestRevisionProviding`.
- Added dedicated pose / cadence / alias surfaces needed to close the remaining SDK audit gaps: animal / body / hand / 3D human joint + group enums, `VideoProcessorCadence`, `VideoProcessorFrameRateCadence`, `VideoProcessorTimeIntervalCadence`, `VideoProcessorRequestProcessingOptions`, `TrackOpticalFlowRequestComputationAccuracy`, `RecognizedTextCandidate`, and the `VisionContour` alias.
- Expanded the 3D human-body bridge to surface `VNHumanBodyRecognizedPoint3D` details (local position + parent joint) and added smoke-test coverage for every new symbol family.
- Refreshed `COVERAGE_AUDIT.md` to mark all 222 current non-exempt public SDK symbols as wrapped.

## [0.15.2] - 2026-05-17

### Added (request/observation wrapper completion)

- Added explicit base request wrappers for `VNImageBasedRequest`, `VNTargetedImageRequest`, `VNStatefulRequest`, `VNTrackingRequest`, and `VNImageRegistrationRequest` (`ImageBasedRequest`, `TargetedImageRequest`, `StatefulRequest`, `TrackingRequest`, `ImageRegistrationRequest`, `TrackingLevel`).
- Added dedicated observation wrappers for the remaining request/observation gaps, including `TextObservation`, `ContoursObservation`, `HorizonObservation`, `HumanBodyPoseObservation`, `HumanHandPoseObservation`, `HumanBodyPose3DObservation`, `RecognizedPointsObservation`, `RecognizedPoints3DObservation`, `ImageAlignmentObservation`, `PixelBufferObservation`, `InstanceMaskObservation`, and `CoreMLFeatureValueObservation`.
- Added `TextRectanglesRequest`, `CoreMLRequest`, `CoreMLModel`, `coreml_feature_value_in_path`, and observation-returning helpers for text rectangles, pose, contours, horizon, registration, optical flow, and instance-mask workflows.
- Added smoke test `tests/request_observations.rs` and refreshed `examples/04_v013_missing_requests.rs` to cover the new public surface.
- Updated `COVERAGE.md` to mark every current Vision request/observation type as implemented and refreshed `COVERAGE_AUDIT.md` for the newly-wrapped request/observation interfaces.

## [0.15.1] - 2026-05-16

### Added (explicit request-processing wrappers)

- Added **`Request`** / **`RequestKind`** — an explicit `VNRequest` wrapper for OCR pipelines, including revision + background/CPU configuration.
- Added **`Observation`** / **`RecognizedTextObservation`** — shared `VNObservation` metadata (`uuid`, confidence, optional time-range) alongside recognized text payloads.
- Added **`ImageRequestHandler`** and **`SequenceRequestHandler`** — dedicated wrappers for `VNImageRequestHandler` and retained `VNSequenceRequestHandler` state.
- Added **`VideoProcessor`**, **`VideoProcessingOptions`**, and **`VideoCadence`** — a `VNVideoProcessor` OCR surface for video files.
- Added smoke test **`tests/request_processing.rs`** and public example **`06_request_processing`**.

## [0.15.0] - 2026-05-16

### Added (request/observation audit + bridge refactor)

- Added **`COVERAGE.md`** — an audited matrix of every current macOS Vision request + observation type, plus renamed / absent legacy symbols (`VNDetectImageAestheticsScoresRequest`, `VNAnimalDetectionRequest`, `VNTrajectoryRequest`).
- Split the Swift bridge into logical-area files so every `swift-bridge/Sources/VisionBridge/*.swift` file stays under the screencapturekit-style ~500-line ceiling.
- Expanded `tests/api_coverage.rs` to account for every current `VN*Request` / `VN*Observation` interface, enforce the multi-file bridge layout, and reject temporary-path usage in public docs/examples.
- Moved example fixture output from temp paths into `target/vision-example-fixtures/`, matching the headless example pattern used elsewhere in the doom-fish Apple crates.
- Dropped the sibling-repo `path = "../apple-cf-rs"` override so the crate now validates against the published `apple-cf` 0.5.x release instead of any dirty local checkout.

## [0.14.0] - 2026-05-16

### Added (5 stateful tracking request types — completes Vision request coverage)

- **`ObjectTracker`** — `VNTrackObjectRequest` — retains a sequence request handler + request and updates the tracked object observation across frames.
- **`RectangleTracker`** — `VNTrackRectangleRequest` — retains a rectangle observation and tracks it across subsequent frames.
- **`OpticalFlowTracker`** — `VNTrackOpticalFlowRequest` (macOS 14+) — returns the per-frame optical-flow pixel buffer as copied raw bytes.
- **`TranslationalImageTracker`** — `VNTrackTranslationalImageRegistrationRequest` (macOS 14+) — returns per-frame translational alignment.
- **`HomographicImageTracker`** — `VNTrackHomographicImageRegistrationRequest` (macOS 14+) — returns per-frame homography.
- New example **`05_tracking`** exercises all five trackers against generated fixture frames.

## [0.13.0] - 2026-05-16

### Added (8 missing Vision request types — pushes coverage to 100% for single-frame surface)

- **`detect_animal_body_pose`** — `VNDetectAnimalBodyPoseRequest`
  (macOS 14+) — body-pose keypoints for cats, dogs and similar
  quadrupeds.
- **`detect_human_body_pose_3d`** — `VNDetectHumanBodyPose3DRequest`
  (macOS 14+) — 3D human-body keypoints.
- **`detect_text_rectangles`** — `VNDetectTextRectanglesRequest` —
  text-region detection without OCR.
- **`objectness_saliency`** —
  `VNGenerateObjectnessBasedSaliencyImageRequest` — discrete
  salient-object regions (complements the existing attention-based
  saliency).
- **`person_instance_mask`** —
  `VNGeneratePersonInstanceMaskRequest` (macOS 14+) — per-person
  instance mask returned as an 8-bit grayscale `PersonInstanceMask`.
- **`detect_trajectories`** — `VNDetectTrajectoriesRequest` — parabolic-
  trajectory detection (single-frame call returns 0 results; the
  proper stateful API lands in v0.14).
- **`register_translational`** —
  `VNTranslationalImageRegistrationRequest` — 2D translation
  between two images.
- **`register_homographic`** —
  `VNHomographicImageRegistrationRequest` — 3×3 perspective
  homography between two images.

Swift bridge: existing `Vision.swift` helpers (`loadCGImage`,
`ffiString`, status codes) are now `internal` so the new
`MissingRequests.swift` file can reuse them. New example
`04_v013_missing_requests` exercises all 8 surfaces on M4 Max.

## [0.3.0] - Unreleased

### Added

- **Face detection** — `FaceDetector` wraps `VNDetectFaceRectanglesRequest`.
  Both `detect_in_path(&Path)` and `detect_in_pixel_buffer(&CVPixelBuffer)`
  are supported. `DetectedFace` carries bounding box, confidence, and
  `Option<f32>` roll/yaw/pitch (optionals reflect older request revisions
  that don't report all three angles).
- `detect_faces` feature flag (on by default).
- Smoke test `03_face_detect` runs on a blank image (asserting 0 faces) and
  optionally on a user-supplied image path.
- API harness extended to `VNDetectFaceRectanglesRequest` and
  `VNFaceObservation` — 6/6 tests at 100% coverable.

## [0.2.0] - Unreleased

### Added (BREAKING — adds dependency)

- **`apple-cf` as a dependency** (with `cv` + `iosurface` features) so the
  bridge can speak `CVPixelBuffer` directly.
- `TextRecognizer::recognize_in_pixel_buffer(&CVPixelBuffer)` — zero-copy
  OCR path for live capture pipelines (screencapturekit / videotoolbox
  decoder / AVCaptureSession). No PNG round-trip, no bytes copied between
  Vision and the pixel data.
- `vn_recognize_text_in_pixel_buffer` `@_cdecl` export driving
  `VNImageRequestHandler(cvPixelBuffer:)`.
- Smoke test `02_ocr_pixel_buffer` runs OCR through both the file and
  pixel-buffer paths against the same render, proving Vision accepts a
  CVPixelBuffer end-to-end.

## [0.1.0] - Initial release

### Added

- `TextRecognizer` wraps `VNRecognizeTextRequest` for image-file OCR.
- `RecognitionLevel { Fast, Accurate }` mirrors `VNRequestTextRecognitionLevel`.
- `RecognizedText { text, confidence, bounding_box }` carries Vision's
  observations; `BoundingBox` is in normalised (0..=1) image coordinates
  with origin at the bottom-left.
- `recognize_text` feature flag (on by default) lets future detect/classify
  features stay independently optional.
- Swift bridge wraps `VNImageRequestHandler` + `VNRecognizeTextRequest`
  behind a single synchronous `vn_recognize_text_in_path` call. Result
  arrays are heap-allocated and freed via `vn_recognized_text_free`.
- Smoke test `01_ocr_smoke` renders 'HELLO WORLD' to a PNG via a Swift
  CGContext helper, OCRs it, and asserts on the returned text.
  Verified: confidence 1.00, exact match, normalized bbox.
- API coverage harness verifies our wrappers against
  `VNRecognizeTextRequest` / `VNRecognizedTextObservation` /
  `VNImageRequestHandler` / `VNRequestTextRecognitionLevel` from the
  Vision `.swiftinterface`. 4/4 tests pass at 100% coverable.
