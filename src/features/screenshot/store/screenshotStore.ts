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
  clearAnnotations: () => void;
}

const HISTORY_LIMIT = 50;

// 保留现有图层结构，只按 annotations 重新推导每层的 objects（不丢非 default 层）
const rebuildLayers = (anns: AnnotationObject[], existing: Layer[]): Layer[] =>
  existing.map((layer) => ({
    ...layer,
    objects: anns.filter((a) => a.layerId === layer.id).map((a) => a.id),
  }));

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
  past: [],
  platform: '',
  setPlatform: (p) => set({ platform: p }),
  captureMode: 'region',
  setCaptureMode: (m) => set({ captureMode: m }),
  future: [],

  setCurrentScreenshot: (screenshot) => set({ currentScreenshot: screenshot }),
  
  addAnnotation: (annotation) => set((state) => {
    const ann = { ...annotation, layerId: annotation.layerId || state.activeLayerId || 'default' };
    const anns = [...state.annotations, ann];
    return {
      past: [...state.past, state.annotations].slice(-HISTORY_LIMIT),
      annotations: anns,
      layers: rebuildLayers(anns, state.layers),
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
      layers: rebuildLayers(anns, state.layers),
      future: [],
    };
  }),

  deleteAnnotation: (id) => set((state) => {
    const anns = state.annotations.filter(ann => ann.id !== id);
    return {
      past: [...state.past, state.annotations].slice(-HISTORY_LIMIT),
      annotations: anns,
      layers: rebuildLayers(anns, state.layers),
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
  
  deleteLayer: (id) => set((state) => {
    const anns = state.annotations.filter((a) => a.layerId !== id);
    const layers = state.layers.filter((l) => l.id !== id);
    return {
      annotations: anns,
      layers: rebuildLayers(anns, layers),
      activeLayerId: state.activeLayerId === id ? (layers[0]?.id ?? 'default') : state.activeLayerId,
    };
  }),
  
  setSelectedAnnotations: (ids) => set({ selectedAnnotationIds: ids }),
  
  setSelectedId: (id) => set({ selectedId: id, selectedAnnotationIds: id ? [id] : [] }),
  
  setActiveTool: (tool) => set({ activeTool: tool }),

  setCurrentColor: (c) => set({ currentColor: c }),
  setCurrentStrokeWidth: (w) => set({ currentStrokeWidth: w }),

  clearAnnotations: () => set((state) => ({
    annotations: [],
    selectedAnnotationIds: [],
    selectedId: null,
    past: [],
    future: [],
    layers: state.layers.map((l) => ({ ...l, objects: [] })),
  })),

  undo: () => set((s) => {
    if (s.past.length === 0) return s;
    const prev = s.past[s.past.length - 1];
    return {
      past: s.past.slice(0, -1),
      annotations: prev,
      layers: rebuildLayers(prev, s.layers),
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
      layers: rebuildLayers(next, s.layers),
      future: s.future.slice(1),
      selectedId: null,
      selectedAnnotationIds: [],
    };
  }),
}));
