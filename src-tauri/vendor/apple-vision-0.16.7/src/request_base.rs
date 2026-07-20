//! Shared request / observation building blocks for Vision base classes.

use std::path::{Path, PathBuf};

use crate::registration::{HomographicAlignment, TranslationalAlignment};

/// Function-pointer shape used by [`RequestProgress`] /
/// [`RequestProgressProviding`].
pub type RequestProgressHandler = fn(f64);

/// Mirrors the observable state carried by `VNRequestProgressProviding`.
#[derive(Debug, Clone, Copy, Default)]
pub struct RequestProgress {
    progress_handler: Option<RequestProgressHandler>,
    indeterminate: bool,
}

impl RequestProgress {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            progress_handler: None,
            indeterminate: false,
        }
    }

    #[must_use]
    pub const fn with_progress_handler(mut self, progress_handler: RequestProgressHandler) -> Self {
        self.progress_handler = Some(progress_handler);
        self
    }

    #[must_use]
    pub const fn with_indeterminate(mut self, indeterminate: bool) -> Self {
        self.indeterminate = indeterminate;
        self
    }

    #[must_use]
    pub const fn progress_handler(&self) -> Option<RequestProgressHandler> {
        self.progress_handler
    }

    #[must_use]
    pub const fn is_indeterminate(&self) -> bool {
        self.indeterminate
    }
}

/// Rust mirror of `VNRequestProgressProviding`.
pub trait RequestProgressProviding {
    fn progress_handler(&self) -> Option<RequestProgressHandler>;
    fn is_indeterminate(&self) -> bool;
}

impl RequestProgressProviding for RequestProgress {
    fn progress_handler(&self) -> Option<RequestProgressHandler> {
        self.progress_handler()
    }

    fn is_indeterminate(&self) -> bool {
        self.is_indeterminate()
    }
}

/// Rust mirror of `VNRequestRevisionProviding`.
pub trait RequestRevisionProviding {
    fn request_revision(&self) -> Option<usize>;
}

/// A normalized rectangle in Vision image coordinates (`0.0..=1.0`, lower-left origin).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NormalizedRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl NormalizedRect {
    #[must_use]
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

/// Common configuration shared by `VNImageBasedRequest` subclasses.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ImageBasedRequest {
    region_of_interest: Option<NormalizedRect>,
    prefer_background_processing: bool,
    uses_cpu_only: bool,
    revision: Option<usize>,
}

impl ImageBasedRequest {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            region_of_interest: None,
            prefer_background_processing: false,
            uses_cpu_only: false,
            revision: None,
        }
    }

    #[must_use]
    pub const fn with_region_of_interest(mut self, region_of_interest: NormalizedRect) -> Self {
        self.region_of_interest = Some(region_of_interest);
        self
    }

    #[must_use]
    pub const fn with_prefer_background_processing(mut self, enabled: bool) -> Self {
        self.prefer_background_processing = enabled;
        self
    }

    #[must_use]
    pub const fn with_uses_cpu_only(mut self, enabled: bool) -> Self {
        self.uses_cpu_only = enabled;
        self
    }

    #[must_use]
    pub const fn with_revision(mut self, revision: usize) -> Self {
        self.revision = Some(revision);
        self
    }

    #[must_use]
    pub const fn region_of_interest(&self) -> Option<NormalizedRect> {
        self.region_of_interest
    }

    #[must_use]
    pub const fn prefer_background_processing(&self) -> bool {
        self.prefer_background_processing
    }

    #[must_use]
    pub const fn uses_cpu_only(&self) -> bool {
        self.uses_cpu_only
    }

    #[must_use]
    pub const fn revision(&self) -> Option<usize> {
        self.revision
    }
}

impl RequestRevisionProviding for ImageBasedRequest {
    fn request_revision(&self) -> Option<usize> {
        self.revision()
    }
}

/// A Rust wrapper for the abstract `VNTargetedImageRequest` base class.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetedImageRequest {
    targeted_image_path: PathBuf,
}

impl TargetedImageRequest {
    #[must_use]
    pub fn new(targeted_image_path: impl AsRef<Path>) -> Self {
        Self {
            targeted_image_path: targeted_image_path.as_ref().to_path_buf(),
        }
    }

    #[must_use]
    pub fn targeted_image_path(&self) -> &Path {
        &self.targeted_image_path
    }
}

impl RequestRevisionProviding for TargetedImageRequest {
    fn request_revision(&self) -> Option<usize> {
        None
    }
}

/// A Rust wrapper for the abstract `VNStatefulRequest` base class.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StatefulRequest {
    frame_analysis_spacing_seconds: Option<f64>,
    minimum_latency_frame_count: usize,
}

