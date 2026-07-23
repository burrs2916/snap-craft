// macOS Apple Vision OCR
use super::{OcrBlock, OcrResult};

pub(super) fn run_native_ocr(path: &std::path::Path, _lang: Option<&str>) -> Result<OcrResult, String> {
    use apple_vision::prelude::*;

    let started = std::time::Instant::now();
    let path_str = path.to_str().ok_or("无效的临时路径")?;
    clog!("ocr", "→ macOS Vision OCR: 识别 {}", path_str);

    // Accurate 级别 + 语言校正，兼顾中英文准确度；识别语言由系统按内容自动选择
    // （apple-vision 0.16 的 TextRecognizer 未暴露强制语言接口，_lang 暂保留供将来）。
    if let Some(l) = _lang {
        clog!(
            "ocr",
            "⚠️ macOS Vision 后端暂不支持强制语言（apple-vision 0.16 限制），\
             前端传入的 lang={:?} 将被忽略，系统按内容自动选择识别语言",
            l
        );
    }
    let recognizer = TextRecognizer::new()
        .with_recognition_level(RecognitionLevel::Accurate)
        .with_language_correction(true);

    let observations = recognizer
        .recognize_in_path(path_str)
        .map_err(|e| format!("Vision 识别失败: {:?}", e))?;

    // 每个 observation 是一行/一段。Vision 的 bounding_box 原点在左下、需翻转为左上。
    let blocks: Vec<OcrBlock> = observations
        .iter()
        .map(|o| {
            let b = o.bounding_box;
            OcrBlock {
                text: o.text.trim_end().to_string(),
                x: b.x,
                y: 1.0 - b.y - b.height, // 左下原点 → 左上原点
                w: b.width,
                h: b.height,
                confidence: o.confidence as f64,
            }
        })
        .collect();

    let text = blocks
        .iter()
        .map(|b| b.text.clone())
        .collect::<Vec<_>>()
        .join("\n");

    clog!(
        "ocr",
        "Vision 完成: {} 个文本块, 共 {} 字符, 耗时={}ms",
        blocks.len(),
        text.len(),
        started.elapsed().as_millis()
    );
    if text.trim().is_empty() {
        return Err("未识别到文字".into());
    }
    Ok(OcrResult { text, blocks })
}
