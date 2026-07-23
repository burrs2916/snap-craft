// ===== 批量操作面板组件 =====
// 包含：批量操作条、批量 OCR 结果弹窗、批量 AI 队列结果弹窗。

import type { useBatchOperations } from '../hooks/useBatchOperations';

type BatchState = ReturnType<typeof useBatchOperations>;

export interface BatchOperationsProps {
  batch: BatchState;
  flash: (msg: string, type?: 'success' | 'error' | 'info') => void;
  t: (key: string, vars?: Record<string, any>) => string;
}

/** 批量操作条（在历史网格底部，selMode 激活时显示） */
export function BatchBar({ batch, t }: { batch: BatchState; t: (k: string, v?: any) => string }) {
  const { selIds, batchBusy, handleBatchOcr, setShowBatch, setShowAiBatch, clearSel } = batch;
  if (selIds.length === 0) return null;
  return (
    <div className="batch-bar">
      <span className="batch-count">{t('ocr.batchSel', { n: selIds.length })}</span>
      <button className="batch-btn primary" onClick={handleBatchOcr} disabled={batchBusy}>
        {batchBusy ? t('ocr.batchBusy') : t('ocr.batchRun')}
      </button>
      <button
        className="batch-btn accent"
        onClick={() => { setShowBatch(false); setShowAiBatch(true); }}
        title={t('ocr.batchAiTitle')}
      >
        {t('ocr.batchAi')}
      </button>
      <button className="batch-btn" onClick={clearSel}>{t('ocr.batchCancel')}</button>
    </div>
  );
}

/** 批量 OCR 结果弹窗 */
export function BatchOcrPanel({ batch, flash, t }: BatchOperationsProps) {
  const {
    batchItems, showBatch, setShowBatch, setBatchItems,
    copyBatchAll, exportBatchTxt, clearSel,
  } = batch;
  if (!showBatch) return null;
  return (
    <div className="ocr-panel-mask" onClick={() => setShowBatch(false)}>
      <div className="ocr-panel batch-panel" onClick={(e) => e.stopPropagation()}>
        <div className="ocr-panel-head">
          <span className="ocr-panel-title">
            {t('ocr.batchTitle')}
            {batchItems.length > 0 && <span className="ocr-hist-count">{batchItems.length}</span>}
          </span>
          <button className="ocr-panel-close" onClick={() => setShowBatch(false)} title={t('ocr.close')}>✕</button>
        </div>
        <div className="batch-panel-body">
          {batchItems.length === 0 ? (
            <div className="ocr-entity-empty">{t('ocr.batchEmpty')}</div>
          ) : (
            batchItems.map((it, idx) => (
              <div className="batch-card" key={it.id}>
                <div className="batch-card-head">
                  <span className="batch-card-idx">{idx + 1}</span>
                  <span className="batch-card-time">{it.time}</span>
                  <button
                    type="button"
                    className="batch-card-copy"
                    title={t('ocr.copy')}
                    onClick={async () => {
                      try { await navigator.clipboard.writeText(it.text); flash(t('ocr.copied'), 'success'); }
                      catch { flash(t('ocr.copyFailed'), 'error'); }
                    }}
                  >
                    {t('ocr.copy')}
                  </button>
                </div>
                <textarea
                  className="batch-card-text"
                  value={it.text}
                  spellCheck={false}
                  onChange={(e) =>
                    setBatchItems((arr) => arr.map((x, j) => (j === idx ? { ...x, text: e.target.value } : x)))
                  }
                />
              </div>
            ))
          )}
        </div>
        <div className="ocr-panel-actions">
          <button className="tbar-btn tbar-ghost" disabled={batchItems.length === 0} onClick={copyBatchAll} title={t('ocr.copyAll')}>{t('ocr.copyAll')}</button>
          <button className="tbar-btn tbar-ghost" disabled={batchItems.length === 0} onClick={exportBatchTxt} title={t('ocr.export')}>{t('ocr.export')}</button>
          <button className="tbar-btn tbar-ghost" onClick={clearSel}>{t('ocr.close')}</button>
        </div>
      </div>
    </div>
  );
}

