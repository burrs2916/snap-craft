// 智能体（Agent）管理 —— 段二借鉴 biosphere 的 AgentManager。
// 列表态：卡片化；编辑态：独立 overlay 模态（覆盖 AI 面板窗口，body 可滚动，绝不被裁切）。
// 仅管理「可配置的助手」：系统提示词 / 模态 / 所需能力 / 可绑定工具 / 温度 / 兜底模型。

import { useState } from 'react';
import { t } from '../../i18n';
import { AI_TOOL_DEFS, toolLabel } from './aiTools';
import { MODALITY_LABEL_KEY } from './providers';
import type { AiModality, AiConfig } from './aiTypes';
import { modelTree, modelVisionSupport, modelChatUsable } from './providerConfig';
import { agentLabel, agentDesc, agentModelLabel, type AiAgent } from './aiAgents';

const MODALITIES: AiModality[] = ['analyze'];

function blankAgent(): AiAgent {
  return {
    id: '',
    name: '',
    desc: '',
    systemPrompt: '',
    modality: 'analyze',
    requiresCapability: undefined,
    // 留空 = 全部工具（运行时 aiStore 对 undefined/[] 均按全部处理）
    toolIds: undefined,
    temperature: undefined,
    fallbackModelId: undefined,
    modelId: undefined,
    builtin: false,
  };
}

/** 全部工具名（用于「未显式限定 = 全部可用」的双向换算） */
const ALL_TOOL_NAMES = AI_TOOL_DEFS.map((d) => d.name);

