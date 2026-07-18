/**
 * EditorWindow - 独立编辑窗（每个截图一个独立 Tauri WebviewWindow，可同时开多个）
 *
 * 数据流：hash 取 id -> invoke('get_screenshot') 取图 + 标注 -> 灌进本地 Zustand store
 *   （独立 webview 自动获得全新 store 实例，与主窗口互不干扰）。
 * 关闭/保存时把标注 JSON 回写后端 update_screenshot_annotations。
 *
 * 布局：顶部工具栏 + 左侧画布（AnnotationCanvas）+ 右侧取字侧边栏（常驻、非遮挡）。
 * 不再需要「返回」按钮--关窗口即可。
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
// Phase 18：OCR 文本清洗
import { cleanOcrText } from '../../ai/ocrClean';
import { useI18n, t } from '../../../i18n';
import { useScreenshotStore } from '../store/screenshotStore';
import { AnnotationCanvas, type AnnotationCanvasHandle } from './AnnotationCanvas';
import { AnnotationToolbar } from './AnnotationToolbar';
import type { OcrResult, OcrBlock, AnnotationObject } from '../types';
import type { AiToolHost, NormRect } from '../../ai/aiTools';
import { createToolExecutor } from '../../ai/aiTools';
import { openAiWindow, pushAiContext, setupMainBridge, type AiContext } from '../../../ai-window/bridge';

// N3：多区域连续框选 OCR 的单个区域结果
interface RegionOcrResult {
  id: string;
  dataUrl: string; // 裁剪区域图（用于缩略图回显）
  text: string; // 该区域 OCR 文字
  blocks: OcrBlock[];
}

// ── Phase 14：AI 智能编辑 — 工具宿主辅助函数 ──
const clamp01 = (v: any): number => Math.max(0, Math.min(1, Number(v) || 0));
const genAnnoId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** 归一化矩形(0~1) → 原图像素坐标 */
function normToPx(r: NormRect, W: number, H: number) {
  const x = Math.round(clamp01(r.x) * W);
  const y = Math.round(clamp01(r.y) * H);
  const w = Math.round(clamp01(r.w) * W);
  const h = Math.round(clamp01(r.h) * H);
  return { x, y, w, h };
}

/** 从源图 dataURL 裁剪指定像素区域，返回新的 dataURL（供区域 OCR 使用） */
function cropDataUrl(src: string, x: number, y: number, w: number, h: number): Promise<string> {
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

const elog = (msg: string) => {
  invoke('diag_log', { msg: `[editor-window] ${msg}` }).catch(() => {});
};

// OCR 阅读顺序模式：'none' 保留原生读序；'reading' 按块坐标智能重排（多列/竖排）。
type OcrLayout = 'none' | 'reading';
// OCR 导出格式：'txt' 纯文本 / 'md' Markdown / 'json' 带坐标 / 'tsv' 带坐标。
type OcrExportFmt = 'txt' | 'md' | 'json' | 'tsv';

// 智能阅读顺序：按块坐标把乱序结果重排为正常阅读顺序（与主窗同源逻辑，隔离复用）。
// 仅改变遍历顺序，返回原始块下标数组，编辑映射不被破坏。
function ocrReadingOrder(blocks: OcrBlock[]): number[] {
  const idx = blocks.map((_, i) => i);
  if (blocks.length < 2) return idx;
  const vertCount = blocks.filter((b) => b.h > b.w * 1.2).length;
  const isVertical = vertCount > blocks.length / 2;
  if (isVertical) {
    return [...idx].sort((a, b) => {
      const A = blocks[a];
      const B = blocks[b];
      const ax = A.x + A.w / 2;
      const bx = B.x + B.w / 2;
      const ay = A.y + A.h / 2;
      const by = B.y + B.h / 2;
      if (Math.abs(ax - bx) < (A.w + B.w) / 2) return ay - by;
      return bx - ax;
    });
  }
  const byX = [...idx].sort((a, b) => blocks[a].x + blocks[a].w / 2 - (blocks[b].x + blocks[b].w / 2));
  const columns: number[][] = [];
  let cur: number[] = [byX[0]];
  for (let k = 1; k < byX.length; k++) {
    const prev = blocks[byX[k - 1]];
    const curB = blocks[byX[k]];
    const gap = curB.x + curB.w / 2 - (prev.x + prev.w / 2);
    const avgW = (prev.w + curB.w) / 2;
    if (gap > avgW * 0.6) {
      columns.push(cur);
      cur = [byX[k]];
    } else {
      cur.push(byX[k]);
    }
  }
  columns.push(cur);
  columns.forEach((col) => col.sort((a, b) => blocks[a].y - blocks[b].y));
  columns.sort((a, b) => blocks[a[0]].x - blocks[b[0]].x);
  return columns.flat();
}

// 把文字按搜索词切成高亮片段（大小写不敏感，不用正则避免注入）。
function ocrHighlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text, hit: false }];
  const lt = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: { text: string; hit: boolean }[] = [];
  let idx = 0;
  let at = lt.indexOf(ql, idx);
  while (at >= 0) {
    if (at > idx) out.push({ text: text.slice(idx, at), hit: false });
    out.push({ text: text.slice(at, at + q.length), hit: true });
    idx = at + q.length;
    at = lt.indexOf(ql, idx);
  }
  if (idx < text.length) out.push({ text: text.slice(idx), hit: false });
  return out;
}

// 智能实体提取：从识别结果文本中按需提取 URL / 邮箱 / 电话号码，便于一键复制。
// 与主窗同源逻辑（隔离复制，避免 EditorWindow <-> EnhancedScreenshotApp 循环依赖）；
// 纯前端、安全正则 + 去重，不进入复制/导出/贴回数据链，仅作侧栏辅助视图。
interface OcrEntity {
  urls: string[];
  emails: string[];
  phones: string[];
}
function ocrExtractEntities(text: string): OcrEntity {
  const urls = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  if (!text) return { urls: [], emails: [], phones: [] };

  // URL：http(s):// 或 www. 开头，截到空白/引号/中文标点为止；去掉结尾可能的标点。
  const urlRe = /(?:https?:\/\/|www\.)[^\s<>"'」』）)】〗，。、；：！？]+/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    const u = m[0].replace(/[)\]】』」』）.,;:!?]+$/, '');
    if (u.length > 4) urls.add(u);
  }

  // 邮箱：标准 user@domain.tld 形态。
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  while ((m = emailRe.exec(text)) !== null) emails.add(m[0]);

  // 电话：7–14 位数字，可含空格/括号/连字符/点；过滤纯日期（YYYY-MM-DD 等）与过短/过长。
  const phoneRe = /(\+?\d[\d\s\-().]{5,}\d)/g;
  const isDate = (s: string) => /^\d{4}[-.\s]\d{1,2}[-.\s]\d{1,2}$/.test(s.trim());
  while ((m = phoneRe.exec(text)) !== null) {
    const p = m[0].trim();
    const digits = p.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 14) continue;
    if (isDate(p)) continue; // 避免把日期误判为电话
    // 必含分隔特征：国际号(+)、空格、括号，或含连字符/点（且非日期）；
    // 纯数字串仅接受 11 位（中国大陆手机号启发式），规避价格/编号等长数字误判。
    const ok =
      p.startsWith('+') ||
      /[\s()]/.test(p) ||
      /[-.]/.test(p) ||
      digits.length === 11;
    if (ok) phones.add(p);
  }

  return {
    urls: [...urls],
    emails: [...emails],
    phones: [...phones],
  };
}

// N4：长图/超大图自动分块 OCR —— 纯前端、零后端。
// 系统 OCR（Apple Vision / WinRT）对超大输入会内部降采样，长图小字易漏识别；
// 前端按高度切块分别识别、坐标映射回整图、几何重排、去重，显著提升长图质量。
const OCR_BLOCK_H = 1200;      // 每块高度（像素）
const OCR_OVERLAP = 150;       // 块间重叠（像素），缓解边界行截断
const OCR_LONG_RATIO = 2.2;    // 长图判定：高/宽 > 此值
const OCR_LONG_ABS = 2400;     // 长图判定：高 > 此绝对值（像素）

function isLongImage(w: number, h: number): boolean {
  return w > 0 && h > 0 && (h > w * OCR_LONG_RATIO || h > OCR_LONG_ABS);
}

function loadImageEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('图片加载失败'));
    im.src = src;
  });
}

// 单块归一化坐标 → 整图归一化坐标（按高度切，宽度不变）
function mapBlockToFull(b: OcrBlock, startY: number, blockH: number, fullH: number): OcrBlock {
  return {
    text: b.text,
    x: b.x,
    y: (startY + b.y * blockH) / fullH,
    w: b.w,
    h: (b.h * blockH) / fullH,
    confidence: b.confidence,
  };
}

// 去重重叠区重复行：同名块（阅读序重排后可能不相邻，故与所有已保留块比较）且位置几乎重合
// （映射回整图后 y/x 仅 OCR 抖动差异，<0.5%/2%）视为同一行；阈值远小于真实行间距，
// 避免把列表里重复文字（如多项「完成」）误合并丢失。
function dedupeBlocks(blocks: OcrBlock[]): OcrBlock[] {
  const out: OcrBlock[] = [];
  for (const b of blocks) {
    const dup = out.find(
      (p) =>
        p.text.trim() === b.text.trim() &&
        Math.abs(p.y - b.y) < 0.005 &&
        Math.abs(p.x - b.x) < 0.02,
    );
    if (!dup) out.push(b);
  }
  return out;
}

// 逐块识别并合并：串行切块 → ocr_image → 映射坐标 → 阅读顺序重排 → 去重
async function runTiledOcr(
  imageData: string,
  fullW: number,
  fullH: number,
  lang: string | null,
): Promise<OcrResult> {
  const im = await loadImageEl(imageData);
  const W = im.naturalWidth || fullW;
  const H = im.naturalHeight || fullH;
  const step = OCR_BLOCK_H - OCR_OVERLAP;
  const all: OcrBlock[] = [];
  for (let startY = 0; startY < H; startY += step) {
    const blockH = Math.min(OCR_BLOCK_H, H - startY);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = blockH;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.drawImage(im, 0, startY, W, blockH, 0, 0, W, blockH);
    const dataUrl = canvas.toDataURL('image/png');
    try {
      const res = await invoke<OcrResult>('ocr_image', {
        imageData: dataUrl,
        lang: lang === 'auto' ? null : lang,
      });
      // Phase 18：清洗 OCR 乱码
      const cleanedBlocks = (res?.blocks ?? []).map((b) => ({ ...b, text: cleanOcrText(b.text) }));
      for (const b of cleanedBlocks) all.push(mapBlockToFull(b, startY, blockH, H));
    } catch {
      // 单块失败不中断整体，其余块仍可用
    }
  }
  if (all.length === 0) throw new Error('未识别到文字');
  const order = ocrReadingOrder(all);
  const ordered = order.map((i) => all[i]);
  const deduped = dedupeBlocks(ordered);
  const text = deduped.map((b) => b.text).join('\n');
  return { text, blocks: deduped };
}

