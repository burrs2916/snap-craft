fn main() -> Result<(), Box<dyn std::error::Error>> {
    pollster::block_on(async {
        let path = std::env::args().nth(1);
        if let Some(path) = path {
            let faces = apple_vision::async_api::AsyncDetectFaces::new()
                .detect_in_path(&path)
                .await?;
            println!("Detected {} face(s)", faces.len());
        } else {
            println!("No image path supplied — async plumbing OK");
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    })
}
