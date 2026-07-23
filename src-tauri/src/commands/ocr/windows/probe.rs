// WinRT OcrEngine 能力探测：MaxImageDimension + AvailableRecognizerLanguages 缓存
// ===== OCR 引擎能力探测（P1#35+#38, 2026-07-23）=====
//
// 不同 Windows build 的 WinRT OcrEngine.MaxImageDimension 不同（8000/10000/16384），
// 写死 10000 会把 10800 长边过度缩放 → 小字模糊。改为**启动探测一次**缓存。
// 同时把 AvailableRecognizerLanguages 也一并探测（给 #36 BCP-47 回退用）。
//
// 探查脚本只跑一次（`OnceLock` 保证），后续所有 OCR 直接读缓存，不再重复枚举
// （一次枚举 ~1~2s PS 启动损耗，用户反馈过「识别很慢」）。

/// 探测到的引擎能力（当前只用 max_dim；supported 仅日志用，不入缓存）
#[cfg(any(target_os = "windows", test))]
#[derive(Clone)]
pub(crate) struct OcrEngineCapabilities {
    /// WinRT OcrEngine.MaxImageDimension 静态属性（0 = 探测失败 → 回退 10000）
    pub(crate) max_dim: u32,
}

#[cfg(any(target_os = "windows", test))]
pub(crate) static OCR_CAPS: std::sync::OnceLock<OcrEngineCapabilities> = std::sync::OnceLock::new();

/// BCP-47 语言回退优先级（#36, 2026-07-23）。
/// CJK 优先（避免 English 引擎读中文页 → 识别不全 + 乱码），再 en-US，再其他常用语言。
/// 用户显式 lang 优先于本列表；列表都失败且用户未显式指定 → 走 UserProfile 兜底。
#[cfg(any(target_os = "windows", test))]
pub(crate) const OCR_FALLBACK_LANGS: &[&str] = &[
    "zh-Hans-CN", "zh-Hans", "ja-JP", "ko-KR", "en-US", "zh-Hant-TW", "zh-Hant",
    "fr-FR", "de-DE", "es-ES", "ru-RU", "ar-SA",
];

/// 解析探测脚本的 stdout JSON：{"max_dim":N,"supported":["tag",...]}
/// 纯函数、可单测。
#[cfg(any(target_os = "windows", test))]
pub(crate) fn parse_probe_json(s: &str) -> (u32, Vec<String>) {
    let mut max_dim = 0u32;
    if let Some(p) = s.find("\"max_dim\"") {
        let rest = &s[p..];
        if let Some(colon) = rest.find(':') {
            let after = &rest[colon + 1..];
            let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            max_dim = digits.parse().unwrap_or(0);
        }
    }
    let mut langs = Vec::new();
    if let Some(p) = s.find("\"supported\"") {
        let rest = &s[p..];
        if let Some(arr_start) = rest.find('[') {
            let after = &rest[arr_start..];
            if let Some(arr_end) = after.find(']') {
                let arr = &after[..=arr_end];
                // arr = ["en-US","zh-Hans-CN"] —— 提引号包裹的 tag
                let mut in_str = false;
                let mut cur = String::new();
                for ch in arr.chars() {
                    if ch == '"' {
                        if in_str {
                            let t = cur.trim().to_string();
                            if !t.is_empty() {
                                langs.push(t);
                            }
                            cur.clear();
                            in_str = false;
                        } else {
                            in_str = true;
                        }
                    } else if in_str {
                        cur.push(ch);
                    }
                }
            }
        }
    }
    (max_dim, langs)
}

/// 从真实 WinRT OcrEngine 探测能力（仅跑一次）。
/// 失败（无 powershell / 无 WinRT）回退到保守默认 max_dim=10000, supported=空。
#[cfg(any(target_os = "windows", test))]
pub(crate) fn ocr_startup_probe() -> OcrEngineCapabilities {
    use std::process::Command;
    let dir = std::env::temp_dir();
    let uid = uuid::Uuid::new_v4();
    let ps1_path = dir.join(format!("snapcraft-ocr-probe-{}.ps1", uid));
    // 纯 ASCII 脚本（双保险：注释全 ASCII + UTF-8 BOM，同主 OCR 铁律）
    let script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n\
[Console]::ErrorActionPreference = 'Stop'\n\
try {\n\
  $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]\n\
} catch {\n\
  [Console]::Error.WriteLine('PROBE_WINRT_MISSING'); exit 12\n\
}\n\
$maxDim = 0\n\
try { $maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension } catch {}\n\
$supported = @()\n\
try { foreach ($sl in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) { $supported += $sl.LanguageTag } } catch {}\n\
$json = @{ max_dim = $maxDim; supported = $supported } | ConvertTo-Json -Compress\n\
[Console]::Out.WriteLine($json)\n\
exit 0\n";
    let mut buf: Vec<u8> = Vec::with_capacity(script.len() + 3);
    buf.extend_from_slice(&[0xEF, 0xBB, 0xBF]); // UTF-8 BOM
    buf.extend_from_slice(script.as_bytes());
    std::fs::write(&ps1_path, &buf).ok();
    let out = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &ps1_path.to_string_lossy(),
        ])
        .output();
    let _ = std::fs::remove_file(&ps1_path);
    match out {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let (md, langs) = parse_probe_json(&stdout);
            clog!(
                "ocr",
                "PROBE: WinRT 能力探测 max_dim={} supported=[{}]",
                md,
                langs.join(",")
            );
            OcrEngineCapabilities { max_dim: md }
        }
        Err(_) => {
            clog!("ocr", "PROBE: powershell 不可用，回退默认 max_dim=10000");
            OcrEngineCapabilities { max_dim: 0 }
        }
    }
}

/// 计算实际使用的 OCR 上限（带余量）。
/// raw=0（探测失败）→ 10000 保守默认；否则 raw*0.9 并 clamp 到 [8000,16384]。
#[cfg(any(target_os = "windows", test))]
pub(crate) fn compute_ocr_cap(raw_max_dim: u32) -> u32 {
    if raw_max_dim == 0 {
        return 10000;
    }
    let cap = (raw_max_dim as f64 * 0.9) as u32;
    cap.clamp(8000, 16384)
}

/// 取缓存的引擎能力（首次调用触发一次探测）。
#[cfg(any(target_os = "windows", test))]
pub(crate) fn get_ocr_caps() -> &'static OcrEngineCapabilities {
    OCR_CAPS.get_or_init(ocr_startup_probe)
}
