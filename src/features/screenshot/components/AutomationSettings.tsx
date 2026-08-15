// 截后自动化 —— 设置弹窗（非侵入，纯前端）
//
// 挂载点：主窗口 home 工具栏「⚙ 自动化」按钮 → 打开本弹窗。
// 只增一个按钮 + 一个弹窗，不改动首页布局 / 编辑器 / 截屏链路。
// 所有配置经 useAfterCapture（localStorage 持久化）落地，0 Rust。

import { useState } from 'react';
import {
  useAfterCapture,
  ACTION_LABEL_KEYS,
  ACTION_NEEDS_PARAM,
  type AfterCaptureActionType,
  type AfterCaptureTrigger,
} from '../store/afterCapture';
import { t } from '../../../i18n';

const ALL_ACTIONS: AfterCaptureActionType[] = [
  'copy_image',
  'save',
  'ocr_copy_text',
  'open_editor',
  'reveal',
  'open_external',
];

const TRIGGERS: AfterCaptureTrigger[] = ['capture', 'import', 'both'];

export default function AutomationSettings({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { enabled, trigger, actions, setEnabled, setTrigger, addAction, removeAction, reorder, updateAction } =
    useAfterCapture();
  const [pendingAdd, setPendingAdd] = useState<AfterCaptureActionType>('copy_image');

  if (!open) return null;

  const pickDir = async (idx: number) => {
    const { open: dopen } = await import('@tauri-apps/plugin-dialog');
    const sel = await dopen({ directory: true, multiple: false });
    if (typeof sel === 'string') updateAction(idx, { saveDir: sel });
  };

  return (
    <div className="automation-overlay" onClick={onClose}>
      <div className="automation-panel" onClick={(e) => e.stopPropagation()}>
        <div className="automation-head">
          <h3>{t('automation.title')}</h3>
          <button className="automation-close" onClick={onClose} title={t('automation.close')}>
            ✕
          </button>
        </div>

        <label className="automation-switch">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{t('automation.enable')}</span>
        </label>

        <div className="automation-field">
          <div className="automation-label">{t('automation.triggerLabel')}</div>
          <div className="automation-seg">
            {TRIGGERS.map((tg) => (
              <button
                key={tg}
                className={`automation-seg-btn ${trigger === tg ? 'active' : ''}`}
                onClick={() => setTrigger(tg)}
              >
                {t(`automation.trigger.${tg}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="automation-field">
          <div className="automation-label">{t('automation.actions')}</div>
          <div className="automation-actions">
            {actions.map((a, idx) => (
              <div className="automation-action" key={idx}>
                <span className="automation-idx">{idx + 1}</span>
                <span className="automation-action-name">{t(ACTION_LABEL_KEYS[a.type])}</span>
                {ACTION_NEEDS_PARAM[a.type] === 'saveDir' && (
                  <button className="automation-pick" onClick={() => pickDir(idx)}>
                    {a.saveDir ? a.saveDir : t('automation.pickDir')}
                  </button>
                )}
                {ACTION_NEEDS_PARAM[a.type] === 'openTarget' && (
                  <input
                    className="automation-target-input"
                    placeholder={t('automation.targetPlaceholder')}
                    value={a.openTarget ?? ''}
                    onChange={(e) => updateAction(idx, { openTarget: e.target.value })}
                  />
                )}
                <span className="automation-actions-ctrl">
                  <button
                    disabled={idx === 0}
                    onClick={() => reorder(idx, idx - 1)}
                    title={t('automation.up')}
                  >
                    ↑
                  </button>
                  <button
                    disabled={idx === actions.length - 1}
                    onClick={() => reorder(idx, idx + 1)}
                    title={t('automation.down')}
                  >
                    ↓
                  </button>
                  <button onClick={() => removeAction(idx)} title={t('automation.remove')}>
                    ✕
                  </button>
                </span>
              </div>
            ))}
          </div>
          <div className="automation-add">
            <select
              value={pendingAdd}
              onChange={(e) => setPendingAdd(e.target.value as AfterCaptureActionType)}
            >
              {ALL_ACTIONS.map((at) => (
                <option key={at} value={at}>
                  {t(ACTION_LABEL_KEYS[at])}
                </option>
              ))}
            </select>
            <button className="automation-add-btn" onClick={() => addAction({ type: pendingAdd })}>
              {t('automation.add')}
            </button>
          </div>
        </div>

        <div className="automation-hint">{t('automation.hint')}</div>
      </div>
    </div>
  );
}
