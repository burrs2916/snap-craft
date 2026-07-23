// 长截图切块 OCR 投票合并：字面去重 + 相似度去重 + 跨块长行拼接
use super::super::{OcrBlock, OcrResult};

// ===== 长截图切块 OCR 投票（仅在调用层使用，不暴露给 PS） =====
//
// 切块边界：长边 > 3000 时切 2 块（中心重叠 50%），分别 OCR 后用
// "文本相同 + 中心距离近"双键去重。
//
// 重要（P0#3, 2026-07-22）：切块的子图 word 坐标已经 remap 到原图全局坐标
// （见 remap_blocks_to_global），所以 merge 时直接用归一化坐标比较即可。
// 去重 key = 文本相同 + 中心距离 < 0.05。
#[cfg(any(target_os = "windows", test))]
pub(crate) fn merge_ocr_results_horizontal(
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
pub(crate) fn lcs_similarity(a: &str, b: &str) -> f64 {
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
