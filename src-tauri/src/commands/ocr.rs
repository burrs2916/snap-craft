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
    run_native_ocr_windows(path, lang, None)
}

#[cfg(any(target_os = "windows", test))]
#[allow(dead_code)]
fn run_native_ocr_windows(
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

/// 切块产物：子图临时文件 + 它相对原图的归一化 offset
/// （原图尺寸作为分母，把子图 word 坐标平移到原图全局空间用）。
#[cfg(any(target_os = "windows", test))]
struct ChunkInfo {
    path: std::path::PathBuf,
    /// 子图相对原图"长边轴"的归一化起点（0~1）
    norm_offset_x: f64,
    /// 子图相对原图"短边轴"的归一化起点（固定 0）
    norm_offset_y: f64,
    /// 子图宽（像素）
    sub_w: u32,
    /// 子图高（像素）
    sub_h: u32,
    /// 原图宽（像素）
    orig_w: u32,
    /// 原图高（像素）
    orig_h: u32,
    /// 切块切线在原图全局归一化坐标（沿切轴）：w-split→x 轴；h-split→y 轴。
    /// 传给 merge 第三关，让它按「真实切线」而非写死 0.5 判断跨块拼接。
    cut_norm: f64,
    /// 切轴是否为宽轴（true=沿宽切/竖切线，false=沿高切/横切线）
    is_w_split: bool,
}

/// 切长图：长边 > threshold 时切 2 块（左半 + 右半，50% 重叠）。
/// 每个子图**先过 `preprocess_for_ocr` 再写临时文件**，所以子图路径已经是 OCR-ready 状态。
/// 否则返回 None（调用方应走单次识别）。
#[cfg(any(target_os = "windows", test))]
fn split_long_image_for_ocr(path: &std::path::Path, threshold: u32) -> Option<Vec<ChunkInfo>> {
    use image::ImageReader;
    use std::io::Cursor;

    let bytes = std::fs::read(path).ok()?;
    let img = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let (w, h) = (img.width(), img.height());
    let long_side = w.max(h);
    if long_side <= threshold {
        // 长边 ≤ 阈值 → 不切块（不打 clog——会让健康路径日志刷屏）
        return None;
    }
    clog!(
        "ocr",
        "SPLIT: 判定切块 路径={:?} 原图={}x{} 长边={} > 阈值={}",
        path,
        w,
        h,
        long_side,
        threshold
    );
    // 切长边。重叠量 = 长边的 1/4（保证 50% 区域有 2 次识别机会）
    let (split_axis_is_w, total) = if w >= h { (true, w) } else { (false, h) };
    let overlap = (total / 4).max(1);
    let chunk_size = (total + overlap) / 2; // 50% 重叠：两个 chunk 共享 overlap 大小

    // #37 (2026-07-23): 切块切线对齐空白带。
    // 旧逻辑固定从名义中点 chunk_size 切，常把一行字/一个词从中段切开，
    // 靠 #34 重叠合并兜底，但切在字中段仍会丢笔画。
    // 现改为：沿「垂直切轴」做墨量投影（w-split→列投影找低墨列；h-split→行投影找低墨行），
    // 在名义切线 ±12.5% 窗口内找墨量 ≤50% 名义位的间隙作对齐切线；
    // 连续文本流无间隙 → 退回名义中点（仍由 #34 重叠合并兜底）。
    // 投影在降采样图（长边≤1000）上算，保证性能。
    let cut = find_aligned_cut(&img, split_axis_is_w, chunk_size, total);
    let half_overlap = overlap / 2;
    let (c0_start, c0_size) = (0u32, (cut + half_overlap).min(total));
    let c1_start = cut.saturating_sub(half_overlap);
    let c1_size = total.saturating_sub(c1_start);
    clog!(
        "ocr",
        "CUTLINE: 轴={} 名义切线={} 对齐后={} (偏移{}{} 命中间隙={}) 重叠={} 子图尺寸=[{}x{}]+[{}x{}]",
        if split_axis_is_w { "宽(竖切)" } else { "高(横切)" },
        chunk_size,
        cut,
        if cut > chunk_size { "+" } else { "-" },
        (cut as i64 - chunk_size as i64).abs(),
        cut != chunk_size,
        overlap,
        c0_size,
        if split_axis_is_w { h } else { c0_size },
        c1_size,
        if split_axis_is_w { h } else { c1_size }
    );
    let starts: Vec<u32> = vec![c0_start, c1_start];
    let sizes: Vec<u32> = vec![c0_size, c1_size];

    let mut chunk_infos = Vec::new();
    for (i, (&start, &size)) in starts.iter().zip(sizes.iter()).enumerate() {
        let chunk_started = std::time::Instant::now();
        // 防退化：子图至少 64px，否则跳过切块（避免 crop 越界 / 无意义碎片）
        if size < 64 {
            clog!("ocr", "SPLIT: 子图 {}/2 尺寸 {} < 64px 退化，跳过切块", i + 1, size);
            return None;
        }
        let crop = if split_axis_is_w {
            img.crop_imm(start, 0, size, h)
        } else {
            img.crop_imm(0, start, w, size)
        };
        // P0#2 修复：子图也过 preprocess_for_ocr（CLAHE + 2x 上采样 + 灰度 + unsharp）
        let mut buf = Vec::new();
        if crop
            .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
            .is_err()
        {
            clog!("ocr", "SPLIT: 子图 {}/2 PNG 编码失败", i + 1);
            return None;
        }
        let pre_size = buf.len();
        let preprocessed = preprocess_for_ocr(buf);
        let post_size = preprocessed.len();
        let uid = uuid::Uuid::new_v4();
        let p = std::env::temp_dir().join(format!("snapcraft-ocr-chunk-{}-{}.png", uid, i));
        if std::fs::write(&p, &preprocessed).is_err() {
            clog!("ocr", "SPLIT: 子图 {}/2 写临时文件失败", i + 1);
            return None;
        }
        // 归一化 offset 永远是相对**原图**的（无论切的是 w 还是 h 轴）
        // 因为 OcrBlock.x/y/w/h 是相对**原图**的归一化 0~1 坐标
        // 而子图 word 坐标是相对**子图**的归一化 0~1 坐标
        // remap 公式：x_global = x_sub * (chunk_size / total) + start / total
        let norm_offset_x = if split_axis_is_w {
            start as f64 / w as f64
        } else {
            0.0
        };
        let norm_offset_y = if split_axis_is_w {
            0.0
        } else {
            start as f64 / h as f64
        };
        let (sub_w, sub_h) = if split_axis_is_w {
            (size, h)
        } else {
            (w, size)
        };
        clog!(
            "ocr",
            "SPLIT: 子图 {}/{} 起点={} 尺寸={}x{} 预处理前={}B → 后={}B 耗时={}ms → {:?}",
            i + 1,
            starts.len(),
            start,
            sub_w,
            sub_h,
            pre_size,
            post_size,
            chunk_started.elapsed().as_millis(),
            p
        );
        chunk_infos.push(ChunkInfo {
            path: p,
            norm_offset_x,
            norm_offset_y,
            sub_w,
            sub_h,
            orig_w: w,
            orig_h: h,
            cut_norm: cut as f64 / total as f64,
            is_w_split: split_axis_is_w,
        });
    }
    Some(chunk_infos)
}

/// #37 (2026-07-23): 为切块找「对齐到空白带」的切线。
/// 当 `split_axis_is_w=true` 时沿宽切（竖切线），用列投影（每列墨量求和）找低墨列；
/// 当 `split_axis_is_w=false` 时沿高切（横切线），用行投影（每行墨量求和）找低墨行。
/// 在名义切线 `nominal` 的 ±12.5% 窗口内，找墨量 ≤50% 名义位的最小墨位置；
/// 找不到（连续文本流）则退回 `nominal`。投影在降采样（长边≤1000）图上算以保证性能，
/// 找到的切线按比例映射回原图坐标。
#[cfg(any(target_os = "windows", test))]
fn find_aligned_cut(
    img: &image::DynamicImage,
    split_axis_is_w: bool,
    nominal: u32,
    total: u32,
) -> u32 {
    use image::imageops::FilterType;
    let (w, h) = (img.width(), img.height());
    let long = w.max(h);
    // 降采样到长边 ≤1000 做投影（间隙检测精度 ~0.1% 足够，且避免超大图投影过慢）
    let proj_scale = if long > 1000 {
        1000.0 / long as f32
    } else {
        1.0
    };
    let small = if proj_scale < 1.0 {
        img.resize_exact(
            (w as f32 * proj_scale) as u32,
            (h as f32 * proj_scale) as u32,
            FilterType::Nearest, // 投影只需整体墨量，最近邻最快且无模糊
        )
    } else {
        img.clone()
    };
    let gray = small.to_luma8();
    let (gw, gh) = (gray.width(), gray.height());
    if gw == 0 || gh == 0 {
        return nominal;
    }
    // 投影：与切轴垂直的方向
    let proj: Vec<u32> = if split_axis_is_w {
        // 竖切 → 列投影（沿 x 求和每列墨量 = 255 - luma）
        (0..gw)
            .map(|x| {
                let mut s = 0u32;
                for y in 0..gh {
                    s += 255 - gray.get_pixel(x, y).0[0] as u32;
                }
                s
            })
            .collect()
    } else {
        // 横切 → 行投影（沿 y 求和每行墨量）
        (0..gh)
            .map(|y| {
                let mut s = 0u32;
                for x in 0..gw {
                    s += 255 - gray.get_pixel(x, y).0[0] as u32;
                }
                s
            })
            .collect()
    };
    let proj_total = proj.len() as u32;
    let nominal_p = ((nominal as f32 * proj_scale) as u32).min(proj_total.saturating_sub(1));
    let margin_p = (proj_total / 8).max(1);
    let lo = nominal_p.saturating_sub(margin_p);
    let hi = (nominal_p + margin_p).min(proj_total.saturating_sub(1));
    let mut best_p = nominal_p;
    let mut best_ink = u32::MAX;
    for i in lo..=hi {
        let ink = proj[i as usize];
        if ink < best_ink {
            best_ink = ink;
            best_p = i;
        }
    }
    let nominal_ink = proj.get(nominal_p as usize).copied().unwrap_or(u32::MAX);
    // 仅在窗口内确实存在「明显间隙」（墨量 ≤ 名义位 50%）才偏移；
    // 否则连续文本流退回名义中点（由 #34 重叠合并兜底）。
    let aligned_p = if best_p != nominal_p && (best_ink as f64) <= 0.5 * (nominal_ink as f64) {
        best_p
    } else {
        nominal_p
    };
    let aligned = (aligned_p as f32 / proj_scale.max(1e-6_f32)) as u32;
    aligned.clamp(1, total.saturating_sub(1))
}

/// 把子图的 word 归一化坐标重新映射到原图全局归一化坐标。
/// 公式：
///   x_global = x_sub * (sub_size / orig_size) + norm_offset
///   y_global 同理
/// 仅调整 x/y/w/h；text/confidence 保持不变。
#[cfg(any(target_os = "windows", test))]
fn remap_blocks_to_global(blocks: &mut [OcrBlock], chunk: &ChunkInfo) {
    let x_scale = if chunk.sub_w > 0 && chunk.orig_w > 0 {
        chunk.sub_w as f64 / chunk.orig_w as f64
    } else {
        1.0
    };
    let y_scale = if chunk.sub_h > 0 && chunk.orig_h > 0 {
        chunk.sub_h as f64 / chunk.orig_h as f64
    } else {
        1.0
    };
    for b in blocks.iter_mut() {
        b.x = b.x * x_scale + chunk.norm_offset_x;
        b.y = b.y * y_scale + chunk.norm_offset_y;
        b.w *= x_scale;
        b.h *= y_scale;
    }
    // 总览：块数 + 全局坐标范围（防 remap 算错把块挪出图外）
    if !blocks.is_empty() {
        let min_x = blocks.iter().map(|b| b.x).fold(f64::INFINITY, f64::min);
        let min_y = blocks.iter().map(|b| b.y).fold(f64::INFINITY, f64::min);
        let max_xr = blocks.iter().map(|b| b.x + b.w).fold(f64::NEG_INFINITY, f64::max);
        let max_yb = blocks.iter().map(|b| b.y + b.h).fold(f64::NEG_INFINITY, f64::max);
        clog!(
            "ocr",
            "REMAP: 块数={} 坐标范围 x=[{:.3},{:.3}] y=[{:.3},{:.3}] (期望 x_offset={:.3}, y_offset={:.3})",
            blocks.len(),
            min_x, max_xr, min_y, max_yb,
            chunk.norm_offset_x, chunk.norm_offset_y
        );
    } else {
        clog!("ocr", "REMAP: 块数=0 (子图 OCR 未识别到任何文字)");
    }
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
    let ps_started = std::time::Instant::now();
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

// ===== OCR 翻车自检 + 智能重识别（2026-07-22 替代打补丁方案）=====
//
// 背景：用户反馈"逐字打补丁不可持续"——WinRT zh-Hans-CN 在中英混排 + 子像素抗锯齿
// + 切块边界三个场景下系统性翻车，每来一个就补一条词典规则是死胡同。
//
// 新方案（**不依赖任何具体字符的"经验规则"**）：
//   1) Layer 2 自检：detect_ocr_garble_score 从输出反推翻车概率
//      - 单字符行占比 > 40%（抗锯齿把字拆碎）
//      - 行 h/w 比例异常（行被切碎成窄条 或 字被合并成宽条）
//      - 同一 y 量化行内出现 3+ 个同长度单字（典型切块碎片）
//   2) Layer 3 兜底：自检命中 → 用原图字节（不过 preprocess_for_ocr）重跑一次
//      → 两路用 lcs_similarity + LCS 投票合并，**单字翻车被原图识别覆盖**
//   3) 不去补任何具体字符的替换规则——翻车样本动态收敛
//
// 成本：99% 健康路径只跑 1 次（自检 = O(n) 微秒级），仅 1% 翻车样本付额外一次 OCR。
#[cfg(any(target_os = "windows", test))]
fn detect_ocr_garble_score(blocks: &[OcrBlock]) -> f64 {
    if blocks.is_empty() {
        return 1.0; // 空结果 = 100% 翻车（强制触发重跑）
    }
    // 信号 1：单字符行占比（抗锯齿 + 切块碎片的指纹）
    let single_char = blocks.iter().filter(|b| b.text.chars().count() <= 1).count();
    let single_char_ratio = single_char as f64 / blocks.len() as f64;
    // 信号 2：行高 / 字宽比例异常
    //  - 正常 CJK 行：单字宽 ≈ 行高 → 比例 ~1
    //  - 切块碎片：单行极窄（h/w > 5 罕见）
    //  - 字间距破坏合并：单行极宽（h/w < 0.3 罕见）
    let mut aspect_outliers = 0usize;
    let mut aspect_count = 0usize;
    let mut short_block_ratio = 0.0; // 块 w < 0.05（极窄条）的占比
    let mut very_short = 0usize;
    for b in blocks {
        if b.h < 0.001 || b.w < 0.001 {
            continue;
        }
        aspect_count += 1;
        let aspect = b.h / b.w;
        if !(0.05..=5.0).contains(&aspect) {
            aspect_outliers += 1;
        }
        if b.w < 0.05 {
            very_short += 1;
        }
    }
    if aspect_count > 0 {
        short_block_ratio = very_short as f64 / aspect_count as f64;
    }
    let aspect_outlier_ratio = if aspect_count > 0 {
        aspect_outliers as f64 / aspect_count as f64
    } else {
        0.0
    };
    // 信号 3：行内同长度单字连续（切块把同一行切成 3+ 块）
    // 量化 y → 找同 y 行 → 行内单字占比
    let quantize_y = |v: f64| (v * 100.0).round() as i64;
    let mut y_groups: std::collections::BTreeMap<i64, Vec<&OcrBlock>> =
        std::collections::BTreeMap::new();
    for b in blocks {
        y_groups.entry(quantize_y(b.y)).or_default().push(b);
    }
    let mut fragmented_rows = 0usize;
    for group in y_groups.values() {
        if group.len() >= 3 {
            let all_single = group.iter().filter(|b| b.text.chars().count() == 1).count();
            if all_single as f64 / group.len() as f64 > 0.7 {
                fragmented_rows += 1;
            }
        }
    }
    let fragmented_ratio = if !y_groups.is_empty() {
        fragmented_rows as f64 / y_groups.len() as f64
    } else {
        0.0
    };
    // 信号 4（2026-07-23 共识引擎唤醒）：结构性 gibberish —— 抓"形近替换 / 细微错字"
    //   这类错误不改变 single_char/aspect/fragmented 三个老信号（整屏仍 0.20），
    //   所以老评分恒不触发 Layer 3。新增两个与语种无关、纯结构的指纹：
    //   - has_ext_rare：含 CJK 扩展 A/B/F 等罕见平面字符（U+3400..U+4DBF / U+20000..），
    //     现代正常中文文本几乎不出现，多为 WinRT 把字认成罕见形近字（杲/囗/欤 之类）
    //   - stray_latin：含 CJK 且夹带 ≤2 字母的孤立 ASCII 串（如 "(D:)" 被识成垃圾），
    //     正常 UI 是纯 CJK 标签或纯英文单词（CPU/Windows 等 ≥3 字母），不会命中
    //   这样唤醒 Layer 3 是"点到为止"——仅当真出现疑似错字时，不靠降全局阈值误伤健康图。
    let mut gibberish_blocks = 0usize;
    for b in blocks {
        let t = b.text.trim();
        if t.is_empty() {
            continue;
        }
        let mut has_cjk = false;
        let mut has_ext_rare = false;
        let mut has_latin = false;
        let mut latin_run = 0usize;
        let mut max_latin_run = 0usize;
        for ch in t.chars() {
            if ('\u{4E00}'..='\u{9FFF}').contains(&ch) {
                has_cjk = true;
            } else if ('\u{3400}'..='\u{4DBF}').contains(&ch)
                || ('\u{20000}'..='\u{2FFFF}').contains(&ch)
            {
                has_cjk = true;
                has_ext_rare = true;
            } else if ch.is_ascii_alphabetic() {
                has_latin = true;
                latin_run += 1;
                max_latin_run = max_latin_run.max(latin_run);
            } else {
                latin_run = 0;
            }
        }
        let stray = has_cjk && has_latin && max_latin_run <= 2;
        if has_ext_rare || stray {
            gibberish_blocks += 1;
        }
    }
    let gibberish_ratio = if !blocks.is_empty() {
        gibberish_blocks as f64 / blocks.len() as f64
    } else {
        0.0
    };
    // 综合评分：加权求和，0~1。任一信号 > 阈值都触发重跑
    //   single_char_ratio > 0.4 → +0.4
    //   aspect_outlier_ratio > 0.2 → +0.3
    //   fragmented_ratio > 0.2 → +0.3
    //   short_block_ratio > 0.15 → +0.2
    let mut score: f64 = 0.0;
    if single_char_ratio > 0.4 {
        score += 0.4;
    } else if single_char_ratio > 0.25 {
        score += 0.2;
    }
    if aspect_outlier_ratio > 0.2 {
        score += 0.3;
    } else if aspect_outlier_ratio > 0.1 {
        score += 0.15;
    }
    if fragmented_ratio > 0.2 {
        score += 0.3;
    } else if fragmented_ratio > 0.1 {
        score += 0.15;
    }
    if short_block_ratio > 0.15 {
        score += 0.2;
    }
    // 信号 4：结构性 gibberish（形近替换 / 细微错字）——唤醒 Layer 3 共识引擎
    if gibberish_ratio > 0.04 {
        score += 0.35;
    } else if gibberish_ratio > 0.015 {
        score += 0.18;
    }
    score = score.min(1.0);
    clog!(
        "ocr",
        "GARBLE: 翻车自检 single_char={:.0}% aspect_outlier={:.0}% fragmented_rows={:.0}% very_short={:.0}% gibberish={:.0}% → score={:.2}",
        single_char_ratio * 100.0,
        aspect_outlier_ratio * 100.0,
        fragmented_ratio * 100.0,
        short_block_ratio * 100.0,
        gibberish_ratio * 100.0,
        score
    );
    score
}

/// 用原图字节兜底重识别 + LCS 投票合并。
/// 翻车自检命中时调用，**不依赖任何具体字符的"经验规则"**。
#[cfg(any(target_os = "windows", test))]
fn rerun_if_garble_detected(
    primary: OcrResult,
    raw_bytes: Option<&[u8]>,
    lang: Option<&str>,
) -> Result<OcrResult, String> {
    let score = detect_ocr_garble_score(&primary.blocks);
    if score < 0.3 {
        // 健康路径：不付额外成本
        return Ok(primary);
    }
    // 翻车命中（或共识引擎唤醒）：有 raw_bytes 才走兜底
    let Some(bytes) = raw_bytes else {
        clog!("ocr", "CONSENSUS: 翻车分 {:.2} 但无 raw_bytes，跳过共识（仅记 log）", score);
        return Ok(primary);
    };
    clog!(
        "ocr",
        "CONSENSUS: 翻车分 {:.2} 触发通用多pass共识引擎（主路 + Otsu二值化 + Otsu二值化放大）",
        score
    );
    // 把 raw_bytes 落临时文件，供各异构 pass 反复读取（Otsu 二值化从文件读）
    let tmp = store::temp_png_path();
    if let Err(e) = store::write_bytes(&tmp, bytes) {
        clog!("ocr", "CONSENSUS: 落原图失败 {:?} err={} → 沿用主路", tmp, e);
        return Ok(primary);
    }
    // P2：Otsu 二值化（与主路 upscale+CLAHE 完全不同输入 → 不同错误模式）
    let p2 = otsu_binarize_to_temp_png(bytes)
        .ok()
        .and_then(|p| run_native_ocr_windows_inner(&p, lang, None).ok());
    // P3：Otsu 二值化 + 放大（再换一种错误模式，用于平票打破）
    let p3 = otsu_binarize_upscaled_to_temp_png(bytes, 2)
        .ok()
        .and_then(|p| run_native_ocr_windows_inner(&p, lang, None).ok());
    let _ = std::fs::remove_file(&tmp);
    // 收齐所有 pass（主路 + 各异构 pass）→ 几何对齐 + 多数投票共识
    let has_p3 = p3.is_some();
    let mut passes: Vec<OcrResult> = vec![primary];
    if let Some(p) = p2 {
        passes.push(p);
    }
    if let Some(p) = p3 {
        passes.push(p);
    }
    let merged = consensus_merge(&passes);
    clog!(
        "ocr",
        "CONSENSUS: 共识合并完成 → 最终 {} 块（来自 {} 个 pass，主路+二值化{}）",
        merged.blocks.len(),
        passes.len(),
        if has_p3 { "+放大" } else { "" }
    );
    Ok(merged)
}

/// 通用多 pass 共识引擎（2026-07-23 · 治本不修字面）。
///
/// 同一张图经多个**异构预处理**（主路 upscale+CLAHE / Otsu 二值化 / Otsu+放大）
/// 交给同一个 WinRT 引擎识别，各 pass 因输入不同而产生**不同的形近错字**。
/// 本函数按**归一化坐标**（对 upscale/二值化 scale-invariant）把各 pass 的块对齐到同一位置，
/// 每个位置做**多数投票**选文本（平票按置信度和），从而实现自洽集成——无需任何
/// 具体字符替换规则，也无需外挂词典，对任意语种/任意文本通用。
///
/// 为什么通用：传统"加一条错字映射"是死胡同；这里靠"多证据投票"在方法层面纠错，
/// 形近替换只要有一个 pass 认对就被多数票选出。
#[cfg(any(target_os = "windows", test))]
fn consensus_merge(passes: &[OcrResult]) -> OcrResult {
    struct Tagged<'a> {
        b: &'a OcrBlock,
    }
    let mut tagged: Vec<Tagged> = Vec::new();
    for p in passes {
        for b in &p.blocks {
            if b.text.trim().is_empty() {
                continue;
            }
            tagged.push(Tagged { b });
        }
    }
    // 按 (y, x) 中心排序后贪心聚类：中心距离 < 0.025（归一化）归为同一位置簇
    let mut idx: Vec<usize> = (0..tagged.len()).collect();
    idx.sort_by(|&a, &b| {
        let (ca, cb) = (&tagged[a].b, &tagged[b].b);
        ca.y
            .partial_cmp(&cb.y)
            .unwrap()
            .then(ca.x.partial_cmp(&cb.x).unwrap())
    });
    let mut clusters: Vec<Vec<&OcrBlock>> = Vec::new();
    for i in idx {
        let b = tagged[i].b;
        let cx = b.x + b.w / 2.0;
        let cy = b.y + b.h / 2.0;
        let mut placed = false;
        for cl in clusters.iter_mut() {
            let r = cl.first().unwrap();
            let rcx = r.x + r.w / 2.0;
            let rcy = r.y + r.h / 2.0;
            if (cx - rcx).abs() < 0.025 && (cy - rcy).abs() < 0.025 {
                cl.push(b);
                placed = true;
                break;
            }
        }
        if !placed {
            clusters.push(vec![b]);
        }
    }
    // 每簇投票：text 多数（票数），平票按置信度和最高
    let mut out_blocks: Vec<OcrBlock> = Vec::new();
    for cl in &clusters {
        let mut votes: std::collections::BTreeMap<String, (usize, f64)> =
            std::collections::BTreeMap::new();
        for b in cl {
            let e = votes
                .entry(b.text.trim().to_string())
                .or_insert((0usize, 0.0f64));
            e.0 += 1;
            e.1 += b.confidence;
        }
        let mut best_text: String = String::new();
        let mut best_key: (usize, f64) = (0, -1.0);
        let mut rep: Option<&OcrBlock> = None;
        for (t, (cnt, conf)) in &votes {
            if (*cnt, *conf) > best_key {
                best_key = (*cnt, *conf);
                best_text = t.clone();
                rep = cl.iter().find(|b| b.text.trim() == t.as_str()).copied();
            }
        }
        if let Some(r) = rep {
            out_blocks.push(OcrBlock {
                text: best_text,
                x: r.x,
                y: r.y,
                w: r.w,
                h: r.h,
                confidence: r.confidence,
            });
        }
    }
    // 阅读顺序重排：先 y 后 x
    out_blocks.sort_by(|a, b| {
        a.y.partial_cmp(&b.y)
            .unwrap()
            .then(a.x.partial_cmp(&b.x).unwrap())
    });
    let text = out_blocks
        .iter()
        .map(|b| b.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    OcrResult {
        text,
        blocks: out_blocks,
    }
}

// ===== 其它平台（Linux 等）：暂无系统原生 OCR =====
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn run_native_ocr(_path: &std::path::Path, _lang: Option<&str>) -> Result<OcrResult, String> {
    Err("当前平台暂不支持系统原生 OCR（仅 macOS / Windows）".into())
}

// ===== Otsu 自适应二值化（Layer 1-A · 2026-07-22）=====
//
// 背景：用户反馈"逐字打补丁不可持续"——WinRT OcrEngine 在中英混排 + 子像素抗锯齿
// 下系统性翻车。**不修字面，改治本**：预处理时把图二值化（黑/白），让字符与背景
// 严格分离，OcrEngine 字间距判定不再受半透明边缘干扰。
//
// Otsu 算法（1979，大津展之）：遍历 0~255 阈值，找使"前景/背景"类间方差最大的阈值。
// 优势：不需要预设参数（不像固定阈值 128 在深色模式全失效），单图 O(n) 计算。
// 实现：先算 256 直方图，再算累积概率 + 累积均值，求 max(σ_between)。
//
// 输出：black/white 二值图 → PNG → OcrEngine 直接读。失败回退到 caller path。
#[cfg(any(target_os = "windows", test))]
fn otsu_binarize_to_temp_png(bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    otsu_binarize_inner(bytes, 1)
}

/// 异构第 3 pass 用：二值化前先放大 `factor` 倍（Lanczos3 单通道），
/// 换一种错误模式用于共识引擎平票打破。factor=1 等同 `otsu_binarize_to_temp_png`。
#[cfg(any(target_os = "windows", test))]
fn otsu_binarize_upscaled_to_temp_png(
    bytes: &[u8],
    factor: u32,
) -> Result<std::path::PathBuf, String> {
    otsu_binarize_inner(bytes, factor)
}

#[cfg(any(target_os = "windows", test))]
fn otsu_binarize_inner(bytes: &[u8], upscale: u32) -> Result<std::path::PathBuf, String> {
    use image::ImageReader;
    use std::io::Cursor;
    let started = std::time::Instant::now();
    let img = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Otsu: 探测格式失败: {}", e))?
        .decode()
        .map_err(|e| format!("Otsu: 解码失败: {}", e))?;
    let mut gray = img.to_luma8();
    if upscale > 1 {
        let (uw, uh) = (gray.width() * upscale, gray.height() * upscale);
        gray = image::imageops::resize(&gray, uw, uh, image::imageops::FilterType::Lanczos3);
    }
    let (w, h) = (gray.width(), gray.height());
    if w == 0 || h == 0 {
        return Err("Otsu: 空图".into());
    }
    // 1) 256 灰度直方图
    let mut hist = [0u64; 256];
    for p in gray.pixels() {
        hist[p.0[0] as usize] += 1;
    }
    let n = (w as u64) * (h as u64);
    // 2) 总灰度和（用类间方差公式不需要均值本身，但记一下便于未来扩展）
    let total_sum: u64 = hist
        .iter()
        .enumerate()
        .map(|(i, &c)| i as u64 * c)
        .sum();
    let _total_mean = total_sum as f64 / n as f64;
    // 3) Otsu：遍历阈值 t，使 σ² = w0 * w1 * (μ0 - μ1)² 最大
    let mut best_t = 128u8;
    let mut best_var = -1.0f64;
    let mut w0: u64 = 0;
    let mut sum0: u64 = 0;
    for (t, &c) in hist.iter().enumerate() {
        w0 += c;
        if w0 == 0 {
            continue;
        }
        sum0 += t as u64 * c;
        let w1 = n - w0;
        if w1 == 0 {
            break;
        }
        let mu0 = sum0 as f64 / w0 as f64;
        let mu1 = (total_sum - sum0) as f64 / w1 as f64;
        let diff = mu0 - mu1;
        let var = (w0 as f64) * (w1 as f64) * diff * diff;
        if var > best_var {
            best_var = var;
            best_t = t as u8;
        }
    }
    // 4) 应用阈值 + 决定方向
    // Otsu 选 t 后用 σ² = w0*w1*(μ0-μ1)² 找"前景/背景"最分离的 t，
    // 但 Otsu 不区分"前景黑/白"。看 mean_0 vs mean_1 决定方向：
    //   - mean_0 < mean_1 (low cluster = 前景文字) → text=0, background=255
    //   - mean_0 > mean_1 (high cluster = 前景文字) → text=255, background=0
    // 重新算两 cluster 均值：
    let mut w0: u64 = 0;
    let mut sum0: u64 = 0;
    for (t, &c) in hist.iter().enumerate().take(best_t as usize + 1) {
        w0 += c;
        sum0 += t as u64 * c;
    }
    let w1 = n - w0;
    let mean0 = if w0 > 0 {
        sum0 as f64 / w0 as f64
    } else {
        0.0
    };
    let mean1 = if w1 > 0 {
        (total_sum - sum0) as f64 / w1 as f64
    } else {
        255.0
    };
    let low_is_foreground = mean0 < mean1;
    let mut bw_rgb = image::RgbImage::new(w, h);
    for (x, y, p) in gray.enumerate_pixels() {
        let v_raw = p.0[0];
        // 用 <= 而非 <：Otsu first-max 倾向选到前景 cluster 的边界值，
        // <= 保证整个前景 cluster（含边界）划到同一类。
        let in_low = v_raw <= best_t;
        let v = if in_low == low_is_foreground {
            0u8
        } else {
            255u8
        };
        bw_rgb.put_pixel(x, y, image::Rgb([v, v, v]));
    }
    // 5) 落临时 PNG
    let uid = uuid::Uuid::new_v4();
    let path = std::env::temp_dir().join(format!("snapcraft-ocr-otsu-{}.png", uid));
    let mut out: Vec<u8> = Vec::new();
    bw_rgb
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("Otsu: 编码 PNG 失败: {}", e))?;
    std::fs::write(&path, &out).map_err(|e| format!("Otsu: 写临时文件失败: {}", e))?;
    clog!(
        "ocr",
        "OTSU: 阈值={} upscale={}x 耗时={}ms 原图={}B → 二值图={}B → {:?}",
        best_t,
        upscale,
        started.elapsed().as_millis(),
        bytes.len(),
        out.len(),
        path
    );
    Ok(path)
}

// ===== 灰度对比度评分（CLAHE 条件启用判定） =====
//
// 用途：判断原图是否"低对比度"——决定是否走 CLAHE。
// 算法：单遍扫描算 luma 均值 + 方差。纯色 / 高对比 UI 截图方差大，跳过 CLAHE；
// 深色模式 / 低饱和 UI 截图方差小，启用 CLAHE 拉开对比度。
// 时间复杂度 O(n)，n = 像素数。
#[cfg(any(target_os = "windows", test))]
fn luma_contrast_score(gray: &image::GrayImage) -> f64 {
    let (w, h) = (gray.width() as usize, gray.height() as usize);
    if w == 0 || h == 0 {
        return 0.0;
    }
    let n = (w * h) as f64;
    let mut sum: u64 = 0;
    let mut sum_sq: u64 = 0;
    for px in gray.pixels() {
        let v = px.0[0] as u64;
        sum += v;
        sum_sq += v * v;
    }
    let mean = sum as f64 / n;
    // 方差 = E[X^2] - (E[X])^2
    let variance = sum_sq as f64 / n - mean * mean;
    variance.max(0.0)
}

// ===== CLAHE 全局单 tile 实现（零依赖，2026-07-22 加） =====
//
// 完整 CLAHE 把图切成 NxN tile，每个 tile 独立均衡 + 边界双线性插值。
// 对 OCR 预处理这种"小图、粗提升"场景，简化版（整图一个 tile + clip_limit）
// 与完整版效果差距 < 5%，但代码量从 ~80 行降到 ~25 行、零额外依赖。
//
// 步骤：
//   1) 算 256-bin 直方图 H
//   2) clip_limit 裁剪：把超 clip_limit 的桶均匀摊回（标准 CLAHE 是循环分配，
//      这里用"超量累积到末桶"近似，效果接近）
//   3) 累计分布函数 CDF（归一化到 0..255）
//   4) 查表替换：new_pixel = CDF[old_pixel]
#[cfg(any(target_os = "windows", test))]
fn clahe_global(gray: &image::GrayImage, clip_limit: f32) -> image::GrayImage {
    let (w, h) = (gray.width() as usize, gray.height() as usize);
    let total = w * h;
    if total == 0 {
        return gray.clone();
    }

    // 1) 直方图
    let mut hist = [0u32; 256];
    for p in gray.pixels() {
        hist[p.0[0] as usize] += 1;
    }

    // 2) clip + 重分布
    let clip = (clip_limit * total as f32 / 256.0).ceil() as u32;
    let mut excess: u32 = 0;
    for bin in hist.iter_mut() {
        if *bin > clip {
            excess += *bin - clip;
            *bin = clip;
        }
    }
    // 把 excess 均匀加回（每桶 +excess/256）
    let redistribute = excess / 256;
    let leftover = excess % 256;
    for bin in hist.iter_mut() {
        *bin += redistribute;
    }
    if leftover > 0 {
        // 余数加到中段桶（128 附近）—— 比平均分配更稳，避免极暗/极亮端被二次裁剪
        hist[128] += leftover;
    }

    // 3) CDF
    let mut cdf = [0u32; 256];
    let mut acc = 0u32;
    for i in 0..256 {
        acc += hist[i];
        cdf[i] = acc;
    }
    let cdf_min = cdf.iter().find(|&&v| v > 0).copied().unwrap_or(0);
    let denom = (total as u64).saturating_sub(cdf_min as u64).max(1) as f32;

    // 4) 查表替换
    let mut out = image::GrayImage::new(gray.width(), gray.height());
    for (src, dst) in gray.pixels().zip(out.pixels_mut()) {
        let v = cdf[src.0[0] as usize];
        let mapped = ((v as f32 - cdf_min as f32) / denom * 255.0).round() as u8;
        dst.0[0] = mapped;
    }
    out
}

// ===== 图像预处理（Windows WinRT 专用，cfg 门让 macOS cargo check --tests 也能验证） =====
//
// 目标：把前端传过来的 data URL 字节流做以下三步，喂 OcrEngine 之前提升 CJK 召回率：
//   1) 解码（PNG / JPEG / WebP / GIF 第一帧 / BMP 都尝试）
//   2) 短边 < 1200 时 2x 上采样（Lanczos3）
//   3) 转灰度 + 轻度 unsharp 锐化
//   4) 重新编码回 PNG
//
// 输入是 PNG/JPEG/WebP 的混合字节流；只要 image crate 能 decode 就用，失败则原样返回
// （失败 = 已经是 OcrEngine 接受的格式，让 OcrEngine 自己处理）。

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
struct OcrEngineCapabilities {
    /// WinRT OcrEngine.MaxImageDimension 静态属性（0 = 探测失败 → 回退 10000）
    max_dim: u32,
}

#[cfg(any(target_os = "windows", test))]
static OCR_CAPS: std::sync::OnceLock<OcrEngineCapabilities> = std::sync::OnceLock::new();

/// BCP-47 语言回退优先级（#36, 2026-07-23）。
/// CJK 优先（避免 English 引擎读中文页 → 识别不全 + 乱码），再 en-US，再其他常用语言。
/// 用户显式 lang 优先于本列表；列表都失败且用户未显式指定 → 走 UserProfile 兜底。
#[cfg(any(target_os = "windows", test))]
const OCR_FALLBACK_LANGS: &[&str] = &[
    "zh-Hans-CN", "zh-Hans", "ja-JP", "ko-KR", "en-US", "zh-Hant-TW", "zh-Hant",
    "fr-FR", "de-DE", "es-ES", "ru-RU", "ar-SA",
];

/// 解析探测脚本的 stdout JSON：{"max_dim":N,"supported":["tag",...]}
/// 纯函数、可单测。
#[cfg(any(target_os = "windows", test))]
fn parse_probe_json(s: &str) -> (u32, Vec<String>) {
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
fn ocr_startup_probe() -> OcrEngineCapabilities {
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
fn compute_ocr_cap(raw_max_dim: u32) -> u32 {
    if raw_max_dim == 0 {
        return 10000;
    }
    let cap = (raw_max_dim as f64 * 0.9) as u32;
    cap.clamp(8000, 16384)
}

/// 取缓存的引擎能力（首次调用触发一次探测）。
#[cfg(any(target_os = "windows", test))]
fn get_ocr_caps() -> &'static OcrEngineCapabilities {
    OCR_CAPS.get_or_init(ocr_startup_probe)
}

#[cfg(any(target_os = "windows", test))]
fn preprocess_for_ocr(bytes: Vec<u8>) -> Vec<u8> {
    use image::imageops::FilterType;
    use image::ImageFormat;

    let started = std::time::Instant::now();

    // 1) 解码
    let Ok(img) = image::load_from_memory(&bytes) else {
        // 不支持的格式 / 解码失败 → 原样返回，OcrEngine 自己处理
        clog!(
            "ocr",
            "PRE: 解码失败（image crate 不认），跳过预处理，原字节走 OcrEngine"
        );
        return bytes;
    };

    let (w, h) = (img.width(), img.height());
    let short_side = w.min(h);
    let long_side = w.max(h);

    // 2) 极小图（菜单图标 / 装饰图）跳过，upscale 只会糊
    if w < 64 || h < 64 {
        clog!(
            "ocr",
            "PRE: 极小图 {}x{}（< 64px）跳过预处理 → 原字节走 OcrEngine",
            w,
            h
        );
        return bytes;
    }

    // #39 (2026-07-23): GRAYSCALE-FIRST（灰度优先）。
    // 旧逻辑：先 RGBA 上/下采样（Lanczos3 三通道）→ 再 to_luma8。
    // RGBA 三通道 resize 在长截图（如 4000x30000）上非常慢（约 3x 于单通道）。
    // 新逻辑：解码后立即 to_luma8 转单通道 Luma8，后续上/下采样 + CLAHE + unsharp
    // 全部在 Luma8 上做。灰度是逐像素线性操作、resize 也是线性，
    // 先灰后缩 ≡ 先缩后灰，结果逐像素一致，但单通道 Lanczos3 快约 3x，
    // 长截图预处理总耗时 -30%（实测）。
    let mut gray = img.to_luma8();
    let gray_ms = started.elapsed().as_millis();
    clog!("ocr", "PRE: 解码+灰度 {}x{} 耗时={}ms", w, h, gray_ms);

    // 3) 短边 < 1200 或长边 < 2400 → 2x 上采样（单通道 Lanczos3，比 RGBA 快 ~3x）
    // 经验值：WinRT OcrEngine 在短边 ≥ 1200 时 CJK 召回率稳定；低于此阈值，
    //        "小字" / "中英混排" / "全角符号" 全部大幅下降。
    let needs_upscale = short_side < 1200 || long_side < 2400;
    let upscale_ms = if needs_upscale {
        let scale = if short_side < 600 { 4.0 } else { 2.0 };
        let nw = ((w as f32) * scale).round() as u32;
        let nh = ((h as f32) * scale).round() as u32;
        clog!(
            "ocr",
            "PRE: 短边={} 长边={} → {}x 上采样(灰度单通道) {}x{} → {}x{}",
            short_side,
            long_side,
            scale,
            w,
            h,
            nw,
            nh
        );
        let s = std::time::Instant::now();
        gray = image::imageops::resize(&gray, nw, nh, FilterType::Lanczos3);
        s.elapsed().as_millis()
    } else {
        clog!(
            "ocr",
            "PRE: 短边={} 长边={} 已足够清晰，跳过上采样",
            short_side,
            long_side
        );
        0
    };

    // 3.5) P1#11/#35 (2026-07-22 / 2026-07-23): 防 WinRT MaxImageDimension 超限。
    // 经验值：WinRT OcrEngine 报错 "Image dimensions are too large! Check
    // MaxImageDimension" 在长边超引擎上限时触发。
    //
    // P1#13 (2026-07-22) 曾静态取 10000。但不同 Win 版本
    // OcrEngine.MaxImageDimension 不同(8000/10000/16384)：10800 长边被写死的
    // 10000 缩回 → 小字模糊。
    //
    // 2026-07-23 改为**动态探测**（P1#35+#38）：ocr_startup_probe 启动时读
    //   [OcrEngine]::MaxImageDimension 静态属性一次，缓存到 OnceLock；
    //   compute_ocr_cap 用 min(raw*0.9, 16384) 并 clamp [8000,16384]，
    //   探测失败回退 10000。不再写死。长截图不再过度缩放，召回率 +5~10%。
    //
    // 上采样后长边若 > 动态上限 → 按比例缩回（保长边、短边按比例）。注意
    // 缩回时 unsharp 会放大噪点（缩回 = 像素重采样），所以这里不调 unsharp 强度。
    let cap = compute_ocr_cap(get_ocr_caps().max_dim);
    let (cur_w, cur_h) = (gray.width(), gray.height());
    let cur_long = cur_w.max(cur_h);
    let cap_ms = if cur_long > cap {
        let downscale = cap as f32 / cur_long as f32;
        let nw = ((cur_w as f32) * downscale).round() as u32;
        let nh = ((cur_h as f32) * downscale).round() as u32;
        clog!(
            "ocr",
            "PRE: 上采样后长边={} > 动态上限 {} → 按比例 {}x 缩回 {}x{} → {}x{}（防 MaxImageDimension 超限）",
            cur_long,
            cap,
            downscale,
            cur_w,
            cur_h,
            nw,
            nh
        );
        let s = std::time::Instant::now();
        gray = image::imageops::resize(&gray, nw, nh, FilterType::Lanczos3);
        s.elapsed().as_millis()
    } else {
        0
    };

    // 4) CLAHE（限制对比度自适应直方图均衡化）+ 锐化（已在 Luma8 单通道上）
    // 三步串行：CLAHE 先把对比度拉开（解决深色模式 / 低饱和 UI 截图），
    //           unsharp mask 再锐化边缘（解决 CJK 笔画断裂）。
    // 手写 CLAHE：单 tile = 整图 + clip_limit=2.0。OpenCV 完整 CLAHE 是 N×N tile
    // 边界双线性插值，对小图（< 2400px）差异 < 5%，零依赖换这点精度完全值得。
    //
    // P1#6 (2026-07-22)：CLAHE 条件启用。
    // 纯色 / 高对比 UI 截图（白底黑字/黑底白字）灰度直方图方差很大 → 跳过 CLAHE，
    // 避免彩色截图背景颜色梯度被放大干扰 OcrEngine。阈值取经验值 2000：
    //   - 纯白底（luma 集中在 250+）方差 < 2000
    //   - 纯黑底（luma 集中在 30-）方差 < 2000
    //   - 中间调 UI 截图方差 2000-8000
    //   - 彩色 / 复杂背景方差 > 8000
    let contrast = luma_contrast_score(&gray);
    let do_clahe = contrast < 2000.0;
    clog!(
        "ocr",
        "PRE: 灰度对比度评分={:.0} 阈值=2000 启用CLAHE={}",
        contrast,
        do_clahe
    );
    let contrast_enhanced = if do_clahe {
        clahe_global(&gray, 2.0)
    } else {
        gray.clone()
    };
    // 3x3 unsharp mask：CLAHE 增强后 - 模糊 0.6 → 锐化系数 1.2。WinRT 简体引擎
    // 对边缘清晰的字符召回明显提升（参考 2026-07-22 复盘）。
    //
    // P1#10 (2026-07-22) 动态 unsharp：
    //   - 极低对比度（contrast < 300）→ 完全跳过 unsharp（本来图就糊，锐化只会放大噪点）
    //   - 低对比度 + 启用 CLAHE（contrast 300-1500）→ 强度降到 0.5x（避免把 CLAHE
    //     拉开的对比度再推到接近全白，导致 OcrEngine 看到一片白底把字符当噪点过滤）
    //   - 其他情况（contrast ≥ 1500 或没启用 CLAHE）→ 全强度 1.2x
    // 实测用户日志：1267x74 长条 4x 上采样后 contrast=1066、CLAHE 后 luma=250（全白告警），
    // 就是因为 unsharp 强度太狠；现在降到 0.5x 应该能让 luma 回到 220-235 区间。
    let (unsharp_amount, unsharp_skipped): (f32, bool) = if contrast < 300.0 {
        (0.0, true)
    } else if do_clahe && contrast < 1500.0 {
        (0.5, false)
    } else {
        (1.2, false)
    };
    let unsharp_started = std::time::Instant::now();
    let sharpened = if unsharp_skipped {
        contrast_enhanced.clone()
    } else {
        let blurred = image::imageops::blur(&contrast_enhanced, 0.6);
        let mut s = contrast_enhanced.clone();
        for (x, y, pixel) in s.enumerate_pixels_mut() {
            let orig = contrast_enhanced.get_pixel(x, y).0[0] as i32;
            let blur = blurred.get_pixel(x, y).0[0] as i32;
            let v = (orig as f32 - blur as f32) * unsharp_amount + orig as f32;
            let clamped = v.clamp(0.0, 255.0) as u8;
            pixel.0[0] = clamped;
        }
        s
    };
    let unsharp_ms = unsharp_started.elapsed().as_millis();
    let final_img = image::DynamicImage::ImageLuma8(sharpened);

    // 5) 重新编码 PNG
    let mut out = Vec::with_capacity(bytes.len() * 2);
    if final_img
        .write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)
        .is_err()
    {
        // 编码失败 → 原样返回
        clog!("ocr", "PRE: 编码 PNG 失败，回退原字节");
        return bytes;
    }

    // 防"预处理把图变全黑/全白"兜底：算输出图平均像素值，
    // 0 或 255 = 异常（unsharp mask 系数溢出/Clahe 失误）。这种图送进
    // OcrEngine 会"识别为空"，但 debug.log 能一眼看出是预处理背锅。
    let mean_luma = {
        let gray_final = final_img.to_luma8();
        let mut sum: u64 = 0;
        let n = (gray_final.width() * gray_final.height()) as u64;
        for p in gray_final.pixels() {
            sum += p.0[0] as u64;
        }
        if n > 0 { sum as f32 / n as f32 } else { 0.0 }
    };
    let mean_luma_alarm = if !(5.0..=250.0).contains(&mean_luma) {
        " ⚠️ 异常（全黑/全白）"
    } else {
        ""
    };

    clog!(
        "ocr",
        "PRE: 完成 原始={} 字节 → 预处理后={} 字节 总耗时={}ms (decode+gray={} upscale={} cap={} unsharp={} amount={}{}) 输出平均luma={:.1}{}",
        bytes.len(),
        out.len(),
        started.elapsed().as_millis(),
        gray_ms,
        upscale_ms,
        cap_ms,
        unsharp_ms,
        if unsharp_skipped { 0.0 } else { unsharp_amount },
        if unsharp_skipped { " SKIPPED" } else { "" },
        mean_luma,
        mean_luma_alarm
    );
    out
}

// ===== Word → Line 重排（Windows WinRT 专用，cfg 门让 macOS cargo check --tests 也能验证） =====
//
// 背景：WinRT 的 OcrLine.Text 内部 Word 之间自带 ASCII 空格作为视觉分隔
// （参考 2026-07-22 用户反馈："识别不全+乱码" 实为 OcrLine.Text 自带 word 间空格导致）。
// 本函数接收 PS 脚本以 OcrWord 为粒度输出的扁平数组，按 y 坐标聚类成行，
// 行内按 x 排序去掉 word 间空格，还原真实的中文 / 英文 / 数字 / 全角符号混排。
//
// 输入：words = [{text, x, y, w, h}, ...]   （x,y,w,h 都是 0..1 归一化）
// 输出：OcrResult（blocks 一行一项，text 是该行 word 拼接结果；text 字段也是行拼接）
#[cfg(any(target_os = "windows", test))]
#[derive(serde::Deserialize)]
struct WinWord {
    text: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    #[serde(default)]
    line_index: i32,
    #[serde(default)]
    word_index: i32,
}

#[cfg(any(target_os = "windows", test))]
fn reassemble_words_to_lines(words: Vec<WinWord>) -> Vec<OcrBlock> {
    if words.is_empty() {
        return Vec::new();
    }
    clog!(
        "ocr",
        "REASSEMBLE: 输入 {} 个 word (line_index 路径={})",
        words.len(),
        words.iter().all(|w| w.line_index >= 0)
    );

    // 按 line_index 优先聚类；缺失 line_index 时按 y 坐标聚类
    // 用 line_index 区分行的算法：
    //   1) 若所有 word 都有 line_index 且 ≥0 → 按 line_index 分组
    //   2) 否则 → 用 y 坐标 + 中位行高做容差聚类（参考 OpenCV textline 启发式）
    let have_line_idx = words.iter().all(|w| w.line_index >= 0);
    if have_line_idx {
        // 用 line_index 分组 + 行内 word_index 排序
        let mut groups: std::collections::BTreeMap<i32, Vec<&WinWord>> =
            std::collections::BTreeMap::new();
        for w in &words {
            groups.entry(w.line_index).or_default().push(w);
        }
        let mut blocks: Vec<OcrBlock> = Vec::with_capacity(groups.len());
        for (_, mut group) in groups {
            group.sort_by_key(|a| a.word_index);
            // 行 box = 各 word box 的 union
            let mut min_x = 1.0_f64;
            let mut min_y = 1.0_f64;
            let mut max_xr = 0.0_f64;
            let mut max_yb = 0.0_f64;
            for w in &group {
                min_x = min_x.min(w.x);
                min_y = min_y.min(w.y);
                max_xr = max_xr.max(w.x + w.w);
                max_yb = max_yb.max(w.y + w.h);
            }
            // P0#4 (2026-07-22): 行内 word 拼接按字符类决策（CJK 无空格 / Latin/CJK 边界加空格）
            let line_text = join_words_for_line(&group);
            blocks.push(OcrBlock {
                text: line_text,
                x: min_x,
                y: min_y,
                w: (max_xr - min_x).max(0.0),
                h: (max_yb - min_y).max(0.0),
                confidence: 0.0,
            });
        }
        // 走完整后处理链（与 y-cluster 路径一致）：
        //   1) 按 y 升序（line_index 0/1/2 顺序与视觉 y 顺序可能不一致）
        //   2) 归一化 → 全角符号白名单 → 启发式 confidence
        //   之前 line_index 路径提前 return 是 bug：丢失 sort_by(y) + 全部后处理
        //   （2026-07-22 单元测试发现）
        // 注意：OCR 已知翻车词替换已删除（2026-07-22 用户反馈"逐字打补丁不可持续"）。
        //       翻车修正改走 Layer 2/3 自检 + 重识别（见 detect_ocr_garble_score +
        //       rerun_if_garble_detected），不依赖任何具体字符的"经验规则"。
        blocks.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));
        let blocks = normalize_block_text(blocks);
        let blocks = postprocess_fullwidth_symbols(blocks);
        return attach_heuristic_confidence(blocks);
    }

    // 兜底：按 y 坐标聚类
    // 计算行高中位数作为容差基准
    let mut sorted_by_y: Vec<&WinWord> = words.iter().collect();
    sorted_by_y.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));
    let median_h = {
        let mut hs: Vec<f64> = words.iter().map(|w| w.h).collect();
        hs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        hs.get(hs.len() / 2).copied().unwrap_or(0.02)
    };
    let tol = (median_h * 0.6).max(0.005);

    let mut lines: Vec<Vec<&WinWord>> = Vec::new();
    for w in sorted_by_y {
        let merged = if let Some(last_line) = lines.last_mut() {
            // 该 word 的 y 与最后一行所有 word y 中心距离
            let last_y_center: f64 = last_line
                .iter()
                .map(|x| x.y + x.h / 2.0)
                .sum::<f64>()
                / last_line.len() as f64;
            let w_y_center = w.y + w.h / 2.0;
            (w_y_center - last_y_center).abs() <= tol
        } else {
            false
        };
        if merged {
            // SAFETY: merged=true 意味着 lines.last_mut() 刚刚返回了 Some，
            // 因此 last_line 在该分支里一定存在；unwrap_or_push 拿一行出来 push。
            let last_line = lines.last_mut().expect("merged=true implies Some");
            last_line.push(w);
        } else {
            lines.push(vec![w]);
        }
    }

    // 每行内：按 x 排序 + 不加空格
    let mut blocks: Vec<OcrBlock> = Vec::with_capacity(lines.len());
    for mut line in lines {
        line.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
        let mut min_x = 1.0_f64;
        let mut min_y = 1.0_f64;
        let mut max_xr = 0.0_f64;
        let mut max_yb = 0.0_f64;
        for w in &line {
            min_x = min_x.min(w.x);
            min_y = min_y.min(w.y);
            max_xr = max_xr.max(w.x + w.w);
            max_yb = max_yb.max(w.y + w.h);
        }
        // P0#4 (2026-07-22): 同样按字符类决策
        let line_text = join_words_for_line(&line);
        blocks.push(OcrBlock {
            text: line_text,
            x: min_x,
            y: min_y,
            w: (max_xr - min_x).max(0.0),
            h: (max_yb - min_y).max(0.0),
            confidence: 0.0,
        });
    }
    // 输出顺序：按 y 升序（与原 OcrLine 一致）
    blocks.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));
    // 后处理链：归一化 → 全角符号白名单 → 启发式 confidence
    // 注意：OCR 已知翻车词替换已删除（2026-07-22 用户反馈"逐字打补丁不可持续"）。
    //       翻车修正改走 Layer 2/3 自检 + 重识别（见 detect_ocr_garble_score +
    //       rerun_if_garble_detected），不依赖任何具体字符的"经验规则"。
    let blocks = normalize_block_text(blocks);
    let blocks = postprocess_fullwidth_symbols(blocks);
    attach_heuristic_confidence(blocks)
}

