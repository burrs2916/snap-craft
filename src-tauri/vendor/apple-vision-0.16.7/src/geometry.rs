#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::imprecise_flops,
    clippy::missing_const_for_fn,
    clippy::should_implement_trait,
    clippy::suboptimal_flops
)]
//! Geometry wrappers and utility helpers mirroring Vision's `VNGeometry*` and
//! `VNUtils` surfaces.

use crate::{request_base::NormalizedRect, sdk::ElementType};

/// A two-dimensional Vision point (`VNPoint`).
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(C)]
pub struct VisionPoint {
    pub x: f64,
    pub y: f64,
}

impl VisionPoint {
    #[must_use]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    #[must_use]
    pub const fn zero() -> Self {
        Self { x: 0.0, y: 0.0 }
    }

    #[must_use]
    pub fn apply_vector(self, vector: VisionVector) -> Self {
        Self {
            x: self.x + vector.x,
            y: self.y + vector.y,
        }
    }

    #[must_use]
    pub fn distance_to(self, point: Self) -> f64 {
        ((point.x - self.x).powi(2) + (point.y - self.y).powi(2)).sqrt()
    }
}

/// A two-dimensional Vision vector (`VNVector`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VisionVector {
    pub x: f64,
    pub y: f64,
}

impl VisionVector {
    #[must_use]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    #[must_use]
    pub const fn zero() -> Self {
        Self { x: 0.0, y: 0.0 }
    }

    #[must_use]
    pub fn from_points(head: VisionPoint, tail: VisionPoint) -> Self {
        Self {
            x: head.x - tail.x,
            y: head.y - tail.y,
        }
    }

    #[must_use]
    pub fn unit(self) -> Self {
        let length = self.length();
        if length <= f64::EPSILON {
            Self::zero()
        } else {
            Self {
                x: self.x / length,
                y: self.y / length,
            }
        }
    }

    #[must_use]
    pub fn multiply(self, scalar: f64) -> Self {
        Self {
            x: self.x * scalar,
            y: self.y * scalar,
        }
    }

    #[must_use]
    pub fn add(self, other: Self) -> Self {
        Self {
            x: self.x + other.x,
            y: self.y + other.y,
        }
    }

    #[must_use]
    pub fn subtract(self, other: Self) -> Self {
        Self {
            x: self.x - other.x,
            y: self.y - other.y,
        }
    }

    #[must_use]
    pub fn dot(self, other: Self) -> f64 {
        self.x * other.x + self.y * other.y
    }

    #[must_use]
    pub fn r(self) -> f64 {
        self.length()
    }

    #[must_use]
    pub fn theta(self) -> f64 {
        self.y.atan2(self.x)
    }

    #[must_use]
    pub fn length(self) -> f64 {
        self.squared_length().sqrt()
    }

    #[must_use]
    pub fn squared_length(self) -> f64 {
        self.x.powi(2) + self.y.powi(2)
    }
}

/// A two-dimensional Vision circle (`VNCircle`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VisionCircle {
    pub center: VisionPoint,
    pub radius: f64,
}

impl VisionCircle {
    #[must_use]
    pub const fn new(center: VisionPoint, radius: f64) -> Self {
        Self { center, radius }
    }

    #[must_use]
    pub const fn zero() -> Self {
        Self {
            center: VisionPoint::zero(),
            radius: 0.0,
        }
    }

    #[must_use]
    pub const fn from_diameter(center: VisionPoint, diameter: f64) -> Self {
        Self {
            center,
            radius: diameter / 2.0,
        }
    }

    #[must_use]
    pub const fn diameter(self) -> f64 {
        self.radius * 2.0
    }

    #[must_use]
    pub fn contains_point(self, point: VisionPoint) -> bool {
        self.center.distance_to(point) <= self.radius + 1e-9
    }

    #[must_use]
    pub fn contains_point_in_circumferential_ring(
        self,
        point: VisionPoint,
        ring_width: f64,
    ) -> bool {
        let distance = self.center.distance_to(point);
        let delta = ring_width.abs() / 2.0;
        distance >= self.radius - delta - 1e-9 && distance <= self.radius + delta + 1e-9
    }
}

