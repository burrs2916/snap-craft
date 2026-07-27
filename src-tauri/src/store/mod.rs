use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HistoryItem {
    pub id: String,
    pub data_url: String,
    pub created_at: String,
    pub width: u32,
    pub height: u32,
    // 来源标记：'capture'=本机截图，'clipboard'=从系统剪贴板读取的图片。
    // serde(default) 保证旧 history.json（无此字段）仍能安全加载，不会清空历史。
    #[serde(default)]
    pub source: String,
    // 标注 JSON（AnnotationObject[] 的 JSON 字符串）。空字符串=无标注。
    // serde(default) 保证旧 history.json 缺此字段也能安全加载。
    #[serde(default)]
    pub annotations: String,
    // OCR 识别文字（纯文本）。空字符串=尚未识别或识别无结果。
    // serde(default) 保证旧 history.json 缺此字段也能安全加载，且独立编辑窗重开时可直接回显，
    // 避免「剪贴板图片 OCR 后关窗重开文字丢失、必须重识别」的体验断层。
    #[serde(default)]
    pub ocr_text: String,
    // OCR 完整结果（含每块归一化 bbox 与置信度，JSON 字符串）。
    // 与 ocr_text 平级：纯文本是「快读/搜索」用，本字段是「重开取字/二次编辑」用。
    // 空字符串 = 旧版本未持久化 / 旧截图未带坐标；前端用「全幅占位」回退。
    // serde(default) 保证向后兼容。
    #[serde(default)]
    pub ocr_blocks_json: String,
}

const DATA_URL_PREFIX: &str = "data:image/png;base64,";

/// 返回应用配置目录（不存在则创建）
pub fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
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
    let dir = path.parent().ok_or("无法获取历史目录")?;
    let json = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;

    // 原子写：先写临时文件再 rename，避免写中途崩溃导致 history.json 被截断损坏。
    // 同目录 rename 在同一文件系统上是原子的（POSIX rename / Windows MoveFileEx）。
    let tmp_path = dir.join(format!(
        ".history.json.tmp.{}",
        uuid::Uuid::new_v4()
    ));
    {
        let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp_path, &path).map_err(|e| {
        // rename 失败时清理临时文件，避免残留
        let _ = fs::remove_file(&tmp_path);
        e.to_string()
    })?;
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
    let b64 = data_url.split_once(',').map(|(_, b)| b).unwrap_or(data_url);
    STANDARD.decode(b64).map_err(|e| e.to_string())
}

/// 将字节写入文件
pub fn write_bytes(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    Ok(())
}

// ===== 应用设置（持久化到 settings.json）=====
// 当前字段：
//   hide_self_in_capture：截图时是否隐藏 SnapCraft 自身全部窗口。
//     true（默认）= 隐藏后再截，截图里不出现 SnapCraft 任何窗口；
//     false         = 不隐藏，允许把 SnapCraft 自身窗口也截进去。
// 进程级缓存（OnceLock）避免每次截图都读盘；set 时同步刷新缓存与落盘。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppSettings {
    #[serde(default = "default_true")]
    pub hide_self_in_capture: bool,
}

fn default_true() -> bool {
    true
}

// ⚠️ 关键：绝不能 derive Default —— bool 的 Default 派生恒为 false，会让
// `AppSettings::default()` 得到 hide_self_in_capture=false（不隐藏），与
// 「默认隐藏本软件」的产品语义相反。serde(default) 只对反序列化生效，管不到
// `Default` 派生。这里手写 Default 显式给 true，确保无 settings.json 时也隐藏。
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            hide_self_in_capture: true,
        }
    }
}

/// 进程级缓存：首次访问时惰性从 settings.json 载入；后续读写走内存。
pub static APP_SETTINGS: OnceLock<Arc<RwLock<AppSettings>>> = OnceLock::new();

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("settings.json"))
}

pub fn load_app_settings(app: &AppHandle) -> AppSettings {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => return AppSettings::default(),
    };
    match fs::read_to_string(&path) {
        Ok(content) if !content.trim().is_empty() => {
            serde_json::from_str(&content).unwrap_or_default()
        }
        _ => AppSettings::default(),
    }
}

pub fn save_app_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let dir = path.parent().ok_or("无法获取设置目录")?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;

    // 原子写：先写临时文件再 rename，避免写中途崩溃导致 settings.json 被截断。
    let tmp_path = dir.join(format!(".settings.json.tmp.{}", uuid::Uuid::new_v4()));
    {
        let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp_path, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        e.to_string()
    })?;

    // 落盘成功后再刷新内存缓存
    if let Some(slot) = APP_SETTINGS.get() {
        *slot.write().unwrap() = settings.clone();
    }
    Ok(())
}

/// 截图前判断是否应隐藏 SnapCraft 自身窗口。
/// 进程级缓存惰性初始化（首次调用从 settings.json 载入）；未初始化或读盘失败时默认 true（隐藏，安全）。
pub fn should_hide_self(app: &AppHandle) -> bool {
    let slot = APP_SETTINGS.get_or_init(|| Arc::new(RwLock::new(load_app_settings(app))));
    slot.read().unwrap().hide_self_in_capture
}
