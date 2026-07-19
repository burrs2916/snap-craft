// AI 助手面板：可复用的右侧抽屉
// 在两个编辑器（EnhancedScreenshotApp / EditorWindow）中挂载，传入当前截图的
// dataUrl 与 OCR 文字作为上下文。配置与生成状态来自 useAiStore。
// 设计为「非侵入」：默认不显示，点击工具栏 AI 按钮才滑出；关闭后不影响任何现有功能。
//
// 2026-07-14 Phase 2b 新增：
//  - 「附加更多截图」：从本机截图历史多选，AI 一并分析、合成完整文档（多截图成稿）。
//  - 「管理模板」：用户可保存自己的业务文档/文案预设（localStorage 持久化）。
//  - 导出增 .html（可 ⌘P 另存为 PDF），复用既有 save_text_file 后端命令。

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAiStore, convHash, type AiConvMeta } from './aiStore';
import { type AiPreset, type UserPreset, stripSnapMarkers, hasSnapMarkers } from './aiPresets';
import { AiMarkdown } from './aiMarkdown';
import { chatOnce, estimateCost } from './aiClient';
import { type AiToolHost, toolLabel } from './aiTools';
import { requestRefresh, notifyAiCommit } from '../../ai-window/bridge';
import { mdToHtml, DOC_THEMES } from './markdownHtml';
import { markdownToDocx, type DocxImage } from './markdownDocx';
import { markdownToPptx } from './markdownPptx';
import { markdownToXlsx } from './markdownXlsx';
import { buildZip, dataUrlToBytes } from './zipStore';
import { pickExportPath, buildDefaultPath, rememberDirFromPath, revealInFolder, deriveFileHint, baseNameOf } from './exportPath';
import { pushExportHistory, listExportHistory, clearExportHistory, type ExportHistoryItem } from './exportHistory';
import type { AiApiType, AiChatTurn } from './aiTypes';
import { t, getLang, isTauri } from '../../i18n';
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * 通过隐藏 iframe 触发浏览器「打印 → 另存为 PDF」。
 * 改进点（对标顶级项目对打印可靠性的要求）：
 *  - 不再用 0×0 尺寸的 iframe（部分平台下 0×0 无法正常打印）；
 *  - 打印前用 Promise 等待文档内全部 <img>（含内联 base64 截图）解码完成，
 *    避免图文报告 PDF 出现空白 / 截断；2.5s 兜底超时，极端情况下也不永久卡住。
 * 返回 null 表示已触发打印；返回错误码字符串（如 'iframe'）表示失败。
 */
function printHtmlViaIframe(html: string): Promise<string | null> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.left = '-10000px';
    iframe.style.top = '0';
    iframe.style.width = '1000px';
    iframe.style.height = '10px';
    iframe.style.border = 'none';
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      resolve('iframe');
      return;
    }
    doc.open();
    doc.write(html);
    doc.close();
    const finish = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        /* 忽略打印异常 */
      }
      setTimeout(() => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 1000);
      resolve(null);
    };
    iframe.onload = () => {
      const imgs = Array.from(doc.images) as HTMLImageElement[];
      if (imgs.length === 0) {
        finish();
        return;
      }
      let pending = imgs.length;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        finish();
      };
      imgs.forEach((img) => {
        if (img.complete && img.naturalWidth > 0) {
          if (--pending === 0) done();
        } else {
          img.addEventListener('load', () => { if (--pending === 0) done(); }, { once: true });
          img.addEventListener('error', () => { if (--pending === 0) done(); }, { once: true });
        }
      });
      // 兜底：2.5s 后无论如何都打印，避免极端情况下永久卡住
      setTimeout(done, 2500);
    };
  });
}

// 轻量 Markdown → 纯文本（用于「导出 .txt」），只剥离常见标记、保留可读结构
function mdToPlainText(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '- ')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*\|.+\|\s*$/gm, (m) => m.replace(/\|/g, ' ').trim())
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 文档统计：字数（去 Markdown 标记后的纯文字长度）/ 行数 / 阅读时长（中文 300 字/分）
// 用于生成完成后在导出区上方展示一行量化信息（专业感 + 阅读预期管理）
function docStats(md: string): { words: number; lines: number; minutes: number } {
  const plain = (md || '')
    .replace(/```[\s\S]*?```/g, '')           // 代码块
    .replace(/`[^`]*`/g, '')                   // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')      // 图片语法
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // 链接 → 文字
    .replace(/^#{1,6}\s+/gm, '')               // 标题井号
    .replace(/^\s*[-*+]\s+/gm, '')             // 无序列表标记
    .replace(/^\s*\d+\.\s+/gm, '')            // 有序列表标记
    .replace(/^\s*>\s?/gm, '')                 // 引用标记
    .replace(/^\s*\|.+\|\s*$/gm, (m) => m.replace(/\|/g, ' ').trim()) // 表格行保留文字
    .replace(/[*_~`]/g, '')                    // 强调 / 删除线 / 代码标记
    .replace(/<!--[\s\S]*?-->/g, '')           // HTML 注释（含 SNAP 章节锚点）
    .replace(/\s+/g, '');                      // 所有空白
  const words = plain.length;
  const lines = (md || '').split('\n').filter((l) => l.trim().length > 0).length;
  const minutes = Math.max(1, Math.round(words / 300));
  return { words, lines, minutes };
}

// 来源截图「前置整块」HTML：与 DOCX / PPTX / 复制为富文本一致的**顶部**位置，
// 避免 HTML 文件导出 / PDF 打印 / 应用内预览把截图丢在正文底部（footer 之后），
// 造成「同一文档 6 种产物 3 种位置错乱」的视觉落差，达不到「附带截图」的预期效果。
function frontImageBlockHtml(imgs: DocxImage[]): string {
  if (!imgs.length) return '';
  const fig = imgs
    .map(
      (im) =>
        `<figure class="doc-fig"><img class="doc-img" src="${im.dataUrl}" alt="" /><figcaption class="doc-cap">${im.caption ?? ''}</figcaption></figure>`,
    )
    .join('');
  return `<div class="doc-fig-block" style="max-width:820px;margin:0 auto;padding:6px 40px 0;box-sizing:border-box;">${fig}</div>`;
}

