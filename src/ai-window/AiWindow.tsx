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
import { ModelConfigPage } from '../features/ai/ModelConfigPage';
import { AiAgentManager } from '../features/ai/AiAgentManager';
import { t, useI18n } from '../i18n';
import { RemoteToolHost } from './RemoteToolHost';
import { Tabs, Tab } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import { useAiTheme } from '../features/ai/aiTheme';
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
  // 订阅语言切换：独立 AI 窗口是单独的 React 根，不订阅 useI18n 时主窗口切换
  // 语言不会触发本窗口（含 AIPanel 子树）重渲染，残留旧语言文案。
  useI18n();
  const theme = useAiTheme();
  const [tab, setTab] = useState<'doc' | 'settings' | 'agent'>('doc');
  const { agents, config, upsertAgent, deleteAgent } = useAiStore();
  const [ctx, setCtx] = useState<AiContext | null>(null);
  const [ready, setReady] = useState(false);
  const remoteHostRef = useRef(new RemoteToolHost(null));

  // 教程捕获模式：主窗收集步骤后通过 URL ?tutorialIds= 注入，透传给 AIPanel 受控自动成稿
  // host / tutorialIds 由 bridge 经同源 localStorage 写入（替代 URL 查询串，规避
  // Windows 运行时 WebView2 带 ?query 打开独立窗口时的子资源解析异常）。
  const tutorialIdsRaw = localStorage.getItem('snapcraft-ai-tutorialIds');
  const tutorialIds = tutorialIdsRaw ? tutorialIdsRaw.split(',').filter(Boolean) : undefined;

  // 挂载桥接：监听宿主窗口推送的上下文，挂载后主动请求一次最新上下文
  useEffect(() => {
    let cancelled = false;
    let handles: { unlisten: (() => void)[] } | null = null;

    // 从 URL ?host= 读取「是谁开的我」（main / editor-<id>），所有工具/回写/关闭事件
    // 定向投递到该宿主窗口，避免主窗与编辑窗同时监听导致工具被两边画布各执行一遍
    const host = localStorage.getItem('snapcraft-ai-host') || MAIN_WINDOW_LABEL;
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
    <ThemeProvider theme={theme}>
      <div className="aiwin-shell">
        {/* 最左侧竖向标签栏：文档 / 模型接入 / 智能体 */}
        <aside className="aiwin-rail">
          <Tabs
            value={tab}
            onChange={(_, v) => setTab(v)}
            orientation="vertical"
            className="aiwin-tabs"
          >
            <Tab value="doc" label={t('ai.tabDoc')} />
            <Tab value="settings" label={t('ai.tabSettings')} />
            <Tab value="agent" label={t('ai.tabAgent')} />
          </Tabs>
        </aside>
        <div className="aiwin-content">
          {tab === 'doc' && (
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
              tutorialIds={tutorialIds}
            />
          )}
          {tab === 'settings' && <ModelConfigPage />}
          {tab === 'agent' && (
            <AiAgentManager
              agents={agents}
              config={config}
              onClose={() => setTab('doc')}
              onUpsert={upsertAgent}
              onDelete={deleteAgent}
            />
          )}
        </div>
      </div>
    </ThemeProvider>
  );
}
