// AI 生成预设：把「截图 → 文档 / 文案」的产品愿景拆成具体场景
// 每个预设提供：system 指令 + 用户消息模板（可注入 OCR 原文作为上下文）。
// 指令以中文为主（产品主语言），并明确要求「输出与截图文字相同的语言」。
//
// 2026-07-14 Phase 2b：
//  - buildUser 支持多图 OCR（ocrText 当前图 + ocrTexts 附加图），用于「多截图成稿」。
//  - AiPreset 容许自定义预设（name/desc 直接展示、custom 标记），并新增
//    makeCustomPreset() 工厂，让用户可以保存自己的业务文档/文案模板。

export interface AiPreset {
  id: string;
  /** i18n key（展示名称）——内置预设用 */
  labelKey?: string;
  /** 直接展示名称——自定义预设用（优先于 labelKey） */
  name?: string;
  /** i18n key（一句话说明）——内置预设用 */
  descKey?: string;
  /** 直接说明——自定义预设用 */
  desc?: string;
  /** 是否支持附带截图（视觉模型）；纯文本场景也兼容，只是忽略图片 */
  vision: boolean;
  system: string;
  buildUser: (ctx: { goal: string; ocrText?: string; ocrTexts?: string[] }) => string;
  /** 是否为用户自定义预设 */
  custom?: boolean;
}

/** 单段 OCR 文字块（可带标签，如「当前」「附加1」） */
function withOcr(ocrText?: string, label?: string): string {
  if (!ocrText || !ocrText.trim()) return '';
  const tag = label ? `（${label}）` : '';
  return `\n\n以下是截图${tag}中通过 OCR 识别出的原文文字，供你参考、引用或整合（如与图片不符以图片为准）：\n"""\n${ocrText.trim()}\n"""`;
}

/**
 * 共享的用户消息构造：合并「当前图 OCR」与「多张附加图 OCR」。
 * 所有预设（含自定义）统一走这里，保证多截图叙事一致。
 */
export function buildDefaultUser(ctx: {
  goal: string;
  ocrText?: string;
  ocrTexts?: string[];
}): string {
  const g = (ctx.goal ?? '').trim();
  let ocr = withOcr(ctx.ocrText, '当前');
  (ctx.ocrTexts ?? []).forEach((t, i) => {
    ocr += withOcr(t, `附加${i + 1}`);
  });
  return `${g}${ocr}`;
}

/** 圆数字（①②③…），用于多截图报告里给每张截图标注序号 */
export const CIRCLE = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
export function toCircle(n: number): string {
  return CIRCLE[n - 1] ?? String(n);
}

/**
 * 「多截图成报告」的章节锚点标记：AI 输出中每行 `<!--SNAP:k-->` 表示「此处应插入
 * 第 k 张截图」。导出时据此把图片内嵌到对应章节前，实现真正的图文混排报告。
 * k 从 1 开始，与 AIPanel 发送图片的顺序（当前截图 + 附加截图）一一对应。
 */
export const SNAP_MARKER_RE = /^<!--\s*SNAP:(\d+)\s*-->$/;