// 取 Markdown 首个一级标题文本，用作导出封面标题——让「AI 自己写的标题」出现在文档封面，
// 而不是被通用预设名（如"文档"）覆盖。跳过 <!--SNAP:k--> 章节锚点行。
function firstHeading(md: string): string | null {
  for (const raw of (md ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || /^<!--\s*SNAP:\d+\s*-->$/.test(line)) continue;
    const m = /^#\s+(.*)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

// 时间戳 → 紧凑本地时间（用于历史库列表）
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 多截图章节顺序持久化（按截图哈希分桶）：关闭面板后仍可恢复，避免图文报告顺序丢失
const SEL_PREFIX = 'snapcraft-ai-sel:';
const loadSel = (hash: string): string[] => {
  try {
    const raw = localStorage.getItem(SEL_PREFIX + hash);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
};
const saveSel = (hash: string, ids: string[]) => {
  try {
    localStorage.setItem(SEL_PREFIX + hash, JSON.stringify(ids));
  } catch {
    /* 忽略写入失败 */
  }
};

// 截图历史条目（与 Rust HistoryItem 对齐，仅取面板所需字段）
interface HistoryItem {
  id: string;
  data_url: string;
  ocr_text: string;
  created_at: string;
}

function presetLabel(p: AiPreset): string {
  return p.name ?? (p.labelKey ? t(p.labelKey) : p.id);
}
function presetDesc(p: AiPreset): string {
  return p.desc ?? (p.descKey ? t(p.descKey) : '');
}

interface AIPanelProps {
  imageDataUrl?: string;
  ocrText?: string;
  open: boolean;
  onClose: () => void;
  /** 可选：把 AI 生成的纯文本文案作为文字标注贴回当前截图（由宿主编辑器实现） */
  onApplyToScreenshot?: (text: string) => void;
  /**
   * 可选：AI 实际看到的「编辑后截图」dataURL（底图 + 全部标注，含打码/模糊）。
   * 若不传则回退为 imageDataUrl。imageDataUrl 仍作为截图身份（对话线程键 / 历史排除），
   * visionImageUrl 仅决定发给模型的视觉内容——从而让 AI 基于用户编辑后的截图产出文档。
   */
  visionImageUrl?: string;
  /** 可选：宿主重算 visionImageUrl（如用户继续编辑后点「同步最新编辑」） */
  onRefreshImage?: () => void;
  /**
   * 可选：AI 智能编辑的「工具宿主」——由编辑器注入，使 AI 能直接调用工具修改当前截图
   * （圈选 / 打码 / 高亮 / 区域识别）。提供时面板才显示「AI 智能编辑」模式开关。
   */
  aiTools?: AiToolHost;
  /**
   * 可选：AI 窗口专属。为 true 时把本头部升级为「窗口标题栏」：
   *   - 标题文字带 data-tauri-drag-region 拖拽区（避开历史/关闭按钮，规避拖拽吞点击）；
   *   - 头部应用 ai-panel-head--win 的窗口级样式。
   * 编辑器窗口默认 false，维持原抽屉头部样式，互不影响。
   */
  windowChrome?: boolean;
  /** 可选：AI 窗口专属。为 true 时标题旁显示「实时联动主窗口」状态点。 */
  live?: boolean;
}

export default function AIPanel({
  imageDataUrl,
  ocrText,
  open,
  onClose,
  onApplyToScreenshot,
  visionImageUrl,
  onRefreshImage,
  aiTools,
  windowChrome = false,
  live = false,
}: AIPanelProps) {
  const {
    config,
    status,
    output,
    error,
    refining,
    usage,
    thinking,
    agentSteps,
    attachImage,
    attachOcr,
    activePresetId,
    customPresets,
    conversation,
    convKey,
    memories,
    activeMemoryIds,
    setConvKey,
    chat,
    clearConversation,
    compactMemory,
    deleteMemory,
    updateMemory,
    setConfig,
    setAttachImage,
    setAttachOcr,
    setActivePreset,
    addCustomPreset,
    updateCustomPreset,
    deleteCustomPreset,
    allPresets,
    resolvePreset,
    generate,
    refine,
    runAgent,
    stop,
    reset,
    listConvMeta,
    getConvByHash,
    deleteConv,
    forkConversation,
    setOutput,
    recordConvMeta,
  } = useAiStore();

  // 独立浮动窗（windowChrome）拖动：macOS 无边框窗口下 data-tauri-drag-region 自动注入常失效，
  // 仿 PinWindow 在 mousedown 时显式调用 startDragging()；仅 windowChrome 模式启用，
  // 命中按钮（历史/关闭/⏻/主题）时不拖动，避免吞点击。
  const startDrag = useCallback((e: React.MouseEvent) => {
    if (!windowChrome) return;
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    getCurrentWindow().startDragging().catch(() => {});
  }, [windowChrome]);

  const [goal, setGoal] = useState('');
  // 思考过程卡片默认展开（流式期间实时可见），可折叠收起
  const [thinkOpen, setThinkOpen] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedRich, setCopiedRich] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  // 应用内预览层 HTML（Tauri 环境替代 window.open 弹窗；null 表示未打开）
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  // 面板内富文本二次编辑：编辑态下用 textarea 改 markdown 源码，完成后写回 output（setOutput 同步会话与落盘）
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [exportErr, setExportErr] = useState(false);
  // 导出成功后，记忆"上一次导出文件路径"，供"在 Finder 中显示"按钮使用。
  // 跨 6 种格式复用：用户点过哪个格式的 reveal，下一次该格式成功后仍能 reveal。
  // P1-2：持久化到 localStorage，重开应用后仍可定位上次导出。
  const LAST_EXPORT_KEY = 'snapcraft-ai-last-exported-path';
  const [lastExportedPath, setLastExportedPath] = useState<string | null>(() => {
    try { return localStorage.getItem(LAST_EXPORT_KEY); } catch { return null; }
  });
  // 历史库导出的落盘路径（与实时导出区区分，让「在 Finder 显示 / 打开文件」双按钮出现在历史阅读器内，
  // 而非挤在实时导出区，避免用户从历史区导出后找不到对应操作按钮）。
  // P1-2：同样持久化，重开应用后历史阅读器仍可定位上次导出。
  const HIST_EXPORT_KEY = 'snapcraft-ai-last-history-exported-path';
  const [historyExportedPath, setHistoryExportedPath] = useState<string | null>(() => {
    try { return localStorage.getItem(HIST_EXPORT_KEY); } catch { return null; }
  });
  const [exporting, setExporting] = useState(false);
  // 流式输出独立弹出框（解决右侧抽屉太局促的体验问题）：
  //   popupOpen：本组件实例内的显示状态；由 isStreaming 自动驱动首次出现
  //   popupDismissed：用户主动关闭后，本轮流式期间不再自动弹（用户可点 📌 钉住恢复）
  //   popupPinned：用户主动钉住后，每次流式都自动弹（持久化到 localStorage）
  const [popupOpen, setPopupOpen] = useState(false);
  const [popupDismissed, setPopupDismissed] = useState(false);
  const [popupPinned, setPopupPinned] = useState<boolean>(() => {
    try { return localStorage.getItem('snapcraft-ai-popup-pinned') === '1'; } catch { return false; }
  });
  // 回写截图反馈
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  // AI 智能编辑模式：开启后「生成」走 Agent 工具循环（需宿主提供 aiTools）
  const [agentMode, setAgentMode] = useState(false);
  // 隐私哨兵模式：Agent 的「仅打码」变体（与智能编辑互斥）
  const [sentinelMode, setSentinelMode] = useState(false);

  // 新需求-8：导出历史下拉（最近 20 条落盘导出，可 revealInFolder）
  const [showExportHistory, setShowExportHistory] = useState(false);
  const [exportHistoryList, setExportHistoryList] = useState<ExportHistoryItem[]>([]);

  // 多轮对话：跟随截图上下文切换对话线程（每个截图一份独立对话，互不干扰）
  useEffect(() => {
    setConvKey(convHash(imageDataUrl));
  }, [imageDataUrl, setConvKey]);

  // 切换/打开截图时恢复该截图之前选择的多截图章节顺序（关闭面板不丢失，gap ⑦ 修复）
  useEffect(() => {
    setSelectedOrder(loadSel(convHash(imageDataUrl)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageDataUrl]);

  // 实际发送给模型的视觉内容：优先用「编辑后截图」，否则回退原始截图
  const visionImg = visionImageUrl || imageDataUrl;

  // 后续轮追问输入
  const [follow, setFollow] = useState('');
  // 长期记忆展开
  const [showMem, setShowMem] = useState(false);
  // 记忆编辑态：正在编辑的记忆 id + 草稿（摘要 / 重要性）
  const [editMemId, setEditMemId] = useState<string | null>(null);
  const [editSummary, setEditSummary] = useState('');
  const [editImportance, setEditImportance] = useState(3);

  // 多截图成稿 / 图文报告：按选择顺序排列（决定报告里的章节顺序）
  const [showAttach, setShowAttach] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<string[]>([]);
  // 拖拽重排：当前被拖动项在 selectedOrder 中的下标（图文报告章节顺序）
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  // 上移 / 下移：调整已选截图顺序（决定报告章节顺序）
  const moveSel = (id: string, dir: -1 | 1) => {
    setSelectedOrder((prev) => {
      const i = prev.indexOf(id);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      saveSel(convHash(imageDataUrl), next);
      return next;
    });
  };
  // 移除某张已选截图
  const removeSel = (id: string) =>
    setSelectedOrder((prev) => {
      const next = prev.filter((x) => x !== id);
      saveSel(convHash(imageDataUrl), next);
      return next;
    });
  // 拖拽释放在目标位：把 dragIdx 项移动到 toIdx。
  // 注意：先 splice 移除被拖项会使后续索引整体左移一位；当 dragIdx < toIdx 时，
  // 需用 toIdx-1 作为插入点，否则会落到放置点下方一位（off-by-one）。
  const onDropAt = (toIdx: number) => {
    if (dragIdx === null || dragIdx === toIdx) {
      setDragIdx(null);
      return;
    }
    setSelectedOrder((prev) => {
      const next = prev.slice();
      const [item] = next.splice(dragIdx, 1);
      const insertAt = dragIdx < toIdx ? toIdx - 1 : toIdx;
      next.splice(insertAt, 0, item);
      saveSel(convHash(imageDataUrl), next);
      return next;
    });
    setDragIdx(null);
  };

  // 自定义模板管理
  const [showTemplates, setShowTemplates] = useState(false);
  const [editing, setEditing] = useState<UserPreset | null>(null);

  // ── Phase 11：跨截图 AI 文档历史库 ──
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<AiConvMeta[]>([]);
  const [activeConv, setActiveConv] = useState<{ meta: AiConvMeta; conv: AiChatTurn[] } | null>(null);
  const [historySearch, setHistorySearch] = useState('');
  const [historyMsg, setHistoryMsg] = useState<string | null>(null);

  // 打开历史库：即时读取索引并倒序
  const openHistory = () => {
    setHistoryList(listConvMeta());
    setActiveConv(null);
    setHistorySearch('');
    setHistoryMsg(null);
    setShowHistory(true);
  };
  // 进入阅读器：取回完整对话线程
  const openConvReader = (meta: AiConvMeta) => {
    setActiveConv({ meta, conv: getConvByHash(meta.hash) });
  };
  // 历史阅读器里的「载入对话」：把该线程载入当前面板继续追问
  const loadConvIntoPanel = (hash: string) => {
    setConvKey(hash);
    setShowHistory(false);
    setHistoryMsg(t('ai.historyLoaded'));
  };
  // 删除某条历史（带二次确认，防止单条误删）
  const removeConv = (hash: string) => {
    if (!window.confirm(t('ai.historyConfirmDelete'))) return;
    deleteConv(hash);
    setHistoryList(listConvMeta());
    if (activeConv?.meta.hash === hash) setActiveConv(null);
    setHistoryMsg(t('ai.historyDeleted'));
  };
  // 历史阅读器里当前展示的「末轮 AI 成稿」
  const activeDoc =
    activeConv && activeConv.conv.length
      ? (() => {
          for (let i = activeConv.conv.length - 1; i >= 0; i--) {
            if (activeConv.conv[i].role === 'assistant') return activeConv.conv[i].content;
          }
          return '';
        })()
      : '';

  // 历史阅读器里的文本导出（Phase 19-B5：docx/pdf/html 附带来源截图缩略图作为封面证据）
  const handleHistoryExport = async (
    fmt: 'md' | 'txt' | 'html' | 'xlsx' | 'docx' | 'pptx' | 'pdf',
  ) => {
    if (!activeConv) return;
    const md = stripSnapMarkers(activeDoc);
    const baseName = `snapcraft-ai-${Date.now()}`;
    // Phase 19-B5：把会话对应的截图缩略图作为封面/首章插图。仅 docx/pdf/html 使用。
    const thumb = activeConv.meta.thumb;
    const coverImages =
      thumb && (fmt === 'docx' || fmt === 'pdf' || fmt === 'html' || fmt === 'pptx')
        ? [{ dataUrl: thumb, caption: activeConv.meta.firstGoal || undefined }]
        : undefined;
    try {
      if (fmt === 'xlsx') {
        const bytes = await markdownToXlsx(md, activeConv.meta.presetName);
        const path = await pickExportPath({
          ext: 'xlsx',
          hint: deriveFileHint(activeConv.meta.firstGoal),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }],
        });
        if (!path) return;
        await invoke('save_binary_file', { bytes: Array.from(bytes), filePath: path });
        setHistoryMsg(t('ai.exportOk', { path: baseNameOf(path) }));
        setLastExportedPath(path);
        setHistoryExportedPath(path);
        pushExportHistory({ path, format: 'xlsx', title: firstHeading(md) || activeConv.meta.firstGoal, time: Date.now() });
      } else if (fmt === 'docx') {
        // 历史成稿已无 <!--SNAP:k--> 标记，缩略图须作为「前置整块」内嵌（images），
        // 而非 sectionImages（无标记时 sectionImages 永不触发 → 缩略图静默丢失）。
        const bytes = await markdownToDocx(md, {
          title: firstHeading(md) || activeConv.meta.presetName,
          images: coverImages,
        });
        const path = await pickExportPath({
          ext: 'docx',
          hint: deriveFileHint(activeConv.meta.firstGoal),
          filters: [{ name: 'Word', extensions: ['docx'] }],
        });
        if (!path) return;
        await invoke('save_binary_file', { bytes: Array.from(bytes), filePath: path });
        setHistoryMsg(t('ai.exportOk', { path: baseNameOf(path) }));
        setLastExportedPath(path);
        setHistoryExportedPath(path);
        pushExportHistory({ path, format: 'docx', title: firstHeading(md) || activeConv.meta.firstGoal, time: Date.now() });
      } else if (fmt === 'pdf') {
        let html = mdToHtml(md, {
          title: firstHeading(md) || activeConv.meta.presetName,
          subtitle: activeConv.meta.firstGoal,
          tocTitle: t('ai.toc'),
          theme: config.theme,
        });
        // 历史成稿无 SNAP 标记，缩略图作为「前置整块」内嵌（与实时导出一致）。
        // 与实时导出一致：截图整块前置到正文顶部（<main class="doc-main"> 前），
        // 而非丢在 </body> 之前的 footer 之后——历史库导出的 html/pdf 此前位置与实时导出错乱。
        if (coverImages && coverImages.length) {
          const block = frontImageBlockHtml(coverImages);
          if (block) html = html.replace('<main class="doc-main">', block + '<main class="doc-main">');
        }
        const err = await printHtmlViaIframe(html);
        if (err) {
          setHistoryMsg(t('ai.exportFail', { msg: err }));
          return;
        }
        // PDF 为打印式导出，不落盘具体文件，故给诚实提示而非假文件名（避免误导 + 无法「在 Finder 中显示」）
        setHistoryMsg(t('ai.exportPdfHint'));
      } else if (fmt === 'pptx') {
        // 历史成稿无 <!--SNAP:k--> 标记：缩略图作为「前置整块」内嵌（images），与实时导出一致。
        const bytes = markdownToPptx(md, {
          title: firstHeading(md) || activeConv.meta.presetName,
          subtitle: activeConv.meta.firstGoal,
          theme: config.theme,
          sectionImages: [],
          images: coverImages || [],
        });
        const path = await pickExportPath({
          ext: 'pptx',
          hint: deriveFileHint(activeConv.meta.firstGoal),
          filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
        });
        if (!path) return;
        await invoke('save_binary_file', { bytes: Array.from(bytes), filePath: path });
        setHistoryMsg(t('ai.exportOk', { path: baseNameOf(path) }));
        setHistoryExportedPath(path);
        pushExportHistory({ path, format: 'pptx', title: firstHeading(md) || activeConv.meta.firstGoal, time: Date.now() });
      } else {
        let content: string;
        if (fmt === 'html') {
          let html = mdToHtml(md, {
            title: firstHeading(md) || activeConv.meta.presetName,
            subtitle: activeConv.meta.firstGoal,
            tocTitle: t('ai.toc'),
            theme: config.theme,
          });
          // 历史成稿无 SNAP 标记，缩略图作为「前置整块」内嵌（与实时导出一致），
          // 与实时导出一致：截图整块前置到正文顶部（<main class="doc-main"> 前），
          // 否则历史导出的 html 把截图丢在 footer 之后，与实时导出位置错乱。
          if (coverImages && coverImages.length) {
            const block = frontImageBlockHtml(coverImages);
            if (block) html = html.replace('<main class="doc-main">', block + '<main class="doc-main">');
          }
          content = html;
        } else if (fmt === 'md') {
          content = md;
        } else {
          content = mdToPlainText(md);
        }
        const path = await pickExportPath({
          ext: fmt,
          hint: deriveFileHint(activeConv.meta.firstGoal),
          filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }],
        });
        if (!path) return;
        await invoke('save_text_file', { content, filePath: path });
        setHistoryMsg(t('ai.exportOk', { path: baseNameOf(path) }));
        setLastExportedPath(path);
        setHistoryExportedPath(path);
        pushExportHistory({ path, format: fmt, title: firstHeading(md) || activeConv.meta.firstGoal, time: Date.now() });
      }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setHistoryMsg(t('ai.exportFail', { msg }));
    }
  };

  // 历史阅读器：把会话打包成便携 zip（成稿 md + 原始对话 json + 来源截图 + README）
  const handleHistoryZip = async () => {
    if (!activeConv) return;
    try {
      const enc = new TextEncoder();
      const files: { name: string; data: Uint8Array }[] = [];
      const md = stripSnapMarkers(activeDoc);
      files.push({ name: 'conversation.md', data: enc.encode(md) });
      files.push({
        name: 'conversation.json',
        data: enc.encode(JSON.stringify(activeConv.conv, null, 2)),
      });
      const thumb = activeConv.meta.thumb;
      if (thumb) {
        const bytes = dataUrlToBytes(thumb);
        if (bytes) files.push({ name: 'source.png', data: bytes });
      }
      const readme = [
        'SnapCraft AI 会话归档',
        `预设: ${activeConv.meta.presetName}`,
        `首轮目标: ${activeConv.meta.firstGoal || '(空)'}`,
        `消息数: ${activeConv.meta.msgCount}`,
        `更新时间: ${new Date(activeConv.meta.updatedAt).toLocaleString()}`,
        activeConv.meta.parent ? `分支自: ${activeConv.meta.parent}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      files.push({ name: 'README.txt', data: enc.encode(readme) });
      const zip = buildZip(files);
      const path = await pickExportPath({
        ext: 'zip',
        hint: activeConv ? deriveFileHint(activeConv.meta.firstGoal) : '',
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (!path) return;
      await invoke('save_binary_file', { bytes: Array.from(zip), filePath: path });
      setHistoryMsg(t('ai.exportOk', { path: baseNameOf(path) }));
      setLastExportedPath(path);
      pushExportHistory({ path, format: 'zip', title: activeConv.meta.firstGoal || 'Archive', time: Date.now() });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setHistoryMsg(t('ai.exportFail', { msg }));
    }
  };

  const isStreaming = status === 'streaming';
  const hasOutput = !!output && !isStreaming && status !== 'error';

  // 新需求-7：文档统计（字数 / 行数 / 阅读时长）——仅在生成完成时计算
  const stats = useMemo(() => (output ? docStats(output) : null), [output]);
  // 新需求-9：导出文件名预览——用 goal 推导默认文件名（docx 为代表格式），
  // 随 goal 变化更新；时间戳在 goal 变化时冻结一次，避免每次渲染抖动。
  const exportNamePreview = useMemo(() => {
    const full = buildDefaultPath({ ext: 'docx', hint: deriveFileHint(goal) });
    return baseNameOf(full);
  }, [goal]);

  // AI 工具循环（打码/画框等）在主窗口真实执行后，自动让主窗口重算「编辑后截图」
  // 并推回本窗口，使 AI 侧视觉与主画布一致（解决「产物推出后看不到预览」的体感）。
  // 仅在流式结束（streaming→done/error）时刷一次，避免哨兵多区域连发时反复重跑 OCR。
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current === 'streaming' && status !== 'streaming') {
      requestRefresh();
      notifyAiCommit();
    }
    prevStatusRef.current = status;
  }, [status]);

  // 流式输出独立弹出框：自动弹出策略
  //  - 流式开始时（isStreaming 变 true）：钉住 OR 首次（未 dismiss 过）→ 自动弹
  //  - 流式结束时（isStreaming 变 false）：让用户读一会（保持 popup 可见 1.2s 后自动关闭）
  //  - 用户主动关：本次流式期间不再弹（除非钉住）
  useEffect(() => {
    if (isStreaming) {
      if (popupPinned || !popupDismissed) {
        setPopupOpen(true);
      }
    } else {
      // 流式结束：延时关闭，让用户看到「生成完毕」状态
      const t = setTimeout(() => setPopupOpen(false), 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [isStreaming, popupPinned, popupDismissed]);
  // 切换截图/清空对话时重置 dismiss 标志，让下一次流式再次弹
  useEffect(() => {
    setPopupDismissed(false);
  }, [convKey]);

  // P1-2：lastExportedPath / historyExportedPath 持久化——变更时同步写 localStorage，
  // 重开应用后「在 Finder 显示 / 打开文件」仍可定位上次导出。失败静默不影响主流程。
  useEffect(() => {
    try {
      if (lastExportedPath) localStorage.setItem(LAST_EXPORT_KEY, lastExportedPath);
      else localStorage.removeItem(LAST_EXPORT_KEY);
    } catch { /* 忽略 */ }
  }, [lastExportedPath]);
  useEffect(() => {
    try {
      if (historyExportedPath) localStorage.setItem(HIST_EXPORT_KEY, historyExportedPath);
      else localStorage.removeItem(HIST_EXPORT_KEY);
    } catch { /* 忽略 */ }
  }, [historyExportedPath]);

  // P1-3：导出成功反馈自动消失（4s）——成功消息停留过久会让用户误以为还在导出。
  // 错误消息（exportErr=true）保留，需用户手动关闭或下次操作清空。
  useEffect(() => {
    if (!exportMsg || exportErr) return;
    const timer = setTimeout(() => setExportMsg(null), 4000);
    return () => clearTimeout(timer);
  }, [exportMsg, exportErr]);

  // 历史库：按关键词过滤（标题 / 预设名 / 预览内容），不区分大小写
  const filteredList = (() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return historyList;
    return historyList.filter((m) =>
      `${m.firstGoal} ${m.presetName} ${m.preview}`.toLowerCase().includes(q),
    );
  })();

  if (!open) return null;

  const presets = allPresets();
  const activePreset = resolvePreset(activePresetId);

  // ===== 多截图历史加载 =====
  const loadHistory = async () => {
    if (historyLoading) return;
    setHistoryLoading(true);
    try {
      const items = await invoke<HistoryItem[]>('get_history');
      // 排除与当前截图相同的条目，避免重复发送
      const filtered = items.filter((it) => it.data_url && it.data_url !== imageDataUrl);
      setHistory(filtered);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const toggleAttach = () => {
    const next = !showAttach;
    setShowAttach(next);
    if (next && history.length === 0) loadHistory();
  };

  const toggleHistoryItem = (id: string) => {
    setSelectedOrder((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      saveSel(convHash(imageDataUrl), next);
      return next;
    });
  };

  // ===== 生成（首轮） =====
  const handleGenerate = () => {
    setTestMsg(null);
    // 无目标时不动作，避免误清空已有对话（footgun 修复）
    if (!goal.trim()) return;
    // 已有对话则先确认清空（修复前：静默清空 → 多轮打磨成果误丢，无撤销）。
    // window.confirm 在 Tauri webview 中正常生效，零依赖。
    if (conversation.length && !window.confirm(t('ai.confirmRegenerate'))) return;
    if (conversation.length) clearConversation();
    // P1-4：report 预设强制附带截图（与 handleMakeReport 一致），
    // 避免用户手动选 report 预设 + 取消勾选 → AI 输出 SNAP:k 标记但导出时无图。
    if (activePreset.id === 'report') {
      setAttachImage(true);
    }
    const selected = selectedOrder
      .map((id) => history.find((it) => it.id === id))
      .filter((it): it is HistoryItem => !!it);
    const extraImages = selected.map((it) => it.data_url);
    const extraOcr = selected.map((it) => it.ocr_text);
    generate({
      preset: activePreset,
      goal,
      imageDataUrl: visionImg,
      ocrText,
      images: extraImages,
      ocrTexts: extraOcr,
    });
    // 修复：goal 输入框生成后清空，与 follow 输入框行为对齐，
    // 避免「上次的 goal 残留 → 误以为已有内容 → 不再输入 → 再次点击仍是旧 prompt」。
    // 用户如需复用可从历史库点回该会话（hasOutput 路径）。
    setGoal('');
  };

  // 按「当前截图 + 已选附加（选择顺序）」拼出报告章节对应的有序图片列表
  const orderedImages = (): DocxImage[] => {
    const imgs: DocxImage[] = [];
    // agent / 隐私哨兵模式下「附上原图」勾选框恒显示已勾选（见操作区复选框），
    // 故此处一并强制包含当前截图，避免"勾选了却导出丢图"的视觉与结果矛盾。
    if ((attachImage || agentMode || sentinelMode) && visionImg) {
      imgs.push({ dataUrl: visionImg, caption: t('ai.embedCurrent') });
    }
    selectedOrder.forEach((id, idx) => {
      const it = history.find((h) => h.id === id);
      if (it) imgs.push({ dataUrl: it.data_url, caption: t('ai.embedExtra', { n: idx + 1 }) });
    });
    return imgs;
  };

  // ===== 一键成报告（图文混排）=====
  // 强制携带当前截图与识别文字，确保章节标记 <!--SNAP:k--> 与图片顺序严格对应。
  const handleMakeReport = () => {
    setTestMsg(null);
    // 无目标时不动作（与 handleGenerate 一致的 footgun 守卫）
    if (!goal.trim()) return;
    if (conversation.length) clearConversation();
    setAttachImage(true);
    setAttachOcr(true);
    setActivePreset('report');
    const selected = selectedOrder
      .map((id) => history.find((it) => it.id === id))
      .filter((it): it is HistoryItem => !!it);
    const extraImages = selected.map((it) => it.data_url);
    const extraOcr = selected.map((it) => it.ocr_text);
    generate({
      preset: resolvePreset('report'),
      goal,
      imageDataUrl: visionImg,
      ocrText,
      images: extraImages,
      ocrTexts: extraOcr,
    });
  };

  // ===== AI 智能编辑 / 隐私哨兵（Phase 14/21：Agent 工具循环）=====
  const handleAgentRun = () => {
    setTestMsg(null);
    if (!aiTools) return;
    const isSentinel = sentinelMode;
    // 隐私哨兵允许目标为空：自动用默认指令「扫描并打码所有敏感信息」
    const effectiveGoal = goal.trim() || (isSentinel ? t('ai.sentinelDefaultGoal') : '');
    if (!effectiveGoal) return;
    // 已有对话则先清空，确保 Agent 从当前截图重新规划编辑与文档
    if (conversation.length) clearConversation();
    runAgent({
      preset: activePreset,
      goal: effectiveGoal,
      imageDataUrl: visionImg,
      ocrText,
      images: [],
      ocrTexts: [],
      host: aiTools,
      agentKind: isSentinel ? 'sentinel' : 'edit',
    });
  };

  // 工具步骤的简短参数摘要（坐标 / 标签）
  const stepArgsSummary = (args: Record<string, any>): string => {
    if (args.label) return `“${args.label}”`;
    const f = (v: any) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? ''));
    return `(${f(args.x)}, ${f(args.y)}) ${f(args.w)}×${f(args.h)}`;
  };

  // ===== 多轮追问（后续轮，纯文本迭代） =====
  const handleFollow = () => {
    const msg = follow.trim();
    if (!msg || isStreaming) return;
    setExportMsg(null);
    setFollow('');
    chat(msg, {
      preset: activePreset,
      imageDataUrl: visionImg,
      ocrText,
      images: [],
      ocrTexts: [],
    });
  };

  const handleCopy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 忽略复制失败 */
    }
  };

  // 复制为富文本：把 Markdown 渲染成 HTML 片段，以 text/html 写入剪贴板，
  // 粘贴到 Word / 邮件 / 富文本编辑器时保留结构（标题/列表/表格/引用/代码），
  // 而非裸 Markdown 源码（带 **、| 等标记）。text/plain 兜底为 Markdown 源码。
  const handleCopyRich = async () => {
    if (!output) return;
    try {
      const hasSec = hasSnapMarkers(output);
      const clean = stripSnapMarkers(output);
      // 图文报告（含 <!--SNAP:k-->）必须传「未剥离标记」的原文给渲染器——
      // 渲染器据标记内嵌对应截图；若先 strip 掉标记，sectionImages 永不触发 → 富文本复制丢图。
      const source = hasSec ? output : clean;
      let html = mdToHtml(source, {
        fragment: true,
        sectionImages: hasSec ? orderedImages() : undefined,
        theme: config.theme,
      });
      // 纯文档（无章节标记）同样把来源截图整块前置内嵌，与「导出 / 预览」行为对齐，
      // 否则粘贴到 Word / 邮件的纯文档看不到截图证据。
      if (!hasSec) {
        const imgs = orderedImages();
        if (imgs.length) {
          const imgHtml = imgs
            .map(
              (im) =>
                `<figure class="doc-fig"><img class="doc-img" src="${im.dataUrl}" alt="" /><figcaption class="doc-cap">${im.caption ?? ''}</figcaption></figure>`,
            )
            .join('');
          html = imgHtml + html;
        }
      }
      const htmlBlob = new Blob([html], { type: 'text/html' });
      const textBlob = new Blob([clean], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': htmlBlob,
          'text/plain': textBlob,
        }),
      ]);
      setCopiedRich(true);
      setTimeout(() => setCopiedRich(false), 1500);
    } catch {
      /* 忽略复制失败（如剪贴板权限受限、环境不支持 ClipboardItem） */
    }
  };

  // 用系统默认应用打开已导出的文件。
  // 调用后端 open_external 命令（open.rs），内部对本地文件路径走 opener 插件的 open_path，
  // 对 URL 走 open_url，已正确注册在 invoke_handler。
  const openExported = async (path: string) => {
    if (!path) return;
    try {
      await invoke('open_external', { target: path });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setExportMsg(t('ai.exportFail', { msg }));
      setExportErr(true);
    }
  };

  // 进入/退出「编辑文档」态：进入时把当前 output 载入草稿 textarea；
  // 完成（退出）时写回 store——setOutput 会同步对话线程末条 assistant 并落盘，保证「编辑→重导」与「重开恢复」同源。
  // 编辑后同步刷新历史索引（preview/updatedAt），否则历史库列表仍显示旧预览。
  const handleToggleEdit = () => {
    if (isEditing) {
      setOutput(editDraft);
      // 同步历史索引：用新 output 生成最新 preview（activePreset 维持原值，不变）
      const st = useAiStore.getState();
      if (st.convKey && st.conversation.length) {
        recordConvMeta(st.convKey, st.conversation, activePreset, undefined, '');
      }
      setIsEditing(false);
    } else {
      setEditDraft(output ?? '');
      setIsEditing(true);
    }
  };

  // 取消编辑：丢弃草稿改动，回到预览态（不写回）
  const handleCancelEdit = () => {
    setEditDraft('');
    setIsEditing(false);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      await chatOnce({
        config,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'ping' },
        ],
      });
      setTestMsg(t('ai.testOk'));
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setTestMsg(t('ai.testFail', { msg }));
    } finally {
      setTesting(false);
    }
  };

  // 导出为文件（复用 Rust save_text_file，零新后端）
  const handleExport = async (fmt: 'md' | 'txt' | 'html') => {
    if (!output || exporting) return;
    // 含章节标记时，把「未剥离标记」的原文交给 HTML 渲染器（渲染器据标记内嵌截图）；
    // .md / .txt 仍需剥离标记保持干净。
    const hasSec = hasSnapMarkers(output);
    const clean = stripSnapMarkers(output);
    const isHtml = fmt === 'html';
    let content: string;
    if (isHtml) {
      let html = mdToHtml(hasSec ? output : clean, {
        title: firstHeading(hasSec ? output : clean) || presetLabel(activePreset),
        subtitle: goal,
        tocTitle: t('ai.toc'),
        sectionImages: hasSec ? orderedImages() : undefined,
        theme: config.theme,
      });
      // 回退：纯文档（无章节标记）也把来源截图整块内嵌到正文前（顶部），与 DOCX/PPTX 行为对齐，
      // 否则「导出的 HTML 把截图丢在底部、而 docx 在顶部」会造成明显的导出位置不一致。
      if (!hasSec) {
        const block = frontImageBlockHtml(orderedImages());
        if (block) html = html.replace('<main class="doc-main">', block + '<main class="doc-main">');
      }
      content = html;
    } else {
      content = fmt === 'md' ? clean : mdToPlainText(clean);
    }
    const path = await pickExportPath({
      ext: fmt,
      hint: deriveFileHint(goal),
      filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }],
    });
    if (!path) return;
    try {
      await invoke('save_text_file', { content, filePath: path });
      const name = baseNameOf(path);
      setExportMsg(t('ai.exportOk', { path: name }));
      setExportErr(false);
      setLastExportedPath(path);
      pushExportHistory({ path, format: fmt, title: firstHeading(output) || goal, time: Date.now() });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setExportMsg(t('ai.exportFail', { msg }));
      setExportErr(true);
    }
  };

  // 导出真实 Word(.docx)：Markdown → docx，并按章节标记把来源截图内嵌到对应小节前
  // （图文报告）；未含标记时回退为整块前置内嵌（截图工具独有价值）。
  const handleExportDocx = async () => {
    if (!output || exporting) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const useSections = hasSnapMarkers(output);
      const imgs = orderedImages();
      // 含章节标记时同样把未剥离的原文交给 docx 渲染器（渲染器据标记内嵌章节截图）
      const bytes = await markdownToDocx(useSections ? output : stripSnapMarkers(output), {
        title: firstHeading(useSections ? output : stripSnapMarkers(output)) || presetLabel(activePreset),
        subtitle: goal,
        theme: config.theme,
        tocTitle: t('ai.toc'),
        sectionImages: useSections ? imgs : [],
        images: useSections ? [] : imgs,
      });
      const path = await pickExportPath({
        ext: 'docx',
        hint: deriveFileHint(goal),
        filters: [{ name: 'Word', extensions: ['docx'] }],
      });
      if (!path) {
        setExporting(false);
        return;
      }
      await invoke('save_binary_file', { bytes: Array.from(bytes), filePath: path });
      const name = baseNameOf(path);
      setExportMsg(t('ai.exportOk', { path: name }));
      setExportErr(false);
      setLastExportedPath(path);
      pushExportHistory({ path, format: 'docx', title: firstHeading(output) || goal, time: Date.now() });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setExportMsg(t('ai.exportFail', { msg }));
      setExportErr(true);
    } finally {
      setExporting(false);
    }
  };

  // 导出 PowerPoint(.pptx)：Markdown 按 #/## 标题断页成幻灯片（手搓 OOXML+ZIP，零依赖）。
  // 图文报告：含 SNAP 标记时按标记把对应截图内嵌到对应幻灯片；否则整块前置内嵌（对齐 docx 行为）。
  const handleExportPptx = async () => {
    if (!output || exporting) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const useSections = hasSnapMarkers(output);
      const imgs = orderedImages();
      const bytes = markdownToPptx(useSections ? output : stripSnapMarkers(output), {
        title: firstHeading(useSections ? output : stripSnapMarkers(output)) || presetLabel(activePreset),
        subtitle: goal,
        theme: config.theme,
        sectionImages: useSections ? imgs : [],
        images: useSections ? [] : imgs,
      });
      const path = await pickExportPath({
        ext: 'pptx',
        hint: deriveFileHint(goal),
        filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
      });
      if (!path) {
        setExporting(false);
        return;
      }
      await invoke('save_binary_file', { bytes: Array.from(bytes), filePath: path });
      const name = baseNameOf(path);
      setExportMsg(t('ai.exportOk', { path: name }));
      setExportErr(false);
      setLastExportedPath(path);
      pushExportHistory({ path, format: 'pptx', title: firstHeading(output) || goal, time: Date.now() });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setExportMsg(t('ai.exportFail', { msg }));
      setExportErr(true);
    } finally {
      setExporting(false);
    }
  };

  // 导出 Excel(.xlsx)：Markdown 表格 → 可编辑电子表格（与 privdoc-ai 的 xlsx 导出对齐）。
  // 文档含表格时按表生成多 sheet；无表格时回退为「内容」sheet（每行一段），保证任何结果都能落地成 Excel。
  // 截图工具的独有价值：配合「提取表格」预设，把截图里的数据/表格一键变成可编辑 Excel。
  const handleExportXlsx = async () => {
    if (!output || exporting) return;
    setExporting(true);
    setExportMsg(null);
    try {
      const md = stripSnapMarkers(output);
      const bytes = markdownToXlsx(md, presetLabel(activePreset));
      const path = await pickExportPath({
        ext: 'xlsx',
        hint: deriveFileHint(goal),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      });
      if (!path) {
        setExporting(false);
        return;
      }
      await invoke('save_binary_file', { bytes: Array.from(bytes), filePath: path });
      const name = baseNameOf(path);
      setExportMsg(t('ai.exportOk', { path: name }));
      setExportErr(false);
      setLastExportedPath(path);
      pushExportHistory({ path, format: 'xlsx', title: firstHeading(output) || goal, time: Date.now() });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setExportMsg(t('ai.exportFail', { msg }));
      setExportErr(true);
    } finally {
      setExporting(false);
    }
  };

  // 导出 PDF：复用 mdToHtml 渲染（含章节内嵌截图），再用隐藏 iframe 触发打印（可「另存为 PDF」）
  const handleExportPdf = async () => {
    if (!output || exporting) return;
    // P1-1/P1-9：与其他 5 种格式对齐——设 loading 态 + finally 收尾，
    // 用户点击后立即有「导出中」反馈，异常时也统一复位 exporting。
    setExporting(true);
    setExportMsg(null);
    try {
      const useSections = hasSnapMarkers(output);
      const imgs = orderedImages();
      const md = useSections ? output : stripSnapMarkers(output);
      let html = mdToHtml(md, {
        title: firstHeading(md) || presetLabel(activePreset),
        subtitle: goal,
        tocTitle: t('ai.toc'),
        sectionImages: useSections ? imgs : undefined,
        theme: config.theme,
      });
      if (!useSections) {
        // 回退：把全部截图整块内嵌到正文前（顶部，沿用主题化 .doc-fig 样式），与 DOCX/PPTX 对齐
        const block = frontImageBlockHtml(imgs);
        if (block) html = html.replace('<main class="doc-main">', block + '<main class="doc-main">');
      }
      const err = await printHtmlViaIframe(html);
      if (err) {
        setExportMsg(t('ai.exportFail', { msg: err }));
        setExportErr(true);
        return;
      }
      // PDF 是「打印式」导出：文件由用户在系统打印弹窗里「存储为 PDF」落地，
      // 应用拿不到最终路径，所以只给诚实提示、不写 lastExportedPath（避免「在 Finder 中显示」指向不存在文件）。
      setExportMsg(t('ai.exportPdfHint'));
      setExportErr(false);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setExportMsg(t('ai.exportFail', { msg }));
      setExportErr(true);
    } finally {
      setExporting(false);
    }
  };

  // 预览：把主题化 HTML 打开预览。Tauri 环境 window.open 弹窗会被 webview 拦截，
  // 改用应用内 iframe(srcDoc) 预览层（同源、必被允许），零 Rust、不依赖临时文件；
  // 纯前端 dev 环境保留 Blob + 新标签预览。
  const handlePreview = () => {
    if (!output || exporting) return;
    setExportMsg(null);
    try {
      const md = stripSnapMarkers(output);
      const useSections = hasSnapMarkers(output);
      let html = mdToHtml(md, {
        title: firstHeading(md) || presetLabel(activePreset),
        subtitle: goal,
        tocTitle: t('ai.toc'),
        sectionImages: useSections ? orderedImages() : undefined,
        theme: config.theme,
      });
      // 回退：纯文档（无章节标记）也把来源截图整块内嵌到正文前（顶部），与 DOCX/PPTX 导出、HTML 文件导出对齐，
      // 让应用内预览与最终产物视觉一致。
      if (!useSections) {
        const block = frontImageBlockHtml(orderedImages());
        if (block) html = html.replace('<main class="doc-main">', block + '<main class="doc-main">');
      }
      if (isTauri()) {
        // Tauri 运行时：应用内预览，规避 window.open 被拦截的报错
        setPreviewHtml(html);
        return;
      }
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank');
      if (!win) {
        setExportMsg(t('ai.previewBlocked'));
        setExportErr(true);
        return;
      }
      // 预览窗口加载后释放 Blob URL（延迟避免提前回收）
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setExportMsg(t('ai.exportFail', { msg }));
      setExportErr(true);
    }
  };

  // 快速润色：以上一轮结果为输入，追加润色指令再生成
  const handleRefine = (instruction: string) => {
    setExportMsg(null);
    refine(instruction);
  };

  // 回写截图：把 AI 纯文本文案作为可编辑文字标注贴回当前截图
  const handleApplyToScreenshot = () => {
    if (!onApplyToScreenshot || !output) return;
    // 先剥离「图文报告」的章节锚点标记，避免 <!--SNAP:k--> 被原样贴成图上文字
    onApplyToScreenshot(mdToPlainText(stripSnapMarkers(output)));
    setApplyMsg(t('ai.applied'));
    setTimeout(() => setApplyMsg(null), 1800);
  };

  // ===== 自定义模板 =====
  const openNewTemplate = () =>
    setEditing({ id: '', name: '', desc: '', system: '', vision: true, userBuilder: 'default' });
  const openEditTemplate = (p: UserPreset) => setEditing({ ...p });
  const saveTemplate = () => {
    if (!editing || !editing.name.trim()) return;
    const data = {
      name: editing.name.trim(),
      desc: editing.desc?.trim() ?? '',
      system: editing.system,
      vision: editing.vision,
      userBuilder: editing.userBuilder ?? 'default',
    };
    if (editing.id) updateCustomPreset({ ...data, id: editing.id });
    else addCustomPreset(data);
    setEditing(null);
  };

  return (
    <div className="ai-panel">
      <div
        className={`ai-panel-head${windowChrome ? ' ai-panel-head--win' : ''}`}
        onMouseDown={windowChrome ? startDrag : undefined}
      >
        <span className="ai-panel-title">
          {live && <span className="ai-live-dot" />}
          ✨ {t('ai.title')}
        </span>
        <div className="ai-panel-head-actions">
          <button
            type="button"
            className="ai-panel-settings-btn"
            onClick={() => setShowSettings(true)}
            title={t('ai.config')}
          >
            ⚙️ <span className="ai-panel-settings-text">{t('ai.config')}</span>
          </button>
          <button
            type="button"
            className="ai-panel-icon"
            onClick={openHistory}
            title={t('ai.historyTitle')}
          >
            📚
          </button>
          <button className="ai-panel-close" onClick={onClose} title={t('ai.close')}>
            ✕
          </button>
        </div>
      </div>

      {/* 可滚动主体：当预设/模板/附件/导出/记忆等区块较多时，整体滚动而不被裁剪 */}
      <div className="ai-panel-scroll">
      {/* 首次使用引导：apiKey 为空且无对话时显示 */}
      {!config.apiKey.trim() && conversation.length === 0 && (
        <div className="ai-welcome">
          <div className="ai-welcome-title">{t('ai.welcomeTitle')}</div>
          <div className="ai-welcome-desc">{t('ai.welcomeDesc')}</div>
          <button
            className="ai-btn ai-btn-primary ai-welcome-btn"
            onClick={() => setShowSettings(true)}
          >
            {t('ai.welcomeConfig')}
          </button>
        </div>
      )}
      {/* 生成方式预设（内置 + 自定义） */}
      <div className="ai-presets">
        {presets.map((p) => (
          <button
            key={p.id}
            className={`ai-chip${p.id === activePresetId ? ' active' : ''}`}
            title={presetDesc(p)}
            onClick={() => setActivePreset(p.id)}
          >
            {p.custom ? '★ ' : ''}
            {presetLabel(p)}
          </button>
        ))}
        <button
          className="ai-chip ai-chip-manage"
          title={t('ai.templateManage')}
          onClick={() => setShowTemplates((v) => !v)}
        >
          ✎ {t('ai.templateManage')}
        </button>
        {aiTools && (
          <button
            type="button"
            className={`ai-chip ai-chip-agent${agentMode ? ' active' : ''}`}
            title={t('ai.agentModeDesc')}
            onClick={() => {
              setAgentMode((v) => !v);
              if (!agentMode) setSentinelMode(false);
            }}
          >
            🤖 {t('ai.agentMode')}
          </button>
        )}
        {aiTools && (
          <button
            type="button"
            className={`ai-chip ai-chip-sentinel${sentinelMode ? ' active' : ''}`}
            title={t('ai.sentinelModeDesc')}
            onClick={() => {
              setSentinelMode((v) => !v);
              if (!sentinelMode) setAgentMode(false);
            }}
          >
            🔒 {t('ai.sentinelMode')}
          </button>
        )}
      </div>

      {/* 自定义模板管理面板 */}
      {showTemplates && (
        <div className="ai-tpl">
          {editing ? (
            <div className="ai-tpl-form">
              <input
                className="ai-tpl-input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder={t('ai.templateNamePh')}
              />
              <input
                className="ai-tpl-input"
                value={editing.desc}
                onChange={(e) => setEditing({ ...editing, desc: e.target.value })}
                placeholder={t('ai.templateDescPh')}
              />
              <textarea
                className="ai-tpl-textarea"
                rows={4}
                value={editing.system}
                onChange={(e) => setEditing({ ...editing, system: e.target.value })}
                placeholder={t('ai.templateInstructionPh')}
              />
              <label className="ai-check">
                <input
                  type="checkbox"
                  checked={editing.vision}
                  onChange={(e) => setEditing({ ...editing, vision: e.target.checked })}
                />
                <span>{t('ai.templateVision')}</span>
              </label>
              <select
                className="ai-tpl-input"
                value={editing.userBuilder ?? 'default'}
                onChange={(e) => setEditing({ ...editing, userBuilder: e.target.value as 'default' | 'report' })}
                title={t('ai.templateBuilder')}
              >
                <option value="default">{t('ai.templateBuilderDefault')}</option>
                <option value="report">{t('ai.templateBuilderReport')}</option>
              </select>
              <div className="ai-tpl-actions">
                <button
                  className="ai-btn ai-btn-sm ai-btn-primary"
                  onClick={saveTemplate}
                  disabled={!editing.name.trim()}
                >
                  {t('ai.templateSave')}
                </button>
                <button className="ai-btn ai-btn-sm" onClick={() => setEditing(null)}>
                  {t('ai.templateCancel')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <button className="ai-btn ai-btn-sm ai-tpl-add" onClick={openNewTemplate}>
                ＋ {t('ai.templateAdd')}
              </button>
              {customPresets.length === 0 ? (
                <div className="ai-tpl-empty">{t('ai.templateEmpty')}</div>
              ) : (
                <div className="ai-tpl-list">
                  {customPresets.map((p) => (
                    <div key={p.id} className="ai-tpl-item">
                      <span className="ai-tpl-name" title={p.desc ?? ''}>
                        ★ {p.name}
                      </span>
                      <span className="ai-tpl-item-actions">
                        <button
                          className="ai-link"
                          onClick={() => openEditTemplate(p)}
                          title={t('ai.templateEdit')}
                        >
                          {t('ai.templateEdit')}
                        </button>
                        <button
                          className="ai-link ai-link-danger"
                          onClick={() => deleteCustomPreset(p.id)}
                          title={t('ai.templateDelete')}
                        >
                          {t('ai.templateDelete')}
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 需求输入 */}
      <div className="ai-field">
        <textarea
          className="ai-textarea"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={
            sentinelMode ? t('ai.sentinelGoalPh') : agentMode ? t('ai.agentGoalPh') : t('ai.goalPh')
          }
          rows={3}
        />
      </div>

      {/* 多截图成稿 / 图文报告：从历史附加更多截图（按选择顺序组稿） */}
      <div className="ai-attach">
        <button className="ai-link" onClick={toggleAttach}>
          {showAttach ? '▾' : '▸'} 📎 {t('ai.attachMore')}
          {selectedOrder.length > 0 && (
            <span className="ai-attach-count"> · {t('ai.attachMoreCount', { n: selectedOrder.length })}</span>
          )}
        </button>
        {showAttach && (
          <div className="ai-attach-body">
            <div className="ai-attach-hint">{t('ai.attachMoreDesc')}</div>
            {historyLoading ? (
              <div className="ai-attach-meta">{t('ai.attachMoreLoading')}</div>
            ) : history.length === 0 ? (
              <div className="ai-attach-meta">{t('ai.attachMoreEmpty')}</div>
            ) : (
              <div className="ai-attach-grid">
                {history.map((it) => {
                  const selIdx = selectedOrder.indexOf(it.id);
                  const sel = selIdx >= 0;
                  return (
                    <button
                      key={it.id}
                      className={`ai-attach-thumb${sel ? ' selected' : ''}`}
                      onClick={() => toggleHistoryItem(it.id)}
                      title={it.created_at}
                    >
                      <img src={it.data_url} alt="" />
                      {sel && <span className="ai-attach-badge">{selIdx + 1}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {selectedOrder.length > 0 && (
              <div className="ai-attach-foot">
                <span className="ai-attach-foot-hint">{t('ai.selOrder')}</span>
                <button className="ai-link" onClick={() => { setSelectedOrder([]); saveSel(convHash(imageDataUrl), []); }}>
                  {t('ai.clearSel')}
                </button>
              </div>
            )}
            {/* 已选截图的有序列表：拖拽 / 箭头调整章节顺序（图文报告） */}
            {selectedOrder.length > 0 && (
              <div className="ai-attach-order">
                <div className="ai-attach-order-head">{t('ai.orderDrag')}</div>
                {selectedOrder.map((id, idx) => {
                  const it = history.find((h) => h.id === id);
                  if (!it) return null;
                  return (
                    <div
                      key={id}
                      className={`ai-attach-order-item${dragIdx === idx ? ' dragging' : ''}`}
                      draggable
                      onDragStart={() => setDragIdx(idx)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => onDropAt(idx)}
                      onDragEnd={() => setDragIdx(null)}
                    >
                      <span className="ai-attach-order-grip" title={t('ai.orderDrag')}>
                        ⠿
                      </span>
                      <span className="ai-attach-order-idx">{idx + 1}</span>
                      <img className="ai-attach-order-thumb" src={it.data_url} alt="" />
                      <div className="ai-attach-order-btns">
                        <button
                          type="button"
                          className="ai-attach-order-btn"
                          onClick={() => moveSel(id, -1)}
                          disabled={idx === 0}
                          title={t('ai.orderUp')}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="ai-attach-order-btn"
                          onClick={() => moveSel(id, 1)}
                          disabled={idx === selectedOrder.length - 1}
                          title={t('ai.orderDown')}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="ai-attach-order-btn danger"
                          onClick={() => removeSel(id)}
                          title={t('ai.orderRemove')}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 上下文选项 */}
      <div className="ai-options">
        <label
          className={`ai-check${(!imageDataUrl || agentMode || sentinelMode) ? ' disabled' : ''}`}
          title={agentMode || sentinelMode ? t('ai.attachImageAgentTitle') : undefined}
        >
          <input
            type="checkbox"
            checked={agentMode || sentinelMode ? true : attachImage}
            onChange={(e) => setAttachImage(e.target.checked)}
            disabled={!imageDataUrl || agentMode || sentinelMode}
          />
          <span title={agentMode || sentinelMode ? t('ai.attachImageAgentTitle') : t('ai.attachImageTitle')}>
            {t('ai.attachImage')}
          </span>
        </label>
        <label className={`ai-check${!ocrText ? ' disabled' : ''}`}>
          <input
            type="checkbox"
            checked={attachOcr}
            onChange={(e) => setAttachOcr(e.target.checked)}
            disabled={!ocrText}
          />
          <span title={t('ai.attachOcrTitle')}>{t('ai.attachOcr')}</span>
        </label>
        {onRefreshImage && (
          <button
            type="button"
            className="ai-btn-sm ai-btn-refresh"
            onClick={() => onRefreshImage?.()}
            title={t('ai.visionImageTitle')}
          >
            🔄 {t('ai.refreshImage')}
          </button>
        )}
      </div>

      {/* 操作 */}
      <div className="ai-actions">
        {isStreaming ? (
          <button className="ai-btn ai-btn-stop" onClick={stop}>
            {t('ai.stop')}
          </button>
        ) : (
        <button
          className="ai-btn ai-btn-primary"
          onClick={(agentMode || sentinelMode) && aiTools ? handleAgentRun : handleGenerate}
          disabled={!config.apiKey.trim() || isEditing || (!(agentMode || sentinelMode) && !goal.trim())}
        >
          {sentinelMode && aiTools
            ? t('ai.sentinelRun')
            : agentMode && aiTools
              ? t('ai.agentRun')
              : t('ai.generate')}
        </button>
        )}
        <button
          className="ai-btn ai-btn-report"
          onClick={handleMakeReport}
          disabled={!config.apiKey.trim() || !goal.trim() || isStreaming || (!imageDataUrl && selectedOrder.length === 0)}
          title={t('ai.makeReportTitle')}
        >
          📑 {t('ai.makeReport')}
        </button>
        <button className="ai-btn" onClick={handleCopy} disabled={!output || isEditing}>
          {copied ? t('ai.copied') : t('ai.copy')}
        </button>
        <button
          className="ai-btn"
          onClick={handleCopyRich}
          disabled={!output || isEditing}
          title={t('ai.copyRichTitle')}
        >
          {copiedRich ? t('ai.copied') : t('ai.copyRich')}
        </button>
        <button
          className="ai-btn"
          onClick={handleToggleEdit}
          disabled={!output || isStreaming}
          title={t('ai.editTitle')}
        >
          {isEditing ? t('ai.editDone') : t('ai.edit')}
        </button>
        <button
          className="ai-btn"
          onClick={() => {
            reset();
            setGoal('');
          }}
          disabled={isEditing}
        >
          {t('ai.clear')}
        </button>
        <button className="ai-btn" onClick={clearConversation} disabled={isStreaming || isEditing || conversation.length === 0}>
          {t('ai.newChat')}
        </button>
      </div>

      {/* 多轮对话：后续轮追问输入（生成首稿后即可逐步打磨） */}
      <div className="ai-follow">
        <textarea
          className="ai-follow-input"
          value={follow}
          onChange={(e) => setFollow(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleFollow();
            }
          }}
          placeholder={t('ai.chatPlaceholder')}
          rows={2}
        />
        <button
          className="ai-btn ai-btn-primary ai-follow-send"
          onClick={handleFollow}
          disabled={!follow.trim() || isStreaming}
        >
          {t('ai.send')}
        </button>
      </div>

      {/* 面板内富文本二次编辑区：编辑态显示 markdown 源 textarea（零依赖），完成时写回 output（setOutput 同步会话+落盘） */}
      {isEditing && (
        <div className="ai-edit-block">
          <div className="ai-edit-head">
            <span className="ai-edit-hint">{t('ai.editHint')}</span>
            <span className="ai-edit-btns">
              <button className="ai-btn ai-btn-sm ai-btn-primary" onClick={handleToggleEdit}>
                {t('ai.editDone')}
              </button>
              <button className="ai-btn ai-btn-sm" onClick={handleCancelEdit}>
                {t('ai.cancel')}
              </button>
            </span>
          </div>
          <textarea
            className="ai-edit-area"
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            rows={22}
            spellCheck={false}
          />
        </div>
      )}

      {/* 生成结果后的「导出文档 + 快速润色」迭代区（编辑态隐藏，避免用旧 output 误导出） */}
      {hasOutput && !isEditing && (
        <div className="ai-post">
          {/* 新需求-7/9：文档统计 + 导出文件名预览（导出按钮上方，小灰字一行） */}
          {stats && (
            <div className="ai-doc-stats">
              <span className="ai-doc-stats-info">
                {t('ai.stats', {
                  words: stats.words.toLocaleString(),
                  lines: stats.lines,
                  minutes: stats.minutes,
                  images: orderedImages().length,
                })}
              </span>
              <span className="ai-doc-stats-name" title={exportNamePreview}>
                {t('ai.exportNamePreview', { name: exportNamePreview })}
              </span>
            </div>
          )}
          <div className="ai-post-row">
            <span className="ai-post-label">{t('ai.export')}</span>
            <button className="ai-btn ai-btn-sm" onClick={() => handleExport('md')} disabled={exporting}>
              .md
            </button>
            <button className="ai-btn ai-btn-sm" onClick={() => handleExport('txt')} disabled={exporting}>
              .txt
            </button>
            <button className="ai-btn ai-btn-sm" onClick={() => handleExport('html')} disabled={exporting}>
              .html
            </button>
            <button
              className="ai-btn ai-btn-sm ai-btn-primary"
              onClick={handleExportXlsx}
              disabled={exporting}
              title={t('ai.exportXlsxTitle')}
            >
              {exporting ? t('ai.exporting') : '.xlsx'}
            </button>
            <button
              className="ai-btn ai-btn-sm ai-btn-primary"
              onClick={handleExportDocx}
              disabled={exporting}
              title={t('ai.exportDocxTitle')}
            >
              {exporting ? t('ai.exporting') : '.docx'}
            </button>
            <button
              className="ai-btn ai-btn-sm"
              onClick={handleExportPptx}
              disabled={exporting}
              title={t('ai.exportPptxTitle')}
            >
              {exporting ? t('ai.exporting') : '.pptx'}
            </button>
            <button className="ai-btn ai-btn-sm" onClick={handleExportPdf} disabled={exporting} title={t('ai.exportPdfTitle')}>
              .pdf
            </button>
            <button
              className="ai-btn ai-btn-sm ai-btn-preview"
              onClick={handlePreview}
              disabled={exporting}
              title={t('ai.previewTitle')}
            >
              👁 {t('ai.preview')}
            </button>
            {/* 新需求-8：导出历史入口 */}
            <button
              className="ai-btn ai-btn-sm"
              onClick={() => {
                setShowExportHistory((v) => !v);
                setExportHistoryList(listExportHistory());
              }}
              title={t('ai.exportHistory')}
            >
              📜 {t('ai.exportHistory')}
            </button>
          </div>
          {/* 新需求-8：导出历史下拉列表（最近 20 条落盘导出，可 revealInFolder） */}
          {showExportHistory && (
            <div className="ai-export-history">
              {exportHistoryList.length === 0 ? (
                <div className="ai-export-history-empty">{t('ai.exportHistoryEmpty')}</div>
              ) : (
                <>
                  {exportHistoryList.map((it, i) => (
                    <div key={`${it.path}-${i}`} className="ai-export-history-item">
                      <span className="ai-export-history-fmt">.{it.format}</span>
                      <span className="ai-export-history-name" title={it.path}>
                        {baseNameOf(it.path)}
                      </span>
                      <span className="ai-export-history-time">{fmtTime(it.time)}</span>
                      <button
                        className="ai-btn ai-btn-sm ai-btn-reveal"
                        title={t('ai.exportRevealTitle')}
                        onClick={async () => {
                          const err = await revealInFolder(it.path);
                          if (err) {
                            setExportMsg(t('ai.exportFail', { msg: err }));
                            setExportErr(true);
                          }
                        }}
                      >
                        {t('ai.exportReveal')}
                      </button>
                    </div>
                  ))}
                  <button
                    className="ai-link ai-link-danger"
                    onClick={() => {
                      clearExportHistory();
                      setExportHistoryList([]);
                    }}
                  >
                    {t('ai.exportHistoryClear')}
                  </button>
                </>
              )}
            </div>
          )}
          {/* 文档主题：选择 HTML / PDF 导出的外观（产品推广 / 杂志风等精美样式） */}
          <div className="ai-style-row">
            <span className="ai-post-label">{t('ai.style')}</span>
            {DOC_THEMES.map((th) => {
              const lang = getLang();
              const label = lang === 'zh-CN' ? th.name.zh : th.name.en;
              const desc = lang === 'zh-CN' ? th.desc.zh : th.desc.en;
              return (
                <button
                  key={th.id}
                  className={`ai-chip ai-style-chip${config.theme === th.id ? ' active' : ''}`}
                  title={desc}
                  onClick={() => setConfig({ theme: th.id })}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="ai-post-row">
            <span className="ai-post-label">{t('ai.refine')}</span>
            <button
              className="ai-chip ai-refine-chip"
              disabled={refining || isStreaming}
              onClick={() => handleRefine(t('ai.refineShorter'))}
            >
              {t('ai.refineShorter')}
            </button>
            <button
              className="ai-chip ai-refine-chip"
              disabled={refining || isStreaming}
              onClick={() => handleRefine(t('ai.refineLonger'))}
            >
              {t('ai.refineLonger')}
            </button>
            <button
              className="ai-chip ai-refine-chip"
              disabled={refining || isStreaming}
              onClick={() => handleRefine(t('ai.refineFormal'))}
            >
              {t('ai.refineFormal')}
            </button>
            <button
              className="ai-chip ai-refine-chip"
              disabled={refining || isStreaming}
              onClick={() => handleRefine(t('ai.refineCasual'))}
            >
              {t('ai.refineCasual')}
            </button>
            <button
              className="ai-chip ai-refine-chip"
              disabled={refining || isStreaming}
              onClick={() => handleRefine(t('ai.refineEn'))}
            >
              {t('ai.refineEn')}
            </button>
          </div>
          {/* 回写截图：把 AI 文案作为可编辑文字标注贴回当前截图（截图工具独有闭环） */}
          <div className="ai-post-row">
            <button
              className="ai-btn ai-btn-sm ai-btn-apply"
              onClick={handleApplyToScreenshot}
              disabled={!output || isStreaming || !onApplyToScreenshot}
              title={t('ai.applyTitle')}
            >
              📝 {t('ai.applyToScreenshot')}
            </button>
          </div>
          {exportMsg && (
            <div className={`ai-export-msg${exportErr ? ' err' : ''}`}>
              <span>{exportMsg}</span>
              {!exportErr && lastExportedPath && (
                <>
                  <button
                    className="ai-btn ai-btn-sm ai-btn-reveal"
                    title={t('ai.exportRevealTitle')}
                    onClick={async () => {
                      const err = await revealInFolder(lastExportedPath);
                      if (err) {
                        setExportMsg(t('ai.exportFail', { msg: err }));
                        setExportErr(true);
                      }
                    }}
                  >
                    {t('ai.exportReveal')}
                  </button>
                  <button
                    className="ai-btn ai-btn-sm ai-btn-open"
                    title={t('ai.openAppTitle')}
                    onClick={() => openExported(lastExportedPath)}
                  >
                    {t('ai.openApp')}
                  </button>
                </>
              )}
            </div>
          )}
          {applyMsg && <div className="ai-export-msg">{applyMsg}</div>}
          {/* Phase 13+：本次消耗 token / 成本透明（对齐 claw-code usage.rs） */}
          {usage.input + usage.output > 0 && (
            <div className="ai-usage">
              🔤 {usage.input.toLocaleString()}↑ · {usage.output.toLocaleString()}↓ tokens
              {usage.cacheRead ? ` · ⚡${usage.cacheRead.toLocaleString()} ${t('ai.usageCache')}` : ''}
              {(() => {
                const c = estimateCost(config.model, usage.input, usage.output);
                return c != null ? ` · ≈$${c.toFixed(4)}` : '';
              })()}
            </div>
          )}
        </div>
      )}

      {/* 接口设置弹窗已移到 .ai-panel-scroll 外部，避免 overflow 裁切 */}

      {/* 长期记忆（Phase 6，对齐 privdoc-ai 的 Agent Memory）：压缩早期对话，支撑多轮迭代不溢出。
          Phase 9：记忆较多时按相关性筛选注入，仅「本次相关」的记忆高亮并标「相关」徽标。 */}
      {memories.length > 0 && (
        <div className="ai-mem">
          <div className="ai-mem-head">
            <button className="ai-link" onClick={() => setShowMem((v) => !v)}>
              {showMem ? '▾' : '▸'} 🧠 {t('ai.memTitle')} · {memories.reduce((s, m) => s + (m.turnsCovered || 0), 0)} {t('ai.memRounds')}
            </button>
            <button
              className="ai-link ai-mem-compact"
              onClick={() => compactMemory()}
              disabled={isStreaming || conversation.length <= 4}
              title={t('ai.memCompactTitle')}
            >
              {t('ai.memCompact')}
            </button>
          </div>
          {activeMemoryIds.length > 0 && activeMemoryIds.length < memories.length && (
            <div className="ai-mem-hint">{t('ai.memActive', { k: activeMemoryIds.length })}</div>
          )}
          {showMem && (
            <div className="ai-mem-body">
              {memories.map((m, i) => {
                const active = !!m.id && activeMemoryIds.includes(m.id);
                const editing = editMemId === m.id;
                return (
                  <div key={m.id ?? i} className={`ai-mem-item${active ? ' active' : ''}${editing ? ' editing' : ''}`}>
                    {!editing ? (
                      <>
                        <div className="ai-mem-meta">
                          <span className="ai-mem-imp" title={t('ai.memImp')}>
                            {'●'.repeat(m.importance)}
                            {'○'.repeat(5 - m.importance)}
                          </span>
                          <span className="ai-mem-cov">{t('ai.memCov', { n: m.turnsCovered })}</span>
                          {m.merged && m.merged > 1 && (
                            <span className="ai-mem-merged">{t('ai.memMerged', { n: m.merged })}</span>
                          )}
                          {active && <span className="ai-mem-rel">{t('ai.memRel')}</span>}
                          <span className="ai-mem-acts">
                            <button
                              type="button"
                              className="ai-mem-act"
                              title={t('ai.memEditTitle')}
                              onClick={() => {
                                setEditMemId(m.id ?? null);
                                setEditSummary(m.summary);
                                setEditImportance(m.importance);
                              }}
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              className="ai-mem-act del"
                              title={t('ai.memDeleteTitle')}
                              onClick={() => {
                                if (m.id) deleteMemory(m.id);
                              }}
                            >
                              🗑
                            </button>
                          </span>
                        </div>
                        <div className="ai-mem-summary">{m.summary}</div>
                      </>
                    ) : (
                      <div className="ai-mem-edit">
                        <textarea
                          className="ai-mem-edit-area"
                          value={editSummary}
                          rows={3}
                          onChange={(e) => setEditSummary(e.target.value)}
                        />
                        <div className="ai-mem-edit-imp">
                          <span>{t('ai.memEditImportance')}</span>
                          <span className="ai-mem-imp-pick">
                            {[1, 2, 3, 4, 5].map((v) => (
                              <button
                                key={v}
                                type="button"
                                className={`ai-mem-imp-dot${v <= editImportance ? ' on' : ''}`}
                                onClick={() => setEditImportance(v)}
                                title={`${v}`}
                              >
                                ●
                              </button>
                            ))}
                          </span>
                        </div>
                        <div className="ai-mem-edit-btns">
                          <button
                            type="button"
                            className="ai-btn-sm ai-btn-primary"
                            onClick={() => {
                              if (m.id) updateMemory(m.id, { summary: editSummary.trim(), importance: editImportance });
                              setEditMemId(null);
                            }}
                            disabled={!editSummary.trim()}
                          >
                            {t('ai.memSave')}
                          </button>
                          <button type="button" className="ai-btn-sm" onClick={() => setEditMemId(null)}>
                            {t('ai.memCancel')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 思考过程（Phase 16：对齐 openclaw thinking 事件流）：模型推理过程可折叠展示，
          让用户看到 AI 如何拆解截图任务；无思考内容（如普通模型）时不显示。 */}
      {thinking && (
        <div className={`ai-think-block${thinkOpen ? '' : ' collapsed'}`}>
          <button
            className="ai-think-head"
            onClick={() => setThinkOpen((v) => !v)}
            title={t('ai.thinkingTitle')}
          >
            <span className="ai-think-chevron">{thinkOpen ? '▾' : '▸'}</span>
            <span className="ai-think-title">💭 {t('ai.thinkingTitle')}</span>
            {isStreaming && <span className="ai-think-live">●</span>}
          </button>
          {thinkOpen && <div className="ai-think-body"><AiMarkdown source={thinking} /></div>}
        </div>
      )}

      {/* 多轮对话记录（替代原单一 output 区）：每个截图一份线程，逐步打磨成稿 */}
      {/* 独立窗口模式（windowChrome）：空间充足，不再折叠对话区，也不显示「新弹窗」提示
          （该提示是旧侧边栏架构措辞，独立窗口下语义错误）；编辑器窗口保留原折叠行为。 */}
      <div
        className={`ai-chat${
          !windowChrome && ((popupOpen && isStreaming) || (popupOpen && output)) ? ' collapsed' : ''
        }`}
        {...(!windowChrome ? { 'data-collapsed-hint': t('ai.popupChatMoved') } : {})}
      >
        {status === 'error' && (
          <div className="ai-error">
            {error}
            {(error?.includes('Key') || error?.includes('401') || error?.includes('403') || error?.includes('接口设置') || error?.includes('API Settings')) && (
              <button className="ai-error-link" onClick={() => setShowSettings(true)}>
                ⚙️ {t('ai.config')}
              </button>
            )}
          </div>
        )}
        {conversation.length === 0 && !isStreaming && (
          <div className="ai-chat-empty">{t('ai.chatEmpty')}</div>
        )}
        {conversation.map((m, i) => (
          <div key={i} className={`ai-msg ${m.role === 'user' ? 'ai-msg-user' : 'ai-msg-ai'}`}>
            <div className="ai-msg-role">{m.role === 'user' ? t('ai.you') : 'AI'}</div>
            <div className="ai-msg-body">
              {m.role === 'user' ? (
                <div className="ai-msg-text">{m.content}</div>
              ) : (
                <AiMarkdown source={m.content} />
              )}
            </div>
          </div>
        ))}
        {/* Phase 14：AI Agent 工具步骤回显（正在执行 / 已完成） */}
        {agentSteps.length > 0 && (
          <div className="ai-agent-steps">
            {agentSteps.map((st) => (
              <div key={st.callId} className={`ai-agent-step${st.isError ? ' err' : ''}${st.source === 'shaped' ? ' shaped' : ''}`}>
                <span className="ai-agent-step-ico">
                  {st.result === undefined ? '⏳' : st.isError ? '⚠️' : '✓'}
                </span>
                <span className="ai-agent-step-name">{t(toolLabel(st.name))}</span>
                <span className="ai-agent-step-args">{stepArgsSummary(st.args)}</span>
                {st.source === 'shaped' && (
                  <span className="ai-agent-step-tag" title={t('ai.shapedHint')}>
                    {t('ai.shaped')}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {isStreaming && (
          <div className="ai-msg ai-msg-ai">
            <div className="ai-msg-role">AI</div>
            <div className="ai-msg-body">
              {output ? (
                <AiMarkdown
                  source={output}
                  sectionImages={hasSnapMarkers(output) ? orderedImages() : undefined}
                />
              ) : (
                <span className="ai-think">{t('ai.thinking')}</span>
              )}
              <span className="ai-cursor">▋</span>
            </div>
          </div>
        )}
      </div>
      </div>

      {/* 接口设置弹窗（放在 .ai-panel-scroll 外部，避免 overflow 裁切）
          ⚠️ 使用 absolute 定位（相对 .ai-panel），不用 fixed：
          ① fixed 在有 transform 祖先时会被困住；
          ② .ai-panel-scroll 的 overflow 会裁切 fixed 子元素；
          ③ absolute 相对 .ai-panel 定位，弹窗恰好覆盖面板可视区，不溢出。 */}
      {showSettings && (
        <div className="ai-settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="ai-settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ai-settings-head">
              <span className="ai-settings-title">⚙️ {t('ai.settingsTitle')}</span>
              <button className="ai-settings-close" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <div className="ai-settings-body">
              {/* 供应商预设：一键填充 baseUrl + model */}
              <div className="ai-settings-group">
                <div className="ai-settings-group-label">{t('ai.provider')}</div>
                <div className="ai-settings-chips">
                  {([
                    { id: 'openai', label: t('ai.providerOpenAI'), apiType: 'openai' as const, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
                    { id: 'anthropic', label: t('ai.providerAnthropic'), apiType: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
                    { id: 'deepseek', label: t('ai.providerDeepSeek'), apiType: 'openai' as const, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
                    { id: 'qwen', label: t('ai.providerQwen'), apiType: 'openai' as const, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max' },
                    { id: 'zhipu', label: t('ai.providerZhipu'), apiType: 'openai' as const, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v' },
                    { id: 'moonshot', label: t('ai.providerMoonshot'), apiType: 'openai' as const, baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
                  ]).map((p) => (
                    <button
                      key={p.id}
                      className={`ai-chip${config.baseUrl === p.baseUrl ? ' active' : ''}`}
                      onClick={() => setConfig({ apiType: p.apiType, baseUrl: p.baseUrl, model: p.model })}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              {/* 接口配置字段 */}
              <div className="ai-settings-group">
                <div className="ai-settings-field">
                  <label className="ai-settings-field-label">{t('ai.apiType')}</label>
                  <select
                    className="ai-settings-field-input"
                    value={config.apiType}
                    onChange={(e) => setConfig({ apiType: e.target.value as AiApiType })}
                  >
                    <option value="openai">{t('ai.apiTypeOpenAI')}</option>
                    <option value="anthropic">{t('ai.apiTypeAnthropic')}</option>
                  </select>
                </div>
                <div className="ai-settings-field">
                  <label className="ai-settings-field-label">{t('ai.baseUrl')}</label>
                  <input
                    className="ai-settings-field-input"
                    value={config.baseUrl}
                    onChange={(e) => setConfig({ baseUrl: e.target.value })}
                    placeholder={t('ai.baseUrlPh')}
                  />
                </div>
                <div className="ai-settings-field-hint">{t('ai.baseUrlHint')}</div>
                <div className="ai-settings-field">
                  <label className="ai-settings-field-label">{t('ai.apiKey')}</label>
                  <div className="ai-settings-key-row">
                    <input
                      className="ai-settings-field-input"
                      type={showKey ? 'text' : 'password'}
                      value={config.apiKey}
                      onChange={(e) => setConfig({ apiKey: e.target.value })}
                      placeholder={t('ai.apiKeyPh')}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="ai-settings-key-toggle"
                      onClick={() => setShowKey((v) => !v)}
                      title={showKey ? t('ai.hideKey') : t('ai.showKey')}
                    >
                      {showKey ? '🙈' : '👁'}
                    </button>
                  </div>
                </div>
                <div className="ai-settings-field">
                  <label className="ai-settings-field-label">{t('ai.model')}</label>
                  <input
                    className="ai-settings-field-input"
                    value={config.model}
                    onChange={(e) => setConfig({ model: e.target.value })}
                    placeholder={t('ai.modelPh')}
                  />
                </div>
                <div className="ai-settings-field">
                  <label className="ai-settings-field-label">{t('ai.temperature')}</label>
                  <div className="ai-settings-temp">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.1}
                      value={config.temperature}
                      onChange={(e) => setConfig({ temperature: Number(e.target.value) })}
                    />
                    <span className="ai-settings-temp-val">{config.temperature.toFixed(1)}</span>
                  </div>
                </div>
                <div className="ai-settings-temp-labels">
                  <span>{t('ai.tempLow')}</span>
                  <span>{t('ai.tempHigh')}</span>
                </div>
              </div>
              {/* 测试连接 */}
              <div className="ai-settings-group">
                <button
                  className="ai-btn ai-btn-test"
                  onClick={handleTest}
                  disabled={testing || !config.apiKey.trim()}
                >
                  {testing ? t('ai.testing') : t('ai.test')}
                </button>
                {testMsg && (
                  <div className={`ai-test-msg${testMsg.includes('失败') || testMsg.includes('failed') ? ' err' : ''}`}>{testMsg}</div>
                )}
              </div>
            </div>
            <div className="ai-settings-foot">
              <button
                className="ai-btn ai-btn-primary"
                onClick={() => setShowSettings(false)}
              >
                {t('ai.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Phase 17：流式输出独立弹出框 ──
          解决右侧抽屉（400px 宽）承载过多区块时，流式输出被挤在小区域不友好的问题。
          点击「生成 / 智能编辑 / 追问 / 润色」开始流式时，自动弹出全屏居中大框（流式内容独占大空间）。
          关闭 popup ≠ 停止流式（流式继续在面板内进行，可在小面板里看完整设置/历史/导出）。
          状态机：popupPinned=true 每次都弹；popupDismissed=true 本次流式不再弹（用户主动选了"仅小面板"）。 */}
      {popupOpen && (isStreaming || output || thinking) && (
        <div
          className="ai-stream-popup"
          role="dialog"
          aria-modal="true"
          aria-label={t('ai.popupTitle')}
          /* 点遮罩空白处即收起弹窗（与 ▾ 最小化同语义），立即露出被遮住的 ✕ 关闭按钮；
             内容框内点击 stopPropagation，避免误触收起。 */
          onClick={() => {
            setPopupOpen(false);
            setPopupDismissed(true);
          }}
        >
          <div className="ai-stream-box" onClick={(e) => e.stopPropagation()}>
            <div className="ai-stream-head">
              <span className="ai-stream-title">
                {isStreaming ? t('ai.popupStreaming') : t('ai.popupDone')} · {t('ai.popupTitle')}
              </span>
              <div className="ai-stream-actions">
                <button
                  type="button"
                  className={`ai-stream-pin${popupPinned ? ' on' : ''}`}
                  title={t('ai.popupPinTitle')}
                  onClick={() => {
                    const next = !popupPinned;
                    setPopupPinned(next);
                    try { localStorage.setItem('snapcraft-ai-popup-pinned', next ? '1' : '0'); } catch {}
                  }}
                >
                  📌 {t('ai.popupPin')}
                </button>
                <button
                  type="button"
                  className="ai-stream-copy"
                  title={t('ai.copy')}
                  disabled={!output}
                  onClick={async () => {
                    if (!output) return;
                    try {
                      await navigator.clipboard.writeText(output);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    } catch { /* 忽略：剪贴板权限可能未授予 */ }
                  }}
                >
                  {copied ? t('ai.copied') : t('ai.copy')}
                </button>
                <button
                  type="button"
                  className="ai-stream-stop"
                  title={t('ai.stop')}
                  disabled={!isStreaming}
                  onClick={() => stop()}
                >
                  ⏹ {t('ai.stop')}
                </button>
                <button
                  type="button"
                  className="ai-stream-close"
                  title={t('ai.popupMinimize')}
                  onClick={() => {
                    setPopupOpen(false);
                    setPopupDismissed(true);
                  }}
                >
                  ▾
                </button>
              </div>
            </div>
            <div className="ai-stream-body">
              {/* 思考过程（折叠） */}
              {thinking && (
                <details className="ai-stream-think" open={thinkOpen}>
                  <summary onClick={(e) => { e.preventDefault(); setThinkOpen((v) => !v); }}>
                    💭 {t('ai.thinkingTitle')} · {thinking.length} chars
                  </summary>
                  <div className="ai-stream-think-body"><AiMarkdown source={thinking} /></div>
                </details>
              )}
              {/* 工具步骤（实时回显） */}
              {agentSteps.length > 0 && (
                <div className="ai-stream-steps">
                  {agentSteps.map((st) => (
                    <div
                      key={st.callId}
                      className={`ai-stream-step${st.isError ? ' err' : ''}${st.source === 'shaped' ? ' shaped' : ''}`}
                    >
                      <span className="ai-stream-step-ico">
                        {st.result === undefined ? '⏳' : st.isError ? '⚠️' : '✓'}
                      </span>
                      <span className="ai-stream-step-name">{t(toolLabel(st.name))}</span>
                      {st.source === 'shaped' && (
                        <span className="ai-agent-step-tag" title={t('ai.shapedHint')}>
                          {t('ai.shaped')}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {/* 流式输出主体 */}
              <div className="ai-stream-output">
                {output ? (
                  <AiMarkdown
                    source={output}
                    sectionImages={hasSnapMarkers(output) ? orderedImages() : undefined}
                  />
                ) : isStreaming ? (
                  <span className="ai-think">{t('ai.thinking')}</span>
                ) : (
                  <span className="ai-think">—</span>
                )}
                {isStreaming && <span className="ai-cursor">▋</span>}
              </div>
              {/* Phase 18：导出/润色/回写 全部入口（与下方小面板共享 handler） */}
              {/* 新需求-7/9：文档统计 + 导出文件名预览（导出按钮上方） */}
              {hasOutput && !isStreaming && stats && (
                <div className="ai-doc-stats">
                  <span className="ai-doc-stats-info">
                    {t('ai.stats', {
                      words: stats.words.toLocaleString(),
                      lines: stats.lines,
                      minutes: stats.minutes,
                      images: orderedImages().length,
                    })}
                  </span>
                  <span className="ai-doc-stats-name" title={exportNamePreview}>
                    {t('ai.exportNamePreview', { name: exportNamePreview })}
                  </span>
                </div>
              )}
              {hasOutput && !isStreaming && (
                <div className="ai-stream-actions-row">
                  <span className="ai-stream-section">{t('ai.export')}</span>
                  <button className="ai-btn ai-btn-sm" onClick={() => handleExport('md')} disabled={exporting}>.md</button>
                  <button className="ai-btn ai-btn-sm" onClick={() => handleExport('txt')} disabled={exporting}>.txt</button>
                  <button className="ai-btn ai-btn-sm" onClick={() => handleExport('html')} disabled={exporting}>.html</button>
                  <button
                    className="ai-btn ai-btn-sm ai-btn-primary"
                    onClick={handleExportXlsx}
                    disabled={exporting}
                    title={t('ai.exportXlsxTitle')}
                  >
                    {exporting ? t('ai.exporting') : '.xlsx'}
                  </button>
                  <button
                    className="ai-btn ai-btn-sm ai-btn-primary"
                    onClick={handleExportDocx}
                    disabled={exporting}
                    title={t('ai.exportDocxTitle')}
                  >
                    {exporting ? t('ai.exporting') : '.docx'}
                  </button>
                  <button className="ai-btn ai-btn-sm" onClick={handleExportPdf} disabled={exporting} title={t('ai.exportPdfTitle')}>.pdf</button>
                  <button
                    className="ai-btn ai-btn-sm ai-btn-preview"
                    onClick={handlePreview}
                    disabled={exporting}
                    title={t('ai.previewTitle')}
                  >
                    👁 {t('ai.preview')}
                  </button>
                  <button
                    className="ai-btn ai-btn-sm"
                    onClick={() => {
                      setShowExportHistory((v) => !v);
                      setExportHistoryList(listExportHistory());
                    }}
                    title={t('ai.exportHistory')}
                  >
                    📜 {t('ai.exportHistory')}
                  </button>
                </div>
              )}
              {/* 新需求-8：导出历史下拉列表（全屏弹窗内复用同一份历史） */}
              {hasOutput && !isStreaming && showExportHistory && (
                <div className="ai-export-history">
                  {exportHistoryList.length === 0 ? (
                    <div className="ai-export-history-empty">{t('ai.exportHistoryEmpty')}</div>
                  ) : (
                    <>
                      {exportHistoryList.map((it, i) => (
                        <div key={`${it.path}-${i}`} className="ai-export-history-item">
                          <span className="ai-export-history-fmt">.{it.format}</span>
                          <span className="ai-export-history-name" title={it.path}>
                            {baseNameOf(it.path)}
                          </span>
                          <span className="ai-export-history-time">{fmtTime(it.time)}</span>
                          <button
                            className="ai-btn ai-btn-sm ai-btn-reveal"
                            title={t('ai.exportRevealTitle')}
                            onClick={async () => {
                              const err = await revealInFolder(it.path);
                              if (err) {
                                setExportMsg(t('ai.exportFail', { msg: err }));
                                setExportErr(true);
                              }
                            }}
                          >
                            {t('ai.exportReveal')}
                          </button>
                        </div>
                      ))}
                      <button
                        className="ai-link ai-link-danger"
                        onClick={() => {
                          clearExportHistory();
                          setExportHistoryList([]);
                        }}
                      >
                        {t('ai.exportHistoryClear')}
                      </button>
                    </>
                  )}
                </div>
              )}
              {hasOutput && !isStreaming && (
                <div className="ai-stream-actions-row">
                  <span className="ai-stream-section">{t('ai.refine')}</span>
                  <button className="ai-chip ai-refine-chip" disabled={refining} onClick={() => handleRefine(t('ai.refineShorter'))}>{t('ai.refineShorter')}</button>
                  <button className="ai-chip ai-refine-chip" disabled={refining} onClick={() => handleRefine(t('ai.refineLonger'))}>{t('ai.refineLonger')}</button>
                  <button className="ai-chip ai-refine-chip" disabled={refining} onClick={() => handleRefine(t('ai.refineFormal'))}>{t('ai.refineFormal')}</button>
                  <button className="ai-chip ai-refine-chip" disabled={refining} onClick={() => handleRefine(t('ai.refineCasual'))}>{t('ai.refineCasual')}</button>
                  <button className="ai-chip ai-refine-chip" disabled={refining} onClick={() => handleRefine(t('ai.refineEn'))}>{t('ai.refineEn')}</button>
                </div>
              )}
              {hasOutput && !isStreaming && onApplyToScreenshot && (
                <div className="ai-stream-actions-row">
                  <button
                    className="ai-btn ai-btn-sm ai-btn-apply"
                    onClick={handleApplyToScreenshot}
                    title={t('ai.applyTitle')}
                  >
                    📝 {t('ai.applyToScreenshot')}
                  </button>
                </div>
              )}
            </div>
            <div className="ai-stream-foot">
              {usage.input || usage.output ? (
                <span className="ai-stream-usage">
                  🔤 {usage.input}↑ · {usage.output}↓
                  {usage.cacheRead ? ` · ⚡${usage.cacheRead} ${t('ai.usageCache')}` : ''}
                  {usage.cacheCreate ? ` · 🆕${usage.cacheCreate}` : ''}
                </span>
              ) : (
                <span />
              )}
              {error && <span className="ai-stream-err">{error}</span>}
              {exportMsg && !error && (
                <span className={`ai-stream-export-msg${exportErr ? ' err' : ''}`}>
                  {exportMsg}
                  {!exportErr && lastExportedPath && (
                    <>
                      <button
                        className="ai-btn ai-btn-sm ai-btn-reveal"
                        title={t('ai.exportRevealTitle')}
                        onClick={async () => {
                          const err = await revealInFolder(lastExportedPath);
                          if (err) {
                            setExportMsg(t('ai.exportFail', { msg: err }));
                            setExportErr(true);
                          }
                        }}
                      >
                        {t('ai.exportReveal')}
                      </button>
                      <button
                        className="ai-btn ai-btn-sm ai-btn-open"
                        title={t('ai.openAppTitle')}
                        onClick={() => openExported(lastExportedPath)}
                      >
                        {t('ai.openApp')}
                      </button>
                    </>
                  )}
                </span>
              )}
              {applyMsg && !error && (
                <span className="ai-stream-export-msg">{applyMsg}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Phase 11：跨截图 AI 文档历史库（覆盖层，纯前端，零 Rust） ──
          列出所有截图各自的 AI 成稿线程（按截图分桶、按更新时间倒序），可搜索 / 阅读 / 载入追问 / 删除 / 导出。
          对齐 privdoc-ai 的 conversations 列表，但天然把「截图」作为文档锚点。 */}
      {showHistory && (
        <div className="ai-hist">
          <div className="ai-hist-head">
            <span className="ai-hist-title">📚 {t('ai.historyTitle')}</span>
            <div className="ai-hist-head-actions">
              <button className="ai-panel-close" onClick={() => setShowHistory(false)} title={t('ai.historyClose')}>
                ✕
              </button>
              {windowChrome && (
                <button className="ai-panel-close" onClick={onClose} title={t('ai.close')}>
                  {'⏻'}
                </button>
              )}
            </div>
          </div>

          {activeConv ? (
            /* 阅读器：只读展示该线程全部轮次，可导出或载入当前面板继续追问 */
            <div className="ai-hist-reader">
              <div className="ai-hist-bar">
                <button className="ai-link" onClick={() => setActiveConv(null)}>
                  ‹ {t('ai.historyBack')}
                </button>
                <span className="ai-hist-badge">{activeConv.meta.presetName}</span>
                <button className="ai-link" onClick={() => loadConvIntoPanel(activeConv.meta.hash)}>
                  {t('ai.historyLoad')}
                </button>
                <button
                  className="ai-link"
                  title={t('ai.historyForkTitle')}
                  onClick={() => {
                    const nh = forkConversation(activeConv.meta.hash);
                    if (nh) {
                      loadConvIntoPanel(nh);
                      setHistoryMsg(t('ai.historyForked'));
                    }
                  }}
                >
                  🍴 {t('ai.historyFork')}
                </button>
              </div>
              <div className="ai-hist-doc-title">{activeConv.meta.firstGoal || t('ai.historyNoGoal')}</div>
              <div className="ai-post-row ai-hist-export">
                <span className="ai-post-label">{t('ai.export')}</span>
                <button className="ai-btn ai-btn-sm" onClick={() => handleHistoryExport('md')}>
                  .md
                </button>
                <button className="ai-btn ai-btn-sm" onClick={() => handleHistoryExport('txt')}>
                  .txt
                </button>
                <button className="ai-btn ai-btn-sm" onClick={() => handleHistoryExport('html')}>
                  .html
                </button>
                <button className="ai-btn ai-btn-sm" onClick={() => handleHistoryExport('docx')}>
                  .docx
                </button>
                <button className="ai-btn ai-btn-sm" onClick={() => handleHistoryExport('pdf')}>
                  .pdf
                </button>
                <button
                  className="ai-btn ai-btn-sm"
                  onClick={() => handleHistoryExport('pptx')}
                  title={t('ai.exportPptxTitle')}
                >
                  .pptx
                </button>
                <button
                  className="ai-btn ai-btn-sm ai-btn-primary"
                  onClick={() => handleHistoryExport('xlsx')}
                  title={t('ai.exportXlsxTitle')}
                >
                  .xlsx
                </button>
                <button
                  className="ai-btn ai-btn-sm"
                  onClick={handleHistoryZip}
                  title={t('ai.exportZipTitle')}
                >
                  📦 .zip
                </button>
              </div>
              <div className="ai-chat ai-hist-chat">
                {activeConv.conv.map((m, i) => (
                  <div key={i} className={`ai-msg ${m.role === 'user' ? 'ai-msg-user' : 'ai-msg-ai'}`}>
                    <div className="ai-msg-role">{m.role === 'user' ? t('ai.you') : 'AI'}</div>
                    <div className="ai-msg-body">
                      {m.role === 'user' ? (
                        <div className="ai-msg-text">{m.content}</div>
                      ) : (
                        <AiMarkdown source={m.content} />
                      )}
                      {m.role === 'assistant' && (
                        <button
                          className="ai-msg-fork"
                          title={t('ai.historyForkFromTitle')}
                          onClick={() => {
                            const nh = forkConversation(activeConv.meta.hash, i);
                            if (nh) {
                              loadConvIntoPanel(nh);
                              setHistoryMsg(t('ai.historyForked'));
                            }
                          }}
                        >
                          🍴 {t('ai.historyForkFrom')}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {historyMsg && <div className="ai-export-msg">{historyMsg}</div>}
              {historyExportedPath && (
                <div className="ai-export-msg ai-hist-export-actions">
                  <button
                    className="ai-btn ai-btn-sm ai-btn-reveal"
                    title={t('ai.exportRevealTitle')}
                    onClick={async () => {
                      const err = await revealInFolder(historyExportedPath);
                      if (err) setHistoryMsg(t('ai.exportFail', { msg: err }));
                    }}
                  >
                    {t('ai.exportReveal')}
                  </button>
                  <button
                    className="ai-btn ai-btn-sm ai-btn-open"
                    title={t('ai.openAppTitle')}
                    onClick={() => openExported(historyExportedPath)}
                  >
                    {t('ai.openApp')}
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* 列表：搜索 + 卡片 */
            <>
              <div className="ai-hist-search">
                <input
                  className="ai-hist-search-input"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder={t('ai.historySearchPh')}
                />
              </div>
              <div className="ai-hist-body">
                {historyList.length === 0 ? (
                  <div className="ai-hist-empty">{t('ai.historyEmpty')}</div>
                ) : filteredList.length === 0 ? (
                  <div className="ai-hist-empty">{t('ai.historyNoResult')}</div>
                ) : (
                  filteredList.map((meta) => (
                    <div key={meta.hash} className="ai-hist-item">
                      {meta.thumb && <img className="ai-hist-thumb" src={meta.thumb} alt="" />}
                      <div className="ai-hist-info">
                        <div className="ai-hist-item-title">{meta.firstGoal || t('ai.historyNoGoal')}</div>
                        <div className="ai-hist-item-meta">
                          {meta.parent && <span className="ai-hist-fork-badge">🍴 {t('ai.historyForkBadge')}</span>}
                          <span className="ai-hist-badge">{meta.presetName}</span>
                          <span className="ai-hist-dot">·</span>
                          <span>{fmtTime(meta.updatedAt)}</span>
                          <span className="ai-hist-dot">·</span>
                          <span>{t('ai.historyMsgs', { n: meta.msgCount })}</span>
                        </div>
                      </div>
                      <div className="ai-hist-actions">
                        <button className="ai-link" onClick={() => openConvReader(meta)}>
                          {t('ai.historyRead')}
                        </button>
                        <button className="ai-link" onClick={() => loadConvIntoPanel(meta.hash)}>
                          {t('ai.historyLoad')}
                        </button>
                        <button className="ai-link ai-link-danger" onClick={() => removeConv(meta.hash)}>
                          {t('ai.historyDelete')}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* 应用内预览层：Tauri 环境替代被 webview 拦截的 window.open 弹窗；
          同源 iframe(srcDoc) 必然允许加载，避免"预览被浏览器拦截"报错。 */}
      {previewHtml && (
        <div
          className="ai-preview-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPreviewHtml(null);
          }}
        >
          <div className="ai-preview-modal">
            <div className="ai-preview-bar">
              <span className="ai-preview-title">👁 {t('ai.preview')}</span>
              <button
                type="button"
                className="ai-panel-close"
                onClick={() => setPreviewHtml(null)}
                title={t('ai.close')}
              >
                ✕
              </button>
            </div>
            <iframe className="ai-preview-frame" title={t('ai.preview')} srcDoc={previewHtml} />
          </div>
        </div>
      )}
    </div>
  );
}
