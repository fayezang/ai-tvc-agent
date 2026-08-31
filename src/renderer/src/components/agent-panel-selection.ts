import type { CanvasNode } from "../../../shared/contracts.js";

export type AgentPanelSelection =
  | { mode: "none" | "storyboard-image" | "multiple-scripts" }
  | { mode: "script"; script: CanvasNode };

/**
 * Agent 动作区只跟随用户明确选择的节点，不从项目中猜一个“当前脚本”。
 * 静态图优先：即使框选中还包含脚本，图片的编辑动作也只留在图片节点内部。
 */
export const resolveAgentPanelSelection = (
  selectedNodes: readonly CanvasNode[]
): AgentPanelSelection => {
  if (selectedNodes.some((node) => node.kind === "storyboard-frame")) {
    return { mode: "storyboard-image" };
  }
  const scripts = selectedNodes.filter((node) => node.kind === "script");
  if (scripts.length > 1) return { mode: "multiple-scripts" };
  if (scripts.length === 1) return { mode: "script", script: scripts[0]! };
  return { mode: "none" };
};
