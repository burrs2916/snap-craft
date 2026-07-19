use crate::store;
use std::path::Path;
use std::sync::Mutex;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use tauri::AppHandle;

/// 全局剪贴板锁：macOS 的 NSPasteboard 不是线程安全的，
/// 多个 tokio worker 线程同时调 arboard 会触发 EXC_BAD_ACCESS 崩溃。
/// 用 Mutex 串行化所有剪贴板读写，确保同一时刻只有一个线程在访问。
static CLIPBOARD_LOCK: Mutex<()> = Mutex::new(());

/// 将 data URL 写入指定文件路径
#[tauri::command]
pub async fn save_screenshot(
    _app: AppHandle,
    image_data: String,
    file_path: String,
) -> Result<(), String> {
    let bytes = store::data_url_to_bytes(&image_data)?;
    let path = std::path::Path::new(&file_path);
    store::write_bytes(path, &bytes)?;
    Ok(())
}

/// 将截图复制到系统剪贴板
#[tauri::command]
pub async fn copy_to_clipboard(_app: AppHandle, image_data: String) -> Result<(), String> {
    clog!("clip", "copy_to_clipboard 调用: data_url 长度={} 前缀={}",
        image_data.len(),
        &image_data.chars().take(30).collect::<String>());
    // 跨平台统一路径：解码 PNG 为 RGBA，使用 arboard 写入剪贴板。
    // - 此前 macOS 走 osascript（包外外部二进制），在 App Store 沙箱下无法 spawn → 复制图片失效；
    //   arboard 在 macOS 走 NSPasteboard，沙箱可用，macOS App Store 版本也能正常复制图片。
    // - Windows / Linux 行为与此前完全一致，无回归。
    // - NSPasteboard 非线程安全，必须串行化（与 read_clipboard_image_sync / 文本读取共用同一把锁）。
    let bytes = store::data_url_to_bytes(&image_data)?;
    let tmp = store::temp_png_path();
    store::write_bytes(&tmp, &bytes)?;

    let img = image::open(&tmp)
        .map_err(|e| format!("解码图片失败: {}", e))?
        .to_rgba8();
    // 清理临时文件
    let _ = std::fs::remove_file(&tmp);
    let (w, h) = (img.width() as usize, img.height() as usize);
    let rgba = img.into_raw();

    let _guard = CLIPBOARD_LOCK.lock().map_err(|e| format!("剪贴板锁获取失败: {}", e))?;
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("剪贴板初始化失败: {}", e))?;
    clipboard
        .set_image(arboard::ImageData {
            width: w,
            height: h,
            bytes: rgba.into(),
        })
        .map_err(|e| format!("复制到剪贴板失败: {}", e))?;
    clog!("clip", "复制到剪贴板成功 ✅");
    Ok(())
}

/// 系统剪贴板图片经本命令读取后，长边允许的最大像素：超过则等比缩放后再编码。
/// 生产级动机：4K/Retina 全屏截图复制到剪贴板常达 3000px+，原图直出 PNG data URL
/// 动辄数 MB~数十 MB，经 Tauri IPC 回传会造成主线程卡顿、内存压力，且 OCR 引擎处理巨图变慢。
/// Apple Vision / WinRT 在 3000px 长边下对截图文字识别精度基本无损，故以此为上限。
const CLIP_MAX_DIM: u32 = 3000;

/// 错误令牌：后端用稳定前缀标记错误类别，前端据此映射为精准本地化文案，
/// 绝不把 arboard 原始报错（如 "The clipboard contents were not available..."）直接暴露给用户。
const ERR_EMPTY: &str = "ERR_EMPTY";
const ERR_TEXT_NOT_IMAGE: &str = "ERR_TEXT_NOT_IMAGE";
const ERR_NO_IMG_FILE: &str = "ERR_NO_IMG_FILE";
const ERR_BAD_IMG_FILE: &str = "ERR_BAD_IMG_FILE";
const ERR_ZERO_SIZE: &str = "ERR_ZERO_SIZE";

