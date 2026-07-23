// Windows OCR 切块子系统：长截图切 2 块 + 空白带对齐切线 + 坐标重映射
use super::super::OcrBlock;
use super::preprocess::preprocess_for_ocr;

/// 切块产物：子图临时文件 + 它相对原图的归一化 offset
/// （原图尺寸作为分母，把子图 word 坐标平移到原图全局空间用）。
#[cfg(any(target_os = "windows", test))]
pub(crate) struct ChunkInfo {
    pub(crate) path: std::path::PathBuf,
    /// 子图相对原图"长边轴"的归一化起点（0~1）
    pub(crate) norm_offset_x: f64,
    /// 子图相对原图"短边轴"的归一化起点（固定 0）
    pub(crate) norm_offset_y: f64,
    /// 子图宽（像素）
    pub(crate) sub_w: u32,
    /// 子图高（像素）
    pub(crate) sub_h: u32,
    /// 原图宽（像素）
    pub(crate) orig_w: u32,
    /// 原图高（像素）
    pub(crate) orig_h: u32,
    /// 切块切线在原图全局归一化坐标（沿切轴）：w-split→x 轴；h-split→y 轴。
    /// 传给 merge 第三关，让它按「真实切线」而非写死 0.5 判断跨块拼接。
    pub(crate) cut_norm: f64,
    /// 切轴是否为宽轴（true=沿宽切/竖切线，false=沿高切/横切线）
    pub(crate) is_w_split: bool,
}

/// 切长图：长边 > threshold 时切 2 块（左半 + 右半，50% 重叠）。
/// 每个子图**先过 `preprocess_for_ocr` 再写临时文件**，所以子图路径已经是 OCR-ready 状态。
/// 否则返回 None（调用方应走单次识别）。
#[cfg(any(target_os = "windows", test))]
pub(crate) fn split_long_image_for_ocr(path: &std::path::Path, threshold: u32) -> Option<Vec<ChunkInfo>> {
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
pub(crate) fn find_aligned_cut(
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
pub(crate) fn remap_blocks_to_global(blocks: &mut [OcrBlock], chunk: &ChunkInfo) {
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
