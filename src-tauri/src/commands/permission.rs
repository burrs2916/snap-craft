// SnapCraft - 跨平台权限管理（Tauri commands）
// =============================================================
//
// M1.5 Patch-1：补齐 PermissionSettings 所需的 4 个 Tauri command，
// 让前端 UI 在 macOS / Windows / Linux 上行为一致。
//
// 已存在的 `check_screen_capture_access` 仍留在 commands/capture.rs（本文件不再复制）；
// 此处只补 mic / accessibility / settings-deeplink 三个新命令，
// 并把 `get_platform` 从 lib.rs 迁过来以统一平台相关 command 入口。
//
// 跨平台策略：
//   - macOS：真实走 AVCaptureDevice / AXIsProcessTrusted / x-apple.systempreferences: deeplink
//   - Windows / Linux：现阶段 M1.5 仅 stub（返回 false / 跳 ms-settings:），M2 阶段会基于
//     `windows` crate 或 OS API 替换；目标是 M2 PAL 层把"平台分支"集中到本文件，避免 lib.rs 长 if-else。
//
// 不引入新 crate：mic 状态用 `objc2` / `core-foundation` 通过 `extern "C"` 直绑 AVFoundation
// 与 ApplicationServices 框架（Cargo 已有 CoreGraphics 绑定经验，沿用同样写法）。
// =============================================================

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

// ===== 平台标识（替代 lib.rs 中的 get_platform，统一入口） =====

/// 返回当前操作系统标识：macos / windows / linux
/// 前端 `tauri.invoke('get_platform')` 用此决定走 macOS 分支还是 Win 分支。
#[tauri::command]
pub fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

// ===== macOS FFI 绑定（仅编译期引入） =====

// ⚠️ macOS 26 SDK 兼容性修复：
// AVCaptureDeviceAuthorizationStatusForMediaType 在 macOS 26 SDK 中不再作为
// 可链接的 C 符号暴露（AVFoundation 框架仍存在，但该 C 函数被标记为废弃）。
// 改用运行时 dlopen/dlsym 动态查找，避免编译时链接失败。
// AXIsProcessTrusted（ApplicationServices）在 macOS 26 SDK 中仍可正常链接。
#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    /// ApplicationServices: 进程是否被 AX 信任（无参数，调用即查询）
    fn AXIsProcessTrusted() -> std::os::raw::c_uchar;
}

// dlopen/dlsym 运行时动态加载（macOS 自带 libdl）
#[cfg(target_os = "macos")]
extern "C" {
    fn dlopen(filename: *const std::os::raw::c_char, flag: std::os::raw::c_int) -> *mut std::ffi::c_void;
    fn dlsym(handle: *mut std::ffi::c_void, symbol: *const std::os::raw::c_char) -> *mut std::ffi::c_void;
}

#[cfg(target_os = "macos")]
const RTLD_LAZY: std::os::raw::c_int = 1;

/// AVAuthorizationStatus 函数指针类型
#[cfg(target_os = "macos")]
type AVCaptureDeviceAuthorizationStatusFn =
    unsafe extern "C" fn(media_type: *const std::os::raw::c_char) -> std::os::raw::c_int;

/// 运行时从 AVFoundation 框架动态加载 AVCaptureDeviceAuthorizationStatusForMediaType。
/// macOS 26 SDK 不再暴露该 C 符号供编译时链接，但运行时 dlsym 仍可找到
/// （AVFoundation.framework 二进制中函数仍在，只是 SDK 头文件/链接器不再导出）。
/// 返回 None 表示函数不可用（极旧或极新 macOS），调用方应降级为 false。
#[cfg(target_os = "macos")]
unsafe fn load_av_authorization_status_fn() -> Option<AVCaptureDeviceAuthorizationStatusFn> {
    let framework = b"/System/Library/Frameworks/AVFoundation.framework/AVFoundation\0";
    let handle = dlopen(
        framework.as_ptr() as *const std::os::raw::c_char,
        RTLD_LAZY,
    );
    if handle.is_null() {
        clog!("permission", "dlopen AVFoundation 失败，麦克风权限检查降级为 false");
        return None;
    }
    let sym_name = b"AVCaptureDeviceAuthorizationStatusForMediaType\0";
    let sym = dlsym(handle, sym_name.as_ptr() as *const std::os::raw::c_char);
    if sym.is_null() {
        clog!("permission", "dlsym AVCaptureDeviceAuthorizationStatusForMediaType 失败（macOS 26+ 可能已移除），麦克风权限检查降级为 false");
        return None;
    }
    Some(std::mem::transmute::<*mut std::ffi::c_void, AVCaptureDeviceAuthorizationStatusFn>(sym))
}

/// AVAuthorizationStatus（与 AVFoundation/AVCaptureDevice.h 头文件一一对应）：
///   0 = NotDetermined   1 = Restricted   2 = Denied   3 = Authorized
/// 仅用于判断"已授权（>= 3）"。
#[cfg(target_os = "macos")]
const AV_AUTHORIZATION_AUTHORIZED: std::os::raw::c_int = 3;

/// `AVMediaTypeAudio` 在 C 层是常量字符串 "soun"（fourCC）。
/// 用 `c"..."` 字面量保证 C 字符串以 NUL 结尾。
#[cfg(target_os = "macos")]
fn av_media_type_audio() -> *const std::os::raw::c_char {
    // "soun" 的 fourCC；AVMediaTypeAudio 在 Foundation/AVFoundation 中定义如此
    c"soun".as_ptr() as *const std::os::raw::c_char
}

