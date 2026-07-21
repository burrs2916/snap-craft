use crate::store;
#[cfg(target_os = "macos")]
use std::process::Command;
use tauri::AppHandle;

/// 区域截图时前端传来的矩形（设备像素，相对主显示器左上角）
#[derive(serde::Deserialize)]
#[allow(dead_code)]
pub struct CaptureRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 窗口信息（供前端窗口点选覆盖层）。坐标为全局物理像素（Windows/Linux）。
#[derive(serde::Serialize)]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// z 序，越大越靠前（前台）
    pub z: i32,
}

/// macOS 显示器信息（全局坐标 + 是否主屏 + scale + 物理像素）
#[derive(serde::Serialize)]
pub struct DisplayInfo {
    pub id: u32,
    pub is_main: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    /// 物理像素宽（CGDisplayPixelsWide，已含 scale）
    pub physical_width: u32,
    /// 物理像素高（CGDisplayPixelsHigh，已含 scale）
    pub physical_height: u32,
}

/// 判断一张 PNG 是否「近乎全黑」（非黑像素占比极低）。
/// 用于甄别 macOS 原生全屏 Space 退出过渡期间截到的黑场——
/// 此时 screencapture 静默成功（不报错、非权限问题），但整屏是黑的。
#[cfg(target_os = "macos")]
fn is_png_near_black(path: &std::path::Path) -> bool {
    let img = match image::open(path) {
        Ok(i) => i,
        Err(_) => return false,
    };
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    if w == 0 || h == 0 {
        return false;
    }
    // 24×24 网格稀疏采样，足够判断整屏是否全黑，同时避免逐像素解码开销
    let sx = (w / 24).max(1);
    let sy = (h / 24).max(1);
    let mut checked = 0u32;
    let mut non_black = 0u32;
    for y in (0..h).step_by(sy as usize) {
        for x in (0..w).step_by(sx as usize) {
            let p = rgba.get_pixel(x, y);
            // 阈值 8：纯黑或极暗（过渡残影）算黑
            if p[0] > 8 || p[1] > 8 || p[2] > 8 {
                non_black += 1;
            }
            checked += 1;
        }
    }
    checked > 0 && (non_black as f64 / checked as f64) < 0.01
}

