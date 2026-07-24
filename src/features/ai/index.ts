// src/features/ai/index.ts
// AI 助手 feature 统一出口。
// 外部模块（如 screenshot feature）应从此处导入，而非直接引用内部文件路径，
// 以便后续内部重构不影响外部消费者。

// ── 核心 Store ──
export { useAiStore, convHash } from './aiStore';
export type { AiConvMeta } from './aiStore';

// ── AI 客户端 ──
export { chatOnce, streamChat, estimateCost, estimateTokens, trimHistoryToBudget, classifyAiError } from './aiClient';
export type { AiErrorKind } from './aiClient';

// ── 类型 ──
export type {
  AiConfig,
  AiMessage,
  AiToolDef,
  AiToolCall,
  AiToolResult,
  AiAgentStep,
  AiUsage,
  StreamOpts,
  AiChatTurn,
  AiMemory,
  DocThemeId,
  DocxImage,
  AiApiType,
} from './aiTypes';

// ── 工具契约 ──
export { AI_TOOL_DEFS, createToolExecutor, agentSystem, agentSystemSentinel, toolLabel } from './aiTools';
export type { AiToolHost } from './aiTools';
// NormRect / NormPoint 已迁移至 shared/geometry，此处保留 re-export 向后兼容
export type { NormRect, NormPoint } from './aiTools';

// ── 预设 ──
export { AI_PRESETS, stripSnapMarkers, hasSnapMarkers } from './aiPresets';
export type { AiPreset, UserPreset } from './aiPresets';

// ── 导出服务 ──
export { exportAs, exportZip, buildPreviewHtml, buildRichTextHtml, resolveContext } from './export/exportService';
export type { ExportContext, ExportFormat } from './export/exportService';

// ── 导出路径 ──
export { pickExportPath, buildDefaultPath, deriveFileHint, baseNameOf, revealInFolder } from './export/exportPath';

// ── 导出历史 ──
export { pushExportHistory, listExportHistory, clearExportHistory } from './export/exportHistory';
export type { ExportHistoryItem } from './export/exportHistory';

// ── Markdown 转换器 ──
export { mdToHtml, DOC_THEMES } from './export/markdownHtml';
export { markdownToDocx } from './export/markdownDocx';
export { markdownToPptx } from './export/markdownPptx';
export { markdownToXlsx } from './export/markdownXlsx';

// ── 工具函数 ──
export { cleanOcrText } from './ocrClean';
export { printHtmlViaIframe, mdToPlainText, docStats, frontImageBlockHtml, firstHeading, fmtTime } from './aiUtils';
export { buildZip, dataUrlToBytes } from './export/zipStore';

// ── UI 组件 ──
export { default as AIPanel } from './AIPanel';
export { AiMarkdown } from './aiMarkdown';
export { AiHistoryOverlay } from './AiHistoryOverlay';
export { AiTemplateManager } from './AiTemplateManager';

// ── Hooks ──
export { useExportActions } from './hooks/useExportActions';
export type { ExportActionsApi, ExportActionsState } from './hooks/useExportActions';

// ── 持久化 ──
export { loadConfig, saveConfig, loadTemplates, saveTemplates, loadConversation, saveConversation, loadSelection, saveSelection } from './lib/persistence';
