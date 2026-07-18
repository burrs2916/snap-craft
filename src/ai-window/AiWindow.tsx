// AI 助手独立窗口主组件
//
// 复用 AIPanel 的全部能力（聊天 / 预设 / 流式 / 工具可视化 / 导出 / 历史库 / 模板 / 记忆），
// 仅把「截图上下文来源」从 props 改为经 bridge 从主窗口获取，「工具宿主」换成 RemoteToolHost
// （工具调用回传主窗口真实画布执行）。窗口级布局让 AI 助手获得完整大空间，解决原侧边抽屉局促的问题。
//
// 跨窗口 store 同步：Tauri 多窗口共享同一 origin 的 localStorage，aiStore 的对话/配置/模板
// 在 AI 窗口自动加载，无需任何 IPC 同步 store 状态。对话因 localStorage 持久化，关闭窗口不丢。

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAiStore } from '../features/ai/aiStore';
import AIPanel from '../features/ai/AIPanel';
import { t } from '../i18n';
import { RemoteToolHost } from './RemoteToolHost';
import {
  setupAiBridge,
  notifyAiClosed,
  requestRefresh,
  applyToScreenshot,
  closeAiWindow,
  setAiHost,
  MAIN_WINDOW_LABEL,
  type AiContext,
} from './bridge';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './ai-window.css';

export default function AiWindow() {
  const [ctx, setCtx] = useState<AiContext | null>(null);
  const [ready, setReady] = useState(false);
  const remoteHostRef = useRef(new RemoteToolHost(null));

  // 挂载桥接：监听宿主窗口推送的上下文，挂载后主动请求一次最新上下文
  useEffect(() => {
    let cancelled = false;
    let handles: { unlisten: (() => void)[] } | null = null;

    // 从 URL ?host= 读取「是谁开的我」（main / editor-<id>），所有工具/回写/关闭事件
    // 定向投递到该宿主窗口，避免主窗与编辑窗同时监听导致工具被两边画布各执行一遍
    const host = new URLSearchParams(window.location.search).get('host') || MAIN_WINDOW_LABEL;
    setAiHost(host);

    setupAiBridge({
      onContext: (c) => {
        setCtx(c);
        remoteHostRef.current.setSize(
          c.width && c.height ? { width: c.width, height: c.height } : null,
        );
      },
    }).then((h) => {
      if (cancelled) {
        h.unlisten.forEach((u) => u());
        return;
      }
      handles = h;
      setReady(true);
      h.requestContext();
    });

    // 窗口关闭（unload / 程序化关闭）：取消未完成任务 + 通知主窗口复位 UI 态
    // + 清理跨窗口传输的临时图片文件（save_temp_file 写入的 $TMPDIR/snapcraft-ai/*.png）
    const onUnload = () => {
      useAiStore.getState().stop();
      notifyAiClosed();
      invoke('cleanup_temp_files').catch(() => {});
    };
    window.addEventListener('beforeunload', onUnload);

    return () => {
      cancelled = true;
      window.removeEventListener('beforeunload', onUnload);
      handles?.unlisten.forEach((u) => u());
    };
  }, []);

  const handleClose = () => {
    // 取消本窗口未完成的流式请求（localStorage 已持久化已完成对话）
    useAiStore.getState().stop();
    notifyAiClosed();
    // 清理跨窗口传输的临时图片文件
    invoke('cleanup_temp_files').catch(() => {});
    closeAiWindow();
  };

  // 加载态也处于 decorations:false 的无边框窗口，同样需显式拖动；跳过关闭按钮
  const startDragLoading = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.aiwin-loading-close')) return;
    getCurrentWindow().startDragging().catch(() => {});
  };

  if (!ready || !ctx) {
    return (
      <div className="aiwin-loading" onMouseDown={startDragLoading}>
        <button
          className="aiwin-loading-close"
          onClick={handleClose}
          title={t('ai.close')}
        >
          ✕
        </button>
        <div className="aiwin-spinner" />
        <div className="aiwin-loading-text">{t('ai.windowLoading')}</div>
      </div>
    );
  }

  return (
    <AIPanel
      imageDataUrl={ctx.dataUrl}
      ocrText={ctx.ocrText}
      visionImageUrl={ctx.visionUrl}
      open
      onClose={handleClose}
      onRefreshImage={requestRefresh}
      onApplyToScreenshot={applyToScreenshot}
      aiTools={remoteHostRef.current}
      windowChrome
      live={ready && !!ctx}
    />
  );
}