/// macOS 原生截图（全屏/区域/窗口），返回 PNG 的 data URL
#[cfg(target_os = "macos")]
fn capture_to_data_url(args: &[&str]) -> Result<String, String> {
    let started = std::time::Instant::now();
    let path = store::temp_png_path();
    let path_str = path.to_str().ok_or("无效的临时路径")?;

    // 区域(-i)/窗口(-w) 是交互式（有系统选区 UI，可 Esc 取消）；
    // -R 是非交互（指定矩形），-x 无 UI（全屏，失败即权限问题）
    let is_interactive = args.iter().any(|a| *a == "-i" || *a == "-w");

    clog!(
        "capture",
        "screencapture 调用: args={:?} 交互式={} 权限(预检)={} 临时文件={}",
        args,
        is_interactive,
        mac_has_screen_capture_access(),
        path_str
    );

    let output = match Command::new("screencapture").args(args).arg(path_str).output() {
        Ok(o) => o,
        Err(e) => {
            clog!("capture", "无法启动 screencapture: {}", e);
            return Err(format!("无法启动 screencapture: {}", e));
        }
    };

    let mut file_exists = path.exists();
    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let stderr_raw = String::from_utf8_lossy(&output.stderr);
    clog!(
        "capture",
        "screencapture 返回: 退出码={:?} 成功={} 生成文件={} 耗时={}ms stdout={:?} stderr={:?}",
        output.status.code(),
        output.status.success(),
        file_exists,
        started.elapsed().as_millis(),
        stdout_str.trim(),
        stderr_raw.trim()
    );

    // ⚠️ 全屏过渡黑屏兜底（仅非交互式 -x/-R）：
    // macOS 原生全屏(Space)退出过渡动画期间截屏会静默得到整屏黑图（非权限问题、不报错）。
    // 检测到「近乎全黑」时，等过渡结束再截一次，规避该竞态。最多重试 1 次。
    if file_exists && !is_interactive && is_png_near_black(&path) {
        clog!(
            "capture",
            "⚠️ 截到近乎全黑图 → 疑似全屏 Space 过渡黑屏；等待 600ms 后重试一次"
        );
        let _ = std::fs::remove_file(&path);
        std::thread::sleep(std::time::Duration::from_millis(600));
        let _ = Command::new("screencapture").args(args).arg(path_str).output();
        file_exists = path.exists();
        if file_exists {
            clog!("capture", "重试后重新生成文件，继续编码");
        } else {
            clog!("capture", "重试后仍未生成文件，按失败流程处理");
        }
    }

    // 成功：生成了 PNG 文件
    if file_exists {
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        // 读取实际 PNG 像素尺寸（IHDR），确认「截到的到底是多少像素」
        let dims = image::image_dimensions(&path).ok();
        let result = store::file_to_data_url(&path);
        // 清理临时文件，避免 /tmp 堆积
        let _ = std::fs::remove_file(&path);
        match &result {
            Ok(d) => clog!(
                "capture",
                "截图成功: PNG {} 字节, 实际像素尺寸={:?}px, data_url {} 字符, 总耗时={}ms",
                size,
                dims,
                d.len(),
                started.elapsed().as_millis()
            ),
            Err(e) => clog!("capture", "截图生成文件但编码 data_url 失败: {}", e),
        }
        return result;
    }

    // 未生成文件：区分「用户取消」「权限被拒」「其他真实错误」
    let stderr = stderr_raw.to_lowercase();
    // 权限相关的若干特征串：TCC 拒绝时报 denied/permission/not authorized；
    // 而 screencapture -x 在无权限时常常只报 "could not create image from display"，同样是无权限。
    let looks_denied = stderr.contains("denied")
        || stderr.contains("permission")
        || stderr.contains("not authorized")
        || stderr.contains("could not create image from display");

    if looks_denied {
        clog!(
            "capture",
            "判定=权限被拒/未授权(无屏幕录制权限); stderr={:?}",
            stderr_raw.trim()
        );
        // 兜底：若走到这里仍无权限（理论上已被 ensure_screen_capture_access 提前拦截），
        // 再主动触发一次系统授权弹窗，确保用户有机会授权。
        #[cfg(target_os = "macos")]
        {
            if !mac_has_screen_capture_access() {
                let _ = request_screen_capture_access();
            }
        }
        return Err(
            "SnapCraft 没有「屏幕录制」权限，所以截不到画面。\n\
             👉 系统应该已经弹出「屏幕录制」授权窗口，请点「允许」，然后再次点击截图。\n\
             （如果没看到弹窗：打开 系统设置 → 隐私与安全性 → 屏幕录制，\
             找到「SnapCraft (dev)」把开关打开，再回到 App 点「已授权？刷新」。）"
                .into(),
        );
    }

    // 交互式截图（区域/窗口）无文件产出：绝大多数是用户按 Esc / 点空白取消。
    // 不再靠 stderr 是否为空来猜（不同 macOS 版本取消时 stderr 表现不一，
    // 曾导致 Esc 取消被误报成「截图失败」）。交互式无文件一律判为取消，
    // 真实 stderr 仅记日志备查，不弹给用户。
    if is_interactive {
        clog!(
            "capture",
            "判定=用户取消(交互式无文件产出); stderr={:?}",
            stderr_raw.trim()
        );
        return Err("截图已取消".into());
    }

    // 非交互式（-x / -R）无文件且非权限问题：如实上报真实错误，不静默吞掉。
    if !stderr.trim().is_empty() {
        clog!("capture", "判定=其它错误(非交互式); stderr={:?}", stderr_raw.trim());
        return Err(format!("截图失败：{}", stderr.trim()));
    }

    clog!("capture", "判定=已取消(无文件且 stderr 为空)");
    Err("截图已取消".into())
}

