export interface Point {
  x: number;
  y: number;
}

export interface AnnotationGeometry {
  type: 'point' | 'line' | 'rectangle' | 'circle' | 'text' | 'arrow' | 'freehand' | 'highlight' | 'mosaic' | 'number' | 'ruler';
  points: Point[];
  text?: string;
  fontSize?: number;
}

export interface AnnotationObject {
  id: string;
  geometry: AnnotationGeometry;
  layerId: string;
  color: string;
  lineWidth: number;
  opacity: number;
  properties: Record<string, string>;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  objects: string[];  // AnnotationObject IDs
}

export interface ScreenshotData {
  id: string;
  filePath: string;
  dataUrl: string;
  width: number;
  height: number;
  annotations: AnnotationObject[];
  layers: Layer[];
  createdAt: string;
  updatedAt: string;
}
