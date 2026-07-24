//! macOS App Store 沙箱截图：ScreenCaptureKit（纯框架调用，无需 spawn 外部二进制）
//!
//! 应用商店沙箱（App Sandbox）禁止 spawn 外部进程，因此 `screencapture` / `osascript`
//! 在沙箱内无法运行 → 原生截图全家失效。正解是用 ScreenCaptureKit（系统框架，
//! 沙箱可用，仅需「屏幕录制」TCC 权限，无需任何特殊 entitlement）：
//!
//! - `captureScreenshotWithFilter`  抓整屏 / 指定窗口（按 SCContentFilter）
//! - `captureScreenshotWithRect`    抓区域（按屏幕空间 CGRect）
//!
//! 两张 API 都能把 PNG 直接写到 `SCScreenshotConfiguration.fileURL`，省去
//! CGImage → PNG 的手动转换（objc2 当前未绑定 CGImageDestination，此路径最稳）。
//!
//! 开发者 ID 构建不进此路径：capture.rs 的 `is_sandboxed()` 运行时分流会在沙箱内
//! 才调用本模块，沙箱外仍走原生 screencapture（行为/清晰度已验证）。

use std::sync::{Arc, Condvar, Mutex};

    use block2::StackBlock;
    use objc2::rc::Retained;
    use objc2::AllocAnyThread as _;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSString, NSArray, NSError, NSURL};
    use objc2_screen_capture_kit::{
        SCContentFilter, SCScreenshotConfiguration, SCScreenshotManager, SCShareableContent,
        SCDisplay, SCRunningApplication, SCWindow,
    };
    use objc2_uniform_type_identifiers::UTTypePNG;

    use crate::commands::capture::{ensure_screen_capture_access, WindowInfo};
    use crate::store;

    // —— 跨线程把截图成功/失败结果传回调用线程（只传 String，绝不跨线程移动 Objective-C 对象）——
    struct Pending {
        state: Mutex<Option<Result<(), String>>>,
        cvar: Condvar,
    }

    /// 运行时沙箱检测：App Store 沙箱下系统会注入 `APP_SANDBOX_CONTAINER_ID` 环境变量。
    /// 开发者 ID 构建无此变量 → 走原生 screencapture；有 → 走本模块的 ScreenCaptureKit。
    pub fn is_sandboxed() -> bool {
        std::env::var_os("APP_SANDBOX_CONTAINER_ID").is_some()
    }

    // ===== 显示器几何（用于区域/窗口坐标转换：全局物理像素 ↔ ScreenCaptureKit 屏幕空间点）=====
    // 2026-07-23 架构解耦：display_backing_pixels 提取至 platform::macos_display 共享模块。
    // CGGetActiveDisplayList / CGDisplayBounds 保留本地声明（返回 objc2_core_foundation::CGRect，
    // 与共享模块的 raw C CGRect 是不同类型，ScreenCaptureKit API 需要 objc2 版本）。
    use crate::platform::macos_display::display_backing_pixels;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGGetActiveDisplayList(
            max_displays: u32,
            active_displays: *mut u32,
            display_count: *mut u32,
        ) -> i32;
        fn CGDisplayBounds(display: u32) -> CGRect;
    }

    /// 找到包含给定「全局物理像素点」的显示器，返回其 scale（物理像素/逻辑点）。
    /// ScreenCaptureKit 屏幕空间（点）与 CoreGraphics 全局坐标同构：sc_pt = px / scale。
    fn scale_for_point(px: f64, py: f64) -> f64 {
        const MAX: u32 = 32;
        let mut displays: [u32; MAX as usize] = [0; MAX as usize];
        let mut count: u32 = 0;
        unsafe {
            CGGetActiveDisplayList(MAX, displays.as_mut_ptr(), &mut count);
        }
        let mut best = 1.0f64;
        let mut best_dist = f64::MAX;
        for &d in displays.iter().take(count as usize) {
            let b = unsafe { CGDisplayBounds(d) };
            let (pw, ph) = display_backing_pixels(d, b.size.width, b.size.height);
            let scale = if b.size.width > 0.0 && b.size.height > 0.0 {
                ((pw as f64 / b.size.width) + (ph as f64 / b.size.height)) / 2.0
            } else {
                1.0
            };
            // 显示器全局物理像素边界
            let ox = b.origin.x * scale;
            let oy = b.origin.y * scale;
            let ow = b.size.width * scale;
            let oh = b.size.height * scale;
            let inside = px >= ox && px < ox + ow && py >= oy && py < oy + oh;
            // 命中即用；未命中时取最近显示器（兜底，避免多屏边界 1px 误差导致无结果）
            if inside {
                return scale;
            }
            let cx = (ox + ow / 2.0) - px;
            let cy = (oy + oh / 2.0) - py;
            let dist = cx * cx + cy * cy;
            if dist < best_dist {
                best_dist = dist;
                best = scale;
            }
        }
        best
    }

    // ===== 截图流程骨架 =====

    /// 截图前准备：权限闸门 + 临时 PNG 路径 + 共享完成状态。
    fn begin_capture() -> Result<(String, Arc<Pending>), String> {
        ensure_screen_capture_access()?;
        let path = store::temp_png_path();
        let path_str = path.to_str().ok_or("无效的临时路径")?.to_string();
        let pending = Arc::new(Pending {
            state: Mutex::new(None),
            cvar: Condvar::new(),
        });
        Ok((path_str, pending))
    }

    /// 阻塞调用线程直到 ScreenCaptureKit 完成回调触发，然后读临时 PNG 转 data URL。
    fn wait_for_result(pending: &Arc<Pending>, path_str: &str) -> Result<String, String> {
        let mut guard = pending.state.lock().unwrap();
        while guard.is_none() {
            guard = pending.cvar.wait(guard).unwrap();
        }
        let res = guard.take().unwrap();
        drop(guard);
        match res {
            Ok(()) => store::file_to_data_url(std::path::Path::new(path_str)),
            Err(e) => Err(e),
        }
    }

    /// 配置一次截图并把 PNG 写到 fileURL；final block 完成后置结果并唤醒等待线程。
    /// 整屏/窗口共用此函数（用 SCContentFilter 区分）。
    fn capture_with_filter(filter: &SCContentFilter, path_str: &str, pending: &Arc<Pending>) {
        let config = unsafe { SCScreenshotConfiguration::new() };
        let url = NSURL::fileURLWithPath(&NSString::from_str(path_str));
        unsafe {
            config.setFileURL(Some(&url));
            // 显式指定 PNG（受 objc2-uniform-type-identifiers 支持；fileURL 带 .png 扩展名兜底）
            config.setContentType(UTTypePNG);
            config.setShowsCursor(false);
        }

        let pending2 = pending.clone();
        let p = path_str.to_string();
        let block = StackBlock::new(move |_out: *mut objc2_screen_capture_kit::SCScreenshotOutput,
                                         err: *mut NSError| {
            let result = if let Some(err) = unsafe { Retained::from_raw(err) } {
                    let desc = err.localizedDescription().to_string();
                Err(format!("ScreenCaptureKit 截图失败: {}", desc))
            } else if std::path::Path::new(&p).exists() {
                Ok(())
            } else {
                Err("截图文件未生成（ScreenCaptureKit 未写出 PNG）".into())
            };
            *pending2.state.lock().unwrap() = Some(result);
            pending2.cvar.notify_all();
        });
        unsafe {
            SCScreenshotManager::captureScreenshotWithFilter_configuration_completionHandler(
                filter, &config, Some(&block),
            );
        }
    }

    /// 区域截图：按屏幕空间 CGRect 直接截取（display-agnostic，支持跨屏）。
    fn capture_with_rect(rect: &CGRect, path_str: &str, pending: &Arc<Pending>) {
        let config = unsafe { SCScreenshotConfiguration::new() };
        let url = NSURL::fileURLWithPath(&NSString::from_str(path_str));
        unsafe {
            config.setFileURL(Some(&url));
            config.setContentType(UTTypePNG);
            config.setShowsCursor(false);
        }

        let pending2 = pending.clone();
        let p = path_str.to_string();
        let block = StackBlock::new(move |_out: *mut objc2_screen_capture_kit::SCScreenshotOutput,
                                         err: *mut NSError| {
            let result = if let Some(err) = unsafe { Retained::from_raw(err) } {
                    let desc = err.localizedDescription().to_string();
                Err(format!("ScreenCaptureKit 区域截图失败: {}", desc))
            } else if std::path::Path::new(&p).exists() {
                Ok(())
            } else {
                Err("区域截图文件未生成".into())
            };
            *pending2.state.lock().unwrap() = Some(result);
            pending2.cvar.notify_all();
        });
        unsafe {
            SCScreenshotManager::captureScreenshotWithRect_configuration_completionHandler(
                *rect, &config, Some(&block),
            );
        }
    }

    /// 枚举可截图内容（显示器/窗口），在回调里按 display_id 构建 SCContentFilter。
    fn with_display<F>(_display_id: Option<u32>, path_str: &str, pending: &Arc<Pending>, pick: F)
    where
        F: Fn(&SCShareableContent, &str, &Arc<Pending>) + Clone + 'static,
    {
        let p = path_str.to_string();
        let pend = pending.clone();
        let block = StackBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
            let result = if let Some(err) = unsafe { Retained::from_raw(err) } {
                    let desc = err.localizedDescription().to_string();
                Err(format!("枚举可截图内容失败: {}", desc))
            } else {
                match unsafe { Retained::from_raw(content) } {
                    Some(c) => {
                        pick(&c, &p, &pend);
                        return; // pick 内部已发起 capture
                    }
                    None => Err("枚举可截图内容返回空".into()),
                }
            };
            *pend.state.lock().unwrap() = Some(result);
            pend.cvar.notify_all();
        });
        unsafe {
            SCShareableContent::getShareableContentWithCompletionHandler(&block);
        }
    }

    // ===== 对外 API（供 capture.rs 命令在沙箱内调用）=====

    /// 抓取整屏：display_id=None 取主屏，Some(id) 取指定显示器。返回 PNG data URL。
    pub fn sc_capture_display(display_id: Option<u32>) -> Result<String, String> {
        clog!("capture", "[SC] 抓取整屏 display_id={:?}", display_id);
        let (path_str, pending) = begin_capture()?;
        let pend = pending.clone();
        with_display(display_id, &path_str, &pending, move |content, p, pend2| {
            let displays = unsafe { content.displays() };
            let target: Option<Retained<SCDisplay>> = match display_id {
                None => displays.firstObject(),
                Some(did) => {
                    let mut found = None;
                    for i in 0..displays.count() {
                        let d = displays.objectAtIndex(i);
                        if unsafe { d.displayID() } == did {
                            found = Some(d);
                            break;
                        }
                    }
                    found
                }
            };
            let display = match target {
                Some(d) => d,
                None => {
                    *pend2.state.lock().unwrap() = Some(Err("未找到目标显示器".into()));
                    pend2.cvar.notify_all();
                    return;
                }
            };
            // 整屏：排除窗口列表传空数组即可（桌面/菜单栏包含在内）
            let empty: Retained<NSArray<SCWindow>> = NSArray::new();
            let filter = unsafe {
                SCContentFilter::initWithDisplay_excludingWindows(
                    SCContentFilter::alloc(),
                    &display,
                    &empty,
                )
            };
            capture_with_filter(&filter, p, pend2);
        });
        wait_for_result(&pend, &path_str)
    }

    /// 按窗口 id 截图（App Store 沙箱下的「窗口截图」路径）。
    pub fn sc_capture_window_by_id(window_id: u32) -> Result<String, String> {
        clog!("capture", "[SC] 按窗口截图 window_id={}", window_id);
        let (path_str, pending) = begin_capture()?;
        let pend = pending.clone();
        with_display(Some(window_id), &path_str, &pending, move |content, p, pend2| {
            let windows = unsafe { content.windows() };
            let mut target: Option<Retained<SCWindow>> = None;
            for i in 0..windows.count() {
                let w = windows.objectAtIndex(i);
                if unsafe { w.windowID() } == window_id {
                    target = Some(w);
                    break;
                }
            }
            let window = match target {
                Some(w) => w,
                None => {
                    *pend2.state.lock().unwrap() =
                        Some(Err(format!("未找到窗口 id={}", window_id)));
                    pend2.cvar.notify_all();
                    return;
                }
            };
            let filter = unsafe {
                SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window)
            };
            capture_with_filter(&filter, p, pend2);
        });
        wait_for_result(&pend, &path_str)
    }

    /// 抓「最前台窗口」（App Store 沙箱下托盘「窗口截图」的兜底：无交互取窗 UI）。
    /// 自动选取最靠前的可见窗口（windowLayer 最大者）。
    pub fn sc_capture_frontmost_window() -> Result<String, String> {
        clog!("capture", "[SC] 抓最前台窗口");
        let (path_str, pending) = begin_capture()?;
        let pend = pending.clone();
        with_display(None, &path_str, &pending, move |content, p, pend2| {
            let windows = unsafe { content.windows() };
            let mut best: Option<Retained<SCWindow>> = None;
            let mut best_layer: i64 = i64::MIN;
            for i in 0..windows.count() {
                let w = windows.objectAtIndex(i);
                if !unsafe { w.isOnScreen() } {
                    continue;
                }
                let layer = unsafe { w.windowLayer() } as i64;
                if layer > best_layer {
                    best_layer = layer;
                    best = Some(w);
                }
            }
            let window = match best {
                Some(w) => w,
                None => {
                    *pend2.state.lock().unwrap() = Some(Err("未找到可见窗口".into()));
                    pend2.cvar.notify_all();
                    return;
                }
            };
            let filter = unsafe {
                SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window)
            };
            capture_with_filter(&filter, p, pend2);
        });
        wait_for_result(&pend, &path_str)
    }

    /// 区域截图：rect 为全局物理像素（与 Windows/Linux 覆盖层契约一致）。
    /// 内部按命中显示器的 scale 转换为 ScreenCaptureKit 屏幕空间点。
    pub fn sc_capture_region(
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) -> Result<String, String> {
        clog!(
            "capture",
            "[SC] 区域截图 全局物理像素=({},{},{}x{})",
            x, y, width, height
        );
        let (path_str, pending) = begin_capture()?;
        let scale = scale_for_point(x as f64, y as f64);
        let rect = CGRect {
            origin: CGPoint {
                x: x as f64 / scale,
                y: y as f64 / scale,
            },
            size: CGSize {
                width: width as f64 / scale,
                height: height as f64 / scale,
            },
        };
        capture_with_rect(&rect, &path_str, &pending);
        wait_for_result(&pending, &path_str)
    }

    /// 枚举窗口（App Store 沙箱下的「窗口点选覆盖层」用），坐标转全局物理像素。
    /// 开发者 ID 路径不需要此命令（走系统原生 -w 交互取窗）。
    pub fn sc_list_windows() -> Vec<WindowInfo> {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<WindowInfo>>();
        let block = StackBlock::new(move |content: *mut SCShareableContent, err: *mut NSError| {
            let _ = err;
            let mut out = Vec::new();
            if let Some(content) = unsafe { Retained::from_raw(content) } {
                let windows = unsafe { content.windows() };
                for i in 0..windows.count() {
                    let w = windows.objectAtIndex(i);
                    if !unsafe { w.isOnScreen() } {
                        continue;
                    }
                    let f = unsafe { w.frame() };
                    let scale = scale_for_point(f.origin.x, f.origin.y);
                    let app = unsafe {
                        w.owningApplication()
                            .map(|a: Retained<SCRunningApplication>| a.applicationName().to_string())
                            .unwrap_or_default()
                    };
                    let title = unsafe {
                        w.title()
                            .map(|s| s.to_string())
                            .unwrap_or_default()
                    };
                    out.push(WindowInfo {
                        id: unsafe { w.windowID() },
                        title,
                        app_name: app,
                        x: (f.origin.x * scale) as i32,
                        y: (f.origin.y * scale) as i32,
                        width: (f.size.width * scale) as u32,
                        height: (f.size.height * scale) as u32,
                        z: unsafe { w.windowLayer() } as i32,
                    });
                }
            }
            let _ = tx.send(out);
        });
        unsafe {
            SCShareableContent::getShareableContentWithCompletionHandler(&block);
        }
        // 超时保护：SC 枚举通常 <500ms，1s 兜底避免前端永久等待
        rx.recv_timeout(std::time::Duration::from_secs(1))
            .unwrap_or_default()
    }