/// Column-major 4×4 transform used by Vision's 3-D point wrappers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transform3D {
    pub columns: [[f32; 4]; 4],
}

impl Transform3D {
    #[must_use]
    pub const fn identity() -> Self {
        Self {
            columns: [
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ],
        }
    }

    #[must_use]
    pub const fn from_translation(x: f32, y: f32, z: f32) -> Self {
        Self {
            columns: [
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [x, y, z, 1.0],
            ],
        }
    }

    #[must_use]
    pub const fn translation(self) -> (f32, f32, f32) {
        (self.columns[3][0], self.columns[3][1], self.columns[3][2])
    }
}

/// A three-dimensional Vision point (`VNPoint3D`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VisionPoint3D {
    pub position: Transform3D,
}

impl VisionPoint3D {
    #[must_use]
    pub const fn new(position: Transform3D) -> Self {
        Self { position }
    }

    #[must_use]
    pub const fn from_xyz(x: f32, y: f32, z: f32) -> Self {
        Self {
            position: Transform3D::from_translation(x, y, z),
        }
    }

    #[must_use]
    pub const fn x(self) -> f32 {
        self.position.columns[3][0]
    }

    #[must_use]
    pub const fn y(self) -> f32 {
        self.position.columns[3][1]
    }

    #[must_use]
    pub const fn z(self) -> f32 {
        self.position.columns[3][2]
    }
}

