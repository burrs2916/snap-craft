//! 轻量文件日志器（无第三方依赖）。
//!
//! 目的：把截屏全链路的诊断信息落到 `logs/dev.log`，用于精确定位错误。
//! - 同时输出到 stderr（终端 / tauri 输出可见）与日志文件（best-effort，失败绝不影响主流程）。
//! - 日志文件路径优先级：
//!     1. 环境变量 `SNAP_LOG_FILE`（`start.sh dev` 注入的绝对路径，最可靠）
//!     2. debug 构建：编译期 `CARGO_MANIFEST_DIR` 的父目录（即项目根）下 `logs/dev.log`
//!     3. 都不可用（如 release）：仅打 stderr，不写文件
//! - 时间戳固定东八区（本项目用户在中国），格式 `YYYY-MM-DD HH:MM:SS.mmm`，无需引入 chrono。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// 解析日志文件路径。返回 None 表示不写文件（仅 stderr）。
fn log_path() -> Option<PathBuf> {
    // 1) 显式环境变量优先
    if let Ok(p) = std::env::var("SNAP_LOG_FILE") {
        let p = p.trim();
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    // 2) debug 构建：用编译期 manifest 目录反推项目根
    #[cfg(debug_assertions)]
    {
        // CARGO_MANIFEST_DIR 形如 .../snap-craft/src-tauri
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(root) = manifest.parent() {
            return Some(root.join("logs").join("dev.log"));
        }
    }
    None
}

/// 生成东八区可读时间戳 `YYYY-MM-DD HH:MM:SS.mmm`（civil_from_days，无需 chrono）。
fn timestamp() -> String {
    let dur = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d,
        Err(_) => return "0000-00-00 00:00:00.000".to_string(),
    };
    let millis = dur.subsec_millis();
    let secs = dur.as_secs() as i64 + 8 * 3600; // 东八区
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (hh, mi, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // Howard Hinnant civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        y, m, d, hh, mi, ss, millis
    )
}

/// 追加一条日志。`tag` 用于区分子系统（如 "capture" / "boot"）。
pub fn log(tag: &str, msg: &str) {
    let line = format!("[{}] [{}] {}", timestamp(), tag, msg);
    // 始终打到 stderr
    eprintln!("{}", line);
    // 追加到文件（best-effort）
    if let Some(path) = log_path() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{}", line);
        }
    }
}

/// 便捷宏：`clog!("capture", "msg {}", x)`。
#[macro_export]
macro_rules! clog {
    ($tag:expr, $($arg:tt)*) => {
        $crate::logger::log($tag, &format!($($arg)*))
    };
}
