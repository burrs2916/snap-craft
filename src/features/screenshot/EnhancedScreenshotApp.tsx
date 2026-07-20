import { useCallback, useEffect, useRef, useState, useMemo, type MouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
// Phase 18：OCR 文本清洗（去零宽字符/控制字符/重复字，避免污染 AI 视觉上下文）
import { cleanOcrText } from '../ai/ocrClean';
import { getCurrentWindow, LogicalSize, LogicalPosition } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { save } from '@tauri-apps/plugin-dialog';
import { AnnotationToolbar } from './components/AnnotationToolbar';
import AnnotationCanvas, { AnnotationCanvasHandle } from './components/AnnotationCanvas';
import { openEditorWindow, openClipboardOcrWindow } from './components/EditorWindow';
import { LanguageToggle } from '../../components/LanguageToggle';
import { useScreenshotStore } from './store/screenshotStore';
import type { OcrResult, OcrBlock, AnnotationObject } from './types';
import {
  openAiWindow,
  pushAiContext,
  setupMainBridge,
  EVT_COMMIT,
  type AiContext,
} from '../../ai-window/bridge';
import { createToolExecutor } from '../ai/aiTools';
import type { AiToolHost, NormRect } from '../ai/aiTools';
// Phase 28：批量 Agent 队列 —— 复用 chatOnce（一次性非流式，不触碰共享会话状态）+ markdownToDocx + AI 配置
import { chatOnce } from '../ai/aiClient';
import { markdownToDocx } from '../ai/markdownDocx';
import { useAiStore } from '../ai/aiStore';
import { useI18n, t } from '../../i18n';
import { stitchFrames, loadImage, type StitchFrame } from './utils/stitch';

/**
 * 平台兜底检测（不依赖 IPC）：当 `get_platform` 命令调用失败时，
 * 用 `navigator.userAgent` 判定平台，杜绝「失败回落到 macOS」导致
 * Windows / Linux 误走 macOS 专属分支（如快捷键提示 ⌘⇧、区域截屏走
 * screencapture -i 等）——这是跨平台对等（parity）的关键边界用例（R2）。
 * 返回值与 Rust `std::env::consts::OS` 一致：'macos' | 'windows' | 'linux'。
 */
function detectPlatformFromUA(): string {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  return 'linux';
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

// 诊断日志：写入 logs/dev.log（tag=diag，前缀 [flow]）。best-effort，绝不阻断主流程。
// 用于把「截屏触发 → invoke → 拿到图 → 结果条 → 点击编辑」的全链路落到日志。
const flog = (msg: string) => {
  invoke('diag_log', { msg: `[flow] ${msg}` }).catch(() => {});
};

// 截图前安全隐藏主窗口。
// ⚠️ macOS 原生全屏（绿灯/最大化）会把窗口放进独立的 Space（专属全屏空间）。
// 若此时直接 hide()，那块屏正在跑 Space 退出/过渡动画（短暂黑场），紧接着 screencapture
// 就会截到「过渡中的黑屏」——尤其是把工具窗口最大化放在第二屏、再截该屏时必现。
// 修复：hide 前若处于全屏/最大化，先退出该状态并等待 Space 过渡动画彻底结束，再 hide、再截图。
async function safeHideForCapture(win: ReturnType<typeof getCurrentWindow>): Promise<void> {
  let wasFullscreen = false;
  let wasMaximized = false;
  try {
    wasFullscreen = await win.isFullscreen();
  } catch { /* 某些平台无此 API，忽略 */ }
  try {
    wasMaximized = await win.isMaximized();
  } catch { /* ignore */ }

  if (wasFullscreen) {
    // ⚠️ macOS 26 崩溃修复：原方案 setFullscreen(false) + 固定延迟 + hide() 会 crash——
    // 全屏 Space 拆除期间 WebPageProxy 被释放，hide() 触发的 insets 派发解引用 null。
    // 修复：全屏态改用 setMinimized(true) 代替 hide()。
    //   minimize 是原子操作，macOS 内部处理全屏退出，不走 orderOut → 不触发 insets crash。
    //   minimize 后窗口完全不在屏幕上，截图不会截到自身。
    flog(`safeHide: 窗口处于原生全屏 → minimize (避免 hide() 触发 insets crash)`);
    try { await win.minimize(); } catch { /* ignore */ }
    // 等 minimize + Space 拆除完成
    await new Promise((r) => setTimeout(r, 600));
  } else if (wasMaximized) {
    flog(`safeHide: 窗口处于最大化 → 先取消最大化并等待重绘再隐藏`);
    try { await win.unmaximize(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 350));
    await win.hide();
  } else {
    await win.hide();
  }
  // 隐藏后再给屏幕合成器一点时间稳定
  if (wasFullscreen) {
    await new Promise((r) => setTimeout(r, 150));
  }
}

/* ── 顶栏线性图标（与标注工具栏同款描边风格，stroke=currentColor 跟随主题）── */
const TBIcon = ({ d }: { d: string }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: d }}
  />
);
const TB_PATHS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  pin: '<path d="M9 4h6l-1 5 3 3v2h-5v5l-1 2-1-2v-5H4v-2l3-3-1-5z"/>',
  save: '<path d="M12 3v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 20h14"/>',
  ocr: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h6M7 13h10M7 17h4"/>',
} as const;

type Theme = 'light' | 'dark' | 'system';

interface HistoryEntry {
  id: string;
  dataUrl: string;
  createdAt: string;
  width: number;
  height: number;
  // 来源：'capture'=本机截图，'clipboard'=从系统剪贴板读取的图片，'ai_edit'=AI 智能编辑烧录产物。
  // 用于历史网格角标区分，v4 起新增 ai_edit（独立持久化的 AI 编辑合成图）。
  source?: 'capture' | 'clipboard' | 'ai_edit';
  // OCR 识别结果（已落库），用于历史网格按 OCR 文字搜索。
  ocr_text?: string;
}

// macOS 显示器信息（list_displays 返回，全局逻辑点坐标）
interface DisplayInfo {
  id: number;
  is_main: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

// 按真实物理位置排序显示器：先按全局 x（左→右），x 相近时按 y（上→下）。
// 返回带统一序号 label 的数组——序号即用户看到的「显示器 N」，与卡片布局位置一致。
const orderDisplays = (displays: DisplayInfo[]): (DisplayInfo & { label: number })[] =>
  [...displays]
    .sort((a, b) => (Math.abs(a.x - b.x) > 40 ? a.x - b.x : a.y - b.y))
    .map((d, i) => ({ ...d, label: i + 1 }));

// 多屏选择器：居中弹窗，按真实相对位置铺放各屏缩略卡片，点选后由 pickDisplay 截取。
// 不遮挡真实屏幕内容——只在应用窗口内以缩略示意图呈现，安全直观。
const DisplayPicker = ({
  displays,
  onPick,
  onCancel,
}: {
  displays: DisplayInfo[];
  onPick: (id: number | null) => void;
  onCancel: () => void;
}) => {
  // 统一按物理位置排序 + 编号（左→右）
  const ordered = orderDisplays(displays);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  ordered.forEach((d) => {
    minX = Math.min(minX, d.x);
    minY = Math.min(minY, d.y);
    maxX = Math.max(maxX, d.x + d.width);
    maxY = Math.max(maxY, d.y + d.height);
  });
  const uw = maxX - minX;
  const uh = maxY - minY;
  return (
    <div className="permission-gate" style={{ zIndex: 60 }}>
      <div className="permission-card" style={{ maxWidth: 720 }}>
        <div className="permission-icon">🖥️</div>
        <div className="permission-title">{t('display.title')}</div>
        <div className="permission-text">
          {t('display.text', { n: ordered.length })}
        </div>
        <div
          className="display-picker-grid"
          style={{ aspectRatio: `${uw} / ${uh}`, position: 'relative', width: '100%' }}
        >
          {ordered.map((d) => (
            <button
              key={d.id}
              className="display-pick-card"
              onClick={() => onPick(d.id)}
              style={{
                left: `${((d.x - minX) / uw) * 100}%`,
                top: `${((d.y - minY) / uh) * 100}%`,
                width: `${(d.width / uw) * 100}%`,
                height: `${(d.height / uh) * 100}%`,
              }}
            >
              {d.is_main && <div className="display-pick-badge">{t('display.main')}</div>}
              <div className="display-pick-num">{d.label}</div>
              <div className="display-pick-res">
                {d.width} × {d.height}
                {d.scale >= 1.5 ? ' · Retina' : ''}
              </div>
            </button>
          ))}
        </div>
        <div className="permission-actions">
          <button className="permission-btn ghost" onClick={onCancel}>
            {t('display.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
};

// 历史缩略图：滚入视口才把 dataUrl 设为 src，避免一次性解码全部大图
const LazyHistoryThumb = ({ dataUrl, alt }: { dataUrl: string; alt: string }) => {
  const ref = useRef<HTMLImageElement>(null);
  const [src, setSrc] = useState('');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          setSrc(dataUrl);
          io.disconnect();
        }
      });
    });
    io.observe(el);
    return () => io.disconnect();
  }, [dataUrl]);
  return (
    <img
      ref={ref}
      src={src || undefined}
      alt={alt}
      loading="lazy"
      style={src ? undefined : { backgroundColor: 'var(--surface-strong)' }}
    />
  );
};

// ===== OCR 面板：偏好与历史（localStorage 隔离存储，不碰截图历史体系）=====
const OCR_PREF_KEY = 'snapcraft.ocr.prefs';
const OCR_HIST_KEY = 'snapcraft.ocr.history';
// 5→50：扩容 10x，附缩略图后仍 < 5MB localStorage 限额（按 50*100KB 估算），零回归。
const OCR_HIST_MAX = 50;

interface OcrPrefs {
  lang: string;
  merge: boolean;
  autoCopy: boolean;
  // 'none' = 保留系统识别顺序（默认，零回归）；'reading' = 按版式坐标重排（多列/竖排）
  layout: OcrLayout;
  // 面板字号（px）：作用于结果文字，跨会话记住；默认 13 = 历史观感，零回归。
  fontSize: number;
  // 导出格式（txt/md/json/tsv）：跨会话记住上次选择，默认 'txt'。
  exportFmt: OcrExportFmt;
  // 智能实体提取（URL/邮箱/电话）：默认关（零回归），开启后从识别结果中一键提取可复制实体。
  extract: boolean;
  // 智能文本清洗（全半角归一 / 去 CJK 间空格 / 折叠空白）：默认关（零回归），
  // 开启后对「复制/导出文字」做安全规范化（不做字符猜测），提高中文截图取字后直贴文档的质量。
  clean: boolean;
}

// OCR 阅读顺序模式：'none' 保留 Vision/WinRT 原始读序；'reading' 按块坐标智能重排。
export type OcrLayout = 'none' | 'reading';
// OCR 导出格式：'txt' 纯文本 / 'md' Markdown / 'json' 带坐标 JSON / 'tsv' 带坐标 TSV。
export type OcrExportFmt = 'txt' | 'md' | 'json' | 'tsv';

// 智能阅读顺序：按块坐标把乱序的识别结果重排为正常阅读顺序。
// - 横排多列：先按 x 把块聚成列（列间水平间隙明显大于列内行距），列内从上到下、列间从左到右。
// - 竖排（多数块高>宽）：列内从上到下、列间从右到左。
// 返回的是「原始块下标」的排序数组，ocrVisibleLines 仍用原下标索引 ocrEdits，编辑映射不破坏。
// 纯几何启发式、无平台/网络依赖；仅在用户开启「按版式重排」时调用，默认关闭不影响原行为。
function ocrReadingOrder(blocks: OcrBlock[]): number[] {
  const idx = blocks.map((_, i) => i);
  if (blocks.length < 2) return idx;

  const vertCount = blocks.filter((b) => b.h > b.w * 1.2).length;
  const isVertical = vertCount > blocks.length / 2;

  if (isVertical) {
    // 竖排：同一（x 相近）列内按 y 从上到下；不同列按 x 从右到左。
    return [...idx].sort((a, b) => {
      const A = blocks[a];
      const B = blocks[b];
      const ax = A.x + A.w / 2;
      const bx = B.x + B.w / 2;
      const ay = A.y + A.h / 2;
      const by = B.y + B.h / 2;
      if (Math.abs(ax - bx) < (A.w + B.w) / 2) return ay - by; // 同列
      return bx - ax; // 不同列：右→左
    });
  }

  // 横排：按中心 x 排序后，依据相邻块水平间隙切分列。
  const byX = [...idx].sort(
    (a, b) => blocks[a].x + blocks[a].w / 2 - (blocks[b].x + blocks[b].w / 2)
  );
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
  // 列内按 y 从上到下
  columns.forEach((col) => col.sort((a, b) => blocks[a].y - blocks[b].y));
  // 列间按起始 x 从左到右
  columns.sort((a, b) => blocks[a[0]].x - blocks[b[0]].x);
  return columns.flat();
}

// 把文字按搜索词切成高亮片段：大小写不敏感；不使用正则，避免特殊字符注入。
// 渲染时 hit=true 的片段用 <mark> 包裹。空查询返回单段（整段非命中，零渲染变化）。
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
// 纯前端、无正则注入风险：每个类别用独立的安全正则 + 去重（Set）；不进入复制/导出/贴回数据链，
// 仅作为面板内的辅助视图（WYSIWYG：提取自当前可见/纳入集合文字，受搜索/置信度/勾选影响）。
// 返回已去重、按出现顺序保留的实体数组；未识别到则对应数组为空。
export interface OcrEntity {
  urls: string[];
  emails: string[];
  phones: string[];
}

// 批量取字结果单项（按截图拆分，可独立编辑/复制）
interface BatchItem {
  id: string;
  time: string;
  text: string;
}

// Phase 28：批量 Agent 队列结果单项（每张选中截图一次 AI 调用的产出）
interface AiBatchItem {
  id: string;
  time: string;
  text: string;
  error?: string;
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
// 智能文本清洗：对识别结果做「安全规范化」，提高中文截图取字后直贴文档的质量。
// 仅做可逆的格式整理，绝不做 1→l / O→0 之类的字符猜测（避免误导）。
// 步骤：① NFKC 全半角归一（全角字母/数字/括号/全角空格→半角）②去 CJK/Kana 之间的多余空格
// （OCR 常见逐字空格）③折叠连续空白为单空格 ④逐行去尾随空白 ⑤>=3 连续换行折叠为单空行。
// 纯前端、无平台/网络依赖；仅在用户开启「智能清洗」时调用，默认关闭不进入任何数据链。
function isCJKChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x3000 && c <= 0x30ff) || // CJK 符号/标点 + 平假名 + 片假名
    (c >= 0x3400 && c <= 0x9fff) || // CJK 扩展 A + 基本汉字
    (c >= 0xf900 && c <= 0xfaff) || // 兼容汉字
    (c >= 0xff66 && c <= 0xff9f)    // 半角片假名
  );
}
function removeSpacesBetweenCJK(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      const prev = out.length ? out[out.length - 1] : '';
      const next = s[i + 1] ?? '';
      // 仅当两个相邻字符都是 CJK/Kana 时才跳过中间的空格（英文单词内空格保留）
      if (prev && next && isCJKChar(prev) && isCJKChar(next)) continue;
    }
    out.push(ch);
  }
  return out.join('');
}
function ocrCleanText(text: string): string {
  if (!text) return text;
  let s = text.normalize('NFKC');            // 全半角归一
  s = removeSpacesBetweenCJK(s);             // 去 CJK 间逐字空格
  s = s.replace(/[ \t]+/g, ' ');             // 折叠连续空白
  s = s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n'); // 逐行去尾随空白
  s = s.replace(/\n{3,}/g, '\n\n');          // 折叠多余空行
  return s;
}

// 生成小尺寸缩略图 dataUrl（用于 OCR 历史项左侧缩略图，零依赖）。
// 失败返回空串（不抛错，不影响识别主流程）。
function makeThumbDataUrl(src: string, w: number, h: number): string {
  if (!src) return '';
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    const img = new Image();
    // 同步取：用完即弃；dataUrl 同源，无需 crossOrigin
    img.src = src;
    // 注意：调用方需在 onload 后再读取，但本函数被用于 push 时已识别完成；
    // 真实场景下用 getMergedImageDataUrl → 已渲染 canvas，img.complete 几乎必为 true
    // ——若为 false，drawImage 静默失败，返回空串兜底。
    try {
      ctx.drawImage(img, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.7);
    } catch {
      return '';
    }
  } catch {
    return '';
  }
}

interface OcrHistItem {
  text: string;
  lang: string;
  ts: number;
  chars: number;
  // 来源截图缩略图（dataUrl，~10KB 缩到 80x60）。
  // 为空 = 来自剪贴板文字模式 / 或历史压缩前的旧记录；不影响核心识别回放。
  thumb?: string;
  // 来源截图 id（与 Rust history.json 同源）；点击可回放到该截图。
  sourceId?: string;
}