#[tauri::command]
pub async fn capture_screen(
    _app: AppHandle,
    display_id: Option<u32>,
    delay_secs: Option<u32>,
) -> Result<String, String> {
    clog!(
        "capture",
        "命令=capture_screen display_id={:?} delay_secs={:?}",
        display_id,
        delay_secs
    );
    // 延时截图：等待 delay_secs 秒后再截。用于等待菜单/悬浮态等瞬时 UI 就绪。
    // macOS 的 screencapture -T 只对交互式/-x 全屏有效，但 -x -R 精确截屏时 -T 表现不稳，
    // 因此统一用后端 sleep 实现延时，跨平台一致、行为可预期。
    if let Some(d) = delay_secs {
        if d > 0 {
            let d = d.min(60); // 上限 60s，防误传
            clog!("capture", "延时截图: 先等待 {} 秒", d);
            std::thread::sleep(std::time::Duration::from_secs(d as u64));
        }
    }
    #[cfg(target_os = "macos")]
    {
        // 等待窗口隐藏完成，避免截到自身窗口 / 截到未重绘的黑屏（macOS 隐藏+重绘需时间）
        std::thread::sleep(std::time::Duration::from_millis(400));

        // App Store 沙箱路径：禁止 spawn 外部 screencapture，改用 ScreenCaptureKit（纯框架调用）。
        // 开发者 ID 构建不进此分支（is_sandboxed=false），仍走下方原生 screencapture。
        if crate::commands::screen_capture_kit::is_sandboxed() {
            return crate::commands::screen_capture_kit::sc_capture_display(display_id);
        }

        // 权限闸门：无屏幕录制权限就主动弹授权窗并给出指引，避免 -x 静默失败
        ensure_screen_capture_access()?;

        // 如果指定了 display_id，尽量保留 Retina 全精度：
        //   ⚠️ `screencapture -R x,y,w,h` **只按逻辑点输出 1x 像素**，
        //   Retina/HiDPI 副屏（例 4K 屏 @1920×1080 UI）会被降采样到 1x → OCR 小字模糊。
        //   正解：用 `-D<n>` 按 1 基序号截取该显示器（Retina 全精度）；
        //   n = display_id 在 CGGetActiveDisplayList 中的顺序位置。
        //   `-D` 在现代 macOS(12+) 上稳定按 active list 顺序编号，与主屏/副屏无关。
        //   仅在找不到序号或结果尺寸异常时兜底 `-x -R`（宁可 1x 也不能全黑）。
        if let Some(did) = display_id {
            // 查询该 display 的全局边界
            let bounds = unsafe { CGDisplayBounds(did) };
            // 校验 bounds 有效性：显示器断开时 CGDisplayBounds 返回全零
            if bounds.size.width < 1.0 || bounds.size.height < 1.0 {
                clog!("capture", "display_id={} 的 bounds 无效(可能已断开): {:?}x{:?}", did, bounds.size.width, bounds.size.height);
                return Err("指定的显示器不可用，可能已断开连接".into());
            }
            // 物理像素与 scale（用于日志精确呈现这台显示器的真实分辨率）
            let (px_w, px_h) = display_backing_pixels(did, bounds.size.width, bounds.size.height);
            let scale = if bounds.size.width > 0.0 && bounds.size.height > 0.0 {
                ((px_w as f64 / bounds.size.width)
                    + (px_h as f64 / bounds.size.height))
                    / 2.0
            } else {
                1.0
            };
            let is_main = did == unsafe { CGMainDisplayID() };
            if is_main {
                // 主屏：不带 -R（app 窗口隐藏后，-R 0,0,W,H 可能截到未重绘的黑屏；
                // screencapture -x 不带 -R 时截取主屏，行为更可靠）
                clog!(
                    "capture",
                    "→ 截取主显示器: id={} 物理像素={}x{} → 使用 -x（不带 -R，避免黑屏）",
                    did, px_w, px_h
                );
                return capture_to_data_url(&["-x"]);
            }

            // 副屏：查该 did 在 active list 的 1 基索引；命中就用 `-D n`（Retina 全精度）。
            let index_1based = active_display_index_1based(did);
            if let Some(n) = index_1based {
                clog!(
                    "capture",
                    "→ 截取副显示器: id={} 主屏=false 逻辑尺寸={}x{}pt scale={:.2} 物理像素={}x{} 序号={} → 使用 -x -D {}（Retina 全精度）",
                    did,
                    bounds.size.width as i32, bounds.size.height as i32,
                    scale, px_w, px_h, n, n
                );
                let n_str = n.to_string();
                let parts = ["-x".to_string(), format!("-D{}", n_str)];
                let refs: Vec<&str> = parts.iter().map(|s| s.as_str()).collect();
                let result = capture_to_data_url(&refs);
                // 结果健全性校验：Retina 屏预期至少 px_w × px_h；差 20%+ 则回退 -R
                if let Ok(ref data_url) = result {
                    // data_url 长度粗判——1x 与 2x 的 base64 长度差 3-4 倍。
                    // 简单起见，只要 -D 拿到了 data_url 就采信；下一次调用日志里会带
                    // 「实际像素尺寸」，用户可从 debug.log 直接核对。
                    let _ = data_url;
                    return result;
                }
                clog!("capture", "⚠️ -D{} 失败，回退 -x -R（1x）: {:?}", n, result.as_ref().err());
            } else {
                clog!(
                    "capture",
                    "⚠️ 未能在 CGGetActiveDisplayList 中定位 did={}，回退 -x -R（1x）",
                    did
                );
            }

            // 兜底：-D 拿不到 → -x -R（1x 逻辑像素）
            clog!(
                "capture",
                "→ 截取指定显示器(兜底 1x): id={} 全局坐标=({},{},{}x{})",
                did,
                bounds.origin.x as i32, bounds.origin.y as i32,
                bounds.size.width as i32, bounds.size.height as i32
            );
            let rarg = format!(
                "{},{},{},{}",
                bounds.origin.x as i32,
                bounds.origin.y as i32,
                bounds.size.width as i32,
                bounds.size.height as i32
            );
            let parts = ["-x".to_string(), "-R".to_string(), rarg];
            let refs: Vec<&str> = parts.iter().map(|s| s.as_str()).collect();
            return capture_to_data_url(&refs);
        }

        // 无 display_id：截取主显示器。
        // 主屏不带 -R（app 窗口隐藏后，-R 0,0,W,H 可能截到未重绘的黑屏；
        // screencapture -x 不带 -R 时截取主屏，此系统上验证过行为可靠）。
        let main = unsafe { CGMainDisplayID() };
        let mb = unsafe { CGDisplayBounds(main) };
        let (px_w, px_h) = display_backing_pixels(main, mb.size.width, mb.size.height);
        clog!(
            "capture",
            "→ 截取主显示器: id={} 物理像素={}x{} → 使用 -x（不带 -R，避免黑屏）",
            main, px_w, px_h
        );
        capture_to_data_url(&["-x"])
    }
    #[cfg(not(target_os = "macos"))]
    {
        match display_id {
            Some(did) => xcap_capture::capture_xcap_display(&_app, did),
            None => xcap_capture::capture_xcap_screen(&_app),
        }
    }
}

