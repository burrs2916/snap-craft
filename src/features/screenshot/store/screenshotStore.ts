import { create } from 'zustand';
import { ScreenshotData, AnnotationObject, Layer } from '../types';

interface ScreenshotState {
  currentScreenshot: ScreenshotData | null;
  annotations: AnnotationObject[];
  layers: Layer[];
  activeLayerId: string | null;
  selectedAnnotationIds: string[];
  selectedId: string | null;
  activeTool: string | null;
  currentColor: string;
  currentStrokeWidth: number;
  // 文字样式（新建文字标注时使用；选中文字时同步更新）
  currentFontSize: number;
  currentBold: boolean;
  currentItalic: boolean;
  currentAlign: 'left' | 'center' | 'right';
  currentFontFamily: string;
  currentTextBg: boolean;
  currentBgColor: string;
  currentBgOpacity: number;
  currentTextStroke: boolean;
  // 打码设置：模式（马赛克/高斯模糊/涂黑遮挡）、强度、画笔半径
  maskBlur: boolean;
  maskStrength: number;
  maskSolid: boolean; // 涂黑遮挡模式
  maskBrushSize: number; // 画笔打码的笔刷半径
  past: AnnotationObject[][];
  future: AnnotationObject[][];

  // 跨窗口透传：覆盖层（独立 WebviewWindow）需要知道平台与当前截图模式
  platform: string;
  setPlatform: (p: string) => void;
  captureMode: 'region' | 'window';
  setCaptureMode: (m: 'region' | 'window') => void;

  setCurrentScreenshot: (screenshot: ScreenshotData | null) => void;
  addAnnotation: (annotation: AnnotationObject) => void;
  updateAnnotation: (id: string, updates: Partial<AnnotationObject>) => void;
  deleteAnnotation: (id: string) => void;
  undo: () => void;
  redo: () => void;
  setActiveLayer: (layerId: string) => void;
  addLayer: (layer: Layer) => void;
  updateLayer: (id: string, updates: Partial<Layer>) => void;
  deleteLayer: (id: string) => void;
  setSelectedAnnotations: (ids: string[]) => void;
  setSelectedId: (id: string | null) => void;
  setActiveTool: (tool: string | null) => void;
  setCurrentColor: (c: string) => void;
  setCurrentStrokeWidth: (w: number) => void;
  setCurrentFontSize: (s: number) => void;
  setCurrentBold: (b: boolean) => void;
  setCurrentItalic: (b: boolean) => void;
  setCurrentAlign: (a: 'left' | 'center' | 'right') => void;
  setCurrentFontFamily: (f: string) => void;
  setCurrentTextBg: (b: boolean) => void;
  setCurrentBgColor: (c: string) => void;
  setCurrentBgOpacity: (n: number) => void;
  setCurrentTextStroke: (b: boolean) => void;
  setMaskBlur: (b: boolean) => void;
  setMaskStrength: (s: number) => void;
  setMaskSolid: (b: boolean) => void;
  setMaskBrushSize: (s: number) => void;
  clearAnnotations: () => void;
}

const HISTORY_LIMIT = 50;

// 从 annotations 重新推导图层的 objects，保证撤销/重做后 layers 与 annotations 一致
const rebuildLayers = (anns: AnnotationObject[]): Layer[] => [
  {
    id: 'default',
    name: '默认图层',
    visible: true,
    locked: false,
    objects: anns.filter((a) => a.layerId === 'default').map((a) => a.id),
  },
];