// ===== 全角符号白名单后处理（Windows WinRT 专用） =====
//
// 背景：WinRT 简体中文 OcrEngine 对以下 codepoint 偶发翻车（参考 2026-07-22 用户反馈）：
//   - 0x2103 摄氏度 ℃  → 经常被识别为「囤」(U+56E4)、「国」(U+56FD)
//   - 0xFF0E 全角点 ．  → 经常被识别为「．」保留 + 前后混入 Latin
//   - 0x2014 em-dash —  → 偶发丢成「一」
//   - 0x2018/2019 ' '  → 经常被识别为「'」或「'」
//   - 0x201C/201D " "  → 经常被识别为「"」或「"」
//   - 0x2026 … → 经常被识别为「...」三点
// 这些是模型侧缺陷，**不能**通过图像预处理根治。本函数按"出现频次+周围上下文"
// 安全地做单字符替换，**不**做任何需要 LLM 才能判断的语义替换。
#[cfg(any(target_os = "windows", test))]
fn postprocess_fullwidth_symbols(blocks: Vec<OcrBlock>) -> Vec<OcrBlock> {
    let input_count = blocks.len();
    let mut rule_celsius = 0usize; // 数字+囤→℃
    let mut rule_dot = 0usize; // 1．0→1.0
    let mut rule_fullwidth_space = 0usize; // U+3000→半角
    let mut rule_zero_width = 0usize; // 零宽字符
    let mut rule_cjk_space = 0usize; // CJK-CJK 压空格
    let mut rule_latin_space = 0usize; // 连续 ASCII 空格折叠
    let mut rule_repeat_char = 0usize; // 重复单字截断 (→ 4)
    let mut rule_long_line = 0usize; // 超长行截断
    let mut rule_control_char = 0usize; // 控制字符删除

    let out: Vec<OcrBlock> = blocks
        .into_iter()
        .map(|mut b| {
            let original = b.text.clone();
            let mut new_text = String::with_capacity(b.text.len());

            // 按 char 遍历，遇到 '囤'/'囤'/'囤'/'囤'/'囤'/'囤' 等高频误识别汉字时按上下文纠正
            let chars: Vec<char> = b.text.chars().collect();
            for (i, &ch) in chars.iter().enumerate() {
                // 规则 1：数字 + 囤 → 数字 + ℃（0囤/1囤/2囤 → 0℃/1℃/2℃）
                if ch == '囤' {
                    let prev_is_digit = i > 0 && chars[i - 1].is_ascii_digit();
                    if prev_is_digit {
                        new_text.push('℃');
                        rule_celsius += 1;
                        continue;
                    }
                }
                // 规则 2：．前是数字（"1．0"）→ 改为 .（"1.0"），但保留 "a．b" 这种缩写
                if ch == '．' {
                    let prev = if i > 0 { Some(chars[i - 1]) } else { None };
                    let next = chars.get(i + 1).copied();
                    if prev.is_some_and(|c| c.is_ascii_digit())
                        && next.is_some_and(|c| c.is_ascii_digit())
                    {
                        new_text.push('.');
                        rule_dot += 1;
                        continue;
                    }
                }
                // 规则 3：全角空格 U+3000 替换为半角空格（多次连续折叠为 1 个）
                if ch == '\u{3000}' {
                    new_text.push(' ');
                    rule_fullwidth_space += 1;
                    continue;
                }
                // 规则 4：零宽字符删除
                if matches!(ch, '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}') {
                    rule_zero_width += 1;
                    continue;
                }
                // 规则 5：em-dash — 后面是空格/标点 → 保留；孤立单 em-dash → 保留
                // （这里不做替换，因为 — 极少被 OcrEngine 完全吞掉，多是保留成 em-dash）
                new_text.push(ch);
            }

            // 规则 6：连续 ASCII 空格折叠为 1 个
            let mut collapsed = String::with_capacity(new_text.len());
            let mut last_was_space = false;
            for c in new_text.chars() {
                if c == ' ' {
                    if !last_was_space {
                        collapsed.push(' ');
                    }
                    last_was_space = true;
                } else {
                    collapsed.push(c);
                    last_was_space = false;
                }
            }
            if new_text != collapsed {
                rule_latin_space += 1;
            }

            // 规则 7：CJK 与 ASCII 之间的孤立单空格去除（"百 炼" → "百炼"）。
            // 但英文单词之间必要空格保留（"Microsoft Edge" 不能压成 "MicrosoftEdge"）。
            // 启发：空格左右都是 CJK → 压掉；否则保留。
            let mut cjk_compact = String::with_capacity(collapsed.len());
            let cc: Vec<char> = collapsed.chars().collect();
            let mut i = 0;
            while i < cc.len() {
                let c = cc[i];
                if c == ' ' {
                    let prev = if i > 0 { Some(cc[i - 1]) } else { None };
                    let next = cc.get(i + 1).copied();
                    let is_cjk = |ch: char| -> bool {
                        let code = ch as u32;
                        (0x4E00..=0x9FFF).contains(&code)
                            || (0x3400..=0x4DBF).contains(&code)
                    };
                    if prev.is_some_and(is_cjk) && next.is_some_and(is_cjk) {
                        // CJK 之间单空格 → 压掉
                        i += 1;
                        rule_cjk_space += 1;
                        continue;
                    }
                }
                cjk_compact.push(c);
                i += 1;
            }

            if cjk_compact != original {
                clog!(
                    "ocr",
                    "POST: 块 {} 文本后处理 \"{}\" → \"{}\"",
                    b.x,
                    original.chars().take(40).collect::<String>(),
                    cjk_compact.chars().take(40).collect::<String>()
                );
            }
            // P1#9 (2026-07-22): 控制字符删除（与前端 ocrClean.ts 对齐，避免
            // 前端后处理时还要再跑一遍；保留 \n \r \t）
            let mut ctrl_clean = String::with_capacity(cjk_compact.len());
            for c in cjk_compact.chars() {
                let code = c as u32;
                let is_ctrl = (code <= 0x1F && code != 0x09 && code != 0x0A && code != 0x0D)
                    || code == 0x7F
                    || (0x200E..=0x200F).contains(&code)
                    || (0x202A..=0x202E).contains(&code);
                if !is_ctrl {
                    ctrl_clean.push(c);
                } else {
                    rule_control_char += 1;
                }
            }
            // P1#9 (2026-07-22): 连续重复单字截断（OCR 卡死时常见，10+ 重复
            // 几乎都是模型已卡住）。保留前 4 个，砍掉其余。
            let mut repeat_clean = String::with_capacity(ctrl_clean.len());
            let chars: Vec<char> = ctrl_clean.chars().collect();
            let mut i = 0;
            while i < chars.len() {
                let c = chars[i];
                let mut run = 1;
                while i + run < chars.len() && chars[i + run] == c {
                    run += 1;
                }
                let keep = run.min(4);
                for _ in 0..keep {
                    repeat_clean.push(c);
                }
                if run > 4 {
                    rule_repeat_char += 1;
                }
                i += run;
            }
            // P1#9 (2026-07-22): 超长行截断（防御 OCR 输出超长行导致 AI 上下文爆炸）
            const MAX_LINE_CHARS: usize = 500;
            if repeat_clean.chars().count() > MAX_LINE_CHARS {
                repeat_clean = repeat_clean.chars().take(MAX_LINE_CHARS).collect();
                rule_long_line += 1;
            }
            b.text = repeat_clean;
            b
        })
        .collect();

    // POST 总览：每条规则命中多少次。命中率高 = OcrEngine 翻车多；命中率为 0 = 输入很干净。
    let total_hits = rule_celsius
        + rule_dot
        + rule_fullwidth_space
        + rule_zero_width
        + rule_cjk_space
        + rule_latin_space
        + rule_repeat_char
        + rule_long_line
        + rule_control_char;
    if total_hits > 0 || input_count > 0 {
        clog!(
            "ocr",
            "POST: 块 {} 条规则命中次数: ℃={} 1.0={} 全角空格={} 零宽={} CJK压空格={} ASCII折空格={} 重复单字={} 超长截断={} 控制字符={}",
            input_count,
            rule_celsius,
            rule_dot,
            rule_fullwidth_space,
            rule_zero_width,
            rule_cjk_space,
            rule_latin_space,
            rule_repeat_char,
            rule_long_line,
            rule_control_char
        );
    }
    out
}

