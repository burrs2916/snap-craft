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
        let url = store::file_to_data_url(&path);
        // 清理临时 PNG，避免每次截图泄漏一个文件
        let _ = std::fs::remove_file(&path);
        return url;
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

        // 选定要抓取的显示器，直接使用该显示器的「全局几何矩形」抓取
        // （CGDisplayBounds 返回的全局 Quartz 坐标，与区域截图同坐标系）。
        // 用 CGWindowListCreateImage(rect, onScreenOnly) 按几何精确截取，不再依赖
        // CGDisplayCreateImage + 显示索引映射，彻底规避「选了副屏却截到主屏」的错位。
        let rect = match display_id {
            Some(idx) => {
                let displays = enumerate_displays();
                let i = (idx as usize).saturating_sub(1);
                let d = displays
                    .get(i)
                    .copied()
                    .unwrap_or_else(|| unsafe { CGMainDisplayID() });
                unsafe { CGDisplayBounds(d) }
            }
            None => unsafe { CGDisplayBounds(CGMainDisplayID()) },
        };

        // kCGWindowListOptionOnScreenOnly = 2；window_id = 0 (kCGNullWindowID)；image_option = 0。
        // 设了 sharingType=.none 的自身窗口会被系统自动排除，不会截进画面。
        let img = unsafe { CGWindowListCreateImage(rect, 2, 0, 0) };
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
            let url = store::file_to_data_url(&path);
            let _ = std::fs::remove_file(&path);
            url
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
                    let url = store::file_to_data_url(&path);
                    let _ = std::fs::remove_file(&path);
                    url
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
    fn CGImageRelease(image: *mut std::ffi::c_void);
    fn CGImageGetWidth(image: *mut std::ffi::c_void) -> usize;
    fn CGImageGetHeight(image: *mut std::ffi::c_void) -> usize;
    // 按全局 Quartz 坐标（逻辑点，原点主屏左上、y 向下，含所有显示器）截取屏幕区域，
    // 用于区域截图，彻底绕开 screencapture -R 的坐标坑，且天然支持跨屏。
    fn CGWindowListCreateImage(
        screen_bounds: CGRect,
        list_option: u32,
        window_id: u32,
        image_option: u32,
    ) -> *mut std::ffi::c_void;
    // 颜色空间 + 位图上下文：把任意字节序的 CGImage 重绘成「明确 RGBA little-endian」，
    // 彻底规避 CGImage 实际像素格式不固定（BGRA/ARGB）导致的通道错位（偏蓝）。
    fn CGColorSpaceCreateDeviceRGB() -> *mut std::ffi::c_void;
    fn CGBitmapContextCreate(
        data: *mut std::ffi::c_void,
        width: usize,
        height: usize,
        bits_per_component: usize,
        bytes_per_row: usize,
        colorspace: *mut std::ffi::c_void,
        bitmap_info: u32,
    ) -> *mut std::ffi::c_void;
    fn CGContextDrawImage(ctx: *mut std::ffi::c_void, rect: CGRect, image: *mut std::ffi::c_void);
    fn CGContextRelease(ctx: *mut std::ffi::c_void);
    // 坐标变换：翻转 Y 轴，让 DrawImage 输出与 image::RgbaImage/PNG 的「左上为原点」一致，
    // 否则截图会上下颠倒（CG 位图上下文原点在左下角）。
    fn CGContextTranslateCTM(ctx: *mut std::ffi::c_void, tx: f64, ty: f64);
    fn CGContextScaleCTM(ctx: *mut std::ffi::c_void, sx: f64, sy: f64);
}

// CoreFoundation：CGImage 的像素数据经 CGDataProviderCopyData 得到 CFData，需 CF 函数读取。
#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
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

/// 将 CGImageRef 转换为 image::RgbaImage（内存顺序 [R,G,B,A]，RGBA little-endian）。
///
/// 坑点：CGDisplayCreateImage / CGWindowListCreateImage 产出的 CGImage 其底层像素字节序
/// 并不固定（Apple Silicon / 新 SDK 上常为 BGRA），若直接按 [A,R,G,B] 裸读通道会错位 →
/// 整图偏蓝（红蓝互换）。因此这里**不直接读原始字节**，而是把图像重新绘制到一个
/// 「明确 RGBA little-endian、premultiplied-last」的位图上下文，输出的字节顺序与
/// image::RgbaImage 完全一致，从根上消除偏色。
#[cfg(target_os = "macos")]
#[allow(non_upper_case_globals)]
const kCGImageAlphaNoneSkipLast: u32 = 6;
#[cfg(target_os = "macos")]
#[allow(non_upper_case_globals)]
const kCGImageByteOrder32Little: u32 = 0x2000;

#[cfg(target_os = "macos")]
fn cgimage_to_rgba(image: *mut std::ffi::c_void) -> Result<image::RgbaImage, String> {
    let width = unsafe { CGImageGetWidth(image) } as u32;
    let height = unsafe { CGImageGetHeight(image) } as u32;
    if width == 0 || height == 0 {
        return Err("截图结果为空（图像尺寸为 0）".into());
    }
    let bytes_per_row = (width as usize) * 4;
    let mut buf: Vec<u8> = vec![0u8; (height as usize) * bytes_per_row];

    let color_space = unsafe { CGColorSpaceCreateDeviceRGB() };
    if color_space.is_null() {
        return Err("无法创建颜色空间".into());
    }
    let ctx = unsafe {
        CGBitmapContextCreate(
            buf.as_mut_ptr() as *mut std::ffi::c_void,
            width as usize,
            height as usize,
            8,
            bytes_per_row,
            color_space,
            // NoneSkipLast：第 4 字节是填充位（无 alpha 语义），杜绝 CGWindowListCreateImage
            // 返回的 alpha 通道非 255 时被当作预乘系数导致整图偏色（偏红/偏暗/发黑）。
            // 32Little：内存顺序 [R,G,B,X]，与 image::RgbaImage 的 [R,G,B,A] 完全对齐。
            kCGImageAlphaNoneSkipLast | kCGImageByteOrder32Little,
        )
    };
    if ctx.is_null() {
        unsafe { CFRelease(color_space as *const std::ffi::c_void) };
        return Err("无法创建位图上下文（截图失败）".into());
    }
    unsafe {
        // CG 位图上下文原点在左下角，PNG/RgbaImage 期望左上角。
        // 先把坐标系上移 height、再 Y 翻转，DrawImage 输出的缓冲区即为「左上为原点」的正确朝向。
        CGContextTranslateCTM(ctx, 0.0, height as f64);
        CGContextScaleCTM(ctx, 1.0, -1.0);
        CGContextDrawImage(
            ctx,
            CGRect {
                origin: CGPoint { x: 0.0, y: 0.0 },
                size: CGSize { width: width as f64, height: height as f64 },
            },
            image,
        );
        CGContextRelease(ctx);
        CFRelease(color_space as *const std::ffi::c_void);
    }
    // 填充位无语义，强制 alpha=255，保证 PNG 完全不透明
    let mut i = 3;
    while i < buf.len() {
        buf[i] = 255;
        i += 4;
    }
    image::RgbaImage::from_raw(width, height, buf)
        .ok_or_else(|| "图像缓冲构造失败".to_string())
}
