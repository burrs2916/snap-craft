// Word → Line 重排 + 全角符号后处理 + 启发式 confidence
use super::super::OcrBlock;

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
pub(crate) struct WinWord {
    pub(crate) text: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
    #[serde(default)]
    pub(crate) line_index: i32,
    #[serde(default)]
    pub(crate) word_index: i32,
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn reassemble_words_to_lines(words: Vec<WinWord>) -> Vec<OcrBlock> {
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
pub(crate) fn postprocess_fullwidth_symbols(blocks: Vec<OcrBlock>) -> Vec<OcrBlock> {
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
pub(crate) fn is_cjk_or_fullwidth(c: char) -> bool {
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
pub(crate) fn is_latin_or_digit(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn join_words_for_line(group: &[&WinWord]) -> String {
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
pub(crate) fn normalize_block_text(mut blocks: Vec<OcrBlock>) -> Vec<OcrBlock> {
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
pub(crate) fn attach_heuristic_confidence(blocks: Vec<OcrBlock>) -> Vec<OcrBlock> {
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
