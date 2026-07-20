fn main() -> Result<(), Box<dyn std::error::Error>> {
    pollster::block_on(async {
        let path = std::env::args().nth(1);
        if let Some(path) = path {
            let mask = apple_vision::async_api::AsyncPersonSegmentation::default()
                .generate_in_path(&path)
                .await?;
            println!("Segmentation mask: {}x{}", mask.width, mask.height);
        } else {
            println!("No image path supplied — async plumbing OK");
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    })
}
