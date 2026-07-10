use crate::store::{self, HistoryItem};
use tauri::AppHandle;

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
    items.insert(0, item);
    // 最多保留 100 条，避免体积膨胀
    items.truncate(100);
    store::save_history(&app, &items)
}

/// 按 id 删除一条历史记录
#[tauri::command]
pub async fn delete_history(app: AppHandle, id: String) -> Result<(), String> {
    let mut items = store::load_history(&app);
    items.retain(|it| it.id != id);
    store::save_history(&app, &items)
}

/// 清空全部历史记录
#[tauri::command]
pub async fn clear_history(app: AppHandle) -> Result<(), String> {
    store::save_history(&app, &[])
}
