// OCR 翻车自检 + 智能重识别 + 通用多 pass 共识引擎
use super::super::{OcrBlock, OcrResult};
use super::binarize::{otsu_binarize_to_temp_png, otsu_binarize_upscaled_to_temp_png};
use crate::store;
use super::run_native_ocr_windows_inner;

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
pub(crate) fn detect_ocr_garble_score(blocks: &[OcrBlock]) -> f64 {
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
    let mut short_block_ratio = 0.0; // 块宽显著小于同屏中位块宽的占比
    let mut very_short = 0usize;
    // 先收集有效块宽，求中位数 → 相对阈值。
    // 2026-07-24 修复：旧版用绝对阈值 w<0.05，桌面/密集 UI 截图里所有文字块天然就小
    // （实测 84% 块 <0.05），把正常 UI 误判成切块碎片 → 误触发共识引擎多花 2-3 秒。
    // 改为相对中位块宽：密集 UI 中位宽本身就小，阈值随之降低不再误报；
    // 真切块碎片（远小于同屏正常块）仍会被抓住。
    let mut valid_widths: Vec<f64> = blocks
        .iter()
        .filter(|b| b.h >= 0.001 && b.w >= 0.001)
        .map(|b| b.w)
        .collect();
    valid_widths.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median_w = if valid_widths.is_empty() {
        0.0
    } else {
        valid_widths[valid_widths.len() / 2]
    };
    // 相对阈值 = 中位宽 * 0.4，再用 0.05 绝对上限兜底（防止极大图把阈值抬太高）。
    let very_short_thresh = if median_w > 0.0 {
        (median_w * 0.4).min(0.05)
    } else {
        0.05
    };
    for b in blocks {
        if b.h < 0.001 || b.w < 0.001 {
            continue;
        }
        aspect_count += 1;
        let aspect = b.h / b.w;
        if !(0.05..=5.0).contains(&aspect) {
            aspect_outliers += 1;
        }
        if b.w < very_short_thresh {
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
        // stray：含 CJK 且夹带恰好 2 字母的孤立 ASCII 串（如 "(D:)" 被识成垃圾）。
        // 2026-07-24 修复：旧版 max_latin_run<=2 把单字母也计入，导致「C盘」「D盘」
        // 「E盘」这类正常盘符/单字母+中文 UI 标签被误判为形近错字（桌面截图里极常见），
        // gibberish 虚高 → 误触发共识引擎。单 ASCII 字母/数字紧邻中文是正常 UI 模式，
        // 真正的 OCR 乱码通常是 2+ 字母串，故下界提到 2（恰好 2 字母才报）。
        let stray = has_cjk && has_latin && max_latin_run == 2;
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
pub(crate) fn rerun_if_garble_detected(
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
pub(crate) fn consensus_merge(passes: &[OcrResult]) -> OcrResult {
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