/** 移除 AI 输出里的 SNAP 标记行（用于 .md / .txt 导出保持干净） */
export function stripSnapMarkers(md: string): string {
  return (md ?? '')
    .split('\n')
    .filter((l) => !SNAP_MARKER_RE.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 判断一段 Markdown 是否含有 SNAP 章节标记。
 * 注意：必须用「任意位置匹配」而非 `^...$` 整篇锚定——
 * 真实报告是多段正文 + 多个 `<!--SNAP:k-->` 标记，整篇锚定永远为 false，
 * 会导致「图文报告」导出时章节内嵌截图完全失效（已修复）。
 */
export function hasSnapMarkers(md: string): boolean {
  return /<!--\s*SNAP:\d+\s*-->/g.test(md ?? '');
}

/**
 * 「图文报告」专用用户消息构造：按顺序排列多张截图（①当前，②/③附加），
 * 要求模型为每张截图输出独立的 `<!--SNAP:k-->` 锚点章节。
 */
export function buildReportUser(ctx: {
  goal: string;
  ocrText?: string;
  ocrTexts?: string[];
}): string {
  const g = (ctx.goal ?? '').trim();
  let n = 0;
  let blocks = '';
  if (ctx.ocrText && ctx.ocrText.trim()) {
    n += 1;
    blocks += withOcr(ctx.ocrText, `截图${toCircle(n)}（当前）`);
  }
  (ctx.ocrTexts ?? []).forEach((txt, i) => {
    n += 1;
    blocks += withOcr(txt, `截图${toCircle(n)}（附加${i + 1}）`);
  });
  const intro = `下面是按顺序排列的多张截图：截图①为当前截图，截图②/③/…为附加截图。请据此生成一份连贯的图文报告——每张截图对应一节，每节必须以单独一行的标记 <!--SNAP:k--> 开头（k 为该截图序号，从 1 开始、按截图顺序），随后用「## 截图 k：<小节标题>」展开内容并给出你的分析。各节之间要有承上启下的连贯叙述，整篇读起来像一份完整文档而非零散片段。`;
  return `${g ? g + '\n\n' : ''}${intro}${blocks}\n\n请直接输出报告（Markdown，含 <!--SNAP:k--> 标记）。`;
}

// 公共约束：输出 Markdown，结构清晰，可直接使用
const COMMON =
  '你是一个擅长把截图内容转化为结构化文档与文案的助手。' +
  '请使用 Markdown 输出，结构清晰、层次分明、可直接使用。' +
  '若截图中含文字，请尽量整合其信息；输出语言应与截图中文字的语言保持一致（中文截图用中文，英文截图用英文）。';

/** 内置预设的默认 system（任务说明由各预设补充） */
function systemWith(task: string): string {
  return `${COMMON}\n任务：${task}`;
}

export const AI_PRESETS: AiPreset[] = [
  {
    id: 'doc',
    labelKey: 'ai.preset.doc',
    descKey: 'ai.preset.docDesc',
    vision: true,
    system: systemWith('根据这张截图（及其中文字）生成一份结构完整的文档，包含标题、分级小标题、要点与必要的说明。'),
    buildUser: buildDefaultUser,
  },
  {
    id: 'copy',
    labelKey: 'ai.preset.copy',
    descKey: 'ai.preset.copyDesc',
    vision: true,
    system: systemWith('把截图内容改写成吸引人的文案，可用于产品介绍、社交媒体或营销场景。语气可适度生动，但信息须准确。'),
    buildUser: buildDefaultUser,
  },
  {
    id: 'summary',
    labelKey: 'ai.preset.summary',
    descKey: 'ai.preset.summaryDesc',
    vision: true,
    system: systemWith('基于截图的要点，生成一份工作周报或阶段性小结，突出完成项、进行中与待办。'),
    buildUser: buildDefaultUser,
  },
  {
    id: 'tutorial',
    labelKey: 'ai.preset.tutorial',
    descKey: 'ai.preset.tutorialDesc',
    vision: true,
    system: systemWith('把截图内容整理为图文步骤教程，用有序列表逐步说明操作，必要时补充注意事项。'),
    buildUser: buildDefaultUser,
  },
  {
    id: 'bullet',
    labelKey: 'ai.preset.bullet',
    descKey: 'ai.preset.bulletDesc',
    vision: true,
    system: systemWith('提炼截图的核心要点，用要点列表呈现，每条简洁明确，可附简短解释。'),
    buildUser: buildDefaultUser,
  },
  {
    id: 'translate',
    labelKey: 'ai.preset.translate',
    descKey: 'ai.preset.translateDesc',
    vision: true,
    system: systemWith('把截图中的文字翻译为目标语言，保留原有结构（标题、列表等）。若未指定目标语言，默认翻译为英文。'),
    buildUser: buildDefaultUser,
  },
  {
    id: 'free',
    labelKey: 'ai.preset.free',
    descKey: 'ai.preset.freeDesc',
    vision: true,
    system: systemWith('自由回答用户关于这张截图的问题或请求。'),
    buildUser: buildDefaultUser,
  },
  // ── 2026-07-15 Phase 7：预置「业务文档」模板 ───────────────────────────────
  // 直接服务「截图 → 完整文档」的产品愿景：把截图（原型/界面/图表/白板/聊天）
  // 一键生成为真实业务场景可用的结构化文档，无需用户自己写 prompt。
  {
    id: 'bug',
    labelKey: 'ai.preset.bug',
    descKey: 'ai.preset.bugDesc',
    vision: true,
    system:
      '你擅长把一张软件界面/报错截图整理成结构化的缺陷报告。' +
      '请使用 Markdown 输出，包含：① 标题（一句话描述现象）；② 环境（如能从截图推断系统/页面/版本请写明，否则标「待补充」）；' +
      '③ 复现步骤（有序列表）；④ 预期结果；⑤ 实际结果；⑥ 影响范围与严重度建议（P0–P3）；⑦ 附加上报信息（日志/账号/时间等，能推断则写）。' +
      '信息不足处明确标注「待补充」。语言与截图文字保持一致。',
    buildUser: buildDefaultUser,
  },
  {
    id: 'prd',
    labelKey: 'ai.preset.prd',
    descKey: 'ai.preset.prdDesc',
    vision: true,
    system:
      '你擅长把一张原型图 / 界面截图 / 流程图整理成产品需求要点文档。' +
      '请使用 Markdown 输出，包含：① 背景与目标；② 目标用户；③ 核心功能点（分条，必要时二级列表）；' +
      '④ 关键交互与边界说明；⑤ 验收标准（可勾选清单 `- [ ]`）；⑥ 待确认问题。结构清晰、可直接评审。语言与截图文字保持一致。',
    buildUser: buildDefaultUser,
  },
  {
    id: 'compete',
    labelKey: 'ai.preset.compete',
    descKey: 'ai.preset.competeDesc',
    vision: true,
    system:
      '你擅长根据竞品界面 / 功能 / 数据截图生成竞品分析。' +
      '请使用 Markdown 输出，包含：① 分析对象；② 对比维度（用 GFM 表格呈现「维度 | 我方 | 竞品」的差异）；' +
      '③ 各自优势与劣势；④ 机会点与建议。若涉及多张截图，请综合比较而非逐张罗列。语言与截图文字保持一致。',
    buildUser: buildDefaultUser,
  },
  {
    id: 'meeting',
    labelKey: 'ai.preset.meeting',
    descKey: 'ai.preset.meetingDesc',
    vision: true,
    system:
      '你擅长把白板 / 聊天记录 / 文档 / 演示截图整理成会议纪要。' +
      '请使用 Markdown 输出，包含：① 会议主题；② 关键结论；③ 行动项（用表格：事项 | 负责人 | 时限）；' +
      '④ 待跟进问题；⑤ 下一步计划。重点突出结论与责任归属，避免流水账。语言与截图文字保持一致。',
    buildUser: buildDefaultUser,
  },
  {
    id: 'insight',
    labelKey: 'ai.preset.insight',
    descKey: 'ai.preset.insightDesc',
    vision: true,
    system:
      '你擅长解读截图中的图表 / 数据（仪表盘、报表、趋势图、看板）。' +
      '请使用 Markdown 输出，包含：① 数据概览；② 关键趋势与异常（尽量引用图中具体数字）；③ 可能的原因假设；' +
      '④ 业务洞察与建议；⑤ 需要关注的风险点。结论要有数据支撑，不要空泛。语言与截图文字保持一致。',
    buildUser: buildDefaultUser,
  },
  {
    id: 'report',
    labelKey: 'ai.preset.report',
    descKey: 'ai.preset.reportDesc',
    vision: true,
    system: systemWith(
      '把用户提供的多张截图（截图①=当前、截图②/③…=附加）整理成一份连贯的图文报告。' +
        '要求：每张截图对应一节；每节必须以单独一行的标记 <!--SNAP:k--> 开头（k 为阿拉伯数字序号，从 1 开始、按截图顺序），' +
        '其后用「## 截图 k：<标题>」展开内容与分析。各节之间用连贯的叙述衔接，整篇读起来像一份完整文档而非零散片段。',
    ),
    buildUser: buildReportUser,
  },
  {
    id: 'table',
    labelKey: 'ai.preset.table',
    descKey: 'ai.preset.tableDesc',
    vision: true,
    system:
      '你擅长从截图（尤其仪表盘、报表、发票、价目表、数据列表等）中识别结构化数据。' +
      '请把截图里的表格 / 关键数据提取为标准的 GitHub Flavored Markdown 表格：第一行是列标题，其后是数据行，列用 `|` 分隔。' +
      '若截图包含多张独立表格，请依次输出多张 Markdown 表（表与表之间空一行），并为每张表前加一个 `## 表名` 标题。' +
      '若截图没有清晰表格，也请尽量把核心信息整理成一张结构化表格。只输出表格内容，不要额外解释。' +
      '输出语言与截图文字语言保持一致。',
    buildUser: buildDefaultUser,
  },
];

export function getPreset(id: string): AiPreset {
  return AI_PRESETS.find((p) => p.id === id) ?? AI_PRESETS[AI_PRESETS.length - 1];
}

/** 用户自定义预设的持久化形状 */
export interface UserPreset {
  id: string;
  name: string;
  desc?: string;
  system: string;
  vision: boolean;
  /** 用户消息构造器：'default'=普通（含 OCR 上下文）；'report'=图文报告（产出 <!--SNAP:k--> 标记）。缺省 'default'。 */
  userBuilder?: 'default' | 'report';
}

/**
 * 把用户自定义预设转成 AiPreset（复用共享的用户消息构造）。
 * system 缺省时回退到 COMMON，保证至少有基本约束。
 */
export function makeCustomPreset(p: UserPreset): AiPreset {
  // 用户消息构造器：图文报告模式走 buildReportUser（产出 <!--SNAP:k--> 标记），
  // 否则走共享的 buildDefaultUser（含 OCR 上下文）。缺省 'default' 保持向后兼容。
  const buildUser = p.userBuilder === 'report' ? buildReportUser : buildDefaultUser;
  return {
    id: p.id,
    name: p.name,
    desc: p.desc,
    vision: p.vision,
    system: p.system?.trim() ? p.system.trim() : COMMON,
    buildUser,
    custom: true,
  };
}
