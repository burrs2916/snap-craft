#[cfg(target_os = "macos")]
use std::process::Command;
use tauri::AppHandle;
use tauri::Manager;
use crate::store;

/// 区域截图时前端透明覆盖层传来的矩形（全局 Quartz 逻辑点坐标，原点主屏左上、y 向下，
/// 含所有显示器；可能为负数，如位于主屏左侧的副屏）。与 CGWindowListCreateImage 同坐标系。
#[derive(serde::Deserialize)]
#[allow(dead_code)]
pub struct CaptureRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// macOS 显示器信息（全局坐标 + 是否主屏 + scale + 真实物理像素）
#[derive(serde::Serialize)]
pub struct DisplayInfo {
    pub id: u32,
    /// 逻辑点宽（系统设置里「看起来」的分辨率，用于 UI 布局与坐标换算）
    pub width: u32,
    /// 逻辑点高
    pub height: u32,
    /// 缩放比 = 物理像素 / 逻辑点（Retina 2x → 2.0；普通屏 → 1.0；自定义缩放如 1.5x）
    pub scale: f64,
    /// 真实物理像素宽（截图实际抓到的像素数，CGDisplayPixelsWide）
    pub physical_width: u32,
    /// 真实物理像素高
    pub physical_height: u32,
    pub is_main: bool,
    pub x: i32,
    pub y: i32,
}

/// macOS 原生截图（全屏/区域/窗口），返回 PNG 的 data URL
#[cfg(target_os = "macos")]
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
        // 双保险：强制把 SnapCraft 自身窗口设为不可见，避免截图瞬间工具界面仍在最前
        // （尤其窗口最大化时表现为整屏黑屏）。前端已 win.hide()，这里再兜底一次。
        let _ = Command::new("osascript")
            .args([
                "-e",
                "tell application \"System Events\" to set visible of (first process whose name is \"SnapCraft\") to false",
            ])
            .output();
        // 等待自身窗口隐藏动画完成（macOS 隐藏有动画延迟）
        std::thread::sleep(std::time::Duration::from_millis(400));

        // 选定要抓取的显示器：display_id 来自 list_displays 的 1-based id（即
        // CGGetActiveDisplayList 数组下标 + 1），直接拿对应的 CGDirectDisplayID，
        // 用 CGDisplayCreateImage 精确抓那块屏——100% 对应，不受屏幕排列顺序影响。
        let displays = enumerate_displays();
        let target = match display_id {
            Some(idx) => {
                let i = (idx as usize).saturating_sub(1);
                displays.get(i).copied().unwrap_or_else(|| {
                    if displays.is_empty() {
                        unsafe { CGMainDisplayID() }
                    } else {
                        displays[0]
                    }
                })
            }
            None => {
                if displays.is_empty() {
                    unsafe { CGMainDisplayID() }
                } else {
                    displays[0]
                }
            }
        };

        let img = unsafe { CGDisplayCreateImage(target) };
        if img.is_null() {
            return Err(
                "截图失败：可能 SnapCraft 未获得「屏幕录制」权限，或无法抓取该显示器画面。\
                 \n请打开 系统设置 → 隐私与安全性 → 屏幕录制，确认 SnapCraft 已开启开关。\
                 \n（若以开发模式 tauri dev 运行，系统不会登记本应用，请改用 build 出的 .app）"
                    .into(),
            );
        }
        let result = cgimage_to_rgba(img).and_then(|rgba| {
            let path = store::temp_png_path();
            let path_str = path.to_str().ok_or("无效的临时路径")?.to_string();
            rgba
                .save(&path_str)
                .map_err(|e| format!("保存截图失败: {}", e))?;
            store::file_to_data_url(&path)
        });
        unsafe { CGImageRelease(img) };
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = display_id;
        #[cfg(windows)]
        {
            win_capture::capture_screen()
        }
        #[cfg(not(windows))]
        {
            Err("当前平台不支持全屏截图".into())
        }
    }
}