/// 读取系统剪贴板中的任意图片并编码为 PNG data URL，供前端直接送 OCR 识别。
/// 覆盖来源：浏览器 / 微信 / 其它截图工具复制的位图，或 Finder / 资源管理器复制的图片文件。
///
/// 相对初版的生产级加固：
///  1) 大图保护：长边超过 CLIP_MAX_DIM 时等比缩放（Lanczos3），避免巨型 payload 拖垮 IPC / OCR。
///  2) 文件回退：剪贴板里若是「图片文件」而非原始像素（常见 Finder 复制），
///     回退读取首个图片文件，覆盖「复制图片文件」场景。
///  3) 零尺寸守卫：解码后宽高任一为 0 直接报错，避免产出损坏 PNG 导致 OCR 静默失败。
///  4) 错误分级：用稳定令牌区分「空剪贴板 / 文字非图片 / 无图片文件 / 文件非有效图片 / 零尺寸」，
///     前端映射为精准本地化文案，绝不把 arboard 原始报错透传用户（修复此前「读取剪贴板文件失败」泄漏）。
///  5) 诊断日志：记录原始/输出尺寸、是否缩放、payload 大小，便于线上排查。
///
/// 仅读取用户主动复制的内容，不访问屏幕录制，无需 TCC 屏幕录制权限；只读不写，
/// 与 copy_to_clipboard 平级、互不干扰。返回契约（PNG data URL 字符串）未变，前端零改造。
/// 同步实现：在独立线程（spawn_blocking）执行，避免阻塞 tokio 运行时。
/// 见 `read_clipboard_image` 命令包装。
fn read_clipboard_image_sync() -> Result<String, String> {
    use image::imageops::FilterType;

    // macOS 的 NSPasteboard 不是线程安全的，多个 tokio worker 线程同时读会 EXC_BAD_ACCESS。
    // 用全局 Mutex 串行化所有剪贴板读写，确保同一时刻只有一个线程在访问。
    let _guard = CLIPBOARD_LOCK.lock().map_err(|e| format!("剪贴板锁获取失败: {}", e))?;

    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("剪贴板初始化失败: {}", e))?;

    // 1) 优先读取剪贴板里的「原始像素图片」（浏览器/微信/截图工具复制的位图）
    let from_pixels: Option<image::DynamicImage> = match clipboard.get_image() {
        Ok(img) => {
            let w = img.width as u32;
            let h = img.height as u32;
            let rgba = img.bytes.to_vec();
            // 极少数情况下像素尺寸与字节数不匹配、无法构建缓冲区：不在此报错，
            // 交给下方的「文件回退 + 空判定」统一处理，避免误报。
            image::ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_raw(w, h, rgba)
                .map(image::DynamicImage::ImageRgba8)
        }
        Err(_) => None,
    };

    // 2) 原始像素读不到 → 回退尝试「图片文件」（Finder/资源管理器复制的文件路径）。
    //    用 if-let 吞掉 file_list 的底层报错：失败仅意味着「不是文件型图片」，
    //    绝不能把 arboard 原始错误（如 "The clipboard contents were not available..."）
    //    泄漏给用户——这正是此前「读取剪贴板文件失败」报错的根因。
    let mut loaded: Option<image::DynamicImage> = from_pixels;
    let mut had_files = false; // 剪贴板里是否真有文件（区分「复制了文件夹」与「真的空」）
    if loaded.is_none() {
        if let Ok(files) = clipboard.get().file_list() {
            had_files = !files.is_empty();
            // 只挑真正的图片文件：剪贴板里可能复制了文件夹、或混入了文本/PDF 等非图片文件，
            // 若直接取首个，image::open 会报「不是可识别的图片」，误导用户以为图片坏了。
            const IMG_EXTS: &[&str] = &[
                "png", "jpg", "jpeg", "gif", "bmp", "webp", "tiff", "tif", "heic", "heif",
            ];
            if let Some(img_file) = files.iter().find(|f| {
                f.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| IMG_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                    .unwrap_or(false)
            }) {
                match image::open(img_file) {
                    Ok(im) => loaded = Some(im),
                    // 找到图片文件但解码失败（损坏/编码不支持）→ 明确标记为非有效图片，
                    // 后续统一映射到「文件不是有效图片」文案，而非笼统的空提示。
                    Err(_) => return Err(format!("{}:{}", ERR_BAD_IMG_FILE, img_file.display())),
                }
            }
        }
    }

    // 3) 仍未拿到图片 → 分级诊断：是空剪贴板、是文字、还是复制了非图片文件？
    let loaded: image::DynamicImage = match loaded {
        Some(im) => im,
        None => {
            if had_files {
                // 剪贴板里有文件，但都不是可识别的图片（如文件夹、PDF、文本文件等）。
                return Err(ERR_NO_IMG_FILE.into());
            }
            // 探测是否有文本内容：有文字说明用户复制的是文字而非图片，给出更精准的引导。
            let has_text = clipboard
                .get()
                .text()
                .map(|t| !t.trim().is_empty())
                .unwrap_or(false);
            if has_text {
                return Err(ERR_TEXT_NOT_IMAGE.into());
            }
            return Err(ERR_EMPTY.into());
        }
    };

    let (ow, oh) = (loaded.width(), loaded.height());
    // 4) 零尺寸守卫
    if ow == 0 || oh == 0 {
        return Err(ERR_ZERO_SIZE.into());
    }

    // 5) 大图等比缩放保护（仅在超限时才缩放，小图零质量损失）
    let scaled = if ow > CLIP_MAX_DIM || oh > CLIP_MAX_DIM {
        let scale = CLIP_MAX_DIM as f32 / ow.max(oh) as f32;
        let nw = (ow as f32 * scale).max(1.0).round() as u32;
        let nh = (oh as f32 * scale).max(1.0).round() as u32;
        clog!(
            "ocr",
            "read_clipboard_image: 原图 {}x{} 过大 → 等比缩放至 {}x{}",
            ow,
            oh,
            nw,
            nh
        );
        loaded.resize(nw, nh, FilterType::Lanczos3)
    } else {
        loaded
    };

    // 编码 PNG data URL
    let mut png: Vec<u8> = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut png);
        scaled
            .write_to(&mut cursor, image::ImageFormat::Png)
            .map_err(|e| format!("编码 PNG 失败: {}", e))?;
    }
    let b64 = B64.encode(&png);
    let data_url = format!("data:image/png;base64,{}", b64);
    clog!(
        "ocr",
        "read_clipboard_image: 原图 {}x{} → 输出 {}x{} PNG {} 字节 (base64 {} 字符)",
        ow,
        oh,
        scaled.width(),
        scaled.height(),
        png.len(),
        data_url.len()
    );
    Ok(data_url)
}

