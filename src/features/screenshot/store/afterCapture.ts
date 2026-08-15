// 截后自动化规则链 —— 轻量配置（薄编排层，非侵入）
//
// 设计原则（与教程捕获模式一致，零破坏性）：
//  - 本 store 只是「一条自动化规则」：{ enabled, trigger, actions[] }，决定「截屏/导入落库后，
//    按顺序自动执行哪些原子动作」（复制图片 / 存盘到文件夹 / OCR 并复制文字 / 打开编辑器 /
//    在文件夹显示 / 打开外部文件）。
//  - 所有原子动作都是已有 Rust 命令（copy_to_clipboard / save_screenshot / ocr_image /
//    set_screenshot_ocr / open_external / reveal_in_folder / openEditorWindow），本模块不新
//    增任何后端逻辑，纯前端 0 Rust。
//  - onCaptured / handleImportFiles 落库成功后调用 runAfterCapture()；若规则未启用则调用方保留
//    现有硬编码行为（如自动复制图片）作为 fallback，零回归。
//  - 配置持久化到 localStorage（zustand persist），不碰任何 Rust 状态 / 历史库 schema。

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { openEditorWindow } from '../components/EditorWindow';
import { t } from '../../../i18n';

export type AfterCaptureActionType =
  | 'copy_image'
  | 'save'
  | 'ocr_copy_text'
  | 'open_editor'
  | 'reveal'
  | 'open_external';

export interface AfterCaptureAction {
  type: AfterCaptureActionType;
  /** save 动作：目标目录（绝对路径） */
  saveDir?: string;
  /** open_external 动作：要打开的文件/URL（缺省时用 save 落盘路径） */
  openTarget?: string;
}

export type AfterCaptureTrigger = 'capture' | 'import' | 'both';

/** i18n key，供设置 UI 显示动作名 */
export const ACTION_LABEL_KEYS: Record<AfterCaptureActionType, string> = {
  copy_image: 'automation.action.copyImage',
  save: 'automation.action.save',
  ocr_copy_text: 'automation.action.ocrCopyText',
  open_editor: 'automation.action.openEditor',
  reveal: 'automation.action.reveal',
  open_external: 'automation.action.openExternal',
};

/** save / open_external 需要参数，其余动作无参数 */
export const ACTION_NEEDS_PARAM: Partial<Record<AfterCaptureActionType, 'saveDir' | 'openTarget'>> = {
  save: 'saveDir',
  open_external: 'openTarget',
};

interface AfterCaptureState {
  enabled: boolean;
  trigger: AfterCaptureTrigger;
  actions: AfterCaptureAction[];
  setEnabled: (v: boolean) => void;
  setTrigger: (t: AfterCaptureTrigger) => void;
  addAction: (a: AfterCaptureAction) => void;
  removeAction: (idx: number) => void;
  reorder: (from: number, to: number) => void;
  updateAction: (idx: number, patch: Partial<AfterCaptureAction>) => void;
}

interface RunCtx {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  isFirst: boolean;
}

/** 时间戳文件名：snapcraft-YYYYMMDD-HHmmss.png（与现有命名一致） */
function fileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// save 动作落盘后记录路径，供后续 reveal / open_external 复用
let lastSavedPath: string | null = null;

async function runOne(action: AfterCaptureAction, ctx: RunCtx): Promise<void> {
  const { id, dataUrl, width, height, isFirst } = ctx;
  switch (action.type) {
    case 'copy_image':
      await invoke('copy_to_clipboard', { imageData: dataUrl });
      break;
    case 'save': {
      if (!action.saveDir) break;
      const path = `${action.saveDir}/snapcraft-${fileStamp()}.png`;
      await invoke('save_screenshot', { imageData: dataUrl, filePath: path });
      lastSavedPath = path;
      break;
    }
    case 'ocr_copy_text': {
      // 复用现有 ocr_image 命令（与 useOcrPanel.runOcr 同款），lang=null 走自动语言
      const res = await invoke<{ text?: string }>('ocr_image', { imageData: dataUrl, lang: null });
      const text = (res?.text ?? '').trim();
      if (text) {
        await navigator.clipboard.writeText(text).catch(() => {});
        // 顺手把 OCR 结果写回历史，便于后续检索 / 复用
        await invoke('set_screenshot_ocr', { id, ocrText: text }).catch(() => {});
      }
      break;
    }
    case 'open_editor':
      // 批量（多张导入）时仅首张开编辑器，避免窗口泛滥
      if (isFirst) await openEditorWindow({ id, width, height });
      break;
    case 'reveal':
      if (lastSavedPath) await invoke('reveal_in_folder', { path: lastSavedPath });
      break;
    case 'open_external': {
      const target = action.openTarget || lastSavedPath;
      if (target) await invoke('open_external', { target });
      break;
    }
  }
}

/**
 * 执行截后自动化。规则未启用或不匹配触发时机时直接返回（调用方保留 fallback）。
 * @param source 本次触发来源：'capture' 截屏 / 'import' 导入
 * @param isFirst 批量时是否为首张（open_editor 仅对首张生效）
 */
export async function runAfterCapture(
  source: 'capture' | 'import',
  id: string,
  dataUrl: string,
  width: number,
  height: number,
  isFirst = true,
  onToast?: (message: string, kind: 'success' | 'error' | 'info') => void,
): Promise<void> {
  const { enabled, trigger, actions } = useAfterCapture.getState();
  if (!enabled) return;
  if (trigger !== 'both' && trigger !== source) return;
  lastSavedPath = null;
  const failed: string[] = [];
  for (const action of actions) {
    try {
      await runOne(action, { id, dataUrl, width, height, isFirst });
    } catch (e) {
      // 单个动作失败不阻断后续动作 / 不打断用户截屏流
      failed.push(action.type);
      console.warn('[afterCapture] action failed:', action.type, e);
    }
  }
  // 本地化执行反馈（调用方决定要不要显示；批量导入由调用方统一汇总，不在此重复）
  if (onToast) {
    if (actions.length === 0) {
      onToast(t('automation.empty'), 'info');
    } else if (failed.length > 0) {
      onToast(t('automation.partialFailed', { n: failed.length }), 'error');
    } else {
      onToast(t('automation.ran', { n: actions.length }), 'success');
    }
  }
}

export const useAfterCapture = create<AfterCaptureState>()(
  persist(
    (set) => ({
      enabled: false,
      trigger: 'both',
      // 默认模板：截屏后自动复制图片（与现有硬编码行为对齐，可编辑）
      actions: [{ type: 'copy_image' }],
      setEnabled: (v) => set({ enabled: v }),
      setTrigger: (t) => set({ trigger: t }),
      addAction: (a) => set((s) => ({ actions: [...s.actions, a] })),
      removeAction: (idx) =>
        set((s) => ({ actions: s.actions.filter((_, i) => i !== idx) })),
      reorder: (from, to) =>
        set((s) => {
          const arr = s.actions.slice();
          if (from < 0 || from >= arr.length || to < 0 || to >= arr.length) return s;
          const [moved] = arr.splice(from, 1);
          arr.splice(to, 0, moved);
          return { actions: arr };
        }),
      updateAction: (idx, patch) =>
        set((s) => ({
          actions: s.actions.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
        })),
    }),
    {
      name: 'snapcraft-after-capture',
      partialize: (s) => ({ enabled: s.enabled, trigger: s.trigger, actions: s.actions }),
    },
  ),
);
