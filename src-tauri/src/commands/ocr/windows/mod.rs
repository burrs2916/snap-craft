// Windows WinRT OCR 实现（编排器）
// 子模块：chunking(切块) / preprocess(预处理) / binarize(二值化) / probe(引擎探测)
//         reassemble(Word→Line重排) / quality(翻车自检+共识) / merge(切块投票合并)
use super::*;

mod binarize;
mod chunking;
mod merge;
mod preprocess;
mod probe;
mod quality;
mod reassemble;

// 子模块项重导出（pub(crate) 让 ocr/mod.rs 的 glob use 和 tests.rs 都能访问）
#[allow(unused_imports)]
pub(crate) use binarize::{otsu_binarize_to_temp_png, otsu_binarize_upscaled_to_temp_png};
#[allow(unused_imports)]
pub(crate) use chunking::{split_long_image_for_ocr, find_aligned_cut, remap_blocks_to_global, ChunkInfo};
#[allow(unused_imports)]
pub(crate) use merge::{merge_ocr_results_horizontal, lcs_similarity};
#[allow(unused_imports)]
pub(crate) use preprocess::{preprocess_for_ocr, luma_contrast_score, clahe_global};
#[allow(unused_imports)]
pub(crate) use probe::{get_ocr_caps, compute_ocr_cap, parse_probe_json, OcrEngineCapabilities, OCR_FALLBACK_LANGS, OCR_CAPS, ocr_startup_probe};
#[allow(unused_imports)]
pub(crate) use quality::{rerun_if_garble_detected, detect_ocr_garble_score, consensus_merge};
#[allow(unused_imports)]
pub(crate) use reassemble::{reassemble_words_to_lines, postprocess_fullwidth_symbols, attach_heuristic_confidence, join_words_for_line, normalize_block_text, WinWord, is_cjk_or_fullwidth, is_latin_or_digit};

/// 带超时地运行子进程并等待退出（纯 std 实现，不引入 wait-timeout / tokio 依赖）。
///
/// 语义与 `Command::output()` 一致（返回 `Output { status, stdout, stderr }`），
/// 但保证在 `timeout` 内必然返回：超时则 kill 子进程并返回
/// `io::ErrorKind::TimedOut`。此前直接用 `.output()` 无超时——WinRT OCR 偶发
/// 死锁/挂起时，`invoke('ocr_image')` 永不 resolve，前端 `ocrBusy` 永久为 true，
/// 用户只能强杀应用。
///
/// stdout/stderr 各用独立线程读到 EOF，避免管道缓冲区写满导致子进程阻塞在输出上
/// （OCR 结果 JSON 可能很大，超过默认管道缓冲）。
#[cfg(any(target_os = "windows", test))]
fn run_command_with_timeout(
    cmd: &mut std::process::Command,
    timeout: std::time::Duration,
) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    use std::process::Stdio;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let mut stdout_pipe = child.stdout.take().expect("stdout 已设为 piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr 已设为 piped");
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });
    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(s) => break s,
            None => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait(); // 回收，避免僵尸进程
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!("OCR 子进程超时（超过 {} 秒）", timeout.as_secs()),
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    };
    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    Ok(std::process::Output { status, stdout, stderr })
}

#[cfg(target_os = "windows")]
fn run_native_ocr(path: &std::path::Path, lang: Option<&str>) -> Result<OcrResult, String> {
    run_native_ocr_windows(path, lang, None)
}

