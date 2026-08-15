// AI 助手独立窗口 —— 跨窗口 IPC 通信层
//
// 设计原则（UX-first，零新 Rust 依赖，零破坏性）：
//  - 主窗口（main）与 AI 窗口（ai-panel）各自是一个 Tauri WebviewWindow，
//    共享同一 origin 的 localStorage → aiStore 的对话/配置/模板自动跨窗口可见，无需同步 store 状态。
//  - 需要跨窗口传的只有「当前截图 dataUrl + 编辑后 visionUrl + OCR 文字 + 尺寸」这些不在 localStorage 的内容。
//  - 大图（dataUrl 可达数 MB）走 Rust 临时文件命令（save/read_temp_file）零感知传输，避免 Event 分片抖动。
//  - AI Agent 工具调用经 IPC 转发主窗口执行（主窗口 addAnnotation/flashRegion 在真实画布生效）：
//      · draw/redact/highlight/arrow/callout 为同步接口约定，走 fire-and-forget + 本地坐标串反馈；
//      · summarize_region 为 async，走请求/响应拿 OCR 结果。
//  - 窗口关闭：取消本窗口未完成任务 + 通知主窗口复位 UI 态（已完成对话因 localStorage 自动持久化不丢）。

import { invoke } from '@tauri-apps/api/core';
import { listen, emitTo, TauriEvent, type UnlistenFn, type Event } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window';

export const AI_WINDOW_LABEL = 'ai-panel';
export const MAIN_WINDOW_LABEL = 'main';

// AI 窗口的「宿主」窗口 label：决定工具调用 / 回写 / 关闭 / 请求上下文等事件
// 定向投递到哪个窗口（避免主窗与编辑窗同时监听导致工具被两边画布各执行一遍）。
// 由 AI 窗口挂载时按 URL ?host= 设定；openAiWindow 记录当前宿主用于重建判定。
let aiHost: string = MAIN_WINDOW_LABEL;
let currentAiHost: string = MAIN_WINDOW_LABEL;
export function setAiHost(label: string): void {
  aiHost = label || MAIN_WINDOW_LABEL;
}

// 事件名（集中定义，避免拼写漂移）
const EVT_CONTEXT = 'ai:context'; // 主 → AI：推送上下文（大图走临时文件 filename）
const EVT_REQ_CONTEXT = 'ai:request-context'; // AI → 主：请求一次上下文
const EVT_TOOL = 'ai:tool'; // AI → 主：工具调用（fire-and-forget 或等待结果）
const EVT_TOOL_RESULT = 'ai:tool:result'; // 主 → AI：工具结果（请求/响应模式）
const EVT_CLOSED = 'ai:closed'; // AI → 主：窗口已关闭
const EVT_APPLY = 'ai:apply'; // AI → 主：把 AI 文案回写为截图标注
const EVT_REFRESH = 'ai:refresh'; // AI → 主：请求重新同步「编辑后截图」
export const EVT_COMMIT = 'ai:commit'; // AI → 主：Agent 改过画布后，固化编辑产物为当前截图

export interface AiStyle {
  color: string;
  lineWidth: number;
}

// 主窗口推送载荷（不含大图本体，仅临时文件名 + 元数据）
export interface AiContextPush {
  dataFilename: string;
  visionFilename?: string;
  ocrText?: string;
  width?: number;
  height?: number;
}

// AI 窗口解析后的完整上下文（含 base64 dataUrl 本体）
export interface AiContext {
  dataUrl: string;
  visionUrl?: string;
  ocrText?: string;
  style?: AiStyle;
  width?: number;
  height?: number;
}

interface ToolCallMsg {
  callId: string;
  name: string;
  args: Record<string, any>;
}
interface ToolResultMsg {
  callId: string;
  content: string;
  isError?: boolean;
}

// ── 临时文件 helper ──
export async function saveTempImage(dataUrl: string): Promise<string> {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  return invoke<string>('save_temp_file', { contentBase64: base64 });
}

export async function readTempImage(filename: string): Promise<string> {
  const base64 = await invoke<string>('read_temp_file', { filename });
  return `data:image/png;base64,${base64}`;
}

// ───────────────────────── 主窗口侧 API ─────────────────────────