#[tauri::command]
pub async fn capture_region(_app: AppHandle, rect: Option<CaptureRect>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        // 收到 rect（来自透明覆盖层，已是全局 Quartz 逻辑点坐标）：用 CGWindowListCreateImage
        // 按全局坐标精确抓取该区域。彻底绕开 screencapture -R 的坐标歧义，且天然支持跨屏。
        // 调用前主窗口与覆盖层均已隐藏，所以抓到的是干净的真实屏幕。
        if let Some(r) = rect {
            if r.width >= 5 && r.height >= 5 {
                let bounds = CGRect {
                    origin: CGPoint {
                        x: r.x as f64,
                        y: r.y as f64,
                    },
                    size: CGSize {
                        width: r.width as f64,
                        height: r.height as f64,
                    },
                };
                // kCGWindowListOptionOnScreenOnly = 2, kCGNullWindowID = 0, kCGWindowImageDefault = 0
                let img = unsafe { CGWindowListCreateImage(bounds, 2, 0, 0) };
                if img.is_null() {
                    return Err("区域截屏失败：无法抓取该区域（可能未获得屏幕录制权限）".into());
                }
                let result = cgimage_to_rgba(img).and_then(|rgba| {
                    let path = store::temp_png_path();
                    let path_str = path.to_str().ok_or("无效的临时路径")?.to_string();
                    rgba
                        .save(&path_str)
                        .map_err(|e| format!("保存截图失败: {}", e))?;
                    store::file_to_data_url(&path)
                });
                unsafe { CGImageRelease(img) };
                return result;
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
        #[cfg(windows)]
        {
            win_capture::capture_region(rect)
        }
        #[cfg(not(windows))]
        {
            let _ = rect;
            Err("当前平台不支持区域截图".into())
        }
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
        #[cfg(windows)]
        {
            win_capture::capture_window()
        }
        #[cfg(not(windows))]
        {
            Err("当前平台不支持窗口截图".into())
        }
    }
}

// ===== Windows：原生截屏 =====
// 屏幕/区域继续用 xcap（其底层即 Windows 原生 BitBlt，已支持多屏）；
// 窗口截图升级为原生 PrintWindow —— 可截取「隐藏 / 被遮挡」窗口的真实内容
// （这是 Windows 独有、macOS 做不到的优势），失败时回退 xcap。
#[cfg(windows)]
mod win_capture {
    use super::*;
    use image::RgbaImage;
    use std::ffi::c_void;
    use xcap::{Monitor, Window};

    fn save_and_encode(image: RgbaImage) -> Result<String, String> {
        let path = store::temp_png_path();
        let path_str = path.to_str().ok_or("无效的临时路径")?.to_string();
        image
            .save(path_str)
            .map_err(|e| format!("保存截图失败: {}", e))?;
        store::file_to_data_url(&path)
    }

    // 屏幕截图：xcap 抓主显示器（原生 BitBlt）
    pub fn capture_screen() -> Result<String, String> {
        let monitor = Monitor::from_point(0, 0)
            .map_err(|e| format!("获取主显示器失败: {}", e))?;
        save_and_encode(
            monitor
                .capture_image()
                .map_err(|e| format!("全屏截屏失败: {}", e))?,
        )
    }

    // 区域截图：xcap 按全局坐标抓（原生 BitBlt）
    pub fn capture_region(rect: Option<CaptureRect>) -> Result<String, String> {
        let rect = rect.ok_or("区域截屏需要先选择区域")?;
        let monitor = Monitor::from_point(0, 0)
            .map_err(|e| format!("获取主显示器失败: {}", e))?;
        // 区域坐标在 Windows 上相对主显示器左上角，理论非负；极端负值夹断避免越界。
        let x: u32 = if rect.x < 0 { 0 } else { rect.x as u32 };
        let y: u32 = if rect.y < 0 { 0 } else { rect.y as u32 };
        save_and_encode(
            monitor
                .capture_region(x, y, rect.width, rect.height)
                .map_err(|e| format!("区域截屏失败: {}", e))?,
        )
    }

    // 窗口截图：优先 PrintWindow，失败回退 xcap
    pub fn capture_window() -> Result<String, String> {
        match capture_window_print() {
            Ok(d) => Ok(d),
            Err(e) => match Window::all()
                .map_err(|err| format!("枚举窗口失败: {}", err))
                .and_then(|ws| {
                    ws.into_iter()
                        .find(|w| !w.is_minimized().unwrap_or(true))
                        .ok_or_else(|| "未找到可截图的窗口".to_string())
                        .and_then(|w| {
                            w.capture_image().map_err(|err| format!("窗口截屏失败: {}", err))
                        })
                }) {
                Ok(img) => save_and_encode(img),
                Err(_) => Err(e),
            },
        }
    }

    // ---- 原生 PrintWindow 实现 ----
    type HWND = *mut c_void;
    type HDC = *mut c_void;
    type HBITMAP = *mut c_void;
    type BOOL = i32;

    #[repr(C)]
    struct RECT {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct RGBQUAD {
        b: u8,
        g: u8,
        r: u8,
        a: u8,
    }

    #[repr(C)]
    struct BITMAPINFOHEADER {
        biSize: u32,
        biWidth: i32,
        biHeight: i32,
        biPlanes: u16,
        biBitCount: u16,
        biCompression: u32,
        biSizeImage: u32,
        biXPelsPerMeter: i32,
        biYPelsPerMeter: i32,
        biClrUsed: u32,
        biClrImportant: u32,
    }

    #[repr(C)]
    struct BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER,
        bmiColors: [RGBQUAD; 1],
    }

    extern "system" {
        fn GetDC(hWnd: HWND) -> HDC;
        fn ReleaseDC(hWnd: HWND, hDC: HDC) -> i32;
        fn CreateCompatibleDC(hDC: HDC) -> HDC;
        fn DeleteDC(hDC: HDC) -> i32;
        fn CreateCompatibleBitmap(hDC: HDC, cx: i32, cy: i32) -> HBITMAP;
        fn DeleteObject(hObject: HBITMAP) -> i32;
        fn SelectObject(hDC: HDC, hObject: HBITMAP) -> HBITMAP;
        fn PrintWindow(hwnd: HWND, hdcBlt: HDC, nFlags: u32) -> BOOL;
        fn GetForegroundWindow() -> HWND;
        fn GetWindowRect(hWnd: HWND, lpRect: *mut RECT) -> BOOL;
        fn GetDIBits(
            hdc: HDC,
            hbmp: HBITMAP,
            uStartScan: u32,
            cScanLines: u32,
            lpvBits: *mut c_void,
            lpbi: *mut BITMAPINFO,
            uUsage: u32,
        ) -> i32;
    }

    fn capture_window_print() -> Result<String, String> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return Err("未找到前台窗口".into());
        }
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
            return Err("无法获取窗口尺寸".into());
        }
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w <= 0 || h <= 0 {
            return Err("窗口尺寸无效".into());
        }

        let hdc_screen = unsafe { GetDC(std::ptr::null_mut()) };
        if hdc_screen.is_null() {
            return Err("无法获取屏幕 DC".into());
        }
        let hdc_mem = unsafe { CreateCompatibleDC(hdc_screen) };
        let hbmp = unsafe { CreateCompatibleBitmap(hdc_screen, w, h) };
        let old = unsafe { SelectObject(hdc_mem, hbmp) };

        let printed = unsafe { PrintWindow(hwnd, hdc_mem, 0) };
        let result = if printed == 0 {
            Err("PrintWindow 失败".into())
        } else {
            let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = w;
            bmi.bmiHeader.biHeight = -h; // 负高度 → 顶层向下（top-down）排列，免去手动翻转
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = 0; // BI_RGB
            let mut buf: Vec<u8> = vec![0u8; (w as usize) * (h as usize) * 4];
            let got = unsafe {
                GetDIBits(
                    hdc_mem,
                    hbmp,
                    0,
                    h as u32,
                    buf.as_mut_ptr() as *mut c_void,
                    &mut bmi,
                    0, // DIB_RGB_COLORS
                )
            };
            if got == 0 {
                Err("读取窗口像素失败".into())
            } else {
                // GDI 像素为 BGRA，转成 RGBA 并强制不透明（避免 PrintWindow 的透明 alpha）
                let mut rgba: Vec<u8> = Vec::with_capacity(buf.len());
                for chunk in buf.chunks_exact(4) {
                    rgba.extend_from_slice(&[chunk[2], chunk[1], chunk[0], 255]);
                }
                save_and_encode(
                    image::RgbaImage::from_raw(w as u32, h as u32, rgba)
                        .ok_or_else(|| "构造图像失败".to_string())?,
                )
            }
        };

        unsafe {
            if !old.is_null() {
                SelectObject(hdc_mem, old);
            }
            DeleteObject(hbmp);
            DeleteDC(hdc_mem);
            ReleaseDC(std::ptr::null_mut(), hdc_screen);
        }
        result
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
    // CGDisplayScaleFactor 在 macOS 10.7 后废弃并已从新 SDK 移除（链接报 undefined symbol），
    // 改用 CGDisplayPixelsWide/High（物理像素）除以 CGDisplayBounds（逻辑点）反推 scale。
    fn CGDisplayPixelsWide(display: u32) -> usize;
    fn CGDisplayPixelsHigh(display: u32) -> usize;

    // ===== 直接抓屏（替代 screencapture 命令行，避免 -D 序号歧义 / -R 坐标歧义）=====
    // 返回指定显示器的当前画面，100% 精确对应那块屏（不受屏幕排列顺序影响）。
    fn CGDisplayCreateImage(display: u32) -> *mut std::ffi::c_void;
    fn CGImageRelease(image: *mut std::ffi::c_void);
    fn CGImageGetWidth(image: *mut std::ffi::c_void) -> usize;
    fn CGImageGetHeight(image: *mut std::ffi::c_void) -> usize;
    fn CGImageGetBitsPerPixel(image: *mut std::ffi::c_void) -> usize;
    fn CGImageGetBytesPerRow(image: *mut std::ffi::c_void) -> usize;
    fn CGImageGetDataProvider(image: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    // 按全局 Quartz 坐标（逻辑点，原点主屏左上、y 向下，含所有显示器）截取屏幕区域，
    // 用于区域截图，彻底绕开 screencapture -R 的坐标坑，且天然支持跨屏。
    fn CGWindowListCreateImage(
        screen_bounds: CGRect,
        list_option: u32,
        window_id: u32,
        image_option: u32,
    ) -> *mut std::ffi::c_void;
}

