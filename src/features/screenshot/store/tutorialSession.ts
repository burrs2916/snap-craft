// 教程捕获模式 —— 轻量会话状态（薄编排层）
//
// 设计原则（非侵入，零破坏性）：
//  - 本 store 只是一个「教程草稿」：{ active, ids[] }，记录当前正在收集的教程步骤顺序。
//  - 截屏 / 导入落库后，若会话 active，则把新图 id append 进 ids（在 onCaptured /
//    handleImportFiles 里调用 addStep）。编辑器 / 截屏链路 / 页面布局完全不碰。
//  - 生成教程复用现有 AIPanel 的 generate（tutorial 预设 + buildReportUser 嵌图），
//    本 store 不持有任何生成逻辑，只负责「按顺序收集步骤」。
//  - cancel() 直接清空，不残留。

import { create } from 'zustand';

export interface TutorialSessionState {
  active: boolean;
  /** 已收集的步骤图片 id（按收集顺序排列，对应历史库 HistoryItem.id） */
  ids: string[];
  startTutorial: () => void;
  addStep: (id: string) => void;
  removeStep: (id: string) => void;
  /** 拖拽重排：把 from 位置项移到 to 位置 */
  reorder: (from: number, to: number) => void;
  cancel: () => void;
}

export const useTutorialSession = create<TutorialSessionState>((set) => ({
  active: false,
  ids: [],
  startTutorial: () => set({ active: true, ids: [] }),
  addStep: (id) =>
    set((s) => (s.active && !s.ids.includes(id) ? { ids: [...s.ids, id] } : s)),
  removeStep: (id) => set((s) => ({ ids: s.ids.filter((x) => x !== id) })),
  reorder: (from, to) =>
    set((s) => {
      if (from < 0 || from >= s.ids.length || to < 0 || to >= s.ids.length || from === to) {
        return s;
      }
      const next = s.ids.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { ids: next };
    }),
  cancel: () => set({ active: false, ids: [] }),
}));
