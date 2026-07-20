//! Smoke test for the v0.13 missing-request additions: runs each new
//! API against a fixture image and prints whether the FFI plumbing
//! returned a syntactically valid response. (We don't assert on
//! ML output content because that depends on the input image.)

use std::path::PathBuf;

use apple_vision::recognize_text::_test_helper_render_text_png;
use apple_vision::{
    detect_animal_body_pose, detect_human_body_pose_3d, detect_text_observations,
    detect_text_rectangles, detect_trajectories, objectness_saliency, person_instance_mask,
    register_homographic, register_translational,
};

fn fixture() -> PathBuf {
    let dir = std::env::current_dir()
        .expect("cwd")
        .join("target")
        .join("vision-example-fixtures")
        .join("04_v013_missing_requests");
    std::fs::create_dir_all(&dir).expect("fixture dir");

    let path = dir.join("vision_v013_fixture.png");
    if !path.exists() {
        _test_helper_render_text_png("hello", 320, 240, &path).expect("render fixture png");
    }
    path
}

fn main() {
    let img = fixture();
    println!("Using fixture image: {}", img.display());

    let joints = detect_animal_body_pose(&img).expect("animal body pose");
    println!("✅ animal body pose: {} joints", joints.len());

    let joints3d = detect_human_body_pose_3d(&img).expect("3D body pose");
    println!("✅ 3D human body pose: {} joints", joints3d.len());

    let rects = detect_text_rectangles(&img, false).expect("text rectangles");
    println!("✅ text rectangles: {} regions", rects.len());
    let text_observations = detect_text_observations(&img, true).expect("text observations");
    println!(
        "✅ text observations: {} regions ({} character boxes in first region)",
        text_observations.len(),
        text_observations
            .first()
            .map_or(0, |observation| observation.character_boxes.len())
    );

    let saliency = objectness_saliency(&img).expect("objectness saliency");
    println!("✅ objectness saliency: {} regions", saliency.len());

    match person_instance_mask(&img).expect("person instance mask") {
        Some(mask) => println!(
            "✅ person instance mask: {}x{} ({} bytes)",
            mask.width,
            mask.height,
            mask.as_bytes().len()
        ),
        None => println!("✅ person instance mask: no persons (expected for fixture)"),
    }

    let trajectories = detect_trajectories(&img, 5).expect("trajectories");
    println!("✅ trajectories: {} detected", trajectories.len());

    let tr = register_translational(&img, &img).expect("translational registration");
    println!(
        "✅ translational alignment: tx={:.3} ty={:.3}",
        tr.tx, tr.ty
    );

    let hr = register_homographic(&img, &img).expect("homographic registration");
    println!("✅ homographic alignment:");
    for row in &hr.matrix {
        println!("    [{:8.4} {:8.4} {:8.4}]", row[0], row[1], row[2]);
    }
}