// ===== 麦克风权限 =====

/// 检测当前是否已获得麦克风权限。
/// macOS：运行时动态加载 AVCaptureDeviceAuthorizationStatusForMediaType（dlopen/dlsym），
///        兼容 macOS 26 SDK（该 C 符号不再可编译时链接，但运行时仍可用）。
/// Windows / Linux：现阶段 stub 返回 false（M2 阶段接入 winreg / UWP API）
#[tauri::command]
pub fn check_microphone_access() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let check_fn = unsafe { load_av_authorization_status_fn() };
        match check_fn {
            Some(f) => {
                let status = unsafe { f(av_media_type_audio()) };
                clog!(
                    "permission",
                    "check_microphone_access: AVCaptureDeviceAuthorizationStatus={}",
                    status
                );
                // status >= 3 表示已授权；NotDetermined(0) / Restricted(1) / Denied(2) 都视为未授权
                Ok(status >= AV_AUTHORIZATION_AUTHORIZED)
            }
            None => {
                // dlopen/dlsym 失败：AVFoundation 框架或函数不可用
                clog!("permission", "check_microphone_access: AVFoundation 函数不可用，降级为 false");
                Ok(false)
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // M2 stub：Windows / Linux 上先返回 false，前端走"功能尚未支持"分支
        Ok(false)
    }
}

// ===== 辅助功能（Accessibility）权限 =====

/// 检测当前进程是否被 macOS 辅助功能信任。
/// macOS：调 AXIsProcessTrusted()（ApplicationServices）
/// Windows / Linux：现阶段 stub 返回 false
///
/// 注意：辅助功能是 macOS 独有的概念（用于全局快捷键 / 自动化）。
/// SnapCraft 当前不在 Tauri 主进程使用辅助功能（Tauri 2 的 global-shortcut 走 CGEventPost
/// 走的是 Input Monitoring 而不是 Accessibility），但 `PermissionSettings` UI 仍会展示状态。
#[tauri::command]
pub fn check_accessibility_access() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let trusted = unsafe { AXIsProcessTrusted() } != 0;
        clog!(
            "permission",
            "check_accessibility_access: AXIsProcessTrusted={}",
            trusted
        );
        Ok(trusted)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

// ===== 一键打开系统设置面板 =====

/// 打开对应权限的"系统设置"面板，让用户能直接打开开关。
/// - macOS: 跳 `x-apple.systempreferences:com.apple.preference.security?Privacy_<Type>`
/// - Windows: 跳 `ms-settings:privacy-<type>`
/// - Linux: 暂未实现（M2 阶段补 .desktop 文件 + xdg-open）
///
/// `kind` 由前端传，合法值：
///   "screen" | "microphone" | "accessibility" | "input-monitoring"
/// 非法值返回 Err，前端 fallback 到"打开系统设置首页"。
#[tauri::command]
pub fn open_permission_settings(app: AppHandle, kind: String) -> Result<(), String> {
    let kind_norm = kind.to_ascii_lowercase();
    clog!("permission", "open_permission_settings: kind={}", kind_norm);

    #[cfg(target_os = "macos")]
    {
        let url = match kind_norm.as_str() {
            "screen" | "screen-recording" | "screen_recording" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            "input-monitoring" | "input_monitoring" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
            }
            other => {
                return Err(format!("不支持的权限类型: {}", other));
            }
        };
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("打开系统设置失败: {}", e))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        let url = match kind_norm.as_str() {
            "microphone" => "ms-settings:privacy-microphone",
            // screen / accessibility 在 Win 上无直接 deeplink；返回首页让用户自寻
            _ => "ms-settings:privacy",
        };
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("打开 Windows 设置失败: {}", e))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        // Linux: M2 阶段接 xdg-open + .desktop hint；先返回明确错误而非 panic
        let _ = app;
        Err(format!("当前平台不支持一键打开权限设置: {}", kind_norm))
    }
}

// ===== 重置全部权限 =====

/// 重置本 App 的所有 TCC 权限（屏幕录制 / 麦克风 / 辅助功能）。
///
/// macOS sandbox 限制：App 无法通过 `tccutil` 等外部进程直接重置 TCC 权限，
/// 只能引导用户到「系统设置 → 隐私与安全性」面板手动操作。
/// 此命令打开隐私面板首页，用户手动重置后点击「刷新」即可看到最新状态。
///
/// Windows / Linux：TCC 不适用，直接返回 Ok（无操作）。
#[tauri::command]
pub fn reset_all_permissions(app: AppHandle) -> Result<(), String> {
    clog!("permission", "reset_all_permissions 调用");

    #[cfg(target_os = "macos")]
    {
        // sandbox 下无法调 tccutil，打开隐私面板让用户手动重置
        app.opener()
            .open_url(
                "x-apple.systempreferences:com.apple.preference.security?Privacy",
                None::<&str>,
            )
            .map_err(|e| format!("打开系统设置失败: {}", e))?;
        clog!("permission", "已打开「系统设置 → 隐私与安全性」面板，请用户手动重置权限");
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Windows / Linux：TCC 不适用，直接返回 Ok
        let _ = app;
    }

    Ok(())
}
