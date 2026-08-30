import { create } from "zustand";

interface UiState {
  agentPanelOpen: boolean;
  agentPanelWidth: number;
  selectedNodeIds: string[];
  setAgentPanelOpen(open: boolean): void;
  setAgentPanelWidth(width: number): void;
  setSelectedNodeIds(ids: string[]): void;
}

export const useUiStore = create<UiState>((set) => ({
  agentPanelOpen: true,
  agentPanelWidth: 420,
  selectedNodeIds: [],
  setAgentPanelOpen: (agentPanelOpen) => set({ agentPanelOpen }),
  setAgentPanelWidth: (agentPanelWidth) => set({ agentPanelWidth: Math.min(620, Math.max(340, agentPanelWidth)) }),
  setSelectedNodeIds: (selectedNodeIds) => set({ selectedNodeIds })
}));
