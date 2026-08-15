// AI 助手面板：可复用的右侧抽屉
// 在两个编辑器（EnhancedScreenshotApp / EditorWindow）中挂载，传入当前截图的
// dataUrl 与 OCR 文字作为上下文。配置与生成状态来自 useAiStore。
// 设计为「非侵入」：默认不显示，点击工具栏 AI 按钮才滑出；关闭后不影响任何现有功能。
//
// 2026-07-14 Phase 2b 新增：
//  - 「附加更多截图」：从本机截图历史多选，AI 一并分析、合成完整文档（多截图成稿）。
//  - 「管理模板」：用户可保存自己的业务文档/文案预设（localStorage 持久化）。
//  - 导出增 .html（可 ⌘P 另存为 PDF），复用既有 save_text_file 后端命令。

import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { useAiStore, convHash } from './aiStore';
import { type AiPreset, type UserPreset, stripSnapMarkers, hasSnapMarkers } from './aiPresets';
import { AiMarkdown } from './aiMarkdown';
import { chatOnce, estimateCost } from './aiClient';
import { type AiToolHost, toolLabel } from './aiTools';
import { agentLabel } from './aiAgents';
import { requestRefresh, notifyAiCommit } from '../../ai-window/bridge';
import { DOC_THEMES } from './export/markdownHtml';
import type { DocxImage } from './export/markdownDocx';
import { buildDefaultPath, deriveFileHint, baseNameOf } from './export/exportPath';
import type { ExportHistoryItem } from './export/exportHistory';
import type { AiApiType } from './aiTypes';
import { t, getLang } from '../../i18n';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { mdToPlainText, docStats, firstHeading, fmtTime } from './aiUtils';
import { AiTemplateManager } from './AiTemplateManager';
import { AiHistoryOverlay } from './AiHistoryOverlay';
import { loadSelection, saveSelection } from './lib/persistence';
import { useExportActions } from './hooks/useExportActions';
import type { ExportContext } from './export/exportService';
import { useLicenseStore } from '../licensing/licenseStore';
import { useUpgradeDialogStore } from '../licensing/upgradeDialogStore';
// MUI 布局体系：用成熟组件替代自定义布局样式（aiTheme 提供跟随 app data-theme 的明暗主题）
import { ThemeProvider } from '@mui/material/styles';
import { Box, Stack, Paper, Typography, Button, IconButton, Chip, TextField, Checkbox, FormControlLabel, Dialog, DialogTitle, DialogContent, DialogActions, Alert, Slider, MenuItem, InputAdornment, Select, FormControl } from '@mui/material';
import { useAiTheme } from './aiTheme';


