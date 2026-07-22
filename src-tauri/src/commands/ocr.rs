use crate::store;
use serde::Serialize;
use tauri::AppHandle;

/// 单个文字块（已归一化、原点左上，与前端画布坐标一致）。
/// x,y = 文字块左上角（0..1）；w,h = 宽高（0..1）。
/// confidence = 置信度 0..1；部分平台/路径无法提供时为 0（表示未给出）。
#[derive(Serialize)]
pub struct OcrBlock {
    text: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    confidence: f64,
}

/// OCR 识别结果：纯文本（按 Vision 读序、行以 \n 连接，便于「复制全部」）
/// + 带位置/置信度的逐块结果（便于「选区/逐行复制/贴为文字标注」）。
#[derive(Serialize)]
pub struct OcrResult {
    text: String,
    blocks: Vec<OcrBlock>,
}

/// OCR 识别结果：识别出的纯文本（多行以 \n 连接）。
/// 双平台系统原生实现：macOS = Apple Vision；Windows = WinRT Windows.Media.Ocr。
/// `lang`：期望识别语言（如 "zh-Hans" / "en-US" / "ja-JP"），
///   macOS 的 apple-vision 0.16 暂未暴露强制语言（走系统自动选语言），此参数仅 Windows 生效。
#[tauri::command]
pub async fn ocr_image(
    _app: AppHandle,
    image_data: String,
    lang: Option<String>,
) -> Result<OcrResult, String> {
    clog!(
        "ocr",
        "命令=ocr_image data_url 长度={} 前缀={} lang={:?}",
        image_data.len(),
        image_data.chars().take(30).collect::<String>(),
        lang
    );
    // 先把 data URL 落地成临时 PNG，两个平台的原生 OCR 都从文件路径读入最稳。
    let bytes = store::data_url_to_bytes(&image_data).map_err(|e| {
        clog!("ocr", "解码 data_url 失败: {}", e);
        format!("解码图片数据失败: {}", e)
    })?;
    let tmp = store::temp_png_path();
    store::write_bytes(&tmp, &bytes).map_err(|e| {
        clog!("ocr", "写临时 PNG 失败: {:?} err={}", tmp, e);
        format!("写入临时文件失败: {}", e)
    })?;
    clog!("ocr", "临时 PNG 已写入: {:?} ({} 字节)", tmp, bytes.len());
    // 主动分析图像基本特征（图像损坏/过小是 "识别不全" 的常见原因之一）
    if bytes.len() < 2048 {
        clog!(
            "ocr",
            "⚠️ 图像字节数过小 ({} 字节 < 2KB)，可能是空白/纯色截图，OCR 大概率识别不到内容",
            bytes.len()
        );
    }
    // 判断 PNG 头部——data URL 前缀已过滤，这里再校验一次二进制签名
    let magic = bytes.iter().take(8).copied().collect::<Vec<u8>>();
    let is_png = magic == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    clog!(
        "ocr",
        "图像签名校验: is_png={} magic={:02X?}",
        is_png,
        &magic[..magic.len().min(8)]
    );

    let result = run_native_ocr(&tmp, lang.as_deref());
    // 无论成败都清理临时文件
    if let Err(e) = std::fs::remove_file(&tmp) {
        clog!("ocr", "清理临时 PNG 失败: {:?} err={}", tmp, e);
    }

    match &result {
        Ok(r) => {
            // 输出前 5 块文本预览 + 关键统计，让 debug.log 自解释
            let preview: Vec<String> = r
                .blocks
                .iter()
                .take(5)
                .map(|b| {
                    let s: String = b.text.chars().take(40).collect();
                    format!(
                        "  #{:02}  ({:.3},{:.3},{:.3},{:.3})  \"{}\"",
                        0, b.x, b.y, b.w, b.h, s
                    )
                })
                .collect();
            clog!(
                "ocr",
                "识别成功: {} 块, 共 {} 字符  预览前 5 块:\n{}",
                r.blocks.len(),
                r.text.len(),
                preview.join("\n")
            );
            // 主动分析：字符类别分布 + 疑似乱码判断
            let (cjk, latin, digit, other, single_char_lines) = analyze_text(r);
            clog!(
                "ocr",
                "文本类别分布: cjk={} latin={} digit={} other={} single_char_lines={}/{}",
                cjk,
                latin,
                digit,
                other,
                single_char_lines,
                r.blocks.len()
            );
            // 触发建议：CJK 少 + Latin 多 + 单字符行占比高 → 引擎语言错配
            if r.blocks.len() >= 5 {
                let sr = single_char_lines as f64 / r.blocks.len() as f64;
                if cjk == 0 && latin > 20 && sr > 0.3 {
                    clog!("ocr", "SUGGEST: 大量单字符 Latin 块可能是「英文 OCR 引擎误识别中文页面」造成的乱码。当前脚本已优先尝试 zh-Hans-CN；若仍失败，请在「设置 → 时间和语言 → 语言」为中文添加「光学字符识别」组件。");
                } else if sr > 0.5 {
                    clog!("ocr", "SUGGEST: 单字符块占比 {:.0}% > 50%，可能是图像太糊/字号太小/字体渲染子像素抗锯齿导致识别不稳定。建议截图前放大原图或改截更大尺寸。", sr * 100.0);
                }
            }
        }
        Err(e) => clog!("ocr", "识别失败: {}", e),
    }
    result
}