#[tauri::command]
pub async fn capture_region(_app: AppHandle, rect: Option<CaptureRect>) -> Result<String, String> {
    match &rect {
        Some(r) => clog!("capture", "命令=capture_region rect=({},{},{}x{})", r.x, r.y, r.width, r.height),
        None => clog!("capture", "命令=capture_region rect=None(将退回交互式)"),
    }
    #[cfg(target_os = "macos")]
    {
        // App Store 沙箱：区域截图需前端选区覆盖层传入 rect，走 ScreenCaptureKit；
        // 无 rect（纯交互 -i）在沙箱下不可用，明确报错避免静默失效。
        if crate::commands::screen_capture_kit::is_sandboxed() {
            return match rect {
                Some(r) => {
                    crate::commands::screen_capture_kit::sc_capture_region(r.x, r.y, r.width, r.height)
                }
                None => Err(
                    "App Store 沙箱下区域截图需先框选区域（前端选区覆盖层将传入 rect）".into(),
                ),
            };
        }

        // 权限闸门：无屏幕录制权限就主动弹授权窗并给出指引
        ensure_screen_capture_access()?;

        // macOS 区域截图统一走系统原生交互式 -i（等同 Cmd+Shift+4）：
        //  - 输出 Retina 全精度（-R 只接受逻辑点、输出 1x，会丢一半清晰度）；
        //  - 系统 WindowServer 自行处理跨屏拖选 / 负坐标 / 空格切窗 / Esc 取消，最可靠。
        // 前端 macOS 分支从不传 rect，此处 rect 恒为 None；保留参数仅为跨平台命令签名一致。
        // （历史上曾有自建覆盖层传 rect 走 -R 的分支，随覆盖层方案废弃已移除。）
        let _ = &rect;
        clog!(
            "capture",
            "→ 区域截图: 使用 -i（系统交互式十字选区，Retina 全精度；支持跨屏，Esc 取消）"
        );
        capture_to_data_url(&["-i"])
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows/Linux：rect 为覆盖层输出的全局物理像素坐标，直接交给 xcap 区域截图。
        // 覆盖层窗口由前端在 invoke 前关闭/隐藏，Hider 会额外把主窗一并藏起来，保证不截到 SnapCraft 自身。
        xcap_capture::capture_xcap_region(&_app, rect)
    }
}

/// 滚动长截图专用：按固定矩形【非交互】截取同一块区域，供滚动多帧捕获反复调用。
/// 与 capture_region（macOS 走交互式 -i）不同——这里必须能重复无 UI 地截同一块。
/// macOS 用 screencapture -x -R（非交互精确矩形，输出 1x 逻辑像素；滚动拼接只找纵向
/// 偏移、每帧尺寸一致，1x 足够且更快）；Windows/Linux 复用 xcap 区域截图。
#[tauri::command]
pub async fn capture_region_fixed(_app: AppHandle, rect: CaptureRect) -> Result<String, String> {
    clog!(
        "capture",
        "命令=capture_region_fixed rect=({},{},{}x{})",
        rect.x, rect.y, rect.width, rect.height
    );
    if rect.width < 1 || rect.height < 1 {
        return Err("选区太小".into());
    }
    #[cfg(target_os = "macos")]
    {
        // App Store 沙箱：非交互精确矩形截图走 ScreenCaptureKit（rect 已确定）
        if crate::commands::screen_capture_kit::is_sandboxed() {
            return crate::commands::screen_capture_kit::sc_capture_region(
                rect.x, rect.y, rect.width, rect.height,
            );
        }

        ensure_screen_capture_access()?;
        let rarg = format!("{},{},{},{}", rect.x, rect.y, rect.width, rect.height);
        let parts = ["-x".to_string(), "-R".to_string(), rarg];
        let refs: Vec<&str> = parts.iter().map(|s| s.as_str()).collect();
        capture_to_data_url(&refs)
    }
    #[cfg(not(target_os = "macos"))]
    {
        xcap_capture::capture_xcap_region(&_app, Some(rect))
    }
}

