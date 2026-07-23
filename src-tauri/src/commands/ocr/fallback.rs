// Linux/other platform stub
use super::{OcrBlock, OcrResult};

pub(super) fn run_native_ocr(_path: &std::path::Path, _lang: Option<&str>) -> Result<OcrResult, String> {
    Err("当前平台暂不支持系统原生 OCR（仅 macOS / Windows）".into())
}
