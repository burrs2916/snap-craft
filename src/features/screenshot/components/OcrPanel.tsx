// ===== OCR 面板组件 =====
// 纯展示 + 交互，所有状态/逻辑由 useOcrPanel hook 提供。
// 从 EnhancedScreenshotApp.tsx 的 JSX 3146-3820 行提取。

import { invoke } from '@tauri-apps/api/core';
import type { OcrResult, OcrBlock } from '../types';
import {
  ocrHighlightParts,
  ocrExtractEntities,
  ocrCleanText,
  ocrLangTag,
  fmtOcrTime,
  type OcrExportFmt,
  type OcrHistItem,
} from '../utils/ocrUtils';
import type { OcrPanelState } from '../hooks/useOcrPanel';

// 工具栏图标（复用父组件的 TBIcon / TB_PATHS）
function TBIcon({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const TB_PATHS = {
  ocr: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8h10M7 12h6M7 16h8',
};

export interface OcrPanelProps {
  ocr: OcrPanelState;
  current: { dataUrl: string; width: number; height: number } | null;
  flash: (msg: string, type?: 'success' | 'error' | 'info') => void;
  t: (key: string, vars?: Record<string, any>) => string;
  history: any[];
  setCurrentScreenshot: (s: any | null) => void;
}

export function OcrPanel({ ocr, current, flash, t, history, setCurrentScreenshot }: OcrPanelProps) {
  const {
    ocrResult, ocrBusy, ocrLang, ocrEdits, ocrSearch, ocrConf, ocrMerge,
    ocrAutoCopy, ocrElapsed, ocrHistory, ocrHistoryOpen, ocrLayout,
    ocrExportFmt, ocrExtract, ocrClean, ocrFontSize, ocrSel, ocrLastImage,
    ocrSourceKind, ocrMatchIdx, ocrHoverLine, ocrRegionPick, ocrDrag,
    ocrSearchRef, ocrTextRef, ocrActiveMarkRef, ocrWrapRef,
    setOcrResult, setOcrLang, setOcrEdits, setOcrSearch, setOcrConf,
    setOcrMerge, setOcrAutoCopy, setOcrHistoryOpen, setOcrLayout,
    setOcrExportFmt, setOcrExtract, setOcrClean, setOcrFontSize,
    setOcrSel, setOcrMatchIdx, setOcrHoverLine, setOcrRegionPick, setOcrHistory,
    runOcr, handleLangChange, applyOcrAsAnnotations, redactOcrSel,
    highlightOcrSel, arrowOcrSel, handleExportOcr, copyOcrAs, selectOcrText,
    onPreviewDown, onPreviewMove, onPreviewUp,
    ocrVisibleLines, ocrIncludedLines, ocrTextAt, focusOcrLine,
  } = ocr;

  if (ocrResult === null || !current) return null;

  // ── 派生计算 ──
  const ocrVis = ocrVisibleLines();
  const ocrInc = ocrIncludedLines();
  const q0 = ocrSearch.trim().toLowerCase();
  const _ocrRawDisplay = ocrInc.map(({ b, i }) => ocrTextAt(i, b)).join(ocrMerge ? ' ' : '\n');
  const ocrDisplayText = ocrClean ? ocrCleanText(_ocrRawDisplay) : _ocrRawDisplay;
  const ocrLT = ocrDisplayText.toLowerCase();
  let ocrMatchTotal = 0;
  if (q0) {
    let mi = 0;
    let at = ocrLT.indexOf(q0, mi);
    while (at >= 0) { ocrMatchTotal += 1; mi = at + q0.length; at = ocrLT.indexOf(q0, mi); }
  }
  const ocrShown = ocrVis.length;
  const ocrTotal = ocrResult.blocks.length;
  const ocrHiddenByConf = ocrResult.blocks.filter((b) => ocrConf > 0 && b.confidence > 0 && b.confidence * 100 < ocrConf).length;
  const ocrHasConf = ocrResult.blocks.some((b) => b.confidence > 0);
  const ocrChars = ocrDisplayText.length;
  const ocrSelActive = ocrVis.some(({ i }) => ocrSel[i]);
  const ocrVisSet = new Set(ocrVis.map((x) => x.i));
  const ocrEnt = ocrExtract ? ocrExtractEntities(ocrDisplayText) : null;

  return (
    <div className="ocr-panel-mask" onClick={() => setOcrResult(null)}>
      <div
        className="ocr-panel"
        style={{ ['--ocr-fs' as any]: `${ocrFontSize}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ocr-panel-head">
          <span className="ocr-panel-title">
            <TBIcon d={TB_PATHS.ocr} />
            {t('ocr.title')}
            {ocrResult.blocks.length > 0 && (
              <span className="ocr-panel-count">{ocrResult.blocks.length}</span>
            )}
          </span>
          <select
            className="ocr-lang"
            value={ocrLang}
            onChange={(e) => handleLangChange(e.target.value)}
            title={t('ocr.langTitle')}
          >
            <option value="auto">{t('ocr.langAuto')}</option>
            <option value="zh-Hans">{t('ocr.langZh')}</option>
            <option value="en-US">{t('ocr.langEn')}</option>
            <option value="ja-JP">{t('ocr.langJa')}</option>
          </select>
          <button
            className={`ocr-panel-hist${ocrHistoryOpen ? ' active' : ''}`}
            onClick={() => setOcrHistoryOpen((v) => !v)}
            title={t('ocr.historyTitle')}
          >
            {t('ocr.history')}
            {ocrHistory.length > 0 && <span className="ocr-hist-count">{ocrHistory.length}</span>}
          </button>
          <span className="ocr-fs">
            <button className="ocr-fs-btn" onClick={() => setOcrFontSize((s) => Math.max(11, s - 1))} disabled={ocrFontSize <= 11} title={t('ocr.fsMinus')}>A−</button>
            <button className="ocr-fs-btn" onClick={() => setOcrFontSize((s) => Math.min(22, s + 1))} disabled={ocrFontSize >= 22} title={t('ocr.fsPlus')}>A+</button>
          </span>
          <button
            className={`ocr-panel-toggle${ocrClean ? ' active' : ''}`}
            onClick={() => setOcrClean((v) => !v)}
            title={t('ocr.cleanTitle')}
          >
            {t('ocr.clean')}
          </button>
          <button className="ocr-panel-close" onClick={() => setOcrResult(null)} title={t('ocr.close')}>✕</button>
        </div>

        {/* 统计 */}
        <div className="ocr-stats">
          <span>{t('ocr.elapsed', { ms: ocrElapsed ?? 0 })}</span>
          <span className="ocr-stats-sep">·</span>
          <span>{t('ocr.statLines', { n: ocrShown })}</span>
          <span className="ocr-stats-sep">·</span>
          <span>{t('ocr.statChars', { n: ocrChars })}</span>
        </div>

        {/* 预览缩略图 */}
        <div className="ocr-preview">
          <div className="ocr-preview-head">
            <span className="ocr-preview-title">{t('ocr.preview')}</span>
            <span className="ocr-preview-hint">{t('ocr.previewTitle')}</span>
            <button
              className={`ocr-region-pick${ocrRegionPick ? ' active' : ''}`}
              onClick={() => setOcrRegionPick((v) => !v)}
              disabled={ocrResult.blocks.length === 0}
              title={t('ocr.regionPickTitle')}
            >
              ▭ {t('ocr.regionPick')}
            </button>
          </div>
          <div
            ref={ocrWrapRef}
            className={`ocr-preview-imgwrap${ocrRegionPick ? ' picking' : ''}`}
            onMouseDown={ocrRegionPick ? onPreviewDown : undefined}
            onMouseMove={ocrRegionPick ? onPreviewMove : undefined}
            onMouseUp={ocrRegionPick ? onPreviewUp : undefined}
            onMouseLeave={ocrRegionPick ? onPreviewUp : undefined}
          >
            <img className="ocr-preview-img" src={current.dataUrl} alt="" draggable={false} />
            <div className="ocr-preview-boxes">
              {ocrResult.blocks.map((b, i) => {
                const hidden = !ocrVisSet.has(i);
                const low = b.confidence > 0 && b.confidence < 0.7;
                const active = ocrHoverLine === i;
                const bc = ['ocr-box'];
                if (hidden) bc.push('hidden');
                if (low) bc.push('low');
                if (active) bc.push('active');
                if (ocrSel[i]) bc.push('selected');
                return (
                  <div
                    key={i}
                    className={bc.join(' ')}
                    style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
                    title={ocrTextAt(i, b)}
                    onMouseEnter={() => setOcrHoverLine(i)}
                    onMouseLeave={() => setOcrHoverLine(null)}
                    onClick={() => focusOcrLine(i)}
                  />
                );
              })}
            </div>
            {ocrDrag && (
              <div className="ocr-region-drag" style={{ left: `${ocrDrag.x}%`, top: `${ocrDrag.y}%`, width: `${ocrDrag.w}%`, height: `${ocrDrag.h}%` }} />
            )}
          </div>
          {ocrRegionPick && <div className="ocr-preview-hint-active">{t('ocr.regionPickActive')}</div>}
        </div>

        {/* 全文高亮 */}
        <div
          ref={ocrTextRef}
          className="ocr-panel-text ocr-hl"
          tabIndex={0}
          spellCheck={false}
          onFocus={selectOcrText}
          onClick={() => { if (!window.getSelection()?.toString().trim()) selectOcrText(); }}
          onMouseUp={() => {
            const sel = window.getSelection();
            const q = sel?.toString().trim();
            if (!q) return;
            const el = ocrTextRef.current;
            if (el && q.length >= (el.textContent || '').trim().length) return;
            const map: Record<number, boolean> = {};
            ocrVisibleLines().forEach(({ b, i }) => {
              const bt = ocrTextAt(i, b).trim();
              if (!bt) return;
              if (bt.includes(q) || q.includes(bt)) map[i] = true;
            });
            const keys = Object.keys(map);
            if (keys.length) {
              setOcrSel(map);
              setOcrRegionPick(false);
              flash(t('ocr.selByText', { n: keys.length }), 'info');
            }
          }}
        >
          {(() => {
            const parts = ocrHighlightParts(ocrDisplayText, ocrSearch);
            let mi = -1;
            return parts.map((p, k) => {
              if (!p.hit) return <span key={k}>{p.text}</span>;
              mi += 1;
              const active = mi === ocrMatchIdx;
              return (
                <mark
                  key={k}
                  ref={active ? (el: HTMLElement | null) => { ocrActiveMarkRef.current = el; } : undefined}
                  className={`ocr-mark${active ? ' active' : ''}`}
                >
                  {p.text}
                </mark>
              );
            });
          })()}
        </div>

        {/* 搜索行 */}
        <div className="ocr-search-row">
          <input
            ref={ocrSearchRef}
            className="ocr-search"
            value={ocrSearch}
            placeholder={t('ocr.search')}
            spellCheck={false}
            onChange={(e) => setOcrSearch(e.target.value)}
          />
          {ocrSearch.trim() && (
            <span className="ocr-search-count">{t('ocr.matchCount', { shown: ocrShown, total: ocrTotal })}</span>
          )}
          {ocrMatchTotal > 0 && (
            <span className="ocr-match-nav">
              <button type="button" className="ocr-match-btn" title={t('ocr.matchPrev')} onClick={() => setOcrMatchIdx((v) => (v - 1 + ocrMatchTotal) % ocrMatchTotal)}>‹</button>
              <span className="ocr-match-pos">{Math.min(ocrMatchIdx + 1, ocrMatchTotal)} / {ocrMatchTotal}</span>
              <button type="button" className="ocr-match-btn" title={t('ocr.matchNext')} onClick={() => setOcrMatchIdx((v) => (v + 1) % ocrMatchTotal)}>›</button>
            </span>
          )}
          {ocrSearch && <button className="ocr-search-clear" onClick={() => setOcrSearch('')}>{t('ocr.searchClear')}</button>}
        </div>

        {/* 置信度阈值 */}
        {ocrHasConf && (
          <div className="ocr-conf-row">
            <span className="ocr-conf-label">{t('ocr.confLabel')}</span>
            <input type="range" min={0} max={100} step={5} value={ocrConf} className="ocr-conf-range" onChange={(e) => setOcrConf(Number(e.target.value))} title={t('ocr.confTitle', { n: ocrConf })} />
            <span className="ocr-conf-val">{ocrConf === 0 ? t('ocr.confAll') : `≥${ocrConf}%`}</span>
          </div>
        )}
        {ocrHiddenByConf > 0 && <div className="ocr-conf-hint">{t('ocr.confHidden', { n: ocrHiddenByConf })}</div>}

        {/* 选项行 */}
        <div className="ocr-opts-row">
          <label className="ocr-merge"><input type="checkbox" checked={ocrMerge} onChange={(e) => setOcrMerge(e.target.checked)} />{t('ocr.copyMerge')}</label>
          <label className="ocr-autocopy"><input type="checkbox" checked={ocrAutoCopy} onChange={(e) => setOcrAutoCopy(e.target.checked)} />{t('ocr.autoCopy')}</label>
          <label className="ocr-layout"><input type="checkbox" checked={ocrLayout === 'reading'} onChange={(e) => setOcrLayout(e.target.checked ? 'reading' : 'none')} />{t('ocr.layoutReading')}</label>
          <label className="ocr-fmt">
            {t('ocr.exportFmt')}
            <select className="ocr-fmt-select" value={ocrExportFmt} onChange={(e) => setOcrExportFmt(e.target.value as OcrExportFmt)} title={t('ocr.exportFmtTitle')}>
              <option value="txt">{t('ocr.fmtTxt')}</option>
              <option value="md">{t('ocr.fmtMd')}</option>
              <option value="json">{t('ocr.fmtJson')}</option>
              <option value="tsv">{t('ocr.fmtTsv')}</option>
            </select>
          </label>
          <label className="ocr-extract" title={t('ocr.extractTitle')}><input type="checkbox" checked={ocrExtract} onChange={(e) => setOcrExtract(e.target.checked)} />{t('ocr.extract')}</label>
          <label className="ocr-clean" title={t('ocr.cleanTitle')}><input type="checkbox" checked={ocrClean} onChange={(e) => setOcrClean(e.target.checked)} />{t('ocr.clean')}</label>
          <button
            className="ocr-sel-btn"
            onClick={() => {
              const visIdx = ocrVis.map((x) => x.i);
              const anySel = visIdx.some((idx) => ocrSel[idx]);
              if (anySel) setOcrSel({});
              else setOcrSel(Object.fromEntries(visIdx.map((idx) => [idx, true])));
            }}
            disabled={ocrResult.blocks.length === 0}
            title={t('ocr.selAllTitle')}
          >
            {ocrSelActive ? t('ocr.selClear') : t('ocr.selAll')}
          </button>
          {ocrSelActive && <span className="ocr-sel-info">{t('ocr.selInfo', { n: ocrInc.length })}</span>}
          <span className="ocr-merge-tip">{t('ocr.layoutReadingTitle')}</span>
        </div>

        {/* 智能实体提取 */}
        {ocrEnt && (() => {
          const groups: { kind: 'urls' | 'emails' | 'phones'; items: string[]; label: string }[] = [
            { kind: 'urls', items: ocrEnt.urls, label: t('ocr.entUrls') },
            { kind: 'emails', items: ocrEnt.emails, label: t('ocr.entEmails') },
            { kind: 'phones', items: ocrEnt.phones, label: t('ocr.entPhones') },
          ];
          const entTotal = ocrEnt.urls.length + ocrEnt.emails.length + ocrEnt.phones.length;
          const copyEntItems = async (items: string[]) => {
            if (!items.length) return;
            try { await navigator.clipboard.writeText(items.join('\n')); flash(t('ocr.copied'), 'success'); }
            catch { flash(t('ocr.copyFailed'), 'error'); }
          };
          const openExternalEntity = async (kind: 'urls' | 'emails' | 'phones', item: string) => {
            let target = item;
            if (kind === 'emails') target = `mailto:${item}`;
            else if (kind === 'phones') target = `tel:${item.replace(/\D/g, '')}`;
            else if (/^www\./i.test(item)) target = `https://${item}`;
            try { await invoke('open_external', { target }); }
            catch (e: any) { flash(t('ocr.openEntityFailed', { msg: String(e) }), 'error'); }
          };
          return (
            <div className="ocr-entity">
              <div className="ocr-entity-head">
                <span>{t('ocr.extract')}</span>
                {entTotal > 0 && <span className="ocr-entity-count">{entTotal}</span>}
                {entTotal > 0 && (
                  <button type="button" className="ocr-entity-copyall" style={{ marginLeft: 'auto' }} onClick={() => copyEntItems([...ocrEnt.urls, ...ocrEnt.emails, ...ocrEnt.phones])} title={t('ocr.entCopyAllAll')}>{t('ocr.entCopyAll')}</button>
                )}
              </div>
              {entTotal === 0 ? (
                <div className="ocr-entity-empty">{t('ocr.noEntity')}</div>
              ) : (
                groups.map((g) =>
                  g.items.length === 0 ? null : (
                    <div className="ocr-entity-group" key={g.kind}>
                      <div className="ocr-entity-grouph">
                        <span className="ocr-entity-label">{g.label}</span>
                        <button type="button" className="ocr-entity-copyall" onClick={() => copyEntItems(g.items)}>{t('ocr.entCopyAll')}</button>
                      </div>
                      <div className="ocr-entity-chips">
                        {g.items.map((item, k) => (
                          <span className="ocr-entity-chip" key={k}>
                            <button type="button" className="ocr-entity-text ocr-entity-link" title={item} aria-label={t('ocr.openEntity')} onClick={() => openExternalEntity(g.kind, item)}>{item}</button>
                            <button type="button" className="ocr-entity-copy" title={t('ocr.copy')} onClick={async () => { try { await navigator.clipboard.writeText(item); flash(t('ocr.copied'), 'success'); } catch { flash(t('ocr.copyFailed'), 'error'); } }}>{t('ocr.copy')}</button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )
                )
              )}
            </div>
          );
        })()}

        {/* 历史 */}
        {ocrHistoryOpen && (
          <div className="ocr-history">
            <div className="ocr-history-head">
              <span>{t('ocr.historyTitle')}</span>
              {ocrHistory.length > 0 && (
                <button className="ocr-history-clear" onClick={() => setOcrHistory([])} title={t('ocr.historyClearTitle')}>{t('ocr.historyClear')}</button>
              )}
            </div>
            {ocrHistory.length === 0 ? (
              <div className="ocr-history-empty">{t('ocr.historyEmpty')}</div>
            ) : (
              <div className="ocr-history-list">
                {ocrHistory.map((it, idx) => (
                  <div className="ocr-history-item" key={`${it.ts}-${idx}`}>
                    <div className="ocr-history-meta">
                      {it.thumb && (
                        <img
                          className="ocr-history-thumb"
                          src={it.thumb}
                          alt=""
                          onClick={() => {
                            if (!it.sourceId) return;
                            const target = history.find((s) => s.id === it.sourceId);
                            if (target) {
                              setCurrentScreenshot({ id: target.id, filePath: '', dataUrl: target.dataUrl, width: target.width, height: target.height, annotations: [], layers: [], createdAt: target.createdAt, updatedAt: target.createdAt });
                              setOcrResult({ text: it.text, blocks: [{ text: it.text, x: 0, y: 0, w: 1, h: 1, confidence: 1 }] });
                              flash(t('ocr.historyReplayed'), 'success');
                            }
                          }}
                          title={it.sourceId ? t('ocr.historyReplayTitle') : ''}
                        />
                      )}
                      <span className="ocr-history-lang">{ocrLangTag(it.lang)}</span>
                      <span className="ocr-history-time">{fmtOcrTime(it.ts)}</span>
                      <span className="ocr-history-chars">{it.chars}{t('ocr.charUnit')}</span>
                    </div>
                    <div className="ocr-history-text">{it.text}</div>
                    <button className="ocr-history-copy" title={t('ocr.copy')} onClick={async () => { try { await navigator.clipboard.writeText(it.text); flash(t('ocr.copied'), 'success'); } catch { flash(t('ocr.copyFailed'), 'error'); } }}>{t('ocr.copy')}</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 逐行结果 */}
        <div className="ocr-blocks">
          {ocrVis.map(({ b, i }) => {
            const cur = ocrTextAt(i, b);
            const edited = ocrEdits[i] !== undefined;
            const lowConf = b.confidence > 0 && b.confidence < 0.7;
            const cls = ['ocr-block'];
            if (edited) cls.push('edited');
            if (lowConf) cls.push('low-conf');
            if (ocrHoverLine === i) cls.push('focused');
            return (
              <div className={cls.join(' ')} key={i} data-ocr-idx={i} onMouseEnter={() => setOcrHoverLine(i)} onMouseLeave={() => setOcrHoverLine(null)}>
                <input
                  type="checkbox"
                  className="ocr-block-sel"
                  checked={!!ocrSel[i]}
                  onChange={(e) => setOcrSel((m) => { const n = { ...m }; if (e.target.checked) n[i] = true; else delete n[i]; return n; })}
                  title={t('ocr.selLineTitle')}
                />
                {b.confidence > 0 && <span className="ocr-chip">{Math.round(b.confidence * 100)}%</span>}
                <input className="ocr-block-edit" value={cur} spellCheck={false} placeholder={t('ocr.copyLine')} onChange={(e) => setOcrEdits((m) => ({ ...m, [i]: e.target.value }))} />
                <button className="ocr-block-copy" title={t('ocr.copyLine')} onClick={async () => { try { await navigator.clipboard.writeText(cur); flash(t('ocr.copied'), 'success'); } catch { flash(t('ocr.copyFailed'), 'error'); } }}>{t('ocr.copy')}</button>
              </div>
            );
          })}
        </div>

        {/* 底部操作栏 */}
        <div className="ocr-panel-actions">
          <button className="tbar-btn tbar-primary" onClick={applyOcrAsAnnotations} disabled={ocrResult.blocks.length === 0 || ocrSourceKind === 'text'} title={ocrSourceKind === 'text' ? t('ocr.applyTitleText') : t('ocr.applyTitle')}>{t('ocr.apply')}</button>
          <button className="tbar-btn tbar-ghost" onClick={redactOcrSel} disabled={ocrResult.blocks.length === 0} title={t('ocr.redactSelTitle')}>{t('ocr.redactSel')}</button>
          <button className="tbar-btn tbar-ghost" onClick={highlightOcrSel} disabled={ocrResult.blocks.length === 0} title={t('ocr.highlightSelTitle')}>{t('ocr.highlightSel')}</button>
          <button className="tbar-btn tbar-ghost" onClick={arrowOcrSel} disabled={ocrResult.blocks.length === 0} title={t('ocr.arrowSelTitle')}>{t('ocr.arrowSel')}</button>
          <button className="tbar-btn tbar-ghost" onClick={() => runOcr(ocrLastImage ?? current?.dataUrl ?? '')} disabled={ocrBusy || !ocrLastImage || ocrSourceKind === 'text'} title={ocrSourceKind === 'text' ? t('ocr.rerunTitleText') : t('ocr.rerunTitle')}>{ocrBusy ? t('editor.ocrBusy') : t('ocr.rerun')}</button>
          <button className="tbar-btn tbar-ghost" onClick={async () => { try { await navigator.clipboard.writeText(ocrDisplayText); flash(t('ocr.copied'), 'success'); } catch { flash(t('ocr.copyFailed'), 'error'); } }}>{t('ocr.copyAll')}</button>
          <button className="tbar-btn tbar-ghost" onClick={() => copyOcrAs('json')} disabled={ocrResult.blocks.length === 0} title={t('ocr.copyJsonTitle')}>{t('ocr.copyJson')}</button>
          <button className="tbar-btn tbar-ghost" onClick={() => copyOcrAs('tsv')} disabled={ocrResult.blocks.length === 0} title={t('ocr.copyTsvTitle')}>{t('ocr.copyTsv')}</button>
          <button className="tbar-btn tbar-ghost" onClick={handleExportOcr} disabled={ocrResult.blocks.length === 0} title={t('ocr.exportTitle')}>{t('ocr.export')}</button>
          {Object.keys(ocrEdits).length > 0 && (
            <button className="tbar-btn tbar-ghost" onClick={() => setOcrEdits({})} title={t('ocr.resetEditsTitle')}>{t('ocr.resetEdits')}</button>
          )}
          <button className="tbar-btn tbar-ghost" onClick={() => setOcrResult(null)}>{t('ocr.close')}</button>
        </div>
      </div>
    </div>
  );
}
