use crate::store::{self, HistoryItem};
use serde::Serialize;
use std::fs;
use std::io::Cursor;
use tauri::AppHandle;
use base64::{engine::general_purpose::STANDARD, Engine as _};

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

/// 按 id 取单条截图（避免独立编辑窗拉全量历史，图内联 base64 传输浪费）
#[tauri::command]
pub async fn get_screenshot(app: AppHandle, id: String) -> Result<Option<HistoryItem>, String> {
    let items = store::load_history(&app);
    Ok(items.into_iter().find(|it| it.id == id))
}

/// 按 id 更新某条截图的标注 JSON（只改该条，整文件回写。
/// 多窗口各自编辑不同截图时，互相不会覆盖对方的标注）
#[tauri::command]
pub async fn update_screenshot_annotations(
    app: AppHandle,
    id: String,
    annotations_json: String,
) -> Result<(), String> {
    let mut items = store::load_history(&app);
    if let Some(item) = items.iter_mut().find(|it| it.id == id) {
        item.annotations = annotations_json;
        store::save_history(&app, &items)
    } else {
        Err(format!("screenshot not found: {}", id))
    }
}

/// 按 id 更新某条截图的底图（裁剪后回写 data_url + 宽高）。
/// 裁剪使旧标注坐标系与 OCR 结果全部失效，故一并清空（与前端 clearAnnotations 对齐），
/// 避免重开历史时旧标注错位叠加在新图上、或 OCR 框指向错误位置。
/// 设计动机：此前裁剪只更新编辑窗本地 state，从不落库，关窗重开回到裁剪前原图（数据丢失）。
#[tauri::command]
pub async fn update_screenshot_image(
    app: AppHandle,
    id: String,
    data_url: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let mut items = store::load_history(&app);
    if let Some(item) = items.iter_mut().find(|it| it.id == id) {
        item.data_url = data_url;
        item.width = width;
        item.height = height;
        item.annotations = String::new();
        item.ocr_text = String::new();
        item.ocr_blocks_json = String::new();
        store::save_history(&app, &items)
    } else {
        Err(format!("screenshot not found: {}", id))
    }
}

/// 按 id 写入某条截图的 OCR 识别文字（纯文本）。
/// 与 update_screenshot_annotations 平级：前者存标注、本命令存识别结果，
/// 关窗后从历史重开（独立编辑窗）即可直接回显文字，无需二次识别。
/// 设计动机：剪贴板图片/截图经 OCR 后，结果应随历史持久化，消除「识别完关窗再开文字没了」的断层。
#[tauri::command]
pub async fn set_screenshot_ocr(
    app: AppHandle,
    id: String,
    ocr_text: String,
) -> Result<(), String> {
    let mut items = store::load_history(&app);
    if let Some(item) = items.iter_mut().find(|it| it.id == id) {
        item.ocr_text = ocr_text;
        store::save_history(&app, &items)
    } else {
        Err(format!("screenshot not found: {}", id))
    }
}

/// v4：写入某条截图的 OCR 完整结果（含每块归一化 bbox + 置信度，JSON 字符串）。
/// 与 set_screenshot_ocr 平级：后者存纯文本，本命令存「坐标 + 文本」联合。
/// 关窗重开后能取字位置、逐行框选/编辑、按框选局部重识别（不再伪造占位 bbox）。
/// 空字符串=清除（允许前端主动擦除坐标仅保留纯文本）。
#[tauri::command]
pub async fn set_screenshot_ocr_full(
    app: AppHandle,
    id: String,
    ocr_text: String,
    ocr_blocks_json: String,
) -> Result<(), String> {
    let mut items = store::load_history(&app);
    if let Some(item) = items.iter_mut().find(|it| it.id == id) {
        item.ocr_text = ocr_text;
        item.ocr_blocks_json = ocr_blocks_json;
        store::save_history(&app, &items)
    } else {
        Err(format!("screenshot not found: {}", id))
    }
}

/// 导入图片的结果：成功入库的条目 + 因格式不支持等被跳过的文件（附原因）。
#[derive(Serialize)]
pub struct ImportImagesResult {
    pub items: Vec<HistoryItem>,
    pub skipped: Vec<String>,
}

/// 把单个图片文件读入为 HistoryItem（source='imported'）。
/// 通过内容嗅探确定真实 MIME 与宽高，避免硬编码 png 前缀导致 jpg/webp 等无法渲染；
/// image crate 不支持的格式（如 HEIC/AVIF）或无法解析尺寸的文件，返回 Err 交由外层标记 skipped。
fn import_one_image(path: &std::path::Path) -> Result<HistoryItem, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取失败: {}", e))?;
    let fmt = image::guess_format(&bytes).map_err(|e| format!("无法识别图片格式: {}", e))?;
    let mime = match fmt {
        image::ImageFormat::Png => "png",
        image::ImageFormat::Jpeg => "jpeg",
        image::ImageFormat::WebP => "webp",
        image::ImageFormat::Gif => "gif",
        image::ImageFormat::Bmp => "bmp",
        image::ImageFormat::Tiff => "tiff",
        _ => return Err("不支持的图片格式".into()),
    };
    let dim = image::ImageReader::new(Cursor::new(bytes.clone()))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .into_dimensions()
        .map_err(|e| format!("无法解析图片尺寸: {}", e))?;
    let data_url = format!("data:image/{};base64,{}", mime, STANDARD.encode(&bytes));
    Ok(HistoryItem {
        id: uuid::Uuid::new_v4().to_string(),
        data_url,
        created_at: chrono::Utc::now().to_rfc3339(),
        width: dim.0,
        height: dim.1,
        source: "imported".to_string(),
        annotations: String::new(),
        ocr_text: String::new(),
        ocr_blocks_json: String::new(),
    })
}

/// 导入本地图片文件进历史库（source='imported'）。前端随后用 openEditorWindow(id) 打开，
/// 复用现有标注 / OCR / AI 编辑 / 导出 / 批量全部能力——编辑器按 history id 取图，
/// 完全不感知图来自截屏还是文件。导入即复制进历史库，绝不触碰磁盘上的原文件（非破坏性）。
#[tauri::command]
pub async fn import_images(app: AppHandle, paths: Vec<String>) -> Result<ImportImagesResult, String> {
    let mut new_items: Vec<HistoryItem> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for p in paths {
        let path = std::path::Path::new(&p);
        match import_one_image(path) {
            Ok(item) => new_items.push(item),
            Err(e) => skipped.push(format!("{}: {}", p, e)),
        }
    }
    if !new_items.is_empty() {
        let items = store::load_history(&app);
        let mut combined = new_items.clone();
        combined.extend(items);
        combined.truncate(100);
        store::save_history(&app, &combined)?;
    }
    Ok(ImportImagesResult { items: new_items, skipped })
}
