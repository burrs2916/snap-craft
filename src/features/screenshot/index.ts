// src/features/screenshot/index.ts
// 截图 feature 统一出口。
// 外部模块应从此处导入，而非直接引用内部文件路径。

// ── 主组件 ──
export { default as EnhancedScreenshotApp } from './EnhancedScreenshotApp';

// ── 子组件 ──
export { AnnotationCanvas } from './components/AnnotationCanvas';
export type { AnnotationCanvasHandle } from './components/AnnotationCanvas';
export { AnnotationToolbar } from './components/AnnotationToolbar';
export { BatchBar, BatchOcrPanel, AiBatchPanel } from './components/BatchOperations';
export type { BatchOperationsProps } from './components/BatchOperations';
export { EditorWindow } from './components/EditorWindow';
export { OcrPanel } from './components/OcrPanel';
export { PinWindow } from './components/PinWindow';
export { RegionOverlay } from './components/RegionOverlay';
export { WindowOverlay } from './components/WindowOverlay';

// ── Hooks ──
export { useAiIntegration } from './hooks/useAiIntegration';
export type { AiIntegrationDeps } from './hooks/useAiIntegration';
export { useBatchOperations } from './hooks/useBatchOperations';
export { useOcrPanel } from './hooks/useOcrPanel';
export { useScreenPermission } from './hooks/useScreenPermission';
export { useScrollCapture } from './hooks/useScrollCapture';

// ── Store ──
export { useScreenshotStore } from './store/screenshotStore';

// ── 类型 ──
export type {
  Point,
  AnnotationGeometry,
  Layer,
  ScreenshotData,
  OcrBlock,
  OcrResult,
  AnnotationObject,
} from './types';

// ── 工具函数 ──
export { clamp01, genAnnoId, normToPx, cropDataUrl, flog } from './utils/helpers';
export { ocrReadingOrder, ocrHighlightParts, ocrExtractEntities } from './utils/ocrUtils';
export type { OcrLayout, OcrExportFmt, OcrEntity } from './utils/ocrUtils';
export { stitchFrames } from './utils/stitch';