/** 打开（或聚焦已打开的）AI 窗口。窗口右侧贴着主窗口摆放，避免遮挡真实截图。 */
export async function openAiWindow(
  ctx: AiContext | null,
  host: string = MAIN_WINDOW_LABEL,
  tutorialIds?: string[],
): Promise<WebviewWindow | null> {
  try {
    const existing = await WebviewWindow.getByLabel(AI_WINDOW_LABEL);
    if (existing) {
      // 教程注入需求（tutorialIds）或宿主切换：销毁旧窗、按新参数重建，
      // 确保 URL(?tutorialIds=) 生效（教程成稿需全新窗口承载自动生成）。
      if (tutorialIds || currentAiHost !== host) {
        await existing.close().catch(() => {});
      } else {
        await existing.show();
        await existing.setFocus();
        if (ctx) void pushAiContext(ctx);
        return existing;
      }
    }
    currentAiHost = host;
    // 用 localStorage（同源 webview 共享）传递 host / tutorialIds 给 AI 窗口，
    // 替代原先 URL 查询串 `ai-panel.html?host=...`。运行时 WebView2 带 ?query 打开
    // 独立窗口时，Windows 上偶发子资源(CSS/JS)解析异常、样式丢失；去查询串可规避。
    try {
      localStorage.setItem('snapcraft-ai-host', host);
      localStorage.setItem(
        'snapcraft-ai-tutorialIds',
        tutorialIds && tutorialIds.length ? tutorialIds.join(',') : '',
      );
    } catch {
      /* localStorage 不可用时退回默认行为 */
    }
    // 窗口默认宽 > 1080：否则会落在 @container(max-width:1080px) 降级两栏
    // （对话区被压到下方 38vh），用户始终看不到「左导航/中内容/右对话」完整三栏，
    // 体感「不是完整窗口、功能局促」。给足余量：三栏最小宽 220+420+340+间距≈1040。
    const WIN_W = 1140;
    const WIN_H = 780;
    const GAP = 16;
    let x = 140;
    let y = 90;
    try {
      const opener = getCurrentWindow();
      const pos = await opener.outerPosition(); // 物理像素
      const size = await opener.outerSize(); // 物理像素
      const sf = (await currentMonitor())?.scaleFactor || 1;
      // 当前屏工作区（已排除菜单栏/Dock），物理px÷scaleFactor 转逻辑
      const mon = await currentMonitor();
      const wa = mon
        ? {
            x: mon.workArea.position.x / sf,
            y: mon.workArea.position.y / sf,
            w: mon.workArea.size.width / sf,
            h: mon.workArea.size.height / sf,
          }
        : { x: 0, y: 0, w: 10000, h: 10000 }; // 兜底：不钳制

      const opX = pos.x / sf;
      const opY = pos.y / sf;
      const opW = size.width / sf;

      // 优先放主窗右侧；放不下（超出工作区右界）则回退左侧；再不行居中兜底
      const rightX = opX + opW + GAP;
      const leftX = opX - WIN_W - GAP;
      if (rightX + WIN_W <= wa.x + wa.w) {
        x = rightX;
      } else if (leftX >= wa.x) {
        x = leftX;
      } else {
        x = wa.x + Math.max(0, (wa.w - WIN_W) / 2);
      }
      y = opY;

      // 整体钳制进工作区，确保整窗始终完整可见（避免「只有一半显示」）
      if (x + WIN_W > wa.x + wa.w) x = Math.max(wa.x, wa.x + wa.w - WIN_W);
      if (x < wa.x) x = wa.x;
      if (y + WIN_H > wa.y + wa.h) y = Math.max(wa.y, wa.y + wa.h - WIN_H);
      if (y < wa.y) y = wa.y;
    } catch {
      /* 用默认坐标 */
    }
    const win = new WebviewWindow(AI_WINDOW_LABEL, {
      title: 'SnapCraft AI',
      url: 'ai-panel.html',
      devtools: true, // 允许在 AI 窗口内右键 Inspect 调试（Windows 运行时窗口默认关闭）
      width: WIN_W,
      height: WIN_H,
      minWidth: 680,
      minHeight: 480,
      x,
      y,
      resizable: true,
      // 与编辑器弹出框（openEditorWindow）保持一致：完整系统窗口（系统标题栏 + 边框，
      // 可最小化/最大化/多屏拖动），解决「无边框自绘窗不是完整 windows、功能局促」的问题。
      // 自绘标题栏（ai-panel-head--win）已在 AIPanel 侧按 windowChrome 分支移除，避免系统标题栏 + 自绘头部双层 header。
      decorations: true,
      minimizable: true,
      maximizable: true,
    });
    // 崩溃兜底：AI 窗口被销毁（webview 崩溃 / 进程异常退出）时页面侧 beforeunload
    // 不会执行 → EVT_CLOSED 永不发出 → 宿主窗 aiOpen 卡 true（工具栏常亮、
    // 上下文推送 effect 误判窗仍开着）。监听窗口级 tauri://destroyed 事件，
    // 销毁时补发关闭通知给宿主。正常关闭会先后触发 notifyClosed 与本回调，
    // setAiOpen(false) 幂等，无副作用。
    win
      .once(TauriEvent.WINDOW_DESTROYED, () => {
        void emitTo(host, EVT_CLOSED).catch(() => {});
      })
      .catch(() => {});
    // 初始上下文：窗口挂载后会主动 request，这里也推一次，双保险
    if (ctx) {
      setTimeout(() => {
        void pushAiContext(ctx);
      }, 300);
    }
    return win;
  } catch (e) {
    console.error('[bridge] openAiWindow failed', e);
    return null;
  }
}

