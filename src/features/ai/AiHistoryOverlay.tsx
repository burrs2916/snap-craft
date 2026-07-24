// AI 历史库覆盖层：列出所有截图各自的 AI 成稿线程，可搜索/阅读/载入追问/删除/导出。
// 自包含组件：内部管理 historyList/activeConv/search/export 全部状态，
// 仅通过 props 与父组件交互（载入对话、关闭面板、打开导出文件）。
//
// 2026-07-23 架构解耦：导出逻辑统一走 exportService.ts，消除与 AIPanel 的重复管线。
import { useState } from 'react';
import { useAiStore, type AiConvMeta } from './aiStore';
import { stripSnapMarkers } from './aiPresets';
import { AiMarkdown } from './aiMarkdown';
import { exportAs, exportZip, type ExportContext, type ExportFormat } from './export/exportService';
import { dataUrlToBytes } from './export/zipStore';
import { revealInFolder, deriveFileHint, baseNameOf } from './export/exportPath';
import type { AiChatTurn } from './aiTypes';
import { t } from '../../i18n';
import { firstHeading, fmtTime } from './aiUtils';

export interface AiHistoryOverlayProps {
  onClose: () => void;
  onHide: () => void;
  onLoadConv: (hash: string) => void;
  windowChrome: boolean;
  openExported: (path: string) => void;
  setLastExportedPath: (path: string) => void;
}

