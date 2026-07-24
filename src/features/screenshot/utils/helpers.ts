// ===== 共享辅助函数 =====
// 从 EnhancedScreenshotApp.tsx 提取，供 OCR / AI / 编辑器等多模块复用。
//
// 2026-07-23 架构解耦：几何类型与计算（NormRect / clamp01 / normToPx）
// 已迁移至 shared/geometry.ts，打破 screenshot ↔ ai 循环依赖。
// 本文件保留 re-export 确保既有导入路径不受影响。

import { invoke } from '@tauri-apps/api/core';

// 向后兼容：此前从 aiTools 导入 NormRect，现统一从 shared/geometry 导入
export { clamp01, normToPx, type NormRect, type NormPoint } from '../../../shared/geometry';
import { clamp01 } from '../../../shared/geometry';

// ── 通用 ──
export const genAnnoId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

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