/** 把完整上下文经临时文件推送给 AI 窗口 */
export async function pushAiContext(ctx: AiContext): Promise<void> {
  try {
    const dataFilename = await saveTempImage(ctx.dataUrl);
    const visionFilename =
      ctx.visionUrl && ctx.visionUrl !== ctx.dataUrl ? await saveTempImage(ctx.visionUrl) : undefined;
    const push: AiContextPush = {
      dataFilename,
      visionFilename,
      ocrText: ctx.ocrText,
      width: ctx.width,
      height: ctx.height,
    };
    await emitTo(AI_WINDOW_LABEL, EVT_CONTEXT, push);
  } catch (e) {
    console.error('[bridge] pushAiContext failed', e);
  }
}

export interface MainBridgeHandles {
  unlisten: UnlistenFn[];
}

/**
 * 在主窗口挂载监听：
 *  - AI 窗口请求上下文时回推最新上下文；
 *  - AI 窗口发起工具调用时，用本窗口真实的 aiTools 执行（在主画布生效）并回传结果；
 *  - AI 窗口关闭 / 回写文案 / 刷新视觉时回调上层。
 */
export async function setupMainBridge(opts: {
  getCtx: () => AiContext | null;
  execTool: (name: string, args: Record<string, any>) => Promise<{ content: string; isError?: boolean }>;
  onClosed?: () => void;
  onApply?: (text: string) => void;
  onRefresh?: () => void;
  onCommit?: () => void;
}): Promise<MainBridgeHandles> {
  const unsubs: UnlistenFn[] = [];
  unsubs.push(
    await listen(EVT_REQ_CONTEXT, async () => {
      const ctx = opts.getCtx();
      if (ctx) await pushAiContext(ctx);
    }),
  );
  unsubs.push(
    await listen<ToolCallMsg>(EVT_TOOL, async (e: Event<ToolCallMsg>) => {
      const { callId, name, args } = e.payload;
      try {
        const res = await opts.execTool(name, args);
        await emitTo(AI_WINDOW_LABEL, EVT_TOOL_RESULT, { callId, ...res } as ToolResultMsg);
      } catch (err: any) {
        await emitTo(AI_WINDOW_LABEL, EVT_TOOL_RESULT, {
          callId,
          content: `工具执行异常：${err?.message ?? err}`,
          isError: true,
        } as ToolResultMsg);
      }
    }),
  );
  unsubs.push(
    await listen<string>(EVT_APPLY, (e: Event<string>) => {
      opts.onApply?.(e.payload);
    }),
  );
  unsubs.push(
    await listen(EVT_REFRESH, () => {
      opts.onRefresh?.();
    }),
  );
  unsubs.push(
    await listen(EVT_COMMIT, () => {
      opts.onCommit?.();
    }),
  );
  unsubs.push(
    await listen(EVT_CLOSED, () => {
      opts.onClosed?.();
    }),
  );
  return { unlisten: unsubs };
}