// 多截图章节顺序持久化：委托 lib/persistence（消除与 AIPanel 的重复实现）
const loadSel = loadSelection;
const saveSel = saveSelection;

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
  /** 可选：教程捕获模式——主窗收集步骤 id 经 URL 注入，透传供 AIPanel 受控自动成稿 */
  tutorialIds?: string[];
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
    agents,
    activeAgentId,
    setActiveAgent,
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
    listConvMeta,
    getConvByHash,
    deleteConv,
    forkConversation,
    setOutput,
    recordConvMeta,
  } = useAiStore();

  // MUI 主题：跟随 app 根节点 data-theme(dark/light) 实时切换
  const theme = useAiTheme();

  // 宽屏判定：独立窗口(windowChrome)内宽 > 880 时启用文档三栏布局，否则降级单栏。
  // 注意：固定大窗(windowChrome)内容区 = 1140 - 左竖栏140 = 1000px，阈值必须 < 1000，
  // 否则会恒判窄屏 → 首屏走单栏（用户报「拖动后才正常」即此）。故 windowChrome 下默认 true，
  // 仅在 ResizeObserver 实测确实偏窄时才降级，消除首帧布局闪烁。
  const panelRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState<boolean>(!!windowChrome);
  // 首帧同步测量 + 尺寸稳定兜底重测：Tauri 在 macOS 上新创建的窗首帧内容尺寸不稳定，
  // 仅依赖 ResizeObserver 首回调会在「真实尺寸就绪前」误判为窄屏 → 显示旧的单栏布局，
  // 直到拖动窗口触发尺寸变化才纠正（用户报「拖动后恢复正常」即此）。
  // useLayoutEffect 在绘制前同步测量消除首帧闪烁；rAF / 250ms 兜底覆盖首帧尺寸未稳定的情况。
  useLayoutEffect(() => {
    const el = panelRef.current;
    const measure = () => {
      const w =
        el?.getBoundingClientRect().width ??
        (typeof window !== 'undefined' ? window.innerWidth : 0);
      setWide(w > 880);
    };
    measure();
    const ro = new ResizeObserver(() => measure());
    if (el) ro.observe(el);
    const raf = requestAnimationFrame(measure);
    const tm = typeof window !== 'undefined' ? window.setTimeout(measure, 250) : 0;
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      if (tm) clearTimeout(tm);
    };
  }, []);

  // 三栏布局（windowChrome 宽屏）下，附加截图区常驻显示，需主动拉取历史库，
  // 否则 history 永为空 → 恒显示「暂无历史截图可附加」。抽屉模式由 toggleAttach 触发，无需此 effect。
  useEffect(() => {
    if (windowChrome && wide && history.length === 0) {
      loadHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowChrome, wide]);

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
  // 面板内富文本二次编辑：编辑态下用 textarea 改 markdown 源码，完成后写回 output（setOutput 同步会话与落盘）
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');

  // 2026-07-23 架构解耦：导出状态与操作统一由 useExportActions hook 管理，
  // 消除 AIPanel 内重复的 7 格式导出管线代码（~300 行）。
  const {
    exporting,
    exportMsg,
    exportErr,
    lastExportedPath,
    previewHtml,
    doExport,
    doExportZip,
    doPreview,
    openPreview,
    doCopyRich,
    revealExported,
    openExported,
    closePreview,
    clearMsg: clearExportMsg,
    setLastExportedPath,
    getExportHistory,
    doClearExportHistory,
  } = useExportActions();
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

  // ── Phase 11：跨截图 AI 文档历史库（覆盖层已提取为 AiHistoryOverlay 组件） ──
  const [showHistory, setShowHistory] = useState(false);
  const openHistory = () => setShowHistory(true);

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

  // lastExportedPath 持久化 + exportMsg 自动消失已由 useExportActions hook 内部管理


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

  // 构建导出上下文：把 AIPanel 当前状态组装为 exportService 所需的 ExportContext。
  // resolveContext 会自动检测 SNAP 标记并分配 sectionImages / images。
  const buildExportContext = useCallback((): ExportContext => {
    const md = output ?? '';
    return {
      markdown: md,
      title: firstHeading(md) || presetLabel(activePreset),
      subtitle: goal,
      theme: config.theme ?? 'modern',
      images: orderedImages(),
      fileHint: deriveFileHint(goal),
      tocTitle: t('ai.toc'),
    };
  }, [output, activePreset, goal, config.theme, attachImage, agentMode, sentinelMode, visionImg, selectedOrder, history]);

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
    const rawGoal = goal.trim();
    // 智能编辑需要明确目标；隐私哨兵允许留空（系统提示词 agentSystemSentinel 已自包含
    // 「扫描并打码全部敏感信息」，空用户消息即可工作）。哨兵留空时 runAgent 走中性标签展示，
    // 不再把默认目标当普通对话显示（软问题修复）。
    if (!isSentinel && !rawGoal) return;
    // 已有对话则先清空，确保 Agent 从当前截图重新规划编辑与文档
    if (conversation.length) clearConversation();
    // 段二：把「当前助手」绑定（模型/温度/系统提示词/工具）贯通到 Agent 运行，
    // 让文档栏选中的智能体在智能编辑/哨兵模式下同样生效（此前仅 chat 路径生效）。
    const activeAgent = activeAgentId ? agents.find((a) => a.id === activeAgentId) ?? null : null;
    const runInput: Parameters<typeof runAgent>[0] = {
      preset: activePreset,
      goal: rawGoal,
      imageDataUrl: visionImg,
      ocrText,
      images: [],
      ocrTexts: [],
      host: aiTools,
      agentKind: isSentinel ? 'sentinel' : 'edit',
    };
    if (activeAgent) {
      // 哨兵强制使用内置系统提示词 + 仅 redact_area 工具，故不覆盖 systemPrompt/toolIds；
      // 仅贯通模型/温度/兜底模型，让哨兵也能跑在用户绑定的专属模型上。
      if (isSentinel) {
        runInput.agentModelId = activeAgent.modelId;
        runInput.agentTemperature = activeAgent.temperature;
        runInput.agentFallbackModelId = activeAgent.fallbackModelId;
      } else {
        runInput.agentSystemPrompt = activeAgent.systemPrompt?.trim() || undefined;
        runInput.agentModelId = activeAgent.modelId;
        runInput.agentTemperature = activeAgent.temperature;
        runInput.agentToolIds = activeAgent.toolIds;
        runInput.agentFallbackModelId = activeAgent.fallbackModelId;
      }
    }
    runAgent(runInput);
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
    clearExportMsg();
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

  // 复制为富文本：委托 useExportActions hook，消除重复的 HTML 构建 + 剪贴板写入逻辑
  const handleCopyRich = async () => {
    if (!output) return;
    const ok = await doCopyRich(buildExportContext(), stripSnapMarkers(output));
    if (ok) {
      setCopiedRich(true);
      setTimeout(() => setCopiedRich(false), 1500);
    }
  };

  // openExported 已由 useExportActions hook 提供，无需本地重复实现

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
    // 付费门禁：连通性测试仍消耗 AI 请求，属 AI 功能，须受订阅控制（一致性 fail-closed）。
    if (!useLicenseStore.getState().canUse('ai')) {
      useUpgradeDialogStore.getState().openDialog('ai');
      return;
    }
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

  // ===== 导出操作：统一委托 useExportActions hook =====
  // 此前 AIPanel 内各自实现了 7 格式导出管线（MD/TXT/HTML/DOCX/PPTX/XLSX/PDF），
  // 与 exportService.ts + useExportActions.ts 完全重复。现统一走 hook，消除 ~250 行冗余。
  const handleExport = async (fmt: 'md' | 'txt' | 'html') => {
    if (!output) return;
    await doExport(buildExportContext(), fmt);
  };

  const handleExportDocx = async () => {
    if (!output) return;
    await doExport(buildExportContext(), 'docx');
  };

  const handleExportPdf = async () => {
    if (!output) return;
    await doExport(buildExportContext(), 'pdf');
  };

  const handlePreview = () => {
    if (!output) return;
    doPreview(buildExportContext());
  };

  // 快速润色：以上一轮结果为输入，追加润色指令再生成
  const handleRefine = (instruction: string) => {
    clearExportMsg();
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

  // 导出 / 预览 / 主题 / 润色 / 应用截图 / 反馈 操作簇：抽屉(单列)与三栏(大窗)两种布局共用，
  // 避免三栏模式因互不渲染而「丢失」全部操作按钮（之前整条操作栏只在 !windowChrome&&wide 下渲染）。
  const renderDocActions = () => (
    <>
      {hasOutput && !isEditing && (
        <Stack spacing={1} sx={{ px: 1.5, py: 1, borderTop: 1, borderColor: 'divider' }}>
          {/* 新需求-7/9：文档统计 + 导出文件名预览（导出按钮上方，小灰字一行） */}
          {stats && (
            <Stack direction="row" spacing={1} alignItems="baseline" sx={{ flexWrap: 'wrap' }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('ai.stats', {
                  words: stats.words.toLocaleString(),
                  lines: stats.lines,
                  minutes: stats.minutes,
                  images: orderedImages().length,
                })}
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }} title={exportNamePreview}>
                {t('ai.exportNamePreview', { name: exportNamePreview })}
              </Typography>
            </Stack>
          )}
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
            <Typography variant="caption" sx={{ color: 'text.secondary', mr: 0.5 }}>{t('ai.export')}</Typography>
            <Button size="small" variant="outlined" onClick={() => handleExport('md')} disabled={exporting}>.md</Button>
            <Button size="small" variant="outlined" onClick={() => handleExport('txt')} disabled={exporting}>.txt</Button>
            <Button size="small" variant="outlined" onClick={() => handleExport('html')} disabled={exporting}>.html</Button>
            <Button size="small" variant="contained" onClick={handleExportDocx} disabled={exporting} title={t('ai.exportDocxTitle')}>
              {exporting ? t('ai.exporting') : '.docx'}
            </Button>
            <Button size="small" variant="outlined" onClick={handleExportPdf} disabled={exporting} title={t('ai.exportPdfTitle')}>.pdf</Button>
            <Button size="small" variant="outlined" onClick={handlePreview} disabled={exporting} title={t('ai.previewTitle')}>
              👁 {t('ai.preview')}
            </Button>
            {/* 新需求-8：导出历史入口 */}
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                setShowExportHistory((v) => !v);
                setExportHistoryList(getExportHistory());
              }}
              title={t('ai.exportHistory')}
            >
              📜 {t('ai.exportHistory')}
            </Button>
          </Stack>
          {/* 新需求-8：导出历史下拉列表（最近 20 条落盘导出，可 revealInFolder） */}
          {showExportHistory && (
            <Paper variant="outlined" sx={{ p: 1 }}>
              {exportHistoryList.length === 0 ? (
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('ai.exportHistoryEmpty')}</Typography>
              ) : (
                <Stack spacing={0.5}>
                  {exportHistoryList.map((it, i) => (
                    <Stack key={`${it.path}-${i}`} direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                      <Typography variant="caption" sx={{ fontWeight: 600 }}>.{it.format}</Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={it.path}>
                        {baseNameOf(it.path)}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>{fmtTime(it.time)}</Typography>
                      <Button size="small" variant="text" onClick={() => revealExported(it.path)} title={t('ai.exportRevealTitle')}>
                        {t('ai.exportReveal')}
                      </Button>
                    </Stack>
                  ))}
                  <Button
                    size="small"
                    variant="text"
                    color="error"
                    onClick={() => {
                      doClearExportHistory();
                      setExportHistoryList([]);
                    }}
                  >
                    {t('ai.exportHistoryClear')}
                  </Button>
                </Stack>
              )}
            </Paper>
          )}
          {/* 文档主题：选择 HTML / PDF 导出的外观（产品推广 / 杂志风等精美样式） */}
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
            <Typography variant="caption" sx={{ color: 'text.secondary', mr: 0.5 }}>{t('ai.style')}</Typography>
            {DOC_THEMES.map((th) => {
              const lang = getLang();
              const label = lang === 'zh-CN' ? th.name.zh : th.name.en;
              const desc = lang === 'zh-CN' ? th.desc.zh : th.desc.en;
              return (
                <Chip
                  key={th.id}
                  label={label}
                  title={desc}
                  onClick={() => setConfig({ theme: th.id })}
                  color={config.theme === th.id ? 'primary' : 'default'}
                  variant={config.theme === th.id ? 'filled' : 'outlined'}
                  clickable
                  size="small"
                />
              );
            })}
          </Stack>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
            <Typography variant="caption" sx={{ color: 'text.secondary', mr: 0.5 }}>{t('ai.refine')}</Typography>
            <Chip label={t('ai.refineShorter')} disabled={refining || isStreaming} onClick={() => handleRefine(t('ai.refineShorter'))} clickable size="small" />
            <Chip label={t('ai.refineLonger')} disabled={refining || isStreaming} onClick={() => handleRefine(t('ai.refineLonger'))} clickable size="small" />
            <Chip label={t('ai.refineFormal')} disabled={refining || isStreaming} onClick={() => handleRefine(t('ai.refineFormal'))} clickable size="small" />
            <Chip label={t('ai.refineCasual')} disabled={refining || isStreaming} onClick={() => handleRefine(t('ai.refineCasual'))} clickable size="small" />
            <Chip label={t('ai.refineEn')} disabled={refining || isStreaming} onClick={() => handleRefine(t('ai.refineEn'))} clickable size="small" />
          </Stack>
          {/* 回写截图：把 AI 文案作为可编辑文字标注贴回当前截图（截图工具独有闭环） */}
          <Button
            size="small"
            variant="outlined"
            onClick={handleApplyToScreenshot}
            disabled={!output || isStreaming || !onApplyToScreenshot}
            title={t('ai.applyTitle')}
          >
            📝 {t('ai.applyToScreenshot')}
          </Button>
          {exportMsg && (
            <Alert severity={exportErr ? 'error' : 'success'} sx={{ alignItems: 'center' }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <span>{exportMsg}</span>
                {!exportErr && lastExportedPath && (
                  <>
                    <Button size="small" variant="text" onClick={() => revealExported(lastExportedPath)} title={t('ai.exportRevealTitle')}>
                      {t('ai.exportReveal')}
                    </Button>
                    <Button size="small" variant="text" onClick={() => openExported(lastExportedPath)} title={t('ai.openAppTitle')}>
                      {t('ai.openApp')}
                    </Button>
                  </>
                )}
              </Stack>
            </Alert>
          )}
          {applyMsg && <Alert severity="info">{applyMsg}</Alert>}
          {/* Phase 13+：本次消耗 token / 成本透明 */}
          {usage.input + usage.output > 0 && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              🔤 {t('ai.usageTokens', { in: usage.input.toLocaleString(), out: usage.output.toLocaleString() })}
              {usage.cacheRead ? ` · ⚡${usage.cacheRead.toLocaleString()} ${t('ai.usageCache')}` : ''}
              {(() => {
                const c = estimateCost(config.model, usage.input, usage.output);
                return c != null ? ` · ≈$${c.toFixed(4)}` : '';
              })()}
            </Typography>
          )}
        </Stack>
      )}
    </>
  );

  // 长期记忆（Phase 6）：抽屉与三栏共用，避免三栏丢失记忆管理。
  const renderMemory = () => (
    <>
      {memories.length > 0 && (
        <Paper variant="outlined" sx={{ m: 1.5, p: 1 }}>
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
                  <Paper key={m.id ?? i} variant="outlined" sx={{ p: 0.75, mb: 0.5 }}>
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
                  </Paper>
                );
              })}
            </div>
          )}
        </Paper>
      )}
    </>
  );

  return (
    <ThemeProvider theme={theme}>
    <div className={`ai-panel${windowChrome ? ' ai-panel-wide' : ''}`} ref={panelRef}>
      {/* 头部：独立系统窗(windowChrome)由系统标题栏接管，不渲染自绘头部→避免双重头部；
          抽屉模式渲染 MUI 头部(标题 + 设置/历史/关闭)。 */}
      {!windowChrome && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            px: 1.5,
            py: 1,
            borderBottom: 1,
            borderColor: 'divider',
            flexShrink: 0,
          }}
        >
          <Stack direction="row" spacing={0.5} alignItems="center">
            {live && (
              <Box
                component="span"
                sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'success.main', boxShadow: '0 0 6px' }}
              />
            )}
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              ✨ {t('ai.title')}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={0.5}>
            <IconButton size="small" onClick={openHistory} title={t('ai.historyTitle')}>
              📚
            </IconButton>
            <IconButton size="small" onClick={onClose} title={t('ai.close')}>
              ✕
            </IconButton>
          </Stack>
        </Box>
      )}

      {/* 文档三栏布局（windowChrome 宽屏）：
          左栏=预设/模式开关/执行按钮/附加截图；中栏=对话流(成稿作为 AI 回答显示)；右栏=历史(内联)。
          顶部竖向标签(文档/模型接入/智能体)在 AiWindow 最左侧栏。 */}
      {windowChrome && wide && (
        <Box className="ai-doc-3col">
          {/* 左栏：预设 + 模式开关 + 执行按钮 + 附加截图 */}
          <Box className="ai-doc-nav">
            {/* 执行业务的智能体：置顶，下拉选择当前用于对话的助手（系统提示词/模型/温度），
                为空则走默认文档模式。列表来自用户自建助手（内置助手已迁为模式开关）。 */}
            <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>🤖 {t('ai.businessAgent')}</Typography>
            <FormControl size="small" fullWidth sx={{ mb: 1.5 }}>
              <Select
                value={activeAgentId ?? ''}
                displayEmpty
                onChange={(e) => setActiveAgent(e.target.value || null)}
              >
                <MenuItem value="">{t('ai.agentNone')}</MenuItem>
                {agents.map((a) => (
                  <MenuItem key={a.id} value={a.id}>{agentLabel(a, t)}</MenuItem>
                ))}
              </Select>
            </FormControl>
            {agents.length === 0 && (
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1.5 }}>
                {t('ai.noAgentHint')}
              </Typography>
            )}

            <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>{t('ai.presets')}</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.5, mb: 1.5 }}>
              {presets.map((p) => (
                <Chip
                  key={p.id}
                  label={`${p.custom ? '★ ' : ''}${presetLabel(p)}`}
                  title={presetDesc(p)}
                  onClick={() => setActivePreset(p.id)}
                  color={p.id === activePresetId ? 'primary' : 'default'}
                  variant={p.id === activePresetId ? 'filled' : 'outlined'}
                  clickable
                  size="small"
                  sx={{ width: '100%', justifyContent: 'flex-start' }}
                />
              ))}
            </Box>
            <Stack direction="column" spacing={0.5} sx={{ mb: 1.5 }}>
              <Button size="small" variant="outlined" onClick={() => setShowTemplates((v) => !v)}>✎ {t('ai.templateManage')}</Button>
              {aiTools && (
                <>
                  <Button size="small" variant={agentMode ? 'contained' : 'outlined'} color="secondary" onClick={() => { setAgentMode((v) => !v); if (!agentMode) setSentinelMode(false); }}>🤖 {t('ai.agentMode')}</Button>
                  <Button size="small" variant={sentinelMode ? 'contained' : 'outlined'} color="secondary" onClick={() => { setSentinelMode((v) => !v); if (!sentinelMode) setAgentMode(false); }}>🔒 {t('ai.sentinelMode')}</Button>
                </>
              )}
            </Stack>
            <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>{t('ai.actions')}</Typography>
            <Stack direction="column" spacing={0.5} sx={{ mb: 1.5 }}>
              {isStreaming ? (
                <Button variant="contained" color="error" size="small" onClick={stop}>{t('ai.stop')}</Button>
              ) : (
                <Button
                  variant="contained"
                  size="small"
                  onClick={(agentMode || sentinelMode) && aiTools ? handleAgentRun : handleGenerate}
                  disabled={!config.apiKey.trim() || isEditing || (!(agentMode || sentinelMode) && !goal.trim())}
                >
                  {sentinelMode && aiTools ? t('ai.sentinelRun') : agentMode && aiTools ? t('ai.agentRun') : t('ai.generate')}
                </Button>
              )}
              <Button size="small" variant="outlined" onClick={handleToggleEdit} disabled={!output || isStreaming}>{isEditing ? t('ai.editDone') : t('ai.edit')}</Button>
              <Button size="small" variant="outlined" onClick={() => { clearConversation(); setGoal(''); }} disabled={isEditing}>{t('ai.clear')}</Button>
              <Button size="small" variant="outlined" onClick={clearConversation} disabled={isStreaming || isEditing || conversation.length === 0}>{t('ai.newChat')}</Button>
            </Stack>
            <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>📸 {t('ai.attachMore')}</Typography>
            {historyLoading ? (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('ai.attachMoreLoading')}</Typography>
            ) : history.length === 0 ? (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('ai.attachMoreEmpty')}</Typography>
            ) : (
              <Stack spacing={0.5}>
                {history.map((it) => {
                  const sel = selectedOrder.includes(it.id);
                  return (
                    <button
                      key={it.id}
                      className={`ai-attach-thumb${sel ? ' selected' : ''}`}
                      onClick={() => toggleHistoryItem(it.id)}
                      title={it.created_at}
                      style={{ width: '100%', height: 56 }}
                    >
                      <img src={it.data_url} alt="" style={{ height: 48, borderRadius: 4 }} />
                    </button>
                  );
                })}
              </Stack>
            )}
          </Box>

          {/* 中栏：顶部常驻工具条（导出/预览/主题/润色/应用）+ 中间成稿独立滚动 + 底部输入 */}
          <Box className="ai-doc-main">
            {status === 'error' && error && (
              <Alert severity="error" sx={{ mx: 1.5, mt: 1.5, mb: 0 }}>{error}</Alert>
            )}
            {/* 常驻工具条：导出/预览/主题/润色/应用截图 分组横向排布，避免大窗里按钮散落沉底；
                无成稿时不渲染，避免留出空白条 */}
            {hasOutput && !isEditing && <div className="ai-doc-toolbar">{renderDocActions()}</div>}
            <Box
              className="ai-chat"
              sx={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, overflowY: 'auto', px: 1.5, py: 1 }}
            >
              {conversation.length === 0 && !isStreaming && !output && (
                <Typography variant="body2" sx={{ color: 'text.secondary', p: 1.5 }}>{t('ai.chatEmpty')}</Typography>
              )}
              {conversation.map((m, i) => (
                <Paper key={i} variant="outlined" sx={{ p: 1.25, mb: 1, alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: m.role === 'user' ? '80%' : '96%', bgcolor: m.role === 'user' ? 'action.selected' : 'background.paper' }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, display: 'block', mb: 0.25 }}>{m.role === 'user' ? t('ai.you') : 'AI'}</Typography>
                  {m.role === 'user' ? <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{m.content}</Typography> : <AiMarkdown source={m.content} />}
                </Paper>
              ))}
              {/* 成稿放进对话流：编辑态显示文本框；否则 agent 模式只写 output，补显示为 AI 回答 */}
              {(() => {
                if (isEditing) {
                  return (
                    <Paper variant="outlined" sx={{ p: 1.25, mb: 1, alignSelf: 'flex-start', maxWidth: '96%', width: '96%' }}>
                      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, display: 'block', mb: 0.25 }}>{t('ai.editing')}</Typography>
                      <TextField fullWidth multiline minRows={22} size="small" value={editDraft} onChange={(e) => setEditDraft(e.target.value)} spellCheck={false} />
                    </Paper>
                  );
                }
                if (output && (conversation.length === 0 || conversation[conversation.length - 1].role !== 'assistant' || conversation[conversation.length - 1].content !== output)) {
                  return (
                    <Paper variant="outlined" sx={{ p: 1.25, mb: 1, alignSelf: 'flex-start', maxWidth: '96%', bgcolor: 'background.paper' }}>
                      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, display: 'block', mb: 0.25 }}>AI</Typography>
                      <AiMarkdown source={output} sectionImages={hasSnapMarkers(output) ? orderedImages() : undefined} />
                    </Paper>
                  );
                }
                return null;
              })()}
              {agentSteps.length > 0 && (
                <div className="ai-agent-steps">
                  {agentSteps.map((st) => (
                    <div key={st.callId} className={`ai-agent-step${st.isError ? ' err' : ''}${st.source === 'shaped' ? ' shaped' : ''}`}>
                      <span className="ai-agent-step-ico">{st.result === undefined ? '⏳' : st.isError ? '⚠️' : '✓'}</span>
                      <span className="ai-agent-step-name">{t(toolLabel(st.name))}</span>
                      <span className="ai-agent-step-args">{stepArgsSummary(st.args)}</span>
                      {st.source === 'shaped' && <span className="ai-agent-step-tag" title={t('ai.shapedHint')}>{t('ai.shaped')}</span>}
                    </div>
                  ))}
                </div>
              )}
              {isStreaming && (
                <Paper variant="outlined" sx={{ p: 1.25, mb: 1, alignSelf: 'flex-start', maxWidth: '96%' }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, display: 'block', mb: 0.25 }}>AI</Typography>
                  {output ? <AiMarkdown source={output} sectionImages={hasSnapMarkers(output) ? orderedImages() : undefined} /> : <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('ai.thinking')}</Typography>}
                  <Box component="span" sx={{ ml: 0.5 }}>▋</Box>
                </Paper>
              )}
              {/* 长期记忆：置于滚动内容末尾，随对话滚动，不挤占底部输入 */}
              {renderMemory()}
            </Box>
            {/* 底部输入区：目标 + 追问（常驻，不随对话滚动） */}
            <Box sx={{ p: 1.5, borderTop: 1, borderColor: 'divider', bgcolor: 'background.default' }}>
              <TextField fullWidth multiline minRows={3} size="small" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={sentinelMode ? t('ai.sentinelGoalPh') : agentMode ? t('ai.agentGoalPh') : t('ai.goalPh')} sx={{ mb: 1 }} />
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField fullWidth multiline minRows={2} size="small" value={follow} onChange={(e) => setFollow(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleFollow(); } }} placeholder={t('ai.chatPlaceholder')} />
                <Button variant="contained" size="small" onClick={handleFollow} disabled={!follow.trim() || isStreaming} sx={{ whiteSpace: 'nowrap' }}>{t('ai.send')}</Button>
              </Stack>
            </Box>
          </Box>

          {/* 右栏：历史对话 + 文档历史库（内联，取代原弹层） */}
          <Box className="ai-doc-chat-area">
            <AiHistoryOverlay
              onClose={() => {}}
              onHide={() => {}}
              onLoadConv={(h) => setConvKey(h)}
              onPreviewHtml={openPreview}
              windowChrome={windowChrome}
              openExported={openExported}
              setLastExportedPath={setLastExportedPath}
            />
          </Box>
        </Box>
      )}

      {/* 可滚动主体（窄屏/抽屉/非三栏模式）：整体单列滚动而不被裁剪 */}
      {!(windowChrome && wide) && (
      <Box className="ai-panel-scroll">
      {/* 首次使用引导：apiKey 为空且无对话时显示 */}
      {!config.apiKey.trim() && conversation.length === 0 && (
        <Paper variant="outlined" sx={{ p: 2, mx: 1.5, my: 1, textAlign: 'center' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>{t('ai.welcomeTitle')}</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{t('ai.welcomeDesc')}</Typography>
          <Button variant="contained" size="small" onClick={() => setShowSettings(true)}>
            {t('ai.welcomeConfig')}
          </Button>
        </Paper>
      )}
      {/* 生成方式预设（内置 + 自定义） */}
      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ px: 1.5, py: 1 }}>
        {presets.map((p) => (
          <Chip
            key={p.id}
            label={`${p.custom ? '★ ' : ''}${presetLabel(p)}`}
            title={presetDesc(p)}
            onClick={() => setActivePreset(p.id)}
            color={p.id === activePresetId ? 'primary' : 'default'}
            variant={p.id === activePresetId ? 'filled' : 'outlined'}
            clickable
          />
        ))}
        <Button size="small" variant="outlined" onClick={() => setShowTemplates((v) => !v)} title={t('ai.templateManage')}>
          ✎ {t('ai.templateManage')}
        </Button>
        {aiTools && (
          <Button
            size="small"
            variant={agentMode ? 'contained' : 'outlined'}
            color="secondary"
            onClick={() => { setAgentMode((v) => !v); if (!agentMode) setSentinelMode(false); }}
            title={t('ai.agentModeDesc')}
          >
            🤖 {t('ai.agentMode')}
          </Button>
        )}
        {aiTools && (
          <Button
            size="small"
            variant={sentinelMode ? 'contained' : 'outlined'}
            color="secondary"
            onClick={() => { setSentinelMode((v) => !v); if (!sentinelMode) setAgentMode(false); }}
            title={t('ai.sentinelModeDesc')}
          >
            🔒 {t('ai.sentinelMode')}
          </Button>
        )}
      </Stack>

      {/* 自定义模板管理面板 */}
      {showTemplates && (
        <AiTemplateManager
          editing={editing}
          setEditing={setEditing}
          customPresets={customPresets}
          saveTemplate={saveTemplate}
          openNewTemplate={openNewTemplate}
          openEditTemplate={openEditTemplate}
          deleteCustomPreset={deleteCustomPreset}
        />
      )}

      {/* 需求输入 */}
      <Box sx={{ px: 1.5, py: 0.5 }}>
        <TextField
          fullWidth
          multiline
          minRows={3}
          size="small"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={
            sentinelMode ? t('ai.sentinelGoalPh') : agentMode ? t('ai.agentGoalPh') : t('ai.goalPh')
          }
        />
      </Box>

      {/* 多截图成稿 / 图文报告：从历史附加更多截图（按选择顺序组稿） */}
      <Box sx={{ px: 1.5, py: 0.5 }}>
        <Button size="small" variant="text" onClick={toggleAttach} sx={{ alignSelf: 'flex-start' }}>
          {showAttach ? '▾' : '▸'} 📎 {t('ai.attachMore')}
          {selectedOrder.length > 0 && (
            <Box component="span" sx={{ ml: 0.5, color: 'text.secondary' }}>· {t('ai.attachMoreCount', { n: selectedOrder.length })}</Box>
          )}
        </Button>
        {showAttach && (
          <Box sx={{ mt: 1 }}>
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
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('ai.selOrder')}</Typography>
                <Button size="small" variant="text" color="error" onClick={() => { setSelectedOrder([]); saveSel(convHash(imageDataUrl), []); }}>
                  {t('ai.clearSel')}
                </Button>
              </Stack>
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
          </Box>
        )}
      </Box>

      {/* 上下文选项 */}
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ px: 1.5, py: 0.75, flexWrap: 'wrap' }}>
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={agentMode || sentinelMode ? true : attachImage}
              onChange={(e) => setAttachImage(e.target.checked)}
              disabled={!imageDataUrl || agentMode || sentinelMode}
            />
          }
          label={t('ai.attachImage')}
          title={agentMode || sentinelMode ? t('ai.attachImageAgentTitle') : t('ai.attachImageTitle')}
        />
        <FormControlLabel
          control={
            <Checkbox size="small" checked={attachOcr} onChange={(e) => setAttachOcr(e.target.checked)} disabled={!ocrText} />
          }
          label={t('ai.attachOcr')}
          title={t('ai.attachOcrTitle')}
        />
        {onRefreshImage && (
          <Button size="small" variant="text" onClick={() => onRefreshImage?.()} title={t('ai.visionImageTitle')}>
            🔄 {t('ai.refreshImage')}
          </Button>
        )}
      </Stack>

      {/* 操作 */}
      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ px: 1.5, py: 1 }}>
        {isStreaming ? (
          <Button variant="contained" color="error" size="small" onClick={stop}>
            {t('ai.stop')}
          </Button>
        ) : (
          <Button
            variant="contained"
            size="small"
            onClick={(agentMode || sentinelMode) && aiTools ? handleAgentRun : handleGenerate}
            disabled={!config.apiKey.trim() || isEditing || (!(agentMode || sentinelMode) && !goal.trim())}
          >
            {sentinelMode && aiTools
              ? t('ai.sentinelRun')
              : agentMode && aiTools
                ? t('ai.agentRun')
                : t('ai.generate')}
          </Button>
        )}
        <Button
          variant="outlined"
          size="small"
          onClick={handleMakeReport}
          disabled={!config.apiKey.trim() || !goal.trim() || isStreaming || (!imageDataUrl && selectedOrder.length === 0)}
          title={t('ai.makeReportTitle')}
        >
          📑 {t('ai.makeReport')}
        </Button>
        <Button size="small" variant="outlined" onClick={handleCopy} disabled={!output || isEditing}>
          {copied ? t('ai.copied') : t('ai.copy')}
        </Button>
        <Button
          size="small"
          variant="outlined"
          onClick={handleCopyRich}
          disabled={!output || isEditing}
          title={t('ai.copyRichTitle')}
        >
          {copiedRich ? t('ai.copied') : t('ai.copyRich')}
        </Button>
        <Button
          size="small"
          variant="outlined"
          onClick={handleToggleEdit}
          disabled={!output || isStreaming}
          title={t('ai.editTitle')}
        >
          {isEditing ? t('ai.editDone') : t('ai.edit')}
        </Button>
        <Button
          size="small"
          variant="outlined"
          onClick={() => { clearConversation(); setGoal(''); }}
          disabled={isEditing}
        >
          {t('ai.clear')}
        </Button>
        <Button size="small" variant="outlined" onClick={clearConversation} disabled={isStreaming || isEditing || conversation.length === 0}>
          {t('ai.newChat')}
        </Button>
      </Stack>

      {/* 多轮对话：后续轮追问输入（生成首稿后即可逐步打磨） */}
      <Stack direction="row" spacing={1} alignItems="stretch" sx={{ px: 1.5, py: 1 }}>
        <TextField
          fullWidth
          multiline
          minRows={2}
          size="small"
          value={follow}
          onChange={(e) => setFollow(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleFollow();
            }
          }}
          placeholder={t('ai.chatPlaceholder')}
        />
        <Button
          variant="contained"
          size="small"
          onClick={handleFollow}
          disabled={!follow.trim() || isStreaming}
          sx={{ alignSelf: 'flex-end', whiteSpace: 'nowrap' }}
        >
          {t('ai.send')}
        </Button>
      </Stack>

      {/* 面板内富文本二次编辑区：编辑态显示 markdown 源 textarea（零依赖），完成时写回 output（setOutput 同步会话+落盘） */}
      {isEditing && (
        <Paper variant="outlined" sx={{ m: 1.5, p: 1.5 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{t('ai.editHint')}</Typography>
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="contained" onClick={handleToggleEdit}>{t('ai.editDone')}</Button>
              <Button size="small" variant="outlined" onClick={handleCancelEdit}>{t('ai.cancel')}</Button>
            </Stack>
          </Stack>
          <TextField
            fullWidth
            multiline
            minRows={22}
            size="small"
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            spellCheck={false}
          />
        </Paper>
      )}

      {renderDocActions()}

      {/* 接口设置弹窗已移到 .ai-panel-scroll 外部，避免 overflow 裁切 */}

      {renderMemory()}

      {/* 思考过程（Phase 16：对齐 openclaw thinking 事件流）：模型推理过程可折叠展示，
          让用户看到 AI 如何拆解截图任务；无思考内容（如普通模型）时不显示。 */}
      {thinking && (
        <Paper variant="outlined" sx={{ m: 1.5, p: 0.5 }}>
          <Button
            fullWidth
            size="small"
            onClick={() => setThinkOpen((v) => !v)}
            title={t('ai.thinkingTitle')}
            sx={{ justifyContent: 'flex-start' }}
          >
            <Box component="span" sx={{ mr: 0.5 }}>{thinkOpen ? '▾' : '▸'}</Box>
            💭 {t('ai.thinkingTitle')}
            {isStreaming && <Box component="span" sx={{ ml: 0.5, color: 'success.main' }}>●</Box>}
          </Button>
          {thinkOpen && (
            <Box sx={{ px: 0.5, pt: 0.5 }}>
              <AiMarkdown source={thinking} />
            </Box>
          )}
        </Paper>
      )}

      {/* 多轮对话记录（替代原单一 output 区）：每个截图一份线程，逐步打磨成稿 */}
      {/* 独立窗口模式（windowChrome）：空间充足，不再折叠对话区，也不显示「新弹窗」提示
          （该提示是旧侧边栏架构措辞，独立窗口下语义错误）；编辑器窗口保留原折叠行为。 */}
      <Box
        className={`ai-chat${
          !windowChrome && ((popupOpen && isStreaming) || (popupOpen && output)) ? ' collapsed' : ''
        }`}
        sx={{ display: 'flex', flexDirection: 'column' }}
        {...(!windowChrome ? { 'data-collapsed-hint': t('ai.popupChatMoved') } : {})}
      >
        {status === 'error' && (
          <Alert severity="error" sx={{ m: 1, alignItems: 'center' }}>
            <Stack direction="row" spacing={1} alignItems="center">
              <span>{error}</span>
              {(error?.includes('Key') || error?.includes('401') || error?.includes('403') || error?.includes('接口设置') || error?.includes('API Settings')) && (
                <Button size="small" variant="text" onClick={() => setShowSettings(true)}>⚙️ {t('ai.config')}</Button>
              )}
            </Stack>
          </Alert>
        )}
        {conversation.length === 0 && !isStreaming && (
          <Typography variant="body2" sx={{ color: 'text.secondary', p: 1.5 }}>{t('ai.chatEmpty')}</Typography>
        )}
        {conversation.map((m, i) => (
          <Paper
            key={i}
            variant="outlined"
            sx={{
              p: 1,
              mb: 1,
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '92%',
              bgcolor: m.role === 'user' ? 'action.selected' : 'background.paper',
            }}
          >
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, display: 'block', mb: 0.25 }}>
              {m.role === 'user' ? t('ai.you') : 'AI'}
            </Typography>
            {m.role === 'user' ? (
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{m.content}</Typography>
            ) : (
              <AiMarkdown source={m.content} />
            )}
          </Paper>
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
          <Paper variant="outlined" sx={{ p: 1, mb: 1, alignSelf: 'flex-start', maxWidth: '92%' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, display: 'block', mb: 0.25 }}>AI</Typography>
            {output ? (
              <AiMarkdown source={output} sectionImages={hasSnapMarkers(output) ? orderedImages() : undefined} />
            ) : (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>{t('ai.thinking')}</Typography>
            )}
            <Box component="span" sx={{ ml: 0.5 }}>▋</Box>
          </Paper>
        )}
      </Box>
      </Box>
      )}

      {/* 接口设置：MUI Dialog（Portal 到 body，居中视口，自动处理遮罩/Esc 关闭） */}
      {showSettings && (
        <Dialog
          open={showSettings}
          onClose={() => setShowSettings(false)}
          maxWidth="sm"
          fullWidth
          PaperProps={{ sx: { borderRadius: 2 } }}
        >
          <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <span>⚙️ {t('ai.settingsTitle')}</span>
            <IconButton size="small" onClick={() => setShowSettings(false)} aria-label={t('ai.close')}>
              ✕
            </IconButton>
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              {/* 供应商预设：一键填充 baseUrl + model */}
              <Box>
                <Typography variant="body2" sx={{ mb: 1, opacity: 0.7 }}>{t('ai.provider')}</Typography>
                <Stack direction="row" flexWrap="wrap" gap={1}>
                  {([
                    { id: 'openai', label: t('ai.providerOpenAI'), apiType: 'openai' as const, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
                    { id: 'anthropic', label: t('ai.providerAnthropic'), apiType: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
                    { id: 'deepseek', label: t('ai.providerDeepSeek'), apiType: 'openai' as const, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
                    { id: 'qwen', label: t('ai.providerQwen'), apiType: 'openai' as const, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max' },
                    { id: 'zhipu', label: t('ai.providerZhipu'), apiType: 'openai' as const, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v' },
                    { id: 'moonshot', label: t('ai.providerMoonshot'), apiType: 'openai' as const, baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
                  ]).map((p) => {
                    const active = config.baseUrl === p.baseUrl;
                    return (
                      <Chip
                        key={p.id}
                        label={p.label}
                        color={active ? 'primary' : 'default'}
                        variant={active ? 'filled' : 'outlined'}
                        onClick={() => setConfig({ apiType: p.apiType, baseUrl: p.baseUrl, model: p.model })}
                      />
                    );
                  })}
                </Stack>
              </Box>
              {/* 接口配置字段 */}
              <TextField
                select
                label={t('ai.apiType')}
                value={config.apiType}
                onChange={(e) => setConfig({ apiType: e.target.value as AiApiType })}
                fullWidth
              >
                <MenuItem value="openai">{t('ai.apiTypeOpenAI')}</MenuItem>
                <MenuItem value="anthropic">{t('ai.apiTypeAnthropic')}</MenuItem>
              </TextField>
              <TextField
                label={t('ai.baseUrl')}
                value={config.baseUrl}
                onChange={(e) => setConfig({ baseUrl: e.target.value })}
                placeholder={t('ai.baseUrlPh')}
                fullWidth
              />
              <Typography variant="caption" sx={{ opacity: 0.6 }}>{t('ai.baseUrlHint')}</Typography>
              <TextField
                label={t('ai.apiKey')}
                type={showKey ? 'text' : 'password'}
                value={config.apiKey}
                onChange={(e) => setConfig({ apiKey: e.target.value })}
                placeholder={t('ai.apiKeyPh')}
                autoComplete="off"
                spellCheck={false}
                fullWidth
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        size="small"
                        onClick={() => setShowKey((v) => !v)}
                        edge="end"
                        title={showKey ? t('ai.hideKey') : t('ai.showKey')}
                      >
                        {showKey ? '🙈' : '👁'}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />
              <TextField
                label={t('ai.model')}
                value={config.model}
                onChange={(e) => setConfig({ model: e.target.value })}
                placeholder={t('ai.modelPh')}
                fullWidth
              />
              <Box>
                <Typography variant="body2" sx={{ mb: 0.5, opacity: 0.7 }}>{t('ai.temperature')}</Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Slider
                    min={0}
                    max={1}
                    step={0.1}
                    value={config.temperature}
                    onChange={(_, v) => setConfig({ temperature: Array.isArray(v) ? v[0] : v })}
                    sx={{ flex: 1 }}
                  />
                  <Typography variant="body2" sx={{ minWidth: 32 }}>{config.temperature.toFixed(1)}</Typography>
                </Stack>
              </Box>
              {/* 测试连接 */}
              <Box>
                <Button
                  variant="outlined"
                  onClick={handleTest}
                  disabled={testing || !config.apiKey.trim()}
                  fullWidth
                >
                  {testing ? t('ai.testing') : t('ai.test')}
                </Button>
                {testMsg && (
                  <Alert severity={testMsg.includes('失败') || testMsg.includes('failed') ? 'error' : 'success'} sx={{ mt: 1 }}>
                    {testMsg}
                  </Alert>
                )}
              </Box>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button variant="contained" onClick={() => setShowSettings(false)}>
              {t('ai.save')}
            </Button>
          </DialogActions>
        </Dialog>
      )}

      {/* ── Phase 17：流式输出独立弹出框 ──
          解决右侧抽屉（400px 宽）承载过多区块时，流式输出被挤在小区域不友好的问题。
          点击「生成 / 智能编辑 / 追问 / 润色」开始流式时，自动弹出全屏居中大框（流式内容独占大空间）。
          关闭 popup ≠ 停止流式（流式继续在面板内进行，可在小面板里看完整设置/历史/导出）。
          状态机：popupPinned=true 每次都弹；popupDismissed=true 本次流式不再弹（用户主动选了"仅小面板"）。 */}
      {popupOpen && (isStreaming || output || thinking) && (
        <Dialog
          open
          onClose={() => { setPopupOpen(false); setPopupDismissed(true); }}
          maxWidth="md"
          fullWidth
          PaperProps={{ sx: { height: '82vh', maxHeight: '82vh', display: 'flex', flexDirection: 'column' } }}
        >
          <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, py: 1.5 }}>
            <Typography variant="subtitle1" noWrap>
              {isStreaming ? t('ai.popupStreaming') : t('ai.popupDone')} · {t('ai.popupTitle')}
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <Button
                size="small"
                variant={popupPinned ? 'contained' : 'outlined'}
                onClick={() => {
                  const next = !popupPinned;
                  setPopupPinned(next);
                  try { localStorage.setItem('snapcraft-ai-popup-pinned', next ? '1' : '0'); } catch {}
                }}
              >
                📌 {t('ai.popupPin')}
              </Button>
              <Button
                size="small"
                variant="outlined"
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
              </Button>
              <Button
                size="small"
                variant="outlined"
                disabled={!isStreaming}
                onClick={() => stop()}
              >
                ⏹ {t('ai.stop')}
              </Button>
              <IconButton
                size="small"
                onClick={() => { setPopupOpen(false); setPopupDismissed(true); }}
                title={t('ai.popupMinimize')}
              >
                ▾
              </IconButton>
            </Stack>
          </DialogTitle>
          <DialogContent
            dividers
            sx={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1.5, py: 2 }}
          >
            {/* 思考过程（折叠） */}
            {thinking && (
              <Box>
                <Button size="small" onClick={() => setThinkOpen((v) => !v)} sx={{ mb: 0.5 }}>
                  💭 {t('ai.thinkingTitle')} · {t('ai.thinkingChars', { n: thinking.length })}
                </Button>
                {thinkOpen && (
                  <Box sx={{ pl: 1.5, borderLeft: '2px solid', borderColor: 'divider' }}>
                    <AiMarkdown source={thinking} />
                  </Box>
                )}
              </Box>
            )}
            {/* 工具步骤（实时回显） */}
            {agentSteps.length > 0 && (
              <Stack spacing={0.5}>
                {agentSteps.map((st) => (
                  <Stack
                    key={st.callId}
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    sx={st.isError ? { color: 'error.main' } : undefined}
                  >
                    <Typography>{st.result === undefined ? '⏳' : st.isError ? '⚠️' : '✓'}</Typography>
                    <Typography variant="body2">{t(toolLabel(st.name))}</Typography>
                    {st.source === 'shaped' && (
                      <Chip size="small" label={t('ai.shaped')} title={t('ai.shapedHint')} />
                    )}
                  </Stack>
                ))}
              </Stack>
            )}
            {/* 流式输出主体 */}
            <Box sx={{ minHeight: 48 }}>
              {output ? (
                <AiMarkdown
                  source={output}
                  sectionImages={hasSnapMarkers(output) ? orderedImages() : undefined}
                />
              ) : isStreaming ? (
                <Typography color="text.secondary">{t('ai.thinking')}</Typography>
              ) : (
                <Typography color="text.secondary">—</Typography>
              )}
              {isStreaming && <Typography component="span">▋</Typography>}
            </Box>
            {/* 文档统计 */}
            {hasOutput && !isStreaming && stats && (
              <Stack direction="row" spacing={1} justifyContent="space-between" sx={{ opacity: 0.85 }}>
                <Typography variant="body2">
                  {t('ai.stats', {
                    words: stats.words.toLocaleString(),
                    lines: stats.lines,
                    minutes: stats.minutes,
                    images: orderedImages().length,
                  })}
                </Typography>
                <Typography variant="body2" title={exportNamePreview} noWrap>
                  {t('ai.exportNamePreview', { name: exportNamePreview })}
                </Typography>
              </Stack>
            )}
            {/* 导出入口 */}
            {hasOutput && !isStreaming && (
              <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center">
                <Typography variant="body2" sx={{ mr: 0.5 }}>{t('ai.export')}</Typography>
                <Button size="small" onClick={() => handleExport('md')} disabled={exporting}>.md</Button>
                <Button size="small" onClick={() => handleExport('txt')} disabled={exporting}>.txt</Button>
                <Button size="small" onClick={() => handleExport('html')} disabled={exporting}>.html</Button>
                <Button size="small" variant="contained" onClick={handleExportDocx} disabled={exporting} title={t('ai.exportDocxTitle')}>{exporting ? t('ai.exporting') : '.docx'}</Button>
                <Button size="small" onClick={handleExportPdf} disabled={exporting} title={t('ai.exportPdfTitle')}>.pdf</Button>
                <Button size="small" onClick={handlePreview} disabled={exporting} title={t('ai.previewTitle')}>👁 {t('ai.preview')}</Button>
                <Button
                  size="small"
                  onClick={() => { setShowExportHistory((v) => !v); setExportHistoryList(getExportHistory()); }}
                  title={t('ai.exportHistory')}
                >
                  📜 {t('ai.exportHistory')}
                </Button>
              </Stack>
            )}
            {/* 导出历史 */}
            {hasOutput && !isStreaming && showExportHistory && (
              <Box sx={{ pl: 1.5, borderLeft: '2px solid', borderColor: 'divider' }}>
                {exportHistoryList.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">{t('ai.exportHistoryEmpty')}</Typography>
                ) : (
                  <Stack spacing={0.5}>
                    {exportHistoryList.map((it, i) => (
                      <Stack key={`${it.path}-${i}`} direction="row" spacing={1} alignItems="center">
                        <Typography variant="caption" sx={{ minWidth: 40 }}>.{it.format}</Typography>
                        <Typography variant="body2" title={it.path} noWrap sx={{ flex: 1 }}>{baseNameOf(it.path)}</Typography>
                        <Typography variant="caption">{fmtTime(it.time)}</Typography>
                        <Button size="small" onClick={() => revealExported(it.path)} title={t('ai.exportRevealTitle')}>{t('ai.exportReveal')}</Button>
                      </Stack>
                    ))}
                    <Button size="small" color="error" onClick={() => { doClearExportHistory(); setExportHistoryList([]); }}>{t('ai.exportHistoryClear')}</Button>
                  </Stack>
                )}
              </Box>
            )}
            {/* 润色入口 */}
            {hasOutput && !isStreaming && (
              <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center">
                <Typography variant="body2" sx={{ mr: 0.5 }}>{t('ai.refine')}</Typography>
                <Chip label={t('ai.refineShorter')} onClick={() => handleRefine(t('ai.refineShorter'))} disabled={refining} />
                <Chip label={t('ai.refineLonger')} onClick={() => handleRefine(t('ai.refineLonger'))} disabled={refining} />
                <Chip label={t('ai.refineFormal')} onClick={() => handleRefine(t('ai.refineFormal'))} disabled={refining} />
                <Chip label={t('ai.refineCasual')} onClick={() => handleRefine(t('ai.refineCasual'))} disabled={refining} />
                <Chip label={t('ai.refineEn')} onClick={() => handleRefine(t('ai.refineEn'))} disabled={refining} />
              </Stack>
            )}
            {/* 回写截图 */}
            {hasOutput && !isStreaming && onApplyToScreenshot && (
              <Box>
                <Button size="small" variant="contained" onClick={handleApplyToScreenshot} title={t('ai.applyTitle')}>
                  📝 {t('ai.applyToScreenshot')}
                </Button>
              </Box>
            )}
            {/* 底部状态 */}
            <Stack spacing={0.5} sx={{ mt: 'auto', pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
              {usage.input || usage.output ? (
                <Typography variant="caption">
                  🔤 {usage.input}↑ · {usage.output}↓{usage.cacheRead ? ` · ⚡${usage.cacheRead} ${t('ai.usageCache')}` : ''}{usage.cacheCreate ? ` · 🆕${usage.cacheCreate}` : ''}
                </Typography>
              ) : null}
              {error && <Alert severity="error">{error}</Alert>}
              {exportMsg && !error && (
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="caption" color={exportErr ? 'error.main' : 'inherit'}>{exportMsg}</Typography>
                  {!exportErr && lastExportedPath && (
                    <>
                      <Button size="small" onClick={() => revealExported(lastExportedPath)} title={t('ai.exportRevealTitle')}>{t('ai.exportReveal')}</Button>
                      <Button size="small" onClick={() => openExported(lastExportedPath)} title={t('ai.openAppTitle')}>{t('ai.openApp')}</Button>
                    </>
                  )}
                </Stack>
              )}
              {applyMsg && !error && <Typography variant="caption">{applyMsg}</Typography>}
            </Stack>
          </DialogContent>
        </Dialog>
      )}

      {/* ── Phase 11：跨截图 AI 文档历史库（覆盖层，纯前端，零 Rust） ──
          列出所有截图各自的 AI 成稿线程（按截图分桶、按更新时间倒序），可搜索 / 阅读 / 载入追问 / 删除 / 导出。
          对齐 privdoc-ai 的 conversations 列表，但天然把「截图」作为文档锚点。 */}
      {showHistory && (
        <AiHistoryOverlay
          onClose={onClose}
          onHide={() => setShowHistory(false)}
          onLoadConv={(hash) => { setConvKey(hash); setShowHistory(false); }}
          onPreviewHtml={openPreview}
          windowChrome={windowChrome}
          openExported={openExported}
          setLastExportedPath={setLastExportedPath}
        />
      )}

      {/* 应用内预览层：Tauri 环境替代被 webview 拦截的 window.open 弹窗；
          同源 iframe(srcDoc) 必然允许加载，避免"预览被浏览器拦截"报错。 */}
      {previewHtml && (
        <Dialog
          open
          onClose={closePreview}
          maxWidth="lg"
          fullWidth
          PaperProps={{ sx: { height: '85vh' } }}
        >
          <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 1.5 }}>
            <span>👁 {t('ai.preview')}</span>
            <IconButton size="small" onClick={closePreview} title={t('ai.close')}>✕</IconButton>
          </DialogTitle>
          <DialogContent sx={{ p: 0, display: 'flex' }}>
            <Box
              component="iframe"
              title={t('ai.preview')}
              srcDoc={previewHtml}
              sx={{ width: '100%', height: '100%', border: 0, flex: 1 }}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
    </ThemeProvider>
  );
}
