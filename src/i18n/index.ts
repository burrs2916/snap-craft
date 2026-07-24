import { useSyncExternalStore } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import zhCN from '../locales/zh-CN.json';
import enUS from '../locales/en-US.json';
// isTauri 统一使用共享平台模块（消除各文件重复定义）
import { isTauri } from '../shared/platform';
// re-export 保持向后兼容（多处从 i18n 导入 isTauri）
export { isTauri };

/**
 * 轻量国际化引擎（零依赖，结构对齐参考项目 biosphere-terminal-app）。
 * - 语言：zh-CN / en-US，持久化到 localStorage('snapcraft-locale')
 * - 启动时按 已保存 > 浏览器语言 推断
 * - 通过 useSyncExternalStore 订阅语言变化，切换时组件自动重渲染（单窗口内）
 * - 通过 Tauri 全局事件 'snapcraft:lang-changed' 跨窗口广播：
 *   主窗口切换语言后，所有已打开的弹窗窗口（钉图 / 区域 / 窗口覆盖层）实时同步，
 *   弹窗本身不内置独立的语言选择器，统一跟随「主页面」这一个事件源。
 * - 纯前端 UI 文案翻译；后端返回的内容（OCR 文本、截图数据等）不属于 UI 文案，不在此处理
 */

export type Lang = 'zh-CN' | 'en-US';

const LANGS: Lang[] = ['zh-CN', 'en-US'];
const STORAGE_KEY = 'snapcraft-locale';
// 跨窗口语言广播事件名（主窗口 → 各弹窗窗口）
const LANG_EVENT = 'snapcraft:lang-changed';

type Dict = { [k: string]: string | Dict };

const resources: Record<Lang, Dict> = {
  'zh-CN': zhCN as Dict,
  'en-US': enUS as Dict,
};

function getInitialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh-CN' || saved === 'en-US') return saved;
  } catch {
    /* localStorage 不可用时忽略，回落到浏览器语言 */
  }
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN';
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

let current: Lang = getInitialLang();
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((l) => l());
}

function persist(lang: Lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* 忽略写入失败 */
  }
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', lang);
    // 文档标题（窗口/标签页）随语言切换，避免硬编码中文标题无法国际化
    document.title = `SnapCraft - ${translate('app.subtitle')}`;
  }
}

// 统一的应用语言入口：更新 current + 持久化 + 通知本窗口订阅者；
// broadcast=true 时通过 Tauri 全局事件广播给其它窗口（弹窗）。
// 收到广播的窗口以 broadcast=false 调用，避免回环再广播。
function applyLang(lang: Lang, broadcast: boolean) {
  if (!LANGS.includes(lang) || lang === current) return;
  current = lang;
  persist(lang);
  notifyListeners();
  if (broadcast && isTauri()) {
    emit(LANG_EVENT, lang).catch(() => {});
  }
}

persist(current);

// 订阅其它窗口广播的语言变化（仅 Tauri 环境注册，避免纯前端报错）
if (isTauri()) {
  listen<Lang>(LANG_EVENT, (e) => {
    applyLang(e.payload, false);
  }).catch(() => {});
  // v14-A P0-2 兜底：主窗在 AI 窗 mount 之前 setLang + emit，listen 异步注册可能错过事件；
  // 每 2s 读 localStorage 检测漂移并同步（轻量、零侵入，仅 Tauri 环境）
  setInterval(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && saved !== current && (saved === 'zh-CN' || saved === 'en-US')) {
        applyLang(saved, false);
      }
    } catch {
      /* 忽略 */
    }
  }, 2000);
}

export function setLang(lang: Lang) {
  applyLang(lang, true);
}

export function toggleLang() {
  applyLang(current === 'zh-CN' ? 'en-US' : 'zh-CN', true);
}

export function getLang(): Lang {
  return current;
}

// 深层查找：先按完整 key 直接命中，否则按 '.' 拆分逐层查找；未命中回退 zh-CN，再回退 key 本身
function resolve(dict: Dict, key: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(dict, key)) {
    const v = dict[key];
    if (typeof v === 'string') return v;
  }
  const parts = key.split('.');
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return typeof cur === 'string' ? cur : undefined;
}

export interface TParams {
  [k: string]: string | number;
}

export function translate(key: string, params?: TParams): string {
  const dict = resources[current] ?? resources['zh-CN'];
  let str = resolve(dict, key);
  if (str === undefined) str = resolve(resources['zh-CN'], key); // 回退到中文
  if (str === undefined) return key; // 最终回退到 key 本身，避免空白
  if (params) {
    str = str.replace(/\{(\w+)\}/g, (_m, name: string) =>
      params[name] !== undefined ? String(params[name]) : `{${name}}`
    );
  }
  return str;
}

// 稳定的模块级 t：JSX 与回调共用同一引用，避免 useCallback 依赖抖动
export const t = translate;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Lang {
  return current;
}

export function useI18n() {
  const lang = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { t, lang, toggleLang, setLang };
}

export default useI18n;