// CoreFoundation：CGImage 的像素数据经 CGDataProviderCopyData 得到 CFData，需 CF 函数读取。
#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CGDataProviderCopyData(provider: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn CFDataGetLength(data: *mut std::ffi::c_void) -> isize;
    fn CFDataGetBytePtr(data: *mut std::ffi::c_void) -> *const u8;
    fn CFRelease(cf: *const std::ffi::c_void);
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
        for i in 0..count as usize {
            let d = displays[i];
            let b = unsafe { CGDisplayBounds(d) };
            // 真实物理像素（截图实际抓到的分辨率）
            let px_w = unsafe { CGDisplayPixelsWide(d) } as u32;
            let px_h = unsafe { CGDisplayPixelsHigh(d) } as u32;
            // scale = 物理像素 / 逻辑点（Retina 2x → 2.0；普通屏 → 1.0；自定义缩放如 1.5x），
            // 两轴取平均更稳健
            let scale = if b.size.width > 0.0 && b.size.height > 0.0 {
                ((px_w as f64 / b.size.width) + (px_h as f64 / b.size.height)) / 2.0
            } else {
                1.0
            };
            out.push(DisplayInfo {
                // 1 基序号（1=主屏），与 capture_screen 的 display_id 对应：
                // 即 enumerate_displays()[id-1]，用于 CGDisplayCreateImage 精确抓该屏
                id: (i as u32) + 1,
                width: b.size.width as u32,
                height: b.size.height as u32,
                scale,
                physical_width: px_w,
                physical_height: px_h,
                is_main: d == main,
                x: b.origin.x as i32,
                y: b.origin.y as i32,
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
// 用 CoreGraphics 的 CGPreflightScreenCaptureAccess 预检，无需弹窗即可知道权限状态。
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> std::os::raw::c_uchar;
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

// ===== 窗口自排除（self-exclusion）：让工具自身不出现在截屏里 =====
// macOS 用 NSWindow.sharingType = .none（原生正解，零时序、无需等待 hide 动画）；
// Windows 用 SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)。
// 前端在每个窗口建好后调用一次 apply_window_stealth(label) 即可，彻底根治「工具被截进画面」。
#[tauri::command]
pub fn apply_window_stealth(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("窗口 {} 不存在", label))?;

    #[cfg(target_os = "macos")]
    {
        let ns_win = window
            .ns_window()
            .map_err(|e| format!("获取 NSWindow 失败: {}", e))?;
        set_nswindow_sharing_none(ns_win as *mut std::ffi::c_void);
    }

    #[cfg(windows)]
    {
        let hwnd = window
            .hwnd()
            .map_err(|e| format!("获取 HWND 失败: {}", e))?;
        // HWND 在 windows-rs 中是元组结构体包裹（底层为 *mut c_void 或 isize），
        // 不能用 `as` 整体强转，需取 .0 再 cast（两种底层表示都安全）。
        set_hwnd_exclude_from_capture(hwnd.0 as *mut std::ffi::c_void);
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = window;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_nswindow_sharing_none(ns_win: *mut std::ffi::c_void) {
    // 直接走 Objective-C runtime，避免引入 objc2 依赖带来的版本耦合。
    // NSWindowSharingType 是 NSUInteger 的 typedef；None = 0。
    extern "C" {
        fn sel_registerName(name: *const std::os::raw::c_char) -> *const std::ffi::c_void;
        fn objc_msgSend(obj: *mut std::ffi::c_void, sel: *const std::ffi::c_void, arg: u64);
    }
    let cname = match std::ffi::CString::new("setSharingType:") {
        Ok(c) => c,
        Err(_) => return,
    };
    let sel = unsafe { sel_registerName(cname.as_ptr()) };
    if sel.is_null() {
        return;
    }
    unsafe { objc_msgSend(ns_win, sel, 0u64) };
}

#[cfg(windows)]
fn set_hwnd_exclude_from_capture(hwnd: *mut std::ffi::c_void) {
    extern "system" {
        fn SetWindowDisplayAffinity(hWnd: *mut std::ffi::c_void, dwAffinity: u32) -> i32;
    }
    const WDA_EXCLUDEFROMCAPTURE: u32 = 0x11;
    unsafe {
        SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    }
}

// ===== CoreGraphics 抓屏辅助（macOS）=====

/// 枚举所有活动显示器的 CGDirectDisplayID（顺序与 list_displays 的 1-based id 对应）。
#[cfg(target_os = "macos")]
fn enumerate_displays() -> Vec<u32> {
    const MAX: u32 = 32;
    let mut displays: [u32; MAX as usize] = [0; MAX as usize];
    let mut count: u32 = 0;
    unsafe {
        CGGetActiveDisplayList(MAX, displays.as_mut_ptr(), &mut count);
    }
    displays[..count as usize].to_vec()
}

/// 将 CGImageRef 的像素数据转换为 image::RgbaImage（内存顺序 [R,G,B,A]）。
/// CoreGraphics 抓出的 CGImage 通常为 kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Big，
/// 即每像素 4 字节、内存顺序 [A,R,G,B]；这里逐像素转为 RGBA 供 PNG 编码。
#[cfg(target_os = "macos")]
fn cgimage_to_rgba(image: *mut std::ffi::c_void) -> Result<image::RgbaImage, String> {
    let width = unsafe { CGImageGetWidth(image) } as u32;
    let height = unsafe { CGImageGetHeight(image) } as u32;
    if width == 0 || height == 0 {
        return Err("截图结果为空（图像尺寸为 0）".into());
    }
    let bpr = unsafe { CGImageGetBytesPerRow(image) } as usize;
    let bpp = unsafe { CGImageGetBitsPerPixel(image) };
    if bpp != 32 {
        return Err(format!("不支持的图像像素格式（{}bpp，期望 32）", bpp));
    }
    let provider = unsafe { CGImageGetDataProvider(image) };
    if provider.is_null() {
        return Err("无法获取图像数据提供者".into());
    }
    let data = unsafe { CGDataProviderCopyData(provider) };
    if data.is_null() {
        return Err("读取图像数据失败（可能屏幕录制权限被拒）".into());
    }
    let len = unsafe { CFDataGetLength(data) };
    let ptr = unsafe { CFDataGetBytePtr(data) };
    let out = if ptr.is_null() {
        Err("图像数据为空".into())
    } else {
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
        let mut buf: Vec<u8> = Vec::with_capacity((width as usize) * (height as usize) * 4);
        for y in 0..height as usize {
            let row = &bytes[y * bpr..];
            for x in 0..width as usize {
                let o = x * 4;
                // 源：[A, R, G, B]（premultiplied-first, big-endian 布局）；目标：[R, G, B, A]
                let a = row[o];
                let r = row[o + 1];
                let g = row[o + 2];
                let b = row[o + 3];
                buf.extend_from_slice(&[r, g, b, a]);
            }
        }
        image::RgbaImage::from_raw(width, height, buf)
            .ok_or_else(|| "图像缓冲构造失败".to_string())
    };
    unsafe { CFRelease(data as *const std::ffi::c_void) };
    out
}
