// 教程捕获模式 —— 底部浮条（非全屏，独立组件）
//
// 非侵入说明：
//  - 本组件只读取 tutorialSession（步骤顺序）+ 主窗 historyList（取缩略图），不修改任何现有实现。
//  - 收集的步骤顺序由 tutorialSession 维护，本组件仅展示 / 重排 / 删除 / 触发生成。
//  - 「完成并生成教程」只做一件事：打开 AI 窗口（首张作上下文），把全部步骤 id 经 URL 注入；
//    真正的成稿由 AIPanel 受控复用现有 generate（tutorial 预设 + buildReportUser 嵌图）完成。
//  - 浮条固定底部居中、小条、非全屏，符合「多屏禁全屏 overlay」偏好。

import { useState } from 'react';
import { useTutorialSession } from '../store/tutorialSession';
import type { HistoryEntry } from '../hooks/useHistory';
import { t } from '../../../i18n';
import { openAiWindow } from '../../../ai-window/bridge';

interface TutorialBarProps {
  historyList: HistoryEntry[];
  flash: (msg: string, type?: 'info' | 'success' | 'error', duration?: number) => void;
}

const CIRCLE = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

export function TutorialBar({ historyList, flash }: TutorialBarProps) {
  const active = useTutorialSession((s) => s.active);
  const ids = useTutorialSession((s) => s.ids);
  const removeStep = useTutorialSession((s) => s.removeStep);
  const reorder = useTutorialSession((s) => s.reorder);
  const cancel = useTutorialSession((s) => s.cancel);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  if (!active) return null;

  // 按收集顺序解析缩略图（historyList 顺序不一定等于收集顺序）
  const items = ids
    .map((id) => historyList.find((h) => h.id === id))
    .filter((h): h is HistoryEntry => !!h);

  const handleGenerate = async () => {
    if (items.length === 0) {
      flash(t('tutorial.empty'), 'error');
      return;
    }
    const first = items[0];
    // 首张作 AI 窗口「当前截图」上下文；全部步骤 id 经 URL 注入供 AIPanel 自动成稿
    await openAiWindow(
      {
        dataUrl: first.dataUrl,
        ocrText: undefined,
        width: first.width,
        height: first.height,
      },
      'main',
      ids,
    );
    flash(t('tutorial.generating'), 'info');
    cancel();
  };

  return (
    <div className="tutorial-bar">
      <div className="tutorial-bar-head">
        <span className="tutorial-bar-title">📚 {t('tutorial.barTitle')}</span>
        <span className="tutorial-bar-count">{t('tutorial.stepCount', { n: items.length })}</span>
      </div>
      <div className="tutorial-bar-steps">
        {items.map((h, idx) => (
          <div
            key={h.id}
            className={`tutorial-step${dragIdx === idx ? ' dragging' : ''}`}
            draggable
            onDragStart={() => setDragIdx(idx)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIdx !== null && dragIdx !== idx) reorder(dragIdx, idx);
              setDragIdx(null);
            }}
            onDragEnd={() => setDragIdx(null)}
            title={t('tutorial.dragHint')}
          >
            <span className="tutorial-step-badge">{CIRCLE[idx] ?? idx + 1}</span>
            <img className="tutorial-step-thumb" src={h.dataUrl} alt="" draggable={false} />
            <button
              className="tutorial-step-del"
              onClick={() => removeStep(h.id)}
              title={t('tutorial.remove')}
            >
              ✕
            </button>
          </div>
        ))}
        {items.length === 0 && (
          <span className="tutorial-bar-empty">{t('tutorial.emptyHint')}</span>
        )}
      </div>
      <div className="tutorial-bar-actions">
        <button className="tutorial-btn ghost" onClick={() => cancel()}>
          {t('tutorial.cancel')}
        </button>
        <button className="tutorial-btn primary" onClick={handleGenerate} disabled={items.length === 0}>
          {t('tutorial.generate')}
        </button>
      </div>
    </div>
  );
}