// ───────────────────────── AI 窗口侧 API ─────────────────────────

export interface AiBridgeHandles {
  requestContext: () => void;
  unlisten: UnlistenFn[];
}

/** 在 AI 窗口挂载监听：主窗口推送上下文时解析（读临时文件）并回调。返回请求函数。 */
export async function setupAiBridge(opts: {
  onContext: (ctx: AiContext) => void;
}): Promise<AiBridgeHandles> {
  const unsubs: UnlistenFn[] = [];
  unsubs.push(
    await listen<AiContextPush>(EVT_CONTEXT, async (e: Event<AiContextPush>) => {
      const p = e.payload;
      try {
        const dataUrl = await readTempImage(p.dataFilename);
        const visionUrl = p.visionFilename ? await readTempImage(p.visionFilename) : undefined;
        opts.onContext({
          dataUrl,
          visionUrl: visionUrl || dataUrl,
          ocrText: p.ocrText,
          width: p.width,
          height: p.height,
        });
      } catch (err) {
        console.error('[bridge] onContext failed', err);
      }
    }),
  );
  const requestContext = () => {
    void emitTo(aiHost, EVT_REQ_CONTEXT).catch(() => {});
  };
  return { requestContext, unlisten: unsubs };
}

/** 工具：fire-and-forget（draw/redact/highlight/arrow/callout 不需要返回，本地算坐标串即可） */
export function emitTool(name: string, args: Record<string, any>): void {
  const callId = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  void emitTo(aiHost, EVT_TOOL, { callId, name, args }).catch(() => {});
}

/** 工具：请求/响应（summarize_region 需要 OCR 结果） */
export async function callTool(
  name: string,
  args: Record<string, any>,
): Promise<{ content: string; isError?: boolean }> {
  const callId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    let unsub: UnlistenFn | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      unsub?.();
    };
    const handler = (e: Event<ToolResultMsg>) => {
      if (e.payload.callId === callId) {
        cleanup();
        resolve({ content: e.payload.content, isError: e.payload.isError });
      }
    };
    listen<ToolResultMsg>(EVT_TOOL_RESULT, handler).then((u) => {
      // 竞态修复：若超时已先于 listen 注册完成触发 cleanup，此时 unsub 为 null 会漏卸载，
      // 导致 EVT_TOOL_RESULT 监听器泄漏。已结算则注册即卸载。
      if (cleaned) {
        u();
      } else {
        unsub = u;
      }
    });
    void emitTo(aiHost, EVT_TOOL, { callId, name, args }).catch(() => {});
    // v14 修复：主窗未响应（崩溃/未监听）时 Promise 永久挂起会卡死整段生成；加超时兜底
    timer = setTimeout(() => {
      cleanup();
      resolve({ content: `工具调用超时（${name}）：主窗口未在 15s 内回应`, isError: true });
    }, 15000);
  });
}

/** AI 窗口「同步最新编辑」按钮 → 请求宿主窗口重算 visionUrl 并推送 */
export function requestRefresh(): void {
  void emitTo(aiHost, EVT_REFRESH).catch(() => {});
}

/** AI 文案 → 截图标注回写（发给宿主窗口执行） */
export function applyToScreenshot(text: string): void {
  void emitTo(aiHost, EVT_APPLY, text).catch(() => {});
}

/** 通知宿主窗口固化本次 AI 编辑产物（仅当 Agent 改过画布时由 AI 窗口在结束时调用） */
export function notifyAiCommit(): void {
  void emitTo(aiHost, EVT_COMMIT).catch(() => {});
}

/** 通知宿主窗口本 AI 窗口已关闭（复位 UI 态） */
export function notifyAiClosed(): void {
  void emitTo(aiHost, EVT_CLOSED).catch(() => {});
}

/** 关闭 AI 窗口自身 */
export function closeAiWindow(): void {
  void getCurrentWindow()
    .close()
    .catch(() => {});
}
