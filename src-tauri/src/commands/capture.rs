use crate::store;
use std::process::Command;
use tauri::AppHandle;
#[cfg(not(target_os = "macos"))]
use tauri::Manager;

/// 区域截图时前端传来的矩形（设备像素，相对主显示器左上角）
#[derive(serde::Deserialize)]
#[allow(dead_code)]
pub struct CaptureRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// macOS 显示器信息（全局坐标 + 是否主屏 + scale）
#[derive(serde::Serialize)]
pub struct DisplayInfo {
    pub id: u32,
    pub is_main: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

/// macOS 原生截图（全屏/区域/窗口），返回 PNG 的 data URL
fn capture_to_data_url(args: &[&str]) -> Result<String, String> {
    if !cfg!(target_os = "macos") {
        return Err("当前平台暂仅支持 macOS 原生截图".into());
    }

    let path = store::temp_png_path();
    let path_str = path.to_str().ok_or("无效的临时路径")?;

    // 区域(-i)/窗口(-w) 是交互式（有系统选区 UI，可 Esc 取消）；
    // -R 是非交互（指定矩形），-x 无 UI（全屏，失败即权限问题）
    let is_interactive = args.iter().any(|a| *a == "-i" || *a == "-w");

    let output = Command::new("screencapture")
        .args(args)
        .arg(path_str)
        .output()
        .map_err(|e| format!("无法启动 screencapture: {}", e))?;

    // 成功：生成了 PNG 文件
    if path.exists() {
        return store::file_to_data_url(&path);
    }

    // 未生成文件：区分「用户取消」「权限被拒」「其他真实错误」
    let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
    let looks_denied = stderr.contains("denied")
        || stderr.contains("permission")
        || stderr.contains("not authorized");

    if looks_denied {
        return Err(
            "截图失败：SnapCraft 没有「屏幕录制」权限。请打开 系统设置 → 隐私与安全性 → 屏幕录制，\
             找到 SnapCraft 并开启开关，然后重试。\n\
             提示：用 `tauri dev` 每次重编都会变更签名，权限可能不生效；建议执行 `pnpm tauri build` \
            后运行打包好的 SnapCraft.app（签名稳定，权限才能被系统记住）。"
                .into(),
        );
    }

    // 交互式截图（区域/窗口）按 Esc 或点空白取消：stderr 多为空或含 cancel
    if is_interactive && (stderr.trim().is_empty() || stderr.contains("cancel")) {
        return Err("截图已取消".into());
    }

    // 其它情况（含 -R 矩形非法、-w 启动失败等）如实上报，不再被静默吞掉
    if !stderr.trim().is_empty() {
        return Err(format!("截图失败：{}", stderr.trim()));
    }

    Err("截图已取消".into())
}

#[tauri::command]
pub async fn capture_screen(_app: AppHandle, display_id: Option<u32>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        // 等待窗口隐藏完成，避免截到自身窗口（macOS 隐藏存在极短过渡）
        std::thread::sleep(std::time::Duration::from_millis(200));
        let mut parts: Vec<String> = vec!["-x".into()];
        if let Some(d) = display_id {
            parts.push("-D".into());
            parts.push(d.to_string());
        }
        let refs: Vec<&str> = parts.iter().map(|s| s.as_str()).collect();
        capture_to_data_url(&refs)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = display_id;
        xcap_capture::capture_xcap_screen()
    }
}

#[tauri::command]
pub async fn capture_region(_app: AppHandle, rect: Option<CaptureRect>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        // 收到 rect（来自透明覆盖层）：用非交互 -R 按全局坐标截取，彻底绕开
        // 交互式 screencapture -i 在「App 非前台」时选框起不来的问题，且支持跨屏。
        // rect 已是全局 Quartz 坐标（points），与 screencapture -R 同坐标系。
        if let Some(r) = rect {
            if r.width >= 5 && r.height >= 5 {
                let rarg = format!("{},{},{},{}", r.x, r.y, r.width, r.height);
                let parts = ["-x".to_string(), "-R".to_string(), rarg];
                let refs: Vec<&str> = parts.iter().map(|s| s.as_str()).collect();
                return capture_to_data_url(&refs);
            }
        }
        // 兜底：无 rect 时退回交互式（理论上覆盖层总会传 rect）
        capture_to_data_url(&["-i"])
    }
    #[cfg(not(target_os = "macos"))]
    {
        // 区域由应用内覆盖层选择；截图前先隐藏覆盖层，避免被截入画面
        if let Some(w) = _app.get_webview_window("capture-overlay") {
            let _ = w.hide();
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        xcap_capture::capture_xcap_region(rect)
    }
}

#[tauri::command]
pub async fn capture_window(_app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        // 窗口截图是交互式（-w）。覆盖层（我们的窗口）刚被隐藏时 App 可能不再是前台，
        // 这里主动把 SnapCraft 提到前台，确保 screencapture 的取窗 UI 能接收点击。
        let _ = Command::new("osascript")
            .args(["-e", "activate application \"SnapCraft\""])
            .output();
        capture_to_data_url(&["-w"])
    }
    #[cfg(not(target_os = "macos"))]
    {
        xcap_capture::capture_xcap_window()
    }
}

// ===== Windows / Linux：使用 xcap 原生截屏 =====
#[cfg(not(target_os = "macos"))]
mod xcap_capture {
    use super::*;
    use xcap::{Monitor, Window};

    fn save_and_encode(image: image::RgbaImage) -> Result<String, String> {
        let path = store::temp_png_path();
        let path_str = path.to_str().ok_or("无效的临时路径")?.to_string();
        image
            .save(path_str)
            .map_err(|e| format!("保存截图失败: {}", e))?;
        store::file_to_data_url(&path)
    }

