/// <reference types="vite/client" />
declare module 'troika-three-text' {
  import { Object3D, Color, Material } from 'three';
  export class Text extends Object3D {
    text: string;
    font: string | null;
    fontSize: number;
    color: Color | string | number;
    anchorX: string | number;
    anchorY: string | number;
    maxWidth: number | undefined;
    lineHeight: number | undefined;
    depthTest: boolean;
    material: Material | null;
    textRenderInfo: {
      blockWidth: number;
      blockHeight: number;
    } | null;
    sync(callback?: () => void): void;
    dispose(): void;
  }
  export class BatchedText extends Text {
    addText(text: Text): void;
    removeText(text: Text): void;
  }
}
