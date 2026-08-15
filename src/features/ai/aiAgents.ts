// 专业 AI 智能体（Agent）数据模型 —— 段二借鉴 biosphere-terminal-app 的「笔记助手 / 终端助手」模式。
//
// 设计取舍（与 biosphere 的差异）：
//  - biosphere 的 Agent 工具（terminal/notebook/file）有副作用、会真改系统，故有 ToolRegistry + 权限系统。
//  - snap-craft 的工具（draw_*/redact_area/...）副作用已被 AiToolHost 收敛在截图画布（host.addAnnotation 自动进撤销历史），
//    因此无需权限/工作区，更安全，也更贴合「非侵入」铁律。
//  - 本文件只定义「可配置的助手」：系统提示词 + 所需能力 + 可绑定工具子集 + 模态 + 温度/兜底模型。
//
// 内置助手已移除：AI 智能编辑（OCR+工具改画布）/ 隐私哨兵（OCR+打码）不再作为可配置 agent，
// 改为文档 tab 内的「独立模式开关」（对齐老项目 back/snap-craft），走 Agent 工具循环 + 系统 OCR。
// 用户自定义助手持久化在 localStorage（见 lib/persistence）。

import type { AiCapability, AiConfig } from './aiTypes';
// agentSystem / agentSystemSentinel 现由 AIPanel 在「AI 智能编辑 / 隐私哨兵」模式开关中直接引用。
import { providerById, endpointById, findModel, modelVisionSupport } from './providerConfig';

/** 助手模态：分析（基于 OCR 文本 + 工具循环改画布 / 纯 LLM 对话）。当前版本仅 analyze 一条可执行路径。 */
export type AgentModality = 'analyze' | 'artistic' | 'generate';

export interface AiAgent {
  id: string;
  /** 展示名：内置助手存 i18n key（UI 层用 t() 解析）；用户助手存字面名 */
  name: string;
  /** 一句话说明：同上，内置存 i18n key */
  desc?: string;
  /** 系统提示词（替代 agentSystem / agentSystemSentinel 的固定词） */
  systemPrompt: string;
  /** 运行所需模型能力：不满足时面板显示 CTA（对应 biosphere 的 requiredToolId） */
  requiresCapability?: AiCapability;
  modality: AgentModality;
  /** 可绑定工具（AI_TOOL_DEFS 子集）；留空 = 全部可用 */
  toolIds?: string[];
  /** 温度覆盖（不填用全局 config.temperature） */
  temperature?: number;
  /** 绑定的模型（PROVIDERS 目录里的推荐模型名）；空 = 跟随全局接口设置 */
  modelId?: string;
  /** 兜底模型（可选） */
  fallbackModelId?: string;
  /** 是否内置（内置不可删，可「另存为」自定义） */
  builtin?: boolean;
}

// 内置助手已迁移为文档 tab 内的独立模式开关（非 agent），故不再导出具体 ID，BUILTIN_AGENTS 置空。
// 老项目 back/snap-craft 中 AI 智能编辑 / 隐私哨兵即为 agentMode / sentinelMode 两个开关，
// 通过 agentSystem() / agentSystemSentinel() 走同一套工具循环（OCR + 工具改画布 / 打码）。

export const BUILTIN_AGENTS: AiAgent[] = [];

/** 合并内置 + 用户自定义助手（内置恒定在前，保证顺序稳定） */
export function mergeAgents(userAgents: AiAgent[]): AiAgent[] {
  const user = userAgents.filter((a) => !a.builtin);
  return [...BUILTIN_AGENTS, ...user];
}

/** 助手展示名：内置解析 i18n，用户用字面名 */
export function agentLabel(a: AiAgent, t: (k: string) => string): string {
  return a.builtin ? t(a.name) : a.name;
}
export function agentDesc(a: AiAgent, t: (k: string) => string): string {
  return a.desc ? (a.builtin ? t(a.desc) : a.desc) : '';
}

/** 能力校验：无要求或已具备则通过（沿用全局 capabilities 粗判，供非视觉能力兜底） */
export function agentCapabilityMet(
  a: AiAgent,
  capabilities: AiCapability[] | undefined,
): boolean {
  if (!a.requiresCapability) return true;
  return !!capabilities && capabilities.includes(a.requiresCapability);
}

/**
 * 按「绑定模型」的实际能力校验助手是否可用（取代全局 config.capabilities 粗判）。
 * 关键：能力判断落在助手具体绑定的模型上，而非全局开关——避免「探测过一次 vision 就全放行」
 * 或「纯文本模型绑到视觉助手却放行」的错位。
 *  - 无 requiresCapability → true
 *  - vision：取 agent.modelId（空则 config.model 全局默认）→ modelVisionSupport 实测/声明/启发式
 *     返回 yes→true, no→false, unknown→'unknown'（unknown 视为允许但 UI 给警告）
 *  - 其余能力（image-gen / image-edit，P4 占位）→ 沿用全局 capabilities 粗判（与旧行为一致）
 */
export function agentModelCapable(config: AiConfig, agent: AiAgent): boolean | 'unknown' {
  if (!agent.requiresCapability) return true;
  if (agent.requiresCapability === 'vision') {
    const modelId = agent.modelId ?? config.model;
    const s = modelVisionSupport(config, modelId);
    return s === 'yes' ? true : s === 'no' ? false : 'unknown';
  }
  return (config.capabilities ?? []).includes(agent.requiresCapability);
}

/** 是否应被禁用（能力不满足）：unknown 视为允许，仅 'no' 禁用 */
export function agentModelBlocked(config: AiConfig, agent: AiAgent): boolean {
  return agentModelCapable(config, agent) === false;
}

/** 绑定模型展示名：空 → 跟随全局；命中模型实体 → 供应商 · 接入方式 · 模型名（带 refKey 兜底）。
 *  config 为当前完整三层配置；缺省时直接回退显示 modelId（自定义 refKey）。 */
export function agentModelLabel(
  a: AiAgent,
  t: (k: string) => string,
  config?: AiConfig,
): string {
  if (!a.modelId) return t('ai.agentModelFollowGlobal');
  // 无配置上下文时无法解析三层链路，直接回退显示原始 id（可能是自定义 refKey）
  if (!config) return a.modelId;
  // findModel：兼容旧配置里 modelId 存的是 refKey 而非实体 id 的情况
  const m = findModel(config, a.modelId);
  if (!m) return a.modelId;
  const ep = endpointById(config, m.endpointId);
  const prov = ep ? providerById(config, ep.providerId) : undefined;
  const provName = prov ? (prov.builtin ? t(prov.name) : prov.name) : '';
  return [provName, ep?.name, m.name].filter(Boolean).join(' · ');
}