/** 批量 AI 队列结果弹窗 */
export function AiBatchPanel({ batch, flash, t }: BatchOperationsProps) {
  const {
    aiPrompt, setAiPrompt, aiBatchBusy, aiBatchItems, aiBatchDone, aiBatchTotal,
    showAiBatch, setShowAiBatch, setAiBatchItems, selIds,
    handleBatchAi, copyAiBatchAll, exportAiBatchMd, exportAiBatchDocx,
  } = batch;
  if (!showAiBatch) return null;
  return (
    <div className="ocr-panel-mask" onClick={() => setShowAiBatch(false)}>
      <div className="ocr-panel batch-panel ai-batch-panel" onClick={(e) => e.stopPropagation()}>
        <div className="ocr-panel-head">
          <span className="ocr-panel-title">
            {t('ocr.batchAiTitle')}
            {aiBatchItems.length > 0 && <span className="ocr-hist-count">{aiBatchItems.length}</span>}
          </span>
          <button className="ocr-panel-close" onClick={() => setShowAiBatch(false)} title={t('ocr.close')}>✕</button>
        </div>
        <div className="ai-batch-prompt-row">
          <textarea
            className="batch-card-text ai-batch-prompt"
            value={aiPrompt}
            spellCheck={false}
            placeholder={t('ocr.batchAiPrompt')}
            onChange={(e) => setAiPrompt(e.target.value)}
          />
          <button
            className="batch-btn accent"
            onClick={handleBatchAi}
            disabled={aiBatchBusy || selIds.length === 0}
            title={t('ocr.batchAiRun')}
          >
            {aiBatchBusy ? t('ocr.batchAiBusy') : t('ocr.batchAiRun')}
          </button>
        </div>
        {aiBatchBusy && (
          <div className="ai-batch-progress">{t('ocr.batchAiProgress', { done: aiBatchDone, total: aiBatchTotal })}</div>
        )}
        <div className="batch-panel-body">
          {aiBatchItems.length === 0 ? (
            <div className="ocr-entity-empty">{aiBatchBusy ? t('ocr.batchAiRunning') : t('ocr.batchAiEmpty2')}</div>
          ) : (
            aiBatchItems.map((it, idx) => (
              <div className="batch-card" key={it.id}>
                <div className="batch-card-head">
                  <span className="batch-card-idx">{idx + 1}</span>
                  <span className="batch-card-time">{it.time}</span>
                  <button
                    type="button"
                    className="batch-card-copy"
                    title={t('ocr.copy')}
                    onClick={async () => {
                      try { await navigator.clipboard.writeText(it.error ? it.error : it.text); flash(t('ocr.copied'), 'success'); }
                      catch { flash(t('ocr.copyFailed'), 'error'); }
                    }}
                  >
                    {t('ocr.copy')}
                  </button>
                </div>
                {it.error ? (
                  <div className="batch-card-err">{t('ocr.batchAiError', { msg: it.error })}</div>
                ) : (
                  <textarea
                    className="batch-card-text"
                    value={it.text}
                    spellCheck={false}
                    onChange={(e) =>
                      setAiBatchItems((arr) => arr.map((x, j) => (j === idx ? { ...x, text: e.target.value } : x)))
                    }
                  />
                )}
              </div>
            ))
          )}
        </div>
        <div className="ocr-panel-actions">
          <button className="tbar-btn tbar-ghost" disabled={aiBatchItems.length === 0} onClick={copyAiBatchAll} title={t('ocr.copyAll')}>{t('ocr.copyAll')}</button>
          <button className="tbar-btn tbar-ghost" disabled={aiBatchItems.length === 0} onClick={exportAiBatchMd} title={t('ocr.batchAiExportMd')}>{t('ocr.batchAiExportMd')}</button>
          <button className="tbar-btn tbar-ghost" disabled={aiBatchItems.length === 0} onClick={exportAiBatchDocx} title={t('ocr.batchAiExportDocx')}>{t('ocr.batchAiExportDocx')}</button>
          <button className="tbar-btn tbar-ghost" onClick={() => setShowAiBatch(false)}>{t('ocr.close')}</button>
        </div>
      </div>
    </div>
  );
}