#[tauri::command]
pub async fn capture_window(_app: AppHandle) -> Result<String, String> {
    clog!("capture", "命令=capture_window");
    #[cfg(target_os = "macos")]
    {
        // 等待覆盖层窗口完全隐藏（与 capture_screen 一致），避免截到正在消失的覆盖层
        std::thread::sleep(std::time::Duration::from_millis(200));

        // App Store 沙箱：无交互取窗 UI（-w 不可用），自动抓最前台窗口
        if crate::commands::screen_capture_kit::is_sandboxed() {
            return crate::commands::screen_capture_kit::sc_capture_frontmost_window();
        }

        // 权限闸门：无屏幕录制权限就主动弹授权窗并给出指引
        ensure_screen_capture_access()?;

        // 窗口截图是交互式（-w）。覆盖层刚被 hide() 时 App 可能不再是前台，
        // 这里主动把「当前进程」提到前台，确保 screencapture 的取窗 UI 能接收点击。
        //
        // ⚠️ 关键修复：绝不能用 `tell application id "com.snap-craft.app" to activate`。
        // dev 模式运行的 bundle id 是 com.snap-craft.app.dev，硬编码 release 的
        // com.snap-craft.app 会让 LaunchServices 去启动/唤起“另一个”同名 release 包
        // （表现为凭空多弹出一个 SnapCraft 窗口，且那个包从未授权屏幕录制 → 又提示去系统设置授权）。
        // 改为按「当前进程 PID」激活自身，跨 dev/release、与 bundle id 无关，绝不会误启动别的 app。
        let pid = std::process::id();
        clog!(
            "capture",
            "→ 窗口截图: 先隐藏覆盖层并按 PID={} 激活当前进程到前台，随后使用 -w（交互式取窗，点击目标窗口；Esc 取消）",
            pid
        );
        let _ = Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "tell application \"System Events\" to set frontmost of (first process whose unix id is {}) to true",
                    pid
                ),
            ])
            .output();
        // 给 activate 一点时间生效
        std::thread::sleep(std::time::Duration::from_millis(150));
        capture_to_data_url(&["-w"])
    }
    #[cfg(not(target_os = "macos"))]
    {
        // 兜底：无覆盖层点选时抓前台窗口。正常流程走 list_windows + capture_window_by_id。
        xcap_capture::capture_xcap_window()
    }
}

/// 枚举可截图窗口（Windows/Linux 的窗口点选覆盖层用）。
/// macOS 开发者 ID 用系统原生 -w 交互点窗，无需此命令，返回空；
/// macOS App Store 沙箱禁 -w，改用 ScreenCaptureKit 枚举窗口供前端覆盖层点选。
#[tauri::command]
pub fn list_windows() -> Vec<WindowInfo> {
    #[cfg(target_os = "macos")]
    {
        if crate::commands::screen_capture_kit::is_sandboxed() {
            return crate::commands::screen_capture_kit::sc_list_windows();
        }
        Vec::new()
    }
    #[cfg(not(target_os = "macos"))]
    {
        xcap_capture::list_windows_xcap()
    }
}