    pub fn capture_xcap_screen() -> Result<String, String> {
        let monitor = Monitor::from_point(0, 0).map_err(|e| format!("获取主显示器失败: {}", e))?;
        let image = monitor
            .capture_image()
            .map_err(|e| format!("全屏截屏失败: {}", e))?;
        save_and_encode(image)
    }

    pub fn capture_xcap_region(rect: Option<CaptureRect>) -> Result<String, String> {
        let rect = rect.ok_or("区域截屏需要先选择区域")?;
        let monitor = Monitor::from_point(0, 0).map_err(|e| format!("获取主显示器失败: {}", e))?;
        let image = monitor
            .capture_region(rect.x as u32, rect.y as u32, rect.width, rect.height)
            .map_err(|e| format!("区域截屏失败: {}", e))?;
        save_and_encode(image)
    }

    pub fn capture_xcap_window() -> Result<String, String> {
        let windows = Window::all().map_err(|e| format!("枚举窗口失败: {}", e))?;
        let window = windows
            .into_iter()
            .find(|w| !w.is_minimized().unwrap_or(true))
            .ok_or("未找到可截图的窗口")?;
        let image = window
            .capture_image()
            .map_err(|e| format!("窗口截屏失败: {}", e))?;
        save_and_encode(image)
    }
}

// ===== macOS 显示器枚举（CoreGraphics） =====
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGGetActiveDisplayList(
        max_displays: u32,
        active_displays: *mut u32,
        display_count: *mut u32,
    ) -> i32;
    fn CGDisplayBounds(display: u32) -> CGRect;
    fn CGMainDisplayID() -> u32;
    // CGDisplayScaleFactor 在较新 macOS SDK 中已从 CoreGraphics 移除（链接报 undefined symbol），
    // 改用物理像素 CGDisplayPixelsWide/High 除以逻辑点 CGDisplayBounds 反推 scale。
    fn CGDisplayPixelsWide(display: u32) -> usize;
    fn CGDisplayPixelsHigh(display: u32) -> usize;
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGSize {
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

/// 枚举所有显示器：全局坐标 (x,y,width,height 为逻辑点)、是否主屏、scale。
/// 用于前端显示器选择器与覆盖层跨屏铺满。
#[tauri::command]
pub fn list_displays() -> Vec<DisplayInfo> {
    #[cfg(target_os = "macos")]
    {
        const MAX: u32 = 32;
        let mut displays: [u32; MAX as usize] = [0; MAX as usize];
        let mut count: u32 = 0;
        unsafe {
            CGGetActiveDisplayList(MAX, displays.as_mut_ptr(), &mut count);
        }
        let main = unsafe { CGMainDisplayID() };
        let mut out = Vec::new();
        for (i, &d) in displays.iter().enumerate().take(count as usize) {
            let b = unsafe { CGDisplayBounds(d) };
            let px_w = unsafe { CGDisplayPixelsWide(d) } as u32;
            let px_h = unsafe { CGDisplayPixelsHigh(d) } as u32;
            // scale = 物理像素 / 逻辑点（Retina 2x → 2.0；自定义缩放如 1.5x），两轴取平均更稳健
            let scale = if b.size.width > 0.0 && b.size.height > 0.0 {
                ((px_w as f64 / b.size.width) + (px_h as f64 / b.size.height)) / 2.0
            } else {
                1.0
            };
            out.push(DisplayInfo {
                // screencapture -D 用 1 基序号（1=主屏，其余按 CGGetActiveDisplayList 顺序）
                id: (i as u32) + 1,
                is_main: d == main,
                x: b.origin.x as i32,
                y: b.origin.y as i32,
                width: b.size.width as u32,
                height: b.size.height as u32,
                scale,
            });
        }
        out
    }
    #[cfg(not(target_os = "macos"))]
    {
        vec![]
    }
}

// ===== macOS 屏幕录制权限（仅 macOS） =====
// CGPreflightScreenCaptureAccess：预检权限状态，不弹窗
// CGRequestScreenCaptureAccess：请求权限，首次调用会弹出系统授权对话框
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> std::os::raw::c_uchar;
    fn CGRequestScreenCaptureAccess() -> std::os::raw::c_uchar;
}

#[cfg(target_os = "macos")]
fn mac_has_screen_capture_access() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() != 0 }
}

/// 检测当前是否已获得屏幕录制权限。非 macOS 直接返回 true（不需要）。
#[tauri::command]
pub fn check_screen_capture_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac_has_screen_capture_access()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// 请求屏幕录制权限。首次调用会弹出系统授权对话框，用户点击后系统会创建 TCC 条目。
/// 已授权时直接返回 true。非 macOS 返回 true。
/// 这是解决「ad-hoc 签名权限不持久」的关键——系统弹窗授权创建的 TCC 条目比手动开关更稳定。
#[tauri::command]
pub fn request_screen_capture_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        // 先预检：已授权就直接返回，避免重复弹窗
        if mac_has_screen_capture_access() {
            return true;
        }
        // 请求权限——会弹出系统授权对话框
        unsafe { CGRequestScreenCaptureAccess() != 0 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// 一键打开「系统设置 → 屏幕录制」面板。用户在列表里找到 SnapCraft 打开开关即可，无需手动查找。
#[tauri::command]
pub fn open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .status()
            .map_err(|e| format!("打开系统设置失败: {}", e))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("仅 macOS 需要此操作".into())
    }
}