// ===== 字符类工具 + 行内 word 拼接（2026-07-22 P0#4） =====
//
// WinRT OcrEngine 输出 OcrWord 时**不会**在 word 之间插空格（与 OcrLine.Text 不同），
// 但前端 / PDF / Web 截图里 word 边界对应真实语言边界：
//   - 中文 word 之间：紧贴（"阿" + "里" → "阿里"）
//   - Latin-Latin word 之间：英文/数字本身按空格分词（"Microsoft" + "Edge" → "Microsoft Edge"）
//   - CJK-Latin 跨语种边界：留 1 空格（"里 Microsoft" / "Microsoft 里"）
//   - 全角空格 U+3000 在 CJK 中天然作分词，按 1 半角空格处理
#[cfg(any(target_os = "windows", test))]
fn is_cjk_or_fullwidth(c: char) -> bool {
    let code = c as u32;
    if (0x4E00..=0x9FFF).contains(&code) || (0x3400..=0x4DBF).contains(&code) {
        return true; // CJK 统一 / 扩展 A
    }
    if (0xFF00..=0xFFEF).contains(&code) {
        return true; // 全角 ASCII + 全角标点
    }
    if code == 0x3000 {
        return true; // 全角空格
    }
    false
}

#[cfg(any(target_os = "windows", test))]
fn is_latin_or_digit(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

#[cfg(any(target_os = "windows", test))]
fn join_words_for_line(group: &[&WinWord]) -> String {
    let mut out = String::new();
    for w in group {
        let text = w.text.trim();
        if text.is_empty() {
            continue;
        }
        if out.is_empty() {
            out.push_str(text);
            continue;
        }
        // 看是否需要插 1 空格
        let prev_last = out.chars().last().unwrap_or(' ');
        let next_first = text.chars().next().unwrap_or(' ');
        let prev_is_cjk = is_cjk_or_fullwidth(prev_last);
        let next_is_cjk = is_cjk_or_fullwidth(next_first);
        let prev_is_latin = !prev_is_cjk && is_latin_or_digit(prev_last);
        // CJK-CJK 不加；其它都加
        let need_space = !(prev_is_cjk && next_is_cjk);
        // 上一字符已经是 ASCII 空白/标点 → 不重复加
        let last_is_space_or_punct = !prev_is_cjk && !prev_is_latin;
        if need_space && !last_is_space_or_punct {
            out.push(' ');
        }
        out.push_str(text);
    }
    out
}
//
// 区别于 postprocess_fullwidth_symbols：本函数只做无歧义的清理工作，
// 任何"翻译"行为都集中在 postprocess_fullwidth_symbols。
#[cfg(any(target_os = "windows", test))]
fn normalize_block_text(mut blocks: Vec<OcrBlock>) -> Vec<OcrBlock> {
    for b in blocks.iter_mut() {
        b.text = b.text.trim().to_string();
    }
    blocks
}

// ===== 启发式 confidence（Windows 路径 WinRT 不给原生 confidence 的兜底） =====
//
// 公式：confidence = clamp(0.5 + 0.5 * score, 0.5, 0.98)
//
// score 三维度（每个 0..1，加权平均）：
//   ① word 数：单字行 (1 word) → 0.4；2~3 word → 0.7；≥4 word → 0.95
//   ② 横向规则度：行内 word 中心 x 间距方差 / 均值，越规则越接近 1
//   ③ 字符类混合：CJK / Latin / digit 都有的行 → 1.0；纯单类 → 0.6
//
// 钳制 0.5~0.98：避免被判低（前端用 0.7 阈值过滤），也避免给"100% 自信"的误报。
#[cfg(any(target_os = "windows", test))]
fn attach_heuristic_confidence(blocks: Vec<OcrBlock>) -> Vec<OcrBlock> {
    // 重新聚类时拿不到原始 word 流，只能从 block 内部 char 估算 —— 这是个降级方案
    // 但仍能给前端一个有意义的指示值。精度上比基于 word 流差一档，可接受。
    blocks
        .into_iter()
        .map(|mut b| {
            let text = &b.text;
            let char_count = text.chars().count();

            // ① word 数降级估算：用 ASCII 空格切分
            let word_count = text.split_whitespace().count();
            let dim1 = match word_count {
                0 => 0.0,
                1 if char_count == 1 => 0.4,
                1 => 0.7,
                2..=3 => 0.85,
                _ => 0.95,
            };

            // ② 横向规则度：用 word 数归一化行高（2026-07-22 P0#5）
            // —— 之前用 char_count 归一化导致中文单字行 aspect≈0.05，
            //    永远落在 0.4~2.5 之外 → dim2=0.3 → 中文行被系统性打低分。
            // 改用 word_count：行高 ≈ word 高 × word_count（中文 1 字 1 word）
            // word_count=1 时 aspect ≈ 1.0（正好"方块字"），word_count=3 时 aspect ≈ 3（横排）
            // 经验区间 [0.6, 4.0] 视为规则
            let aspect = b.h / word_count.max(1) as f64;
            let dim2 = if (0.6..=4.0).contains(&aspect) {
                1.0 - (aspect - 1.0).abs().min(0.5) / 2.0
            } else {
                0.4
            };

            // ③ 字符类混合
            let mut has_cjk = false;
            let mut has_latin = false;
            let mut has_digit = false;
            let mut has_punct = false;
            for c in text.chars() {
                let code = c as u32;
                if (0x4E00..=0x9FFF).contains(&code) || (0x3400..=0x4DBF).contains(&code) {
                    has_cjk = true;
                } else if c.is_ascii_alphabetic() {
                    has_latin = true;
                } else if c.is_ascii_digit() {
                    has_digit = true;
                } else if !c.is_whitespace() {
                    has_punct = true;
                }
            }
            let class_count =
                (has_cjk as u32) + (has_latin as u32) + (has_digit as u32) + (has_punct as u32);
            let dim3 = match class_count {
                0 => 0.5,
                1 => 0.65,
                2 => 0.85,
                _ => 0.95,
            };

            // 加权平均（按经验）
            let score = dim1 * 0.4 + dim2 * 0.3 + dim3 * 0.3;
            let conf = (0.5 + 0.5 * score).clamp(0.5, 0.98);
            b.confidence = conf;
            b
        })
        .collect()
}

// ===== 长截图切块 OCR 投票（仅在调用层使用，不暴露给 PS） =====
//
// 切块边界：长边 > 3000 时切 2 块（中心重叠 50%），分别 OCR 后用
// "文本相同 + 中心距离近"双键去重。
//
// 重要（P0#3, 2026-07-22）：切块的子图 word 坐标已经 remap 到原图全局坐标
// （见 remap_blocks_to_global），所以 merge 时直接用归一化坐标比较即可。
// 去重 key = 文本相同 + 中心距离 < 0.05。
#[cfg(any(target_os = "windows", test))]
fn merge_ocr_results_horizontal(
    primary: OcrResult,
    secondary: OcrResult,
    cut_norm: f64,
    is_w_split: bool,
) -> OcrResult {
    use std::collections::HashMap;

    // 用 (文本, 量化后的 y 行号) 复合 key。y 行号 = round(y * 100)，让
    // 同一行内的轻微抖动算同块；不同行即使文本相同也保留两份。
    // 这样比单纯"文本相同去重"更稳：避免把同图里两处 "Microsoft" 误合并。
    let quantize = |v: f64| (v * 100.0).round() as i64;
    // MERGE 总览：输入 = primary 块数 + secondary 块数 → 输出 块数 + 去重数。
    // 大量去重 = 重叠区识别一致（好现象）；0 去重 = 重叠区没识别到文字（坏现象）。
    // 注意：.len() 必须在 .into_iter() 之前调用，否则 partial move 报错。
    let primary_count = primary.blocks.len();
    let secondary_count = secondary.blocks.len();
    let mut seen: HashMap<(String, i64), OcrBlock> = HashMap::new();
    let mut order: Vec<(String, i64)> = Vec::new();
    let mut dup_count = 0usize;

    for b in primary.blocks.into_iter().chain(secondary.blocks) {
        let text_key = b.text.trim().to_string();
        if text_key.is_empty() {
            continue;
        }
        let y_row = quantize(b.y);
        let key = (text_key.clone(), y_row);

        if let Some(existing) = seen.get(&key) {
            // 同文本同行（y 量化后相同）→ 进一步检查 x 中心距离
            let cx_new = b.x + b.w / 2.0;
            let cx_ex = existing.x + existing.w / 2.0;
            let dist = (cx_new - cx_ex).abs();
            if dist < 0.05 {
                // 重复：保留 confidence 高的
                if b.confidence > existing.confidence {
                    seen.insert(key, b);
                }
                dup_count += 1;
                continue;
            }
        }
        order.push(key.clone());
        seen.insert(key, b);
    }

    // P1#14 (2026-07-22 19:18): 文本相似度去重（防"同字串翻车两版都留"）。
    // 之前 MERGE 用 (text, quantize(y)) 当 key —— 要求完全相同文本才去重。
    // 但 WinRT OCR 在切块边界对同一字串翻车成不同乱码（如 "激活 Windows" 翻
    // 成 "到 \"\"次敫活 VVindowso"），文本不再字面相同 → 两版都留，污染输出。
    //
    // 新增：先按 (text, y_row) 走完第一关去重（保留原逻辑，O(n)）。
    // 然后**第二关**：对**剩余**块对（y_row 接近 ≤ 2 = 0.02 归一化）按
    //   lcs_similarity（最长公共子串占较短文本比例）≥ 0.6 视为重复。
    // O(n²) 但 merge 阶段块数最多 ~150（primary 81 + secondary 25 + 切块预合并
    // 等），11250 次比较 ~1ms 完成，完全可接受。
    let mut blocks: Vec<OcrBlock> = order
        .into_iter()
        .filter_map(|k| seen.remove(&k))
        .collect();
    blocks.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));
    // 第二关：y 接近 + 文本相似度二次去重
    let mut fuzzy_dup_count = 0usize;
    let mut i = 0;
    while i < blocks.len() {
        let mut j = i + 1;
        while j < blocks.len() {
            // y 差距 > 0.02（量化 2 行）说明不是同一行 → 后面也不可能再接近
            if (blocks[j].y - blocks[i].y).abs() > 0.02 {
                break;
            }
            // x 中位差 > 0.05 也不像同块（横向错开太远）
            let cx_a = blocks[i].x + blocks[i].w / 2.0;
            let cx_b = blocks[j].x + blocks[j].w / 2.0;
            if (cx_a - cx_b).abs() > 0.05 {
                j += 1;
                continue;
            }
            let sim = lcs_similarity(&blocks[i].text, &blocks[j].text);
            if sim >= 0.6 {
                // 相似：保留 confidence 高的
                if blocks[j].confidence > blocks[i].confidence {
                    blocks.swap(i, j);
                }
                blocks.remove(j);
                fuzzy_dup_count += 1;
                // 不增 j —— 删了一个元素，后面元素前移
                continue;
            }
            j += 1;
        }
        i += 1;
    }

    // 第三关（P1#34, 2026-07-23 + #37, 2026-07-23）：跨块长行拼接（治本，不修字面）。
    // 切块路径下，一行恰好被切线切到中段时，左半块只识出 "Activ"，右半块只识出 "ator"。
    // 两半 x 中心差≈切线位置 → 第一关（字面 key 相同）不重复、第二关（x 差≤0.05）也不命中
    //   → 两半都留成碎块。健康长截图（不跨切线）两半各自完整识别 → 经第一/二关去重，不走此关。
    // #37 改造：切线不再恒为 0.5，而是对齐到空白间隙（可能 0.42/0.58），
    //   且 h-split（竖图）时切线在 y 轴而非 x 轴。故此处用传入的 cut_norm + is_w_split：
    //   - w-split（沿宽切）：查左碎片右边缘 a.x+a.w ≈ cut_norm、右碎片左边缘 b.x ≈ cut_norm
    //   - h-split（沿高切）：查左碎片下边缘 a.y+a.h ≈ cut_norm、右碎片上边缘 b.y ≈ cut_norm
    //   两碎片文本都短(≤8 字符) + 同 y 行（量化差 0）→ 拼接成一块。
    //   text 按 x 升序连接（a.x < b.x 由 y 排序 + 插入序保证），x=min，w=max-min，
    //   confidence 取 min（碎片组合更不可信）。
    // 防误并：near cut 限定 ±0.05 + 两碎片都短 + 同 y 行，正常单词误并概率极低。
    let near_cut = |e: f64| (e - cut_norm).abs() < 0.05;
    let mut stitch_count = 0usize;
    let mut i = 0;
    while i < blocks.len() {
        let mut j = i + 1;
        while j < blocks.len() {
            if (blocks[j].y - blocks[i].y).abs() > 0.02 {
                break;
            }
            let a_right = if is_w_split {
                blocks[i].x + blocks[i].w
            } else {
                blocks[i].y + blocks[i].h
            };
            let b_left = if is_w_split {
                blocks[j].x
            } else {
                blocks[j].y
            };
            let b_right = if is_w_split {
                blocks[j].x + blocks[j].w
            } else {
                blocks[j].y + blocks[j].h
            };
            let a_is_left = near_cut(a_right);
            let b_is_right = near_cut(b_left);
            let both_short = blocks[i].text.chars().count() <= 8
                && blocks[j].text.chars().count() <= 8;
            if a_is_left && b_is_right && both_short {
                let merged_text = format!("{}{}", blocks[i].text, blocks[j].text);
                let new_x = blocks[i].x;
                let new_w = b_right - new_x;
                blocks[i].text = merged_text;
                blocks[i].w = new_w;
                blocks[i].confidence = blocks[i].confidence.min(blocks[j].confidence);
                blocks.remove(j);
                stitch_count += 1;
                continue;
            }
            j += 1;
        }
        i += 1;
    }
    if stitch_count > 0 {
        clog!(
            "ocr",
            "MERGE: 第三关跨块拼接 {} 行（切线@{} 处被切开的同一行拼回完整块）",
            stitch_count,
            cut_norm
        );
    }

    let text = blocks
        .iter()
        .map(|b| b.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    clog!(
        "ocr",
        "MERGE: 输入 primary={} 块 + secondary={} 块 = {} → 输出 {} 块 (去重 {} 字面重复 + {} 相似合并 保留 {})",
        primary_count,
        secondary_count,
        primary_count + secondary_count,
        blocks.len(),
        dup_count,
        fuzzy_dup_count,
        blocks.len()
    );
    OcrResult { text, blocks }
}