export const EditorWindow = () => {
  useI18n(); // 跟随语言切换

  const [mode, setMode] = useState<'editor' | 'clipboard'>('editor');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [imageData, setImageData] = useState<string>('');
  const [imgWidth, setImgWidth] = useState(0);
  const [imgHeight, setImgHeight] = useState(0);
  const [screenshotId, setScreenshotId] = useState<string>('');
  const [sourceKind, setSourceKind] = useState<'image' | 'text'>('image');
  const [toast, setToast] = useState<string | null>(null);
  const [toastType, setToastType] = useState<'success' | 'error' | 'info'>('info');

  // OCR 侧边栏状态（自包含，不依赖主窗口的 ocr* 状态）
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  // 用 ref 持有最新 OCR 结果，供 refreshAiVision 在不重建回调的情况下读取（避免 stale closure）。
  const ocrResultRef = useRef<OcrResult | null>(null);
  ocrResultRef.current = ocrResult;
  // AI 助手面板开关（默认关闭，非侵入）
  const [aiOpen, setAiOpen] = useState(false);
  // AI 实际看到的「编辑后截图」（底图 + 全部标注，含打码/模糊）。默认等于原图，
  // 打开面板或用户点「同步最新编辑」时，由 canvasRef.getMergedImageDataUrl() 重算。
  const [aiVisionUrl, setAiVisionUrl] = useState(imageData);
  // 发给 AI 的 OCR 文字：默认等于原图 OCR；用户编辑/打码后点「同步最新编辑」会重跑 OCR 得到编辑后文字，
  // 避免打码/模糊区域的原文经 OCR 上下文泄漏给模型（候选④）。
  const [aiOcrText, setAiOcrText] = useState<string>('');
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrLang, setOcrLang] = useState('auto');
  const [ocrElapsed, setOcrElapsed] = useState<number | null>(null);
  // 增强 OCR 侧栏状态（对齐主窗富面板能力，R1/R2/R3）
  const [ocrSearch, setOcrSearch] = useState('');
  const [ocrConf, setOcrConf] = useState(0); // 置信度阈值 %
  const [ocrLayout, setOcrLayout] = useState<OcrLayout>('none');
  const [ocrMerge, setOcrMerge] = useState(false); // 合并为一行
  const [ocrFormat, setOcrFormat] = useState<OcrExportFmt>('txt');
  const [ocrEdits, setOcrEdits] = useState<Record<number, string>>({}); // R2 逐行勘误
  const [ocrSel, setOcrSel] = useState<Record<number, boolean>>({}); // 逐行勾选
  const [ocrEditing, setOcrEditing] = useState<number | null>(null); // 正在内联编辑的行
  const [ocrExtract, setOcrExtract] = useState(false); // N2：智能实体提取开关
  // N2 下半：OCR 结果文字字号（作用于侧栏行文字，长文可缩放阅读）；范围 11–22，与主窗一致。
  const [ocrFontSize, setOcrFontSize] = useState(14);
  const [ocrAutoCopy, setOcrAutoCopy] = useState(false); // N2：识别后自动复制剪贴板
  const [platform, setPlatformState] = useState(''); // 本地平台（门控置信度控件）
  // 框选区域 OCR：开启时画布进入选区模式（AnnotationCanvas 已支持 ocrRegionMode）
  const [ocrSelectionMode, setOcrSelectionMode] = useState(false);
  // 最近一次框选区域的裁剪图（用于侧边栏预览回显，整图识别时清空）
  const [ocrRegionPreview, setOcrRegionPreview] = useState<string | null>(null);
  // N3：多区域连续框选 OCR——开启后选区模式不退出，区域结果累加进 ocrRegions
  const [ocrMultiRegion, setOcrMultiRegion] = useState(false);
  const [ocrRegions, setOcrRegions] = useState<RegionOcrResult[]>([]);

  const canvasRef = useRef<AnnotationCanvasHandle>(null);
  const autoOcrRef = useRef(false); // 防重复自动 OCR
  // 持最新 loadFromClipboard 引用，供「重新读取」事件监听器调用（避免闭包捕获旧版本）
  const loadFromClipboardRef = useRef<() => Promise<void>>(async () => {});

  // 从 store 取标注和工具状态（独立 webview = 全新 store 实例）
  const {
    annotations,
    addAnnotation,
    activeTool,
    setPlatform,
    // 贴回画布：复用当前文字样式默认值（来自 store 默认值）
    currentColor,
    currentStrokeWidth,
    currentFontFamily,
    currentBold,
    currentItalic,
    currentTextBg,
    currentBgColor,
    currentBgOpacity,
    currentTextStroke,
  } = useScreenshotStore();

  const flash = useCallback((msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast(msg);
    setToastType(type);
    window.setTimeout(() => setToast(null), type === 'error' ? 5000 : type === 'info' ? 2600 : 1800);
  }, []);

  // 挂载：按 hash 前缀走不同加载路径
  //   #editor?id=xxx     -> 从历史取图 + 标注
  //   #clipboard-ocr     -> 自己读剪贴板（文字优先 -> 图片次之 -> 空中性提示）
  useEffect(() => {
    (async () => {
      const hash = window.location.hash;
      const isClipboard = hash.startsWith('#clipboard-ocr');
      setMode(isClipboard ? 'clipboard' : 'editor');

      // 平台检测（AnnotationCanvas/Toolbar 需要；同时记录本地平台用于门控置信度控件）
      try {
        const platform = await invoke<string>('get_platform');
        setPlatform(platform);
        setPlatformState(platform);
      } catch {
        /* ignore */
      }

      if (isClipboard) {
        await loadFromClipboard();
      } else {
        await loadFromHistory();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 模式 1：从历史取图
  const loadFromHistory = async () => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    const id = params.get('id');
    if (!id) {
      setError('Missing id');
      setLoading(false);
      return;
    }
    setScreenshotId(id);
    setSourceKind('image');
    try {
      const item = await invoke<any>('get_screenshot', { id });
      if (!item) {
        setError(t('editor.notFound'));
        setLoading(false);
        return;
      }
      setImageData(item.data_url);
      setImgWidth(item.width);
      setImgHeight(item.height);

      // 灌入已有标注
      if (item.annotations) {
        try {
          const anns = JSON.parse(item.annotations) as AnnotationObject[];
          if (Array.isArray(anns)) anns.forEach((a) => addAnnotation(a));
        } catch {
          /* 旧数据可能无标注或格式不兼容，忽略 */
        }
      }

      // 回显已持久化的 OCR 文字（若有），关窗后重开无需二次识别
      if (item.ocr_text) {
        // v4：优先用 ocr_blocks_json 恢复真实坐标 + 置信度（取字位置、逐行编辑可用）；
        // 旧版/无坐标时按行伪造全幅占位（保持向后兼容）。
        let blocks: { text: string; x: number; y: number; w: number; h: number; confidence: number }[] = [];
        if (item.ocr_blocks_json) {
          try {
            const parsed = JSON.parse(item.ocr_blocks_json);
            if (Array.isArray(parsed)) blocks = parsed;
          } catch {
            /* 容错：JSON 损坏则走占位路径 */
          }
        }
        if (blocks.length === 0) {
          const lines: string[] = String(item.ocr_text).split('\n');
          blocks = lines.map((l: string) => ({ text: l, x: 0, y: 0, w: 1, h: 1, confidence: 1 }));
        }
        setOcrResult({ text: String(item.ocr_text), blocks });
        setOcrElapsed(null);
      }

      // 取字入口带 ocr=1 打开时，挂载后自动跑一次 OCR（保持一键取字体验，与剪贴板图片模式一致）
      if (params.get('ocr') === '1') {
        setTimeout(() => doOcr(item.data_url), 100);
      }

      elog(`[editor] 加载完成: id=${id} ${item.width}x${item.height}`);
      setLoading(false);
    } catch (e) {
      setError(t('editor.loadFailed', { msg: String(e) }));
      setLoading(false);
    }
  };

  // 模式 2：从剪贴板取字（文字优先 -> 图片次之 -> 空中性提示）
  const loadFromClipboard = async () => {
    // 重新读取前重置状态（首次挂载时已 loading=true，这里保证「重新读取」也走 loading 态）
    setLoading(true);
    setError(null);
    setOcrResult(null);
    setOcrRegionPreview(null);
    setSourceKind('image');
    try {
      // 2a) 先探测文字
      let clipText: string | null = null;
      try {
        const raw = await invoke<string>('read_clipboard_text');
        if (raw && raw.trim().length > 0) clipText = raw;
      } catch {
        /* ERR_EMPTY 等：无文字 */
      }

      if (clipText) {
        // 文字模式：直接当取字结果（最贴合「取字」语义，无需 OCR）。
        // 关键修复：不再把文字渲染成假 PNG 卡片塞进画布——
        // 那样工具栏「复制」会复制出「文字的图片」而非文字本身。改为真实文本视图。
        setSourceKind('text');
        setImageData('');
        setImgWidth(0);
        setImgHeight(0);
        setOcrResult({
          text: clipText,
          blocks: [{ text: clipText, x: 0, y: 0, w: 1, h: 1, confidence: 1 }],
        });
        setOcrElapsed(0);
        flash(t('ocr.clipTextMode'), 'success');
        elog(`[clipboard] 文字模式: ${clipText.length} 字符`);
        setLoading(false);
        return;
      }

      // 2b) 图片路径
      const dataUrl = await invoke<string>('read_clipboard_image');
      if (!dataUrl || !dataUrl.startsWith('data:image')) {
        flash(t('ocr.clipEmptyNeutral'), 'info');
        setError(t('ocr.clipEmptyNeutral'));
        setLoading(false);
        return;
      }

      const dim = await getImageDims(dataUrl);
      setImageData(dataUrl);
      setImgWidth(dim.w);
      setImgHeight(dim.h);

      // 进历史网格（source=clipboard），可重开/钉住/删除
      const cid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const cAt = new Date().toISOString();
      setScreenshotId(cid);
      try {
        await invoke('add_history', {
          item: {
            id: cid,
            data_url: dataUrl,
            created_at: cAt,
            width: dim.w,
            height: dim.h,
            source: 'clipboard',
            annotations: '',
          },
        });
      } catch {
        /* 持久化失败不阻断 */
      }

      elog(`[clipboard] 图片模式: ${dim.w}x${dim.h} id=${cid}`);
      setLoading(false);

      // 自动跑 OCR（挂载后自动识别，比之前更省一步）
      setTimeout(() => doOcr(dataUrl), 100);
    } catch (e) {
      const msg = String(e);
      if (msg.includes('ERR_EMPTY') || msg.includes('没有图片') || /no image/i.test(msg)) {
        flash(t('ocr.clipEmptyNeutral'), 'info');
        setError(t('ocr.clipEmptyNeutral'));
      } else {
        setError(t('ocr.clipFailed', { msg }));
        flash(t('ocr.clipFailed', { msg }), 'error');
      }
      setLoading(false);
    }
  };

  // 持最新引用（每次渲染刷新），供下方事件监听器在「重新读取」时调用
  loadFromClipboardRef.current = loadFromClipboard;

  // ── OCR 增强辅助（对齐主窗富面板，R1/R2/R3），定义于消费方之前避免前向引用 ──
  const ocrTextAt = (i: number, b: OcrBlock): string =>
    ocrEdits[i] !== undefined ? ocrEdits[i] : b.text;

  // 是否有任意块提供置信度（macOS Vision 有；Windows WinRT 无 → 不显示阈值控件）
  const ocrHasConf = ocrResult ? ocrResult.blocks.some((b) => b.confidence > 0) : false;

  // 可见行：受「搜索 + 置信度阈值」过滤；阅读顺序重排只改遍历序，不破坏编辑映射
  const ocrVisibleLines = useCallback((): { b: OcrBlock; i: number }[] => {
    if (!ocrResult) return [];
    const q = ocrSearch.trim().toLowerCase();
    const pass = (conf: number) => ocrConf <= 0 || conf <= 0 || conf * 100 >= ocrConf;
    const order =
      ocrLayout === 'reading'
        ? ocrReadingOrder(ocrResult.blocks)
        : ocrResult.blocks.map((_, i) => i);
    return order
      .map((i) => ({ b: ocrResult.blocks[i], i }))
      .filter(({ b, i }) => {
        if (q && !ocrTextAt(i, b).toLowerCase().includes(q)) return false;
        if (!pass(b.confidence)) return false;
        return true;
      });
  }, [ocrResult, ocrSearch, ocrConf, ocrEdits, ocrLayout]);

  // 纳入集合：可见行之上叠加逐行勾选（未勾选任何 → 取全部可见行）
  const ocrIncludedLines = useCallback((): { b: OcrBlock; i: number }[] => {
    const vis = ocrVisibleLines();
    const anySel = vis.some(({ i }) => ocrSel[i]);
    if (!anySel) return vis;
    return vis.filter(({ i }) => ocrSel[i]);
  }, [ocrVisibleLines, ocrSel]);

  // N2：智能实体提取（URL/邮箱/电话）：仅开启提取开关时计算，纯前端辅助视图，不进入数据链；
  // 提取自当前可见/纳入集合文字（WYSIWYG，受搜索/置信度/勾选影响）。关闭时返回 null = 零渲染。
  const ocrEnt = ocrExtract
    ? ocrExtractEntities(ocrVisibleLines().map(({ b, i }) => ocrTextAt(i, b)).join('\n'))
    : null;

  // 组装导出内容：尊重搜索/置信度/阅读顺序/合并；json/tsv 带归一化坐标
  const buildOcrExportContent = (fmt: OcrExportFmt): string => {
    const vis = ocrIncludedLines();
    if (fmt === 'json') {
      const arr = vis.map(({ b, i }) => ({
        text: ocrTextAt(i, b),
        x: +b.x.toFixed(5),
        y: +b.y.toFixed(5),
        w: +b.w.toFixed(5),
        h: +b.h.toFixed(5),
        confidence: +b.confidence.toFixed(3),
      }));
      return JSON.stringify(arr, null, 2);
    }
    if (fmt === 'tsv') {
      const esc = (s: string) => s.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
      const head = 'text\tx\ty\tw\th\tconfidence';
      const rows = vis.map(({ b, i }) =>
        [esc(ocrTextAt(i, b)), b.x.toFixed(5), b.y.toFixed(5), b.w.toFixed(5), b.h.toFixed(5), b.confidence.toFixed(3)].join('\t')
      );
      return [head, ...rows].join('\n');
    }
    const bodyRaw = vis.map(({ b, i }) => ocrTextAt(i, b)).join(ocrMerge ? ' ' : '\n');
    return fmt === 'md' ? `# SnapCraft OCR\n\n${bodyRaw}\n` : bodyRaw;
  };

  // R2：持久化 OCR 文字（含逐行勘误）到历史；仅 screenshotId 存在时落库
  const persistOcrText = useCallback(async () => {
    if (!screenshotId || !ocrResult) return;
    const text = ocrResult.blocks
      .map((b, i) => (ocrEdits[i] !== undefined ? ocrEdits[i] : b.text))
      .join('\n');
    await invoke('set_screenshot_ocr', { id: screenshotId, ocrText: text }).catch((e) => {
      console.warn('[OCR] 持久化 ocr_text 失败:', e);
    });
  }, [screenshotId, ocrResult, ocrEdits]);

  // R3：把 OCR 可见行作为文字标注贴回画布（归一化坐标→像素，按块高设字号）
  const handlePasteToCanvas = useCallback(() => {
    if (!ocrResult || !imgWidth || !imgHeight) return;
    let n = 0;
    ocrIncludedLines().forEach(({ b, i }) => {
      const tx = (ocrEdits[i] !== undefined ? ocrEdits[i] : b.text).trim();
      if (!tx) return;
      const px = Math.max(0, Math.round(b.x * imgWidth));
      const py = Math.max(0, Math.round(b.y * imgHeight));
      const fs = Math.min(240, Math.max(10, Math.round(b.h * imgHeight)));
      addAnnotation({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        geometry: {
          type: 'text',
          points: [{ x: px, y: py }],
          text: tx,
          fontSize: fs,
          fontFamily: currentFontFamily,
          bold: currentBold,
          italic: currentItalic,
          align: 'left',
          bg: currentTextBg,
          bgColor: currentBgColor,
          bgOpacity: currentBgOpacity,
          stroke: currentTextStroke,
        },
        layerId: 'default',
        color: currentColor,
        lineWidth: currentStrokeWidth,
        opacity: 1,
        properties: {},
      });
      n++;
    });
    if (n > 0) flash(t('ocr.applied', { n }), 'success');
    else flash(t('ocr.appliedZero'), 'error');
  }, [ocrResult, ocrIncludedLines, imgWidth, imgHeight, ocrEdits, addAnnotation, currentColor, currentStrokeWidth, currentFontFamily, currentBold, currentItalic, currentTextBg, currentBgColor, currentBgOpacity, currentTextStroke, flash, t]);

  // AI 文案 → 截图标注回写：把 AI 生成的纯文本作为可编辑文字标注贴回当前截图，
  // 闭环「截图 → 编辑 → AI → 结果落到图上 → 再导出」。默认左上角、半透明底衬保证可读。
  const applyAiToScreenshot = useCallback((text: string) => {
    if (!imgWidth || !imgHeight) {
      flash(t('ai.applyZero'), 'error');
      return;
    }
    const clean = (text || '').trim();
    if (!clean) return;
    const fs = Math.max(14, Math.min(24, Math.round(imgWidth / 40)));
    addAnnotation({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      geometry: {
        type: 'text',
        points: [{ x: 16, y: 16 }],
        text: clean,
        fontSize: fs,
        fontFamily: currentFontFamily,
        bold: false,
        italic: false,
        align: 'left',
        bg: true,
        bgColor: '#1d1d1f',
        bgOpacity: 0.72,
        stroke: false,
      },
      layerId: 'default',
      color: currentColor,
      lineWidth: currentStrokeWidth,
      opacity: 1,
      properties: {},
    });
    flash(t('ai.applied'), 'success');
  }, [imgWidth, imgHeight, addAnnotation, currentColor, currentStrokeWidth, currentFontFamily, flash, t]);

  // 将画布（底图 + 最新标注）合成为一张图，作为 AI 看到的视觉内容；
  // 同时让 OCR 文字也跟随「编辑后截图」——打码/模糊区域的文字不再经 OCR 上下文泄漏给模型（候选④）。
  // 任一环节失败都回退到原图 + 原 OCR，保证 AI 始终有图/有文字可看，不影响其它功能。
  const refreshAiVision = useCallback(async () => {
    const fallback = imageData;
    const rawOcr = ocrResultRef.current?.text ?? '';
    try {
      const merged = canvasRef.current ? await canvasRef.current.getMergedImageDataUrl() : null;
      const visionUrl = merged || fallback;
      setAiVisionUrl(visionUrl);
      // 仅当真正合成了「编辑后图」（与原图不同）才重跑 OCR；否则沿用原 OCR，避免无谓耗时。
      if (merged && merged !== imageData) {
        try {
          const res = await invoke<OcrResult>('ocr_image', {
            imageData: merged,
            lang: ocrLang === 'auto' ? null : ocrLang,
          });
          // Phase 18：清洗 OCR 乱码
          const cleanedText = cleanOcrText(res?.text);
          setAiOcrText(cleanedText || rawOcr);
        } catch {
          setAiOcrText(rawOcr);
        }
      } else {
        setAiOcrText(rawOcr);
      }
    } catch {
      setAiVisionUrl(fallback);
      setAiOcrText(rawOcr);
    }
  }, [imageData, ocrLang]);

  // ── Phase 14：AI 智能编辑「工具宿主」──
  // 把模型给出的归一化区域(0~1)换算为原图像素，并经既有 store.addAnnotation 写入标注
  // （与用户手动标注同路、自动入撤销历史）；summarize_region 裁剪区域后走 ocr_image。
  // 供 AIPanel 的 AI Agent 工具循环直接操作当前截图（零新画布交互层、零 Rust）。
  //
  // Phase 19-B1：画笔/字号/字体等 UI 快照用 ref 隔离，避免 aiTools 引用因用户切颜色反复重建。
  const currentColorRef = useRef(currentColor);
  const currentStrokeWidthRef = useRef(currentStrokeWidth);
  const currentFontFamilyRef = useRef(currentFontFamily);
  useEffect(() => { currentColorRef.current = currentColor; }, [currentColor]);
  useEffect(() => { currentStrokeWidthRef.current = currentStrokeWidth; }, [currentStrokeWidth]);
  useEffect(() => { currentFontFamilyRef.current = currentFontFamily; }, [currentFontFamily]);
  const aiTools: AiToolHost = useMemo(
    () => ({
      getImageSize: () => (imgWidth && imgHeight ? { width: imgWidth, height: imgHeight } : null),
      drawRectangle: (r, opts) => {
        const sz = imgWidth && imgHeight ? { width: imgWidth, height: imgHeight } : null;
        if (!sz) return '(无图)';
        const { x, y, w, h } = normToPx(r, sz.width, sz.height);
        addAnnotation({
          id: genAnnoId(),
          geometry: { type: 'rectangle', points: [{ x, y }, { x: x + w, y: y + h }] },
          layerId: 'default',
          color: opts?.color || currentColorRef.current,
          lineWidth: currentStrokeWidthRef.current,
          opacity: 1,
          properties: {},
        });
        if (opts?.label) {
          addAnnotation({
            id: genAnnoId(),
            geometry: {
              type: 'text',
              points: [{ x, y: Math.max(0, y - 18) }],
              text: opts.label,
              fontSize: Math.max(12, Math.round(sz.height / 45)),
              fontFamily: currentFontFamilyRef.current,
              bold: false,
              italic: false,
              align: 'left',
              bg: true,
              bgColor: '#1d1d1f',
              bgOpacity: 0.78,
              stroke: false,
            },
            layerId: 'default',
            color: opts?.color || currentColorRef.current,
            lineWidth: 1,
            opacity: 1,
            properties: {},
          });
        }
        canvasRef.current?.flashRegion({ x, y, w, h }, opts?.color || currentColorRef.current, 'rect');
        return `(${x},${y})-(${x + w},${y + h})`;
      },
      redactArea: (r, mode, strength) => {
        const sz = imgWidth && imgHeight ? { width: imgWidth, height: imgHeight } : null;
        if (!sz) return '(无图)';
        const { x, y, w, h } = normToPx(r, sz.width, sz.height);
        const s = Math.max(1, Math.min(20, Number(strength) || 12));
        const geom: AnnotationObject['geometry'] =
          mode === 'black'
            ? {
                type: 'mosaic',
                points: [{ x, y }, { x: x + w, y: y + h }],
                maskMode: 'brush',
                solid: true,
                brushSize: Math.max(8, Math.round(w / 2)),
                blur: false,
                strength: s,
              }
            : { type: 'mosaic', points: [{ x, y }, { x: x + w, y: y + h }], blur: mode === 'blur', strength: s };
        addAnnotation({
          id: genAnnoId(),
          geometry: geom,
          layerId: 'default',
          // mode==='black'（涂黑）必须用固定黑色，不能用 currentColor（否则当前色若是红/其他色，
          // 涂黑会变成红块/异色块——与「一键打码满屏红」同源）。mosaic/blur 走像素底图，color 无关。
          color: mode === 'black' ? '#000000' : currentColorRef.current,
          lineWidth: currentStrokeWidthRef.current,
          opacity: 1,
          properties: {},
        });
        canvasRef.current?.flashRegion({ x, y, w, h }, undefined, 'redact');
        return `(${x},${y})-(${x + w},${y + h})`;
      },
      highlightRect: (r, color) => {
        const sz = imgWidth && imgHeight ? { width: imgWidth, height: imgHeight } : null;
        if (!sz) return '(无图)';
        const { x, y, w, h } = normToPx(r, sz.width, sz.height);
        addAnnotation({
          id: genAnnoId(),
          geometry: { type: 'highlight', points: [{ x, y }, { x: x + w, y: y + h }] },
          layerId: 'default',
          color: color || '#FFE600',
          lineWidth: currentStrokeWidthRef.current,
          opacity: 0.45,
          properties: {},
        });
        canvasRef.current?.flashRegion({ x, y, w, h }, color || '#FFE600', 'highlight');
        return `(${x},${y})-(${x + w},${y + h})`;
      },
      drawArrow: (from, to, opts) => {
        const sz = imgWidth && imgHeight ? { width: imgWidth, height: imgHeight } : null;
        if (!sz) return '(无图)';
        const fx = clamp01(from.x) * sz.width;
        const fy = clamp01(from.y) * sz.height;
        const tx = clamp01(to.x) * sz.width;
        const ty = clamp01(to.y) * sz.height;
        const color = opts?.color || '#0a84ff';
        addAnnotation({
          id: genAnnoId(),
          geometry: { type: 'arrow', points: [{ x: fx, y: fy }, { x: tx, y: ty }] },
          layerId: 'default',
          color,
          lineWidth: currentStrokeWidthRef.current,
          opacity: 1,
          properties: {},
        });
        if (opts?.label) {
          addAnnotation({
            id: genAnnoId(),
            geometry: {
              type: 'text',
              points: [{ x: tx, y: Math.max(0, ty - 6) }],
              text: opts.label,
              fontSize: Math.max(12, Math.round(sz.height / 45)),
              fontFamily: currentFontFamilyRef.current,
              bold: false,
              italic: false,
              align: 'left',
              bg: true,
              bgColor: '#1d1d1f',
              bgOpacity: 0.78,
              stroke: false,
            },
            layerId: 'default',
            color,
            lineWidth: 1,
            opacity: 1,
            properties: {},
          });
        }
        const bx = Math.min(fx, tx);
        const by = Math.min(fy, ty);
        canvasRef.current?.flashRegion(
          { x: bx, y: by, w: Math.abs(tx - fx), h: Math.abs(ty - fy) },
          color,
          'arrow',
        );
        return `(${fx.toFixed(0)},${fy.toFixed(0)})→(${tx.toFixed(0)},${ty.toFixed(0)})`;
      },
      drawCallout: (anchor, label, opts) => {
        const sz = imgWidth && imgHeight ? { width: imgWidth, height: imgHeight } : null;
        if (!sz) return '(无图)';
        const ax = clamp01(anchor.x) * sz.width;
        const ay = clamp01(anchor.y) * sz.height;
        const lx = clamp01(label.x) * sz.width;
        const ly = clamp01(label.y) * sz.height;
        const color = opts?.color || currentColorRef.current || '#0a84ff';
        addAnnotation({
          id: genAnnoId(),
          geometry: {
            type: 'callout',
            points: [{ x: ax, y: ay }, { x: lx, y: ly }],
            text: opts?.text || '',
            fontSize: 20,
            fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
            bold: false,
            italic: false,
            align: 'center',
            bg: true,
            bgColor: '#1d1d1f',
            bgOpacity: 0.92,
            stroke: true,
          },
          layerId: 'default',
          color,
          lineWidth: currentStrokeWidthRef.current,
          opacity: 1,
          properties: {},
        });
        // 脉冲覆盖气泡区（AI 操作可视化，与 Phase 20 一致）
        const bw = 170;
        const bh = 72;
        canvasRef.current?.flashRegion(
          { x: lx - bw / 2, y: ly - bh / 2, w: bw, h: bh },
          color,
          'rect',
        );
        return `锚点(${ax.toFixed(0)},${ay.toFixed(0)})→气泡(${lx.toFixed(0)},${ly.toFixed(0)}) 文字「${opts?.text || ''}」`;
      },
      summarizeRegion: async (r) => {
        const sz = imgWidth && imgHeight ? { width: imgWidth, height: imgHeight } : null;
        if (!sz) return '(无图)';
        const { x, y, w, h } = normToPx(r, sz.width, sz.height);
        const crop = await cropDataUrl(imageData, x, y, Math.max(1, w), Math.max(1, h));
        try {
          const res = await invoke<OcrResult>('ocr_image', {
            imageData: crop,
            lang: ocrLang === 'auto' ? null : ocrLang,
          });
          return cleanOcrText(res?.text).trim() || '(该区域未识别到文字)';
        } catch (e: any) {
          return `(识别失败：${e?.message ?? e})`;
        }
      },
    }),
  // Phase 19-B1：只依赖真正决定工具语义的字段；画笔/字号/字体从 ref 读，不参与依赖
  [imgWidth, imgHeight, addAnnotation, imageData, ocrLang],
  );

  // ── 路径 A（复用主窗机制）：把 AI 助手从「内嵌右侧抽屉」改为「独立浮动窗」。
  //    editor 窗口自己注册一份 setupMainBridge（该函数不绑定窗口），AI 工具/回写事件经
  //    bridge 定向投递到本 editor 窗口（aiHost=本窗 label），不会误触主窗画布。
  //    实时快照当前上下文，供 getCtx 读取「最新值」（避免一次性闭包捕获陈旧 state）。
  const ctxRef = useRef<AiContext | null>(null);
  ctxRef.current =
    imgWidth && imgHeight
      ? {
          dataUrl: imageData,
          visionUrl: aiVisionUrl,
          ocrText: aiOcrText,
          width: imgWidth,
          height: imgHeight,
        }
      : null;
  const execTool = useMemo(() => createToolExecutor(aiTools), [aiTools]);
  // 挂载跨窗口监听（仅一次）：AI 窗口请求上下文/工具调用/关闭/回写/刷新时响应
  useEffect(() => {
    let handles: { unlisten: (() => void)[] } | null = null;
    setupMainBridge({
      getCtx: () => ctxRef.current,
      execTool: (name, args) => execTool(name, args),
      onClosed: () => setAiOpen(false),
      onApply: (text) => applyAiToScreenshot(text),
      onRefresh: () => {
        void refreshAiVision();
      },
      // 编辑窗的 AI 标注已直接落在画布（addAnnotation），无需像主窗那样 burn-in 到 base；
      // commit 时同步一次「编辑后视觉」给 AI 窗口即可
      onCommit: () => {
        void refreshAiVision();
      },
    }).then((h) => {
      handles = h;
    });
    return () => {
      handles?.unlisten.forEach((u) => u());
    };
  }, [execTool]);

  // 打开 AI 助手：复用主窗「独立浮动窗」路径（980×720、可拖可缩），把当前编辑后的截图
  // 经桥接推给 AI 窗口，并把宿主设为「本 editor 窗口」→ 工具/回写定向回本画布（不会误触主窗）。
  const openEditorAi = useCallback(async () => {
    const host = getCurrentWindow().label;
    const merged =
      canvasRef.current && typeof canvasRef.current.getMergedImageDataUrl === 'function'
        ? await canvasRef.current.getMergedImageDataUrl()
        : imageData;
    const ctx: AiContext = {
      dataUrl: merged || imageData,
      visionUrl: aiVisionUrl || merged || imageData,
      ocrText: aiOcrText,
      width: imgWidth,
      height: imgHeight,
    };
    setAiOpen(true);
    await openAiWindow(ctx, host);
    await pushAiContext(ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageData, aiVisionUrl, aiOcrText, imgWidth, imgHeight]);

  // 切换截图时把 AI 视觉内容重置为原图
  useEffect(() => {
    setAiVisionUrl(imageData);
  }, [imageData]);
  // 原图 OCR 结果变化时（首次识别/重识别/切换截图），把发给 AI 的 OCR 文字同步为原图 OCR；
  // 用户编辑后由 refreshAiVision 覆盖为「编辑后 OCR」。
  useEffect(() => {
    setAiOcrText(ocrResult?.text ?? '');
  }, [ocrResult]);

  // 打开 AI 面板时，立即把「编辑后截图」同步给模型
  useEffect(() => {
    if (aiOpen) refreshAiVision();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiOpen]);

  // F1 回归修复：用户编辑截图 / 重识别后，refreshAiVision 已更新本地 aiVisionUrl/aiOcrText，
  // 但旧逻辑只改本地 state、不回推已打开的 AI 窗口 → AI 始终看到编辑前的旧图/旧 OCR。
  // 对齐主窗口 EnhancedScreenshotApp.tsx:2611-2617：视觉或 OCR 变化且 AI 窗已开时，
  // 把最新上下文（经 ctxRef 持有）重新 emitTo AI 窗口，保证模型看到的图与画布一致。
  useEffect(() => {
    const c = ctxRef.current;
    if (aiOpen && c?.dataUrl) {
      void pushAiContext(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiVisionUrl, aiOcrText, imageData]);

  // 保存标注到后端（含 R2：一并持久化 OCR 勘误文字）。返回是否成功，供关闭拦截使用。
  const saveAnnotations = useCallback(async () => {
    if (!screenshotId) return true;
    try {
      const json = JSON.stringify(annotations);
      await invoke('update_screenshot_annotations', {
        id: screenshotId,
        annotationsJson: json,
      });
      elog(`标注已保存: id=${screenshotId} 标注数=${annotations.length}`);
      await persistOcrText();
      return true;
    } catch (e) {
      elog(`标注保存失败: ${String(e)}`);
      return false;
    }
  }, [screenshotId, annotations, persistOcrText]);

  // ── 关闭拦截：用 ref 持有最新 saveAnnotations，onCloseRequested 只注册一次，
  //    避免依赖变更导致的重复监听竞态（多个 handler 互相 preventDefault 会卡死关闭）──
  const saveRef = useRef(saveAnnotations);
  useEffect(() => {
    saveRef.current = saveAnnotations;
  }, [saveAnnotations]);

  // 关闭窗口前保存标注（系统关闭按钮 / 自定义关闭均走此拦截）
  // 诊断日志：每步写入 logs/dev.log（elog → diag_log → clog），用于定位「系统关闭按钮无效」。
  //
  // ⚠️ 终修（已实证根因）：
  // 日志（13:05）证明：「不调 preventDefault → 系统自动关窗」在 Tauri 2.11 + 多监听器
  // （React StrictMode 双挂载导致两个 onCloseRequested）场景下【根本不生效】——第一次
  // 「不拦截→系统正常关闭」后窗口没关，OS 持续重发 CloseRequested 8 次。
  // 正确做法：始终先 preventDefault 挂起默认关闭，保存成功后用【显式 destroy()】确定性
  // 关窗（绕过 CloseRequested 重入）；幂等守卫（handling/destroyed）让两个监听器也只
  // destroy 一次，绝不卡死。
  const closeRegistered = useRef(false);
  useEffect(() => {
    if (closeRegistered.current) {
      // dev 下组件可能挂载两次，避免注册两个 handler 互相打架
      elog('[onCloseRequested] 已注册过，跳过重复注册');
      return;
    }
    closeRegistered.current = true;
    const w = getCurrentWindow();
    let handling = false;
    let destroyed = false;
    const unlistenP = w.onCloseRequested(async (e) => {
      // 始终先挂起系统默认关闭：不依赖「不 preventDefault → 自动关」（已证不生效），
      // 改由下方显式 destroy() 确定性关窗。
      e.preventDefault();
      elog('[onCloseRequested] 触发（系统关闭按钮）');
      if (handling || destroyed) {
        // 已在关闭流程中（重复触发/第二监听器）：交由首次流程的 destroy() 收尾，这里直接跳过
        elog('[onCloseRequested] 已在关闭流程中 → 跳过（由首次流程 destroy）');
        return;
      }
      handling = true;
      let ok = true;
      try {
        // 超时保护：若 invoke 卡死，3s 后强制放行，避免关闭按钮永久失效
        ok = await Promise.race([
          saveRef.current(),
          new Promise<boolean>((resolve) => {
            setTimeout(() => {
              elog('[onCloseRequested] saveAnnotations 超时(3s)，强制放行关闭');
              resolve(true);
            }, 3000);
          }),
        ]);
        elog(`[onCloseRequested] save 完成 ok=${ok}`);
      } catch (err) {
        ok = false;
        elog(`[onCloseRequested] save 异常: ${String(err)}`);
      }
      if (!ok) {
        // 保存失败：保留窗口并提示，避免静默丢标注（安全意图）；复位 flag 允许重试
        flash(t('editor.saveFail'), 'error');
        elog('[onCloseRequested] 保存失败 → 保留窗口并提示');
        handling = false;
        return;
      }
      // 保存成功：显式销毁窗口（确定性关闭，绕过 CloseRequested 重入循环）
      destroyed = true;
      elog('[onCloseRequested] 调用 destroy() 强制关闭窗口');
      try {
        await w.destroy();
      } catch (err) {
        elog(`[onCloseRequested] destroy 异常: ${String(err)}`);
        // destroy 失败则复位，让用户能再点一次重试，避免永久卡死
        destroyed = false;
        handling = false;
      }
    });
    elog('[onCloseRequested] 监听已注册');
    return () => {
      unlistenP.then((fn) => fn()).catch(() => {});
      closeRegistered.current = false;
    };
  }, []);

  // ⌘S 保存 / ⌘C 复制
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ESC 退出框选区域 OCR 模式
  useEffect(() => {
    if (!ocrSelectionMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOcrSelectionMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ocrSelectionMode]);

  // 剪贴板窗单窗口复用：已开窗被再次触发时，由 openClipboardOcrWindow 发 'clipboard://reread'
  // 事件，这里监听并重读剪贴板（拾取用户新复制的内容），无需关窗重开。
  useEffect(() => {
    if (mode !== 'clipboard') return;
    const w = getCurrentWindow();
    const p = w.listen('clipboard://reread', () => {
      loadFromClipboardRef.current();
    });
    return () => {
      p.then((fn) => fn()).catch(() => {});
    };
  }, [mode]);

  // OCR 执行（可被自动/手动复用）。N4：长图自动分块 OCR（仅整图识别触发；区域 OCR 不分块）。
  const doOcr = useCallback(async (img?: string) => {
    const target = img ?? imageData;
    if (ocrBusy || !target || sourceKind === 'text') return;
    if (!img) setOcrRegionPreview(null); // 整图识别：清掉上一次框选区域预览，避免混淆
    setOcrBusy(true);
    setOcrElapsed(null);
    const t0 = performance.now();
    try {
      // N4：长图/超大图 → 前端分块逐块识别后合并；普通图/区域 → 直接整图识别
      let res: OcrResult;
      if (!img && isLongImage(imgWidth, imgHeight)) {
        res = await runTiledOcr(target, imgWidth, imgHeight, ocrLang);
      } else {
        res = await invoke<OcrResult>('ocr_image', {
          imageData: target,
          lang: ocrLang === 'auto' ? null : ocrLang,
        });
      }
      setOcrResult(res);
      setOcrElapsed(Math.round(performance.now() - t0));
      // 新识别结果：清空上一次的逐行勘误与勾选，避免陈旧编辑污染
      setOcrEdits({});
      setOcrSel({});
      if (res.blocks.length === 0) {
        flash(t('toast.ocrNone'), 'error');
      } else if (screenshotId && !img) {
        // 落库：识别结果随历史持久化，关窗/历史重开无需二次识别
        const text = res.text || res.blocks.map((b) => b.text).join('\n');
        invoke('set_screenshot_ocr', { id: screenshotId, ocrText: text }).catch((e) => {
          console.warn('[OCR] 持久化 ocr_text 失败:', e);
        });
      }
      // N2：自动复制（默认关）：复制当前显示文字（尊重「合并为一行」格式），避免误覆盖用户剪贴板。
      if (ocrAutoCopy) {
        const txt = res.blocks.map((b) => b.text).join(ocrMerge ? ' ' : '\n');
        try {
          await navigator.clipboard.writeText(txt);
          flash(t('ocr.autoCopied'), 'success');
        } catch {
          flash(t('ocr.copyFailed'), 'error');
        }
      }
    } catch (e) {
      flash(t('toast.ocrFailed', { msg: String(e) }), 'error');
    } finally {
      setOcrBusy(false);
    }
  }, [ocrBusy, imageData, ocrLang, sourceKind, flash, t, ocrAutoCopy, ocrMerge, imgWidth, imgHeight, screenshotId]);

  // 框选区域 OCR 回调：AnnotationCanvas 在 ocrRegionMode 下拖框松手，
  // 裁出该区域（自然像素）的 PNG dataURL 回传。
  // N3：多区域模式不退出选区、结果累加进 ocrRegions；单区域模式保持原行为。
  const handleRegionOcr = useCallback(async (cropDataUrl: string) => {
    if (!cropDataUrl) return;
    setOcrRegionPreview(cropDataUrl); // 侧边栏预览回显裁剪区域
    if (ocrMultiRegion) {
      try {
        const res = await invoke<OcrResult>('ocr_image', {
          imageData: cropDataUrl,
          lang: ocrLang === 'auto' ? null : ocrLang,
        });
        const text = res.text || res.blocks.map((b) => b.text).join('\n');
        const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        setOcrRegions((arr) => [...arr, { id: rid, dataUrl: cropDataUrl, text, blocks: res.blocks }]);
        flash(t('ocr.regionsTitle', { n: ocrRegions.length + 1 }), 'success');
      } catch (e) {
        flash(t('ocr.regionFailed', { msg: String(e) }), 'error');
      }
      return; // 保持选区模式，可继续框下一个区域
    }
    setOcrSelectionMode(false); // 单区域：退出选区模式（回传在 mouseup 后，安全）
    await doOcr(cropDataUrl);
  }, [doOcr, ocrMultiRegion, ocrLang, ocrRegions.length, t, flash]);

  // N3：多区域结果的复制 / 合并操作
  const copyRegion = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      flash(t('ocr.copied'), 'success');
    } catch {
      flash(t('ocr.copyFailed'), 'error');
    }
  }, [flash, t]);

  const mergeCopyRegions = useCallback(async () => {
    const txt = ocrRegions.map((r) => r.text.trim()).filter(Boolean).join('\n\n');
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      flash(t('ocr.copied'), 'success');
    } catch {
      flash(t('ocr.copyFailed'), 'error');
    }
  }, [ocrRegions, flash, t]);

  const mergeExportRegions = useCallback(async () => {
    const txt = ocrRegions.map((r) => r.text.trim()).filter(Boolean).join('\n\n');
    if (!txt) return;
    const path = await saveDialog({ defaultPath: `ocr-regions-${Date.now()}.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (!path) return;
    try {
      await invoke('save_text_file', { content: txt, filePath: path });
      flash(t('ocr.exported'), 'success');
    } catch (e) {
      flash(t('ocr.exportFailed', { msg: String(e) }), 'error');
    }
  }, [ocrRegions, flash, t]);

  // 取字（工具栏按钮，可重跑）
  const handleOcr = useCallback(() => {
    if (autoOcrRef.current && mode === 'clipboard') {
      autoOcrRef.current = false; // 允许手动重跑
    }
    doOcr();
  }, [doOcr, mode]);

  // 保存图片
  const handleSave = useCallback(async () => {
    if (!canvasRef.current) return;
    try {
      const merged = await canvasRef.current.getMergedImageDataUrl();
      if (!merged) {
        flash(t('toast.copyInvalid'), 'error');
        return;
      }
      const path = await saveDialog({
        defaultPath: `snapcraft-${Date.now()}.png`,
        filters: [{ name: 'PNG Image', extensions: ['png'] }],
      });
      if (!path) return;
      await invoke('save_screenshot', { imageData: merged, filePath: path });
      flash(t('toast.saved', { path }), 'success');
      // 同时保存标注
      await saveAnnotations();
    } catch (e) {
      flash(t('toast.saveFailed', { msg: String(e) }), 'error');
    }
  }, [flash, t, saveAnnotations]);

  // 复制：文字模式复制文字本身，图片模式复制合成后的图片
  const handleCopy = useCallback(async () => {
    if (sourceKind === 'text') {
      // 关键修复：文字模式复制「文字」，而非「文字的图片」
      if (!ocrResult) return;
      const text = ocrResult.blocks.map((b) => b.text).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        flash(t('ocr.copied'), 'success');
      } catch {
        flash(t('ocr.copyFailed'), 'error');
      }
      return;
    }
    if (!canvasRef.current) return;
    try {
      const merged = await canvasRef.current.getMergedImageDataUrl();
      if (!merged) {
        flash(t('toast.copyInvalid'), 'error');
        return;
      }
      await invoke('copy_to_clipboard', { imageData: merged });
      flash(t('toast.copied'), 'success');
    } catch (e) {
      flash(t('toast.copyFailed', { msg: String(e) }), 'error');
    }
  }, [sourceKind, ocrResult, flash, t]);

  // 复制识别文字
  const handleCopyOcrText = useCallback(async () => {
    if (!ocrResult) return;
    const text = ocrResult.blocks.map((b) => b.text).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      flash(t('ocr.copied'), 'success');
    } catch {
      flash(t('ocr.copyFailed'), 'error');
    }
  }, [ocrResult, flash, t]);

  // 导出识别文字（按所选格式 txt/md/json/tsv）
  const handleExportOcr = useCallback(async () => {
    const vis = ocrIncludedLines();
    if (vis.length === 0) {
      flash(t('ocr.exportEmpty'), 'error');
      return;
    }
    const content = buildOcrExportContent(ocrFormat);
    const ext = ocrFormat === 'json' ? 'json' : ocrFormat === 'tsv' ? 'tsv' : ocrFormat === 'md' ? 'md' : 'txt';
    const name = ocrFormat === 'json' ? 'JSON' : ocrFormat === 'tsv' ? 'TSV' : ocrFormat === 'md' ? 'Markdown' : 'Text';
    try {
      const path = await saveDialog({
        defaultPath: `ocr-${Date.now()}.${ext}`,
        filters: [{ name, extensions: [ext] }],
      });
      if (!path) return;
      await invoke('save_text_file', { content, filePath: path });
      flash(t('ocr.exported'), 'success');
    } catch (e) {
      flash(t('ocr.exportFailed', { msg: String(e) }), 'error');
    }
  }, [ocrIncludedLines, ocrFormat, flash, t]);

  // OCR 增强辅助函数已上移至 saveAnnotations 之前（避免前向引用）
  if (loading) {
    return (
      <div className="editor-window-loading">
        <div>{mode === 'clipboard' ? t('ocr.clipBusy') : t('editor.loading')}</div>
      </div>
    );
  }

  // 剪贴板模式 + 空（非致命，显示空状态而非报错页；提供「重新读取」避免死胡同）
  if (error && mode === 'clipboard' && !imageData) {
    return (
      <div className="editor-window-root">
        <div className="clipboard-empty-state">
          <div className="clipboard-empty-icon">📋</div>
          <div className="clipboard-empty-text">{error}</div>
          <div className="clipboard-empty-actions">
            <button
              className="tbar-btn tbar-ghost reread"
              onClick={() => loadFromClipboard()}
              title={t('ocr.clipRereadTitle')}
            >
              🔄 {t('ocr.clipReread')}
            </button>
            <button
              className="tbar-btn tbar-ghost"
              onClick={async () => {
                await saveAnnotations().catch(() => {});
                try {
                  await getCurrentWindow().destroy();
                } catch {
                  /* ignore */
                }
              }}
            >
              {t('ocr.close')}
            </button>
          </div>
        </div>
        {toast && (
          <div className={`toast toast-${toastType}`}>
            <span className="toast-icon">
              {toastType === 'error' ? '!' : toastType === 'info' ? 'ℹ' : '✓'}
            </span>
            <span className="toast-msg">{toast}</span>
          </div>
        )}
      </div>
    );
  }

  if (error && mode === 'editor') {
    return (
      <div className="editor-window-error">
        <div>{error}</div>
      </div>
    );
  }

  return (
    <div className="editor-window-root">
      {/* 顶部工具栏 */}
      <div className="editor-toolbar">
        <div className="toolbar-left">
          <div className="editor-info">
            {mode === 'clipboard' && (
              <span className="editor-mode-tag">
                {sourceKind === 'text' ? '📋 ' + t('ocr.clipTextMode') : '📋 ' + t('ocr.clipboard')}
              </span>
            )}
            {sourceKind !== 'text' && (
              <span className="editor-info-dim">{imgWidth} × {imgHeight}</span>
            )}
            <span className="editor-info-sep">·</span>
            <span>{t('editor.annotations', { n: annotations.length })}</span>
          </div>
        </div>
        {/* 文字模式无需标注工具栏（取字≠编辑） */}
        {!(mode === 'clipboard' && sourceKind === 'text') && <AnnotationToolbar />}
        <div className="toolbar-right">
          {/* 剪贴板模式：常驻「重新读取」，随时拾取新复制的内容 */}
          {mode === 'clipboard' && (
            <button
              className="tbar-btn tbar-ghost reread"
              onClick={() => loadFromClipboard()}
              title={t('ocr.clipRereadTitle')}
            >
              🔄 {t('ocr.clipReread')}
            </button>
          )}
          {/* 图片模式才需要取字 / 框选（文字模式已是最终结果） */}
          {sourceKind !== 'text' && (
            <>
              <button
                className="tbar-btn tbar-ghost"
                onClick={handleOcr}
                disabled={ocrBusy}
                title={t('editor.ocrTitle')}
              >
                {ocrBusy ? t('editor.ocrBusy') : t('editor.ocr')}
              </button>
              <button
                className={`tbar-btn tbar-ghost ${ocrSelectionMode ? 'active' : ''}`}
                onClick={() => setOcrSelectionMode((v) => !v)}
                disabled={ocrBusy || !imageData}
                title={t('ocr.regionTitle')}
              >
                {ocrSelectionMode ? t('ocr.regionCancel') : t('ocr.region')}
              </button>
            </>
          )}
          <button
            className="tbar-btn tbar-ghost"
            onClick={handleCopy}
            title={sourceKind === 'text' ? t('copy') : t('editor.copyTitle', { mod: '⌘' })}
          >
            {t('editor.copy')}
          </button>
          {/* 文字模式无「图片」可保存，仅图片模式显示保存 */}
          {sourceKind !== 'text' && (
            <button
              className="tbar-btn tbar-primary save-btn"
              onClick={handleSave}
              title={t('editor.saveTitle', { mod: '⌘' })}
            >
              {t('editor.save')}
            </button>
          )}
          <button
            className={`tbar-btn tbar-ghost${aiOpen ? ' active' : ''}`}
            onClick={() => void openEditorAi()}
            title={t('ai.title')}
          >
            ✨ AI
          </button>
        </div>
      </div>

      {/* 主体：左画布（图片模式）/ 文本视图（剪贴板文字模式） + 右取字侧边栏 */}
      <div className="editor-body">
        {mode === 'clipboard' && sourceKind === 'text' ? (
          <div className="clipboard-text-view">
            <pre className="clipboard-text-pre">{ocrResult?.text ?? ''}</pre>
          </div>
        ) : (
        <div className={`editor-canvas-area ${ocrSelectionMode ? 'region-selecting' : ''}`}>
          <div className="editor-canvas">
            <AnnotationCanvas
              ref={canvasRef}
              imageData={imageData}
              annotations={annotations}
              onAnnotationAdd={addAnnotation}
              activeTool={activeTool}
              ocrRegionMode={ocrSelectionMode}
              onRegionOcr={handleRegionOcr}
            />
          </div>
          {ocrSelectionMode && (
            <div className="editor-region-hint">{t('ocr.regionHint')}</div>
          )}
        </div>
        )}

        {/* 取字侧边栏（常驻、非遮挡） */}
        <div className="ocr-sidebar" style={{ ['--ocr-fs' as any]: `${ocrFontSize}px` }}>
          <div className="ocr-sidebar-head">
            <span className="ocr-sidebar-title">{t('ocr.title')}</span>
            {ocrResult && sourceKind !== 'text' && (
              <span className="ocr-sidebar-count">{ocrVisibleLines().length}</span>
            )}
            <select
              className="ocr-lang"
              value={ocrLang}
              onChange={(e) => setOcrLang(e.target.value)}
              title={t('ocr.langTitle')}
            >
              <option value="auto">{t('ocr.langAuto')}</option>
              <option value="zh-Hans">{t('ocr.langZh')}</option>
              <option value="en-US">{t('ocr.langEn')}</option>
              <option value="ja-JP">{t('ocr.langJa')}</option>
            </select>
          </div>

          {ocrElapsed !== null && (
            <div className="ocr-stats">
              <span>{t('ocr.elapsed', { ms: ocrElapsed })}</span>
              <span className="ocr-stats-sep">·</span>
              <span>{t('ocr.statLines', { n: ocrResult?.blocks.length ?? 0 })}</span>
              <span className="ocr-stats-sep">·</span>
              <span>{t('ocr.statChars', { n: ocrResult?.text.length ?? 0 })}</span>
            </div>
          )}

          {ocrResult ? (
            <>
              {/* 图片模式增强工具：搜索 / 置信度 / 阅读顺序 / 合并为一行 */}
              {sourceKind !== 'text' && (
                <div className="ocr-sidebar-tools">
                  <div className="ocr-search">
                    <input
                      className="ocr-search-input"
                      type="text"
                      value={ocrSearch}
                      placeholder={t('ocr.search')}
                      onChange={(e) => setOcrSearch(e.target.value)}
                    />
                  </div>
                  {ocrHasConf && (
                    <div className="ocr-conf">
                      <label>{t('ocr.confLabel')} {ocrConf}%</label>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={ocrConf}
                        onChange={(e) => setOcrConf(Number(e.target.value))}
                      />
                    </div>
                  )}
                  <div className="ocr-toggles">
                    <button
                      className={`ocr-toggle ${ocrLayout === 'reading' ? 'active' : ''}`}
                      onClick={() => setOcrLayout((v) => (v === 'reading' ? 'none' : 'reading'))}
                      title={t('ocr.layoutReadingTitle')}
                    >
                      {t('ocr.layoutReading')}
                    </button>
                    <button
                      className={`ocr-toggle ${ocrMerge ? 'active' : ''}`}
                      onClick={() => setOcrMerge((v) => !v)}
                      title={t('ocr.copyMergeTitle')}
                    >
                      {t('ocr.copyMerge')}
                    </button>
                    <button
                      className={`ocr-toggle ${ocrExtract ? 'active' : ''}`}
                      onClick={() => setOcrExtract((v) => !v)}
                      title={t('ocr.extractTitle')}
                    >
                      {t('ocr.extract')}
                    </button>
                    <button
                      className={`ocr-toggle ${ocrAutoCopy ? 'active' : ''}`}
                      onClick={() => setOcrAutoCopy((v) => !v)}
                      title={t('ocr.autoCopyTitle')}
                    >
                      {t('ocr.autoCopy')}
                    </button>
                    <button
                      className={`ocr-toggle ${ocrMultiRegion ? 'active' : ''}`}
                      onClick={() => {
                        setOcrMultiRegion((v) => !v);
                        if (ocrMultiRegion) setOcrRegions([]); // 关闭时清空残留区域
                      }}
                      title={t('ocr.multiRegionTitle')}
                    >
                      {t('ocr.multiRegion')}
                    </button>
                  </div>
                </div>
              )}

              {/* 缩略图预览 + 块框（图片模式） */}
              {sourceKind !== 'text' && (
                <div className="ocr-sidebar-preview">
                  {ocrRegionPreview || imageData ? (
                    <img className="ocr-preview-img" src={ocrRegionPreview ?? imageData} alt="" draggable={false} />
                  ) : (
                    <div className="ocr-preview-empty">📋</div>
                  )}
                </div>
              )}

              {/* 文字列表：图片模式带搜索高亮 / 内联编辑 / 逐行勾选；文字模式纯展示 */}
              <div className="ocr-sidebar-text" tabIndex={0} spellCheck={false}>
                {sourceKind === 'text' ? (
                  <div className="ocr-sidebar-line">{ocrResult.text}</div>
                ) : (
                  ocrVisibleLines().map(({ b, i }) => (
                    <div key={i} className="ocr-sidebar-line" data-ocr-idx={i}>
                      <input
                        type="checkbox"
                        className="ocr-line-check"
                        checked={!!ocrSel[i]}
                        onChange={(e) => setOcrSel((s) => ({ ...s, [i]: e.target.checked }))}
                      />
                      {ocrEditing === i ? (
                        <textarea
                          className="ocr-line-edit"
                          autoFocus
                          defaultValue={ocrTextAt(i, b)}
                          onBlur={(e) => {
                            const v = e.target.value;
                            setOcrEdits((ed) => ({ ...ed, [i]: v }));
                            setOcrEditing(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur();
                            if (e.key === 'Escape') setOcrEditing(null);
                          }}
                        />
                      ) : (
                        <span
                          className="ocr-line-text"
                          onClick={() => setOcrEditing(i)}
                          title={t('ocr.lineEditTitle')}
                        >
                          {ocrHighlightParts(ocrTextAt(i, b), ocrSearch).map((p, k) =>
                            p.hit ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>
                          )}
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>

              {sourceKind !== 'text' && ocrResult && ocrVisibleLines().length === 0 && (
                <div className="ocr-no-match">{t('ocr.noMatch')}</div>
              )}

              {/* N2：智能实体提取：从识别结果一键提取 URL/邮箱/电话，逐条复制/打开。
                  仅开启「提取」时显示（ocrEnt 非 null）；纯前端辅助视图，不进入复制/导出/贴回数据链。 */}
              {ocrEnt && (() => {
                const groups: { kind: 'urls' | 'emails' | 'phones'; items: string[]; label: string }[] = [
                  { kind: 'urls', items: ocrEnt.urls, label: t('ocr.entUrls') },
                  { kind: 'emails', items: ocrEnt.emails, label: t('ocr.entEmails') },
                  { kind: 'phones', items: ocrEnt.phones, label: t('ocr.entPhones') },
                ];
                const entTotal = ocrEnt.urls.length + ocrEnt.emails.length + ocrEnt.phones.length;
                const copyEntItems = async (items: string[]) => {
                  if (!items.length) return;
                  try {
                    await navigator.clipboard.writeText(items.join('\n'));
                    flash(t('ocr.copied'), 'success');
                  } catch {
                    flash(t('ocr.copyFailed'), 'error');
                  }
                };
                // 点击实体项用系统默认程序打开：URL→浏览器、邮箱→邮件客户端、电话→拨号。
                // 委托后端 open_external 命令（薄封装 tauri-plugin-opener，零新依赖）。
                const openExternalEntity = async (kind: 'urls' | 'emails' | 'phones', item: string) => {
                  let target = item;
                  if (kind === 'emails') target = `mailto:${item}`;
                  else if (kind === 'phones') target = `tel:${item.replace(/\D/g, '')}`;
                  else if (/^www\./i.test(item)) target = `https://${item}`;
                  try {
                    await invoke('open_external', { target });
                  } catch (e: any) {
                    flash(t('ocr.openEntityFailed', { msg: String(e) }), 'error');
                  }
                };
                return (
                  <div className="ocr-entity">
                    <div className="ocr-entity-head">
                      <span>{t('ocr.extract')}</span>
                      {entTotal > 0 && <span className="ocr-entity-count">{entTotal}</span>}
                      {entTotal > 0 && (
                        <button
                          type="button"
                          className="ocr-entity-copyall"
                          style={{ marginLeft: 'auto' }}
                          onClick={() => copyEntItems([...ocrEnt.urls, ...ocrEnt.emails, ...ocrEnt.phones])}
                          title={t('ocr.entCopyAllAll')}
                        >
                          {t('ocr.entCopyAll')}
                        </button>
                      )}
                    </div>
                    {entTotal === 0 ? (
                      <div className="ocr-entity-empty">{t('ocr.noEntity')}</div>
                    ) : (
                      groups.map((g) =>
                        g.items.length === 0 ? null : (
                          <div className="ocr-entity-group" key={g.kind}>
                            <div className="ocr-entity-grouph">
                              <span className="ocr-entity-label">{g.label}</span>
                              <button
                                type="button"
                                className="ocr-entity-copyall"
                                onClick={() => copyEntItems(g.items)}
                              >
                                {t('ocr.entCopyAll')}
                              </button>
                            </div>
                            <div className="ocr-entity-chips">
                              {g.items.map((item, k) => (
                                <span className="ocr-entity-chip" key={k}>
                                  <button
                                    type="button"
                                    className="ocr-entity-text ocr-entity-link"
                                    title={item}
                                    aria-label={t('ocr.openEntity')}
                                    onClick={() => openExternalEntity(g.kind, item)}
                                  >
                                    {item}
                                  </button>
                                  <button
                                    type="button"
                                    className="ocr-entity-copy"
                                    title={t('ocr.copy')}
                                    onClick={async () => {
                                      try {
                                        await navigator.clipboard.writeText(item);
                                        flash(t('ocr.copied'), 'success');
                                      } catch {
                                        flash(t('ocr.copyFailed'), 'error');
                                      }
                                    }}
                                  >
                                    {t('ocr.copy')}
                                  </button>
                                </span>
                              ))}
                            </div>
                          </div>
                        )
                      )
                    )}
                  </div>
                );
              })()}

              {/* N2 下半：OCR 结果字号缩放（全模式可用） */}
              <div className="ocr-fs ocr-fs-row">
                <button
                  className="ocr-fs-btn"
                  onClick={() => setOcrFontSize((s) => Math.max(11, s - 1))}
                  disabled={ocrFontSize <= 11}
                  title={t('ocr.fsMinus')}
                >
                  A−
                </button>
                <button
                  className="ocr-fs-btn"
                  onClick={() => setOcrFontSize((s) => Math.min(22, s + 1))}
                  disabled={ocrFontSize >= 22}
                  title={t('ocr.fsPlus')}
                >
                  A+
                </button>
              </div>

              {/* 操作 */}
              <div className="ocr-sidebar-actions">
                <button className="tbar-btn tbar-ghost" onClick={handleCopyOcrText} title={t('ocr.copy')}>
                  {t('ocr.copy')}
                </button>
                <select
                  className="ocr-fmt"
                  value={ocrFormat}
                  onChange={(e) => setOcrFormat(e.target.value as OcrExportFmt)}
                  title={t('ocr.exportFmtTitle')}
                >
                  <option value="txt">TXT</option>
                  <option value="md">MD</option>
                  <option value="json">JSON</option>
                  <option value="tsv">TSV</option>
                </select>
                <button className="tbar-btn tbar-ghost" onClick={handleExportOcr} title={t('ocr.export')}>
                  {t('ocr.export')}
                </button>
                {sourceKind !== 'text' && (
                  <button className="tbar-btn tbar-ghost" onClick={handlePasteToCanvas} title={t('ocr.applyTitle')}>
                    {t('ocr.apply')}
                  </button>
                )}
              </div>

              {/* N3：多区域连续框选结果 */}
              {ocrMultiRegion && ocrRegions.length > 0 && (
                <div className="ocr-regions">
                  <div className="ocr-regions-head">
                    <span className="ocr-regions-title">{t('ocr.regionsTitle', { n: ocrRegions.length })}</span>
                    <button className="ocr-region-clear" onClick={() => setOcrRegions([])} title={t('ocr.clearRegions')}>
                      {t('ocr.clearRegions')}
                    </button>
                  </div>
                  <div className="ocr-region-list">
                    {ocrRegions.map((r, idx) => (
                      <div className="ocr-region-card" key={r.id}>
                        <div className="ocr-region-card-h">
                          <span className="ocr-region-idx">{idx + 1}</span>
                          <button className="tbar-btn tbar-ghost ocr-region-btn" onClick={() => copyRegion(r.text)} title={t('ocr.regionCopy')}>
                            {t('ocr.regionCopy')}
                          </button>
                          <button className="tbar-btn tbar-ghost ocr-region-btn" onClick={() => setOcrRegions((arr) => arr.filter((x) => x.id !== r.id))} title={t('ocr.regionDelete')}>
                            {t('ocr.regionDelete')}
                          </button>
                        </div>
                        <img className="ocr-region-thumb" src={r.dataUrl} alt="" draggable={false} />
                        <pre className="ocr-region-text">{r.text}</pre>
                      </div>
                    ))}
                  </div>
                  <div className="ocr-regions-actions">
                    <button className="tbar-btn tbar-ghost" onClick={mergeCopyRegions} title={t('ocr.mergeCopy')}>
                      {t('ocr.mergeCopy')}
                    </button>
                    <button className="tbar-btn tbar-ghost" onClick={mergeExportRegions} title={t('ocr.mergeExport')}>
                      {t('ocr.mergeExport')}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="ocr-sidebar-empty">
              <div className="ocr-sidebar-empty-icon">🔍</div>
              <div className="ocr-sidebar-empty-text">{t('editor.ocrEmpty')}</div>
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`toast toast-${toastType}`}>
          <span className="toast-icon">
            {toastType === 'error' ? '!' : toastType === 'info' ? 'ℹ' : '✓'}
          </span>
          <span className="toast-msg">{toast}</span>
        </div>
      )}
    </div>
  );
};

export default EditorWindow;

// ── 助手：从主窗口调用，开独立编辑窗 ──────────────────────────────────────────

/** 开独立编辑窗（按 id 去重，已开则聚焦，可同时开多个不同 id 的窗口）
 *  autoOcr: 打开后自动跑一次 OCR（结果条/历史网格的「取字」按钮用，保持一键取字体验）。 */
/**
 * 计算「贴合当前屏幕工作区」的居中窗口尺寸与位置（逻辑像素）。
 *
 * 背景坑：Tauri 的 `center: true` 按「整块屏幕」居中，不避开 macOS 菜单栏 / Dock 占用的区域；
 * 笔记本屏幕上窗口高度一旦接近屏高，就会被菜单栏/Dock 裁掉上下两端，只露出中间一段（"只有一半显示"）。
 * 这里改用 currentMonitor().workArea（已排除菜单栏/Dock）做钳制+居中，且显式给 x/y，避免与 center 冲突。
 *
 * @param reqW/reqH 期望尺寸（逻辑像素，调用方已含侧边栏/工具栏预留）
 * @param cascade   多窗轻微错位量（px），保证不叠在同一位置；会被钳制在工作区内
 */
async function fitWindowOnCurrentMonitor(
  reqW: number,
  reqH: number,
  cascade = 0,
): Promise<{ w: number; h: number; x: number; y: number }> {
  const MIN_W = 600;
  const MIN_H = 400;
  const MARGIN = 24; // 距工作区边缘的安全留白
  // 兜底工作区（拿不到显示器信息时也不致开到屏外）
  let wa = { x: 0, y: 0, w: 1280, h: 800 };
  try {
    const mon = await currentMonitor();
    if (mon) {
      const sf = mon.scaleFactor || 1;
      wa = {
        x: mon.workArea.position.x / sf,
        y: mon.workArea.position.y / sf,
        w: mon.workArea.size.width / sf,
        h: mon.workArea.size.height / sf,
      };
    }
  } catch {
    /* ignore，用兜底 */
  }
  const w = Math.max(MIN_W, Math.min(reqW, wa.w - MARGIN * 2));
  const h = Math.max(MIN_H, Math.min(reqH, wa.h - MARGIN * 2));
  // 居中 + cascade，再钳制进工作区，确保整窗始终完整可见
  const x = Math.min(
    Math.max(wa.x, wa.x + (wa.w - w) / 2 + cascade),
    wa.x + wa.w - w,
  );
  const y = Math.min(
    Math.max(wa.y, wa.y + (wa.h - h) / 2 + cascade),
    wa.y + wa.h - h,
  );
  return { w: Math.round(w), h: Math.round(h), x: Math.round(x), y: Math.round(y) };
}

export async function openEditorWindow(opts: {
  id: string;
  width?: number;
  height?: number;
  autoOcr?: boolean;
}): Promise<void> {
  const label = `editor-${opts.id}`;
  // 已开则聚焦
  try {
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.setFocus();
      return;
    }
  } catch {
    /* ignore */
  }

  // 按图比例定窗口期望尺寸（含侧边栏/工具栏预留），再用工作区钳制+居中
  const MAX_W = 1400;
  const MAX_H = 900;
  const reqW = Math.min(MAX_W, (opts.width ?? 800) + 360); // +360 给侧边栏
  const reqH = Math.min(MAX_H, (opts.height ?? 600) + 52); // +52 给工具栏

  // cascade 错位，避免多窗叠在同一位置
  const offset = Math.floor(Math.random() * 80) + 40;

  const { w, h, x, y } = await fitWindowOnCurrentMonitor(reqW, reqH, offset);

  try {
    const webview = new WebviewWindow(label, {
      url: `/#editor?id=${encodeURIComponent(opts.id)}${opts.autoOcr ? '&ocr=1' : ''}`,
      title: 'SnapCraft Editor',
      width: w,
      height: h,
      x,
      y,
      resizable: true,
      minimizable: true,
      maximizable: true,
      decorations: true,
      transparent: false,
      alwaysOnTop: false,
    });
    webview.once('tauri://created', () => {
      elog(`编辑窗已创建: label=${label} size=${w}x${h} pos=${x},${y}`);
    });
    webview.once('tauri://destroyed', () => {
      elog(`编辑窗已关闭: label=${label}`);
    });
  } catch (e) {
    elog(`创建编辑窗失败: ${String(e)}`);
  }
}

