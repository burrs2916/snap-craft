//! Smoke test for the stateful tracking surface.
//!
//! Renders a base text fixture plus a slightly translated copy (by adding a
//! leading space before centering) and runs each tracker once across the two
//! frames.

use std::fs;
use std::path::{Path, PathBuf};

use apple_vision::recognize_text::_test_helper_render_text_png;
use apple_vision::{
    BoundingBox, HomographicImageTracker, LandmarkPoint, ObjectTracker, OpticalFlowTracker,
    RectangleObservation, RectangleTracker, TextRecognizer, TranslationalImageTracker,
};

fn fixtures() -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    let dir = std::env::current_dir()?
        .join("target")
        .join("vision-example-fixtures")
        .join("05_tracking");
    fs::create_dir_all(&dir)?;

    let base = dir.join("tracking_base.png");
    let shifted = dir.join("tracking_shifted.png");

    _test_helper_render_text_png("TRACK", 640, 240, &base)?;
    _test_helper_render_text_png(" TRACK", 640, 240, &shifted)?;

    Ok((base, shifted))
}

fn initial_bbox(image: &Path) -> Result<BoundingBox, Box<dyn std::error::Error>> {
    let observations = TextRecognizer::new().recognize_in_path(image)?;
    Ok(observations.first().map_or(
        BoundingBox {
            x: 0.22,
            y: 0.24,
            width: 0.56,
            height: 0.36,
        },
        |obs| obs.bounding_box,
    ))
}

fn rectangle_from_bbox(bbox: BoundingBox) -> RectangleObservation {
    let top_left = LandmarkPoint {
        x: bbox.x,
        y: bbox.y + bbox.height,
    };
    let top_right = LandmarkPoint {
        x: bbox.x + bbox.width,
        y: bbox.y + bbox.height,
    };
    let bottom_left = LandmarkPoint {
        x: bbox.x,
        y: bbox.y,
    };
    let bottom_right = LandmarkPoint {
        x: bbox.x + bbox.width,
        y: bbox.y,
    };

    RectangleObservation {
        bounding_box: bbox,
        confidence: 1.0,
        top_left,
        top_right,
        bottom_left,
        bottom_right,
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (base, shifted) = fixtures()?;
    let bbox = initial_bbox(&base)?;

    println!("Base frame   : {}", base.display());
    println!("Shifted frame: {}", shifted.display());
    println!(
        "Initial bbox : x={:.3} y={:.3} w={:.3} h={:.3}",
        bbox.x, bbox.y, bbox.width, bbox.height
    );

    let mut object_tracker = ObjectTracker::new(&base, bbox)?;
    let object_bbox = object_tracker.track(&shifted)?;
    println!(
        "✅ object tracker: x={:.3} y={:.3} w={:.3} h={:.3}",
        object_bbox.x, object_bbox.y, object_bbox.width, object_bbox.height
    );

    let rectangle_seed = rectangle_from_bbox(bbox);
    let mut rectangle_tracker = RectangleTracker::new(&base, &rectangle_seed)?;
    let rectangle = rectangle_tracker.track(&shifted)?;
    println!(
        "✅ rectangle tracker: bbox=({:.3}, {:.3}, {:.3}, {:.3}) tl=({:.3}, {:.3}) tr=({:.3}, {:.3})",
        rectangle.bounding_box.x,
        rectangle.bounding_box.y,
        rectangle.bounding_box.width,
        rectangle.bounding_box.height,
        rectangle.top_left.x,
        rectangle.top_left.y,
        rectangle.top_right.x,
        rectangle.top_right.y,
    );

    let mut optical_flow_tracker = OpticalFlowTracker::new(&base)?;
    let flow = optical_flow_tracker.track(&shifted)?;
    println!(
        "✅ optical flow tracker: {}x{} stride={} bytes={}",
        flow.width,
        flow.height,
        flow.bytes_per_row,
        flow.as_bytes().len()
    );

    let mut translational_tracker = TranslationalImageTracker::new(&base)?;
    let translation = translational_tracker.track(&shifted)?;
    println!(
        "✅ translational tracker: tx={:.3} ty={:.3}",
        translation.tx, translation.ty
    );

    let mut homographic_tracker = HomographicImageTracker::new(&base)?;
    let homography = homographic_tracker.track(&shifted)?;
    println!("✅ homographic tracker:");
    for row in &homography.matrix {
        println!("    [{:8.4} {:8.4} {:8.4}]", row[0], row[1], row[2]);
    }

    Ok(())
}