#[tauri::command]
pub async fn read_clipboard_image() -> Result<String, String> {
    // macOS 的 NSPasteboard 不是线程安全的；用 spawn_blocking 把同步剪贴板 I/O
    // 移到独立线程，避免阻塞 tokio 运行时（生产级：巨图解码 / PNG 编码可达数百 ms）。
    // 全局 CLIPBOARD_LOCK 仍在同一线程内串行化，正确性不受影响。
    let result = tauri::async_runtime::spawn_blocking(read_clipboard_image_sync)
        .await
        .map_err(|e| format!("剪贴板任务执行失败: {}", e))?;
    result
}

/// 读取系统剪贴板中的纯文本（保留内部换行，仅去除首尾空白/换行）。
/// 供「从剪贴板取字」在图片之前**优先**探测：若剪贴板里本来就是文字，直接作为取字结果，
/// 无需 OCR，最贴合「取字」语义，也避开了「一个叫取字的功能拒绝文字」的反直觉问题。
///
/// 返回契约：
///  - 成功：去首尾后的原始文本（内部换行/空格原样保留）；
///  - 无文字（剪贴板空、或仅有空白/换行）：返回 ERR_EMPTY，由前端继续尝试图片路径，
///    最终文字与图片皆无时才提示「剪贴板为空」，绝不把无文字当作错误抛给用户。
/// 仅读取、不写；与 read_clipboard_image 平级、互不干扰。
/// 同步实现：在独立线程（spawn_blocking）执行，避免阻塞 tokio 运行时。
/// 见 `read_clipboard_text` 命令包装。
fn read_clipboard_text_sync() -> Result<String, String> {
    // macOS 的 NSPasteboard 不是线程安全的，用全局 Mutex 串行化。
    let _guard = CLIPBOARD_LOCK.lock().map_err(|e| format!("剪贴板锁获取失败: {}", e))?;

    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("剪贴板初始化失败: {}", e))?;
    let text = match clipboard.get().text() {
        Ok(t) => t,
        // 读不到文本类型（剪贴板里压根没有文字）→ 视为无文字，交由图片路径/空判定统一处理。
        Err(_) => return Err(ERR_EMPTY.into()),
    };
    // 仅去除首尾空白与换行，保留内部换行与空格，尽量忠实还原用户复制的文字。
    let trimmed = text.trim_matches(['\n', '\r', ' ', '\t']);
    if trimmed.is_empty() {
        return Err(ERR_EMPTY.into());
    }
    clog!("clip", "read_clipboard_text 成功: 长度={}", text.len());
    Ok(text)
}

