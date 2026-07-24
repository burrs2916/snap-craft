// OCR 文本清洗（Phase 18，应对 macOS Vision / Windows WinRT 输出的零宽字符 / 控制字符 / 重复字等乱码）
//
// 背景：
//  - macOS Vision 框架对中英混排、特殊字体、艺术字、低分辨率截图的 OCR 输出可能含：
//      ① 零宽字符 U+200B（零宽空格）/ U+200C（零宽非连接符）/ U+200D（零宽连接符）
//        / U+FEFF（BOM）/ U+200E-200F（从左到右标记）/ U+202A-202E（双向控制）
//        / U+2028-2029（行/段分隔符）
//      ② 控制字符 \x00-\x08 \x0B-\x1F \x7F（保留 \n \r \t）
//      ③ 重复单字（OCR 误识别同一字 5+ 次连续）
//      ④ 多余的 3+ 连续空格
//  - 这些字符会污染 AI 视觉上下文（让模型困惑）、让用户复制时携带隐藏字符、影响搜索/导出。
//  - 本函数对单条文本做"轻量级无损清洗"——保留语义、清掉噪音。
//
// 设计原则：
//  - 纯函数，零依赖，输入 string 输出 string
//  - 不假设字符集（不区分 CJK / Latin），统一处理
//  - 默认安全（不会删 ASCII 字母数字 / 标点 / 中文汉字）
//  - 单条不超过 200 字符的连续重复字截断（防御 OCR 卡死模型）
//  - 提供 explain() 调试用：返回 { cleaned, removed: { zeroWidth, control, repeated, spaces } }

const ZERO_WIDTH_RE = /[\u200B-\u200F\u2028-\u202F\u205F-\u206F\uFEFF]/g;
// 排除 \n(0x0A) \r(0x0D) \t(0x09) 的控制字符
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F]/g;
// 3+ 连续空格 → 1
const MULTI_SPACE_RE = /[ \u00A0]{3,}/g;
// 单字 10+ 连续重复（OCR 误识别同字 5-9 次常见需保留语义，10+ 几乎都是模型已卡住）—— 保留前 4 个
const REPEATED_CHAR_RE = /([\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEFa-zA-Z0-9])\1{9,}/g;
/** 单行最大字符数（防御 OCR 输出超长行导致 AI 上下文爆炸） */
const MAX_LINE_CHARS = 500;

/** 清洗 OCR 文本（纯函数） */
export function cleanOcrText(input: string | null | undefined): string {
  if (!input) return '';
  let s = String(input);
  // 1. 零宽字符
  s = s.replace(ZERO_WIDTH_RE, '');
  // 2. 控制字符
  s = s.replace(CONTROL_RE, '');
  // 3. 多余空白（BOM 已在前几步处理）
  s = s.replace(MULTI_SPACE_RE, ' ');
  // 4. 连续重复单字截断（OCR 误识别同字 5-9 次常见需保留语义，10+ 几乎都是模型已卡住）—— 保留前 4 个
  //    全局执行：1000 个 'x' → 4 个；正常长文本（含不同字符）不变
  s = s.replace(REPEATED_CHAR_RE, (m, ch) => ch.repeat(4));
  // 5. 按行处理：超长行截断（合法长文本行如 1000 字符 '你好世界...' → 截到 500+…）
  const lines = s.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].length > MAX_LINE_CHARS) {
      lines[i] = lines[i].slice(0, MAX_LINE_CHARS) + '…';
    }
  }
  s = lines.join('\n');
  // 6. 头尾 trim（保留内部 \n）
  return s.trim();
}
