import { create } from 'zustand';
import type { ProFeature } from './licenseTypes';

interface UpgradeDialogState {
  open: boolean;
  /// The feature that triggered the dialog (used to highlight it in the list).
  triggerFeature: ProFeature | null;
  openDialog: (feature?: ProFeature) => void;
  closeDialog: () => void;
}

export const useUpgradeDialogStore = create<UpgradeDialogState>((set) => ({
  open: false,
  triggerFeature: null,
  openDialog: (feature) => set({ open: true, triggerFeature: feature ?? null }),
  closeDialog: () => set({ open: false }),
}));