#[tauri::command]
pub async fn read_clipboard_text() -> Result<String, String> {
    // 用 spawn_blocking 把同步剪贴板 I/O 移到独立线程，避免阻塞 tokio 运行时。
    let result = tauri::async_runtime::spawn_blocking(read_clipboard_text_sync)
        .await
        .map_err(|e| format!("剪贴板任务执行失败: {}", e))?;
    result
}

/// 将纯文本（如 OCR 识别结果）写入指定文件路径。
/// 与 save_screenshot 平级、互不干扰：前者写图片字节，本命令写 UTF-8 文本。
/// 由前端「导出文本」按钮在拿到用户选择的保存路径后调用。
#[tauri::command]
pub async fn save_text_file(
    _app: AppHandle,
    content: String,
    file_path: String,
) -> Result<(), String> {
    clog!("ocr", "save_text_file 调用: 长度={} 路径={}", content.len(), file_path);
    let path = Path::new(&file_path);
    store::write_bytes(path, content.as_bytes()).map_err(|e| {
        clog!("ocr", "写入文本文件失败: {:?} err={}", path, e);
        format!("写入文本文件失败: {}", e)
    })?;
    clog!("ocr", "文本文件已写入: {:?}", path);
    Ok(())
}

/// 将二进制字节（如 AI 生成的 .docx Word 文档）写入指定文件路径。
/// 与 save_text_file 平级：前者写 UTF-8 文本，本命令写任意二进制。
/// 由前端「导出 Word」按钮在拿到用户选择的保存路径后调用。纯增量，不影响现有功能。
#[tauri::command]
pub async fn save_binary_file(
    _app: AppHandle,
    bytes: Vec<u8>,
    file_path: String,
) -> Result<(), String> {
    clog!("ocr", "save_binary_file 调用: 字节数={} 路径={}", bytes.len(), file_path);
    let path = Path::new(&file_path);
    store::write_bytes(path, &bytes).map_err(|e| {
        clog!("ocr", "写入二进制文件失败: {:?} err={}", path, e);
        format!("写入二进制文件失败: {}", e)
    })?;
    clog!("ocr", "二进制文件已写入: {:?}", path);
    Ok(())
}
