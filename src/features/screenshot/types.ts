export interface Point {
  x: number;
  y: number;
}

export interface AnnotationGeometry {
  type: 'point' | 'line' | 'rectangle' | 'circle' | 'text' | 'arrow' | 'freehand' | 'mosaic' | 'step' | 'highlight' | 'callout';
  points: Point[];
  text?: string;
  fontSize?: number;
  /** 文字标注：CSS font-family 栈（含字体族列表），默认系统字体 */
  fontFamily?: string;
  /** 文字标注：是否粗体 */
  bold?: boolean;
  /** 文字标注：是否斜体 */
  italic?: boolean;
  /** 文字标注：水平对齐 left | center | right */
  align?: 'left' | 'center' | 'right';
  /** 文字标注：是否加半透明底衬（提升对比度） */
  bg?: boolean;
  /** 文字标注：底衬颜色（用户可选，默认深色），bg 为 true 时生效 */
  bgColor?: string;
  /** 文字标注：底衬透明度，0~1（1=不透明），bg 为 true 时生效，支持半透明底衬 */
  bgOpacity?: number;
  /** 文字标注：是否加描边（自动对比色轮廓，保证在任意截图背景上都清晰可读） */
  stroke?: boolean;
  /** 序号标注（step）的编号，从 1 递增 */
  stepNumber?: number;
  /** 打码标注：true=高斯模糊，false/缺省=马赛克像素化 */
  blur?: boolean;
  /** 打码标注强度：马赛克块大小 / 模糊半径（自然像素） */
  strength?: number;
  /** 打码模式：'rect'=矩形区域(默认)，'brush'=画笔涂抹路径 */
  maskMode?: 'rect' | 'brush';
  /** 画笔打码的笔刷半径（自然像素），maskMode='brush' 时生效 */
  brushSize?: number;
  /** 涂黑遮挡：true=纯色遮挡(用 color 填充)，false/缺省=正常打码 */
  solid?: boolean;
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

/** 单个 OCR 文字块：坐标已归一化（原点左上，0..1），与画布坐标一致。 */
export interface OcrBlock {
  text: string;
  /** 左上角 x（0..1） */
  x: number;
  /** 左上角 y（0..1） */
  y: number;
  /** 宽（0..1） */
  w: number;
  /** 高（0..1） */
  h: number;
  /** 置信度 0..1；部分平台不提供时为 0 */
  confidence: number;
}

/** OCR 识别结果：纯文本（行以 \n 连接）+ 带位置/置信度的逐块结果。 */
export interface OcrResult {
  text: string;
  blocks: OcrBlock[];
}
