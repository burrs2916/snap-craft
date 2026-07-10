// SnapCraft - 智能截屏工具
#[macro_use]
mod logger;
mod commands;
mod store;

use tauri::Emitter;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 将快捷键映射为对应的截图事件名（无匹配则返回 None）
fn shortcut_to_event(key: Code, mods: Modifiers) -> Option<&'static str> {
    let super_shift = mods.contains(Modifiers::SUPER | Modifiers::SHIFT);
    let ctrl_shift = mods.contains(Modifiers::CONTROL | Modifiers::SHIFT);
    if !(super_shift || ctrl_shift) {
        return None;
    }
    match key {
        Code::KeyS | Code::Digit1 => Some("capture-screen"),
        Code::Digit2 => Some("capture-region"),
        Code::Digit3 => Some("capture-window"),
        _ => None,
    }
}

/// 返回当前操作系统标识：macos / windows / linux
#[tauri::command]
fn get_platform() -> String {
    std::env::consts::OS.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    if let Some(event_name) = shortcut_to_event(shortcut.key, shortcut.mods) {
                        let _ = app.emit(event_name, ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            // 启动分隔：便于在 logs/dev.log 中区分每一次运行
            clog!(
                "boot",
                "========== SnapCraft 启动 (os={}, debug={}) ==========",
                std::env::consts::OS,
                cfg!(debug_assertions)
            );
            #[cfg(target_os = "macos")]
            clog!(
                "boot",
                "屏幕录制权限(启动预检)={}",
                commands::capture::check_screen_capture_access()
            );

            // 注册全局快捷键：macOS 用 ⌘，Windows/Linux 用 Ctrl
            let mut failed: Vec<String> = Vec::new();
            for modifiers in [Modifiers::SUPER, Modifiers::CONTROL] {
                let shift = modifiers | Modifiers::SHIFT;
                let keys = [
                    (Code::KeyS, "⌘/Ctrl+Shift+S"),
                    (Code::Digit1, "⌘/Ctrl+Shift+1"),
                    (Code::Digit2, "⌘/Ctrl+Shift+2"),
                    (Code::Digit3, "⌘/Ctrl+Shift+3"),
                ];
                for (code, label) in keys {
                    if app.global_shortcut()
                        .register(Shortcut::new(Some(shift), code))
                        .is_err()
                    {
                        failed.push(label.to_string());
                    }
                }
            }
            if !failed.is_empty() {
                let msg = format!(
                    "以下快捷键注册失败，可能被其他应用占用：{}",
                    failed.join("、")
                );
                let _ = app.emit("shortcut-register-failed", msg);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::capture::capture_screen,
            commands::capture::capture_region,
            commands::capture::capture_window,
            commands::capture::list_displays,
            commands::edit::save_screenshot,
            commands::edit::copy_to_clipboard,
            commands::history::get_history,
            commands::history::add_history,
            commands::history::delete_history,
            commands::history::clear_history,
            get_platform,
            commands::capture::check_screen_capture_access,
            commands::capture::request_screen_capture_access,
            commands::capture::open_screen_recording_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
