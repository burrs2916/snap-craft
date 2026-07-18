// AI 窗口侧的「远程工具宿主」：实现 AiToolHost 接口，把工具调用经 IPC 转发主窗口执行
// （主窗口的 aiTools 用 addAnnotation/flashRegion 在真实画布上落笔）。
//
// 关键对齐（铁律：模型只给 0~1 归一化坐标，像素换算严格在主窗口做）：
//  - draw/redact/highlight/arrow/callout 在 AiToolHost 里是「同步返回 string」的签名，
//    而 IPC 是异步的，因此这里走 fire-and-forget（emitTool 不等待结果），
//    并用本窗口已知的 size 本地算出像素坐标串作为即时反馈——与主窗口 normToPx 完全一致。
//  - summarize_region 是 async，走 callTool 请求/响应拿主窗口 OCR 结果。
//  - 所有坐标原样以 0~1 转发，绝不碰像素。

import type { AiToolHost, NormRect, NormPoint } from '../features/ai/aiTools';
import { emitTool, callTool } from './bridge';

const clamp01 = (v: any): number => Math.max(0, Math.min(1, Number(v) || 0));

export class RemoteToolHost implements AiToolHost {
  private size: { width: number; height: number } | null = null;

  constructor(size: { width: number; height: number } | null = null) {
    this.size = size;
  }

  /** 主窗口推送上下文时更新已知尺寸（getImageSize 与本地坐标串计算用） */
  setSize(size: { width: number; height: number } | null): void {
    this.size = size;
  }

  getImageSize(): { width: number; height: number } | null {
    return this.size;
  }

  // 与 EnhancedScreenshotApp.normToPx 完全一致：round + clamp01
  private toPx(r: NormRect): { x: number; y: number; w: number; h: number } {
    const W = this.size?.width ?? 0;
    const H = this.size?.height ?? 0;
    return {
      x: Math.round(clamp01(r.x) * W),
      y: Math.round(clamp01(r.y) * H),
      w: Math.round(clamp01(r.w) * W),
      h: Math.round(clamp01(r.h) * H),
    };
  }

  drawRectangle(rect: NormRect, opts?: { color?: string; label?: string }): string {
    const { x, y, w, h } = this.toPx(rect);
    emitTool('draw_rectangle', {
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      color: opts?.color,
      label: opts?.label,
    });
    return `(${x},${y})-(${x + w},${y + h})`;
  }

  redactArea(rect: NormRect, mode: 'blur' | 'mosaic' | 'black', strength?: number): string {
    const { x, y, w, h } = this.toPx(rect);
    emitTool('redact_area', { x: rect.x, y: rect.y, w: rect.w, h: rect.h, mode, strength });
    return `(${x},${y})-(${x + w},${y + h})`;
  }

  highlightRect(rect: NormRect, color?: string): string {
    const { x, y, w, h } = this.toPx(rect);
    emitTool('highlight_text', { x: rect.x, y: rect.y, w: rect.w, h: rect.h, color });
    return `(${x},${y})-(${x + w},${y + h})`;
  }

  drawArrow(from: NormPoint, to: NormPoint, opts?: { color?: string; label?: string }): string {
    const W = this.size?.width ?? 0;
    const H = this.size?.height ?? 0;
    const fx = Math.round(clamp01(from.x) * W);
    const fy = Math.round(clamp01(from.y) * H);
    const tx = Math.round(clamp01(to.x) * W);
    const ty = Math.round(clamp01(to.y) * H);
    emitTool('draw_arrow', {
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      color: opts?.color,
      label: opts?.label,
    });
    return `(${fx},${fy})→(${tx},${ty})`;
  }

  drawCallout(
    anchor: NormPoint,
    label: NormPoint,
    opts?: { color?: string; text?: string },
  ): string {
    const W = this.size?.width ?? 0;
    const H = this.size?.height ?? 0;
    const ax = Math.round(clamp01(anchor.x) * W);
    const ay = Math.round(clamp01(anchor.y) * H);
    const lx = Math.round(clamp01(label.x) * W);
    const ly = Math.round(clamp01(label.y) * H);
    emitTool('draw_callout', {
      ax: anchor.x,
      ay: anchor.y,
      lx: label.x,
      ly: label.y,
      color: opts?.color,
      text: opts?.text,
    });
    return `锚点(${ax},${ay})→气泡(${lx},${ly}) 文字「${opts?.text || ''}」`;
  }

  async summarizeRegion(rect: NormRect): Promise<string> {
    const res = await callTool('summarize_region', {
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
    });
    return res.content;
  }
}