/// 分析 OCR 结果的文本类别分布（用于 debug.log 自解释）。
/// 返回 (cjk, latin, digit, other, single_char_lines)。
fn analyze_text(r: &OcrResult) -> (usize, usize, usize, usize, usize) {
    let mut cjk = 0usize;
    let mut latin = 0usize;
    let mut digit = 0usize;
    let mut other = 0usize;
    let mut single_char_lines = 0usize;
    for b in &r.blocks {
        if b.text.chars().count() <= 1 {
            single_char_lines += 1;
        }
        for ch in b.text.chars() {
            let code = ch as u32;
            if (0x4E00..=0x9FFF).contains(&code) || (0x3400..=0x4DBF).contains(&code) {
                cjk += 1;
            } else if ch.is_ascii_alphabetic() {
                latin += 1;
            } else if ch.is_ascii_digit() {
                digit += 1;
            } else {
                other += 1;
            }
        }
    }
    (cjk, latin, digit, other, single_char_lines)
}

// ===== macOS：Apple Vision 框架（apple-vision crate，编译期绑定，用户零依赖） =====
#[cfg(target_os = "macos")]
fn run_native_ocr(path: &std::path::Path, _lang: Option<&str>) -> Result<OcrResult, String> {
    use apple_vision::prelude::*;

    let started = std::time::Instant::now();
    let path_str = path.to_str().ok_or("无效的临时路径")?;
    clog!("ocr", "→ macOS Vision OCR: 识别 {}", path_str);

    // Accurate 级别 + 语言校正，兼顾中英文准确度；识别语言由系统按内容自动选择
    // （apple-vision 0.16 的 TextRecognizer 未暴露强制语言接口，_lang 暂保留供将来）。
    if let Some(l) = _lang {
        clog!(
            "ocr",
            "⚠️ macOS Vision 后端暂不支持强制语言（apple-vision 0.16 限制），\
             前端传入的 lang={:?} 将被忽略，系统按内容自动选择识别语言",
            l
        );
    }
    let recognizer = TextRecognizer::new()
        .with_recognition_level(RecognitionLevel::Accurate)
        .with_language_correction(true);

    let observations = recognizer
        .recognize_in_path(path_str)
        .map_err(|e| format!("Vision 识别失败: {:?}", e))?;

    // 每个 observation 是一行/一段。Vision 的 bounding_box 原点在左下、需翻转为左上。
    let blocks: Vec<OcrBlock> = observations
        .iter()
        .map(|o| {
            let b = o.bounding_box;
            OcrBlock {
                text: o.text.trim_end().to_string(),
                x: b.x,
                y: 1.0 - b.y - b.height, // 左下原点 → 左上原点
                w: b.width,
                h: b.height,
                confidence: o.confidence as f64,
            }
        })
        .collect();

    let text = blocks
        .iter()
        .map(|b| b.text.clone())
        .collect::<Vec<_>>()
        .join("\n");

    clog!(
        "ocr",
        "Vision 完成: {} 个文本块, 共 {} 字符, 耗时={}ms",
        blocks.len(),
        text.len(),
        started.elapsed().as_millis()
    );
    if text.trim().is_empty() {
        return Err("未识别到文字".into());
    }
    Ok(OcrResult { text, blocks })
}