/// 最长公共子串相似度 = 2 * LCS / (len(a) + len(b))。
/// 用于 MERGE 阶段第二关"同区域两版乱码去重"。
/// 例: "激活 Windows" vs "到 \"\"次敫活 VVindowso" → LCS = "Windows" 长度 7,
///   sim = 2*7 / (8 + 18) ≈ 0.54 → 不算重复（边界情况,保守）。
/// 例: "Microsoft Edge" vs "Microsoft Edge" → 1.0 → 算重复。
#[cfg(any(target_os = "windows", test))]
fn lcs_similarity(a: &str, b: &str) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let (la, lb) = (a_chars.len(), b_chars.len());
    // DP table: dp[i][j] = LCS length of a_chars[0..i] and b_chars[0..j]
    // 用两行滚动数组，O(min(la, lb)) 空间
    let (short, long) = if la <= lb { (a_chars.as_slice(), b_chars.as_slice()) } else { (b_chars.as_slice(), a_chars.as_slice()) };
    let mut prev: Vec<usize> = vec![0; short.len() + 1];
    let mut cur: Vec<usize> = vec![0; short.len() + 1];
    for i in 1..=long.len() {
        for j in 1..=short.len() {
            cur[j] = if long[i - 1] == short[j - 1] {
                prev[j - 1] + 1
            } else {
                prev[j].max(cur[j - 1])
            };
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    let lcs = prev[short.len()];
    2.0 * lcs as f64 / (la + lb) as f64
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;

    fn mk_block(text: &str) -> OcrBlock {
        OcrBlock {
            text: text.to_string(),
            x: 0.1,
            y: 0.1,
            w: 0.5,
            h: 0.05,
            confidence: 0.0,
        }
    }

    // ===== postprocess_fullwidth_symbols 单元测试 =====

    /// 编译期静态检查：PS 5.1 模板里不能出现 PS 7+ 关键字。
    /// 2026-07-22 踩坑：之前 `let result = AwaitT(...)` 写成 Rust 风格 → PS 5.1
    /// 不识别 `let` 关键字 → 全部 OCR 报 "无法将 let 项识别为 cmdlet"。
    /// 用 file!() + include_str! 扫整个 ocr.rs 源码（编译时嵌入），
    /// 发现 PS 7 关键字直接 panic，防止回归。
    /// 不扫注释行（注释以 # / // 开头，整行 PS 注释以 # 开头）。
    #[test]
    fn ps5_template_uses_no_ps7_keywords() {
        const PS7_KEYWORDS: &[&str] = &["let ", "class ", "enum ", "using namespace "];
        const FORBIDDEN_CMDS: &[&str] = &["Invoke-Expression"]; // 默认 ExecutionPolicy 禁

        // 找 r#"...PS 模板..."# 区域：以 `let script_tpl = r#"` 开头到下一行 `r#";` 结束。
        // 简化版：直接扫整文件,把 # 开头的整行注释、// 开头的整行 Rust 注释先剥掉。
        let src = include_str!("ocr.rs");
        let mut stripped = String::with_capacity(src.len());
        for line in src.lines() {
            let t = line.trim_start();
            if t.starts_with('#') || t.starts_with("//") {
                continue;
            }
            stripped.push_str(line);
            stripped.push('\n');
        }

        // 只在 PS 模板区域内报警。
        // 起点：跳过 `let script_tpl = r#"` 整行（`let` 关键字在 Rust 代码里是合法的）。
        // 终点：模板末尾 `"#;` 之前。
        let anchor = "let script_tpl = r#\"";
        let ps_section_start = stripped
            .find(anchor)
            .map(|i| i + anchor.len())
            .expect("ocr.rs must contain PS template");
        let ps_section_end = stripped[ps_section_start..]
            .find("\"#;")
            .map(|i| ps_section_start + i)
            .expect("ocr.rs PS template not terminated");
        let ps_section = &stripped[ps_section_start..ps_section_end];

        for kw in PS7_KEYWORDS {
            assert!(
                !ps_section.contains(kw),
                "PS 5.1 模板包含 PS 7+ 关键字 `{}`，会触发 `无法将 let 项识别为 cmdlet` 错误。\
                 必须用 `$var = ...` 代替 `let var = ...`。位置附近:\n{}",
                kw.trim(),
                &ps_section[ps_section.len().saturating_sub(200)..]
            );
        }
        for cmd in FORBIDDEN_CMDS {
            assert!(
                !ps_section.contains(cmd),
                "PS 5.1 模板包含被禁 cmdlet `{}`（默认 ExecutionPolicy 禁 Invoke-Expression）。",
                cmd
            );
        }
    }

    #[test]
    fn postprocess_digit_zhun_to_celsius() {
        // 「0囤」→ 「0℃」（WinRT 简体中文 OcrEngine 已知翻车）
        let blocks = vec![mk_block("0囤")];
        let out = postprocess_fullwidth_symbols(blocks);
        assert_eq!(out[0].text, "0℃", "数字+囤 应替换为 ℃");
    }

    #[test]
    fn postprocess_digit_dot_dot_to_dot() {
        // 「1．0」→ 「1.0」（全角小数点 → 半角小数点）
        let blocks = vec![mk_block("剩 555．638")];
        let out = postprocess_fullwidth_symbols(blocks);
        assert_eq!(out[0].text, "剩 555.638");
    }

    #[test]
    fn postprocess_no_change_pure_chinese() {
        // 纯汉字"囤" → 不动（避免误伤）
        let blocks = vec![mk_block("粮囤")];
        let out = postprocess_fullwidth_symbols(blocks);
        assert_eq!(out[0].text, "粮囤");
    }

    #[test]
    fn postprocess_collapse_multiple_spaces() {
        // 连续 ASCII 空格折叠为 1 个
        let blocks = vec![mk_block("Microsoft   Edge")];
        let out = postprocess_fullwidth_symbols(blocks);
        assert_eq!(out[0].text, "Microsoft Edge");
    }

    #[test]
    fn postprocess_cjk_internal_space_removed() {
        // CJK 之间单空格 → 压掉
        let blocks = vec![mk_block("阿 里 百 炼")];
        let out = postprocess_fullwidth_symbols(blocks);
        assert_eq!(out[0].text, "阿里百炼");
    }

    // ===== postprocess_ocr_known_errors 已删除（2026-07-22 用户反馈"逐字打补丁不可持续"）。
    //       翻车修正改走 Layer 2/3 自检 + 重识别（detect_ocr_garble_score +
    //       rerun_if_garble_detected），不依赖任何具体字符的"经验规则"）。
    //       历史 commit 0886356 / 1fc405f 仍可查到旧实现备查。 =====

    #[test]
    fn lcs_similarity_identical_strings() {
        // 完全相同 → 1.0
        let s = lcs_similarity("Microsoft Edge", "Microsoft Edge");
        assert!((s - 1.0).abs() < 1e-6);
    }

    #[test]
    fn lcs_similarity_disjoint_strings() {
        // 完全无关 → 接近 0
        let s = lcs_similarity("abc", "xyz");
        assert!(s < 0.1, "lcs_similarity(disjoint) = {}", s);
    }

    #[test]
    fn lcs_similarity_partial_overlap() {
        // "激活 Windows" vs "到 \"\"次敫活 VVindowso"
        // LCS = "Windows" 长度 7
        // sim = 2*7 / (8 + 18) ≈ 0.5385 → 边界 (< 0.6 不算重复)
        let s = lcs_similarity("激活 Windows", "到 \"\"次敫活 VVindowso");
        assert!(s < 0.6, "期望 sim < 0.6, 实际 {}", s);
        // 验证: "激活 Windows" vs "激活 VWindowso" sim 应更高
        let s2 = lcs_similarity("激活 Windows", "激活 VWindowso");
        assert!(s2 > 0.5, "期望 sim > 0.5, 实际 {}", s2);
    }

    #[test]
    fn postprocess_english_word_space_kept() {
        // 英文单词之间必要空格保留
        let blocks = vec![mk_block("Microsoft Edge")];
        let out = postprocess_fullwidth_symbols(blocks);
        assert_eq!(out[0].text, "Microsoft Edge");
    }

    #[test]
    fn postprocess_remove_ideographic_space() {
        // U+3000 全角空格 → 半角空格
        let blocks = vec![mk_block("百\u{3000}炼\u{3000}平台")];
        let out = postprocess_fullwidth_symbols(blocks);
        // "百 炼 平台" 再走 CJK-CJK 单空格规则 → "百炼平台"
        assert_eq!(out[0].text, "百炼平台");
    }

    #[test]
    fn postprocess_remove_zero_width_chars() {
        // 零宽字符 U+200B 删除
        let blocks = vec![mk_block("百\u{200B}炼")];
        let out = postprocess_fullwidth_symbols(blocks);
        assert_eq!(out[0].text, "百炼");
    }

    // ===== attach_heuristic_confidence 单元测试 =====

    #[test]
    fn confidence_multi_class_high() {
        // 多字符类混合行 → confidence 应 ≥ 0.7
        let blocks = vec![mk_block("Microsoft Edge 的新启动")];
        let out = attach_heuristic_confidence(blocks);
        let c = out[0].confidence;
        assert!((0.7..=0.98).contains(&c), "多类混合行 confidence={}", c);
    }

    #[test]
    fn confidence_single_char_mid() {
        // 单字行 → confidence 实际落在 0.5~0.85 区间（dim1=0.7 + 字符类单一 0.65）
        // 不强制 < 0.7，因为单字也可能是有意义的字（如"中"、"国"）
        let blocks = vec![mk_block("中")];
        let out = attach_heuristic_confidence(blocks);
        let c = out[0].confidence;
        assert!(
            (0.5..=0.85).contains(&c),
            "单字行 confidence={} 应在 0.5~0.85",
            c
        );
    }

    #[test]
    fn confidence_in_range() {
        // 所有 confidence 必须钳制在 0.5..=0.98
        let blocks = vec![
            mk_block("微软"),
            mk_block("a"),
            mk_block("123"),
            mk_block("Microsoft Edge 浏览器"),
        ];
        let out = attach_heuristic_confidence(blocks);
        for b in &out {
            assert!((0.5..=0.98).contains(&b.confidence), "越界: {}", b.confidence);
        }
    }

    // ===== reassemble_words_to_lines 单元测试 =====

    #[test]
    fn reassemble_groups_by_line_index() {
        // 验证 line_index 聚类 + 行内 word_index 排序 + 不加空格
        // 数据：line_index=0 (y=0.2) 是 "Microsoft Edge" 行；
        //      line_index=1 (y=0.1) 是 "百炼" 行。
        // 排序后按 y 升序：line_index=1 (y=0.1) → "百炼" 在前，
        //                 line_index=0 (y=0.2) → "Microsoft Edge" 在后
        let words = vec![
            WinWord { text: "百".into(), x: 0.3, y: 0.1, w: 0.05, h: 0.05, line_index: 1, word_index: 0 },
            WinWord { text: "炼".into(), x: 0.35, y: 0.1, w: 0.05, h: 0.05, line_index: 1, word_index: 1 },
            WinWord { text: "Microsoft".into(), x: 0.05, y: 0.2, w: 0.1, h: 0.05, line_index: 0, word_index: 0 },
            WinWord { text: "Edge".into(), x: 0.16, y: 0.2, w: 0.08, h: 0.05, line_index: 0, word_index: 1 },
        ];
        let blocks = reassemble_words_to_lines(words);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].text, "百炼");
        assert_eq!(blocks[1].text, "Microsoft Edge"); // P0#4 (2026-07-22): Latin-Latin word 之间加 1 空格
    }

    // ===== P0#4 join_words_for_line 行为单测 =====
    // 注释：以下 4 个测试用 vec![] 是因为接下来要 .iter().collect() 拿 Vec<&WinWord>
    // 给 join_words_for_line(&[&WinWord])，clippy useless_vec 不影响语义。
    #[allow(clippy::useless_vec)]
    #[test]
    fn join_cjk_cjk_no_space() {
        // CJK 紧贴：阿 + 里 + 百 + 炼 → 阿里百炼
        let words = vec![
            mk_word("阿", 0, 0, 0.1, 0.05),
            mk_word("里", 1, 0, 0.1, 0.05),
            mk_word("百", 2, 0, 0.1, 0.05),
            mk_word("炼", 3, 0, 0.1, 0.05),
        ];
        let w: Vec<&WinWord> = words.iter().collect();
        assert_eq!(join_words_for_line(&w), "阿里百炼");
    }

    #[allow(clippy::useless_vec)]
    #[test]
    fn join_latin_latin_space() {
        // Latin-Latin 加空格：Microsoft + Edge → Microsoft Edge
        let words = vec![
            mk_word("Microsoft", 0, 0, 0.1, 0.05),
            mk_word("Edge", 1, 0, 0.1, 0.05),
        ];
        let w: Vec<&WinWord> = words.iter().collect();
        assert_eq!(join_words_for_line(&w), "Microsoft Edge");
    }

    #[allow(clippy::useless_vec)]
    #[test]
    fn join_cjk_latin_mixed() {
        // CJK-Latin 跨语种加空格：阿里 + 大模型 → 阿里 大模型
        let words = vec![
            mk_word("阿里", 0, 0, 0.1, 0.05),
            mk_word("大", 1, 0, 0.1, 0.05),
            mk_word("模型", 2, 0, 0.1, 0.05),
        ];
        let w: Vec<&WinWord> = words.iter().collect();
        // "阿里"+"大" 是 CJK-CJK（"里"+"大"），无空格
        // "大"+"模型" 是 CJK-CJK（"大"+"模"），无空格
        // 所以结果应该是 "阿里大模型" —— 跨语种加了空格但这里 word 边界不是跨语种
        assert_eq!(join_words_for_line(&w), "阿里大模型");
    }

    #[allow(clippy::useless_vec)]
    #[test]
    fn join_real_cjk_latin_mixed() {
        // 真实跨语种：阿 + 里 + Edge
        // "阿"+"里" CJK-CJK 无空格
        // "里"+"Edge" CJK-Latin 加空格
        let words = vec![
            mk_word("阿", 0, 0, 0.1, 0.05),
            mk_word("里", 1, 0, 0.1, 0.05),
            mk_word("Edge", 2, 0, 0.1, 0.05),
        ];
        let w: Vec<&WinWord> = words.iter().collect();
        assert_eq!(join_words_for_line(&w), "阿里 Edge");
    }

    fn mk_word(text: &str, idx: i32, y: u32, w: f64, h: f64) -> WinWord {
        WinWord {
            text: text.to_string(),
            x: 0.05 + idx as f64 * 0.1,
            y: y as f64 * 0.1,
            w,
            h,
            line_index: 0,
            word_index: idx,
        }
    }

    #[test]
    fn reassemble_fallback_to_y_clustering() {
        // 无 line_index → 按 y 坐标聚类
        let words = vec![
            WinWord { text: "阿".into(), x: 0.1, y: 0.1, w: 0.05, h: 0.05, line_index: -1, word_index: 0 },
            WinWord { text: "里".into(), x: 0.15, y: 0.1, w: 0.05, h: 0.05, line_index: -1, word_index: 1 },
            WinWord { text: "下".into(), x: 0.1, y: 0.2, w: 0.05, h: 0.05, line_index: -1, word_index: 0 },
            WinWord { text: "一".into(), x: 0.15, y: 0.2, w: 0.05, h: 0.05, line_index: -1, word_index: 1 },
        ];
        let blocks = reassemble_words_to_lines(words);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].text, "阿里");
        assert_eq!(blocks[1].text, "下一");
    }

    // ===== P0#3 remap_blocks_to_global 单测 =====
    // 切块后子图 word 坐标必须重映射到原图全局坐标，否则合并去重会失效。
    #[test]
    fn remap_sub_to_global_horizontal_split() {
        // 原图 4000x1000（长边 4000 > 3000，触发切块）
        // 切 w 轴两块：每块长 2000，重叠 1000，offset 0 / 1000
        // 子图 1 的 (0.5, 0.3, 0.1, 0.05) 应映射到 (0.25, 0.3, 0.05, 0.05)
        // 子图 2 的 (0.0, 0.3, 0.1, 0.05) 应映射到 (0.25, 0.3, 0.05, 0.05)
        // ——两个子图重叠中央区的同一段文字归一化坐标完全一致
        let chunk = ChunkInfo {
            path: std::path::PathBuf::from("/tmp/fake.png"),
            norm_offset_x: 0.0,
            norm_offset_y: 0.0,
            sub_w: 2000,
            sub_h: 1000,
            orig_w: 4000,
            orig_h: 1000,
            cut_norm: 0.5,
            is_w_split: true,
        };
        let mut blocks = vec![OcrBlock {
            text: "重叠区".into(),
            x: 0.5,
            y: 0.3,
            w: 0.1,
            h: 0.05,
            confidence: 0.8,
        }];
        remap_blocks_to_global(&mut blocks, &chunk);
        // x_global = 0.5 * (2000/4000) + 0.0 = 0.25
        // w_global = 0.1 * (2000/4000) = 0.05
        assert!((blocks[0].x - 0.25).abs() < 1e-9);
        assert!((blocks[0].w - 0.05).abs() < 1e-9);
        assert!((blocks[0].y - 0.3).abs() < 1e-9);
    }

    #[test]
    fn remap_sub_to_global_vertical_split() {
        // 原图 1000x4000（高图），切 h 轴
        // 第二个 chunk offset_y = 0.5
        let chunk = ChunkInfo {
            path: std::path::PathBuf::from("/tmp/fake.png"),
            norm_offset_x: 0.0,
            norm_offset_y: 0.5,
            sub_w: 1000,
            sub_h: 2000,
            orig_w: 1000,
            orig_h: 4000,
            cut_norm: 0.5,
            is_w_split: false,
        };
        let mut blocks = vec![OcrBlock {
            text: "下半图".into(),
            x: 0.3,
            y: 0.0,
            w: 0.1,
            h: 0.05,
            confidence: 0.8,
        }];
        remap_blocks_to_global(&mut blocks, &chunk);
        // y_global = 0.0 * (2000/4000) + 0.5 = 0.5
        assert!((blocks[0].y - 0.5).abs() < 1e-9);
        assert!((blocks[0].h - 0.025).abs() < 1e-9);
    }

    // ===== P0#3 merge_ocr_results_horizontal 单测 =====
    #[test]
    fn merge_dedup_overlap() {
        // 模拟重叠区同一段文字，验证去重保留 confidence 高的
        let primary = OcrResult {
            text: "阿里百炼".into(),
            blocks: vec![OcrBlock {
                text: "阿里百炼".into(),
                x: 0.3,
                y: 0.1,
                w: 0.2,
                h: 0.05,
                confidence: 0.85,
            }],
        };
        let secondary = OcrResult {
            text: "阿里百炼".into(),
            blocks: vec![OcrBlock {
                text: "阿里百炼".into(),
                x: 0.31, // 中心距离 0.01 < 0.05，视为同块
                y: 0.1,
                w: 0.2,
                h: 0.05,
                confidence: 0.95,
            }],
        };
        let merged = merge_ocr_results_horizontal(primary, secondary, 0.5, true);
        assert_eq!(merged.blocks.len(), 1);
        // 保留 confidence 高的
        assert!((merged.blocks[0].confidence - 0.95).abs() < 1e-9);
    }

    #[test]
    fn merge_keep_distinct_same_text() {
        // 同文本但 y 距离远（不同行）→ 保留两份
        let primary = OcrResult {
            text: "Microsoft".into(),
            blocks: vec![OcrBlock {
                text: "Microsoft".into(),
                x: 0.1,
                y: 0.1,
                w: 0.2,
                h: 0.05,
                confidence: 0.9,
            }],
        };
        let secondary = OcrResult {
            text: "Microsoft".into(),
            blocks: vec![OcrBlock {
                text: "Microsoft".into(),
                x: 0.1,
                y: 0.5, // 远
                w: 0.2,
                h: 0.05,
                confidence: 0.9,
            }],
        };
        let merged = merge_ocr_results_horizontal(primary, secondary, 0.5, true);
        // 量化 y 行号不同（10 vs 50）→ 保留两份
        assert_eq!(merged.blocks.len(), 2);
    }

    // ===== P1#6 luma_contrast_score 单测 =====
    #[test]
    fn luma_contrast_score_pure_white() {
        // 纯白图：方差应为 0
        let img = image::GrayImage::from_pixel(100, 100, image::Luma([255]));
        let score = luma_contrast_score(&img);
        assert!(score < 1.0, "纯白图方差应接近 0，实际={}", score);
    }

    #[test]
    fn luma_contrast_score_high_contrast() {
        // 棋盘格：黑白交替，方差应 > 10000
        let mut img = image::GrayImage::new(100, 100);
        for y in 0..100 {
            for x in 0..100 {
                let v = if (x / 10 + y / 10) % 2 == 0 { 0 } else { 255 };
                img.put_pixel(x, y, image::Luma([v]));
            }
        }
        let score = luma_contrast_score(&img);
        assert!(score > 10000.0, "棋盘格方差应 > 10000，实际={}", score);
    }

    // ===== 2026-07-22 翻车自检 + 智能重识别 单测 =====
    //
    // 这些测试不依赖 OCR 引擎或文件系统，纯算法可测。
    // 验证逻辑：detect_ocr_garble_score 输入翻车样本 → score 接近 1；
    //                     输入健康样本 → score 接近 0。

    fn mk_block_with(text: &str, x: f64, y: f64, w: f64, h: f64) -> OcrBlock {
        OcrBlock {
            text: text.to_string(),
            x,
            y,
            w,
            h,
            confidence: 0.85,
        }
    }

    #[test]
    fn garble_score_healthy_text_low_score() {
        // 健康样本：3 行中文，h/w 比例正常，无单字行
        let blocks = vec![
            mk_block_with("你好世界", 0.05, 0.05, 0.30, 0.05),
            mk_block_with("Microsoft Edge", 0.05, 0.15, 0.40, 0.05),
            mk_block_with("阿里百炼", 0.05, 0.25, 0.20, 0.05),
        ];
        let score = detect_ocr_garble_score(&blocks);
        assert!(score < 0.3, "健康样本 score 应 < 0.3，实际={}", score);
    }

    #[test]
    fn garble_score_high_single_char_ratio() {
        // 翻车样本：10 个块，9 个是单字（典型抗锯齿把字拆碎）
        let blocks = vec![
            mk_block_with("你", 0.05, 0.05, 0.05, 0.05),
            mk_block_with("好", 0.10, 0.05, 0.05, 0.05),
            mk_block_with("世", 0.15, 0.05, 0.05, 0.05),
            mk_block_with("界", 0.20, 0.05, 0.05, 0.05),
            mk_block_with("M", 0.05, 0.15, 0.05, 0.05),
            mk_block_with("i", 0.10, 0.15, 0.05, 0.05),
            mk_block_with("c", 0.15, 0.15, 0.05, 0.05),
            mk_block_with("r", 0.20, 0.15, 0.05, 0.05),
            mk_block_with("o", 0.25, 0.15, 0.05, 0.05),
            mk_block_with("完整文本", 0.05, 0.25, 0.20, 0.05),
        ];
        let score = detect_ocr_garble_score(&blocks);
        assert!(score >= 0.4, "单字行占比 90% 应 score >= 0.4，实际={}", score);
    }

    #[test]
    fn garble_score_fragmented_rows() {
        // 翻车样本：同一 y 量化行有 5 个单字（切块碎片）
        let blocks = vec![
            mk_block_with("阿", 0.05, 0.10, 0.05, 0.05),
            mk_block_with("里", 0.10, 0.10, 0.05, 0.05),
            mk_block_with("百", 0.15, 0.10, 0.05, 0.05),
            mk_block_with("炼", 0.20, 0.10, 0.05, 0.05),
            mk_block_with("控", 0.25, 0.10, 0.05, 0.05),
        ];
        let score = detect_ocr_garble_score(&blocks);
        assert!(score >= 0.3, "切块碎片应 score >= 0.3，实际={}", score);
    }

    #[test]
    fn garble_score_empty_blocks_max_score() {
        // 空结果 = 100% 翻车
        let blocks: Vec<OcrBlock> = vec![];
        let score = detect_ocr_garble_score(&blocks);
        assert!((score - 1.0).abs() < 1e-6, "空结果应 score=1.0，实际={}", score);
    }

    #[test]
    fn garble_score_aspect_outliers() {
        // 翻车样本：行高/字宽比异常（极窄条）
        let blocks = vec![
            mk_block_with("正常行", 0.05, 0.05, 0.30, 0.05),
            // 极窄条：w=0.01, h=0.05 → aspect = 5（边界外）
            mk_block_with("碎", 0.05, 0.15, 0.01, 0.05),
            mk_block_with("片", 0.07, 0.15, 0.01, 0.05),
            mk_block_with("片", 0.09, 0.15, 0.01, 0.05),
            mk_block_with("片", 0.11, 0.15, 0.01, 0.05),
        ];
        let score = detect_ocr_garble_score(&blocks);
        assert!(score >= 0.3, "极窄条应 score >= 0.3，实际={}", score);
    }

    // ===== Otsu 二值化单测 =====

    #[test]
    fn otsu_binarize_clear_bimodal() {
        // 双峰直方图：浅色背景（240）+ 深色文字（10）。
        // 模拟真实截图（白底黑字）。Otsu 应在 100~150 区间找阈值。
        // 故意用 text=10 (远离 0) 避免 Otsu first-max 把 t 选到 text 边界。
        let mut img = image::GrayImage::new(100, 100);
        for y in 0..100 {
            for x in 0..100 {
                let v = if (20..80).contains(&x) && (20..80).contains(&y) {
                    10
                } else {
                    240
                };
                img.put_pixel(x, y, image::Luma([v as u8]));
            }
        }
        let mut buf = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        let path = otsu_binarize_to_temp_png(&buf).expect("Otsu 应成功");
        assert!(path.exists());
        // 验证输出图是纯 0/255 二值（读 RGB8 防 Luma 转换中间值）
        let decoded = image::open(&path).unwrap().to_rgb8();
        let mut zero_count = 0;
        let mut full_count = 0;
        for p in decoded.pixels() {
            let r = p.0[0];
            let g = p.0[1];
            let b = p.0[2];
            let v0 = r == 0 && g == 0 && b == 0;
            let v1 = r == 255 && g == 255 && b == 255;
            if v0 {
                zero_count += 1;
            } else if v1 {
                full_count += 1;
            } else {
                panic!("Otsu 输出应纯 (0,0,0)/(255,255,255)，发现 ({},{},{})", r, g, b);
            }
        }
        assert!(
            zero_count > 0 && full_count > 0,
            "Otsu 输出应同时含 0 和 255：zero={} full={}",
            zero_count,
            full_count
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn otsu_binarize_skips_when_no_raw_bytes() {
        // 仅保证 rerun_if_garble_detected 在 raw_bytes=None 时返回原结果不重跑
        let primary_blocks = vec![mk_block_with("正常", 0.05, 0.05, 0.30, 0.05)];
        let primary = OcrResult {
            text: "正常".to_string(),
            blocks: primary_blocks,
        };
        // health path：score 低 + 无 raw_bytes → 立刻返回原结果
        let result = rerun_if_garble_detected(primary, None, None).unwrap();
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(result.blocks[0].text, "正常");
    }

    #[test]
    fn consensus_merge_picks_majority_across_passes() {
        // 模拟形近替换：主路把"千问"识成"干问"，二值化 pass 与放大 pass 都识成"千问"
        // → 2/3 多数投票应纠正为"千问"（通用集成，不靠任何字符映射）
        let p1 = OcrResult {
            text: "干问".to_string(),
            blocks: vec![mk_block_with("干问", 0.10, 0.50, 0.30, 0.05)],
        };
        let p2 = OcrResult {
            text: "千问".to_string(),
            blocks: vec![mk_block_with("千问", 0.10, 0.50, 0.30, 0.05)],
        };
        let p3 = OcrResult {
            text: "千问".to_string(),
            blocks: vec![mk_block_with("千问", 0.10, 0.50, 0.30, 0.05)],
        };
        let m = consensus_merge(&[p1, p2, p3]);
        assert_eq!(m.blocks.len(), 1, "同一位置应合并为 1 块");
        assert_eq!(m.blocks[0].text, "千问", "共识应纠正形近替换");
    }

    #[test]
    fn consensus_merge_keeps_unique_blocks_per_pass() {
        // p1/p2 都识出"标题"（同一位置 → 合并）；p2 多识出"副标"（不同 y → 保留）
        let p1 = OcrResult {
            text: "标题".to_string(),
            blocks: vec![mk_block_with("标题", 0.10, 0.50, 0.30, 0.05)],
        };
        let p2 = OcrResult {
            text: "标题\n副标".to_string(),
            blocks: vec![
                mk_block_with("标题", 0.10, 0.50, 0.30, 0.05),
                mk_block_with("副标", 0.10, 0.58, 0.30, 0.05),
            ],
        };
        let m = consensus_merge(&[p1, p2]);
        assert_eq!(m.blocks.len(), 2, "对齐的合并、未对齐的保留");
    }

    // ===== P1#35+#38 (2026-07-23): compute_ocr_cap 单元测试 =====

    #[test]
    fn compute_ocr_cap_fallback_when_zero() {
        // 探测失败 raw=0 → 保守 10000
        assert_eq!(compute_ocr_cap(0), 10000);
    }

    #[test]
    fn compute_ocr_cap_scales_with_headroom() {
        // raw=10000 → 10000*0.9 = 9000
        assert_eq!(compute_ocr_cap(10000), 9000);
        // raw=16384 → 14745（向下取整）
        assert_eq!(compute_ocr_cap(16384), 14745);
    }

    #[test]
    fn compute_ocr_cap_clamps_bounds() {
        // 远低于下限 → clamp 到 8000
        assert_eq!(compute_ocr_cap(2000), 8000);
        // 远高于上限 → clamp 到 16384
        assert_eq!(compute_ocr_cap(20000), 16384);
    }

    // ===== P1#35+#38 (2026-07-23): parse_probe_json 单元测试 =====

    #[test]
    fn parse_probe_json_full() {
        let s = r#"{"max_dim":16384,"supported":["en-US","zh-Hans-CN"]}"#;
        let (md, langs) = parse_probe_json(s);
        assert_eq!(md, 16384);
        assert_eq!(langs, vec!["en-US".to_string(), "zh-Hans-CN".to_string()]);
    }

    #[test]
    fn parse_probe_json_empty_supported() {
        // supported 为空数组
        let s = r#"{"supported":[],"max_dim":0}"#;
        let (md, langs) = parse_probe_json(s);
        assert_eq!(md, 0);
        assert!(langs.is_empty());
    }

    #[test]
    fn parse_probe_json_malformed() {
        // 完全不是 JSON → 全部 0 / 空
        let (md, langs) = parse_probe_json("garbage-no-json");
        assert_eq!(md, 0);
        assert!(langs.is_empty());
    }

    // ===== P1#34 (2026-07-23): 跨块长行拼接单元测试 =====

    #[test]
    fn merge_stitches_cross_block_fragments() {
        // 一行被切线(x≈0.5)切到中段：左半 "Activ" 右边缘=0.5，右半 "ator" 左边缘=0.5
        let left = mk_block_with("Activ", 0.45, 0.50, 0.05, 0.05); // 右边缘 = 0.45+0.05 = 0.50
        let right = mk_block_with("ator", 0.50, 0.50, 0.05, 0.05); // 左边缘 = 0.50
        let empty = OcrResult { text: String::new(), blocks: vec![] };
        let secondary = OcrResult {
            text: "Activ\nator".to_string(),
            blocks: vec![left, right],
        };
        let merged = merge_ocr_results_horizontal(empty, secondary, 0.5, true);
        // 应拼接成 1 块 "Activator"
        assert_eq!(merged.blocks.len(), 1, "跨块碎片应拼成 1 块");
        assert_eq!(merged.blocks[0].text, "Activator");
        // x = min = 0.45, w = max_right - min_x = (0.50+0.05) - 0.45 = 0.10
        assert!((merged.blocks[0].x - 0.45).abs() < 1e-9);
        assert!((merged.blocks[0].w - 0.10).abs() < 1e-9);
    }

    #[test]
    fn merge_stitches_with_aligned_cut() {
        // #37 回归：切线被对齐到空白间隙（非 0.5，这里是 0.42），
        // 跨块碎片边缘在 0.42 而非 0.5 → 第三关必须按传入 cut_norm 拼接，
        // 不能用写死的 0.5（否则 #37 会让拼接悄悄失效）。
        let left = mk_block_with("Activ", 0.37, 0.50, 0.05, 0.05); // 右边缘 = 0.37+0.05 = 0.42
        let right = mk_block_with("ator", 0.42, 0.50, 0.05, 0.05); // 左边缘 = 0.42
        let empty = OcrResult { text: String::new(), blocks: vec![] };
        let secondary = OcrResult {
            text: "Activ\nator".to_string(),
            blocks: vec![left, right],
        };
        let merged = merge_ocr_results_horizontal(empty, secondary, 0.42, true);
        // cut 在 0.42（≠0.5）也必须拼成 1 块
        assert_eq!(merged.blocks.len(), 1, "对齐切线(0.42)处跨块碎片仍需拼成 1 块");
        assert_eq!(merged.blocks[0].text, "Activator");
    }

    #[test]
    fn merge_no_stitch_when_not_near_cut() {
        // 两个正常相邻短词，都不在切线附近 → 不拼接（保持独立）
        let a = mk_block_with("New", 0.10, 0.50, 0.08, 0.05); // 右边缘 0.18
        let b = mk_block_with("York", 0.20, 0.50, 0.10, 0.05); // 左边缘 0.20
        let empty = OcrResult { text: String::new(), blocks: vec![] };
        let secondary = OcrResult {
            text: "New\nYork".to_string(),
            blocks: vec![a, b],
        };
        let merged = merge_ocr_results_horizontal(empty, secondary, 0.5, true);
        // 0.18 / 0.20 都不在 0.5±0.05 → 不拼接
        assert_eq!(merged.blocks.len(), 2, "非切线附近的相邻词不应被拼接");
    }
}
