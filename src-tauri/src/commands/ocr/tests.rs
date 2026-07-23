#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::super::*;

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
        let src = include_str!("windows/mod.rs");
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

