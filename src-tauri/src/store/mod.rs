use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HistoryItem {
    pub id: String,
    #[serde(default)]
    pub data_url: Option<String>, // 旧格式兼容；新格式恒为 None（图片存独立文件）
    #[serde(default)]
    pub file: Option<String>,     // 图片文件名，如 "<id>.png"
    pub created_at: String,
    pub width: u32,
    pub height: u32,
}

const DATA_URL_PREFIX: &str = "data:image/png;base64,";

/// 返回应用配置目录（不存在则创建）
pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn history_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("history.json"))
}

/// 历史截图图片目录（每张图一个独立 PNG 文件，避免 history.json 随截图增多无限膨胀）
pub fn history_images_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("history");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn load_history(app: &tauri::AppHandle) -> Vec<HistoryItem> {
    let path = match history_path(app) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let mut items: Vec<HistoryItem> = match fs::read_to_string(&path) {
        Ok(content) if !content.trim().is_empty() => {
            serde_json::from_str(&content).unwrap_or_default()
        }
        _ => Vec::new(),
    };
    // 兼容旧格式：图片 data_url 内联在 JSON 里。迁移为独立 PNG 文件，history.json 只留轻量元数据。
    if let Ok(dir) = history_images_dir(app) {
        let mut migrated = false;
        for it in items.iter_mut() {
            if it.data_url.is_some() && it.file.is_none() {
                if let Some(b64) = it.data_url.clone() {
                    if let Ok(bytes) = data_url_to_bytes(&b64) {
                        let fname = format!("{}.png", it.id);
                        if write_bytes(&dir.join(&fname), &bytes).is_ok() {
                            it.file = Some(fname);
                            it.data_url = None;
                            migrated = true;
                        }
                    }
                }
            }
        }
        if migrated {
            let _ = save_history(app, &items);
        }
    }
    items
}

pub fn save_history(app: &tauri::AppHandle, items: &[HistoryItem]) -> Result<(), String> {
    let path = history_path(app)?;
    let json = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    // 原子写：先写临时文件再 rename，避免写到一半崩溃损坏 history.json
    let tmp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| format!("历史保存失败: {}", e))?;
    Ok(())
}

/// 生成唯一的临时 PNG 路径
pub fn temp_png_path() -> PathBuf {
    let name = format!("snapcraft-{}.png", uuid::Uuid::new_v4());
    std::env::temp_dir().join(name)
}

/// 读取图片文件并编码为 data URL
pub fn file_to_data_url(path: &std::path::Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(format!("{}{}", DATA_URL_PREFIX, STANDARD.encode(bytes)))
}

/// 将 data URL 解码为字节
pub fn data_url_to_bytes(data_url: &str) -> Result<Vec<u8>, String> {
    let b64 = data_url
        .split_once(',')
        .map(|(_, b)| b)
        .unwrap_or(data_url);
    STANDARD.decode(b64).map_err(|e| e.to_string())
}

/// 将字节写入文件
pub fn write_bytes(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// 读取某条历史的图片，返回 data URL（优先读独立 PNG 文件，旧格式回退到内联 data_url）
pub fn read_history_image(app: &tauri::AppHandle, id: &str) -> Result<String, String> {
    // 防路径穿越：id 仅允许字母数字、点、下划线、连字符
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return Err("非法的历史 id".into());
    }
    let dir = history_images_dir(app)?;
    let fpath = dir.join(format!("{}.png", id));
    if fpath.exists() {
        return file_to_data_url(&fpath);
    }
    // 旧格式回退：从元数据里取内联 data_url
    let items = load_history(app);
    if let Some(it) = items.iter().find(|i| i.id == id) {
        if let Some(d) = &it.data_url {
            return Ok(d.clone());
        }
    }
    Err("未找到该历史截图图片".into())
}
