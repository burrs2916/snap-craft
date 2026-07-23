// ===== AI 自定义模板管理面板 =====
// 从 AIPanel.tsx 提取的模板 CRUD UI。

import type { UserPreset } from './aiPresets';
import { t } from '../../i18n';

export interface AiTemplateManagerProps {
  editing: UserPreset | null;
  setEditing: (p: UserPreset | null) => void;
  customPresets: UserPreset[];
  saveTemplate: () => void;
  openNewTemplate: () => void;
  openEditTemplate: (p: UserPreset) => void;
  deleteCustomPreset: (id: string) => void;
}

export function AiTemplateManager({
  editing, setEditing, customPresets,
  saveTemplate, openNewTemplate, openEditTemplate, deleteCustomPreset,
}: AiTemplateManagerProps) {
  return (
    <div className="ai-tpl">
      {editing ? (
        <div className="ai-tpl-form">
          <input
            className="ai-tpl-input"
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            placeholder={t('ai.templateNamePh')}
          />
          <input
            className="ai-tpl-input"
            value={editing.desc}
            onChange={(e) => setEditing({ ...editing, desc: e.target.value })}
            placeholder={t('ai.templateDescPh')}
          />
          <textarea
            className="ai-tpl-textarea"
            rows={4}
            value={editing.system}
            onChange={(e) => setEditing({ ...editing, system: e.target.value })}
            placeholder={t('ai.templateInstructionPh')}
          />
          <label className="ai-check">
            <input
              type="checkbox"
              checked={editing.vision}
              onChange={(e) => setEditing({ ...editing, vision: e.target.checked })}
            />
            <span>{t('ai.templateVision')}</span>
          </label>
          <select
            className="ai-tpl-input"
            value={editing.userBuilder ?? 'default'}
            onChange={(e) => setEditing({ ...editing, userBuilder: e.target.value as 'default' | 'report' })}
            title={t('ai.templateBuilder')}
          >
            <option value="default">{t('ai.templateBuilderDefault')}</option>
            <option value="report">{t('ai.templateBuilderReport')}</option>
          </select>
          <div className="ai-tpl-actions">
            <button
              className="ai-btn ai-btn-sm ai-btn-primary"
              onClick={saveTemplate}
              disabled={!editing.name.trim()}
            >
              {t('ai.templateSave')}
            </button>
            <button className="ai-btn ai-btn-sm" onClick={() => setEditing(null)}>
              {t('ai.templateCancel')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <button className="ai-btn ai-btn-sm ai-tpl-add" onClick={openNewTemplate}>
            ＋ {t('ai.templateAdd')}
          </button>
          {customPresets.length === 0 ? (
            <div className="ai-tpl-empty">{t('ai.templateEmpty')}</div>
          ) : (
            <div className="ai-tpl-list">
              {customPresets.map((p) => (
                <div key={p.id} className="ai-tpl-item">
                  <span className="ai-tpl-name" title={p.desc ?? ''}>
                    ★ {p.name}
                  </span>
                  <span className="ai-tpl-item-actions">
                    <button
                      className="ai-link"
                      onClick={() => openEditTemplate(p)}
                      title={t('ai.templateEdit')}
                    >
                      {t('ai.templateEdit')}
                    </button>
                    <button
                      className="ai-link ai-link-danger"
                      onClick={() => deleteCustomPreset(p.id)}
                      title={t('ai.templateDelete')}
                    >
                      {t('ai.templateDelete')}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
