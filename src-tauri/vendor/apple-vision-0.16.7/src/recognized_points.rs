//! Generic recognized-point wrappers shared by pose observations.

use std::collections::HashMap;

use crate::{
    geometry::{Transform3D, VisionPoint, VisionPoint3D},
    request_base::NormalizedRect,
};

/// A dedicated `VNDetectedPoint` wrapper.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VisionDetectedPoint {
    pub location: VisionPoint,
    pub confidence: f32,
}

impl VisionDetectedPoint {
    #[must_use]
    pub const fn new(location: VisionPoint, confidence: f32) -> Self {
        Self {
            location,
            confidence,
        }
    }

    #[must_use]
    pub const fn x(&self) -> f64 {
        self.location.x
    }

    #[must_use]
    pub const fn y(&self) -> f64 {
        self.location.y
    }
}

/// A single normalized `VNRecognizedPoint`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RecognizedPoint {
    pub x: f64,
    pub y: f64,
    pub confidence: f32,
}

impl RecognizedPoint {
    #[must_use]
    pub const fn detected_point(self) -> VisionDetectedPoint {
        VisionDetectedPoint::new(VisionPoint::new(self.x, self.y), self.confidence)
    }
}

/// A dedicated `VNRecognizedPoint` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct VisionRecognizedPoint {
    pub identifier: String,
    pub point: VisionDetectedPoint,
}

impl VisionRecognizedPoint {
    #[must_use]
    pub fn new(identifier: impl Into<String>, point: VisionDetectedPoint) -> Self {
        Self {
            identifier: identifier.into(),
            point,
        }
    }
}

/// A generic `VNRecognizedPointsObservation` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct RecognizedPointsObservation {
    pub bounding_box: NormalizedRect,
    pub confidence: f32,
    pub available_keys: Vec<String>,
    pub available_group_keys: Vec<String>,
    pub points: HashMap<String, RecognizedPoint>,
}

impl RecognizedPointsObservation {
    #[must_use]
    pub fn point(&self, key: &str) -> Option<&RecognizedPoint> {
        self.points.get(key)
    }

    #[must_use]
    pub fn recognized_point(&self, key: &str) -> Option<VisionRecognizedPoint> {
        self.point(key)
            .copied()
            .map(|point| VisionRecognizedPoint::new(key, point.detected_point()))
    }

    #[must_use]
    pub fn recognized_points(&self) -> Vec<VisionRecognizedPoint> {
        let mut keys = self.points.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        keys.into_iter()
            .filter_map(|key| self.recognized_point(&key))
            .collect()
    }
}

/// A single normalized `VNRecognizedPoint3D` / `VNHumanBodyRecognizedPoint3D`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RecognizedPoint3D {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub confidence: f32,
}

impl RecognizedPoint3D {
    #[must_use]
    pub const fn point_3d(self) -> VisionPoint3D {
        VisionPoint3D::from_xyz(self.x, self.y, self.z)
    }
}

/// A dedicated `VNRecognizedPoint3D` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct VisionRecognizedPoint3D {
    pub identifier: String,
    pub point: VisionPoint3D,
    pub confidence: f32,
}

impl VisionRecognizedPoint3D {
    #[must_use]
    pub fn new(identifier: impl Into<String>, point: VisionPoint3D, confidence: f32) -> Self {
        Self {
            identifier: identifier.into(),
            point,
            confidence,
        }
    }
}

/// A dedicated `VNHumanBodyRecognizedPoint3D` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct HumanBodyRecognizedPoint3D {
    pub recognized_point: VisionRecognizedPoint3D,
    pub local_position: Transform3D,
    pub parent_joint: Option<String>,
}

impl HumanBodyRecognizedPoint3D {
    #[must_use]
    pub const fn new(
        recognized_point: VisionRecognizedPoint3D,
        local_position: Transform3D,
        parent_joint: Option<String>,
    ) -> Self {
        Self {
            recognized_point,
            local_position,
            parent_joint,
        }
    }
}

/// A generic `VNRecognizedPoints3DObservation` wrapper.
#[derive(Debug, Clone, PartialEq)]
pub struct RecognizedPoints3DObservation {
    pub confidence: f32,
    pub available_keys: Vec<String>,
    pub available_group_keys: Vec<String>,
    pub points: HashMap<String, RecognizedPoint3D>,
}

impl RecognizedPoints3DObservation {
    #[must_use]
    pub fn point(&self, key: &str) -> Option<&RecognizedPoint3D> {
        self.points.get(key)
    }

    #[must_use]
    pub fn recognized_point(&self, key: &str) -> Option<VisionRecognizedPoint3D> {
        self.point(key)
            .copied()
            .map(|point| VisionRecognizedPoint3D::new(key, point.point_3d(), point.confidence))
    }

    #[must_use]
    pub fn recognized_points(&self) -> Vec<VisionRecognizedPoint3D> {
        let mut keys = self.points.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        keys.into_iter()
            .filter_map(|key| self.recognized_point(&key))
            .collect()
    }
}