function loadOcrPrefs(): OcrPrefs {
  const def: OcrPrefs = { lang: 'auto', merge: false, autoCopy: false, layout: 'none', fontSize: 14, exportFmt: 'txt', extract: false, clean: false };
  try {
    const raw = localStorage.getItem(OCR_PREF_KEY);
    if (raw) return { ...def, ...(JSON.parse(raw) as Partial<OcrPrefs>) };
  } catch {
    /* ignore */
  }
  return def;
}
function saveOcrPrefs(p: OcrPrefs) {
  try {
    localStorage.setItem(OCR_PREF_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
function loadOcrHist(): OcrHistItem[] {
  try {
    const raw = localStorage.getItem(OCR_HIST_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v as OcrHistItem[];
    }
  } catch {
    /* ignore */
  }
  return [];
}
function saveOcrHist(h: OcrHistItem[]) {
  try {
    localStorage.setItem(OCR_HIST_KEY, JSON.stringify(h));
  } catch {
    /* ignore */
  }
}
// 历史项语言短标签（与地区无关，避免依赖运行时 i18n）
function ocrLangTag(lang: string): string {
  if (lang === 'zh-Hans') return '中';
  if (lang === 'en-US') return 'EN';
  if (lang === 'ja-JP') return '日';
  return 'A';
}
function fmtOcrTime(ts: number): string {
  try {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return '';
  }
}

export const EnhancedScreenshotApp = () => {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('snapcraft-theme') as Theme) || 'system'
  );
  const [currentView, setCurrentView] = useState<'home' | 'edit'>('home');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historySearch, setHistorySearch] = useState('');
  // 历史搜索：匹配 OCR 文字（已落库）或时间；空查询返回全部。
  const filteredHistory = (() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return history;
    return history.filter((h) => {
      const ocr = (h.ocr_text || '').toLowerCase();
      const time = new Date(h.createdAt).toLocaleString().toLowerCase();
      return ocr.includes(q) || time.includes(q);
    });
  })();
  // R4：批量 OCR 多选状态
  const [selMode, setSelMode] = useState(false);
  const [selIds, setSelIds] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [showBatch, setShowBatch] = useState(false);
  // Phase 28：批量 Agent 队列
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBatchBusy, setAiBatchBusy] = useState(false);
  const [aiBatchItems, setAiBatchItems] = useState<AiBatchItem[]>([]);
  const [aiBatchDone, setAiBatchDone] = useState(0);
  const [aiBatchTotal, setAiBatchTotal] = useState(0);
  const [showAiBatch, setShowAiBatch] = useState(false);
  const [current, setCurrent] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastType, setToastType] = useState<'success' | 'error' | 'info'>('success');
  // v14-A P0-3：保存/导出成功后保留最近一次路径 5s，toast 渲染"在访达中显示"按钮
  // 与 flash 共享字符串窗口，零状态机改动：revealPath 与 toast 同时存在/清空
  const [revealPath, setRevealPath] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string>('');
  // macOS App Store 沙箱标记：沙箱内禁止 spawn 外部 screencapture，区域/窗口截图须走
  // 自建覆盖层（与 Windows/Linux 一致）而非系统原生 -i/-w。开发者 ID 构建为 false。
  const [isSandboxed, setIsSandboxed] = useState(false);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [showDisplayPicker, setShowDisplayPicker] = useState(false);
  // 选屏器用途：全屏截图('shot') 还是滚动长截图('scroll')——决定点选后走哪条流程
  const pickerPurposeRef = useRef<'shot' | 'scroll'>('shot');
  // 截图后轻量结果条：展示最近一张截图缩略图 + 快捷操作（复制/编辑/保存/钉图）。
  // 不再强制跳编辑器，用户想标注才点「编辑」。
  const [lastShot, setLastShot] = useState<{ id: string; dataUrl: string; width: number; height: number } | null>(null);
  // 延时截图：全屏截图前等待的秒数（0=立即）。用于等待菜单/悬浮态等瞬时 UI 就绪。
  const [captureDelay, setCaptureDelay] = useState(0);
  // 延时倒计时显示（秒），null 表示无倒计时进行中
  const [countdown, setCountdown] = useState<number | null>(null);
  const [permissionNeeded, setPermissionNeeded] = useState(false);
  // ===== OCR 取字 =====
  const ocrPrefs0 = loadOcrPrefs();
  // 识别中标志 + 结果文本面板（null=面板关闭）
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  // 用 ref 持有最新 OCR 结果，供 refreshAiVision 在不重建回调的情况下读取（避免 stale closure）。
  const ocrResultRef = useRef<OcrResult | null>(null);
  ocrResultRef.current = ocrResult;
  // AI 助手面板开关（默认关闭，非侵入；不影响任何现有功能）
  const [aiOpen, setAiOpen] = useState(false);
  // AI 实际看到的「编辑后截图」（底图 + 全部标注，含打码/模糊）。默认等于原图，
  // 打开面板或用户点「同步最新编辑」时，由 canvasRef.getMergedImageDataUrl() 重算。
  const [aiVisionUrl, setAiVisionUrl] = useState(current?.dataUrl ?? '');
  // 发给 AI 的 OCR 文字：默认等于原图 OCR；用户编辑/打码后点「同步最新编辑」会重跑 OCR 得到编辑后文字，
  // 避免打码/模糊区域的原文经 OCR 上下文泄漏给模型（候选④）。
  const [aiOcrText, setAiOcrText] = useState<string>('');
  // OCR 语言提示：'auto' = 系统自动选语言；偏好持久化（跨会话记住上次选择）。
  const [ocrLang, setOcrLang] = useState<string>(ocrPrefs0.lang);
  // OCR 选区模式：开启时画布进入框选，拖拽后裁图识别
  const [ocrRegionMode, setOcrRegionMode] = useState(false);
  // OCR 内联编辑：块下标 → 用户修正后的文字（未编辑则回退原始识别文字）。
  // 修正只存于前端内存，复制/贴回/导出均读取修正后内容。每次重新识别会清空。
  const [ocrEdits, setOcrEdits] = useState<Record<number, string>>({});
  // OCR 结果内搜索：按子串（忽略大小写）过滤逐行列表，便于在长文本中快速定位。
  const [ocrSearch, setOcrSearch] = useState('');
  // OCR 置信度阈值：仅显示置信度≥阈值的行（0=全部）。仅对提供置信度的平台生效；
  // 置信度=0（未知，如 Windows WinRT 不返回置信度）视为始终显示，不做过滤。
  const [ocrConf, setOcrConf] = useState(0);
  // OCR 复制/导出格式：合并为一行（去换行、用空格连接）。偏好持久化（跨会话记住）。
  const [ocrMerge, setOcrMerge] = useState<boolean>(ocrPrefs0.merge);
  // OCR 识别完成后自动复制结果到剪贴板（开关，默认关，避免误覆盖用户剪贴板）。
  const [ocrAutoCopy, setOcrAutoCopy] = useState<boolean>(ocrPrefs0.autoCopy);
  // OCR 本次识别耗时（毫秒），用于面板显示识别速度（透明度/可预期性）。
  const [ocrElapsed, setOcrElapsed] = useState<number | null>(null);
  // OCR 历史：最近识别结果（纯文本+语言+时间），localStorage 隔离存储，不碰截图历史体系。
  const [ocrHistory, setOcrHistory] = useState<OcrHistItem[]>(loadOcrHist());
  // OCR 历史面板展开态
  const [ocrHistoryOpen, setOcrHistoryOpen] = useState(false);
  // OCR 阅读顺序：'none' 保留系统原始读序；'reading' 按版式坐标智能重排（多列/竖排）。
  // 偏好持久化（跨会话记住），默认 'none' 不改变任何既有行为（零回归）。
  const [ocrLayout, setOcrLayout] = useState<OcrLayout>(ocrPrefs0.layout || 'none');
  // OCR 导出格式：默认纯文本（与历史版本一致）；可选 Markdown / 带坐标 JSON / TSV。
  // 跨会话记住上次选择（写入 OcrPrefs）。
  const [ocrExportFmt, setOcrExportFmt] = useState<OcrExportFmt>(ocrPrefs0.exportFmt);
  // OCR 智能实体提取（URL/邮箱/电话）：从识别结果中一键提取，逐条复制；默认关，零回归。
  const [ocrExtract, setOcrExtract] = useState<boolean>(ocrPrefs0.extract);
  const [ocrClean, setOcrClean] = useState<boolean>(ocrPrefs0.clean);
  // OCR 面板字号（px）：作用于结果文字，跨会话记住；默认 13 = 历史观感，零回归。
  const [ocrFontSize, setOcrFontSize] = useState<number>(ocrPrefs0.fontSize);
  // 从剪贴板取字的「飞行中」标志：读图阶段按钮禁用 + 文案切换，避免大图时连点重入。
  // 与 ocrBusy（OCR 识别阶段）分离，因为读图与识别是两个独立阶段，互不应阻塞对方视觉反馈。
  const [ocrClipBusy, setOcrClipBusy] = useState(false);
  const ocrClipBusyRef = useRef(false);
  // OCR 逐行勾选：原始块下标 → 是否纳入「复制/导出/贴回」的选择集合。
  // 空对象=未勾选任何行 → 复制/导出/贴回取全部可见行（历史行为）；
  // 任一可见行被勾选 → 仅取勾选的可见行（精准提取）。新识别时清空。
  const [ocrSel, setOcrSel] = useState<Record<number, boolean>>({});
  // OCR 最近一次识别所用的图片（dataUrl），供面板内「重新识别」复用，无需关闭面板再点取字。
  const [ocrLastImage, setOcrLastImage] = useState<string | null>(null);
  // OCR 结果来源类型：'image'=来自真实图片（可重新识别/贴回标注）；'text'=来自剪贴板纯文字
  // （合成卡片占位，无真实原图，这两项动作无意义，面板须禁用）。用于统一四个取字入口的下游动作可用性。
  const [ocrSourceKind, setOcrSourceKind] = useState<'image' | 'text' | null>(null);
  // OCR 搜索框 ref：供 Cmd/Ctrl+F 快捷键聚焦。
  const ocrSearchRef = useRef<HTMLInputElement>(null);
  // OCR 搜索命中高亮：当前命中序号（0 起），供「上一处/下一处」跳转与当前命中强调。
  const [ocrMatchIdx, setOcrMatchIdx] = useState(0);
  // OCR 全文高亮容器 ref（替代只读 textarea，保留手动选取复制）。
  const ocrTextRef = useRef<HTMLDivElement>(null);
  // OCR 当前命中 <mark> ref，供「下一处」滚动定位到可视区域。
  const ocrActiveMarkRef = useRef<HTMLElement | null>(null);
  // OCR 面板内空间缩略图的「当前联动行」：鼠标悬停逐行列表或图块框时记录原始块下标，
  // 另一侧据此高亮并滚动定位。null = 无联动焦点。仅用于面板内视觉联动，不影响任何数据链。
  const [ocrHoverLine, setOcrHoverLine] = useState<number | null>(null);
  // OCR 预览框「框选范围取字」：开启时在预览缩略图上拖拽矩形，落在其内的文字块进入 ocrSel 选择集合
  // （复用既有 复制/导出/贴回 管线，做到「精准提取某列/某段落/某表格单元」）。默认关=零回归；
  // 框选结束后自动退出该模式，但选择保留，可直接复制/导出/贴回。
  const [ocrRegionPick, setOcrRegionPick] = useState(false);
  // 拖拽中的矩形（归一化 0..100，相对预览图包裹层），仅用于渲染；松手时换算成块选择。
  const [ocrDrag, setOcrDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const ocrWrapRef = useRef<HTMLDivElement>(null);
  const ocrDragStart = useRef<{ x: number; y: number } | null>(null);

  // OCR 偏好持久化：语言/合并/自动复制/阅读顺序/实体提取/智能清洗 跨会话记住（仅写 localStorage，不碰其它功能）。
  useEffect(() => {
    saveOcrPrefs({ lang: ocrLang, merge: ocrMerge, autoCopy: ocrAutoCopy, layout: ocrLayout, fontSize: ocrFontSize, exportFmt: ocrExportFmt, extract: ocrExtract, clean: ocrClean });
  }, [ocrLang, ocrMerge, ocrAutoCopy, ocrLayout, ocrFontSize, ocrExportFmt, ocrExtract, ocrClean]);
  // OCR 历史持久化（隔离存储，独立于截图历史）
  useEffect(() => {
    saveOcrHist(ocrHistory);
  }, [ocrHistory]);
  // runOcr 内读取最新偏好用的 ref 镜像（避免加入 runOcr 依赖导致频繁重建）。
  const ocrAutoCopyRef = useRef(ocrAutoCopy);
  const ocrMergeRef = useRef(ocrMerge);
  useEffect(() => {
    ocrAutoCopyRef.current = ocrAutoCopy;
  }, [ocrAutoCopy]);
  useEffect(() => {
    ocrMergeRef.current = ocrMerge;
  }, [ocrMerge]);
  // OCR 面板快捷键：仅当取字面板打开时生效，不干扰其它视图。
  // Esc → 关闭面板；Cmd/Ctrl+F → 聚焦结果内搜索框。
  useEffect(() => {
    if (ocrResult === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOcrResult(null);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        ocrSearchRef.current?.focus();
        ocrSearchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ocrResult]);

  // OCR 搜索词变化时，当前命中序号归零（避免越界，并回到第一处）。
  useEffect(() => {
    setOcrMatchIdx(0);
  }, [ocrSearch]);

  // OCR 当前命中变更时，把命中标记滚动到全文框可视区域（命中数>0 时才有 active mark）。
  useEffect(() => {
    ocrActiveMarkRef.current?.scrollIntoView({ block: 'nearest' });
  }, [ocrMatchIdx, ocrSearch]);
  // ===== 滚动长截图 =====
  // scrolling: 是否处于滚动捕获态（主窗口缩为角落控制条）
  // scrollFrames: 已捕获的帧 dataUrl 列表
  // scrollRect: 本次捕获的固定区域（该屏顶部条带，物理像素全局坐标）
  // scrollBusy: 单帧捕获中，防重入
  const [scrolling, setScrolling] = useState(false);
  const [scrollFrames, setScrollFrames] = useState<string[]>([]);
  const [scrollBusy, setScrollBusy] = useState(false);
  const scrollRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  // 进入滚动态前主窗口的尺寸/位置，退出时恢复
  const preScrollWinRef = useRef<{ w: number; h: number; x: number; y: number } | null>(null);
  const scrollBusyRef = useRef(false);
  // scrolling 的 ref 镜像：供全局快捷键监听器判断当前是否在滚动态（避免作为依赖重注册）
  const scrollingRef = useRef(false);
  useEffect(() => {
    scrollingRef.current = scrolling;
  }, [scrolling]);
  // 权限检查中：platform 未确定或正在 check/request 期间，避免 UI 闪烁
  const [permissionChecking, setPermissionChecking] = useState(true);
  // 前端构建模式：vite dev 提供前端时 import.meta.env.DEV 为 true。
  // 注意：此前 tauri dev 跑裸二进制、进不了 TCC；现已改为 start.sh dev
  // 把 dev 编译的二进制包成真正的 .app（Bundle ID com.snap-craft.app.dev，
  // 显示名「SnapCraft (dev)」），因此同样能进 TCC 列表、能授权屏幕录制，
  // 与 release 的权限流程完全一致。isDev 仅用于文案提示，不再决定"能否授权"。
  const isDev = (import.meta as any).env?.DEV === true;

  const {
    currentScreenshot,
    setCurrentScreenshot,
    clearAnnotations,
    annotations,
    activeTool,
    setActiveTool,
    addAnnotation,
    setPlatform: setStorePlatform,
    // OCR 贴回标注时复用当前文字样式默认值
    currentColor,
    currentFontFamily,
    currentBold,
    currentItalic,
    currentTextBg,
    currentBgColor,
    currentBgOpacity,
    currentTextStroke,
    currentStrokeWidth,
  } = useScreenshotStore();

  const canvasRef = useRef<AnnotationCanvasHandle>(null);
  // busy 的 ref 镜像：供 doCapture 防重入检查，避免 busy 作为 useCallback 依赖
  // 导致事件监听器在截图过程中频繁注销/重注册（会产生事件丢失竞态窗口）
  const busyRef = useRef(false);
  // 权限自动重试计数：防止 CGRequestScreenCaptureAccess 无限重试（最多自动请求 2 次）
  const permissionRetryRef = useRef(0);
  // 结果条自动淡出定时器
  const resultBarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // captureDelay 的 ref 镜像：供 doCapture 读取，避免延时变化导致全局快捷键监听器重注册
  const captureDelayRef = useRef(0);
  useEffect(() => {
    captureDelayRef.current = captureDelay;
  }, [captureDelay]);

  // 国际化：订阅语言变化，切换时本组件自动重渲染（t 为稳定模块级函数，供 JSX 与回调共用）
  useI18n();

  // ===== 主题：light / dark / system =====
  useEffect(() => {
    localStorage.setItem('snapcraft-theme', theme);
    const apply = () => {
      const resolved =
        theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : theme;
      document.documentElement.setAttribute('data-theme', resolved);
    };
    apply();
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme]);

  const flash = useCallback(
    (msg: string, type: 'success' | 'error' | 'info' = 'success', keepMs?: number) => {
      setToast(msg);
      setToastType(type);
      // 错误停留最久（5s）便于阅读原因；中性提示（info）适中（2.6s）；成功最短（1.8s）。
      // v14-A P0-3：成功 + keepMs 时延长到 5s，给 reveal 按钮留出点击窗口
      const ms = keepMs ?? (type === 'error' ? 5000 : type === 'info' ? 2600 : 1800);
      window.setTimeout(() => {
        setToast(null);
        setRevealPath(null);
      }, ms);
    },
    []
  );

  // 延时倒计时：在主窗口仍可见时以覆盖层显示 N…1 的读秒，倒计时结束再真正截图。
  // 放在窗口隐藏之前跑，用户能看到读秒；结束后返回，调用方再 hide + 截图。
  const runCountdown = useCallback(async (secs: number) => {
    if (secs <= 0) return;
    for (let s = secs; s > 0; s--) {
      setCountdown(s);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCountdown(null);
  }, []);

  // ===== 启动加载历史记录 =====
  useEffect(() => {
    (async () => {
      try {
        const raw = (await invoke('get_history')) as any[];
        if (Array.isArray(raw)) {
          setHistory(
            raw.map((i) => ({
              id: i.id,
              dataUrl: i.data_url,
              createdAt: i.created_at,
              width: i.width,
              height: i.height,
              source: i.source === 'clipboard' ? 'clipboard' : 'capture',
            }))
          );
        }
      } catch {
        /* 历史为空或读取失败，忽略 */
      }
    })();
  }, []);

  const onCaptured = useCallback(
    async (dataUrl: string) => {
      flog(`onCaptured 收到截图数据: dataUrl长度=${dataUrl?.length ?? 0} 前缀=${(dataUrl || '').slice(0, 32)}`);
      const decT0 = performance.now();
      const { width, height } = await new Promise<{ width: number; height: number }>(
        (res, rej) => {
          const img = new Image();
          img.onload = () => res({ width: img.width, height: img.height });
          img.onerror = () => {
            flog(`❌ onCaptured 截图数据解码失败: dataUrl长度=${dataUrl?.length ?? 0}`);
            rej(new Error('截图数据解码失败'));
          };
          img.src = dataUrl;
        }
      );
      flog(
        `onCaptured 解码成功: 自然像素=${width}x${height} 解码耗时=${(performance.now() - decT0).toFixed(0)}ms DPR=${window.devicePixelRatio}`
      );
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date().toISOString();
      const entry: HistoryEntry = { id, dataUrl, createdAt, width, height, source: 'capture' };
      setHistory((h) => [entry, ...h]);
      try {
        await invoke('add_history', {
          item: { id, data_url: dataUrl, created_at: createdAt, width, height, source: 'capture' },
        });
      } catch {
        /* 持久化失败不阻断使用 */
      }
      // 截图后自动复制到剪贴板——用户截图最常见的目的就是粘贴
      try {
        await invoke('copy_to_clipboard', { imageData: dataUrl });
        flash(t('toast.doneCopied'), 'success');
      } catch {
        /* 自动复制失败不阻断使用，用户可手动复制 */
      }
      // 不再强制进编辑器：停在主页弹出轻量结果条（缩略图 + 复制/编辑/保存/钉图）。
      // 想标注再点「编辑」。结果条 6 秒后自动淡出。
      flog(`onCaptured 完成: 生成结果条 id=${id} 尺寸=${width}x${height}`);
      setLastShot({ id, dataUrl, width, height });
      if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current);
      resultBarTimerRef.current = setTimeout(() => setLastShot(null), 6000);
    },
    [flash]
  );

  // 结果条 / 历史项 → 进入编辑器标注
  const openEditor = useCallback(
    (shot: { id: string; dataUrl: string; width: number; height: number }) => {
      flog(
        `点击编辑→打开编辑器: id=${shot.id} 传入尺寸=${shot.width}x${shot.height} dataUrl长度=${shot.dataUrl?.length ?? 0}`
      );
      if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current);
      setLastShot(null);
      const createdAt = new Date().toISOString();
      setCurrent({ dataUrl: shot.dataUrl, width: shot.width, height: shot.height });
      setCurrentScreenshot({
        id: shot.id,
        filePath: '',
        dataUrl: shot.dataUrl,
        width: shot.width,
        height: shot.height,
        annotations: [],
        layers: [],
        createdAt,
        updatedAt: createdAt,
      });
      clearAnnotations();
      setCurrentView('edit');
      flog(`编辑器视图已切换(currentView=edit)，等待 AnnotationCanvas 渲染`);
    },
    [setCurrentScreenshot, clearAnnotations]
  );

  // 裁剪确认：用裁剪后的新图替换当前编辑对象，清空标注（标注已合并进新图）。
  const onCropped = useCallback(
    (dataUrl: string, width: number, height: number) => {
      const id = `${Date.now()}-crop`;
      const createdAt = new Date().toISOString();
      setCurrent({ dataUrl, width, height });
      setCurrentScreenshot({
        id,
        filePath: '',
        dataUrl,
        width,
        height,
        annotations: [],
        layers: [],
        createdAt,
        updatedAt: createdAt,
      });
      clearAnnotations();
      setActiveTool('select');
      flash(t('crop.done'), 'success');
    },
    [setCurrentScreenshot, clearAnnotations, setActiveTool, flash]
  );

  // ===== 平台检测（决定快捷键提示与区域截图方式）=====
  // 同时写入本地 state（本组件用）与全局 store（AnnotationToolbar 等子组件用），
  // 否则子组件读到的 store.platform 恒为空串，会错误退回 macOS 快捷键提示。
  useEffect(() => {
    invoke('get_platform')
      .then((p) => {
        setPlatform(p as string);
        setStorePlatform(p as string);
        // macOS 沙箱检测：App Store 构建为 true；开发者 ID 为 false。仅 macOS 查询（命令仅 macOS 注册）。
        if (p === 'macos') {
          invoke<boolean>('is_sandboxed').then(setIsSandboxed).catch(() => setIsSandboxed(false));
        }
      })
      .catch(() => {
        // ⚠️ 跨平台对等（R2）：IPC 失败时不可回落到 'macos'，
        // 否则 Windows / Linux 会错误走 macOS 专属分支。改用 UA 兜底判定。
        const fallback = detectPlatformFromUA();
        console.warn(`[platform] get_platform 调用失败，回落到 UA 判定: ${fallback}`);
        setPlatform(fallback);
        setStorePlatform(fallback);
        if (fallback === 'macos') {
          invoke<boolean>('is_sandboxed').then(setIsSandboxed).catch(() => setIsSandboxed(false));
        }
      });
  }, [setStorePlatform]);

  const isWinLike = platform === 'windows' || platform === 'linux';
  const modLabel = isWinLike ? 'Ctrl' : '⌘';
  // Shift 键标签：Windows/Linux 用文字 "Shift"，macOS 用符号 ⇧（与系统习惯一致）
  const shiftLabel = isWinLike ? 'Shift' : '⇧';

  // 加载显示器列表（多屏时全屏截图弹出选择器需要）。macOS/Windows 均支持多屏枚举。
  useEffect(() => {
    if (platform === '') return; // 平台未就绪时不查
    invoke<DisplayInfo[]>('list_displays')
      .then(setDisplays)
      .catch(() => setDisplays([]));
  }, [platform]);

  // ===== macOS 屏幕录制权限：启动预检 → 自动请求弹窗 → 延迟复检 → fallback 手动引导 =====
  // 设计原则：用户只需点一次"允许"，系统弹窗后自动检测授权结果，形成闭环
  useEffect(() => {
    if (platform !== 'macos') {
      setPermissionChecking(false);
      return;
    }
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const check = async (isFromFocus = false) => {
      if (isFromFocus) {
        // focus 防抖：快速切换窗口时不连续触发
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => check(false), 300);
        return;
      }
      try {
        const ok = await invoke<boolean>('check_screen_capture_access');
        if (ok) {
          setPermissionNeeded(false);
          setPermissionChecking(false);
          permissionRetryRef.current = 0;
          return;
        }
        // 没权限：触发系统授权弹窗（CGRequestScreenCaptureAccess）。
        // ⚠️ 该 API 是异步的：弹窗会在调用后稍后显示，返回值不代表用户已操作。
        //    所以无论返回 true/false，都延迟 2s 后重新检查权限状态
        //    （弹窗出现→用户点允许→2s 后 re-check 检测到权限→不显示引导页）。
        //    最多自动请求 2 次，超过后显示引导页让用户手动处理。
        if (permissionRetryRef.current < 2) {
          permissionRetryRef.current += 1;
          await invoke<boolean>('request_screen_capture_access');
          setTimeout(() => check(false), 2000);
          return;
        }
        // 重试已用完：弹窗可能未出现，显示引导页让用户手动在系统设置开启
        setPermissionChecking(false);
        setPermissionNeeded(true);
      } catch {
        setPermissionChecking(false);
        setPermissionNeeded(true);
      }
    };

    // 延迟 1.5s 再检查：app 刚启动时可能还未完全成为前台 active 状态，
    // 此时调 CGRequestScreenCaptureAccess 系统弹窗可能不显示。延迟让窗口准备好。
    const initialTimer = setTimeout(() => check(false), 1500);
    // 从系统设置返回后重新检测（防抖）
    const onFocus = () => check(true);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (debounceTimer) clearTimeout(debounceTimer);
      clearTimeout(initialTimer);
    };
  }, [platform, isDev]);

  // 一键打开「系统设置 → 屏幕录制」
  const openScreenRecordingSettings = useCallback(() => {
    invoke('open_screen_recording_settings').catch(() => {});
  }, []);

  // 手动重新检查权限（用户在系统设置中授权后点"已授权？刷新"触发）
  const recheckPermission = useCallback(async () => {
    setPermissionChecking(true);
    try {
      const ok = await invoke<boolean>('check_screen_capture_access');
      setPermissionNeeded(!ok);
      if (ok) {
        permissionRetryRef.current = 0;
        flash(t('toast.granted'), 'success');
      } else {
        flash(t('toast.notGranted'), 'error');
      }
    } catch {
      setPermissionNeeded(true);
    } finally {
      setPermissionChecking(false);
    }
  }, [flash]);

  // 截图前权限预检：窗口可见时触发系统授权弹窗（最可靠）。
  // ⚠️ 关键：必须在 win.hide() 之前检查——窗口隐藏后调 CGRequestScreenCaptureAccess，
  //    系统授权弹窗无法显示，用户会什么都看不到（连点截图无反应）。
  const ensureCapturePermission = useCallback(async (): Promise<boolean> => {
    if (platform !== 'macos') return true;
    const ok = await invoke<boolean>('check_screen_capture_access');
    if (ok) return true;
    // 窗口仍可见时主动触发系统授权弹窗（CGRequestScreenCaptureAccess）
    await invoke<boolean>('request_screen_capture_access');
    setPermissionNeeded(true);
    return false;
  }, [platform, setPermissionNeeded]);

  // ===== 滚动长截图：手动滚动 + 智能拼接 =====
  // 捕获区域 = 所选显示器的「整宽 × 顶部约 78% 高」固定条带。用户在其它位置滚动，
  // 按全局快捷键（⌘/Ctrl+Shift+4）或点控制条按钮捕一帧，完成后自动去重叠拼成长图。

  // 进入滚动捕获态：把主窗口缩为角落小控制条（不遮挡内容），记录捕获区域。
  const enterScrollMode = useCallback(
    async (disp: DisplayInfo) => {
      // 捕获条带：整屏宽，顶部起，高取屏高的 78%（留出底部让用户操作滚动）
      const stripH = Math.round(disp.height * 0.78);
      scrollRectRef.current = { x: disp.x, y: disp.y, width: disp.width, height: stripH };
      setScrollFrames([]);
      setScrolling(true);
      // 记录并缩小主窗口到该屏右下角作为控制条
      const win = getCurrentWindow();
      try {
        const sz = await win.innerSize();
        const ps = await win.outerPosition();
        const sf = await win.scaleFactor();
        preScrollWinRef.current = {
          w: sz.width / sf,
          h: sz.height / sf,
          x: ps.x / sf,
          y: ps.y / sf,
        };
        const barW = 340;
        const barH = 132;
        await win.setSize(new LogicalSize(barW, barH));
        // 停靠到该屏右下角（用逻辑坐标；控制条不遮挡将要滚动的主要区域）
        const px = disp.x + disp.width - barW - 24;
        const py = disp.y + disp.height - barH - 40;
        await win.setPosition(new LogicalPosition(px, py));
        await win.setAlwaysOnTop(true);
        await win.show();
        await win.setFocus();
      } catch {
        /* 窗口操作失败不阻断，仍可用 */
      }
    },
    []
  );

  // 捕获一帧：截固定区域，追加到帧列表
  const captureScrollFrame = useCallback(async () => {
    if (scrollBusyRef.current) return;
    const rect = scrollRectRef.current;
    if (!rect) return;
    scrollBusyRef.current = true;
    setScrollBusy(true);
    // 权限预检（macOS）
    if (!(await ensureCapturePermission())) {
      scrollBusyRef.current = false;
      setScrollBusy(false);
      return;
    }
    try {
      const dataUrl = await invoke<string>('capture_region_fixed', { rect });
      setScrollFrames((f) => [...f, dataUrl]);
      flash(t('toast.frameCaptured'), 'success');
    } catch (e) {
      const msg = String(e);
      if (msg.includes('屏幕录制') || msg.includes('permission') || msg.includes('denied') || msg.includes('not authorized')) {
        if (platform === 'macos') {
          invoke<boolean>('check_screen_capture_access').then((ok) => {
            if (!ok) setPermissionNeeded(true);
          });
        }
      } else {
        flash(t('toast.captureFailed', { msg }), 'error');
      }
    } finally {
      scrollBusyRef.current = false;
      setScrollBusy(false);
    }
  }, [ensureCapturePermission, flash, platform, setPermissionNeeded]);

  // 恢复主窗口尺寸/位置并退出滚动态
  const restoreMainWindow = useCallback(async () => {
    const win = getCurrentWindow();
    try {
      await win.setAlwaysOnTop(false);
      const p = preScrollWinRef.current;
      if (p) {
        await win.setSize(new LogicalSize(p.w, p.h));
        await win.setPosition(new LogicalPosition(p.x, p.y));
      }
      await win.show();
      await win.setFocus();
    } catch {
      /* ignore */
    }
    preScrollWinRef.current = null;
    setScrolling(false);
  }, []);

  // 完成：拼接所有帧 → 长图 → 走 onCaptured（进历史 + 结果条）
  const finishScrollCapture = useCallback(async () => {
    const frames = scrollFrames;
    await restoreMainWindow();
    if (frames.length === 0) {
      flash(t('toast.noFrames'), 'error');
      return;
    }
    if (frames.length === 1) {
      // 只有一帧，直接当普通截图
      await onCaptured(frames[0]);
      return;
    }
    try {
      const imgs = await Promise.all(frames.map((d) => loadImage(d)));
      const sframes: StitchFrame[] = imgs.map((img) => ({
        img,
        width: img.naturalWidth,
        height: img.naturalHeight,
      }));
      const { canvas, hadLowConfidence } = stitchFrames(sframes);
      const merged = canvas.toDataURL('image/png');
      await onCaptured(merged);
      if (hadLowConfidence) {
        flash(t('toast.stitchGap'), 'error');
      } else {
        flash(t('toast.stitched', { n: frames.length }), 'success');
      }
    } catch (e) {
      flash(t('toast.stitchFailed', { msg: String(e) }), 'error');
    }
  }, [scrollFrames, restoreMainWindow, onCaptured, flash]);

  // 取消滚动捕获：丢弃已捕获帧并恢复窗口
  const cancelScrollCapture = useCallback(async () => {
    setScrollFrames([]);
    await restoreMainWindow();
    flash(t('toast.scrollCancelled'), 'success');
  }, [restoreMainWindow, flash]);

  // 发起滚动长截图：多屏先选屏，单屏直接进入
  const startScrollCapture = useCallback(async () => {
    if (scrolling) return;
    let disp: DisplayInfo[] = [];
    try {
      disp = await invoke<DisplayInfo[]>('list_displays');
      if (disp.length > 0) setDisplays(disp);
    } catch {
      /* ignore */
    }
    if (disp.length > 1) {
      pickerPurposeRef.current = 'scroll';
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
      setShowDisplayPicker(true);
      return;
    }
    // 单屏（或枚举失败退回主屏）：构造一个默认屏信息
    const only =
      disp[0] || { id: 0, is_main: true, x: 0, y: 0, width: 1440, height: 900, scale: 1 };
    await enterScrollMode(only);
  }, [scrolling, enterScrollMode]);

  // 用户在选择器中点选某块屏后：关闭选择器 → 按用途走全屏截图或滚动长截图
  const pickDisplay = useCallback(
    async (displayId: number | null) => {
      setShowDisplayPicker(false);
      // displayId === null 表示取消
      if (displayId === null) {
        flog(`pickDisplay: 用户取消选屏`);
        flash(t('toast.cancelled'), 'success');
        return;
      }
      const picked = displays.find((d) => d.id === displayId);
      flog(
        `pickDisplay: 用户选中显示器 id=${displayId} 用途=${pickerPurposeRef.current} ` +
          (picked
            ? `主屏=${picked.is_main} 逻辑=${picked.width}x${picked.height} scale=${picked.scale} 全局坐标=(${picked.x},${picked.y})`
            : `(未在列表找到该屏元数据)`)
      );
      // 滚动长截图用途：进入滚动捕获态（不走下面的单帧全屏流程）
      if (pickerPurposeRef.current === 'scroll') {
        pickerPurposeRef.current = 'shot';
        const disp = displays.find((d) => d.id === displayId);
        if (disp) await enterScrollMode(disp);
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      // 权限预检：无权限则不隐藏窗口，直接触发授权弹窗 + 显示引导
      if (!(await ensureCapturePermission())) {
        busyRef.current = false;
        setBusy(false);
        return;
      }
      // 延时倒计时（窗口仍可见时读秒，结束后再隐藏截图）
      const delay = captureDelayRef.current;
      if (delay > 0) await runCountdown(delay);
      const win = getCurrentWindow();
      // ⚠️ 全屏/最大化时不能直接 hide（会截到 macOS Space 过渡黑场），走安全隐藏
      await safeHideForCapture(win);
      try {
        const invT0 = performance.now();
        const dataUrl = await invoke<string>('capture_screen', { displayId });
        flog(
          `pickDisplay: capture_screen(id=${displayId}) 返回 dataUrl长度=${dataUrl?.length ?? 0} invoke耗时=${(performance.now() - invT0).toFixed(0)}ms`
        );
        await onCaptured(dataUrl);
      } catch (e) {
        const msg = String(e);
        flog(`❌ pickDisplay: capture_screen(id=${displayId}) 抛错: ${msg}`);
        if (msg.includes('屏幕录制') || msg.includes('permission') || msg.includes('denied') || msg.includes('not authorized')) {
          if (platform === 'macos') {
            invoke<boolean>('check_screen_capture_access').then((ok) => {
              if (!ok) setPermissionNeeded(true);
            });
          }
          return;
        }
        if (msg.includes('截图已取消') || msg.toLowerCase().includes('cancelled')) {
          flash(t('toast.cancelled'), 'success');
        } else {
          flash(t('toast.captureFailed', { msg }), 'error');
        }
      } finally {
        await win.show();
        await win.setFocus();
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onCaptured, flash, platform, setPermissionNeeded, ensureCapturePermission, runCountdown, displays, enterScrollMode]
  );

  // Windows/Linux 区域截图：打开覆盖【整个虚拟桌面】的全屏选区覆盖层（独立置顶无边框窗口）。
  // 选区结果通过 'region-selected' 事件回传（见下方监听），再真正 invoke capture_region。
  const openRegionOverlay = useCallback(async () => {
    try {
      const existing = await WebviewWindow.getByLabel('region-overlay').catch(() => null);
      if (existing) {
        try { await existing.setFocus(); } catch { /* ignore */ }
        return;
      }
      // 主窗口先隐藏，避免遮挡或被截入
      const main = getCurrentWindow();
      await main.hide();
      // 计算所有显示器的并集包围盒（虚拟桌面），覆盖层铺满整个虚拟桌面 → 支持任意屏拉框。
      // Windows/Linux 的 x/y/width/height 为物理像素、正坐标系。
      // ⚠️ 跨平台坐标一致性（HiDPI 关键修复）：Tauri WebviewWindow 的 x/y/width/height
      // 期望【逻辑像素】，而 list_displays 返回的是【物理像素】。若直接把物理值当逻辑值
      // 传入，在 DPR≠1 的 Windows（如 Surface / 4K 笔记本）上覆盖层会被放大 DPR 倍并错位，
      // 导致区域选框坐标整体偏移 → 截错位置。故创建窗口时按 dpr 折算为逻辑像素，
      // 并把 dpr 经 URL 传给覆盖层，使其内部「CSS局部 × dpr + 原点」换算与窗口定位保持一致。
      // DPR=1 时折算为恒等变换，零回归。
      const dpr = window.devicePixelRatio || 1;
      let vx = 0, vy = 0, vw = 0, vh = 0;
      try {
        const disp = await invoke<DisplayInfo[]>('list_displays');
        if (disp.length > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const d of disp) {
            minX = Math.min(minX, d.x);
            minY = Math.min(minY, d.y);
            maxX = Math.max(maxX, d.x + d.width);
            maxY = Math.max(maxY, d.y + d.height);
          }
          vx = minX; vy = minY;
          vw = maxX - minX; vh = maxY - minY;
        }
      } catch { /* ignore，退回让系统决定尺寸 */ }
      new WebviewWindow('region-overlay', {
        // 把虚拟桌面原点 + dpr 通过 URL 传给覆盖层，用于把 CSS 局部坐标换算成全局物理像素
        url: `/#region-overlay?vx=${vx}&vy=${vy}&vw=${vw}&vh=${vh}&dpr=${dpr}`,
        // 物理像素 → 逻辑像素（Tauri 窗口几何单位），HiDPI 下覆盖层才能精确铺满虚拟桌面
        x: Math.round(vx / dpr),
        y: Math.round(vy / dpr),
        width: Math.round(vw / dpr) || undefined,
        height: Math.round(vh / dpr) || undefined,
        transparent: true,
        decorations: false,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        fullscreen: false,
        focus: true,
      } as any);
    } catch (e) {
      flash(t('toast.openRegionFailed', { msg: String(e) }), 'error');
      try { await getCurrentWindow().show(); } catch { /* ignore */ }
    }
  }, [flash]);

  // Windows/Linux 窗口截图：打开覆盖整个虚拟桌面的窗口点选覆盖层。
  // 覆盖层枚举窗口画高亮框，用户点选后 emit 'window-picked' 带 window_id 回传。
  const openWindowOverlay = useCallback(async () => {
    try {
      const existing = await WebviewWindow.getByLabel('window-overlay').catch(() => null);
      if (existing) {
        try { await existing.setFocus(); } catch { /* ignore */ }
        return;
      }
      const main = getCurrentWindow();
      await main.hide();
      // 同 region-overlay：list_displays 返回物理像素，Tauri 窗口几何用逻辑像素，
      // 按 dpr 折算避免 HiDPI Windows 下覆盖层错位；dpr 经 URL 传给覆盖层保持换算一致。
      const dpr = window.devicePixelRatio || 1;
      let vx = 0, vy = 0, vw = 0, vh = 0;
      try {
        const disp = await invoke<DisplayInfo[]>('list_displays');
        if (disp.length > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const d of disp) {
            minX = Math.min(minX, d.x);
            minY = Math.min(minY, d.y);
            maxX = Math.max(maxX, d.x + d.width);
            maxY = Math.max(maxY, d.y + d.height);
          }
          vx = minX; vy = minY;
          vw = maxX - minX; vh = maxY - minY;
        }
      } catch { /* ignore */ }
      new WebviewWindow('window-overlay', {
        url: `/#window-overlay?vx=${vx}&vy=${vy}&vw=${vw}&vh=${vh}&dpr=${dpr}`,
        x: Math.round(vx / dpr),
        y: Math.round(vy / dpr),
        width: Math.round(vw / dpr) || undefined,
        height: Math.round(vh / dpr) || undefined,
        transparent: true,
        decorations: false,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        fullscreen: false,
        focus: true,
      } as any);
    } catch (e) {
      flash(t('toast.openWindowFailed', { msg: String(e) }), 'error');
      try { await getCurrentWindow().show(); } catch { /* ignore */ }
    }
  }, [flash]);

  const doCapture = useCallback(
    async (kind: 'screen' | 'region' | 'window') => {
      flog(`doCapture 触发: kind=${kind} platform=${platform} busy=${busyRef.current} delay=${captureDelayRef.current}`);
      if (busyRef.current) return; // 防重入：用 ref 而非 state，避免作为 useCallback 依赖
      // 多显示器：全屏截图先让用户选具体显示器（macOS 用 CGDisplayBounds、Windows 用 xcap 均支持按 id 截取）
      // 总是即时获取最新显示器列表（不依赖 displays 状态闭包值，避免旧值导致选择器不弹出）
      if (kind === 'screen') {
        let disp: DisplayInfo[] = [];
        try {
          disp = await invoke<DisplayInfo[]>('list_displays');
          if (disp.length > 0) setDisplays(disp);
        } catch { /* ignore，退回单屏 */ }
        flog(`doCapture(screen): 枚举到 ${disp.length} 块显示器${disp.length > 1 ? ' → 弹出选屏器' : ' → 直接截主屏'}`);
        if (disp.length > 1) {
          // 多屏：弹出居中选择器（不遮挡真实屏幕），用户点选后 pickDisplay 截取
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();
          setShowDisplayPicker(true);
          return;
        }
      }
      busyRef.current = true;
      setBusy(true);
      // 区域截图分流：
      //  - macOS：走系统原生交互式 -i（下方统一 invoke capture_region）；
      //  - Windows/Linux：系统无可调用的交互截图 API，打开自建全屏覆盖层选区，
      //    选区完成后由 'region-selected' 事件回调真正 invoke capture_region。
      if (kind === 'region' && platform !== '' && (platform !== 'macos' || isSandboxed)) {
        busyRef.current = false;
        setBusy(false);
        await openRegionOverlay();
        return;
      }
      // 窗口截图分流：
      //  - macOS：走系统原生 -w 点窗（下方统一 invoke capture_window）；
      //  - Windows/Linux：打开窗口点选覆盖层，画高亮框让用户点选目标窗口，
      //    选中后由 'window-picked' 事件回调 invoke capture_window_by_id。
      if (kind === 'window' && platform !== '' && (platform !== 'macos' || isSandboxed)) {
        busyRef.current = false;
        setBusy(false);
        await openWindowOverlay();
        return;
      }
      // 权限预检：无权限则不隐藏窗口，直接触发授权弹窗 + 显示引导
      if (!(await ensureCapturePermission())) {
        busyRef.current = false;
        setBusy(false);
        return;
      }
      // 延时截图仅对全屏生效（区域/窗口是交互式，用户自己控制时机）。
      // 倒计时在窗口隐藏前跑，用户能看到读秒。
      if (kind === 'screen') {
        const delay = captureDelayRef.current;
        if (delay > 0) await runCountdown(delay);
      }
      const win = getCurrentWindow();
      // 隐藏自身窗口，避免截到工具界面（系统交互式截图 -i/-w 也不应把本工具截进去）
      // ⚠️ 全屏/最大化时走安全隐藏，先退出全屏等 Space 过渡结束，否则截到黑屏
      await safeHideForCapture(win);
      try {
        // 区域 / 窗口截图：直接交给 macOS 系统原生交互式截图。
        // region → 后端 screencapture -i（系统十字选区，等同 Cmd+Shift+4，
        //           自动支持跨屏拖选、空格切窗口模式、Esc 取消）。
        // window → 后端 screencapture -w（系统点窗取图）。
        // 系统 WindowServer 自行处理跨屏/负坐标/取消，比自建透明覆盖层可靠得多，
        // 且不自建任何遮挡真实屏幕的窗口。
        const cmd =
          kind === 'screen' ? 'capture_screen' : kind === 'region' ? 'capture_region' : 'capture_window';
        // capture_screen 需要 displayId=null（截主屏）；region/window 无需参数（后端走交互式）
        const args = kind === 'screen' ? { displayId: null } : {};
        const invT0 = performance.now();
        flog(`doCapture: invoke ${cmd} args=${JSON.stringify(args)}`);
        const dataUrl = await invoke<string>(cmd, args);
        flog(
          `doCapture: ${cmd} 返回 dataUrl长度=${dataUrl?.length ?? 0} invoke耗时=${(performance.now() - invT0).toFixed(0)}ms`
        );
        await onCaptured(dataUrl);
      } catch (e) {
        const msg = String(e);
        flog(`❌ doCapture(${kind}) 抛错: ${msg}`);
        // 权限被拒：自动重检权限状态，弹出引导页
        if (msg.includes('屏幕录制') || msg.includes('permission') || msg.includes('denied') || msg.includes('not authorized')) {
          if (platform === 'macos') {
            // 后台重检权限，若确实没权限则弹出引导页
            invoke<boolean>('check_screen_capture_access').then((ok) => {
              if (!ok) setPermissionNeeded(true);
            });
          }
          return;
        }
        if (msg.includes('截图已取消') || msg.toLowerCase().includes('cancelled')) {
          flash(t('toast.cancelled'), 'success');
        } else {
          flash(t('toast.captureFailed', { msg }), 'error');
        }
      } finally {
        await win.show();
        await win.setFocus();
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onCaptured, flash, platform, isSandboxed, setPermissionNeeded, ensureCapturePermission, openRegionOverlay, openWindowOverlay, runCountdown]
  );

  // ===== 全局快捷键监听 =====
  // 依赖数组不含 doCapture（doCapture 用 busyRef 防重入，不再依赖 busy state），
  // 避免截图过程中 busy 变化导致监听器注销/重注册产生事件丢失竞态
  useEffect(() => {
    const un: Promise<UnlistenFn>[] = [
      listen('capture-screen', () => doCapture('screen')),
      listen('capture-region', () => doCapture('region')),
      listen('capture-window', () => doCapture('window')),
      listen('shortcut-register-failed', (e) => {
        flash(String(e.payload), 'error');
      }),
    ];
    return () => {
      un.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [doCapture, flash]);

  // ===== 滚动长截图：全局快捷键「捕获下一帧」监听 =====
  // 后端 ⌘/Ctrl+Shift+4 → emit 'capture-scroll-frame'。仅在滚动态响应，
  // 这样用户滚动时无需切回控制条即可连续捕帧。用 ref 判断状态，避免依赖 scrolling 重注册。
  const captureScrollFrameRef = useRef(captureScrollFrame);
  useEffect(() => {
    captureScrollFrameRef.current = captureScrollFrame;
  }, [captureScrollFrame]);
  useEffect(() => {
    const un = listen('capture-scroll-frame', () => {
      if (scrollingRef.current) captureScrollFrameRef.current();
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  // ===== 区域截图覆盖层事件（Windows/Linux）=====
  // 覆盖层选区完成 → 收到全局物理像素 rect → 真正 invoke capture_region → 展示结果。
  // 覆盖层取消 → 恢复主窗口显示。
  useEffect(() => {
    const un: Promise<UnlistenFn>[] = [
      listen('region-selected', async (e) => {
        const rect = e.payload as { x: number; y: number; width: number; height: number };
        const main = getCurrentWindow();
        try {
          const dataUrl = await invoke<string>('capture_region', { rect });
          await onCaptured(dataUrl);
          await main.show();
          await main.setFocus();
        } catch (err) {
          const msg = String(err);
          if (msg.includes('取消') || msg.toLowerCase().includes('cancel')) {
            flash(t('toast.cancelled'), 'success');
          } else {
            flash(t('toast.captureFailed', { msg }), 'error');
          }
          try { await main.show(); await main.setFocus(); } catch { /* ignore */ }
        }
      }),
      listen('region-cancelled', async () => {
        const main = getCurrentWindow();
        try { await main.show(); await main.setFocus(); } catch { /* ignore */ }
      }),
      // 窗口点选覆盖层：收到 window_id → invoke capture_window_by_id → 展示结果
      listen('window-picked', async (e) => {
        const { windowId } = e.payload as { windowId: number };
        const main = getCurrentWindow();
        try {
          const dataUrl = await invoke<string>('capture_window_by_id', { windowId });
          await onCaptured(dataUrl);
          await main.show();
          await main.setFocus();
        } catch (err) {
          const msg = String(err);
          if (msg.includes('取消') || msg.toLowerCase().includes('cancel')) {
            flash(t('toast.cancelled'), 'success');
          } else {
            flash(t('toast.captureFailed', { msg }), 'error');
          }
          try { await main.show(); await main.setFocus(); } catch { /* ignore */ }
        }
      }),
      listen('window-cancelled', async () => {
        const main = getCurrentWindow();
        try { await main.show(); await main.setFocus(); } catch { /* ignore */ }
      }),
    ];
    return () => {
      un.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [onCaptured, flash]);

  // 保存 / 复制时若已标注，合并标注后导出（否则用原始截图）。
  // 标注含马赛克时合并是异步的（需在 2D canvas 上二次合成），故返回 Promise。
  const getExportDataUrl = async (): Promise<string> => {
    if (annotations.length > 0 && canvasRef.current) {
      const merged = await canvasRef.current.getMergedImageDataUrl();
      if (merged) return merged;
    }
    return current!.dataUrl;
  };

  const handleSave = async () => {
    if (!current) return;
    const path = await save({
      defaultPath: `snapcraft-${Date.now()}.png`,
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (!path) return;
    try {
      await invoke('save_screenshot', { imageData: await getExportDataUrl(), filePath: path });
      setRevealPath(path);
      flash(t('toast.savedWithReveal', { path }), 'success', 5000);
    } catch (e) {
      flash(t('toast.saveFailed', { msg: String(e) }), 'error');
    }
  };

  const handleCopy = async () => {
    if (!current) return;
    try {
      await invoke('copy_to_clipboard', { imageData: await getExportDataUrl() });
      flash(t('toast.copied'), 'success');
    } catch (e) {
      flash(t('toast.copyFailed', { msg: String(e) }), 'error');
    }
  };

  // OCR 取字：调用系统原生 OCR（macOS Vision / Windows.Media.Ocr）识别图片文字。
  // 用原始截图（current.dataUrl，不含标注）识别，标注线条会干扰识别。
  // lang：语言提示（'auto' 表示交给系统自动选语言，仅 Windows 侧强制生效）。
    const runOcr = useCallback(
    async (imageData: string, langOverride?: string | null) => {
      if (ocrBusy) return null;
      setOcrBusy(true);
      setOcrElapsed(null);
      setOcrLastImage(imageData);
      setOcrSourceKind('image'); // 来自真实图片：重新识别 / 贴回标注均有效
      const t0 = performance.now();
      const used =
        langOverride !== undefined
          ? langOverride
          : ocrLang === 'auto'
          ? null
          : ocrLang;
      try {
        const res = await invoke<OcrResult>('ocr_image', {
          imageData,
          lang: used,
        });
        // Phase 18：OCR 乱码前端清洗（去零宽字符/控制字符/重复字）
        const cleanedText = cleanOcrText(res?.text);
        const cleanedBlocks = (res?.blocks ?? []).map((b) => ({ ...b, text: cleanOcrText(b.text) }));
        const cleaned: OcrResult = { text: cleanedText, blocks: cleanedBlocks };
        const elapsed = Math.round(performance.now() - t0);
        // 新的识别结果：丢弃旧的内联修正（修正只针对上一张识别文字）；
        // 重置置信度阈值（与本次结果质量相关）；清空逐行勾选（选择只针对本次结果）；
        // 退出预览框「框选范围」模式并清空其拖拽矩形（选择只针对本次结果）；
        // 保留「合并为一行」「自动复制」「字号」「导出格式」偏好（跨会话偏好）。
        setOcrEdits({});
        setOcrSearch('');
        setOcrConf(0);
        setOcrSel({});
        setOcrRegionPick(false);
        setOcrDrag(null);
        setOcrResult(cleaned);
        setOcrElapsed(elapsed);
        // 历史：以规范换行副本记录（与搜索/合并无关），最近 50 条，隔离存储。
        // 附「来源截图缩略图 + sourceId」，便于点击历史回放：跳回原截图 + 重载识别结果。
        if (current) {
          // 用 store 里的 currentScreenshot.id（更可靠，view 层 current 无 id）。
          // 剪贴板取字等场景 currentScreenshot.id 为空，正常跳过落库。
          const sourceId = currentScreenshot?.id ?? '';
          const plain = cleanedBlocks.map((b) => b.text).join('\n');
          const histThumb = makeThumbDataUrl(current.dataUrl, 80, 60);
          const histSourceId = sourceId || undefined;
          setOcrHistory((h) =>
            [
              { text: plain, lang: used ?? 'auto', ts: Date.now(), chars: plain.length, thumb: histThumb, sourceId: histSourceId },
              ...h,
            ].slice(0, OCR_HIST_MAX)
          );
          // v4：OCR 完整结果（坐标+置信度）落库到 Rust history.json。
          // 关窗重开后能取字位置、逐行框选/编辑、按框选局部重识别（不再伪造占位 bbox）。
          if (sourceId) {
            try {
              await invoke('set_screenshot_ocr_full', {
                id: sourceId,
                ocrText: cleanedText,
                ocrBlocksJson: JSON.stringify(cleanedBlocks),
              });
            } catch (e) {
              // 静默：本地 ocrHistory 已兜底，Rust 写失败不影响本次交互。
              console.warn('[OCR] 持久化 ocr_blocks 失败:', e);
            }
          }
        }
        // 自动复制（默认关）：复制当前显示文字（尊重「合并为一行」格式）。
        if (ocrAutoCopyRef.current) {
          const txt = cleanedBlocks.map((b) => b.text).join(ocrMergeRef.current ? ' ' : '\n');
          try {
            await navigator.clipboard.writeText(txt);
            flash(t('ocr.autoCopied'), 'success');
          } catch {
            flash(t('ocr.copyFailed'), 'error');
          }
        }
        return res;
      } catch (e) {
        const msg = String(e);
        if (msg.includes('未识别到文字')) {
          flash(t('toast.ocrNone'), 'error');
        } else {
          flash(t('toast.ocrFailed', { msg }), 'error');
        }
        return null;
      } finally {
        setOcrBusy(false);
      }
    },
    [ocrBusy, ocrLang, flash, t]
  );

  // 取某块当前文字：优先用内联修正，否则原始识别文字。
  const ocrTextAt = (i: number, b: OcrBlock): string =>
    ocrEdits[i] !== undefined ? ocrEdits[i] : b.text;

  // OCR 全文框选中全部（替代只读 textarea 的 onFocus 全选，保留手动复制便利）。
  const selectOcrText = () => {
    const el = ocrTextRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel) return;
    const r = document.createRange();
    r.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(r);
  };

  // 当前可见的识别行：同时受「搜索」与「置信度阈值」过滤（WYSIWYG：
  // 复制全部 / 导出文本 / 贴回标注 都用这个可见集合，所见即所得）。
  // 置信度=0 视为未知、永远通过；阈值=0 表示不过滤。仅对提供置信度的平台有意义。
  const ocrVisibleLines = useCallback((): { b: OcrBlock; i: number }[] => {
    if (!ocrResult) return [];
    const q = ocrSearch.trim().toLowerCase();
    const pass = (conf: number) => ocrConf <= 0 || conf <= 0 || conf * 100 >= ocrConf;
    // 阅读顺序：'reading' 时按块坐标重排（多列/竖排）；'none' 保留系统原始读序。
    // 重排只改变「遍历顺序」，i 仍是原始块下标，编辑映射（ocrEdits）不受破坏。
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

  // 纳入「复制/导出/贴回」的集合：在 ocrVisibleLines（搜索+置信度过滤）之上叠加逐行勾选。
  // - 未勾选任何行（ocrSel 全空）→ 取全部可见行（历史行为，零回归）；
  // - 有可见行被勾选 → 仅取勾选的可见行（精准提取，适合表单/表格/部分内容）。
  // 隐藏行（被搜索/置信度过滤掉）即使曾勾选也不计入，避免带上不可见数据。
  const ocrIncludedLines = useCallback((): { b: OcrBlock; i: number }[] => {
    const vis = ocrVisibleLines();
    const anySel = vis.some(({ i }) => ocrSel[i]);
    if (!anySel) return vis;
    return vis.filter(({ i }) => ocrSel[i]);
  }, [ocrVisibleLines, ocrSel]);

  // 严格「已勾选/框选」的集合（仅 ocrSel 选中的可见行）。
  // 与 ocrIncludedLines 的区别：无任何选择时返回空（而非退回全部可见行），
  // 用于「选区→标注」类操作（打码/高亮/箭头），避免无选择时误伤整图。
  const ocrSelectedBlocks = useCallback((): { b: OcrBlock; i: number }[] => {
    const vis = ocrVisibleLines();
    const anySel = vis.some(({ i }) => ocrSel[i]);
    if (!anySel) return [];
    return vis.filter(({ i }) => ocrSel[i]);
  }, [ocrVisibleLines, ocrSel]);

  // 语言切换：更新选择；非 macOS 下语言强制生效，切换即重识别（即时反馈），
  // macOS 走系统自动、忽略 lang，故不重跑（避免无谓等待）。
  const handleLangChange = (v: string) => {
    setOcrLang(v);
    if (platform !== '' && platform !== 'macos' && current && !ocrBusy) {
      runOcr(current.dataUrl, v === 'auto' ? null : v);
    }
  };

  // 导出 OCR 文本：用可见集合（过滤后）组装，尊重「合并为一行」格式，落盘为 .txt/.md。
  // 组装导出内容：尊重「搜索/置信度/阅读顺序」的可见集合（WYSIWYG）。
  // txt/md 用文字（受「合并为一行」影响）；json/tsv 带归一化坐标（x,y,w,h,confidence），供下游处理。
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
    const body = ocrClean ? ocrCleanText(bodyRaw) : bodyRaw;
    return fmt === 'md' ? `# SnapCraft OCR\n\n${body}\n` : body;
  };

  const handleExportOcr = async () => {
    const fmt = ocrExportFmt;
    const lines = ocrIncludedLines();
    if (lines.length === 0) {
      flash(t('ocr.exportEmpty'), 'error');
      return;
    }
    const content = buildOcrExportContent(fmt);
    if (!content.trim()) {
      flash(t('ocr.exportEmpty'), 'error');
      return;
    }
    const ext = fmt === 'txt' ? 'txt' : fmt === 'md' ? 'md' : fmt === 'json' ? 'json' : 'tsv';
    const name = fmt === 'txt' ? 'Text' : fmt === 'md' ? 'Markdown' : fmt === 'json' ? 'JSON' : 'TSV';
    const path = await save({
      defaultPath: `snapcraft-ocr-${Date.now()}.${ext}`,
      filters: [{ name, extensions: [ext] }],
    });
    if (!path) return;
    try {
      await invoke('save_text_file', { content, filePath: path });
      flash(t('ocr.exported', { path }), 'success');
    } catch (e) {
      flash(t('ocr.exportFailed', { msg: String(e) }), 'error');
    }
  };

  const handleOcr = () => {
    if (!current) return;
    runOcr(current.dataUrl);
  };

  // 结果条/历史网格「取字」：开独立编辑窗并自动跑 OCR（与剪贴板图片模式一致的一键体验），
  // 不再走 in-page 编辑视图（openEditor + runOcr），统一为独立 WebviewWindow。
  const startOcrFromShot = (shot: { id: string; dataUrl: string; width: number; height: number }) => {
    if (!shot?.dataUrl) return;
    if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current);
    setLastShot(null);
    openEditorWindow({ id: shot.id, width: shot.width, height: shot.height, autoOcr: true });
  };

  // 取系统剪贴板中图片的像素尺寸（前端解码，仅用于编辑器坐标映射/预览，不依赖后端）。
  const getImageDims = (dataUrl: string): Promise<{ w: number; h: number }> =>
    new Promise((res) => {
      const img = new Image();
      img.onload = () => res({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
      img.onerror = () => res({ w: 0, h: 0 });
      img.src = dataUrl;
    });

  // 把剪贴板里的纯文字渲染成一张「文字卡片」data URL，作为编辑器 current 的占位源，
  // 使「从剪贴板取字（文字模式）」能复用现有取字面板（复制/导出/搜索/合并/重新识别），无需另建视图。
  // 卡片自带浅色背景，明暗主题下均清晰可读；超长文本只渲染前若干行并标注总行数（原型内容仍完整进 ocrResult）。
  const makeTextCardDataUrl = (text: string): Promise<string> =>
    new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve('');
        return;
      }
      const W = 920;
      const pad = 44;
      const fontSize = 20;
      const lineH = 30;
      const maxW = W - pad * 2;
      const font = `${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif`;
      ctx.font = font;

      // 先按已有换行切分，再对超宽行逐字自动折行
      const lines: string[] = [];
      for (const para of text.split(/\n/)) {
        if (para === '') {
          lines.push('');
          continue;
        }
        let cur = '';
        for (const ch of para) {
          const test = cur + ch;
          if (ctx.measureText(test).width > maxW && cur) {
            lines.push(cur);
            cur = ch;
          } else {
            cur = test;
          }
        }
        if (cur) lines.push(cur);
      }

      // 卡片只渲染前 MAX_LINES 行，避免超长文本生成巨型画布（完整文字仍在 ocrResult）。
      const MAX_LINES = 240;
      const over = lines.length > MAX_LINES;
      const shown = over
        ? [...lines.slice(0, MAX_LINES), `…（共 ${lines.length} 行）`]
        : lines;
      const H = Math.max(360, shown.length * lineH + pad * 2);
      canvas.width = W;
      canvas.height = H;

      // 重设尺寸后字体被重置，需重新设置
      ctx.font = font;
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#f4f4f7';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#c7c7d1';
      ctx.fillRect(0, 0, 6, H); // 左侧装饰条
      ctx.fillStyle = '#1d1d1f';
      for (let i = 0; i < shown.length; i++) {
        ctx.fillText(shown[i], pad, pad + i * lineH);
      }
      resolve(canvas.toDataURL('image/png'));
    });

  // 从系统剪贴板取字：覆盖「剪贴板里有什么就处理什么」——
  //   1) 优先探测文字（read_clipboard_text）：有文字直接当取字结果（最贴合「取字」语义，无需 OCR）；
  //   2) 否则读图片（read_clipboard_image）并 OCR；
  //   3) 文字图片皆无 → 中性提示（info），不再把「空」当错误。
  // 这是继「截图取字」「结果条取字」「历史网格取字」之外的第四个入口，
  // 不读取屏幕、不触碰截图/历史/标注等任何其它功能。
  // 生产级加固（相对初版）：
  //  - 文字优先：先 read_clipboard_text，有文字直接当取字结果（最贴合「取字」语义，无需 OCR）；
  //  - 飞行中锁（ocrClipBusyRef）防重入：读取+解码+识别期间连点只算一次；
  //  - 错误分级：图片路径沿用后端 ERR_* 令牌；文字/图片皆无 → info 中性提示，不再当 error；
  //  - 尺寸守卫：文字卡片/图片解码尺寸为 0 时仍进面板（OCR 不依赖 dims），贴回标注自防御跳过防 NaN。
  const startOcrFromClipboard = async () => {
    if (ocrClipBusyRef.current || ocrBusy) return; // 防重入
    ocrClipBusyRef.current = true;
    setOcrClipBusy(true);
    try {
      // 1) 先探测剪贴板里的「文字」：文字型剪贴板直接作为取字结果，无需 OCR。
      let text: string | null = null;
      try {
        const t = await invoke<string>('read_clipboard_text');
        if (t && t.trim().length > 0) text = t;
      } catch {
        // ERR_EMPTY 等：无文字，继续尝试图片路径
      }

      if (text) {
        try {
          // 文字模式：渲染成文字卡片占位图，复用取字面板（复制/导出/搜索/合并/重新识别）。
          const card = await makeTextCardDataUrl(text);
          const dim = await getImageDims(card);
          setCurrentScreenshot(null); // 非本机历史条目，避免误用历史 id
          setCurrent({ dataUrl: card, width: dim.w || 920, height: dim.h || 360 });
          setCurrentView('edit');
          // 与 runOcr 对齐：重置上一次识别遗留的视图状态（搜索/勾选/框选/修正），避免把文字误隐藏。
          setOcrEdits({});
          setOcrSearch('');
          setOcrConf(0);
          setOcrSel({});
          setOcrRegionPick(false);
          setOcrDrag(null);
          // 合成单块 OcrResult：整段文字作为一块（全幅 bbox），复制/导出/搜索均正常。
          setOcrResult({ text, blocks: [{ text, x: 0, y: 0, w: 1, h: 1, confidence: 1 }] });
          setOcrLastImage(card);
          setOcrSourceKind('text'); // 来自剪贴板纯文字：无真实原图，禁用「重新识别/贴回标注」
          flash(t('ocr.clipTextMode'), 'success');
        } catch {
          // 文字已成功读取，仅「渲染成卡片」失败（极罕见，如画布不可用）→
          // 用精准文案而非误导性的「读取剪贴板失败」。
          flash(t('ocr.clipTextRenderFailed'), 'error');
        }
        return;
      }

      // 2) 图片路径：读取剪贴板图片并 OCR（保留原逻辑）。
      const dataUrl = await invoke<string>('read_clipboard_image');
      if (!dataUrl || !dataUrl.startsWith('data:image')) {
        // 既不是图片也不是文字 → 中性提示，不再是 error
        flash(t('ocr.clipEmptyNeutral'), 'info');
        return;
      }
      // 进编辑器并跑 OCR。
      // getImageDims 永不 reject（解码失败按 {0,0} 处理）；runOcr 内部已兜底所有识别错误。
      const dim = await getImageDims(dataUrl);
      // 连续性增强：剪贴板图片与「本机截图」同等待遇——进历史网格（可重开/钉住/删除/保存），
      // 并写入真实 currentScreenshot，使编辑器顶部「钉图」与 ⌘S 保存对齐到该条目（不再孤儿）。
      // 来源标记为 clipboard，历史网格显示低调角标，与截图条目区分而不污染。
      const cid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const cAt = new Date().toISOString();
      const entry: HistoryEntry = {
        id: cid,
        dataUrl,
        createdAt: cAt,
        width: dim.w,
        height: dim.h,
        source: 'clipboard',
      };
      setHistory((h) => [entry, ...h]);
      try {
        await invoke('add_history', {
          item: {
            id: cid,
            data_url: dataUrl,
            created_at: cAt,
            width: dim.w,
            height: dim.h,
            source: 'clipboard',
          },
        });
      } catch {
        /* 持久化失败不阻断使用 */
      }
      setCurrent({ dataUrl, width: dim.w, height: dim.h });
      setCurrentScreenshot({
        id: cid,
        filePath: '',
        dataUrl,
        width: dim.w,
        height: dim.h,
        annotations: [],
        layers: [],
        createdAt: cAt,
        updatedAt: cAt,
      });
      setCurrentView('edit');
      await runOcr(dataUrl);
    } catch (e) {
      const msg = String(e);
      // 生产级防御：即便后端（旧版/异常）泄漏 arboard 原始报错
      // （如 "The clipboard contents were not available in the requested format..."），
      // 也绝不透传给用户，统一降级为中性「剪贴板为空」提示——这是修复
      // 「读取剪贴板失败：读取剪贴板文件失败: ...」报错的展示层兜底。
      const isArboardRaw =
        /not available in the requested format|clipboard contents were not available|was not available|读取剪贴板文件失败/i.test(
          msg,
        );
      if (isArboardRaw) {
        flash(t('ocr.clipEmptyNeutral'), 'info');
      } else if (msg.includes('ERR_EMPTY')) {
        flash(t('ocr.clipEmptyNeutral'), 'info');
      } else if (msg.includes('ERR_TEXT_NOT_IMAGE')) {
        // 极少：文字探测为空但图片路径又看到纯文字（如仅空白文字）→ 中性引导
        flash(t('ocr.clipTextOnly'), 'info');
      } else if (msg.includes('ERR_NO_IMG_FILE')) {
        flash(t('ocr.clipNoImgFile'), 'error');
      } else if (msg.includes('ERR_BAD_IMG_FILE')) {
        flash(t('ocr.clipBadImgFile'), 'error');
      } else if (msg.includes('ERR_ZERO_SIZE')) {
        flash(t('ocr.clipZero'), 'error');
      } else if (msg.includes('没有图片') || /no image/i.test(msg)) {
        // 兜底：兼容旧版后端文案 / 英文环境
        flash(t('ocr.clipEmptyNeutral'), 'info');
      } else {
        flash(t('ocr.clipFailed', { msg }), 'error');
      }
    } finally {
      // 生产级关键保证：无论成功 / 读取失败 / 任何意外异常，必解锁按钮，
      // 杜绝「读取中…」永久卡死导致该功能彻底不可用。
      ocrClipBusyRef.current = false;
      setOcrClipBusy(false);
    }
  };

  // OCR 选区：进入框选模式，用户拖拽后由 Canvas 裁图回调本函数
  const onRegionOcr = (dataUrl: string) => {
    setOcrRegionMode(false);
    runOcr(dataUrl);
  };

  // 识别结果一键「作为文字标注贴回截图」：
  // 把每个文字块映射成可编辑文字标注（归一化坐标→图内像素 + 按块高设字号），
  // 复用当前字体/颜色/背景样式默认值，与刚做好的文字编辑体系打通。
  const applyOcrAsAnnotations = () => {
    if (!ocrResult || !current) return;
    const W = current.width;
    const H = current.height;
    // 尺寸守卫：剪贴板图片若未能取得有效像素尺寸（极端情况），坐标映射会算出 NaN/0，
    // 跳过贴回并提示，避免污染截图。纯防御性逻辑，正常截图/剪贴板图不会触发。
    if (!W || !H || W <= 0 || H <= 0) {
      flash(t('ocr.appliedZero'), 'error');
      return;
    }
    let n = 0;
    // 只贴回「纳入集合」（搜索/置信度过滤后，且被勾选的可见行），被隐藏的低置信行与未勾选行不进入截图。
    ocrIncludedLines().forEach(({ b, i }) => {
      const t = (ocrTextAt(i, b) || '').trim();
      if (!t) return;
      const px = Math.max(0, Math.round(b.x * W));
      const py = Math.max(0, Math.round(b.y * H));
      const fs = Math.min(240, Math.max(10, Math.round(b.h * H)));
      addAnnotation({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        geometry: {
          type: 'text',
          points: [{ x: px, y: py }],
          text: t,
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
      n += 1;
    });
    setOcrResult(null);
    if (n > 0) flash(t('ocr.applied', { n }), 'success');
  };

  // 选区→标注（打码 / 高亮 / 箭头）：把当前勾选/框选的文字块转成对应标注。
  // 复用 addAnnotation + flashRegion（与 AI 智能编辑同源），零 Rust、零新依赖。
  // 必须先有选区，否则提示「请先选择」，避免无选择时整图被打码（选区/划词语义）。
  const redactOcrSel = () => {
    if (!ocrResult || !current) return;
    const sel = ocrSelectedBlocks();
    if (!sel.length) { flash(t('ocr.selNeeded'), 'error'); return; }
    const W = current.width, H = current.height;
    if (!W || !H || W <= 0 || H <= 0) { flash(t('ocr.appliedZero'), 'error'); return; }
    let n = 0;
    sel.forEach(({ b }) => {
      const x = Math.max(0, Math.round(b.x * W));
      const y = Math.max(0, Math.round(b.y * H));
      const w = Math.max(1, Math.round(b.w * W));
      const h = Math.max(1, Math.round(b.h * H));
      addAnnotation({
        id: genAnnoId(),
        geometry: { type: 'mosaic', points: [{ x, y }, { x: x + w, y: y + h }], maskMode: 'brush', solid: true, brushSize: Math.max(8, Math.round(w / 2)), blur: false, strength: 12 },
        layerId: 'default',
        color: currentColor,
        lineWidth: currentStrokeWidth,
        opacity: 1,
        properties: {},
      });
      canvasRef.current?.flashRegion({ x, y, w, h }, undefined, 'redact');
      n += 1;
    });
    if (n > 0) flash(t('ocr.redacted', { n }), 'success');
  };

  const highlightOcrSel = () => {
    if (!ocrResult || !current) return;
    const sel = ocrSelectedBlocks();
    if (!sel.length) { flash(t('ocr.selNeeded'), 'error'); return; }
    const W = current.width, H = current.height;
    if (!W || !H || W <= 0 || H <= 0) { flash(t('ocr.appliedZero'), 'error'); return; }
    let n = 0;
    const hl = '#FFE600';
    sel.forEach(({ b }) => {
      const x = Math.max(0, Math.round(b.x * W));
      const y = Math.max(0, Math.round(b.y * H));
      const w = Math.max(1, Math.round(b.w * W));
      const h = Math.max(1, Math.round(b.h * H));
      addAnnotation({
        id: genAnnoId(),
        geometry: { type: 'highlight', points: [{ x, y }, { x: x + w, y: y + h }] },
        layerId: 'default',
        color: hl,
        lineWidth: currentStrokeWidth,
        opacity: 0.45,
        properties: {},
      });
      canvasRef.current?.flashRegion({ x, y, w, h }, hl, 'highlight');
      n += 1;
    });
    if (n > 0) flash(t('ocr.highlighted', { n }), 'success');
  };

  // 箭头从左侧外缘指向选中块合并外接框的中心（视线引导）；多块时取整体包围盒。
  const arrowOcrSel = () => {
    if (!ocrResult || !current) return;
    const sel = ocrSelectedBlocks();
    if (!sel.length) { flash(t('ocr.selNeeded'), 'error'); return; }
    const W = current.width, H = current.height;
    if (!W || !H || W <= 0 || H <= 0) { flash(t('ocr.appliedZero'), 'error'); return; }
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    sel.forEach(({ b }) => {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    });
    const tx = ((minX + maxX) / 2) * W;
    const ty = ((minY + maxY) / 2) * H;
    const fx = Math.max(0, minX - 0.12) * W;
    const fy = ty;
    addAnnotation({
      id: genAnnoId(),
      geometry: { type: 'arrow', points: [{ x: fx, y: fy }, { x: tx, y: ty }] },
      layerId: 'default',
      color: '#0a84ff',
      lineWidth: currentStrokeWidth,
      opacity: 1,
      properties: {},
    });
    canvasRef.current?.flashRegion({ x: minX * W, y: minY * H, w: (maxX - minX) * W, h: (maxY - minY) * H }, '#0a84ff', 'arrow');
    flash(t('ocr.arrowed', { n: sel.length }), 'success');
  };

  // AI 文案 → 截图标注回写：把 AI 生成的纯文本作为可编辑文字标注贴回当前截图，
  // 闭环「截图 → 编辑 → AI → 结果落到图上 → 再导出」。默认左上角、半透明底衬保证可读。
  const applyAiToScreenshot = (text: string) => {
    if (!current) return;
    const W = current.width;
    const H = current.height;
    if (!W || !H || W <= 0 || H <= 0) {
      flash(t('ai.applyZero'), 'error');
      return;
    }
    const clean = (text || '').trim();
    if (!clean) return;
    const fs = Math.max(14, Math.min(24, Math.round(W / 40)));
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
  };

  // 将画布（底图 + 最新标注）合成为一张图，作为 AI 看到的视觉内容；
  // 同时让 OCR 文字也跟随「编辑后截图」——打码/模糊区域的文字不再经 OCR 上下文泄漏给模型（候选④）。
  // 任一环节失败都回退到原图 + 原 OCR，保证 AI 始终有图/有文字可看，不影响其它功能。
  const refreshAiVision = useCallback(async () => {
    const fallback = current?.dataUrl ?? '';
    const rawOcr = ocrResultRef.current?.text ?? '';
    try {
      const merged = canvasRef.current ? await canvasRef.current.getMergedImageDataUrl() : null;
      const visionUrl = merged || fallback;
      setAiVisionUrl(visionUrl);
      // 仅当真正合成了「编辑后图」（与原图不同）才重跑 OCR；否则沿用原 OCR，避免无谓耗时。
      if (merged && merged !== fallback) {
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
  }, [current?.dataUrl, ocrLang]);

  // AI 打码产物提示 / 固化相关 ref（增强）：debounce 计数 + 稳定持有 flash 与 annotations 最新值
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const redactCountRef = useRef(0);
  const redactTimerRef = useRef<number | null>(null);
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;

  // ── Phase 14：AI 智能编辑「工具宿主」──
  // 把模型给出的归一化区域(0~1)换算为原图像素，并经既有 store.addAnnotation 写入标注
  // （与用户手动标注同路、自动入撤销历史）；summarize_region 裁剪区域后走 ocr_image。
  // 供 AIPanel 的 AI Agent 工具循环直接操作当前截图（零新画布交互层、零 Rust）。
  //
  // Phase 19-B1：画笔/字号/字体等 UI 快照用 ref 隔离，避免 aiTools 引用因用户切颜色反复重建
  // → 从而避免下游 AIPanel useEffect 依赖 aiTools 时被误触发（例如 refreshAiVision 循环）。
  const currentColorRef = useRef(currentColor);
  const currentStrokeWidthRef = useRef(currentStrokeWidth);
  const currentFontFamilyRef = useRef(currentFontFamily);
  useEffect(() => { currentColorRef.current = currentColor; }, [currentColor]);
  useEffect(() => { currentStrokeWidthRef.current = currentStrokeWidth; }, [currentStrokeWidth]);
  useEffect(() => { currentFontFamilyRef.current = currentFontFamily; }, [currentFontFamily]);
  const aiTools: AiToolHost = useMemo(
    () => ({
      getImageSize: () =>
        current?.width && current?.height ? { width: current.width, height: current.height } : null,
      drawRectangle: (r, opts) => {
        const W = current?.width ?? 0;
        const H = current?.height ?? 0;
        if (!W || !H) return '(无图)';
        const { x, y, w, h } = normToPx(r, W, H);
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
              fontSize: Math.max(12, Math.round(H / 45)),
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
        const W = current?.width ?? 0;
        const H = current?.height ?? 0;
        if (!W || !H) return '(无图)';
        const { x, y, w, h } = normToPx(r, W, H);
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
          // 涂黑会变成红块/异色块——这是「一键打码满屏红」的根因）。mosaic/blur 走像素底图，color 无关。
          color: mode === 'black' ? '#000000' : currentColor,
          lineWidth: currentStrokeWidthRef.current,
          opacity: 1,
          properties: {},
        });
        canvasRef.current?.flashRegion({ x, y, w, h }, undefined, 'redact');
        // 主窗口产物提示（增强）：debounce 合并哨兵多区域，避免刷屏；仅打码类提示
        redactCountRef.current += 1;
        if (redactTimerRef.current) window.clearTimeout(redactTimerRef.current);
        redactTimerRef.current = window.setTimeout(() => {
          const n = redactCountRef.current;
          redactCountRef.current = 0;
          flashRef.current?.(`已打码 ${n} 处，可保存 / 复制`, 'success');
        }, 700);
        return `(${x},${y})-(${x + w},${y + h})`;
      },
      highlightRect: (r, color) => {
        const W = current?.width ?? 0;
        const H = current?.height ?? 0;
        if (!W || !H) return '(无图)';
        const { x, y, w, h } = normToPx(r, W, H);
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
        const W = current?.width ?? 0;
        const H = current?.height ?? 0;
        if (!W || !H) return '(无图)';
        const fx = clamp01(from.x) * W;
        const fy = clamp01(from.y) * H;
        const tx = clamp01(to.x) * W;
        const ty = clamp01(to.y) * H;
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
              fontSize: Math.max(12, Math.round(H / 45)),
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
        // 脉冲覆盖整段箭头外接框
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
        const W = current?.width ?? 0;
        const H = current?.height ?? 0;
        if (!W || !H) return '(无图)';
        const ax = clamp01(anchor.x) * W;
        const ay = clamp01(anchor.y) * H;
        const lx = clamp01(label.x) * W;
        const ly = clamp01(label.y) * H;
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
        const W = current?.width ?? 0;
        const H = current?.height ?? 0;
        if (!W || !H) return '(无图)';
        const { x, y, w, h } = normToPx(r, W, H);
        const crop = await cropDataUrl(current?.dataUrl ?? '', x, y, Math.max(1, w), Math.max(1, h));
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
    [current, addAnnotation, ocrLang],
  );

  // 固化 AI 编辑产物：把「原图 + 全部标注」合成图烧录为当前截图（产物即当前图，可继续编辑/导出），
  // 并清空标注层（避免与已烧录内容重复绘制，且重置撤销栈）。仅在确有标注时执行，纯文本轮不误触发。
  // v4：固化后追加一条独立历史项（source='ai_edit'），关窗重开仍可回看"AI 已编辑"产物，
  // 不再"关闭编辑器再重开 = AI 痕迹全无"。
  const commitAiEdit = useCallback(async () => {
    if (!currentScreenshot || annotationsRef.current.length === 0) return;
    const merged = canvasRef.current ? await canvasRef.current.getMergedImageDataUrl() : null;
    if (!merged) return;
    setCurrentScreenshot({
      ...currentScreenshot,
      dataUrl: merged,
      updatedAt: new Date().toISOString(),
    });
    clearAnnotations();
    flash('已固化编辑产物，可继续编辑或保存', 'success');
    // v4：独立持久化烧录后的合成图作为新历史项
    try {
      const aid = `ai-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const aAt = new Date().toISOString();
      const aW = currentScreenshot.width;
      const aH = currentScreenshot.height;
      const aEntry: HistoryEntry = {
        id: aid,
        dataUrl: merged,
        createdAt: aAt,
        width: aW,
        height: aH,
        source: 'ai_edit',
      };
      setHistory((h) => [aEntry, ...h].slice(0, 100));
      await invoke('add_history', {
        item: {
          id: aid,
          data_url: merged,
          created_at: aAt,
          width: aW,
          height: aH,
          source: 'ai_edit',
        },
      });
    } catch {
      /* 持久化失败不阻断主流程 */
    }
  }, [currentScreenshot, setCurrentScreenshot, clearAnnotations, flash, setHistory]);
  const commitAiEditRef = useRef(commitAiEdit);
  commitAiEditRef.current = commitAiEdit;

  // ── 路径 A：AI 助手独立窗口（UX-first，零新 Rust / 零破坏性） ──
  // 实时快照当前上下文，供 bridge.getCtx 读取「最新值」（避免一次性闭包捕获陈旧 state）。
  const ctxRef = useRef<AiContext | null>(null);
  useEffect(() => {
    ctxRef.current = current
      ? {
          dataUrl: current.dataUrl,
          visionUrl: aiVisionUrl,
          ocrText: aiOcrText,
          width: current.width,
          height: current.height,
        }
      : null;
  });
  // 主窗口侧工具执行器：把 AI 窗口发来的工具调用在本画布真实执行
  // （addAnnotation/flashRegion 在 EnhancedScreenshotApp 的 aiTools 里实现，零新画布交互层）
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
      onCommit: () => commitAiEditRef.current(),
    }).then((h) => {
      handles = h;
    });
    return () => {
      handles?.unlisten.forEach((u) => u());
    };
  }, [execTool]);
  // 用户编辑截图 / 切换截图 / 重识别时，把最新上下文推送给已打开的 AI 窗口
  // （初始上下文由 AI 窗口挂载后主动 request，无需在此触发；避免重复写临时文件）
  useEffect(() => {
    const c = ctxRef.current;
    if (aiOpen && c?.dataUrl) {
      void pushAiContext(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiVisionUrl, aiOcrText, current?.dataUrl]);

  // 切换截图时把 AI 视觉内容重置为原图
  useEffect(() => {
    setAiVisionUrl(current?.dataUrl ?? '');
  }, [current]);
  // 原图 OCR 结果变化时（首次识别/重识别/切换截图），把发给 AI 的 OCR 文字同步为原图 OCR；
  // 用户编辑后由 refreshAiVision 覆盖为「编辑后 OCR」。
  useEffect(() => {
    setAiOcrText(ocrResult?.text ?? '');
  }, [ocrResult]);

  // 预览框「框选范围」：把鼠标事件换算成相对预览包裹层的归一化坐标（0..100）。
  const ocrPct = (e: MouseEvent): { x: number; y: number } => {
    const wrap = ocrWrapRef.current;
    if (!wrap) return { x: 0, y: 0 };
    const r = wrap.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    return { x: Math.min(100, Math.max(0, x)), y: Math.min(100, Math.max(0, y)) };
  };
  // 按下：记录起点；移动：实时更新拖拽矩形；松手：与矩形相交的块进入选择集合（复用 ocrSel 管线）。
  const onPreviewDown = (e: MouseEvent) => {
    if (!ocrRegionPick) return;
    const p = ocrPct(e);
    ocrDragStart.current = p;
    setOcrDrag({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onPreviewMove = (e: MouseEvent) => {
    const s = ocrDragStart.current;
    if (!s) return;
    const p = ocrPct(e);
    setOcrDrag({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    });
  };
  const onPreviewUp = () => {
    const s = ocrDragStart.current;
    const d = ocrDrag;
    ocrDragStart.current = null;
    setOcrDrag(null);
    if (!s || !d || d.w < 2 || d.h < 2) return; // 太小视为取消，不改选择
    if (!ocrResult) return;
    // 矩形（归一化 0..1）与每个块求交，相交即纳入精准提取集合。
    const sel: Record<number, boolean> = {};
    ocrResult.blocks.forEach((b, i) => {
      if (b.x < d.x + d.w && b.x + b.w > d.x && b.y < d.y + d.h && b.y + b.h > d.y) sel[i] = true;
    });
    setOcrSel(sel);
    setOcrRegionPick(false); // 选完自动退出框选，选择保留供复制/导出/贴回
  };
  // 结构化复制：复用既有 buildOcrExportContent，把带坐标的 JSON/TSV 直接写入剪贴板（不落文件）。
  const copyOcrAs = async (fmt: 'json' | 'tsv') => {
    if (ocrIncludedLines().length === 0) {
      flash(t('ocr.exportEmpty'), 'error');
      return;
    }
    const content = buildOcrExportContent(fmt);
    if (!content.trim()) {
      flash(t('ocr.exportEmpty'), 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      flash(t('ocr.copied'), 'success');
    } catch {
      flash(t('ocr.copyFailed'), 'error');
    }
  };

  // 通用：直接对某张图（dataUrl）复制 / 保存，供结果条与历史项复用（不经编辑器）
  const copyDataUrl = useCallback(async (dataUrl: string) => {
    try {
      invoke('diag_log', { msg: `[clip] 前端 copyDataUrl: dataUrl长度=${dataUrl?.length ?? 0} 前缀=${(dataUrl || '').slice(0, 30)}` }).catch(() => {});
      if (!dataUrl || !dataUrl.startsWith('data:image')) {
        flash(t('toast.copyInvalid'), 'error');
        invoke('diag_log', { msg: `[clip] 前端 copyDataUrl 中止：dataUrl 非法` }).catch(() => {});
        return;
      }
      await invoke('copy_to_clipboard', { imageData: dataUrl });
      flash(t('toast.copied'), 'success');
    } catch (e) {
      invoke('diag_log', { msg: `[clip] 前端 copyDataUrl 失败: ${String(e)}` }).catch(() => {});
      flash(t('toast.copyFailed', { msg: String(e) }), 'error');
    }
  }, [flash]);

  const saveDataUrl = useCallback(async (dataUrl: string) => {
    const path = await save({
      defaultPath: `snapcraft-${Date.now()}.png`,
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (!path) return;
    try {
      await invoke('save_screenshot', { imageData: dataUrl, filePath: path });
      setRevealPath(path);
      flash(t('toast.savedWithReveal', { path }), 'success', 5000);
    } catch (e) {
      flash(t('toast.saveFailed', { msg: String(e) }), 'error');
    }
  }, [flash]);

  // 钉图：把某张截图钉在屏幕上——开一个无边框、置顶、可拖动的小浮窗（非全屏遮挡）。
  // 尺寸按图等比缩放并限制最大值，避免 4K 截图铺满屏幕；数据经 id 由钉图窗自行查后端历史。
  const pinShot = useCallback(async (shot: { id: string; dataUrl: string; width: number; height: number }) => {
    const MAX_W = 720;
    const MAX_H = 520;
    const ratio = Math.min(MAX_W / shot.width, MAX_H / shot.height, 1);
    const w = Math.max(80, Math.round(shot.width * ratio));
    const h = Math.max(60, Math.round(shot.height * ratio));
    const label = `pin-${shot.id}`;
    try {
      const existing = await WebviewWindow.getByLabel(label).catch(() => null);
      if (existing) {
        try { await existing.setFocus(); } catch { /* ignore */ }
        return;
      }
      new WebviewWindow(label, {
        title: t('pin.windowTitle'),
        url: `/#pin?id=${encodeURIComponent(shot.id)}`,
        width: w,
        height: h,
        // 稍微偏移，避免总是叠在同一位置
        x: 80 + Math.round(Math.random() * 60),
        y: 80 + Math.round(Math.random() * 60),
        transparent: true,
        decorations: false,
        alwaysOnTop: true,
        resizable: true,
        skipTaskbar: false,
        shadow: true,
      } as any);
      flash(t('toast.pinned'), 'success');
    } catch (e) {
      flash(t('toast.pinFailed', { msg: String(e) }), 'error');
    }
  }, [flash]);

  // 删除单条历史：后端按 id 移除并整体重写 history.json（图内联其中，删条目即删图，无孤儿文件）
  const handleDeleteHistory = async (id: string) => {
    if (!id) return;
    try {
      await invoke('delete_history', { id });
      // 同步清掉前端内存里的对应条目，避免界面残留已删的脏数据
      setHistory((h) => h.filter((x) => x.id !== id));
      // 若被删的正是编辑视图当前引用的那条，连带清空当前态，杜绝脏引用
      if (currentScreenshot?.id === id) {
        setCurrentScreenshot(null);
        setCurrent(null);
        if (currentView === 'edit') setCurrentView('home');
      }
      flash(t('toast.deleted'), 'success');
    } catch (e) {
      flash(t('toast.deleteFailed', { msg: String(e) }), 'error');
    }
  };

  // 清空全部历史：先二次确认，再清后端 + 前端状态，确保彻底清理
  const handleClearHistory = async () => {
    if (!window.confirm(t('history.clearConfirm'))) return;
    try {
      await invoke('clear_history');
      setHistory([]);
      // 彻底清理：清空后不应残留任何已删截图的引用
      setCurrentScreenshot(null);
      setCurrent(null);
      if (currentView === 'edit') setCurrentView('home');
      flash(t('toast.historyCleared'), 'success');
    } catch (e) {
      flash(t('toast.historyClearFailed', { msg: String(e) }), 'error');
    }
  };

  // R4：批量 OCR 多选 + 批量取字
  const toggleSel = (id: string) => {
    setSelIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  const selectAll = () => setSelIds(history.map((h) => h.id));
  const clearSel = () => {
    setSelIds([]);
    setSelMode(false);
    setShowBatch(false);
    setBatchItems([]);
  };
  // 循环对选中截图跑 OCR，按项拆分为结构化数组（每项可独立编辑/复制，为后续 AI 整理/排版铺路）
  const handleBatchOcr = async () => {
    if (selIds.length === 0) return;
    setBatchBusy(true);
    const items: BatchItem[] = [];
    let ok = 0;
    let fail = 0;
    for (const id of selIds) {
      const item = history.find((h) => h.id === id);
      if (!item) continue;
      try {
        const res = await invoke<OcrResult>('ocr_image', {
          imageData: item.dataUrl,
          lang: null,
        });
        const txt = cleanOcrText(res?.text).trim();
        if (txt) {
          items.push({ id, time: new Date(item.createdAt).toLocaleString(), text: txt });
          ok++;
        } else {
          fail++;
        }
      } catch {
        fail++;
      }
    }
    setBatchBusy(false);
    setBatchItems(items);
    setShowBatch(true);
    flash(t('ocr.batchDone', { ok, fail }), fail > 0 && ok === 0 ? 'error' : 'success');
  };

  // Phase 28：批量 Agent 队列 —— 对选中的每张截图跑同一个指令，顺序执行并收集结果。
  // 用 chatOnce（一次性非流式）直接带图调用，不改动共享 AI 会话状态，故批量与单图对话零互相干扰。
  // 进度通过 aiBatchDone/aiBatchTotal 实时反馈；结果汇入 aiBatchItems，可复制 / 导出 md / docx。
  const handleBatchAi = async () => {
    if (selIds.length === 0) return;
    const prompt = aiPrompt.trim();
    if (!prompt) { flash(t('ocr.batchAiPromptNeeded'), 'error'); return; }
    const cfg = useAiStore.getState().config;
    if (!cfg || !cfg.apiKey) { flash(t('ocr.batchAiNoKey'), 'error'); return; }
    setAiBatchBusy(true);
    setAiBatchTotal(selIds.length);
    setAiBatchDone(0);
    setShowAiBatch(true);
    setAiBatchItems([]);
    const items: AiBatchItem[] = [];
    let ok = 0;
    let fail = 0;
    for (let idx = 0; idx < selIds.length; idx++) {
      const id = selIds[idx];
      const item = history.find((h) => h.id === id);
      if (!item) { fail++; setAiBatchDone(idx + 1); continue; }
      const time = new Date(item.createdAt).toLocaleString();
      try {
        const text = await chatOnce({
          config: cfg,
          messages: [
            // v14 修复：原 t('ocr.batchAiSystem') 键缺失，批量 AI 实际收到字面量 "ocr.batchAiSystem" 作系统指令。
            // 系统指令应是指令常量而非 UI 翻译键；模型据下方 user 指令的语言回复。
            { role: 'system', content: 'You are the SnapCraft screenshot assistant. The user provides a screenshot and an instruction; follow the instruction to process the screenshot (recognize, summarize, translate, extract information, or generate a document) and reply in the same language as the instruction. Output only the result, do not repeat the instruction.' },
            { role: 'user', content: prompt, imageDataUrl: item.dataUrl },
          ],
        });
        const txt = (text || '').trim();
        items.push({ id, time, text: txt || t('ocr.batchAiEmpty') });
        if (txt) ok++; else fail++;
      } catch (e: any) {
        items.push({ id, time, text: '', error: e?.message || String(e) });
        fail++;
      }
      setAiBatchItems([...items]);
      setAiBatchDone(idx + 1);
    }
    setAiBatchBusy(false);
    flash(t('ocr.batchAiDone', { ok, fail }), fail > 0 && ok === 0 ? 'error' : 'success');
  };

  const cycleTheme = () =>
    setTheme((t) => (t === 'light' ? 'dark' : t === 'dark' ? 'system' : 'light'));
  const themeIcon = theme === 'light' ? '☀️' : theme === 'dark' ? '🌙' : '🖥️';
  const themeLabel = theme === 'light' ? t('theme.light') : theme === 'dark' ? t('theme.dark') : t('theme.system');

  const openHistory = (h: HistoryEntry) => {
    setCurrent({ dataUrl: h.dataUrl, width: h.width, height: h.height });
    setCurrentScreenshot({
      id: h.id,
      filePath: '',
      dataUrl: h.dataUrl,
      width: h.width,
      height: h.height,
      annotations: [],
      layers: [],
      createdAt: h.createdAt,
      updatedAt: h.createdAt,
    });
    clearAnnotations();
    setCurrentView('edit');
  };

  // ===== 编辑视图：⌘/Ctrl+S 保存、⌘/Ctrl+C 复制 =====
  useEffect(() => {
    if (currentView !== 'edit') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        // 只在没有选中文本时拦截，避免影响正常文本复制
        const sel = window.getSelection();
        if (!sel || sel.toString().length === 0) {
          e.preventDefault();
          handleCopy();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentView, current, annotations]);

  // ===== 编辑视图 =====
  if (currentView === 'edit' && current) {
    // OCR 面板辅助计算：可见集合（搜索 + 置信度过滤）、纳入集合（可见 + 逐行勾选）、显示文字、命中数、被隐藏行数
    const ocrVis = ocrVisibleLines();
    const ocrInc = ocrIncludedLines();
    const q0 = ocrSearch.trim().toLowerCase();
    const _ocrRawDisplay = ocrInc.map(({ b, i }) => ocrTextAt(i, b)).join(ocrMerge ? ' ' : '\n');
    const ocrDisplayText = ocrClean ? ocrCleanText(_ocrRawDisplay) : _ocrRawDisplay;
    // 全文命中总数（搜索词在纳入集合文本中的出现次数，大小写不敏感），供「上一处/下一处」定位。
    const ocrLT = ocrDisplayText.toLowerCase();
    let ocrMatchTotal = 0;
    if (q0) {
      let mi = 0;
      let at = ocrLT.indexOf(q0, mi);
      while (at >= 0) {
        ocrMatchTotal += 1;
        mi = at + q0.length;
        at = ocrLT.indexOf(q0, mi);
      }
    }
    const ocrShown = ocrVis.length;
    const ocrTotal = ocrResult ? ocrResult.blocks.length : 0;
    const ocrHiddenByConf = ocrResult
      ? ocrResult.blocks.filter((b) => ocrConf > 0 && b.confidence > 0 && b.confidence * 100 < ocrConf).length
      : 0;
    // 是否有任意块提供置信度（macOS Vision 有；Windows WinRT 无 → 不显示阈值控件）
    const ocrHasConf = ocrResult ? ocrResult.blocks.some((b) => b.confidence > 0) : false;
    // 当前纳入集合的字符数（受搜索/置信度/勾选影响），用于面板统计与「复制全部」。
    const ocrChars = ocrDisplayText.length;
    // 是否有可见行被勾选（决定是否启用「精准提取」语义）。
    const ocrSelActive = ocrVis.some(({ i }) => ocrSel[i]);
    // 可见集合的原始块下标集合：供缩略图边界框判断是否被搜索/置信度过滤隐藏（隐藏框淡化显示）。
    const ocrVisSet = new Set(ocrVis.map((x) => x.i));
    // 智能实体提取（URL/邮箱/电话）：仅当开启提取开关时计算，纯前端辅助视图，
    // 不进入复制/导出/贴回数据链；提取自当前可见/纳入集合文字（WYSIWYG）。关闭时返回 null = 零渲染。
    const ocrEnt = ocrExtract ? ocrExtractEntities(ocrDisplayText) : null;
    // 点击缩略图某块框 → 高亮对应列表行并滚动其进入可视区域（双向联动的一部分）。
    const focusOcrLine = (i: number) => {
      setOcrHoverLine(i);
      try {
        const el = document.querySelector(`[data-ocr-idx="${i}"]`);
        el?.scrollIntoView({ block: 'nearest' });
      } catch {
        /* 该行被过滤隐藏时找不到元素，忽略 */
      }
    };
    return (
      <div className="editor-view">
        <div className="editor-toolbar">
          <div className="toolbar-left">
            <button
              className="tbar-btn tbar-ghost back-btn"
              onClick={() => {
                setCurrent(null);
                setCurrentView('home');
              }}
            >
              <TBIcon d={TB_PATHS.back} />
              {t('editor.back')}
            </button>
            <div className="editor-info">
              <span className="editor-info-dim">{current.width} × {current.height}</span>
              <span className="editor-info-sep">·</span>
              <span>{t('editor.annotations', { n: annotations.length })}</span>
            </div>
          </div>
          <AnnotationToolbar />
          <div className="toolbar-right">
            <button className="tbar-icon-btn" title={t('editor.themeTitle', { label: themeLabel })} onClick={cycleTheme}>
              {themeIcon}
            </button>
            <div className="tbar-divider" />
            <button
              className="tbar-btn tbar-ghost"
              onClick={handleOcr}
              disabled={ocrBusy || ocrRegionMode}
              title={t('editor.ocrTitle')}
            >
              <TBIcon d={TB_PATHS.ocr} />
              {ocrBusy ? t('editor.ocrBusy') : t('editor.ocr')}
            </button>
            <button
              className={`tbar-btn tbar-ghost${ocrRegionMode ? ' active' : ''}`}
              onClick={() => setOcrRegionMode((v) => !v)}
              disabled={ocrBusy}
              title={t('ocr.regionTitle')}
            >
              <TBIcon d={TB_PATHS.ocr} />
              {t('ocr.region')}
            </button>
            <button
              className="tbar-btn tbar-ghost"
              onClick={() => openClipboardOcrWindow()}
              disabled={ocrBusy}
              title={t('ocr.clipTitle')}
            >
              📋 {t('ocr.clipboard')}
            </button>
            <button
              className={`tbar-btn tbar-ghost${aiOpen ? ' active' : ''}`}
              onClick={async () => {
                const w = await openAiWindow(ctxRef.current);
                if (w) setAiOpen(true);
              }}
              disabled={!current}
              title={t('ai.openAi')}
            >
              ✨ AI
            </button>
            <button className="tbar-btn tbar-ghost" onClick={handleCopy} title={t('editor.copyTitle', { mod: modLabel })}>
              <TBIcon d={TB_PATHS.copy} />
              {t('editor.copy')}
            </button>
            {currentScreenshot && (
              <button
                className="tbar-btn tbar-ghost"
                onClick={() => pinShot({ id: currentScreenshot.id, dataUrl: current.dataUrl, width: current.width, height: current.height })}
                title={t('editor.pinTitle')}
              >
                <TBIcon d={TB_PATHS.pin} />
                {t('editor.pin')}
              </button>
            )}
            <button className="tbar-btn tbar-primary save-btn" onClick={handleSave} title={t('editor.saveTitle', { mod: modLabel })}>
              <TBIcon d={TB_PATHS.save} />
              {t('editor.save')}
            </button>
          </div>
        </div>
        <div className="editor-canvas-area">
          <div className="editor-canvas">
            <AnnotationCanvas
              ref={canvasRef}
              imageData={current.dataUrl}
              annotations={annotations}
              onAnnotationAdd={addAnnotation}
              activeTool={activeTool}
              onCropped={onCropped}
              ocrRegionMode={ocrRegionMode}
              onRegionOcr={onRegionOcr}
            />
            {ocrRegionMode && (
              <div className="ocr-region-hint">
                <span>{t('ocr.regionHint')}</span>
                <button className="tbar-btn tbar-ghost" onClick={() => setOcrRegionMode(false)}>
                  {t('ocr.regionCancel')}
                </button>
              </div>
            )}
          </div>
        </div>
        {toast && (
          <div className={`toast toast-${toastType}`}>
            <span className="toast-icon">{toastType === 'error' ? '!' : toastType === 'info' ? 'ℹ' : '✓'}</span>
            <span className="toast-msg">{toast}</span>
            {revealPath && (
              <button
                className="toast-reveal-btn"
                onClick={() => invoke('reveal_in_folder', { path: revealPath })}
                title={t('toast.revealTitle')}
              >
                {t('toast.reveal')}
              </button>
            )}
          </div>
        )}
        {ocrResult !== null && (
          <div className="ocr-panel-mask" onClick={() => setOcrResult(null)}>
            <div
              className="ocr-panel"
              style={{ ['--ocr-fs' as any]: `${ocrFontSize}px` }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="ocr-panel-head">
                <span className="ocr-panel-title">
                  <TBIcon d={TB_PATHS.ocr} />
                  {t('ocr.title')}
                  {ocrResult.blocks.length > 0 && (
                    <span className="ocr-panel-count">{ocrResult.blocks.length}</span>
                  )}
                </span>
                {/* 语言提示：auto=系统自动（macOS 走自动，仅 Windows 强制生效）；
                    非 macOS 切换即重识别（handleLangChange 内即时触发） */}
                <select
                  className="ocr-lang"
                  value={ocrLang}
                  onChange={(e) => handleLangChange(e.target.value)}
                  title={t('ocr.langTitle')}
                >
                  <option value="auto">{t('ocr.langAuto')}</option>
                  <option value="zh-Hans">{t('ocr.langZh')}</option>
                  <option value="en-US">{t('ocr.langEn')}</option>
                  <option value="ja-JP">{t('ocr.langJa')}</option>
                </select>
                <button
                  className={`ocr-panel-hist${ocrHistoryOpen ? ' active' : ''}`}
                  onClick={() => setOcrHistoryOpen((v) => !v)}
                  title={t('ocr.historyTitle')}
                >
                  {t('ocr.history')}
                  {ocrHistory.length > 0 && (
                    <span className="ocr-hist-count">{ocrHistory.length}</span>
                  )}
                </button>
                <span className="ocr-fs">
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
                </span>
                <button
                  className={`ocr-panel-toggle${ocrClean ? ' active' : ''}`}
                  onClick={() => setOcrClean((v) => !v)}
                  title={t('ocr.cleanTitle')}
                >
                  {t('ocr.clean')}
                </button>
                <button className="ocr-panel-close" onClick={() => setOcrResult(null)} title={t('ocr.close')}>✕</button>
              </div>

              {/* 统计：识别耗时 + 可见行数 + 字符数（透明度/可预期性） */}
              <div className="ocr-stats">
                <span>{t('ocr.elapsed', { ms: ocrElapsed ?? 0 })}</span>
                <span className="ocr-stats-sep">·</span>
                <span>{t('ocr.statLines', { n: ocrShown })}</span>
                <span className="ocr-stats-sep">·</span>
                <span>{t('ocr.statChars', { n: ocrChars })}</span>
              </div>

              {/* 识别区域预览：self-contained 缩略图 + 各文字块边界框，与下方列表双向联动。
                  完全在取字面板内完成（被遮罩遮挡的编辑画布不可见，故用面板内缩略图），
                  复用 current.dataUrl 与 ocrResult.blocks 的归一化坐标，不依赖任何其它功能。
                  悬停/点击任一侧高亮另一侧并定位：列表行↔图块框 一一对应，便于核对 OCR 落点是否准确。 */}
              <div className="ocr-preview">
                <div className="ocr-preview-head">
                  <span className="ocr-preview-title">{t('ocr.preview')}</span>
                  <span className="ocr-preview-hint">{t('ocr.previewTitle')}</span>
                  <button
                    className={`ocr-region-pick${ocrRegionPick ? ' active' : ''}`}
                    onClick={() => setOcrRegionPick((v) => !v)}
                    disabled={!ocrResult || ocrResult.blocks.length === 0}
                    title={t('ocr.regionPickTitle')}
                  >
                    ▭ {t('ocr.regionPick')}
                  </button>
                </div>
                <div
                  ref={ocrWrapRef}
                  className={`ocr-preview-imgwrap${ocrRegionPick ? ' picking' : ''}`}
                  onMouseDown={ocrRegionPick ? onPreviewDown : undefined}
                  onMouseMove={ocrRegionPick ? onPreviewMove : undefined}
                  onMouseUp={ocrRegionPick ? onPreviewUp : undefined}
                  onMouseLeave={ocrRegionPick ? onPreviewUp : undefined}
                >
                  <img className="ocr-preview-img" src={current.dataUrl} alt="" draggable={false} />
                  <div className="ocr-preview-boxes">
                    {ocrResult.blocks.map((b, i) => {
                      const hidden = !ocrVisSet.has(i);
                      const low = b.confidence > 0 && b.confidence < 0.7;
                      const active = ocrHoverLine === i;
                      const bc = ['ocr-box'];
                      if (hidden) bc.push('hidden');
                      if (low) bc.push('low');
                      if (active) bc.push('active');
                      if (ocrSel[i]) bc.push('selected');
                      return (
                        <div
                          key={i}
                          className={bc.join(' ')}
                          style={{
                            left: `${b.x * 100}%`,
                            top: `${b.y * 100}%`,
                            width: `${b.w * 100}%`,
                            height: `${b.h * 100}%`,
                          }}
                          title={ocrTextAt(i, b)}
                          onMouseEnter={() => setOcrHoverLine(i)}
                          onMouseLeave={() => setOcrHoverLine(null)}
                          onClick={() => focusOcrLine(i)}
                        />
                      );
                    })}
                  </div>
                  {ocrDrag && (
                    <div
                      className="ocr-region-drag"
                      style={{
                        left: `${ocrDrag.x}%`,
                        top: `${ocrDrag.y}%`,
                        width: `${ocrDrag.w}%`,
                        height: `${ocrDrag.h}%`,
                      }}
                    />
                  )}
                </div>
                {ocrRegionPick && (
                  <div className="ocr-preview-hint-active">{t('ocr.regionPickActive')}</div>
                )}
              </div>

              {/* 全文（行以 \n 连接，含内联修正），只读、可点选复制；
                  搜索时把命中词用 <mark> 高亮，并支持「上一处/下一处」跳转定位。 */}
              <div
                ref={ocrTextRef}
                className="ocr-panel-text ocr-hl"
                tabIndex={0}
                spellCheck={false}
                onFocus={selectOcrText}
                onClick={() => {
                  if (!window.getSelection()?.toString().trim()) selectOcrText();
                }}
                onMouseUp={() => {
                  const sel = window.getSelection();
                  const q = sel?.toString().trim();
                  if (!q) return;
                  const el = ocrTextRef.current;
                  // 忽略「全选」（focus/click 自动全选）触发，仅响应真正的划词子集
                  if (el && q.length >= (el.textContent || '').trim().length) return;
                  const map: Record<number, boolean> = {};
                  ocrVisibleLines().forEach(({ b, i }) => {
                    const bt = ocrTextAt(i, b).trim();
                    if (!bt) return;
                    if (bt.includes(q) || q.includes(bt)) map[i] = true;
                  });
                  const keys = Object.keys(map);
                  if (keys.length) {
                    setOcrSel(map);
                    setOcrRegionPick(false);
                    flash(t('ocr.selByText', { n: keys.length }), 'info');
                  }
                }}
              >
                {(() => {
                  const parts = ocrHighlightParts(ocrDisplayText, ocrSearch);
                  let mi = -1;
                  return parts.map((p, k) => {
                    if (!p.hit) return <span key={k}>{p.text}</span>;
                    mi += 1;
                    const active = mi === ocrMatchIdx;
                    return (
                      <mark
                        key={k}
                        ref={active ? (el: HTMLElement | null) => { ocrActiveMarkRef.current = el; } : undefined}
                        className={`ocr-mark${active ? ' active' : ''}`}
                      >
                        {p.text}
                      </mark>
                    );
                  });
                })()}
              </div>

              {/* 结果内搜索：过滤逐行列表，长文本中快速定位；带命中计数 */}
              <div className="ocr-search-row">
                <input
                  ref={ocrSearchRef}
                  className="ocr-search"
                  value={ocrSearch}
                  placeholder={t('ocr.search')}
                  spellCheck={false}
                  onChange={(e) => setOcrSearch(e.target.value)}
                />
                {ocrSearch.trim() && (
                  <span className="ocr-search-count">
                    {t('ocr.matchCount', { shown: ocrShown, total: ocrTotal })}
                  </span>
                )}
                {ocrMatchTotal > 0 && (
                  <span className="ocr-match-nav">
                    <button
                      type="button"
                      className="ocr-match-btn"
                      title={t('ocr.matchPrev')}
                      onClick={() => setOcrMatchIdx((v) => (v - 1 + ocrMatchTotal) % ocrMatchTotal)}
                    >
                      ‹
                    </button>
                    <span className="ocr-match-pos">
                      {Math.min(ocrMatchIdx + 1, ocrMatchTotal)} / {ocrMatchTotal}
                    </span>
                    <button
                      type="button"
                      className="ocr-match-btn"
                      title={t('ocr.matchNext')}
                      onClick={() => setOcrMatchIdx((v) => (v + 1) % ocrMatchTotal)}
                    >
                      ›
                    </button>
                  </span>
                )}
                {ocrSearch && (
                  <button className="ocr-search-clear" onClick={() => setOcrSearch('')}>
                    {t('ocr.searchClear')}
                  </button>
                )}
              </div>

              {/* 置信度阈值：隐藏低置信行（仅对提供置信度的平台生效，如 macOS Vision）。
                  滑动即实时过滤逐行列表，复制/导出/贴回同步只取可见集合。 */}
              {ocrHasConf && (
                <div className="ocr-conf-row">
                  <span className="ocr-conf-label">{t('ocr.confLabel')}</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={ocrConf}
                    className="ocr-conf-range"
                    onChange={(e) => setOcrConf(Number(e.target.value))}
                    title={t('ocr.confTitle', { n: ocrConf })}
                  />
                  <span className="ocr-conf-val">{ocrConf === 0 ? t('ocr.confAll') : `≥${ocrConf}%`}</span>
                </div>
              )}
              {ocrHiddenByConf > 0 && (
                <div className="ocr-conf-hint">{t('ocr.confHidden', { n: ocrHiddenByConf })}</div>
              )}

              {/* 复制/导出格式与偏好：合并为一行 + 识别后自动复制（均跨会话记住） */}
              <div className="ocr-opts-row">
                <label className="ocr-merge">
                  <input
                    type="checkbox"
                    checked={ocrMerge}
                    onChange={(e) => setOcrMerge(e.target.checked)}
                  />
                  {t('ocr.copyMerge')}
                </label>
                <label className="ocr-autocopy">
                  <input
                    type="checkbox"
                    checked={ocrAutoCopy}
                    onChange={(e) => setOcrAutoCopy(e.target.checked)}
                  />
                  {t('ocr.autoCopy')}
                </label>
                <label className="ocr-layout">
                  <input
                    type="checkbox"
                    checked={ocrLayout === 'reading'}
                    onChange={(e) => setOcrLayout(e.target.checked ? 'reading' : 'none')}
                  />
                  {t('ocr.layoutReading')}
                </label>
                <label className="ocr-fmt">
                  {t('ocr.exportFmt')}
                  <select
                    className="ocr-fmt-select"
                    value={ocrExportFmt}
                    onChange={(e) => setOcrExportFmt(e.target.value as OcrExportFmt)}
                    title={t('ocr.exportFmtTitle')}
                  >
                    <option value="txt">{t('ocr.fmtTxt')}</option>
                    <option value="md">{t('ocr.fmtMd')}</option>
                    <option value="json">{t('ocr.fmtJson')}</option>
                    <option value="tsv">{t('ocr.fmtTsv')}</option>
                  </select>
                </label>
                <label className="ocr-extract" title={t('ocr.extractTitle')}>
                  <input
                    type="checkbox"
                    checked={ocrExtract}
                    onChange={(e) => setOcrExtract(e.target.checked)}
                  />
                  {t('ocr.extract')}
                </label>
                <label className="ocr-clean" title={t('ocr.cleanTitle')}>
                  <input
                    type="checkbox"
                    checked={ocrClean}
                    onChange={(e) => setOcrClean(e.target.checked)}
                  />
                  {t('ocr.clean')}
                </label>
                <button
                  className="ocr-sel-btn"
                  onClick={() => {
                    const visIdx = ocrVis.map((x) => x.i);
                    const anySel = visIdx.some((idx) => ocrSel[idx]);
                    if (anySel) setOcrSel({});
                    else setOcrSel(Object.fromEntries(visIdx.map((idx) => [idx, true])));
                  }}
                  disabled={ocrResult.blocks.length === 0}
                  title={t('ocr.selAllTitle')}
                >
                  {ocrSelActive ? t('ocr.selClear') : t('ocr.selAll')}
                </button>
                {ocrSelActive && (
                  <span className="ocr-sel-info">{t('ocr.selInfo', { n: ocrInc.length })}</span>
                )}
                <span className="ocr-merge-tip">{t('ocr.layoutReadingTitle')}</span>
              </div>

              {/* 智能实体提取：从识别结果中一键提取 URL/邮箱/电话，逐条复制。
                  仅开启「提取链接/邮箱/电话」时显示（ocrEnt 非 null）；纯前端辅助视图，
                  不进入复制/导出/贴回数据链，不影响任何既有功能。 */}
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
                // 委托后端 open_external 命令（薄封装已集成的 tauri-plugin-opener，零新依赖）。
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

              {/* OCR 历史：最近识别结果（隔离 localStorage），可回看 / 一键复制 / 清空。
                  v4：附来源缩略图 + sourceId；点击项可回放到原截图（若有 sourceId）。 */}
              {ocrHistoryOpen && (
                <div className="ocr-history">
                  <div className="ocr-history-head">
                    <span>{t('ocr.historyTitle')}</span>
                    {ocrHistory.length > 0 && (
                      <button
                        className="ocr-history-clear"
                        onClick={() => setOcrHistory([])}
                        title={t('ocr.historyClearTitle')}
                      >
                        {t('ocr.historyClear')}
                      </button>
                    )}
                  </div>
                  {ocrHistory.length === 0 ? (
                    <div className="ocr-history-empty">{t('ocr.historyEmpty')}</div>
                  ) : (
                    <div className="ocr-history-list">
                      {ocrHistory.map((it, idx) => (
                        <div className="ocr-history-item" key={`${it.ts}-${idx}`}>
                          <div className="ocr-history-meta">
                            {it.thumb && (
                              <img
                                className="ocr-history-thumb"
                                src={it.thumb}
                                alt=""
                                onClick={() => {
                                  if (!it.sourceId) return;
                                  // 回放：从 history 找来源截图 → setCurrentScreenshot 加载 → 弹 OCR 面板显示历史文字
                                  const target = history.find((s) => s.id === it.sourceId);
                                  if (target) {
                                    setCurrentScreenshot({
                                      id: target.id,
                                      filePath: '',
                                      dataUrl: target.dataUrl,
                                      width: target.width,
                                      height: target.height,
                                      annotations: [],
                                      layers: [],
                                      createdAt: target.createdAt,
                                      updatedAt: target.createdAt,
                                    });
                                    setOcrResult({ text: it.text, blocks: [{ text: it.text, x: 0, y: 0, w: 1, h: 1, confidence: 1 }] });
                                    flash(t('ocr.historyReplayed'), 'success');
                                  }
                                }}
                                title={it.sourceId ? t('ocr.historyReplayTitle') : ''}
                              />
                            )}
                            <span className="ocr-history-lang">{ocrLangTag(it.lang)}</span>
                            <span className="ocr-history-time">{fmtOcrTime(it.ts)}</span>
                            <span className="ocr-history-chars">{it.chars}{t('ocr.charUnit')}</span>
                          </div>
                          <div className="ocr-history-text">{it.text}</div>
                          <button
                            className="ocr-history-copy"
                            title={t('ocr.copy')}
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(it.text);
                                flash(t('ocr.copied'), 'success');
                              } catch {
                                flash(t('ocr.copyFailed'), 'error');
                              }
                            }}
                          >
                            {t('ocr.copy')}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 逐行结果：置信度标记 + 可内联编辑文本框 + 该行单独复制。
                  编辑只存前端（ocrEdits），复制/贴回/导出均读修正后内容。
                  低置信行（0<conf<0.7）高亮提醒用户复核；列表已是搜索+置信度过滤后的可见集合。 */}
              <div className="ocr-blocks">
                {ocrVis.map(({ b, i }) => {
                  const cur = ocrTextAt(i, b);
                  const edited = ocrEdits[i] !== undefined;
                  const lowConf = b.confidence > 0 && b.confidence < 0.7;
                  const cls = ['ocr-block'];
                  if (edited) cls.push('edited');
                  if (lowConf) cls.push('low-conf');
                  if (ocrHoverLine === i) cls.push('focused');
                  return (
                    <div
                      className={cls.join(' ')}
                      key={i}
                      data-ocr-idx={i}
                      onMouseEnter={() => setOcrHoverLine(i)}
                      onMouseLeave={() => setOcrHoverLine(null)}
                    >
                      <input
                        type="checkbox"
                        className="ocr-block-sel"
                        checked={!!ocrSel[i]}
                        onChange={(e) =>
                          setOcrSel((m) => {
                            const n = { ...m };
                            if (e.target.checked) n[i] = true;
                            else delete n[i];
                            return n;
                          })
                        }
                        title={t('ocr.selLineTitle')}
                      />
                      {b.confidence > 0 && (
                        <span className="ocr-chip">{Math.round(b.confidence * 100)}%</span>
                      )}
                      <input
                        className="ocr-block-edit"
                        value={cur}
                        spellCheck={false}
                        placeholder={t('ocr.copyLine')}
                        onChange={(e) => setOcrEdits((m) => ({ ...m, [i]: e.target.value }))}
                      />
                      <button
                        className="ocr-block-copy"
                        title={t('ocr.copyLine')}
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(cur);
                            flash(t('ocr.copied'), 'success');
                          } catch {
                            flash(t('ocr.copyFailed'), 'error');
                          }
                        }}
                      >
                        {t('ocr.copy')}
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="ocr-panel-actions">
                <button
                  className="tbar-btn tbar-primary"
                  onClick={applyOcrAsAnnotations}
                  disabled={ocrResult.blocks.length === 0 || ocrSourceKind === 'text'}
                  title={ocrSourceKind === 'text' ? t('ocr.applyTitleText') : t('ocr.applyTitle')}
                >
                  {t('ocr.apply')}
                </button>
                <button
                  className="tbar-btn tbar-ghost"
                  onClick={redactOcrSel}
                  disabled={ocrResult.blocks.length === 0}
                  title={t('ocr.redactSelTitle')}
                >
                  {t('ocr.redactSel')}
                </button>
                <button
                  className="tbar-btn tbar-ghost"
                  onClick={highlightOcrSel}
                  disabled={ocrResult.blocks.length === 0}
                  title={t('ocr.highlightSelTitle')}
                >
                  {t('ocr.highlightSel')}
                </button>
                <button
                  className="tbar-btn tbar-ghost"
                  onClick={arrowOcrSel}
                  disabled={ocrResult.blocks.length === 0}
                  title={t('ocr.arrowSelTitle')}
                >
                  {t('ocr.arrowSel')}
                </button>
                <button
                  className="tbar-btn tbar-ghost"
                  onClick={() => runOcr(ocrLastImage ?? current?.dataUrl ?? '')}
                  disabled={ocrBusy || !ocrLastImage || ocrSourceKind === 'text'}
                  title={ocrSourceKind === 'text' ? t('ocr.rerunTitleText') : t('ocr.rerunTitle')}
                >
                  {ocrBusy ? t('editor.ocrBusy') : t('ocr.rerun')}
                </button>
                <button
                  className="tbar-btn tbar-ghost"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(ocrDisplayText);
                      flash(t('ocr.copied'), 'success');
                    } catch {
                      flash(t('ocr.copyFailed'), 'error');
                    }
                  }}
                >
                  {t('ocr.copyAll')}
                </button>
                <button
                  className="tbar-btn tbar-ghost"
                  onClick={() => copyOcrAs('json')}
                  disabled={ocrResult.blocks.length === 0}
                  title={t('ocr.copyJsonTitle')}
                >
                  {t('ocr.copyJson')}
                </button>
                <button
                  className="tbar-btn tbar-ghost"
                  onClick={() => copyOcrAs('tsv')}
                  disabled={ocrResult.blocks.length === 0}
                  title={t('ocr.copyTsvTitle')}
                >
                  {t('ocr.copyTsv')}
                </button>
                <button
                  className="tbar-btn tbar-ghost"
                  onClick={handleExportOcr}
                  disabled={ocrResult.blocks.length === 0}
                  title={t('ocr.exportTitle')}
                >
                  {t('ocr.export')}
                </button>
                {Object.keys(ocrEdits).length > 0 && (
                  <button
                    className="tbar-btn tbar-ghost"
                    onClick={() => setOcrEdits({})}
                    title={t('ocr.resetEditsTitle')}
                  >
                    {t('ocr.resetEdits')}
                  </button>
                )}
                <button className="tbar-btn tbar-ghost" onClick={() => setOcrResult(null)}>{t('ocr.close')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ===== 滚动长截图控制条（主窗口已缩为角落小窗）=====
  if (scrolling) {
    const shiftK = isWinLike ? 'Shift' : '⇧';
    return (
      <div className="scroll-ctrl" data-tauri-drag-region>
        <div className="scroll-ctrl-head">
          <span className="scroll-ctrl-dot" />
          <span className="scroll-ctrl-title">{t('scroll.title')}</span>
          <span className="scroll-ctrl-count">{t('scroll.frames', { n: scrollFrames.length })}</span>
        </div>
        <div className="scroll-ctrl-hint">
          {t('scroll.hintPrefix')} <kbd className="kbd">{modLabel}</kbd><kbd className="kbd">{shiftK}</kbd><kbd className="kbd">4</kbd> {t('scroll.hintSuffix')}
        </div>
        <div className="scroll-ctrl-actions">
          <button
            className="scroll-ctrl-btn primary"
            onClick={captureScrollFrame}
            disabled={scrollBusy}
          >
            {scrollBusy ? t('scroll.captureBusy') : t('scroll.capture')}
          </button>
          <button
            className="scroll-ctrl-btn"
            onClick={finishScrollCapture}
            disabled={scrollBusy || scrollFrames.length === 0}
          >
            {t('scroll.finish')}
          </button>
          <button className="scroll-ctrl-btn ghost" onClick={cancelScrollCapture} disabled={scrollBusy}>
            {t('scroll.cancel')}
          </button>
        </div>
        {toast && (
          <div className={`toast toast-${toastType} scroll-ctrl-toast`}>
            <span className="toast-msg">{toast}</span>
          </div>
        )}
      </div>
    );
  }

  // ===== 主页视图 =====
  return (
    <div className="screenshot-app">
      <div className="topbar">
        <button className="theme-toggle" title={t('editor.themeTitle', { label: themeLabel })} onClick={cycleTheme}>
          {themeIcon}
        </button>
        <LanguageToggle />
      </div>

      <div className="home-view">
        <div style={{ textAlign: 'center' }}>
          <div className="app-title">SnapCraft</div>
          <div className="app-subtitle">{t('app.subtitle')}</div>
        </div>

        <div className="capture-actions">
          <div
            className="capture-card"
            role="button"
            tabIndex={0}
            aria-label={t('capture.screen.aria')}
            onClick={() => doCapture('screen')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                doCapture('screen');
              }
            }}
          >
            <div className="capture-card-icon">🖥️</div>
            <div className="capture-card-label">{t('capture.screen.label')}</div>
            <div className="capture-card-desc">
              <div className="capture-card-keys">
                <kbd className="kbd">{modLabel}</kbd>
                <kbd className="kbd">{shiftLabel}</kbd>
                <kbd className="kbd">S</kbd>
              </div>
              <span className="capture-card-desc-text">{t('capture.screen.desc')}</span>
            </div>
          </div>
          <div
            className="capture-card"
            role="button"
            tabIndex={0}
            aria-label={t('capture.region.aria')}
            onClick={() => doCapture('region')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                doCapture('region');
              }
            }}
          >
            <div className="capture-card-icon">✂️</div>
            <div className="capture-card-label">{t('capture.region.label')}</div>
            <div className="capture-card-desc">
              <div className="capture-card-keys">
                <kbd className="kbd">{modLabel}</kbd>
                <kbd className="kbd">{shiftLabel}</kbd>
                <kbd className="kbd">2</kbd>
              </div>
              <span className="capture-card-desc-text">{t('capture.region.desc')}</span>
            </div>
          </div>
          <div
            className="capture-card"
            role="button"
            tabIndex={0}
            aria-label={t('capture.window.aria')}
            onClick={() => doCapture('window')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                doCapture('window');
              }
            }}
          >
            <div className="capture-card-icon">🪟</div>
            <div className="capture-card-label">{t('capture.window.label')}</div>
            <div className="capture-card-desc">
              <div className="capture-card-keys">
                <kbd className="kbd">{modLabel}</kbd>
                <kbd className="kbd">{shiftLabel}</kbd>
                <kbd className="kbd">3</kbd>
              </div>
              <span className="capture-card-desc-text">{t('capture.window.desc')}</span>
            </div>
          </div>
          <div
            className="capture-card"
            role="button"
            tabIndex={0}
            aria-label={t('capture.scroll.aria')}
            onClick={startScrollCapture}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                startScrollCapture();
              }
            }}
          >
            <div className="capture-card-icon">📜</div>
            <div className="capture-card-label">{t('capture.scroll.label')}</div>
            <div className="capture-card-desc">
              <div className="capture-card-keys">
                <kbd className="kbd">{modLabel}</kbd>
                <kbd className="kbd">{shiftLabel}</kbd>
                <kbd className="kbd">4</kbd>
              </div>
              <span className="capture-card-desc-text">{t('capture.scroll.desc')}</span>
            </div>
          </div>
        </div>

        {/* 从剪贴板取字：读取系统剪贴板中的任意图片并识别文字（第四个 OCR 入口，
            覆盖「图片已复制但不在 SnapCraft 内」的场景）。与截图入口并列但独立，不影响其它功能。 */}
        <div className="home-secondary">
          <button
            className="home-sec-btn"
            onClick={() => openClipboardOcrWindow()}
            disabled={ocrBusy}
            title={t('ocr.clipTitle')}
          >
            📋 {t('ocr.clipboard')}
          </button>
        </div>

        {/* 延时截图：选一个延时后，全屏截图会先读秒再截，方便先展开菜单/悬浮态等瞬时 UI */}
        <div className="delay-bar" role="group" aria-label={t('home.delayLabel')}>
          <span className="delay-bar-label">⏱ {t('home.delayLabel')}</span>
          {[0, 3, 5].map((s) => (
            <button
              key={s}
              className={`delay-chip${captureDelay === s ? ' active' : ''}`}
              aria-pressed={captureDelay === s}
              onClick={() => setCaptureDelay(s)}
              title={s === 0 ? t('home.delayTitleOff') : t('home.delayTitleWait', { s })}
            >
              {s === 0 ? t('home.delayOff') : `${s}s`}
            </button>
          ))}
          <span className="delay-bar-hint">{t('home.delayOnlyFull')}</span>
        </div>

        {displays.length > 1 && (
          <div className="multi-display-hint">
            {t('home.multiDisplay', { n: displays.length })}
          </div>
        )}

        <div className="history-section">
          <div className="history-title">
            <span>📸</span>
            <span>{t('history.title')}</span>
            {history.length > 0 && (
              <>
                <button
                  className="history-clear-btn"
                  onClick={handleClearHistory}
                  title={t('history.clearTitle')}
                >
                  {t('history.clear')}
                </button>
                <button
                  className="history-sel-btn"
                  onClick={() => (selMode ? clearSel() : setSelMode(true))}
                  title={t('history.selectTitle')}
                >
                  {selMode ? t('history.selectDone') : t('history.select')}
                </button>
                {selMode && (
                  <button
                    className="history-sel-btn"
                    onClick={selectAll}
                    title={t('history.selectAllTitle')}
                  >
                    {t('history.selectAll')}
                  </button>
                )}
              </>
            )}
          </div>
          <div className="history-search-row">
            <input
              className="history-search-input"
              type="search"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              placeholder={t('history.searchPlaceholder')}
            />
            {historySearch && (
              <button className="history-search-clear" onClick={() => setHistorySearch('')} title={t('history.clear')}>✕</button>
            )}
          </div>

          {history.length === 0 ? (
            <div className="empty-history">
              <div className="empty-history-icon">📷</div>
              <div className="empty-history-text">{t('history.empty')}</div>
            </div>
          ) : filteredHistory.length === 0 ? (
            <div className="empty-history">
              <div className="empty-history-icon">🔍</div>
              <div className="empty-history-text">{t('history.noMatch')}</div>
            </div>
          ) : (
            <div className="history-grid">
              {filteredHistory.map((h) => (
                <div
                  key={h.id}
                  className={`history-item${selMode ? ' selecting' : ''}${selIds.includes(h.id) ? ' selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={t('history.viewAria', { time: new Date(h.createdAt).toLocaleString() })}
                  onClick={() => (selMode ? toggleSel(h.id) : openEditorWindow({ id: h.id, width: h.width, height: h.height }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selMode ? toggleSel(h.id) : openEditorWindow({ id: h.id, width: h.width, height: h.height });
                    }
                  }}
                >
                  {selMode && (
                    <div
                      className="history-item-check"
                      onClick={(e) => { e.stopPropagation(); toggleSel(h.id); }}
                    >
                      <input type="checkbox" checked={selIds.includes(h.id)} readOnly />
                    </div>
                  )}
                  <LazyHistoryThumb dataUrl={h.dataUrl} alt="screenshot" />
                  {h.source === 'clipboard' && (
                    <span className="history-item-badge" title={t('history.clipboardSourceTitle')}>
                      📋 {t('history.clipboardSource')}
                    </span>
                  )}
                  <div className="history-item-overlay">
                    <span>{new Date(h.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="history-item-actions">
                    <button
                      className="history-act-btn"
                      title={t('history.copyTitle')}
                      aria-label={t('history.copyAria')}
                      onClick={(e) => { e.stopPropagation(); copyDataUrl(h.dataUrl); }}
                    >
                      📋
                    </button>
                    <button
                      className="history-act-btn"
                      title={t('history.ocrTitle')}
                      aria-label={t('history.ocrAria')}
                      onClick={(e) => { e.stopPropagation(); startOcrFromShot(h); }}
                    >
                      🔍
                    </button>
                    <button
                      className="history-act-btn"
                      title={t('history.saveTitle')}
                      aria-label={t('history.saveAria')}
                      onClick={(e) => { e.stopPropagation(); saveDataUrl(h.dataUrl); }}
                    >
                      💾
                    </button>
                    <button
                      className="history-act-btn"
                      title={t('history.pinTitle')}
                      aria-label={t('history.pinAria')}
                      onClick={(e) => { e.stopPropagation(); pinShot(h); }}
                    >
                      📌
                    </button>
                    <button
                      className="history-act-btn danger"
                      title={t('history.deleteTitle')}
                      aria-label={t('history.deleteAria')}
                      onClick={(e) => { e.stopPropagation(); handleDeleteHistory(h.id); }}
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))}
            </div>
            )}
            {/* R4：批量取字操作条 */}
            {selMode && selIds.length > 0 && (
              <div className="batch-bar">
                <span className="batch-count">{t('ocr.batchSel', { n: selIds.length })}</span>
                <button className="batch-btn primary" onClick={handleBatchOcr} disabled={batchBusy}>
                  {batchBusy ? t('ocr.batchBusy') : t('ocr.batchRun')}
                </button>
                <button
                  className="batch-btn accent"
                  onClick={() => { setShowBatch(false); setShowAiBatch(true); }}
                  title={t('ocr.batchAiTitle')}
                >
                  {t('ocr.batchAi')}
                </button>
                <button className="batch-btn" onClick={clearSel}>{t('ocr.batchCancel')}</button>
              </div>
            )}
          </div>
      </div>

      {/* R4：批量取字结果弹窗 */}
      {showBatch && (
        <div className="ocr-panel-mask" onClick={() => setShowBatch(false)}>
          <div className="ocr-panel batch-panel" onClick={(e) => e.stopPropagation()}>
            <div className="ocr-panel-head">
              <span className="ocr-panel-title">
                {t('ocr.batchTitle')}
                {batchItems.length > 0 && <span className="ocr-hist-count">{batchItems.length}</span>}
              </span>
              <button className="ocr-panel-close" onClick={() => setShowBatch(false)} title={t('ocr.close')}>✕</button>
            </div>
            <div className="batch-panel-body">
              {batchItems.length === 0 ? (
                <div className="ocr-entity-empty">{t('ocr.batchEmpty')}</div>
              ) : (
                batchItems.map((it, idx) => (
                  <div className="batch-card" key={it.id}>
                    <div className="batch-card-head">
                      <span className="batch-card-idx">{idx + 1}</span>
                      <span className="batch-card-time">{it.time}</span>
                      <button
                        type="button"
                        className="batch-card-copy"
                        title={t('ocr.copy')}
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(it.text);
                            flash(t('ocr.copied'), 'success');
                          } catch {
                            flash(t('ocr.copyFailed'), 'error');
                          }
                        }}
                      >
                        {t('ocr.copy')}
                      </button>
                    </div>
                    <textarea
                      className="batch-card-text"
                      value={it.text}
                      spellCheck={false}
                      onChange={(e) =>
                        setBatchItems((arr) => arr.map((x, j) => (j === idx ? { ...x, text: e.target.value } : x)))
                      }
                    />
                  </div>
                ))
              )}
            </div>
            <div className="ocr-panel-actions">
              <button
                className="tbar-btn tbar-ghost"
                disabled={batchItems.length === 0}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(batchItems.map((i) => i.text).join('\n\n'));
                    flash(t('ocr.copied'), 'success');
                  } catch {
                    flash(t('ocr.copyFail'), 'error');
                  }
                }}
                title={t('ocr.copyAll')}
              >
                {t('ocr.copyAll')}
              </button>
              <button
                className="tbar-btn tbar-ghost"
                disabled={batchItems.length === 0}
                onClick={async () => {
                  const path = await save({ defaultPath: `ocr-batch-${Date.now()}.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] });
                  if (path) {
                    try {
                      await invoke('save_text_file', { content: batchItems.map((i) => i.text).join('\n\n'), filePath: path });
                      flash(t('ocr.exported'), 'success');
                    } catch (e) {
                      flash(t('ocr.exportFailed', { msg: String(e) }), 'error');
                    }
                  }
                }}
                title={t('ocr.export')}
              >
                {t('ocr.export')}
              </button>
              <button className="tbar-btn tbar-ghost" onClick={clearSel}>{t('ocr.close')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Phase 28：批量 Agent 队列结果弹窗 */}
      {showAiBatch && (
        <div className="ocr-panel-mask" onClick={() => setShowAiBatch(false)}>
          <div className="ocr-panel batch-panel ai-batch-panel" onClick={(e) => e.stopPropagation()}>
            <div className="ocr-panel-head">
              <span className="ocr-panel-title">
                {t('ocr.batchAiTitle')}
                {aiBatchItems.length > 0 && <span className="ocr-hist-count">{aiBatchItems.length}</span>}
              </span>
              <button className="ocr-panel-close" onClick={() => setShowAiBatch(false)} title={t('ocr.close')}>✕</button>
            </div>
            <div className="ai-batch-prompt-row">
              <textarea
                className="batch-card-text ai-batch-prompt"
                value={aiPrompt}
                spellCheck={false}
                placeholder={t('ocr.batchAiPrompt')}
                onChange={(e) => setAiPrompt(e.target.value)}
              />
              <button
                className="batch-btn accent"
                onClick={handleBatchAi}
                disabled={aiBatchBusy || selIds.length === 0}
                title={t('ocr.batchAiRun')}
              >
                {aiBatchBusy ? t('ocr.batchAiBusy') : t('ocr.batchAiRun')}
              </button>
            </div>
            {aiBatchBusy && (
              <div className="ai-batch-progress">{t('ocr.batchAiProgress', { done: aiBatchDone, total: aiBatchTotal })}</div>
            )}
            <div className="batch-panel-body">
              {aiBatchItems.length === 0 ? (
                <div className="ocr-entity-empty">{aiBatchBusy ? t('ocr.batchAiRunning') : t('ocr.batchAiEmpty2')}</div>
              ) : (
                aiBatchItems.map((it, idx) => (
                  <div className="batch-card" key={it.id}>
                    <div className="batch-card-head">
                      <span className="batch-card-idx">{idx + 1}</span>
                      <span className="batch-card-time">{it.time}</span>
                      <button
                        type="button"
                        className="batch-card-copy"
                        title={t('ocr.copy')}
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(it.error ? it.error : it.text);
                            flash(t('ocr.copied'), 'success');
                          } catch {
                            flash(t('ocr.copyFailed'), 'error');
                          }
                        }}
                      >
                        {t('ocr.copy')}
                      </button>
                    </div>
                    {it.error ? (
                      <div className="batch-card-err">{t('ocr.batchAiError', { msg: it.error })}</div>
                    ) : (
                      <textarea
                        className="batch-card-text"
                        value={it.text}
                        spellCheck={false}
                        onChange={(e) =>
                          setAiBatchItems((arr) => arr.map((x, j) => (j === idx ? { ...x, text: e.target.value } : x)))
                        }
                      />
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="ocr-panel-actions">
              <button
                className="tbar-btn tbar-ghost"
                disabled={aiBatchItems.length === 0}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(aiBatchItems.map((i) => (i.error ? i.error : i.text)).join('\n\n'));
                    flash(t('ocr.copied'), 'success');
                  } catch {
                    flash(t('ocr.copyFail'), 'error');
                  }
                }}
                title={t('ocr.copyAll')}
              >
                {t('ocr.copyAll')}
              </button>
              <button
                className="tbar-btn tbar-ghost"
                disabled={aiBatchItems.length === 0}
                onClick={async () => {
                  const path = await save({ defaultPath: `ai-batch-${Date.now()}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
                  if (path) {
                    try {
                      const md = aiBatchItems.map((it, idx) => `## 截图 ${idx + 1}：${it.time}\n\n${it.error ? '> ' + it.error : it.text}`).join('\n\n');
                      await invoke('save_text_file', { content: md, filePath: path });
                      flash(t('ocr.exported'), 'success');
                    } catch (e) {
                      flash(t('ocr.exportFailed', { msg: String(e) }), 'error');
                    }
                  }
                }}
                title={t('ocr.batchAiExportMd')}
              >
                {t('ocr.batchAiExportMd')}
              </button>
              <button
                className="tbar-btn tbar-ghost"
                disabled={aiBatchItems.length === 0}
                onClick={async () => {
                  const path = await save({ defaultPath: `ai-batch-${Date.now()}.docx`, filters: [{ name: 'Word', extensions: ['docx'] }] });
                  if (path) {
                    try {
                      const md = aiBatchItems.map((it, idx) => `## 截图 ${idx + 1}：${it.time}\n\n${it.error ? '> ' + it.error : it.text}`).join('\n\n');
                      const bytes = await markdownToDocx(md, { title: t('ocr.batchAiTitle'), theme: useAiStore.getState().config?.theme });
                      await invoke('save_binary_file', { bytes: Array.from(bytes), filePath: path });
                      flash(t('ocr.exported'), 'success');
                    } catch (e) {
                      flash(t('ocr.exportFailed', { msg: String(e) }), 'error');
                    }
                  }
                }}
                title={t('ocr.batchAiExportDocx')}
              >
                {t('ocr.batchAiExportDocx')}
              </button>
              <button className="tbar-btn tbar-ghost" onClick={() => setShowAiBatch(false)}>{t('ocr.close')}</button>
            </div>
          </div>
        </div>
      )}

      {showDisplayPicker && displays.length > 1 && (
        <DisplayPicker
          displays={displays}
          onPick={pickDisplay}
          onCancel={() => setShowDisplayPicker(false)}
        />
      )}

      {lastShot && (
        <div className="result-bar" role="dialog" aria-label={t('result.aria')}>
          <img className="result-bar-thumb" src={lastShot.dataUrl} alt={t('result.thumbAlt')} />
          <div className="result-bar-info">
            <div className="result-bar-title">{t('result.title')}</div>
            <div className="result-bar-sub">{t('result.sub', { w: lastShot.width, h: lastShot.height })}</div>
          </div>
          <div className="result-bar-actions">
            <button className="result-bar-btn" title={t('result.copyTitle')} onClick={() => copyDataUrl(lastShot.dataUrl)}>📋 {t('result.copy')}</button>
            <button className="result-bar-btn" title={t('result.ocrTitle')} onClick={() => startOcrFromShot(lastShot)}>🔍 {t('result.ocr')}</button>
            <button className="result-bar-btn" title={t('result.editTitle')} onClick={() => { if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current); setLastShot(null); openEditorWindow({ id: lastShot.id, width: lastShot.width, height: lastShot.height }); }}>✏️ {t('result.edit')}</button>
            <button className="result-bar-btn" title={t('result.saveTitle')} onClick={() => saveDataUrl(lastShot.dataUrl)}>💾 {t('result.save')}</button>
            <button className="result-bar-btn" title={t('result.pinTitle')} onClick={() => pinShot(lastShot)}>📌 {t('result.pin')}</button>
          </div>
          <button
            className="result-bar-close"
            title={t('result.close')}
            aria-label={t('result.close')}
            onClick={() => { if (resultBarTimerRef.current) clearTimeout(resultBarTimerRef.current); setLastShot(null); }}
          >
            ✕
          </button>
        </div>
      )}

      {countdown !== null && (
        <div className="countdown-overlay" aria-live="assertive">
          <div className="countdown-num">{countdown}</div>
          <div className="countdown-text">{t('countdown.text')}</div>
        </div>
      )}

      {busy && countdown === null && (
        <div className="capturing-overlay">
          <div style={{ fontSize: '64px' }}>📷</div>
          <div className="capturing-text">{t('capturing.text')}</div>
        </div>
      )}
      {toast && (
        <div className={`toast toast-${toastType}`}>
          <span className="toast-icon">{toastType === 'error' ? '!' : toastType === 'info' ? 'ℹ' : '✓'}</span>
          <span className="toast-msg">{toast}</span>
          {revealPath && (
            <button
              className="toast-reveal-btn"
              onClick={() => invoke('reveal_in_folder', { path: revealPath })}
              title={t('toast.revealTitle')}
            >
              {t('toast.reveal')}
            </button>
          )}
        </div>
      )}
      {permissionNeeded && (
        <div className="permission-gate">
          <div className="permission-card">
            <div className="permission-icon">📸</div>
            <div className="permission-title">{t('permission.title')}</div>
            <div className="permission-text">
              {isDev ? (
                <>
                  {t('permission.dev1')}<b>{t('permission.devBadge')}</b>{t('permission.dev2')}
                  <b>{t('permission.devBrand')}</b>{t('permission.dev3')}
                </>
              ) : (
                <>
                  {t('permission.normal1')}<b>SnapCraft</b>{t('permission.normal2')}
                </>
              )}
            </div>
            <div className="permission-actions">
              <button className="permission-btn" onClick={openScreenRecordingSettings}>
                {t('permission.openSettings')}
              </button>
              <button className="permission-btn" onClick={recheckPermission} disabled={permissionChecking}>
                {permissionChecking ? t('permission.refreshing') : t('permission.refresh')}
              </button>
              <button
                className="permission-btn ghost"
                onClick={() => setPermissionNeeded(false)}
              >
                {t('permission.later')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EnhancedScreenshotApp;
