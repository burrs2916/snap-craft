//! 用系统默认程序打开外部目标（URL / 邮件 / 电话 / 文件路径 / 在文件管理器中显示）。
//!
//! 复用项目已集成的 `tauri-plugin-opener`（Cargo.toml 已依赖、
//! capabilities 已授予 `opener:default`），不引入任何新 crate；
//! 仅新增一个薄命令，零改动其它功能。供 OCR 实体区块「点击打开」与
//! 文档导出后「在 Finder 中显示」调用。

use std::path::Path;
use tauri_plugin_opener::{open_path, open_url, reveal_item_in_dir};

/// 打开外部目标：
/// - `http(s):` / `mailto:` / `tel:` / `www.` 开头 → 作为 URL 用系统默认程序打开；
/// - 本地存在的文件路径 → 用系统默认程序打开；
/// - 其它（如裸域名 `example.com`）→ 兜底当作 https URL 尝试打开。
///
/// 失败返回中文错误（供前端 toast 展示）。只读、不写、不申请额外权限。
#[tauri::command]
pub async fn open_external(target: String) -> Result<(), String> {
    let t = target.trim();
    if t.is_empty() {
        return Err("打开目标为空".into());
    }
    let lower = t.to_lowercase();
    let res = if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with("tel:")
    {
        open_url(t, None::<&str>)
    } else if lower.starts_with("www.") {
        open_url(format!("https://{}", t), None::<&str>)
    } else if Path::new(t).exists() {
        open_path(t, None::<&str>)
    } else {
        // 兜底：裸域名等当成 https URL 尝试打开
        open_url(format!("https://{}", t), None::<&str>)
    };
    res.map_err(|e| format!("打开失败：{}", e))
}

/// 在文件管理器（macOS Finder / Windows Explorer / Linux xdg-open）中显示目标文件。
/// 当文件存在时聚焦到该文件；当其父目录存在但文件已被移动/删除时聚焦到父目录；
/// 两者都不存在时返回本地化错误信息。
///
/// 复用 `tauri-plugin-opener` 已有的 `reveal_item_in_dir`（不需要新 crate），
/// 用于补齐文档导出后的"在 Finder 中显示"刚需按钮。
#[tauri::command]
pub async fn reveal_in_folder(path: String) -> Result<(), String> {
    let p = Path::new(path.trim());
    let target = if p.exists() {
        p.to_path_buf()
    } else if let Some(parent) = p.parent() {
        if parent.as_os_str().is_empty() || !parent.exists() {
            return Err("目标文件不存在，且无法定位其父目录".into());
        }
        parent.to_path_buf()
    } else {
        return Err("目标路径无效".into());
    };
    reveal_item_in_dir(&target).map_err(|e| format!("显示失败：{}", e))
}