#[cfg(any(target_os = "windows", test))]
#[allow(dead_code)]
pub(crate) fn run_native_ocr_windows(
    path: &std::path::Path,
    lang: Option<&str>,
    raw_bytes: Option<&[u8]>,
) -> Result<OcrResult, String> {
    // 触发一次 WinRT 引擎能力探测（#35+#38, 2026-07-23）：
    //   [OcrEngine]::MaxImageDimension + AvailableRecognizerLanguages 缓存到 OnceLock。
    // 后续 preprocess / 语言回退都读缓存，不重复枚举 PS（省 1~2s）。
    let _ = get_ocr_caps();

    // ---- 切块决策（2026-07-22 加）：长截图 (长边 > 3000) 切 2 块走投票 ----
    // WinRT OcrEngine 对极大图块有"中心抑制"——边缘 1/3 区域文字召回率骤降。
    // 切 2 块后每块长边都 < 3000 + 50% 重叠，去重投票后召回率提升 20%+。
    //
    // 重要（P0#1+#2+#3, 2026-07-22）：切块决策跑在原图上；子图先做同样的
    // preprocess_for_ocr 再调 PS（之前直接调 PS 跳过了 CLAHE + 2x 上采样，
    // 同图切块路径质量反而比不切块差）；合并时用子图的归一化坐标 +
    // 子图相对原图的归一化 offset，把所有 word 重新映射到原图全局坐标
    // 再去重（之前两个子图各自归一化，重叠区外完全失效）。
    if let Some(chunks) = split_long_image_for_ocr(path, 3000) {
        clog!(
            "ocr",
            "CHUNK: 检测到长截图（长边 > 3000），切 {} 块分别 OCR + 子图预处理",
            chunks.len()
        );
        let mut results: Vec<OcrResult> = Vec::with_capacity(chunks.len());
        for (i, chunk) in chunks.iter().enumerate() {
            clog!(
                "ocr",
                "CHUNK: 识别第 {}/{} 块 (子图预后) {:?} offset_norm=({:.3},{:.3}) size=({},{})",
                i + 1,
                chunks.len(),
                chunk.path,
                chunk.norm_offset_x,
                chunk.norm_offset_y,
                chunk.sub_w,
                chunk.sub_h
            );
            let mut r = run_native_ocr_windows_inner(&chunk.path, lang, None)?;
            // 把子图 word 坐标重新映射到原图全局坐标
            remap_blocks_to_global(&mut r.blocks, chunk);
            results.push(r);
            // 用完即删临时切块文件
            let _ = std::fs::remove_file(&chunk.path);
        }
        // 合并去重（现在所有 block 都在原图全局坐标空间里）
        // zip chunks 拿真实切线位置 + 切轴方向传给 merge 第三关（#37 让切线不再恒为 0.5）
        let mut iter = chunks.iter().zip(results);
        let (_first_chunk, first) = iter.next().unwrap();
        let merged = iter.fold(first, |acc, (chunk, next)| {
            merge_ocr_results_horizontal(acc, next, chunk.cut_norm, chunk.is_w_split)
        });
        return rerun_if_garble_detected(merged, raw_bytes, lang);
    }

    let primary = run_native_ocr_windows_inner(path, lang, None)?;
    rerun_if_garble_detected(primary, raw_bytes, lang)
}

