import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n'; // 初始化 i18n（设置 <html lang> 与 localStorage 持久化）
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
