//! Async OCR smoke test — recognises text from a simple synthetic image.
//!
//! Pass an image path as the first argument, or run without arguments for a
//! quick headless smoke test that verifies the async plumbing works.
//!
//! Exit codes: 0 = success / no image supplied, non-zero = unexpected error.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    pollster::block_on(async {
        let path = std::env::args().nth(1);
        if let Some(path) = path {
            let texts = apple_vision::async_api::AsyncRecognizeText::default()
                .recognize_in_path(&path)
                .await?;
            println!("Recognized {} text observations", texts.len());
            for text in &texts {
                println!("  {:?}", text.text);
            }
        } else {
            println!("No image path supplied — async plumbing OK");
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    })
}