/** 开剪贴板取字独立窗。
 *  单窗口复用：已开窗则聚焦并 emit('clipboard://reread') 触发重新读取（拾取最新剪贴板内容），
 *  避免每次粘贴都堆一个新窗。符合「取字」瞬时性——同一份内容反复读取即可。 */
export async function openClipboardOcrWindow(): Promise<void> {
  const label = 'clipboard-ocr';
  // 已开则聚焦 + 触发重新读取
  try {
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      await existing.setFocus();
      await existing.emit('clipboard://reread', {});
      elog(`剪贴板取字窗已存在，聚焦并触发重新读取`);
      return;
    }
  } catch {
    /* ignore */
  }

  const offset = Math.floor(Math.random() * 80) + 40;

  const { w, h, x, y } = await fitWindowOnCurrentMonitor(1100, 700, offset);

  try {
    const webview = new WebviewWindow(label, {
      url: '/#clipboard-ocr',
      title: 'SnapCraft · 剪贴板取字',
      width: w,
      height: h,
      x,
      y,
      resizable: true,
      minimizable: true,
      maximizable: true,
      decorations: true,
      transparent: false,
      alwaysOnTop: false,
    });
    webview.once('tauri://created', () => {
      elog(`剪贴板取字窗已创建: label=${label}`);
    });
    webview.once('tauri://destroyed', () => {
      elog(`剪贴板取字窗已关闭: label=${label}`);
    });
  } catch (e) {
    elog(`创建剪贴板取字窗失败: ${String(e)}`);
  }
}

// ── 工具函数（EditorWindow 内部用） ──────────────────────────────────────────

/** 解码图片 dataUrl 尺寸（永不 reject，失败返回 {0,0}） */
function getImageDims(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    if (!dataUrl) {
      resolve({ w: 0, h: 0 });
      return;
    }
    const img = new Image();
    img.onload = () => resolve({ w: img.width, h: img.height });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = dataUrl;
  });
}
