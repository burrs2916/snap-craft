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

    let result = run_native_ocr(&tmp, lang.as_deref());
    // 无论成败都清理临时文件
    let _ = std::fs::remove_file(&tmp);

    match &result {
        Ok(r) => clog!(
            "ocr",
            "识别成功: {} 块, 共 {} 字符",
            r.blocks.len(),
            r.text.len()
        ),
        Err(e) => clog!("ocr", "识别失败: {}", e),
    }
    result
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
#[cfg(target_os = "windows")]
fn run_native_ocr(path: &std::path::Path, lang: Option<&str>) -> Result<OcrResult, String> {
    use std::process::Command;

    let started = std::time::Instant::now();
    // PowerShell 字符串里路径用正斜杠最稳，避免反斜杠转义问题
    let bmp_path = path.to_string_lossy().replace('\\', "/");
    let lang_arg = lang.unwrap_or("");
    clog!(
        "ocr",
        "→ Windows WinRT OCR: 识别 {} lang={:?}",
        bmp_path,
        lang_arg
    );

    // 通过 System.Runtime.WindowsRuntime 的 AsTask 把 WinRT IAsyncOperation 转同步等待。
    // lang 优先：用 TryCreateFromLanguage；失败/为空再退回用户语言包。
    // 输出为归一化（原点左上）JSON 数组，Rust 侧解析为 blocks。
    let ps_script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime]
$asm = [System.Reflection.Assembly]::LoadWithPartialName('System.Runtime.WindowsRuntime')
$extType = $asm.GetType('System.WindowsRuntimeSystemExtensions')
$asTask = ($extType.GetMethods() | Where-Object {{
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
}})[0]
function AwaitT($op, [Type]$rt) {{
  $task = $asTask.MakeGenericMethod($rt).Invoke($null, @($op))
  $task.Wait()
  $task.Result
}}
$engine = $null
$langCode = "{lang_arg}"
if ($langCode -ne '') {{
  try {{
    $l = [Windows.Globalization.Language]::new($langCode)
    if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($l)) {{
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($l)
    }}
  }} catch {{}}
}}
if ($engine -eq $null) {{
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}}
if ($engine -eq $null) {{ Write-Error 'NO_OCR_ENGINE'; exit 2 }}
$path = "{bmp_path}"
$file = AwaitT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
$stream = AwaitT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = AwaitT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = AwaitT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = AwaitT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()
$iw = $bitmap.PixelWidth
$ih = $bitmap.PixelHeight
$arr = @()
foreach ($line in $result.Lines) {{
  $r = $line.BoundingRect
  $arr += [pscustomobject]@{{
    text = $line.Text
    x = ($r.X / $iw)
    y = ($r.Y / $ih)
    w = ($r.Width / $iw)
    h = ($r.Height / $ih)
  }}
}}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output ($arr | ConvertTo-Json -Compress)
"#,
        lang_arg = lang_arg,
        bmp_path = bmp_path
    );

    // 必须用 Windows PowerShell 5.1（powershell.exe），不是 pwsh(PS7)——PS7 移除了 WinRT 投影。
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
        .output()
        .map_err(|e| format!("无法启动 PowerShell: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    clog!(
        "ocr",
        "WinRT OCR 返回: 退出码={:?} 耗时={}ms stderr={:?}",
        output.status.code(),
        started.elapsed().as_millis(),
        stderr.trim()
    );

    if !output.status.success() {
        if stderr.contains("NO_OCR_ENGINE") {
            return Err(
                "系统未安装可用的 OCR 语言包。请在 设置 → 时间和语言 → 语言 中\
                 为中文/英文添加「可选功能」里的文字识别组件后重试。"
                    .into(),
            );
        }
        return Err(format!("Windows OCR 失败：{}", stderr.trim()));
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
    let lines: Vec<WinLine> = match serde_json::from_str(stdout.trim()) {
        Ok(v) => v,
        Err(e) => {
            clog!("ocr", "WinRT OCR JSON 解析失败: {} raw={:?}", e, stdout.trim());
            return Err(format!("OCR 结果解析失败：{}", e));
        }
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