#[derive(Clone, Copy)]
#[repr(C)]
struct CGPointRaw {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct CGSizeRaw {
    width: f64,
    height: f64,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct CGRectRaw {
    origin: CGPointRaw,
    size: CGSizeRaw,
}

#[repr(C)]
struct VectorFloat2Raw {
    x: f32,
    y: f32,
}

extern "C" {
    static VNNormalizedIdentityRect: CGRectRaw;

    fn VNNormalizedRectIsIdentityRect(normalized_rect: CGRectRaw) -> bool;
    fn VNImagePointForNormalizedPoint(
        normalized_point: CGPointRaw,
        image_width: usize,
        image_height: usize,
    ) -> CGPointRaw;
    fn VNImagePointForNormalizedPointUsingRegionOfInterest(
        normalized_point: CGPointRaw,
        image_width: usize,
        image_height: usize,
        roi: CGRectRaw,
    ) -> CGPointRaw;
    fn VNNormalizedPointForImagePoint(
        image_point: CGPointRaw,
        image_width: usize,
        image_height: usize,
    ) -> CGPointRaw;
    fn VNNormalizedPointForImagePointUsingRegionOfInterest(
        image_point: CGPointRaw,
        image_width: usize,
        image_height: usize,
        roi: CGRectRaw,
    ) -> CGPointRaw;
    fn VNImageRectForNormalizedRect(
        normalized_rect: CGRectRaw,
        image_width: usize,
        image_height: usize,
    ) -> CGRectRaw;
    fn VNImageRectForNormalizedRectUsingRegionOfInterest(
        normalized_rect: CGRectRaw,
        image_width: usize,
        image_height: usize,
        roi: CGRectRaw,
    ) -> CGRectRaw;
    fn VNNormalizedRectForImageRect(
        image_rect: CGRectRaw,
        image_width: usize,
        image_height: usize,
    ) -> CGRectRaw;
    fn VNNormalizedRectForImageRectUsingRegionOfInterest(
        image_rect: CGRectRaw,
        image_width: usize,
        image_height: usize,
        roi: CGRectRaw,
    ) -> CGRectRaw;
    fn VNNormalizedFaceBoundingBoxPointForLandmarkPoint(
        face_landmark_point: VectorFloat2Raw,
        face_bounding_box: CGRectRaw,
        image_width: usize,
        image_height: usize,
    ) -> CGPointRaw;
    fn VNImagePointForFaceLandmarkPoint(
        face_landmark_point: VectorFloat2Raw,
        face_bounding_box: CGRectRaw,
        image_width: usize,
        image_height: usize,
    ) -> CGPointRaw;
    fn VNElementTypeSize(element_type: usize) -> usize;
}

fn point_to_raw(point: VisionPoint) -> CGPointRaw {
    CGPointRaw {
        x: point.x,
        y: point.y,
    }
}

fn point_from_raw(raw: CGPointRaw) -> VisionPoint {
    VisionPoint { x: raw.x, y: raw.y }
}

fn rect_to_raw(rect: NormalizedRect) -> CGRectRaw {
    CGRectRaw {
        origin: CGPointRaw {
            x: rect.x,
            y: rect.y,
        },
        size: CGSizeRaw {
            width: rect.width,
            height: rect.height,
        },
    }
}

fn rect_from_raw(raw: CGRectRaw) -> NormalizedRect {
    NormalizedRect::new(raw.origin.x, raw.origin.y, raw.size.width, raw.size.height)
}

/// Mirrors `VNNormalizedIdentityRect`.
#[must_use]
pub fn normalized_identity_rect() -> NormalizedRect {
    // SAFETY: `VNNormalizedIdentityRect` is a valid extern static provided by the Vision framework.
    rect_from_raw(unsafe { VNNormalizedIdentityRect })
}

/// Mirrors `VNNormalizedRectIsIdentityRect`.
#[must_use]
pub fn normalized_rect_is_identity_rect(normalized_rect: NormalizedRect) -> bool {
    // SAFETY: the arguments are plain value types passed by copy; the function is a pure math helper from the Vision framework.
    unsafe { VNNormalizedRectIsIdentityRect(rect_to_raw(normalized_rect)) }
}

/// Mirrors `VNImagePointForNormalizedPoint`.
#[must_use]
pub fn image_point_for_normalized_point(
    normalized_point: VisionPoint,
    image_width: usize,
    image_height: usize,
) -> VisionPoint {
    // SAFETY: the arguments are plain value types passed by copy; the function is a pure math helper from the Vision framework.
    point_from_raw(unsafe {
        VNImagePointForNormalizedPoint(point_to_raw(normalized_point), image_width, image_height)
    })
}

/// Mirrors `VNImagePointForNormalizedPointUsingRegionOfInterest`.
#[must_use]
pub fn image_point_for_normalized_point_using_region_of_interest(
    normalized_point: VisionPoint,
    image_width: usize,
    image_height: usize,
    region_of_interest: NormalizedRect,
) -> VisionPoint {
    // SAFETY: the arguments are plain value types passed by copy; the function is a pure math helper from the Vision framework.
    point_from_raw(unsafe {
        VNImagePointForNormalizedPointUsingRegionOfInterest(
            point_to_raw(normalized_point),
            image_width,
            image_height,
            rect_to_raw(region_of_interest),
        )
    })
}

/// Mirrors `VNNormalizedPointForImagePoint`.
#[must_use]
pub fn normalized_point_for_image_point(
    image_point: VisionPoint,
    image_width: usize,
    image_height: usize,
) -> VisionPoint {
    // SAFETY: the arguments are plain value types passed by copy; the function is a pure math helper from the Vision framework.
    point_from_raw(unsafe {
        VNNormalizedPointForImagePoint(point_to_raw(image_point), image_width, image_height)
    })
}

/// Mirrors `VNNormalizedPointForImagePointUsingRegionOfInterest`.
#[must_use]
pub fn normalized_point_for_image_point_using_region_of_interest(
    image_point: VisionPoint,
    image_width: usize,
    image_height: usize,
    region_of_interest: NormalizedRect,
) -> VisionPoint {
    // SAFETY: the arguments are plain value types passed by copy; the function is a pure math helper from the Vision framework.
    point_from_raw(unsafe {
        VNNormalizedPointForImagePointUsingRegionOfInterest(
            point_to_raw(image_point),
            image_width,
            image_height,
            rect_to_raw(region_of_interest),
        )
    })
}

/// Mirrors `VNImageRectForNormalizedRect`.
#[must_use]
pub fn image_rect_for_normalized_rect(
    normalized_rect: NormalizedRect,
    image_width: usize,
    image_height: usize,
) -> NormalizedRect {
    // SAFETY: the arguments are plain value types passed by copy; the function is a pure math helper from the Vision framework.
    rect_from_raw(unsafe {
        VNImageRectForNormalizedRect(rect_to_raw(normalized_rect), image_width, image_height)
    })
}

/// Mirrors `VNImageRectForNormalizedRectUsingRegionOfInterest`.
#[must_use]
pub fn image_rect_for_normalized_rect_using_region_of_interest(
    normalized_rect: NormalizedRect,
    image_width: usize,
    image_height: usize,
    region_of_interest: NormalizedRect,
) -> NormalizedRect {
    // SAFETY: the arguments are plain value types passed by copy; the function is a pure math helper from the Vision framework.
    rect_from_raw(unsafe {
        VNImageRectForNormalizedRectUsingRegionOfInterest(
            rect_to_raw(normalized_rect),
            image_width,
            image_height,
            rect_to_raw(region_of_interest),
        )
    })
}

/// Mirrors `VNNormalizedRectForImageRect`.
#[must_use]
pub fn normalized_rect_for_image_rect(
    image_rect: NormalizedRect,
    image_width: usize,
    image_height: usize,
) -> NormalizedRect {
    // SAFETY: the arguments are plain value types passed by copy; the function is a pure math helper from the Vision framework.
    rect_from_raw(unsafe {
        VNNormalizedRectForImageRect(rect_to_raw(image_rect), image_width, image_height)
    })
}

/// Mirrors `VNNormalizedRectForImageRectUsingRegionOfInterest`.
#[must_use]
pub fn normalized_rect_for_image_rect_using_region_of_interest(
    image_rect: NormalizedRect,
    image_width: usize,
    image_height: usize,
    region_of_interest: NormalizedRect,
) -> NormalizedRect {
    // SAFETY: the arguments are plain value types passed by copy; the function is a pure math helper from the Vision framework.
    rect_from_raw(unsafe {
        VNNormalizedRectForImageRectUsingRegionOfInterest(
            rect_to_raw(image_rect),
            image_width,
            image_height,
            rect_to_raw(region_of_interest),
        )
    })
}

/// Mirrors `VNNormalizedFaceBoundingBoxPointForLandmarkPoint`.
#[must_use]
pub fn normalized_face_bounding_box_point_for_landmark_point(
    face_landmark_point: VisionPoint,
    face_bounding_box: NormalizedRect,
    image_width: usize,
    image_height: usize,
) -> VisionPoint {
    // SAFETY: the arguments are plain value types passed by copy; the function is a pure math helper from the Vision framework.
    point_from_raw(unsafe {
        VNNormalizedFaceBoundingBoxPointForLandmarkPoint(
            VectorFloat2Raw {
                x: face_landmark_point.x as f32,
                y: face_landmark_point.y as f32,
            },
            rect_to_raw(face_bounding_box),
            image_width,
            image_height,
        )
    })
}

/// Mirrors `VNImagePointForFaceLandmarkPoint`.
#[must_use]
pub fn image_point_for_face_landmark_point(
    face_landmark_point: VisionPoint,
    face_bounding_box: NormalizedRect,
    image_width: usize,
    image_height: usize,
) -> VisionPoint {
    // SAFETY: the arguments are plain value types passed by copy; the function is a pure math helper from the Vision framework.
    point_from_raw(unsafe {
        VNImagePointForFaceLandmarkPoint(
            VectorFloat2Raw {
                x: face_landmark_point.x as f32,
                y: face_landmark_point.y as f32,
            },
            rect_to_raw(face_bounding_box),
            image_width,
            image_height,
        )
    })
}

/// Mirrors `VNElementTypeSize`.
#[must_use]
pub fn element_type_size(element_type: ElementType) -> usize {
    // SAFETY: the arguments are plain value types passed by copy; the function is a pure math helper from the Vision framework.
    unsafe { VNElementTypeSize(element_type.as_raw()) }
}

/// Pure-Rust helpers mirroring `VNGeometryUtils`.
pub struct VisionGeometryUtils;

impl VisionGeometryUtils {
    /// Compute a bounding circle covering every point.
    #[must_use]
    pub fn bounding_circle_for_points(points: &[VisionPoint]) -> Option<VisionCircle> {
        minimal_enclosing_circle(points)
    }

