use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HistoryItem {
    pub id: String,
    pub data_url: String,
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

pub fn load_history(app: &tauri::AppHandle) -> Vec<HistoryItem> {
    let path = match history_path(app) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    match fs::read_to_string(&path) {
        Ok(content) if !content.trim().is_empty() => {
            serde_json::from_str(&content).unwrap_or_default()
        }
        _ => Vec::new(),
    }
}

pub fn save_history(app: &tauri::AppHandle, items: &[HistoryItem]) -> Result<(), String> {
    let path = history_path(app)?;
    let json = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    let mut file = fs::File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
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
