use crate::store;
#[cfg(target_os = "macos")]
use std::process::Command;
use tauri::AppHandle;

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
    #[cfg(target_os = "macos")]
    {
        // macOS：通过 AppleScript 将 PNG 文件写入剪贴板（无需额外解码依赖）
        let bytes = store::data_url_to_bytes(&image_data)?;
        let tmp = store::temp_png_path();
        store::write_bytes(&tmp, &bytes)?;

        let path = tmp.to_str().ok_or("无效的临时路径")?;
        let script = format!(
            "set the clipboard to (read (POSIX file \"{}\") as PNG picture)",
            path.replace('"', "\\\"")
        );
        let status = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .status()
            .map_err(|e| format!("无法运行 osascript: {}", e))?;
        if !status.success() {
            return Err("复制到剪贴板失败".into());
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Windows / Linux：解码 PNG 为 RGBA，使用 arboard 写入剪贴板
        let bytes = store::data_url_to_bytes(&image_data)?;
        let tmp = store::temp_png_path();
        store::write_bytes(&tmp, &bytes)?;

        let img = image::open(tmp)
            .map_err(|e| format!("解码图片失败: {}", e))?
            .to_rgba8();
        let (w, h) = (img.width() as usize, img.height() as usize);
        let rgba = img.into_raw();

        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("剪贴板初始化失败: {}", e))?;
        clipboard
            .set_image(arboard::ImageData {
                width: w,
                height: h,
                bytes: rgba.into(),
            })
            .map_err(|e| format!("复制到剪贴板失败: {}", e))?;
        Ok(())
    }
}