    /// Compute a polygon area using Green's theorem.
    #[must_use]
    pub fn calculate_area(points: &[VisionPoint], oriented: bool) -> Option<f64> {
        if points.len() < 3 {
            return None;
        }
        let mut area = 0.0;
        for index in 0..points.len() {
            let next = points[(index + 1) % points.len()];
            area += points[index].x * next.y - next.x * points[index].y;
        }
        area /= 2.0;
        Some(if oriented { area } else { area.abs() })
    }

    /// Compute the closed polygon perimeter.
    #[must_use]
    pub fn calculate_perimeter(points: &[VisionPoint]) -> Option<f64> {
        if points.len() < 2 {
            return None;
        }
        let mut perimeter = 0.0;
        for index in 0..points.len() {
            perimeter += points[index].distance_to(points[(index + 1) % points.len()]);
        }
        Some(perimeter)
    }
}

fn minimal_enclosing_circle(points: &[VisionPoint]) -> Option<VisionCircle> {
    match points.len() {
        0 => None,
        1 => Some(VisionCircle::new(points[0], 0.0)),
        _ => {
            let mut best: Option<VisionCircle> = None;

            for &point in points {
                let candidate = VisionCircle::new(point, 0.0);
                if contains_all(candidate, points) {
                    best = Some(select_smaller(best, candidate));
                }
            }

            for first in 0..points.len() {
                for second in (first + 1)..points.len() {
                    let candidate = circle_from_two(points[first], points[second]);
                    if contains_all(candidate, points) {
                        best = Some(select_smaller(best, candidate));
                    }
                }
            }

            for first in 0..points.len() {
                for second in (first + 1)..points.len() {
                    for third in (second + 1)..points.len() {
                        if let Some(candidate) =
                            circle_from_three(points[first], points[second], points[third])
                        {
                            if contains_all(candidate, points) {
                                best = Some(select_smaller(best, candidate));
                            }
                        }
                    }
                }
            }

            best.or_else(|| {
                let min_x = points
                    .iter()
                    .map(|point| point.x)
                    .fold(f64::INFINITY, f64::min);
                let max_x = points
                    .iter()
                    .map(|point| point.x)
                    .fold(f64::NEG_INFINITY, f64::max);
                let min_y = points
                    .iter()
                    .map(|point| point.y)
                    .fold(f64::INFINITY, f64::min);
                let max_y = points
                    .iter()
                    .map(|point| point.y)
                    .fold(f64::NEG_INFINITY, f64::max);
                let center = VisionPoint::new((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
                Some(VisionCircle::new(
                    center,
                    center.distance_to(VisionPoint::new(max_x, max_y)),
                ))
            })
        }
    }
}

fn select_smaller(current: Option<VisionCircle>, candidate: VisionCircle) -> VisionCircle {
    current.map_or(candidate, |existing| {
        if candidate.radius < existing.radius {
            candidate
        } else {
            existing
        }
    })
}

fn contains_all(circle: VisionCircle, points: &[VisionPoint]) -> bool {
    points
        .iter()
        .copied()
        .all(|point| circle.contains_point(point))
}

fn circle_from_two(first: VisionPoint, second: VisionPoint) -> VisionCircle {
    let center = VisionPoint::new((first.x + second.x) / 2.0, (first.y + second.y) / 2.0);
    VisionCircle::new(center, center.distance_to(first))
}

fn circle_from_three(
    first: VisionPoint,
    second: VisionPoint,
    third: VisionPoint,
) -> Option<VisionCircle> {
    let d = 2.0
        * (first.x * (second.y - third.y)
            + second.x * (third.y - first.y)
            + third.x * (first.y - second.y));
    if d.abs() <= f64::EPSILON {
        return None;
    }

    let first_sq = first.x.powi(2) + first.y.powi(2);
    let second_sq = second.x.powi(2) + second.y.powi(2);
    let third_sq = third.x.powi(2) + third.y.powi(2);

    let ux = (first_sq * (second.y - third.y)
        + second_sq * (third.y - first.y)
        + third_sq * (first.y - second.y))
        / d;
    let uy = (first_sq * (third.x - second.x)
        + second_sq * (first.x - third.x)
        + third_sq * (second.x - first.x))
        / d;
    let center = VisionPoint::new(ux, uy);
    Some(VisionCircle::new(center, center.distance_to(first)))
}