// ===== Windows：WinRT Windows.Media.Ocr（系统自带 PowerShell 5.1 子进程调用，用户零依赖） =====
// 不引入 windows crate（巨型依赖 + 可能与 Tauri 的 windows 版本冲突），
// 改用 Win10/11 系统自带的 PowerShell 5.1 通过 WinRT 类型投影完成识别。
//
// 关键工程细节（2026-07-21 血泪修）：
//   ① 脚本落到临时 .ps1 文件，避开 `-Command` 内联超长脚本的引号/转义地狱。
//   ② 图片路径也落到脚本旁边的 sidecar 文件读取，不做字符串插值——路径含引号/空格/中文全兼容。
//   ③ `[Console]::OutputEncoding = UTF8` 放在脚本第一行，保证异常抛出前就是 UTF-8（否则错误按 GBK 出，
//      Rust 侧 from_utf8_lossy 变乱码，用户看到的 "OCR 直接报错" 完全没根因）。
//   ④ 用 `-ExecutionPolicy Bypass -File`：绕过用户组策略 Restricted。
//   ⑤ 精细分类错误：PS 未找到、WinRT 组件加载失败、语言包缺失、图片解码失败、空结果 → 各自返回可读文案；
//      不认得的 stderr 原样返回，同时 clog! 落 debug.log 便于线下复现。
//   ⑥ PowerShell 输出单元素数组时 ConvertTo-Json 会退化为对象；显式加 `@()` 强制数组。
#[cfg(target_os = "windows")]
fn run_native_ocr(path: &std::path::Path, lang: Option<&str>) -> Result<OcrResult, String> {
    run_native_ocr_windows(path, lang)
}

