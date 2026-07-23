// Windows OCR 图像预处理：灰度优先 + 上采样 + CLAHE + unsharp + 动态 MaxImageDimension
use super::probe::{get_ocr_caps, compute_ocr_cap};

// ===== 灰度对比度评分（CLAHE 条件启用判定） =====
//
// 用途：判断原图是否"低对比度"——决定是否走 CLAHE。
// 算法：单遍扫描算 luma 均值 + 方差。纯色 / 高对比 UI 截图方差大，跳过 CLAHE；
// 深色模式 / 低饱和 UI 截图方差小，启用 CLAHE 拉开对比度。
// 时间复杂度 O(n)，n = 像素数。
#[cfg(any(target_os = "windows", test))]
pub(crate) fn luma_contrast_score(gray: &image::GrayImage) -> f64 {
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
pub(crate) fn clahe_global(gray: &image::GrayImage, clip_limit: f32) -> image::GrayImage {
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

#[cfg(any(target_os = "windows", test))]
pub(crate) fn preprocess_for_ocr(bytes: Vec<u8>) -> Vec<u8> {
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
