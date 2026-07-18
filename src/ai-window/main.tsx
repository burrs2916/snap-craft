// AI 助手独立窗口入口
// 复用主应用的 index.css（含 AI 面板样式与主题 CSS 变量），再用 ai-window.css 覆盖为独立窗口布局。
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../i18n'; // 初始化 i18n（与主窗口一致：<html lang> + localStorage 持久化 + 主题变量）
import '../index.css';
import './ai-window.css';
import AiWindow from './AiWindow';

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(<AiWindow />);
}