#[cfg(any(target_os = "windows", test))]
#[allow(dead_code)]
fn run_native_ocr_windows(path: &std::path::Path, lang: Option<&str>) -> Result<OcrResult, String> {
    use std::process::Command;

    let started = std::time::Instant::now();
    let img_path = path.to_string_lossy().to_string();
    let lang_arg = lang.unwrap_or("").to_string();
    clog!(
        "ocr",
        "→ Windows WinRT OCR: 识别 {} lang={:?}",
        img_path,
        lang_arg
    );

    // ---- ① 用 sidecar 文件传路径与语言参数（避免字符串插值受特殊字符影响）----
    let dir = std::env::temp_dir();
    let uid = uuid::Uuid::new_v4();
    let ps1_path = dir.join(format!("snapcraft-ocr-{}.ps1", uid));
    let arg_path = dir.join(format!("snapcraft-ocr-{}.args.txt", uid));
    // arg 文件两行：第 1 行=图片绝对路径，第 2 行=语言代码（可空）
    // 加 UTF-8 BOM——PS 5.1 的 Get-Content -Encoding UTF8 在无 BOM 时会走 ANSI 回退启发式，
    // 用户目录含中文（例：C:\Users\张三\AppData\Local\Temp\）时会解码错误。
    // 加了 BOM 就 100% 走 UTF-8 解析路径，与 .ps1 脚本一致的双保险。
    let arg_text = format!("{}\n{}\n", img_path, lang_arg);
    let mut arg_buf: Vec<u8> = Vec::with_capacity(arg_text.len() + 3);
    arg_buf.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    arg_buf.extend_from_slice(arg_text.as_bytes());
    std::fs::write(&arg_path, &arg_buf)
        .map_err(|e| format!("写 OCR 参数文件失败: {}", e))?;

    // ---- ② PS 脚本：UTF-8 编码前置 + WinRT 调用 + 归一化 JSON 输出 ----
    // 重要（血泪坑）：Windows PowerShell 5.1 读取 .ps1 文件时默认按 **系统 ANSI codepage**
    // 解析（中文 Windows = GBK/CP936），除非文件带 UTF-8 BOM。原先脚本含中文注释时，
    // GBK 解码破坏 tokenizer，最终在 `} catch {` 附近报 UnexpectedToken。
    // 双保险：① 脚本文件写入 UTF-8 with BOM；② 注释全英文纯 ASCII，即使 BOM 被杀软策略
    // 吃掉也能正常 tokenize。
    // 注意：这里所有 $ 与 { 都不再受 Rust format! 影响（普通字符串字面量）；
    //       只有 <ARGS_PATH> 一处占位符用 replace 注入，避开 Rust format! 的花括号转义地狱。
    let script_tpl = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

try {
    $argLines = Get-Content -LiteralPath '<ARGS_PATH>' -Encoding UTF8
    if ($argLines.Count -lt 1) { Write-Error 'ARGS_MISSING'; exit 10 }
    $imgPath = $argLines[0]
    $langCode = if ($argLines.Count -ge 2) { $argLines[1] } else { '' }

    if (-not (Test-Path -LiteralPath $imgPath)) { Write-Error 'IMG_NOT_FOUND'; exit 11 }

    # Load WinRT types (built-in on Win10/11; Windows Server / N-SKU may lack them)
    try {
        $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
        $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
        $null = [Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime]
        $null = [Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]
    } catch {
        Write-Error 'WINRT_MISSING'; exit 12
    }

    # AsTask reflection: convert WinRT IAsyncOperation<T> to .NET Task<T> and wait sync
    $asm = [System.Reflection.Assembly]::LoadWithPartialName('System.Runtime.WindowsRuntime')
    if ($asm -eq $null) { Write-Error 'WINRT_RT_MISSING'; exit 13 }
    $extType = $asm.GetType('System.WindowsRuntimeSystemExtensions')
    $asTask = ($extType.GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    function AwaitT($op, [Type]$rt) {
        $task = $asTask.MakeGenericMethod($rt).Invoke($null, @($op))
        $task.Wait()
        $task.Result
    }

    # Enumerate all installed OCR languages (for DIAG_ENV logging + smart pick)
    $supported = @()
    try {
        foreach ($sl in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
            $supported += $sl.LanguageTag
        }
    } catch {}

    # Language selection priority (fixes the "English engine reading Chinese page"
    # root cause of "incomplete recognition + garbled characters"):
    #   1) explicit langCode passed from Rust
    #   2) zh-Hans-CN (Simplified Chinese engine also reads English chars fine;
    #      the reverse - English engine reading Chinese - produces the exact
    #      "recognized text incomplete + garbled" symptom the user reported)
    #   3) zh-Hant-TW  (Traditional Chinese, Taiwan region)
    #   4) en-US       (fallback for English-only screenshots)
    #   5) TryCreateFromUserProfileLanguages (system default heuristic)
    $engine = $null
    $chosenTag = ''
    $tries = @()
    if ($langCode -ne '') { $tries += $langCode }
    $tries += @('zh-Hans-CN','zh-Hans','zh-Hant-TW','zh-Hant','en-US')
    foreach ($tag in $tries) {
        if ([string]::IsNullOrEmpty($tag)) { continue }
        try {
            $l = [Windows.Globalization.Language]::new($tag)
            if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($l)) {
                $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($l)
                if ($engine -ne $null) {
                    $chosenTag = $tag
                    break
                }
            }
        } catch {}
    }
    if ($engine -eq $null) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if ($engine -ne $null -and $engine.RecognizerLanguage -ne $null) {
            $chosenTag = ($engine.RecognizerLanguage.LanguageTag + ' (user-profile-fallback)')
        }
    }
    if ($engine -eq $null) { Write-Error 'NO_OCR_ENGINE'; exit 14 }

    # DIAG_ENV: expose engine + supported langs to Rust via stderr (grep-able one-liner)
    $userProfile = ''
    try {
        $upl = @()
        foreach ($p in [Windows.System.UserProfile.GlobalizationPreferences]::Languages) { $upl += $p }
        $userProfile = ($upl -join ',')
    } catch {}
    [Console]::Error.WriteLine("DIAG_ENV: engine_lang=$chosenTag supported=[$($supported -join ',')] user_profile=[$userProfile]")

    # Read image -> decode SoftwareBitmap -> recognize
    $file = AwaitT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imgPath)) ([Windows.Storage.StorageFile])
    $stream = AwaitT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = AwaitT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = AwaitT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    } catch {
        Write-Error 'IMG_DECODE_FAILED'; exit 15
    } finally {
        try { $stream.Dispose() } catch {}
    }

    $result = AwaitT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $iw = $bitmap.PixelWidth
    $ih = $bitmap.PixelHeight
    [Console]::Error.WriteLine("DIAG_IMG: pixel=${iw}x${ih} format=$($bitmap.BitmapPixelFormat) alpha=$($bitmap.BitmapAlphaMode) text_angle=$($result.TextAngle)")

    $arr = @()
    foreach ($line in $result.Lines) {
        # IMPORTANT: WinRT OcrLine has NO BoundingRect property (only Text + Words).
        # To get per-line box, union all word rects. If words empty, skip line.
        $words = $line.Words
        if ($words -eq $null -or $words.Count -eq 0) { continue }
        $minX = [double]::MaxValue
        $minY = [double]::MaxValue
        $maxX = [double]::MinValue
        $maxY = [double]::MinValue
        foreach ($word in $words) {
            $r = $word.BoundingRect
            $wx = [double]$r.X
            $wy = [double]$r.Y
            $ww = [double]$r.Width
            $wh = [double]$r.Height
            if ($wx -lt $minX) { $minX = $wx }
            if ($wy -lt $minY) { $minY = $wy }
            if (($wx + $ww) -gt $maxX) { $maxX = $wx + $ww }
            if (($wy + $wh) -gt $maxY) { $maxY = $wy + $wh }
        }
        # Force double division; PS integer / integer would truncate to 0.
        $arr += [pscustomobject]@{
            text = $line.Text
            x = $minX / [double]$iw
            y = $minY / [double]$ih
            w = ($maxX - $minX) / [double]$iw
            h = ($maxY - $minY) / [double]$ih
        }
    }
    # DIAG_RESULT: summarize what the engine actually saw (character class breakdown +
    # rough "garbled" heuristic). Emit BEFORE ConvertTo-Json so it lands on stderr even
    # if serialization somehow fails.
    $allText = ($arr | ForEach-Object { $_.text }) -join ''
    $totalChars = $allText.Length
    $cjkCount = 0
    $latinCount = 0
    $digitCount = 0
    $otherCount = 0
    foreach ($ch in $allText.ToCharArray()) {
        $code = [int]$ch
        if ($code -ge 0x4E00 -and $code -le 0x9FFF) { $cjkCount++ }
        elseif ($code -ge 0x3400 -and $code -le 0x4DBF) { $cjkCount++ }
        elseif (($code -ge 0x41 -and $code -le 0x5A) -or ($code -ge 0x61 -and $code -le 0x7A)) { $latinCount++ }
        elseif ($code -ge 0x30 -and $code -le 0x39) { $digitCount++ }
        else { $otherCount++ }
    }
    # Single-character lines with non-CJK content are a common garble pattern
    # (e.g. Chinese page misread by English engine spits out isolated 'l','I','1','o','O' etc.)
    $singleCharLines = ($arr | Where-Object { $_.text.Length -le 1 }).Count
    [Console]::Error.WriteLine("DIAG_RESULT: lines=$($arr.Count) chars=$totalChars cjk=$cjkCount latin=$latinCount digit=$digitCount other=$otherCount single_char_lines=$singleCharLines")

    # Use -InputObject to bypass pipeline (piped arrays get wrapped as {"value":[...]}
    # in PS 5.1); -InputObject with @($arr) always serializes as a JSON array,
    # even for 0 or 1 element (@() enforces array type).
    Write-Output (ConvertTo-Json -InputObject @($arr) -Compress -Depth 4)
    exit 0
} catch {
    # Catchall: full Message + StackTrace to stderr, Rust clog! persists it
    $msg = $_.Exception.Message
    $st  = $_.ScriptStackTrace
    Write-Error ("UNCAUGHT: " + $msg + "`n" + $st)
    exit 99
}
"#;
    let script = script_tpl.replace(
        "<ARGS_PATH>",
        // PS 单引号字符串里的 `'` 需转义成 `''`（虽然 %TEMP% + UUID 路径几乎不会含单引号，
        // 但用户 profile 可能被改成含 `'` 的名字，加转义 0 成本 100% 保险）
        &arg_path.to_string_lossy().replace('\'', "''"),
    );
    // Write UTF-8 with BOM. PowerShell 5.1 auto-detects BOM and skips ANSI/GBK fallback;
    // no BOM = 中文 Windows PS 会用 GBK 解析，即使脚本全 ASCII 也偶发 parser 边界 bug。
    let mut buf: Vec<u8> = Vec::with_capacity(script.len() + 3);
    buf.extend_from_slice(&[0xEF, 0xBB, 0xBF]); // UTF-8 BOM
    buf.extend_from_slice(script.as_bytes());
    std::fs::write(&ps1_path, &buf).map_err(|e| format!("写 OCR 脚本文件失败: {}", e))?;

    // ---- ③ 用 -File 执行，绕过 -Command 引号地狱和 ExecutionPolicy 限制 ----
    // powershell.exe 是 Windows PowerShell 5.1（PS7 pwsh 移除了 WinRT 投影，不能用）
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &ps1_path.to_string_lossy(),
        ])
        .output();

    // 无论成败，先清理临时脚本 / 参数文件（避免 %TEMP% 堆积）
    let _ = std::fs::remove_file(&ps1_path);
    let _ = std::fs::remove_file(&arg_path);

    let output = output.map_err(|e| {
        let msg = e.to_string();
        clog!("ocr", "无法启动 PowerShell: {}", msg);
        if msg.contains("not found") || msg.contains("os error 2") {
            "系统未找到 Windows PowerShell 5.1（powershell.exe）。请确认 Windows 未卸载该组件。".to_string()
        } else {
            format!("无法启动 PowerShell 5.1: {}", msg)
        }
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let code = output.status.code();
    clog!(
        "ocr",
        "WinRT OCR 返回: 退出码={:?} 耗时={}ms stdout_len={} stderr_len={}",
        code,
        started.elapsed().as_millis(),
        stdout.len(),
        stderr.len()
    );
    // 无论成败都透传 PS 侧写到 stderr 的 DIAG_* 诊断行 —— 这些能一眼看出
    // 引擎选了哪种语言、图像格式、结果字符类别分布。是"识别不全/乱码"排查的关键。
    for line in stderr.lines() {
        let t = line.trim();
        if t.starts_with("DIAG_ENV:")
            || t.starts_with("DIAG_IMG:")
            || t.starts_with("DIAG_RESULT:")
        {
            clog!("ocr", "PS→ {}", t);
        }
    }
    // stdout 前 400 字节预览，判断 JSON 结构是裸数组还是 {"value":[...]}
    if !stdout.is_empty() {
        let preview: String = stdout.chars().take(400).collect();
        clog!("ocr", "stdout 预览: {}", preview.replace('\n', "\\n"));
    }
    // 非 DIAG_* 的 stderr（真实错误）也全量落盘
    let non_diag_err: String = stderr
        .lines()
        .filter(|l| {
            let t = l.trim();
            !t.starts_with("DIAG_ENV:")
                && !t.starts_with("DIAG_IMG:")
                && !t.starts_with("DIAG_RESULT:")
                && !t.is_empty()
        })
        .collect::<Vec<_>>()
        .join(" | ");
    if !non_diag_err.is_empty() {
        clog!("ocr", "stderr(非 DIAG): {}", non_diag_err);
    }

    if !output.status.success() {
        // 分类错误码 → 用户可读文案
        if stderr.contains("ARGS_MISSING") {
            return Err("OCR 内部错误：参数文件为空，请重试或反馈问题。".into());
        }
        if stderr.contains("IMG_NOT_FOUND") {
            return Err("OCR 无法读取临时截图文件（可能被杀软拦截）。请把 %TEMP%\\snapcraft-*.png 加入信任列表后重试。".into());
        }
        if stderr.contains("WINRT_MISSING") || stderr.contains("WINRT_RT_MISSING") {
            return Err(
                "本机 Windows 未安装 WinRT 组件（常见于 Windows Server / N-SKU）。\
                 请安装 Media Feature Pack 或改用完整 Windows 10/11 家庭版/专业版。".into(),
            );
        }
        if stderr.contains("NO_OCR_ENGINE") {
            return Err(
                "系统未安装可用的 OCR 语言包。请在「设置 → 时间和语言 → 语言 → 添加语言」\
                 后进入该语言的「语言选项」勾选「光学字符识别」下载完成后重试。".into(),
            );
        }
        if stderr.contains("IMG_DECODE_FAILED") {
            return Err("OCR 无法解码截图（不支持的格式或文件损坏）。请重新截图后重试。".into());
        }
        // 未分类错误：原样返回 stderr（含 UNCAUGHT: 前缀）
        return Err(format!(
            "Windows OCR 失败（退出码 {}）：{}",
            code.unwrap_or(-1),
            stderr.trim()
        ));
    }

    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        // 成功退出但无输出 = 图像里无文字
        return Err("未识别到文字".into());
    }

    // 解析 PowerShell 输出的归一化 JSON 数组（置信度 WinRT 不提供 → 记 0）。
    #[derive(serde::Deserialize)]
    struct WinLine {
        text: String,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }
    // PS 5.1 通过管道传数组给 ConvertTo-Json 时会把结果包裹成 `{"value":[...],"Count":N}`；
    // -InputObject 形式则输出裸数组 `[...]`。两种格式都兼容，保险起见都解析一遍。
    #[derive(serde::Deserialize)]
    struct WinLinesWrapped {
        value: Vec<WinLine>,
    }
    let lines: Vec<WinLine> = if let Ok(arr) = serde_json::from_str::<Vec<WinLine>>(trimmed) {
        arr
    } else if let Ok(w) = serde_json::from_str::<WinLinesWrapped>(trimmed) {
        w.value
    } else {
        // 两种都失败，把详细错落 debug.log，让用户/开发者能贴日志排查
        let err = match serde_json::from_str::<Vec<WinLine>>(trimmed) {
            Ok(_) => "unknown".to_string(),
            Err(e) => e.to_string(),
        };
        clog!(
            "ocr",
            "WinRT OCR JSON 解析失败: {} raw={:?}",
            err,
            trimmed.chars().take(200).collect::<String>()
        );
        return Err(format!("OCR 结果解析失败：{}", err));
    };
    let blocks: Vec<OcrBlock> = lines
        .into_iter()
        .map(|l| OcrBlock {
            text: l.text.trim_end().to_string(),
            x: l.x,
            y: l.y,
            w: l.w,
            h: l.h,
            confidence: 0.0,
        })
        .collect();
    let text = blocks
        .iter()
        .map(|b| b.text.clone())
        .collect::<Vec<_>>()
        .join("\n");

    if text.trim().is_empty() {
        return Err("未识别到文字".into());
    }
    Ok(OcrResult { text, blocks })
}

// ===== 其它平台（Linux 等）：暂无系统原生 OCR =====
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn run_native_ocr(_path: &std::path::Path, _lang: Option<&str>) -> Result<OcrResult, String> {
    Err("当前平台暂不支持系统原生 OCR（仅 macOS / Windows）".into())
}