impl Default for StatefulRequest {
    fn default() -> Self {
        Self::new()
    }
}

impl StatefulRequest {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            frame_analysis_spacing_seconds: None,
            minimum_latency_frame_count: 0,
        }
    }

    #[must_use]
    pub const fn with_frame_analysis_spacing_seconds(mut self, seconds: f64) -> Self {
        self.frame_analysis_spacing_seconds = Some(seconds);
        self
    }

    #[must_use]
    pub const fn with_minimum_latency_frame_count(mut self, frame_count: usize) -> Self {
        self.minimum_latency_frame_count = frame_count;
        self
    }

    #[must_use]
    pub const fn frame_analysis_spacing_seconds(&self) -> Option<f64> {
        self.frame_analysis_spacing_seconds
    }

    #[must_use]
    pub const fn minimum_latency_frame_count(&self) -> usize {
        self.minimum_latency_frame_count
    }
}

impl RequestRevisionProviding for StatefulRequest {
    fn request_revision(&self) -> Option<usize> {
        None
    }
}

/// Mirrors `VNRequestTrackingLevel` used by `VNTrackingRequest` subclasses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TrackingLevel {
    Accurate,
    Fast,
}

/// A Rust wrapper for the abstract `VNTrackingRequest` base class.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackingRequest {
    tracking_level: TrackingLevel,
    last_frame: bool,
    input_observation: Option<NormalizedRect>,
}

impl Default for TrackingRequest {
    fn default() -> Self {
        Self::new()
    }
}

impl TrackingRequest {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            tracking_level: TrackingLevel::Fast,
            last_frame: false,
            input_observation: None,
        }
    }

    #[must_use]
    pub const fn with_tracking_level(mut self, tracking_level: TrackingLevel) -> Self {
        self.tracking_level = tracking_level;
        self
    }

    #[must_use]
    pub const fn with_last_frame(mut self, last_frame: bool) -> Self {
        self.last_frame = last_frame;
        self
    }

    #[must_use]
    pub const fn with_input_observation(mut self, input_observation: NormalizedRect) -> Self {
        self.input_observation = Some(input_observation);
        self
    }

    #[must_use]
    pub const fn tracking_level(&self) -> TrackingLevel {
        self.tracking_level
    }

    #[must_use]
    pub const fn is_last_frame(&self) -> bool {
        self.last_frame
    }

    #[must_use]
    pub const fn input_observation(&self) -> Option<NormalizedRect> {
        self.input_observation
    }
}

impl RequestRevisionProviding for TrackingRequest {
    fn request_revision(&self) -> Option<usize> {
        None
    }
}

/// A Rust wrapper for the abstract `VNImageRegistrationRequest` base class.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRegistrationRequest {
    targeted_image: TargetedImageRequest,
}

impl ImageRegistrationRequest {
    #[must_use]
    pub fn new(targeted_image_path: impl AsRef<Path>) -> Self {
        Self {
            targeted_image: TargetedImageRequest::new(targeted_image_path),
        }
    }

    #[must_use]
    pub const fn from_targeted_image_request(targeted_image: TargetedImageRequest) -> Self {
        Self { targeted_image }
    }

    #[must_use]
    pub const fn targeted_image_request(&self) -> &TargetedImageRequest {
        &self.targeted_image
    }
}

impl RequestRevisionProviding for ImageRegistrationRequest {
    fn request_revision(&self) -> Option<usize> {
        RequestRevisionProviding::request_revision(&self.targeted_image)
    }
}

/// A Rust wrapper for the abstract `VNImageAlignmentObservation` base class.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ImageAlignmentObservation {
    Translational(TranslationalAlignment),
    Homographic(HomographicAlignment),
}

impl ImageAlignmentObservation {
    #[must_use]
    pub const fn translational(alignment: TranslationalAlignment) -> Self {
        Self::Translational(alignment)
    }

    #[must_use]
    pub const fn homographic(alignment: HomographicAlignment) -> Self {
        Self::Homographic(alignment)
    }
}

/// A Rust wrapper for `VNPixelBufferObservation`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PixelBufferObservation {
    pub width: usize,
    pub height: usize,
    pub bytes_per_row: usize,
    pub bytes: Vec<u8>,
    pub feature_name: Option<String>,
}

impl PixelBufferObservation {
    #[must_use]
    pub const fn new(width: usize, height: usize, bytes_per_row: usize, bytes: Vec<u8>) -> Self {
        Self {
            width,
            height,
            bytes_per_row,
            bytes,
            feature_name: None,
        }
    }

    #[must_use]
    pub fn with_feature_name(mut self, feature_name: impl Into<String>) -> Self {
        self.feature_name = Some(feature_name.into());
        self
    }

    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}