function genId(): string {
  return 'agent-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

interface Props {
  agents: AiAgent[];
  /** 当前完整三层配置（provider/endpoint/model），用于绑定模型下拉与展示 */
  config: AiConfig;
  onClose: () => void;
  onUpsert: (a: AiAgent) => void;
  onDelete: (id: string) => void;
}

export function AiAgentManager({ agents, config, onClose, onUpsert, onDelete }: Props) {
  const [editing, setEditing] = useState<AiAgent | null>(null);

  const startNew = () => setEditing(blankAgent());
  // 编辑：内置助手清空 id（保存时生成自定义副本），且副本默认调用全部工具；
  // 自定义助手保留原 id 就地改，并保留其已设定的工具子集。
  const startEdit = (a: AiAgent) =>
    setEditing({ ...a, id: a.builtin ? '' : a.id, toolIds: a.builtin ? undefined : a.toolIds });

  const save = () => {
    if (!editing) return;
    const name = editing.name.trim();
    const sys = editing.systemPrompt.trim();
    if (!name || !sys || !editing.modelId) return; // 基础校验，缺项不保存
    const finalAgent: AiAgent = {
      ...editing,
      id: editing.id || genId(),
      name,
      systemPrompt: sys,
      builtin: false,
      // 纯 LLM+OCR 范围下不再暴露「所需能力」：统一视为无能力要求，避免 image-gen/image-edit
      // 等被选中后把助手（capOk=false）锁死跑不了。
      requiresCapability: undefined,
      temperature: editing.temperature && editing.temperature > 0 ? editing.temperature : undefined,
    };
    onUpsert(finalAgent);
    setEditing(null);
  };

  // 切换工具：未显式限定时视为「全部已选」，首次取消勾选才落为具体子集；
  // 重新全选则回退 undefined（=全部），避免空数组的歧义。
  const toggleTool = (name: string, on: boolean) => {
    if (!editing) return;
    const cur = editing.toolIds && editing.toolIds.length ? editing.toolIds : ALL_TOOL_NAMES;
    const next = on
      ? Array.from(new Set([...cur, name]))
      : cur.filter((x) => x !== name);
    setEditing({
      ...editing,
      toolIds: next.length === ALL_TOOL_NAMES.length ? undefined : next,
    });
  };

  // 管理页只展示用户自建助手；内置模板（截图分析 / 隐私哨兵）恒在 doc tab 助手下拉里可选，不在此 CRUD 列表。
  const customAgents = agents.filter((a) => !a.builtin);

  // 模型下拉选项（主模型与兜底模型共用）：按三层配置 provider/endpoint/model 分组，
  // 视频/图像生成类模型（chatOk=false）禁用，避免选成不可对话的模型。
  const renderModelOptions = () =>
    modelTree(config).flatMap(({ provider, endpoints }) =>
      endpoints
        .filter(({ models }) => models.length > 0)
        .map(({ endpoint, models }) => {
          const epLabel = `${provider.builtin ? t(provider.name) : provider.name}${endpoint.name ? ` · ${endpoint.name}` : ''}${endpoint.baseUrl ? ` · ${endpoint.baseUrl.replace(/^https?:\/\//, '')}` : ''}`;
          return (
            <optgroup key={endpoint.id} label={epLabel}>
              {models.map((m) => {
                const vs = modelVisionSupport(config, m.id);
                const chatOk = modelChatUsable(config, m.id);
                const capSuffix = !chatOk
                  ? ' · 视频✗'
                  : vs === 'yes'
                    ? ' · 视觉'
                    : vs === 'no'
                      ? ' · 仅文本'
                      : '';
                return (
                  <option
                    key={m.id}
                    value={m.id}
                    disabled={!chatOk}
                    title={`${provider.builtin ? t(provider.name) : provider.name} · ${endpoint.name || endpoint.apiType} · ${endpoint.baseUrl}${!chatOk ? ' · 视频生成模型，不可作为对话助手' : vs === 'yes' ? ' · 支持图片' : vs === 'no' ? ' · 仅文本' : ' · 视觉能力未知'}`}
                  >
                    {m.refKey && m.refKey !== m.name ? `${m.name} (${m.refKey})` : m.name}{capSuffix}
                  </option>
                );
              })}
            </optgroup>
          );
        }),
    );

  return (
    <>
      {/* 列表态：卡片化 */}
      <div className="ai-agent">
        <div className="ai-agent-bar">
          <span className="ai-agent-bar-title">{t('ai.agentManage')}</span>
          <button className="ai-agent-add" type="button" onClick={startNew}>+ {t('ai.agentNew')}</button>
          <button className="ai-agent-back" type="button" title={t('ai.close')} onClick={onClose}>✕</button>
        </div>

        {customAgents.length === 0 ? (
          <div className="ai-agent-empty">
            <div className="ai-agent-empty-ico">🤖</div>
            <div className="ai-agent-empty-text">{t('ai.agentEmpty')}</div>
          </div>
        ) : (
          <div className="ai-agent-list">
            {customAgents.map((a) => (
              <div key={a.id} className="ai-agent-card">
                <div className="ai-agent-card-top">
                  <span className="ai-agent-card-ico">🤖</span>
                  <div className="ai-agent-card-meta">
                    <div className="ai-agent-card-name">
                      {agentLabel(a, t)}
                    </div>
                    {a.desc && <div className="ai-agent-card-desc">{agentDesc(a, t)}</div>}
                  </div>
                </div>
                <div className="ai-agent-card-tags">
                  <span className="ai-agent-tag">{t(MODALITY_LABEL_KEY[a.modality])}</span>
                  <span className="ai-agent-tag ai-agent-tag-model">{agentModelLabel(a, t, config)}</span>
                </div>
                <div className="ai-agent-card-actions">
                  <button className="ai-link" type="button" onClick={() => startEdit(a)}>{t('ai.edit')}</button>
                  <button className="ai-link ai-link-danger" type="button" onClick={() => onDelete(a.id)}>{t('ai.delete')}</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 编辑态：独立 overlay 模态，覆盖整个 AI 面板窗口；body 内部滚动，输入框绝不被裁剪 */}
      {editing && (
        <div className="ai-agent-overlay" onClick={() => setEditing(null)}>
          <div className="ai-agent-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ai-agent-modal-head">
              <span className="ai-agent-modal-ico">🤖</span>
              <span className="ai-agent-modal-title">
                {editing.id ? t('ai.agentEdit') : t('ai.agentNew')}
              </span>
              <button className="ai-agent-modal-close" type="button" onClick={() => setEditing(null)}>✕</button>
            </div>

            <div className="ai-agent-modal-body">
              <div className="ai-agent-sec">
                <div className="ai-agent-sec-title">{t('ai.agentSecBasic')}</div>
                <label className="ai-agent-label">{t('ai.agentFieldName')}</label>
                <input
                  className="ai-agent-input"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder={t('ai.agentFieldNamePh')}
                />
                <label className="ai-agent-label">{t('ai.agentFieldDesc')}</label>
                <input
                  className="ai-agent-input"
                  value={editing.desc ?? ''}
                  onChange={(e) => setEditing({ ...editing, desc: e.target.value })}
                  placeholder={t('ai.agentFieldDescPh')}
                />
                <label className="ai-agent-label">{t('ai.agentFieldModel')}</label>
                <select
                  className="ai-agent-input"
                  value={editing.modelId ?? ''}
                  onChange={(e) => setEditing({ ...editing, modelId: e.target.value || undefined })}
                >
                  <option value="" disabled>{t('ai.agentFieldModelPh')}</option>
                  {renderModelOptions()}
                </select>
                {modelTree(config).length === 0 && (
                  <div className="ai-agent-hint">{t('ai.agentNoModelHint')}</div>
                )}
              </div>

              <div className="ai-agent-sec">
                <div className="ai-agent-sec-title">{t('ai.agentSecExec')}</div>
                <div className="ai-agent-row2">
                  <div>
                    <label className="ai-agent-label">{t('ai.agentFieldTemp')}</label>
                    <input
                      className="ai-agent-input"
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      value={editing.temperature ?? ''}
                      onChange={(e) =>
                        setEditing({ ...editing, temperature: e.target.value ? Number(e.target.value) : undefined })
                      }
                      placeholder={t('ai.agentFieldTempPh')}
                    />
                  </div>
                  <div>
                    <label className="ai-agent-label">{t('ai.agentFieldFallback')}</label>
                    <select
                      className="ai-agent-input"
                      value={editing.fallbackModelId ?? ''}
                      onChange={(e) => setEditing({ ...editing, fallbackModelId: e.target.value || undefined })}
                    >
                      <option value="">{t('ai.agentFieldFallbackNone')}</option>
                      {renderModelOptions()}
                    </select>
                  </div>
                </div>
                <div className="ai-agent-hint">{t('ai.agentFieldFallbackPh')}</div>
              </div>

              <div className="ai-agent-sec">
                <div className="ai-agent-sec-title">{t('ai.agentSecTools')}</div>
                <div className="ai-agent-hint">{t('ai.agentToolsHint')}</div>
                <div className="ai-agent-chips">
                  {AI_TOOL_DEFS.map((td) => {
                    const on = !editing.toolIds || editing.toolIds.includes(td.name);
                    return (
                      <button
                        key={td.name}
                        type="button"
                        className={`ai-agent-chip${on ? ' on' : ''}`}
                        onClick={() => toggleTool(td.name, !on)}
                      >
                        {t(toolLabel(td.name))}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="ai-agent-sec">
                <div className="ai-agent-sec-title">{t('ai.agentSecPrompt')}</div>
                <textarea
                  className="ai-agent-textarea"
                  rows={6}
                  value={editing.systemPrompt}
                  onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })}
                  placeholder={t('ai.agentFieldSystemPh')}
                />
              </div>
            </div>

            <div className="ai-agent-modal-foot">
              <button
                className="ai-btn ai-btn-sm ai-btn-primary"
                type="button"
                onClick={save}
                disabled={
                  !editing.name.trim() ||
                  !editing.systemPrompt.trim() ||
                  !editing.modelId ||
                  (editing.requiresCapability === 'vision' &&
                    editing.modelId != null &&
                    modelVisionSupport(config, editing.modelId) === 'no')
                }
              >
                {t('ai.save')}
              </button>
              <button className="ai-btn ai-btn-sm" type="button" onClick={() => setEditing(null)}>{t('ai.cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