export function AiHistoryOverlay({ onClose, onHide, onLoadConv, windowChrome, openExported, setLastExportedPath }: AiHistoryOverlayProps) {
  const { listConvMeta, getConvByHash, deleteConv, forkConversation } = useAiStore();

  const [historyList, setHistoryList] = useState<AiConvMeta[]>(() => listConvMeta());
  const [activeConv, setActiveConv] = useState<{ meta: AiConvMeta; conv: AiChatTurn[] } | null>(null);
  const [historySearch, setHistorySearch] = useState('');
  const [historyMsg, setHistoryMsg] = useState<string | null>(null);
  const [historyExportedPath, setHistoryExportedPath] = useState<string | null>(null);

  const openConvReader = (meta: AiConvMeta) => {
    setActiveConv({ meta, conv: getConvByHash(meta.hash) });
  };
  const loadConvIntoPanel = (hash: string) => {
    onLoadConv(hash);
  };
  const removeConv = (hash: string) => {
    if (!window.confirm(t('ai.historyConfirmDelete'))) return;
    deleteConv(hash);
    setHistoryList(listConvMeta());
    if (activeConv?.meta.hash === hash) setActiveConv(null);
    setHistoryMsg(t('ai.historyDeleted'));
  };
  const activeDoc =
    activeConv && activeConv.conv.length
      ? (() => {
          for (let i = activeConv.conv.length - 1; i >= 0; i--) {
            if (activeConv.conv[i].role === 'assistant') return activeConv.conv[i].content;
          }
          return '';
        })()
      : '';

  // 统一导出：委托 exportService，消除重复管线
  const handleHistoryExport = async (fmt: ExportFormat) => {
    if (!activeConv) return;
    const md = activeDoc;
    const thumb = activeConv.meta.thumb;
    const coverImages =
      thumb && (fmt === 'docx' || fmt === 'pdf' || fmt === 'html' || fmt === 'pptx')
        ? [{ dataUrl: thumb, caption: activeConv.meta.firstGoal || undefined }]
        : undefined;

    const ctx: ExportContext = {
      markdown: md,
      title: firstHeading(stripSnapMarkers(md)) || activeConv.meta.presetName,
      subtitle: activeConv.meta.firstGoal,
      theme: 'modern',
      images: coverImages,
      fileHint: deriveFileHint(activeConv.meta.firstGoal),
    };

    try {
      const path = await exportAs(ctx, fmt, activeConv.meta.presetName);
      if (path) {
        setHistoryMsg(t('ai.exportOk', { path: baseNameOf(path) }));
        setLastExportedPath(path);
        setHistoryExportedPath(path);
      } else if (fmt === 'pdf') {
        setHistoryMsg(t('ai.exportPdfHint'));
      }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setHistoryMsg(t('ai.exportFail', { msg }));
    }
  };

  const handleHistoryZip = async () => {
    if (!activeConv) return;
    try {
      const enc = new TextEncoder();
      const files: { name: string; data: Uint8Array }[] = [];
      const md = stripSnapMarkers(activeDoc);
      files.push({ name: 'conversation.md', data: enc.encode(md) });
      files.push({
        name: 'conversation.json',
        data: enc.encode(JSON.stringify(activeConv.conv, null, 2)),
      });
      const thumb = activeConv.meta.thumb;
      if (thumb) {
        const bytes = dataUrlToBytes(thumb);
        if (bytes) files.push({ name: 'source.png', data: bytes });
      }
      const readme = [
        t('export.archiveTitle'),
        t('export.archivePreset', { v: activeConv.meta.presetName }),
        t('export.archiveGoal', { v: activeConv.meta.firstGoal || t('export.archiveGoalEmpty') }),
        t('export.archiveMsgs', { n: activeConv.meta.msgCount }),
        t('export.archiveUpdated', { v: new Date(activeConv.meta.updatedAt).toLocaleString() }),
        activeConv.meta.parent ? t('export.archiveParent', { v: activeConv.meta.parent }) : '',
      ]
        .filter(Boolean)
        .join('\n');
      files.push({ name: 'README.txt', data: enc.encode(readme) });

      const path = await exportZip(files, activeConv.meta.firstGoal || 'archive');
      if (path) {
        setHistoryMsg(t('ai.exportOk', { path: baseNameOf(path) }));
        setLastExportedPath(path);
      }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setHistoryMsg(t('ai.exportFail', { msg }));
    }
  };

  const filteredList = (() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return historyList;
    return historyList.filter((m) =>
      `${m.firstGoal} ${m.presetName} ${m.preview}`.toLowerCase().includes(q),
    );
  })();

  return (
  <div className="ai-hist">
    <div className="ai-hist-head">
      <span className="ai-hist-title">📚 {t('ai.historyTitle')}</span>
      <div className="ai-hist-head-actions">
        <button className="ai-panel-close" onClick={onHide} title={t('ai.historyClose')}>
          ✕
        </button>
        {windowChrome && (
          <button className="ai-panel-close" onClick={onClose} title={t('ai.close')}>
            {'⏻'}
          </button>
        )}
      </div>
    </div>

    {activeConv ? (
      /* 阅读器：只读展示该线程全部轮次，可导出或载入当前面板继续追问 */
      <div className="ai-hist-reader">
        <div className="ai-hist-bar">
          <button className="ai-link" onClick={() => setActiveConv(null)}>
            ‹ {t('ai.historyBack')}
          </button>
          <span className="ai-hist-badge">{activeConv.meta.presetName}</span>
          <button className="ai-link" onClick={() => loadConvIntoPanel(activeConv.meta.hash)}>
            {t('ai.historyLoad')}
          </button>
          <button
            className="ai-link"
            title={t('ai.historyForkTitle')}
            onClick={() => {
              const nh = forkConversation(activeConv.meta.hash);
              if (nh) {
                loadConvIntoPanel(nh);
                setHistoryMsg(t('ai.historyForked'));
              }
            }}
          >
            🍴 {t('ai.historyFork')}
          </button>
        </div>
        <div className="ai-hist-doc-title">{activeConv.meta.firstGoal || t('ai.historyNoGoal')}</div>
        <div className="ai-post-row ai-hist-export">
          <span className="ai-post-label">{t('ai.export')}</span>
          <button className="ai-btn ai-btn-sm" onClick={() => handleHistoryExport('md')}>
            .md
          </button>
          <button className="ai-btn ai-btn-sm" onClick={() => handleHistoryExport('txt')}>
            .txt
          </button>
          <button className="ai-btn ai-btn-sm" onClick={() => handleHistoryExport('html')}>
            .html
          </button>
          <button className="ai-btn ai-btn-sm" onClick={() => handleHistoryExport('docx')}>
            .docx
          </button>
          <button className="ai-btn ai-btn-sm" onClick={() => handleHistoryExport('pdf')}>
            .pdf
          </button>
          <button
            className="ai-btn ai-btn-sm"
            onClick={() => handleHistoryExport('pptx')}
            title={t('ai.exportPptxTitle')}
          >
            .pptx
          </button>
          <button
            className="ai-btn ai-btn-sm ai-btn-primary"
            onClick={() => handleHistoryExport('xlsx')}
            title={t('ai.exportXlsxTitle')}
          >
            .xlsx
          </button>
          <button
            className="ai-btn ai-btn-sm"
            onClick={handleHistoryZip}
            title={t('ai.exportZipTitle')}
          >
            📦 .zip
          </button>
        </div>
        <div className="ai-chat ai-hist-chat">
          {activeConv.conv.map((m, i) => (
            <div key={i} className={`ai-msg ${m.role === 'user' ? 'ai-msg-user' : 'ai-msg-ai'}`}>
              <div className="ai-msg-role">{m.role === 'user' ? t('ai.you') : 'AI'}</div>
              <div className="ai-msg-body">
                {m.role === 'user' ? (
                  <div className="ai-msg-text">{m.content}</div>
                ) : (
                  <AiMarkdown source={m.content} />
                )}
                {m.role === 'assistant' && (
                  <button
                    className="ai-msg-fork"
                    title={t('ai.historyForkFromTitle')}
                    onClick={() => {
                      const nh = forkConversation(activeConv.meta.hash, i);
                      if (nh) {
                        loadConvIntoPanel(nh);
                        setHistoryMsg(t('ai.historyForked'));
                      }
                    }}
                  >
                    🍴 {t('ai.historyForkFrom')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        {historyMsg && <div className="ai-export-msg">{historyMsg}</div>}
        {historyExportedPath && (
          <div className="ai-export-msg ai-hist-export-actions">
            <button
              className="ai-btn ai-btn-sm ai-btn-reveal"
              title={t('ai.exportRevealTitle')}
              onClick={async () => {
                const err = await revealInFolder(historyExportedPath);
                if (err) setHistoryMsg(t('ai.exportFail', { msg: err }));
              }}
            >
              {t('ai.exportReveal')}
            </button>
            <button
              className="ai-btn ai-btn-sm ai-btn-open"
              title={t('ai.openAppTitle')}
              onClick={() => openExported(historyExportedPath)}
            >
              {t('ai.openApp')}
            </button>
          </div>
        )}
      </div>
    ) : (
      /* 列表：搜索 + 卡片 */
      <>
        <div className="ai-hist-search">
          <input
            className="ai-hist-search-input"
            value={historySearch}
            onChange={(e) => setHistorySearch(e.target.value)}
            placeholder={t('ai.historySearchPh')}
          />
        </div>
        <div className="ai-hist-body">
          {historyList.length === 0 ? (
            <div className="ai-hist-empty">{t('ai.historyEmpty')}</div>
          ) : filteredList.length === 0 ? (
            <div className="ai-hist-empty">{t('ai.historyNoResult')}</div>
          ) : (
            filteredList.map((meta) => (
              <div key={meta.hash} className="ai-hist-item">
                {meta.thumb && <img className="ai-hist-thumb" src={meta.thumb} alt="" />}
                <div className="ai-hist-info">
                  <div className="ai-hist-item-title">{meta.firstGoal || t('ai.historyNoGoal')}</div>
                  <div className="ai-hist-item-meta">
                    {meta.parent && <span className="ai-hist-fork-badge">🍴 {t('ai.historyForkBadge')}</span>}
                    <span className="ai-hist-badge">{meta.presetName}</span>
                    <span className="ai-hist-dot">·</span>
                    <span>{fmtTime(meta.updatedAt)}</span>
                    <span className="ai-hist-dot">·</span>
                    <span>{t('ai.historyMsgs', { n: meta.msgCount })}</span>
                  </div>
                </div>
                <div className="ai-hist-actions">
                  <button className="ai-link" onClick={() => openConvReader(meta)}>
                    {t('ai.historyRead')}
                  </button>
                  <button className="ai-link" onClick={() => loadConvIntoPanel(meta.hash)}>
                    {t('ai.historyLoad')}
                  </button>
                  <button className="ai-link ai-link-danger" onClick={() => removeConv(meta.hash)}>
                    {t('ai.historyDelete')}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </>
    )}
  </div>
  );
}
