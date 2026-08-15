import type { AiConfig } from './aiTypes';
import { estimateTokens } from './aiClient';
import { findModel } from './providerConfig';

// 模型未配置上下文窗口 / 最大输出时的默认。
//  - DEFAULT_CONTEXT_WINDOW：保守默认 32k（宁可低估窗口，让预算多裁历史，也不冒溢出风险）。
//  - DEFAULT_MAX_TOKENS：对齐原 body 的 16384（长文档 / 多截图报告需要），未知模型沿用该值，
//    由 history 预算为其预留空间，保证 input + 16384 ≤ 窗口；若模型真实上限更低，应在
//    模型实体里显式配置 maxTokens（三层模型配置已支持），否则 API 会按 max_tokens 过大报错。
const DEFAULT_CONTEXT_WINDOW = 32_000;
const DEFAULT_MAX_TOKENS = 16_384;
// 单图 token 估算（高 DPI 截图偏保守，留余量；trimHistoryToBudget 用 256，此处更激进以防溢出）
const IMG_TOKEN_EST = 512;
const CHARS_PER_TOKEN = 4;

export interface ModelLimits {
  contextWindow: number;
  maxTokens: number;
}

/** 解析模型真实上下文窗口 / 最大输出（缺省给保守默认，不盲目信 128k）。 */
export function resolveModelLimits(config: AiConfig, modelId?: string): ModelLimits {
  const m = findModel(config, modelId ?? config.model);
  const contextWindow =
    m?.contextWindow && m.contextWindow > 0 ? m.contextWindow : DEFAULT_CONTEXT_WINDOW;
  const maxTokens = m?.maxTokens && m.maxTokens > 0 ? m.maxTokens : DEFAULT_MAX_TOKENS;
  return { contextWindow, maxTokens };
}

export interface FirstTurnFit {
  ocrText?: string;
  ocrTexts?: string[];
  images: string[];
  trimmed: boolean;
  droppedImages: number;
  truncatedOcr: boolean;
}

export interface FitFirstTurnOpts {
  goal: string;
  ocrText?: string;
  ocrTexts?: string[];
  /** 已按「主图在前」排列的图片数组 */
  images: string[];
  /** 首轮 user 消息可用 token 上限（已扣除 system / 记忆 / 输出预留） */
  budgetTokens: number;
  /** 数组前部必须保留的主图张数（不参与丢弃） */
  mainImageCount?: number;
}

/**
 * 首轮自愈裁剪（方案 B）：当「当前需求 + 多张截图 + 长 OCR」本身就可能超模型上下文时，
 * 在装配 user 消息前就把 OCR 文本截断、把最旧的附加截图丢弃（保留主图 + 最近的附加图），
 * 使首轮请求必然落在预算内。与 trimHistoryToBudget（只裁历史轮次）互补，彻底堵住溢出。
 */
export function fitFirstTurn(opts: FitFirstTurnOpts): FirstTurnFit {
  const mainN = Math.max(0, opts.mainImageCount ?? 1);

  // 1) 图片裁剪：前 mainN 张为主图必留；其余附加图从「最旧」（数组头部）开始丢，直至预算够。
  const head = opts.images.slice(0, mainN);
  let keptExtra = opts.images.slice(mainN);
  const within = (h: number, e: number) => h * IMG_TOKEN_EST + e * IMG_TOKEN_EST <= opts.budgetTokens;
  while (keptExtra.length > 0 && !within(head.length, keptExtra.length)) {
    keptExtra.shift();
  }
  // 极端：主图本身过多时，主图也只保留 1 张
  let keptHead = [...head];
  while (keptHead.length > 1 && !within(keptHead.length, keptExtra.length)) {
    keptHead.shift();
  }
  const images = [...keptHead, ...keptExtra];
  const droppedImages = opts.images.length - images.length;

  // 2) OCR 预算 = 剩余 token（扣除图片 + 需求文本），换算成字符预算
  const usedTok = images.length * IMG_TOKEN_EST + estimateTokens(opts.goal);
  const ocrTok = Math.max(0, opts.budgetTokens - usedTok);
  const ocrCharBudget = ocrTok * CHARS_PER_TOKEN;

  let ocrText = opts.ocrText;
  let ocrTexts = opts.ocrTexts;
  const rawOcrLen =
    (ocrText?.length ?? 0) + (ocrTexts ?? []).reduce((s, t) => s + t.length, 0);
  let truncatedOcr = false;
  if (rawOcrLen > 0 && ocrCharBudget > 0 && rawOcrLen > ocrCharBudget) {
    truncatedOcr = true;
    // 当前图 OCR 优先保留（占 60% 预算），其余给附加图 OCR
    const mainBudget = Math.min(ocrText?.length ?? 0, Math.ceil(ocrCharBudget * 0.6));
    if (ocrText && ocrText.length > mainBudget) {
      ocrText = ocrText.slice(0, mainBudget) + '\n…（OCR 已截断）';
    }
    let rest = ocrCharBudget - (ocrText?.length ?? 0);
    if (ocrTexts && ocrTexts.length) {
      const out: string[] = [];
      for (const t of ocrTexts) {
        if (rest <= 0) break;
        const cut = Math.min(t.length, rest);
        out.push(cut < t.length ? t.slice(0, cut) + '\n…（OCR 已截断）' : t);
        rest -= cut;
      }
      ocrTexts = out;
    }
  }

  return {
    ocrText,
    ocrTexts,
    images,
    trimmed: droppedImages > 0 || truncatedOcr,
    droppedImages,
    truncatedOcr,
  };
}