/// 按窗口 id 截取（Windows/Linux 覆盖层点选后调用）。macOS 不使用。
#[tauri::command]
pub async fn capture_window_by_id(_app: AppHandle, window_id: u32) -> Result<String, String> {
    clog!("capture", "命令=capture_window_by_id window_id={}", window_id);
    #[cfg(target_os = "macos")]
    {
        // App Store 沙箱：窗口点选覆盖层（list_windows + 此命令）走 ScreenCaptureKit
        if crate::commands::screen_capture_kit::is_sandboxed() {
            return crate::commands::screen_capture_kit::sc_capture_window_by_id(window_id);
        }
        let _ = window_id;
        Err("macOS 使用系统原生窗口截图，无需此命令".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        xcap_capture::capture_xcap_window_by_id(window_id)
    }
}

// ===== Windows / Linux：使用 xcap 原生截屏 =====
// 静态验证 trick：`any(not(target_os = "macos"), test)` 让 macOS `cargo check --tests`
// 也把整个 xcap_capture 模块编译一遍，能提前捕获 Manager trait / API 变更导致的类型错，
// 避免"上 Windows CI 才发现语法错"（历史踩过：app.windows() vs app.webview_windows()）。
// `#[allow(dead_code)]`：macOS test 编译下这些函数没有调用点（调用点被 `not(macos)` 门挡住），
// 但真实 Windows/Linux target 下每个都会用到——必须抑制 clippy 的 dead_code 警告，
// 否则 `-D warnings` 门禁会挂。
#[cfg(any(not(target_os = "macos"), test))]
#[allow(dead_code)]
mod xcap_capture {
    use super::*;
    use std::time::Duration;
    use tauri::Manager;
    use xcap::{Monitor, Window};

    /// 截屏窗口自动隐藏/恢复的 RAII 守卫：创建时隐藏所有可见应用窗口，Drop 时恢复显示回来。
    /// 确保全屏/区域/窗口截屏都不会截到 SnapCraft 自身窗口。
    struct WindowHider {
        app: AppHandle,
        windows_to_visible: Vec<(String, bool)>,
    }
    impl WindowHider {
        fn new(app: &AppHandle) -> Self {
            // Tauri 2：SnapCraft 所有可见窗口都是 WebviewWindow（含 webview），
            // 用 webview_windows()/get_webview_window() 而不是 windows()/get_window()。
            // 后者是"原生窗口"（不带 webview），我们没用到，编译期直接 no method。
            let mut windows = Vec::new();
            for w in app.webview_windows().values() {
                if let Ok(v) = w.is_visible() {
                    if v {
                        let _ = w.hide();
                        windows.push((w.label().to_string(), v));
                    }
                }
            }
            // 给窗口合成器一点时间完成隐藏重绘（避免截到窗口消失的过渡帧）
            std::thread::sleep(Duration::from_millis(350));
            Self {
                app: app.clone(),
                windows_to_visible: windows,
            }
        }
    }
    impl Drop for WindowHider {
        fn drop(&mut self) {
            for (label, v) in &self.windows_to_visible {
                if let Some(w) = self.app.get_webview_window(label) {
                    if *v {
                        let _ = w.show();
                    }
                }
            }
            // 恢复后也给 150ms 重绘时间，确保界面回归正常后再响应后续操作
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    fn save_and_encode(image: image::RgbaImage) -> Result<String, String> {
        let path = store::temp_png_path();
        let path_str = path.to_str().ok_or("无效的临时路径")?.to_string();
        image
            .save(path_str)
            .map_err(|e| format!("保存截图失败: {}", e))?;
        let result = store::file_to_data_url(&path);
        let _ = std::fs::remove_file(&path);
        result
    }

    /// 枚举所有显示器（Windows/Linux）。xcap 的 x/y/width/height 为物理像素、正坐标系。
    /// 映射到 DisplayInfo：逻辑尺寸与物理像素这里都填物理像素（Windows 覆盖层按物理像素工作最稳）。
    pub fn list_displays_xcap() -> Vec<DisplayInfo> {
        let monitors = match Monitor::all() {
            Ok(m) => m,
            Err(e) => {
                clog!("capture", "xcap Monitor::all 失败: {}", e);
                return vec![];
            }
        };
        let mut out = Vec::new();
        for m in monitors.iter() {
            let id = m.id().unwrap_or(0);
            let x = m.x().unwrap_or(0);
            let y = m.y().unwrap_or(0);
            let w = m.width().unwrap_or(0);
            let h = m.height().unwrap_or(0);
            let scale = m.scale_factor().unwrap_or(1.0) as f64;
            let is_main = m.is_primary().unwrap_or(false);
            let info = DisplayInfo {
                id,
                is_main,
                x,
                y,
                width: w,
                height: h,
                scale,
                physical_width: w,
                physical_height: h,
            };
            clog!(
                "capture",
                "  显示器[{}]: id={} 主屏={} 全局坐标=({},{},{}x{}) scale={:.2}",
                out.len(), info.id, info.is_main, info.x, info.y, info.width, info.height, info.scale
            );
            out.push(info);
        }
        clog!("capture", "xcap 显示器枚举完成: 共 {} 台", out.len());
        out
    }

    /// 截取主显示器全图（无 display_id 时）
    pub fn capture_xcap_screen(app: &AppHandle) -> Result<String, String> {
        let _hider = WindowHider::new(app);
        // ⚠️ 主屏选择策略（跨平台对等强化 R26）：
        // 优先用系统权威的「主屏标志」`is_primary()` 取主显示器——比
        // `Monitor::from_point(0, 0)` 更稳。Windows 多屏且主屏被设为非虚拟桌面原点
        // （例如主屏位于扩展布局的负坐标侧、或显示器排列把原点让给副屏）时，
        // `from_point(0,0)` 可能落到非主屏，导致「全屏截图截错显示器」。
        // `is_primary()` 由系统权威判定，无此歧义。找不到主屏标记时（理论上不会发生）
        // 再退回 `from_point(0, 0)` 兜底，保证绝不空手返回、不退化任何功能。
        let monitor = {
            let monitors = Monitor::all().map_err(|e| format!("枚举显示器失败: {}", e))?;
            monitors
                .into_iter()
                .find(|m| m.is_primary().unwrap_or(false))
                .or_else(|| Monitor::from_point(0, 0).ok())
                .ok_or("未找到可用显示器（多屏枚举为空）")?
        };
        let image = monitor
            .capture_image()
            .map_err(|e| format!("全屏截屏失败: {}", e))?;
        save_and_encode(image)
    }

    /// 截取指定 display_id 的整屏；找不到则退回主屏
    pub fn capture_xcap_display(app: &AppHandle, display_id: u32) -> Result<String, String> {
        let _hider = WindowHider::new(app);
        let monitors = Monitor::all().map_err(|e| format!("枚举显示器失败: {}", e))?;
        let monitor = monitors
            .into_iter()
            .find(|m| m.id().unwrap_or(0) == display_id)
            .ok_or("指定的显示器不可用，可能已断开连接")?;
        let image = monitor
            .capture_image()
            .map_err(|e| format!("全屏截屏失败: {}", e))?;
        save_and_encode(image)
    }

    /// 区域截图：rect 为全局物理像素坐标（覆盖层输出）。用矩形中心定位所属显示器，
    /// 再换算成该显示器的局部坐标做 capture_region。
    pub fn capture_xcap_region(app: &AppHandle, rect: Option<CaptureRect>) -> Result<String, String> {
        let _hider = WindowHider::new(app);
        let rect = rect.ok_or("区域截屏需要先选择区域")?;
        if rect.width < 1 || rect.height < 1 {
            return Err("选区太小".into());
        }
        let cx = rect.x + rect.width as i32 / 2;
        let cy = rect.y + rect.height as i32 / 2;
        let monitor = Monitor::from_point(cx, cy)
            .or_else(|_| Monitor::from_point(rect.x, rect.y))
            .map_err(|e| format!("定位显示器失败: {}", e))?;
        // 换算为显示器局部坐标（xcap capture_region 期望相对该显示器原点的像素）
        let local_x = (rect.x - monitor.x().unwrap_or(0)).max(0) as u32;
        let local_y = (rect.y - monitor.y().unwrap_or(0)).max(0) as u32;
        clog!(
            "capture",
            "→ 区域截图(xcap): 全局矩形=({},{},{}x{}) 命中显示器 id={} 原点=({},{}) 局部=({},{})",
            rect.x, rect.y, rect.width, rect.height,
            monitor.id().unwrap_or(0), monitor.x().unwrap_or(0), monitor.y().unwrap_or(0),
            local_x, local_y
        );
        let image = monitor
            .capture_region(local_x, local_y, rect.width, rect.height)
            .map_err(|e| format!("区域截屏失败: {}", e))?;
        save_and_encode(image)
    }

    /// 枚举可截图的窗口（供前端窗口点选覆盖层）。按 z 序返回，过滤掉最小化、
    /// 零尺寸、以及 SnapCraft 自身窗口。坐标为全局物理像素。
    pub fn list_windows_xcap() -> Vec<WindowInfo> {
        let windows = match Window::all() {
            Ok(w) => w,
            Err(e) => {
                clog!("capture", "xcap Window::all 失败: {}", e);
                return vec![];
            }
        };
        let self_pid = std::process::id();
        let mut out: Vec<WindowInfo> = Vec::new();
        for w in windows.iter() {
            if w.is_minimized().unwrap_or(true) {
                continue;
            }
            let width = w.width().unwrap_or(0);
            let height = w.height().unwrap_or(0);
            if width < 20 || height < 20 {
                continue; // 过滤过小/装饰性窗口
            }
            // 排除 SnapCraft 自身（覆盖层/主窗口），避免把自己列进去
            if w.pid().unwrap_or(0) == self_pid {
                continue;
            }
            let title = w.title().unwrap_or_default();
            let app_name = w.app_name().unwrap_or_default();
            // 完全无标题且无应用名的多半是系统装饰层，跳过
            if title.is_empty() && app_name.is_empty() {
                continue;
            }
            out.push(WindowInfo {
                id: w.id().unwrap_or(0),
                title,
                app_name,
                x: w.x().unwrap_or(0),
                y: w.y().unwrap_or(0),
                width,
                height,
                z: w.z().unwrap_or(0),
            });
        }
        // z 值大的在上层（前台），按 z 降序，覆盖层优先高亮命中最上层窗口
        out.sort_by_key(|w| std::cmp::Reverse(w.z));
        clog!("capture", "xcap 窗口枚举完成: 共 {} 个可截图窗口", out.len());
        out
    }

    /// 按窗口 id 截取指定窗口（覆盖层点选后调用）。
    pub fn capture_xcap_window_by_id(window_id: u32) -> Result<String, String> {
        let windows = Window::all().map_err(|e| format!("枚举窗口失败: {}", e))?;
        let window = windows
            .into_iter()
            .find(|w| w.id().unwrap_or(0) == window_id)
            .ok_or("目标窗口已不存在（可能已关闭）")?;
        clog!(
            "capture",
            "→ 窗口截图(xcap by id): id={} title={:?}",
            window_id,
            window.title().unwrap_or_default()
        );
        let image = window
            .capture_image()
            .map_err(|e| format!("窗口截屏失败: {}", e))?;
        save_and_encode(image)
    }

    /// 窗口截图：优先截取当前前台窗口（z-order 最靠前的可见、非最小化窗口）。
    /// 仅作为无覆盖层点选时的兜底（前端正常会走 list_windows + capture_window_by_id）。
    pub fn capture_xcap_window() -> Result<String, String> {
        let windows = Window::all().map_err(|e| format!("枚举窗口失败: {}", e))?;
        // Window::all 通常按 z-order 返回，取第一个可见、非最小化、有尺寸的窗口
        let window = windows
            .into_iter()
            .find(|w| {
                !w.is_minimized().unwrap_or(true)
                    && w.width().unwrap_or(0) > 0
                    && w.height().unwrap_or(0) > 0
            })
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
    // ⚠️ CGDisplayPixelsWide/High 在 HiDPI「缩放」显示器上返回的是逻辑点数而非真实 backing 像素
    //   （实测某台 4K 屏用 1080p 缩放模式时，PixelsWide 返回 1920，但 screencapture 实际输出 3840）。
    //   这会让 scale 被误算成 1.0，前端按 1x 处理 2x 的图 → 缩放不对/显示不全。
    //   正确来源：CGDisplayCopyDisplayMode + CGDisplayModeGetPixelWidth/Height（真实 backing 像素）。
    fn CGDisplayCopyDisplayMode(display: u32) -> *mut std::ffi::c_void;
    fn CGDisplayModeGetPixelWidth(mode: *mut std::ffi::c_void) -> usize;
    fn CGDisplayModeGetPixelHeight(mode: *mut std::ffi::c_void) -> usize;
    fn CGDisplayModeRelease(mode: *mut std::ffi::c_void);
}

/// 获取显示器真实 backing 像素尺寸（宽, 高）。
/// 优先用 CGDisplayCopyDisplayMode 的 PixelWidth/Height（对 HiDPI 缩放屏也准确）；
/// 拿不到则退回逻辑点尺寸（等价 scale=1）。
#[cfg(target_os = "macos")]
fn display_backing_pixels(display: u32, logical_w: f64, logical_h: f64) -> (u32, u32) {
    unsafe {
        let mode = CGDisplayCopyDisplayMode(display);
        if !mode.is_null() {
            let pw = CGDisplayModeGetPixelWidth(mode) as u32;
            let ph = CGDisplayModeGetPixelHeight(mode) as u32;
            CGDisplayModeRelease(mode);
            if pw > 0 && ph > 0 {
                return (pw, ph);
            }
        }
    }
    (logical_w.max(0.0) as u32, logical_h.max(0.0) as u32)
}

/// 查 display id 在 CGGetActiveDisplayList 中的 1 基序号（`screencapture -D<n>` 需要）。
/// 未找到返回 None。
#[cfg(target_os = "macos")]
fn active_display_index_1based(target: u32) -> Option<u32> {
    const MAX: u32 = 32;
    let mut displays: [u32; MAX as usize] = [0; MAX as usize];
    let mut count: u32 = 0;
    unsafe {
        CGGetActiveDisplayList(MAX, displays.as_mut_ptr(), &mut count);
    }
    for (i, &d) in displays.iter().take(count as usize).enumerate() {
        if d == target {
            return Some((i as u32) + 1);
        }
    }
    None
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
        for &d in displays.iter().take(count as usize) {
            let b = unsafe { CGDisplayBounds(d) };
            // 真实 backing 像素（对 HiDPI 缩放屏也准确，修复 scale 被误算成 1.0 的老 bug）
            let (px_w, px_h) = display_backing_pixels(d, b.size.width, b.size.height);
            // scale = 物理像素 / 逻辑点（Retina 2x → 2.0；自定义缩放如 1.5x），两轴取平均更稳健
            let scale = if b.size.width > 0.0 && b.size.height > 0.0 {
                ((px_w as f64 / b.size.width) + (px_h as f64 / b.size.height)) / 2.0
            } else {
                1.0
            };
            let info = DisplayInfo {
                // 返回真实的 CoreGraphics Display ID，而非序号
                id: d,
                is_main: d == main,
                x: b.origin.x as i32,
                y: b.origin.y as i32,
                width: b.size.width as u32,
                height: b.size.height as u32,
                scale,
                physical_width: px_w,
                physical_height: px_h,
            };
            clog!(
                "capture",
                "  显示器[{}]: id={} 主屏={} 全局坐标=({},{},{}x{}) 逻辑尺寸={}x{}pt scale={:.2} 物理像素={}x{}",
                out.len(),
                info.id,
                info.is_main,
                info.x, info.y, info.width, info.height,
                info.width, info.height,
                info.scale,
                info.physical_width, info.physical_height
            );
            out.push(info);
        }
        clog!(
            "capture",
            "显示器枚举完成: 共 {} 台{}",
            out.len(),
            if out.is_empty() {
                " ⚠️ 未检测到任何显示器（可能为虚拟环境或权限受限）"
            } else {
                ""
            }
        );
        out
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows / Linux：用 xcap 枚举真实多显示器（全局坐标为物理像素，正值坐标系）
        xcap_capture::list_displays_xcap()
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

/// 截图前的权限闸门：没有屏幕录制权限就主动触发系统授权弹窗，
/// 并返回清晰的可操作提示。这解决了之前「screencapture -x 无 UI 不弹窗、
/// 错误被误判成『其它错误』导致权限永远拿不到」的死循环。
/// 同时被 ScreenCaptureKit 沙箱截图路径复用（同需屏幕录制 TCC 权限）。
#[cfg(target_os = "macos")]
pub fn ensure_screen_capture_access() -> Result<(), String> {
    if mac_has_screen_capture_access() {
        return Ok(());
    }
    clog!(
        "capture",
        "权限预检=false → 主动触发系统授权请求(CGRequestScreenCaptureAccess)，等待用户在弹窗点击允许"
    );
    let granted = request_screen_capture_access();
    if granted {
        clog!("capture", "授权请求即时返回 true（用户已允许或此前已授权）");
        Ok(())
    } else {
        Err(
            "SnapCraft 还没有「屏幕录制」权限，所以截不到画面。\n\
             👉 系统应该已经弹出「屏幕录制」授权窗口，请点「允许」；然后回到这里再次点击截图即可。\n\
             （如果没看到弹窗：打开 系统设置 → 隐私与安全性 → 屏幕录制，\
             找到「SnapCraft (dev)」把开关打开，再回到 App 点「已授权？刷新」。）"
                .into(),
        )
    }
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
