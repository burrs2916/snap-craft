//! 运行时诊断日志器（无第三方依赖）。
//!
//! 目标：运行时自动把诊断日志落到 `debug.log`，用于精确定位运行期问题——
//! 尤其是 Windows 生产构建（此前仅在 debug 构建写文件，release 不落盘，
//! 导致用户报 bug 时本地没有任何日志可查）。
//!
//! 路径优先级（对齐 biosphere-terminal-app 的"日志与 .exe 同目录"约定，
//! 便于测试者拿到打包产物后不用翻 `%LOCALAPPDATA%` 就能看到日志）：
//!   1. 环境变量 `SNAP_LOG_FILE`（绝对路径，最可靠；`start.sh dev` 注入 `logs/debug.log`）
//!   2. **可执行文件同级目录** `<exe_dir>/debug.log`（生产/测试主路径）
//!      - Windows: 与 `SnapCraft.exe` 同目录（安装包/绿色版均可写；`Program Files` 只读时才回退）
//!      - macOS: `SnapCraft.app/Contents/MacOS/debug.log`（不可写时回退）
//!      - Linux AppImage: 与 AppImage 同目录（若可写）
//!   3. 用户数据目录 `SnapCraft/debug.log`（exe 同级不可写时的兜底）
//!      - Windows: `%LOCALAPPDATA%\SnapCraft\debug.log`
//!      - macOS:   `~/Library/Application Support/SnapCraft/debug.log`（沙箱内为容器目录）
//!      - Linux:   `$XDG_DATA_HOME/SnapCraft/debug.log` 或 `~/.local/share/SnapCraft/debug.log`
//!   4. debug 构建额外写仓库根 `logs/debug.log`（便于开发期 `tail -f` 查看）
//!
//! - 同时输出到 stderr（终端 / tauri 输出可见）与所有日志文件（best-effort，失败绝不影响主流程）。
//! - 单文件超过 5MB 自动轮转（debug.log → debug.log.1，仅保留 1 个历史备份），避免无限增长。
//! - 时间戳固定东八区，格式 `YYYY-MM-DD HH:MM:SS.mmm`，无需引入 chrono。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// 单文件轮转阈值（5MB）。超过则备份为 `debug.log.1` 并从新文件开始。
const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024;

/// 当前可执行文件所在目录（生产环境把日志落这里，与 .exe 同级）。
/// 打包后 Windows 是 `<install_dir>` / macOS bundle 是 `.app/Contents/MacOS/`。
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// 判断某个目录是否可写：尝试创建一个临时探针文件；成功后立即删除。
/// 这是唯一可靠的方式——`Program Files` 目录 UAC 提升前 write 会静默失败。
fn is_writable(dir: &std::path::Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    // 用 nanoseconds 生成不冲突的探针名（无需 uuid 依赖，日志器要保持零依赖）
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let probe = dir.join(format!(".snapcraft-write-probe-{}", ns));
    match OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 跨平台「用户数据目录」（无需第三方 crate，避免给 release 二进制加依赖）。
/// Windows 优先读 `LOCALAPPDATA`，再退回 `USERPROFILE\AppData\Local`；
/// macOS/Linux 用 `HOME` 推导（沙箱内 `HOME` 已指向容器根，路径天然可写）。
fn user_data_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("LOCALAPPDATA") {
        return Some(PathBuf::from(d));
    }
    if let Some(d) = std::env::var_os("USERPROFILE") {
        return Some(PathBuf::from(d).join("AppData").join("Local"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        if cfg!(target_os = "macos") {
            return Some(home.join("Library").join("Application Support"));
        }
        if cfg!(target_os = "linux") {
            if let Some(x) = std::env::var_os("XDG_DATA_HOME") {
                return Some(PathBuf::from(x));
            }
            return Some(home.join(".local").join("share"));
        }
    }
    None
}

/// 解析所有日志文件路径（按优先级；可能多条）。返回空 Vec 表示仅 stderr。
fn log_paths() -> Vec<PathBuf> {
    // 1) 显式环境变量优先（start.sh dev 注入绝对路径，单文件模式）
    if let Ok(p) = std::env::var("SNAP_LOG_FILE") {
        let p = p.trim();
        if !p.is_empty() {
            return vec![PathBuf::from(p)];
        }
    }
    let mut paths = Vec::new();
    // 2) 首选 exe 同级目录（对齐 biosphere-terminal-app 约定，测试者一眼可见）
    //    仅当目录实际可写时采用；`C:\Program Files\...` 只读会回退到用户目录。
    if let Some(dir) = exe_dir() {
        if is_writable(&dir) {
            paths.push(dir.join("debug.log"));
        } else {
            // exe 目录不可写 → 3) 回退到用户数据目录（Windows 生产主路径）
            if let Some(ud) = user_data_dir() {
                paths.push(ud.join("SnapCraft").join("debug.log"));
            }
        }
    } else if let Some(ud) = user_data_dir() {
        paths.push(ud.join("SnapCraft").join("debug.log"));
    }
    // 4) debug 构建额外写仓库根 logs/debug.log（开发期便于查看）
    #[cfg(debug_assertions)]
    {
        // CARGO_MANIFEST_DIR 形如 .../snap-craft/src-tauri
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(root) = manifest.parent() {
            let dev_log = root.join("logs").join("debug.log");
            // 避免与 exe 同级路径重复（cargo run 里 exe_dir=target/debug，manifest 根不同）
            if !paths.iter().any(|p| p == &dev_log) {
                paths.push(dev_log);
            }
        }
    }
    paths
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
    // 追加到所有文件目标（best-effort）
    for path in log_paths() {
        write_one(&path, &line);
    }
}

/// 写一行到单个文件；若超过轮转阈值则先备份为 `.1` 再写新文件。
fn write_one(path: &PathBuf, line: &str) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    // 轮转：超过阈值则备份为 debug.log.1（覆盖旧备份）并从新文件开始
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > MAX_LOG_SIZE {
            let backup = path.with_extension("log.1"); // debug.log -> debug.log.1
            let _ = fs::remove_file(&backup);
            let _ = fs::rename(path, &backup);
        }
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", line);
    }
}

/// 便捷宏：`clog!("capture", "msg {}", x)`。
#[macro_export]
macro_rules! clog {
    ($tag:expr, $($arg:tt)*) => {
        $crate::logger::log($tag, &format!($($arg)*))
    };
}
