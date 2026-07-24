// src/shared/geometry.ts
// 共享几何类型与工具函数。
//
// 此前 NormRect / NormPoint 定义在 features/ai/aiTools.ts，
// 而 clamp01 / normToPx 定义在 features/screenshot/utils/helpers.ts，
// 导致 screenshot ↔ ai 两个 feature 模块产生循环依赖：
//   - screenshot/utils/helpers.ts → import NormRect from ai/aiTools
//   - ai-window/RemoteToolHost.ts → import clamp01 from screenshot/utils/helpers
//
// 本模块将纯几何类型与计算提取到 shared 层，两个 feature 都从此导入，
// 彻底打破循环依赖，同时保持类型与算法的单一来源。

/** 归一化矩形（0~1 相对比例，左上角 0,0） */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 归一化点（0~1 相对比例，左上角 0,0） */
export interface NormPoint {
  x: number;
  y: number;
}

/** 将任意值钳制到 [0, 1] 区间（NaN / undefined 视为 0） */
export const clamp01 = (v: any): number => Math.max(0, Math.min(1, Number(v) || 0));

/** 归一化矩形(0~1) → 原图像素坐标 */
export function normToPx(r: NormRect, W: number, H: number) {
  const x = Math.round(clamp01(r.x) * W);
  const y = Math.round(clamp01(r.y) * H);
  const w = Math.round(clamp01(r.w) * W);
  const h = Math.round(clamp01(r.h) * H);
  return { x, y, w, h };
}

/** 归一化点(0~1) → 原图像素坐标 */
export function pointToPx(p: NormPoint, W: number, H: number) {
  return {
    x: Math.round(clamp01(p.x) * W),
    y: Math.round(clamp01(p.y) * H),
  };
}
