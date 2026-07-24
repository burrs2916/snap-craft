// src-tauri/src/platform/mod.rs
// 平台抽象层：集中管理平台特定的 FFI 绑定与工具函数。
// 消除 capture.rs 与 screen_capture_kit.rs 中重复的 CoreGraphics 声明。

#[cfg(target_os = "macos")]
pub mod macos_display;
