fn main() -> Result<(), Box<dyn std::error::Error>> {
    pollster::block_on(async {
        let path = std::env::args().nth(1);
        if let Some(path) = path {
            let barcodes = apple_vision::async_api::AsyncDetectBarcodes::new()
                .detect_in_path(&path)
                .await?;
            println!("Detected {} barcode(s)", barcodes.len());
        } else {
            println!("No image path supplied — async plumbing OK");
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    })
}
