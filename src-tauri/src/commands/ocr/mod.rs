use crate::store;
use serde::Serialize;
use tauri::AppHandle;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos::run_native_ocr;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod fallback;
#[cfg(any(target_os = "windows", test))]
mod windows;
#[cfg(any(target_os = "windows", test))]
use windows::*;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use fallback::run_native_ocr;
#[cfg(test)]
mod tests;

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
    // 总调用计时器：覆盖 预处理 + 切块 + PS 启动 + 解析 + 后处理。
    // 用户的"识别很慢"反馈需要这条 grep 出来。结束时打印 elapsed_ms。
    let total_started = std::time::Instant::now();
    // 构建版本号 banner —— 用户复现问题时第一眼就能确认"测的是不是新版本"。
    // 任何时候只要你看到这个 build tag 不对，就能立刻知道 binary 没刷新。
    // 用 OnceLock 避免每次 OCR 都打印（启动 + 首次调用各一次就够）。
    use std::sync::OnceLock;
    static BUILD_BANNER: OnceLock<()> = OnceLock::new();
    BUILD_BANNER.get_or_init(|| {
        clog!(
            "ocr",
            "build={} feat=切块切线对齐空白带(#37)+预处理灰度优先(#39,单通道Lanczos3快~3x)+跨块长行拼接(#34)+动态MaxImageDimension探测缓存(#35+#38)+BCP-47多语言回退(#36)+Layer1-A/2/3治本+通用多pass共识引擎(consensus,几何对齐+多数投票,不修字面)+诊断日志补全(CUTLINE/PRE阶段耗时)",
            crate::BUILD_TAG
        );
    });
    clog!(
        "ocr",
        "命令=ocr_image data_url 长度={} 前缀={} lang={:?}",
        image_data.len(),
        image_data.chars().take(30).collect::<String>(),
        lang
    );
    // 先把 data URL 落地成临时 PNG，两个平台的原生 OCR 都从文件路径读入最稳。
    let raw_bytes = store::data_url_to_bytes(&image_data).map_err(|e| {
        clog!("ocr", "解码 data_url 失败: {}", e);
        format!("解码图片数据失败: {}", e)
    })?;

    // 图像预处理（仅 Windows 路径生效；macOS Apple Vision 走系统级 Accurate 引擎，
    // 自身已有自适应降采样，再 upsample 反而引入锯齿）。WinRT OcrEngine 在小图（短边
    // < 1200px）上 CJK 召回率明显下降，2x 上采样后 CJK 召回率提升 15-25%。
    // 上采样阈值 / 锐化强度参考了 2026-07-21~22 Windows OCR 复盘：
    //   - 长边 < 2400 时按 2x 上采样（Lanczos3 + 轻度 unsharp 锐化）
    //   - 灰度化：黑白截图 / 高对比 UI 截图能让 OcrEngine 减少拉丁 / 数字 / 汉字的误判
    //   - 整图 < 64x64（菜单图标 / 极小截图）跳过预处理，避免无意义放大糊
    #[cfg(any(target_os = "windows", test))]
    let bytes = preprocess_for_ocr(raw_bytes.clone());
    #[cfg(not(any(target_os = "windows", test)))]
    let bytes = raw_bytes;

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

    // 平台分发：macOS 走 Vision（无兜底原图逻辑）；Windows 走翻车自检 + 原图兜底。
    // 拆 dispatch 而不是改 run_native_ocr 签名：避免 macOS 路径被波及（Vision 不需要
    // raw_bytes，CLAHE 那些也跳过）。
    #[cfg(target_os = "windows")]
    let result = run_native_ocr_windows(&tmp, lang.as_deref(), Some(&raw_bytes));
    #[cfg(not(target_os = "windows"))]
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
            // 置信度分布：avg/min/max/stddev —— 前端"低置信度行过滤"和
            // 用户"识别质量主观感受"调试都需要这条。confidence=0 表示未提供
            // （macOS Vision 走系统 0-1 分，Windows 走启发式 0.5-0.98）。
            if !r.blocks.is_empty() {
                let confs: Vec<f64> = r.blocks.iter().map(|b| b.confidence).collect();
                let n = confs.len() as f64;
                let avg = confs.iter().sum::<f64>() / n;
                let min_c = confs.iter().cloned().fold(f64::INFINITY, f64::min);
                let max_c = confs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let var = confs.iter().map(|c| (c - avg).powi(2)).sum::<f64>() / n;
                let stddev = var.sqrt();
                let low_count = confs.iter().filter(|c| **c < 0.6).count();
                clog!(
                    "ocr",
                    "置信度分布: avg={:.3} min={:.3} max={:.3} stddev={:.3} 低置信度块(<0.6)={}/{}",
                    avg,
                    min_c,
                    max_c,
                    stddev,
                    low_count,
                    confs.len()
                );
            }
            // 触发建议：CJK 少 + Latin 多 + 单字符行占比高 → 引擎语言错配
            if r.blocks.len() >= 5 {
                let sr = single_char_lines as f64 / r.blocks.len() as f64;
                if cjk == 0 && latin > 20 && sr > 0.3 {
                    clog!("ocr", "SUGGEST: 大量单字符 Latin 块可能是「英文 OCR 引擎误识别中文页面」造成的乱码。当前脚本已优先尝试 zh-Hans-CN；若仍失败，请在「设置 → 时间和语言 → 语言」为中文添加「光学字符识别」组件。");
                } else if sr > 0.5 {
                    clog!("ocr", "SUGGEST: 单字符块占比 {:.0}% > 50%，可能是图像太糊/字号太小/字体渲染子像素抗锯齿导致识别不稳定。Rust 端已自动 2x 上采样 → 若仍不达标，请检查截图原始 DPI 或换用「窗口截图」模式（直接拿到原生高分图）。", sr * 100.0);
                } else if cjk + latin < other / 2 {
                    clog!("ocr", "SUGGEST: other（标点/全角符号/不可识别字符）占比偏高（cjk={} latin={} other={}），常见根因是 WinRT OcrEngine 把全角符号错映射成 Latin。若效果不理想，可考虑改用云端 OCR 兜底（P1 路线）。", cjk, latin, other);
                }
            }
        }
        Err(e) => clog!("ocr", "识别失败: {}", e),
    }
    // 总耗时：覆盖 预处理 + 切块 + PS + 解析 + 后处理。
    // 用户反馈"识别很慢"时一行 grep 就能定位是不是 PS 启动慢（>1s）。
    clog!(
        "ocr",
        "← ocr_image 完成: 总耗时={}ms 结果={}",
        total_started.elapsed().as_millis(),
        if result.is_ok() { "OK" } else { "ERR" }
    );
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