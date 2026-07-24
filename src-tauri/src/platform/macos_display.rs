// src-tauri/src/platform/macos_display.rs
// macOS CoreGraphics 显示器 FFI 绑定（共享模块）。
// 此前 capture.rs 与 screen_capture_kit.rs 各自重复声明了相同的 extern "C" 绑定，
// 本模块统一提取，消除重复、降低维护成本。
//
// 仅编译于 macOS（由 platform/mod.rs 的 #[cfg(target_os = "macos")] 门控）。

#![allow(non_camel_case_types, dead_code)]

use std::ffi::c_void;

// ── CoreGraphics 类型 ──

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct CGPoint {
    pub x: f64,
    pub y: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct CGSize {
    pub width: f64,
    pub height: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct CGRect {
    pub origin: CGPoint,
    pub size: CGSize,
}

// ── CoreGraphics FFI ──

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub fn CGGetActiveDisplayList(
        max_displays: u32,
        active_displays: *mut u32,
        display_count: *mut u32,
    ) -> i32;

    pub fn CGDisplayBounds(display: u32) -> CGRect;

    pub fn CGMainDisplayID() -> u32;

    // ⚠️ CGDisplayPixelsWide/High 在 HiDPI「缩放」显示器上返回的是逻辑点数而非真实 backing 像素。
    // 正确来源：CGDisplayCopyDisplayMode + CGDisplayModeGetPixelWidth/Height。
    pub fn CGDisplayCopyDisplayMode(display: u32) -> *mut c_void;
    pub fn CGDisplayModeGetPixelWidth(mode: *mut c_void) -> usize;
    pub fn CGDisplayModeGetPixelHeight(mode: *mut c_void) -> usize;
    pub fn CGDisplayModeRelease(mode: *mut c_void);

    // 屏幕录制权限
    pub fn CGPreflightScreenCaptureAccess() -> std::os::raw::c_uchar;
    pub fn CGRequestScreenCaptureAccess() -> std::os::raw::c_uchar;
}

// ── 高层工具函数 ──

/// 获取显示器真实 backing 像素尺寸（宽, 高）。
/// 优先用 CGDisplayCopyDisplayMode 的 PixelWidth/Height（对 HiDPI 缩放屏也准确）；
/// 拿不到则退回逻辑点尺寸（等价 scale=1）。
pub fn display_backing_pixels(display: u32, logical_w: f64, logical_h: f64) -> (u32, u32) {
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
pub fn active_display_index_1based(target: u32) -> Option<u32> {
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

/// 预检屏幕录制权限状态（不弹窗）
pub fn has_screen_capture_access() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() != 0 }
}

/// 请求屏幕录制权限（首次调用弹出系统授权对话框）
pub fn request_screen_capture_access() -> bool {
    if has_screen_capture_access() {
        return true;
    }
    unsafe { CGRequestScreenCaptureAccess() != 0 }
}