export const useScreenshotStore = create<ScreenshotState>((set, get) => ({
  currentScreenshot: null,
  annotations: [],
  layers: [
    { id: 'default', name: '默认图层', visible: true, locked: false, objects: [] }
  ],
  activeLayerId: 'default',
  selectedAnnotationIds: [],
  selectedId: null,
  activeTool: null,
  currentColor: '#ff3b30',
  currentStrokeWidth: 3,
  currentFontSize: 22,
  currentBold: false,
  currentItalic: false,
  currentAlign: 'left',
  currentFontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  currentTextBg: false,
  currentBgColor: '#1d1d1f',
  currentBgOpacity: 1,
  currentTextStroke: false,
  maskBlur: false,
  maskStrength: 12,
  maskSolid: false,
  maskBrushSize: 20,
  past: [],
  platform: '',
  setPlatform: (p) => set({ platform: p }),
  captureMode: 'region',
  setCaptureMode: (m) => set({ captureMode: m }),
  future: [],

  setCurrentScreenshot: (screenshot) => set({ currentScreenshot: screenshot }),
  
  addAnnotation: (annotation) => set((state) => {
    const anns = [...state.annotations, annotation];
    return {
      past: [...state.past, state.annotations].slice(-HISTORY_LIMIT),
      annotations: anns,
      layers: rebuildLayers(anns),
      future: [],
    };
  }),
  
  updateAnnotation: (id, updates) => set((state) => {
    const anns = state.annotations.map(ann => 
      ann.id === id ? { ...ann, ...updates } : ann
    );
    return {
      past: [...state.past, state.annotations].slice(-HISTORY_LIMIT),
      annotations: anns,
      layers: rebuildLayers(anns),
      future: [],
    };
  }),
  
  deleteAnnotation: (id) => set((state) => {
    const anns = state.annotations.filter(ann => ann.id !== id);
    return {
      past: [...state.past, state.annotations].slice(-HISTORY_LIMIT),
      annotations: anns,
      layers: rebuildLayers(anns),
      future: [],
      selectedId: state.selectedId === id ? null : state.selectedId,
    };
  }),
  
  setActiveLayer: (layerId) => set({ activeLayerId: layerId }),
  
  addLayer: (layer) => set((state) => ({
    layers: [...state.layers, layer]
  })),
  
  updateLayer: (id, updates) => set((state) => ({
    layers: state.layers.map(layer =>
      layer.id === id ? { ...layer, ...updates } : layer
    )
  })),
  
  deleteLayer: (id) => set((state) => ({
    layers: state.layers.filter(layer => layer.id !== id)
  })),
  
  setSelectedAnnotations: (ids) => set({ selectedAnnotationIds: ids }),
  
  setSelectedId: (id) => set({ selectedId: id, selectedAnnotationIds: id ? [id] : [] }),
  
  setActiveTool: (tool) => set({ activeTool: tool }),

  setCurrentColor: (c) => set({ currentColor: c }),
  setCurrentStrokeWidth: (w) => set({ currentStrokeWidth: w }),
  setCurrentFontSize: (s) => set({ currentFontSize: s }),
  setCurrentBold: (b) => set({ currentBold: b }),
  setCurrentItalic: (b) => set({ currentItalic: b }),
  setCurrentAlign: (a) => set({ currentAlign: a }),
  setCurrentFontFamily: (f) => set({ currentFontFamily: f }),
  setCurrentTextBg: (b) => set({ currentTextBg: b }),
  setCurrentBgColor: (c) => set({ currentBgColor: c }),
  setCurrentBgOpacity: (n) => set({ currentBgOpacity: n }),
  setCurrentTextStroke: (b) => set({ currentTextStroke: b }),
  setMaskBlur: (b) => set({ maskBlur: b }),
  setMaskStrength: (s) => set({ maskStrength: s }),
  setMaskSolid: (b) => set({ maskSolid: b }),
  setMaskBrushSize: (s) => set({ maskBrushSize: s }),

  clearAnnotations: () => set((s) => ({
    annotations: [],
    selectedAnnotationIds: [],
    selectedId: null,
    // 保留撤销能力：把当前 annotations 压入 past，清空 future
    past: s.annotations.length > 0 ? [...s.past, s.annotations].slice(-HISTORY_LIMIT) : s.past,
    future: [],
  })),

  undo: () => set((s) => {
    if (s.past.length === 0) return s;
    const prev = s.past[s.past.length - 1];
    return {
      past: s.past.slice(0, -1),
      annotations: prev,
      layers: rebuildLayers(prev),
      future: [s.annotations, ...s.future].slice(0, HISTORY_LIMIT),
      selectedId: null,
      selectedAnnotationIds: [],
    };
  }),

  redo: () => set((s) => {
    if (s.future.length === 0) return s;
    const next = s.future[0];
    return {
      past: [...s.past, s.annotations].slice(-HISTORY_LIMIT),
      annotations: next,
      layers: rebuildLayers(next),
      future: s.future.slice(1),
      selectedId: null,
      selectedAnnotationIds: [],
    };
  }),
}));
