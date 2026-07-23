// Otsu 自适应二值化（Layer 1-A）：治本不修字面，让字符与背景严格分离
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
pub(crate) fn otsu_binarize_to_temp_png(bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    otsu_binarize_inner(bytes, 1)
}

/// 异构第 3 pass 用：二值化前先放大 `factor` 倍（Lanczos3 单通道），
/// 换一种错误模式用于共识引擎平票打破。factor=1 等同 `otsu_binarize_to_temp_png`。
#[cfg(any(target_os = "windows", test))]
pub(crate) fn otsu_binarize_upscaled_to_temp_png(
    bytes: &[u8],
    factor: u32,
) -> Result<std::path::PathBuf, String> {
    otsu_binarize_inner(bytes, factor)
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn otsu_binarize_inner(bytes: &[u8], upscale: u32) -> Result<std::path::PathBuf, String> {
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
