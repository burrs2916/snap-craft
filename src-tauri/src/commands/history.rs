use std::fs;
use tauri::AppHandle;
use crate::store::{self, HistoryItem};

/// 读取截图历史记录
#[tauri::command]
pub async fn get_history(app: AppHandle) -> Result<Vec<HistoryItem>, String> {
    Ok(store::load_history(&app))
}

/// 追加一条截图历史记录（去重 + 限制数量）
#[tauri::command]
pub async fn add_history(app: AppHandle, item: HistoryItem) -> Result<(), String> {
    let mut items = store::load_history(&app);
    items.retain(|it| it.id != item.id);
    // 把内联 data_url 落盘为独立 PNG，元数据只保留 file 引用（history.json 不存大图）
    let mut new_item = item;
    if let Some(b64) = new_item.data_url.clone() {
        let dir = store::history_images_dir(&app)?;
        let bytes = store::data_url_to_bytes(&b64)?;
        let fname = format!("{}.png", new_item.id);
        store::write_bytes(&dir.join(&fname), &bytes)?;
        new_item.file = Some(fname);
        new_item.data_url = None;
    }
    items.insert(0, new_item);
    // 最多保留 100 条，避免体积膨胀
    items.truncate(100);
    store::save_history(&app, &items)
}

/// 按 id 读取一条历史截图的图片数据（独立 PNG 文件）
#[tauri::command]
pub async fn get_history_image(app: AppHandle, id: String) -> Result<String, String> {
    store::read_history_image(&app, &id)
}

/// 按 id 删除一条历史记录
#[tauri::command]
pub async fn delete_history(app: AppHandle, id: String) -> Result<(), String> {
    let mut items = store::load_history(&app);
    items.retain(|it| it.id != id);
    store::save_history(&app, &items)?;
    // 一并删除对应的 PNG 图片文件
    if let Ok(dir) = store::history_images_dir(&app) {
        let _ = fs::remove_file(dir.join(format!("{}.png", id)));
    }
    Ok(())
}

/// 清空全部历史记录
#[tauri::command]
pub async fn clear_history(app: AppHandle) -> Result<(), String> {
    if let Ok(dir) = store::history_images_dir(&app) {
        if let Ok(entries) = fs::read_dir(&dir) {
            for e in entries.flatten() {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    store::save_history(&app, &[])
}
