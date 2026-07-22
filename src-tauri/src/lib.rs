// SnapCraft - 智能截屏工具
#[macro_use]
mod logger;
mod commands;
mod store;

use commands::permission::get_platform;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WindowEvent};
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
        Code::Digit4 => Some("capture-scroll-frame"),
        _ => None,
    }
}

/// 前端诊断日志：把消息写入 debug.log（tag=diag），用于排查前端逻辑问题
#[tauri::command]
fn diag_log(msg: String) {
    clog!("diag", "{}", msg);
}

/// 是否处于 App Store 沙箱（macOS）。前端据此决定：区域/窗口截图走「原生交互」
/// 还是「ScreenCaptureKit + 选区覆盖层」。非 macOS 恒为 false。
#[cfg(target_os = "macos")]
#[tauri::command]
fn is_sandboxed() -> bool {
    commands::screen_capture_kit::is_sandboxed()
}

/// AI 窗口大图跨窗口传输用的临时目录（位于系统 temp 下，避免占用内存 IPC）
fn ai_temp_dir() -> std::path::PathBuf {
    let mut d = std::env::temp_dir();
    d.push("snapcraft-ai");
    d
}

/// 把 base64 图片写入临时目录，返回文件名（uuid），AI 窗口凭此读回。
/// 用于主窗口 → AI 独立窗口的大图零感知传输（避免 Event 分片抖动）。
#[tauri::command]
fn save_temp_file(content_base64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&content_base64)
        .map_err(|e| format!("base64 解码失败: {}", e))?;
    let dir = ai_temp_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let filename = format!("{}.png", uuid::Uuid::new_v4());
    let path = dir.join(&filename);
    std::fs::write(&path, &bytes).map_err(|e| format!("写入临时文件失败: {}", e))?;
    Ok(filename)
}

