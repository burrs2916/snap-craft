// ===== 共享辅助函数 =====
// 从 EnhancedScreenshotApp.tsx 提取，供 OCR / AI / 编辑器等多模块复用。

import { invoke } from '@tauri-apps/api/core';
import type { NormRect } from '../../ai/aiTools';

// ── 通用 ──
export const clamp01 = (v: any): number => Math.max(0, Math.min(1, Number(v) || 0));
export const genAnnoId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** 归一化矩形(0~1) → 原图像素坐标 */
export function normToPx(r: NormRect, W: number, H: number) {
  const x = Math.round(clamp01(r.x) * W);
  const y = Math.round(clamp01(r.y) * H);
  const w = Math.round(clamp01(r.w) * W);
  const h = Math.round(clamp01(r.h) * H);
  return { x, y, w, h };
}

/** 从源图 dataURL 裁剪指定像素区域，返回新的 dataURL（供区域 OCR 使用） */
export function cropDataUrl(src: string, x: number, y: number, w: number, h: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cx = document.createElement('canvas');
      cx.width = Math.max(1, Math.round(w));
      cx.height = Math.max(1, Math.round(h));
      const ctx = cx.getContext('2d');
      if (!ctx) return reject(new Error('no 2d context'));
      ctx.drawImage(img, x, y, w, h, 0, 0, cx.width, cx.height);
      resolve(cx.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

// 诊断日志：写入 logs/dev.log（tag=diag，前缀 [flow]）。best-effort，绝不阻断主流程。
export const flog = (msg: string) => {
  invoke('diag_log', { msg: `[flow] ${msg}` }).catch(() => {});
};
