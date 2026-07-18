// 滚动长截图拼接算法（纯前端 Canvas）。
//
// 思路：用户手动滚动、每次捕获同一块区域一帧。相邻两帧在纵向存在重叠——
// 在「上一帧底部一段」与「当前帧」之间做逐行灰度差分（SAD），找到差异最小的
// 纵向偏移，即重叠高度；裁掉重复部分再往长图上拼。匹配置信度过低时直接相接
// 并标记 warning，由调用方提示用户。
//
// 前提：每帧尺寸一致（同一 rect 捕获），因此只需在纵向找偏移，横向恒定对齐，
// Retina/高 DPI 下同区域每帧物理像素一致，无缩放问题。

export interface StitchFrame {
  /** 帧图像（已解码） */
  img: HTMLCanvasElement | HTMLImageElement;
  width: number;
  height: number;
}

export interface StitchResult {
  /** 拼接后的长图 canvas */
  canvas: HTMLCanvasElement;
  /** 每帧检测到的重叠高度（像素），首帧为 0 */
  overlaps: number[];
  /** 是否出现过低置信度拼接（直接相接） */
  hadLowConfidence: boolean;
}

/** 把任意图源画到 canvas 并返回其 2D 灰度数据（Uint8，长度 = w*h） */
const toGray = (
  src: HTMLCanvasElement | HTMLImageElement,
  w: number,
  h: number
): Uint8ClampedArray => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // 加权灰度（Rec.601）
    gray[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return gray;
};

/**
 * 在 prev 帧底部与 cur 帧之间检测纵向重叠高度。
 * 返回 { overlap, confident }：overlap 为 cur 顶部与 prev 底部重合的像素高度。
 *
 * 算法：取 prev 底部一条参考带（高 band），在 cur 顶部滑动，逐行比较灰度平均绝对差，
 * 找到 SAD 最小的位置。为提速：横向按步长采样、纵向只比较参考带若干行。
 */
export const detectOverlap = (
  prevGray: Uint8ClampedArray,
  curGray: Uint8ClampedArray,
  w: number,
  h: number
): { overlap: number; confident: boolean } => {
  // 参考带高度：一帧的 ~35%，但不超过 240px（够用且快）
  const band = Math.min(Math.floor(h * 0.35), 240);
  if (band < 8) return { overlap: 0, confident: false };

  // 横向采样步长（跳采加速），保证至少 ~64 个采样列
  const xStep = Math.max(1, Math.floor(w / 64));
  // 参考带内纵向采样行数
  const rows: number[] = [];
  const rowStep = Math.max(1, Math.floor(band / 24));
  for (let r = 0; r < band; r += rowStep) rows.push(r);

  // prev 底部参考带的起始行
  const prevBandTop = h - band;

  let bestOffset = 0;
  let bestScore = Infinity;
  let secondBest = Infinity;

  // 尝试的重叠范围：cur 顶部从 offset=1..(h-band) 处对齐 prev 底部参考带
  const maxOffset = h - band;
  for (let off = 1; off <= maxOffset; off++) {
    let sum = 0;
    let count = 0;
    for (const r of rows) {
      const prevRow = (prevBandTop + r) * w;
      const curRow = (off + r) * w;
      for (let x = 0; x < w; x += xStep) {
        const d = prevGray[prevRow + x] - curGray[curRow + x];
        sum += d < 0 ? -d : d;
        count++;
      }
    }
    const score = sum / count;
    if (score < bestScore) {
      secondBest = bestScore;
      bestScore = score;
      bestOffset = off;
    } else if (score < secondBest) {
      secondBest = score;
    }
  }

  // 置信度：最佳分数要足够小（像素平均差 < 12），且明显优于次佳（区分度）。
  // bestOffset 即 prev 底部参考带在 cur 中出现的位置 → cur 顶部有 bestOffset 行是
  // prev 已包含的内容（重叠）。
  const confident = bestScore < 12 && bestScore < secondBest * 0.85;
  return { overlap: confident ? bestOffset : 0, confident };
};

/**
 * 依次拼接多帧为一张长图。frames[0] 为顶部，之后每帧检测与上一帧的重叠并裁掉重复。
 */
export const stitchFrames = (frames: StitchFrame[]): StitchResult => {
  if (frames.length === 0) {
    const empty = document.createElement('canvas');
    empty.width = 1;
    empty.height = 1;
    return { canvas: empty, overlaps: [], hadLowConfidence: false };
  }

  const w = frames[0].width;
  // 统一宽度（以首帧为准）
  const grays = frames.map((f) => toGray(f.img, w, f.height));

  const overlaps: number[] = [0];
  let hadLowConfidence = false;
  // 每帧在长图中要绘制的「有效高度」（裁掉与上一帧重叠的部分）
  const drawHeights: number[] = [frames[0].height];

  for (let i = 1; i < frames.length; i++) {
    const { overlap, confident } = detectOverlap(grays[i - 1], grays[i], w, frames[i].height);
    if (!confident) hadLowConfidence = true;
    overlaps.push(overlap);
    drawHeights.push(frames[i].height - overlap);
  }

  const totalH = drawHeights.reduce((a, b) => a + b, 0);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = totalH;
  const ctx = canvas.getContext('2d')!;

  let y = 0;
  for (let i = 0; i < frames.length; i++) {
    const ov = overlaps[i];
    // 从该帧的 ov 行开始绘制（裁掉顶部重叠），画到长图当前 y
    ctx.drawImage(
      frames[i].img,
      0, ov, w, frames[i].height - ov,
      0, y, w, frames[i].height - ov
    );
    y += drawHeights[i];
  }

  return { canvas, overlaps, hadLowConfidence };
};

/** dataURL → 已解码 HTMLImageElement */
export const loadImage = (dataUrl: string): Promise<HTMLImageElement> =>
  new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('图像解码失败'));
    img.src = dataUrl;
  });