/// 读取临时目录中的图片，返回 base64。防目录穿越：仅允许纯文件名。
#[tauri::command]
fn read_temp_file(filename: String) -> Result<String, String> {
    use base64::Engine;
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("非法文件名".into());
    }
    let path = ai_temp_dir().join(&filename);
    let bytes = std::fs::read(&path).map_err(|e| format!("读取临时文件失败: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// 清理 AI 临时目录（AI 窗口关闭时调用，避免残留）
#[tauri::command]
fn cleanup_temp_files() -> Result<(), String> {
    let dir = ai_temp_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("清理临时目录失败: {}", e))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动时第一行日志：用户复现问题第一时间能确认 binary 版本。
    // 任何时候看不到这一行、或 commit hash 不对，立刻知道装的是旧版。
    clog!(
        "boot",
        "build=7d2f15f-2026-07-22 ocr=优先中文引擎+14条DIAG链路 commit=7d2f15f"
    );
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
            // 启动分隔：便于在 debug.log 中区分每一次运行
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
                    (Code::Digit4, "⌘/Ctrl+Shift+4"),
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

            // ===== 菜单栏托盘常驻图标 =====
            // 菜单项复用与全局快捷键相同的 capture-* 事件，前端统一由 doCapture 处理。
            // 加速键提示按平台显示：macOS 用 ⌘⇧，Windows/Linux 用 Ctrl+Shift（避免 Windows 上出现看不懂的 Mac 符号）。
            #[cfg(target_os = "macos")]
            let (acc_screen, acc_region, acc_window, acc_quit) = ("⌘⇧1", "⌘⇧2", "⌘⇧3", "⌘Q");
            #[cfg(not(target_os = "macos"))]
            let (acc_screen, acc_region, acc_window, acc_quit) =
                ("Ctrl+Shift+1", "Ctrl+Shift+2", "Ctrl+Shift+3", "Ctrl+Q");
            let mi_screen =
                MenuItem::with_id(app, "cap_screen", "全屏截图", true, Some(acc_screen))?;
            let mi_region =
                MenuItem::with_id(app, "cap_region", "区域截图", true, Some(acc_region))?;
            let mi_window =
                MenuItem::with_id(app, "cap_window", "窗口截图", true, Some(acc_window))?;
            let mi_show = MenuItem::with_id(app, "show_main", "打开 SnapCraft", true, None::<&str>)?;
            let mi_quit = MenuItem::with_id(app, "quit", "退出", true, Some(acc_quit))?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let tray_menu = Menu::with_items(
                app,
                &[
                    &mi_screen,
                    &mi_region,
                    &mi_window,
                    &sep1,
                    &mi_show,
                    &sep2,
                    &mi_quit,
                ],
            )?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                // 使用独立的模板图标：纯黑实心 + 透明镂空线条，避免默认彩色
                // 图标在 template 模式下被 macOS 渲染成单色实心块导致内部线条丢失。
                .icon(tauri::include_image!("icons/tray-icon.png"))
                .icon_as_template(true)
                .tooltip("SnapCraft 截图")
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    let handle = app.clone();
                    match event.id.as_ref() {
                        "cap_screen" => {
                            let _ = handle.emit("capture-screen", ());
                        }
                        "cap_region" => {
                            let _ = handle.emit("capture-region", ());
                        }
                        "cap_window" => {
                            let _ = handle.emit("capture-window", ());
                        }
                        "show_main" => {
                            if let Some(w) = handle.get_webview_window("main") {
                                // 防御：若窗口仍被标记为全屏（异常残留），先归一为普通窗口再显示，避免黑屏
                                if w.is_fullscreen().unwrap_or(false) {
                                    let _ = w.set_fullscreen(false);
                                }
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => {
                            handle.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::capture::capture_screen,
            commands::capture::capture_region,
            commands::capture::capture_region_fixed,
            commands::capture::capture_window,
            commands::capture::capture_window_by_id,
            commands::capture::list_windows,
            commands::capture::list_displays,
            commands::edit::save_screenshot,
            commands::edit::copy_to_clipboard,
            commands::edit::read_clipboard_image,
            commands::edit::read_clipboard_text,
            commands::edit::save_text_file,
            commands::edit::save_binary_file,
            commands::ocr::ocr_image,
            commands::history::get_history,
            commands::history::add_history,
            commands::history::delete_history,
            commands::history::clear_history,
            commands::history::get_screenshot,
            commands::history::update_screenshot_annotations,
            commands::history::set_screenshot_ocr,
            commands::history::set_screenshot_ocr_full,
            get_platform,
            #[cfg(target_os = "macos")]
            is_sandboxed,
            commands::permission::check_microphone_access,
            commands::permission::check_accessibility_access,
            commands::permission::open_permission_settings,
            commands::permission::reset_all_permissions,
            commands::capture::check_screen_capture_access,
            commands::capture::request_screen_capture_access,
            commands::capture::open_screen_recording_settings,
            commands::open::open_external,
            commands::open::reveal_in_folder,
            diag_log,
            save_temp_file,
            read_temp_file,
            cleanup_temp_files,
        ])
        .on_window_event(|window, event| {
            // 点主窗口关闭按钮时不退出进程，改为隐藏到菜单栏托盘，
            // 保留全局快捷键与托盘常驻能力。真正退出走托盘「退出」菜单。
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 诊断：任何窗口（含 editor-* 独立编辑窗）的关闭请求都先打一行，
                // 用于定位「系统关闭按钮无效」——若日志里看不到 editor-* 的这条，说明 OS 事件没到 Rust 层。
                clog!("window", "CloseRequested 收到 label={} (Rust 层)", window.label());
                if window.label() == "main" {
                    api.prevent_close();

                    // ⚠️ macOS 全屏黑屏根因修复：
                    // macOS 原生全屏（绿灯/最大化）会把窗口放进独立的 Space。
                    // 若此时直接 hide()，Space 被错误拆除，下次 show() 时 WebView
                    // 重新挂回一个失效的全屏 Space → 黑屏。走系统「退出」正常是因为
                    // 它彻底销毁进程，从不 hide/reshow 进死掉的 Space。
                    // 修复：隐藏前先退出全屏/最大化，回到普通窗口态再 hide。
                    // 退出全屏是 ~0.5s 的 Space 过渡动画，必须等动画结束再 hide，
                    // 否则在动画中途 hide 依旧复现该 bug，故延迟到后台线程执行。
                    let is_fs = window.is_fullscreen().unwrap_or(false);
                    let is_max = window.is_maximized().unwrap_or(false);
                    clog!(
                        "window",
                        "CloseRequested main: fullscreen={} maximized={}",
                        is_fs,
                        is_max
                    );

                    if is_fs {
                        // ⚠️ macOS 26 崩溃修复（EXC_BAD_ACCESS in WebPageProxy::dispatchSetObscuredContentInsets）：
                        // 原方案 set_fullscreen(false) + 固定延迟 + hide() 在 macOS 26 上会 crash——
                        // 全屏 Space 拆除期间 WebPageProxy 被释放，hide() 触发的 insets 派发解引用 null 指针。
                        // 修复：全屏态下改用 set_minimized(true) 代替 hide()。
                        //   minimize 是原子操作（NSWindow performMiniaturize:），macOS 内部处理全屏退出，
                        //   不走 orderOut → 不触发 dispatchSetObscuredContentInsets → 不 crash。
                        //   minimize 后窗口完全不在屏幕上（dock 缩略图不算），满足"隐藏到托盘"需求。
                        //   后台延迟再 hide() 彻底从 dock 移除（此时 Space 已完全拆除，hide 安全）。
                        clog!("window", "全屏态 → set_minimized (避免 hide() 触发 insets crash)");
                        let _ = window.minimize();
                        let w = window.clone();
                        std::thread::spawn(move || {
                            // 等 minimize + 全屏 Space 拆除彻底完成（macOS 26 需要更长）
                            std::thread::sleep(std::time::Duration::from_millis(1500));
                            // 此时窗口已最小化且不在全屏 Space 中，hide() 安全
                            let wc = w.clone();
                            let _ = w.run_on_main_thread(move || {
                                let _ = wc.hide();
                                clog!("window", "minimize 后延迟 hide 完成");
                            });
                        });
                    } else if is_max {
                        // 最大化不涉及独立 Space，取消最大化后短暂延迟隐藏更稳
                        let _ = window.unmaximize();
                        let w = window.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(150));
                            let wc = w.clone();
                            let _ = w.run_on_main_thread(move || {
                                let _ = wc.hide();
                                clog!("window", "延迟隐藏完成（取消最大化后）");
                            });
                        });
                    } else {
                        let _ = window.hide();
                        clog!("window", "普通窗口态，直接隐藏");
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