#[cfg(any(target_os = "windows", test))]
fn run_native_ocr_windows_inner(
    path: &std::path::Path,
    lang: Option<&str>,
    raw_bytes: Option<&[u8]>,
) -> Result<OcrResult, String> {
    use std::process::Command;

    let started = std::time::Instant::now();
    // 如果 caller 提供了原图字节，对原图做 Otsu 自适应二值化（Layer 1-A）并替换 path。
    // 二值化对中英混排 + 抗锯齿截图的字符分离效果远好于固定阈值灰度。
    // 失败回退到 caller 给的 path（caller 通常是预处理后 PNG）。
    let effective_path: std::path::PathBuf = if let Some(bytes) = raw_bytes {
        match otsu_binarize_to_temp_png(bytes) {
            Ok(p) => p,
            Err(e) => {
                clog!(
                    "ocr",
                    "INNER: Otsu 二值化失败 err={} → 沿用 caller path={:?}",
                    e,
                    path
                );
                path.to_path_buf()
            }
        }
    } else {
        path.to_path_buf()
    };
    let img_path = effective_path.to_string_lossy().to_string();
    let lang_arg = lang.unwrap_or("").to_string();
    clog!(
        "ocr",
        "→ Windows WinRT OCR: 识别 {} lang={:?}",
        img_path,
        lang_arg
    );
    // 用 sidecar 文件传路径与语言参数（避免字符串插值受特殊字符影响）
    let dir = std::env::temp_dir();
    let uid = uuid::Uuid::new_v4();
    let ps1_path = dir.join(format!("snapcraft-ocr-{}.ps1", uid));
    let arg_path = dir.join(format!("snapcraft-ocr-{}.args.txt", uid));
    // arg 文件三行：第 1 行=图片绝对路径，第 2 行=语言代码（可空），
    //   第 3 行=BCP-47 回退列表（逗号分隔，#36 2026-07-23 注入）。
    // 加 UTF-8 BOM——PS 5.1 的 Get-Content -Encoding UTF8 在无 BOM 时会走 ANSI 回退启发式，
    // 用户目录含中文（例：C:\Users\张三\AppData\Local\Temp\）时会解码错误。
    // 加了 BOM 就 100% 走 UTF-8 解析路径，与 .ps1 脚本一致的双保险。
    let fallback_langs = OCR_FALLBACK_LANGS.join(",");
    let arg_text = format!("{}\n{}\n{}\n", img_path, lang_arg, fallback_langs);
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
    # BCP-47 fallback list injected from Rust (P1#36, 2026-07-23): comna-separated
    # tags in $argLines[2]. CJK-first to avoid English engine reading CJK page
    # (the exact "incomplete + garbled" symptom). Overrides the old hardcode.
    $fallbackStr = if ($argLines.Count -ge 3) { $argLines[2] } else { '' }
    $fallbackList = @()
    if ($fallbackStr -ne '') { $fallbackList = $fallbackStr -split ',' }

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
    $tries += $fallbackList
    foreach ($tag in $tries) {
        if ([string]::IsNullOrEmpty($tag)) { continue }
        # P1#8 (2026-07-22) 诊断：哪些 try 了？哪些 IsLanguageSupported=false 跳过了？
        # 用户显式 lang 但所有 try 都失败时会直接 NO_OCR_ENGINE —— 这条
        # 日志是"我的 lang 参数被吃了吗"的关键证据。
        $supported_here = [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported(
            [Windows.Globalization.Language]::new($tag)
        )
        [Console]::Error.WriteLine("DIAG_TRY: trying tag=$tag IsLanguageSupported=$supported_here")
        try {
            $l = [Windows.Globalization.Language]::new($tag)
            if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($l)) {
                $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($l)
                if ($engine -ne $null) {
                    $chosenTag = $tag
                    [Console]::Error.WriteLine("DIAG_TRY: SUCCESS tag=$tag")
                    break
                }
            }
        } catch {}
    }
    # P1#8 (2026-07-22): 用户显式指定 lang 但 IsLanguageSupported 全 false 时
    # 不再走 user-profile 兜底。直接 NO_OCR_ENGINE 让用户感知"我请求的
    # 语言不支持"，而不是被静默替换成"机器默认"造成识别错位。
    if ($engine -eq $null -and $langCode -eq '') {
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

    # ⚠️ 血泪铁律（2026-07-22 修）：赋值必须用 `$var = ...`，绝不能写 Rust 风格 `let var = ...`。
    # 之前 `let result = AwaitT(...)` 写成 Rust 风格 → PS 5.1 不识别 `let` 关键字 →
    # catchall 报 "无法将 let 项识别为 cmdlet" → OCR 全部失败。PowerShell 7 (pwsh) 才支持
    # `let` 关键字，本项目强制用 PowerShell 5.1 (powershell.exe)，见 build.rs/win/build.yml。
    # 提交前必须 grep 这一行附近的 `let ` 关键字。
    $result = AwaitT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $iw = $bitmap.PixelWidth
    $ih = $bitmap.PixelHeight
    # TextAngle 是 IReference<double>（不是 enum）。当 null 或接近 0 时无旋转。
    # PS 5.1 把 IReference<double> 转 string 时有的 build 返 "Straight" 字面量，
    # 有的返 "0" 字符串，统一归一化到 double 安全比较。
    $rawAngle = "$($result.TextAngle)"
    $textAngle = 0.0
    if ($rawAngle -eq 'Straight' -or $rawAngle -eq '' -or $rawAngle -eq $null) {
        $textAngle = 0.0
    } else {
        try { $textAngle = [double]$rawAngle } catch { $textAngle = 0.0 }
    }
    [Console]::Error.WriteLine("DIAG_IMG: pixel=${iw}x${ih} format=$($bitmap.BitmapPixelFormat) alpha=$($bitmap.BitmapAlphaMode) text_angle=${textAngle}deg (raw=$rawAngle)")

    # P1#7 (2026-07-22): 旋转校正。
    # TextAngle 是顺时针旋转角度（0 表示无旋转）。90/-90/180 等明显旋转时
    # OcrEngine 会把整段文字读成乱码。用 BitmapTransform.Rotate 校正后重跑。
    # 重跑失败时静默回退到原结果。最多重跑 1 次（防卡死/死循环）。
    $maxRetries = 1
    $retries = 0
    while ($retries -lt $maxRetries -and [Math]::Abs($textAngle) -ge 1.0) {
        try {
            # 角度归一化到 [0, 360)
            $norm = ($textAngle % 360.0 + 360.0) % 360.0
            $rot = $null
            # BitmapRotation 接受 Clockwise90/180/270。
            # TextAngle 是顺时针 → 直接对应；负数（逆时针）需要换算到等价顺时针值。
            if ($norm -ge 0.0 -and $norm -lt 45.0) { $rot = $null }                              # 0° → 不转
            elseif ($norm -ge 45.0 -and $norm -lt 135.0) { $rot = [Windows.Graphics.Imaging.BitmapRotation]::Clockwise90Degrees }
            elseif ($norm -ge 135.0 -and $norm -lt 225.0) { $rot = [Windows.Graphics.Imaging.BitmapRotation]::Clockwise180Degrees }
            elseif ($norm -ge 225.0 -and $norm -lt 315.0) { $rot = [Windows.Graphics.Imaging.BitmapRotation]::Clockwise270Degrees }
            else { $rot = $null }                                                                # 接近 360° → 不转
            if ($rot -ne $null) {
                $transform = [Windows.Graphics.Imaging.BitmapTransform]::new()
                $transform.Rotation = $rot
                $rotated = AwaitT ($decoder.GetSoftwareBitmapAsync(
                    [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
                    [Windows.Graphics.Imaging.BitmapAlphaMode]::Straight,
                    $transform,
                    [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
                    [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
                )) ([Windows.Graphics.Imaging.SoftwareBitmap])
                $result2 = AwaitT ($engine.RecognizeAsync($rotated)) ([Windows.Media.Ocr.OcrResult])
                $result = $result2
                $iw = $rotated.PixelWidth
                $ih = $rotated.PixelHeight
                $rawAngle2 = "$($result.TextAngle)"
                $textAngle2 = 0.0
                if ($rawAngle2 -ne 'Straight' -and $rawAngle2 -ne '') {
                    try { $textAngle2 = [double]$rawAngle2 } catch { $textAngle2 = 0.0 }
                }
                $retries += 1
                [Console]::Error.WriteLine("DIAG_ROT: 旋转校正第 ${retries}/${maxRetries} 次, 校正前 angle=${textAngle}deg → 校正后 angle=${textAngle2}deg new_size=${iw}x${ih}")
                $textAngle = $textAngle2
                if ([Math]::Abs($textAngle) -lt 1.0) { break }  # 校正完成，退出 while
            } else {
                [Console]::Error.WriteLine("DIAG_ROT: 角度 ${norm}° 接近 0/360° 跳过校正")
                break
            }
        } catch {
            [Console]::Error.WriteLine("DIAG_ROT: 旋转校正失败, 沿用原结果: $($_.Exception.Message)")
            break
        }
    }

    # Output unit changed: OcrWord (one per word) instead of OcrLine.
    # WinRT OcrLine.Text inserts ASCII spaces between every Word as visual separator,
    # producing the "x 河 里 百 炼 一" garble users reported (2026-07-22). By emitting
    # per-Word records, the Rust side reassembles them into lines with NO inserted
    # spaces - giving correct "阿里百炼" / "Microsoft Edge 的新启动" output.
    $arr = @()
    $lineIdx = 0
    foreach ($line in $result.Lines) {
        $words = $line.Words
        if ($words -eq $null -or $words.Count -eq 0) { $lineIdx++; continue }
        $wIdx = 0
        foreach ($word in $words) {
            $r = $word.BoundingRect
            $wx = [double]$r.X
            $wy = [double]$r.Y
            $ww = [double]$r.Width
            $wh = [double]$r.Height
            $arr += [pscustomobject]@{
                text        = $word.Text
                x           = $wx / [double]$iw
                y           = $wy / [double]$ih
                w           = $ww / [double]$iw
                h           = $wh / [double]$ih
                line_index  = $lineIdx
                word_index  = $wIdx
            }
            $wIdx++
        }
        $lineIdx++
    }
    # DIAG_RESULT: summarize what the engine actually saw (character class breakdown +
    # rough "garbled" heuristic). Emit BEFORE ConvertTo-Json so it lands on stderr even
    # if serialization somehow fails. Counted from the per-Word stream now (2026-07-22
    # change: per-line counting was too coarse to spot the "word with ASCII space
    # injected between every char" garble pattern).
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
    # Single-word lines with non-CJK content are a common garble pattern
    # (e.g. Chinese page misread by English engine spits out isolated 'l','I','1','o','O' etc.)
    # We now count single-char WORDS instead of lines (more sensitive to garble).
    $lineSet = @{}
    $singleWordLines = 0
    foreach ($w in $arr) {
        $li = $w.line_index
        if (-not $lineSet.ContainsKey($li)) { $lineSet[$li] = 0 }
        $lineSet[$li]++
    }
    foreach ($kv in $lineSet.GetEnumerator()) {
        if ($kv.Value -le 1) { $singleWordLines++ }
    }
    [Console]::Error.WriteLine("DIAG_RESULT: words=$($arr.Count) lines=$lineIdx chars=$totalChars cjk=$cjkCount latin=$latinCount digit=$digitCount other=$otherCount single_word_lines=$singleWordLines")

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
    // 带 60s 超时：WinRT OCR 偶发死锁时保证 invoke 必然 resolve，前端不会永久卡死。
    let ps_started = std::time::Instant::now();
    let output = run_command_with_timeout(
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &ps1_path.to_string_lossy(),
            ]),
        std::time::Duration::from_secs(60),
    );
    let ps_ms = ps_started.elapsed().as_millis();

    // 无论成败，先清理临时脚本 / 参数文件（避免 %TEMP% 堆积）
    let _ = std::fs::remove_file(&ps1_path);
    let _ = std::fs::remove_file(&arg_path);
    // 如果 effective_path 是 Otsu 二值化产物（≠ caller 传入 path），也清理
    if effective_path != path {
        let _ = std::fs::remove_file(&effective_path);
    }

    let output = output.map_err(|e| {
        let msg = e.to_string();
        clog!("ocr", "PowerShell OCR 失败: {}", msg);
        if e.kind() == std::io::ErrorKind::TimedOut {
            "Windows OCR 超时（超过 60 秒），WinRT 引擎可能无响应。请重试；若持续出现请重启应用。".to_string()
        } else if msg.contains("not found") || msg.contains("os error 2") {
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
        "WinRT OCR 返回: 退出码={:?} 总耗时={}ms (PS进程={}ms) stdout_len={} stderr_len={}",
        code,
        started.elapsed().as_millis(),
        ps_ms,
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
            || t.starts_with("DIAG_TRY:")
            || t.starts_with("DIAG_ROT:")
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
                && !t.starts_with("DIAG_TRY:")
                && !t.starts_with("DIAG_ROT:")
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

    // 解析 PowerShell 输出的归一化 JSON 数组（per-Word 粒度）。
    // WinRT OcrLine.Text 内部 word 之间自带 ASCII 空格 → "阿里百炼" 变成 "阿 里 百 炼"，
    // Rust 侧按 line_index + word_index 重排为真实行（无插入空格）。
    // PS 5.1 通过管道传数组给 ConvertTo-Json 时会把结果包裹成 `{"value":[...],"Count":N}`；
    // -InputObject 形式则输出裸数组 `[...]`。两种格式都兼容，保险起见都解析一遍。
    #[derive(serde::Deserialize)]
    struct WinWordsWrapped {
        value: Vec<WinWord>,
    }
    let words: Vec<WinWord> = if let Ok(arr) = serde_json::from_str::<Vec<WinWord>>(trimmed) {
        arr
    } else if let Ok(w) = serde_json::from_str::<WinWordsWrapped>(trimmed) {
        w.value
    } else {
        // 两种都失败，把详细错落 debug.log，让用户/开发者能贴日志排查
        let err = match serde_json::from_str::<Vec<WinWord>>(trimmed) {
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
    let blocks: Vec<OcrBlock> = reassemble_words_to_lines(words);
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
