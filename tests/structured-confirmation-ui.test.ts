import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CanvasNode } from "../src/shared/contracts.js";
import { resolveAgentPanelSelection } from "../src/renderer/src/components/agent-panel-selection.js";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("structured Agent confirmation flow", () => {
  test("keeps confirmation controls out of canvas nodes", () => {
    const documentNode = read("../src/renderer/src/components/document-node.tsx");
    const canvasWorkspace = read("../src/renderer/src/components/canvas-workspace.tsx");
    expect(documentNode).not.toContain("确认 Brief");
    expect(documentNode).not.toContain("confirmBrief");
    expect(documentNode).toContain("NodeResizeControl");
    expect(documentNode).toContain('position="bottom-right"');
    expect(documentNode).toContain('resizeDirection="vertical"');
    expect(documentNode).toContain("上下拖动调整高度");
    expect(canvasWorkspace).toContain('change.type !== "select"');
    expect(canvasWorkspace).toContain("selectedIds.has(node.id)");
  });

  test("confirms a five-column script and generates one independent image per prompt", () => {
    const agentPanel = read("../src/renderer/src/components/agent-panel.tsx");
    const workflow = read("../src/utility/workflow-service.ts");
    const agentService = read("../src/utility/agent-service.ts");
    expect(agentPanel).toContain("生成静态效果图");
    expect(agentPanel).toContain("生成完整视频");
    expect(agentPanel).toContain("scriptNodeId: activeScript.id");
    expect(workflow).toContain("| 镜头编号 | 时长 | Prompt | Audio & SFX | VO |");
    expect(agentService).toContain("prompt: shot.prompt");
    expect(agentService).toContain("createStoryboardFrameNode");
  });

  test("keeps image prompt revisions manual and preserves version history", () => {
    const imageNode = read("../src/renderer/src/components/storyboard-image-node.tsx");
    const agentService = read("../src/utility/agent-service.ts");
    expect(imageNode).toContain("使用此 Prompt 重新生成");
    expect(imageNode).toContain("agent.regenerateStoryboardImage");
    expect(imageNode).not.toContain("onBlur={() => void regenerate()");
    expect(agentService).toContain("versions: [...manifest.versions, version]");
    expect(agentService).toContain("selectedVersionId: version.status === \"ready\"");
  });

  test("creates unlimited complete script versions from applied image prompts", () => {
    const imageNode = read("../src/renderer/src/components/storyboard-image-node.tsx");
    const workflow = read("../src/utility/workflow-service.ts");
    const service = read("../src/utility/agent-service.ts");
    expect(imageNode).toContain("应用到新脚本版本");
    expect(imageNode).toContain("agent.applyStoryboardImage");
    expect(workflow).toContain("createNextScriptVersion");
    expect(workflow).toContain("Math.max(");
    expect(workflow).toContain("replaceScriptPromptInMarkdown");
    expect(workflow).toContain("line.slice(0, start)");
    expect(service).not.toContain("Convert this still-image prompt into a production-ready image-to-video prompt");
    expect(service).toContain("prompt: selected.prompt");
  });

  test("uses the selected script only and shows a paid confirmation before native-audio generation", () => {
    const agentPanel = read("../src/renderer/src/components/agent-panel.tsx");
    const service = read("../src/utility/agent-service.ts");
    const contracts = read("../src/shared/contracts.ts");
    expect(agentPanel).toContain("生成最终视频");
    expect(agentPanel).toContain('aria-label="最终视频生成步骤"');
    expect(agentPanel).toContain("完整视频 Prompt（生成前可编辑）");
    expect(agentPanel).not.toContain("查看报价");
    expect(agentPanel).toContain('const steps = ["完整视频 Prompt", "确认生成"]');
    expect(agentPanel).toContain("第 2 步 · 确认生成");
    expect(agentPanel).toContain("本次生成总价");
    expect(agentPanel).toContain("正在计算本次生成总价");
    expect(agentPanel).toContain('scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" })');
    expect(agentPanel).toContain("点击确认后才会向 ORZ 提交任务并产生费用");
    expect(agentPanel).toContain("generateAudio: true");
    expect(agentPanel).toContain("referenceImageUrls: []");
    expect(service).not.toContain("必须选择 ${shots.length} 张图片");
    expect(service).not.toContain("每个镜头必须且只能选择一张静态图");
    expect(service).toContain("Speak every VO line literally and verbatim");
    const videoPromptContract = contracts.slice(
      contracts.indexOf("GenerateVideoPromptRequestSchema"),
      contracts.indexOf("SplitStoryboardOverviewRequestSchema")
    );
    expect(videoPromptContract).not.toContain("imageNodeIds");
    expect(videoPromptContract).not.toContain("referenceImageUrls");
    expect(agentPanel).toContain("setVideoPreparation(null)");
  });

  test("opens a native Save As dialog before exporting a completed video", () => {
    const mainIpc = read("../src/main/ipc.ts");
    const preload = read("../src/preload/index.ts");
    expect(mainIpc).toContain("dialog.showSaveDialog(window");
    expect(mainIpc).toContain('title: "导出已完成视频"');
    expect(mainIpc).toContain('extensions: ["mp4"]');
    expect(mainIpc).toContain("if (selection.canceled || !selection.filePath) return null");
    expect(mainIpc).toContain("destinationPath: selection.filePath");
    expect(preload).toContain("videoExportCompleted");
  });

  test("uses an option plus supplement card and directly generates the script", () => {
    const agentPanel = read("../src/renderer/src/components/agent-panel.tsx");
    expect(agentPanel).toContain("选择一个创意方向");
    expect(agentPanel).toContain("补充或融合想法（可选）");
    expect(agentPanel).toContain("使用此方向直接生成脚本");
    expect(agentPanel).toContain("agent.generateScript");
  });

  test("removes creative and script generation tools from free-form chat", () => {
    const agentService = read("../src/utility/agent-service.ts");
    expect(agentService).toContain("tools: [updateBriefRestatement]");
    expect(agentService).not.toContain('name: "create_creative_directions"');
    expect(agentService).not.toContain('name: "create_script"');
  });

  test("maps explicit selection states and gives one script two independent actions", () => {
    const node = (id: string, kind: CanvasNode["kind"], version?: number): CanvasNode => ({
      id,
      kind,
      title: version ? `脚本 V${version}` : id,
      bodyPath: `nodes/${id}.md`,
      position: { x: 0, y: 0 },
      status: "completed",
      ...(version ? { scriptVersion: version } : {})
    });
    const scriptV2 = node("script-v2", "script", 2);
    const scriptV3 = node("script-v3", "script", 3);
    const frame = node("frame", "storyboard-frame");

    expect(resolveAgentPanelSelection([])).toEqual({ mode: "none" });
    expect(resolveAgentPanelSelection([frame])).toEqual({ mode: "storyboard-image" });
    expect(resolveAgentPanelSelection([scriptV3])).toEqual({ mode: "script", script: scriptV3 });
    expect(resolveAgentPanelSelection([scriptV2, scriptV3])).toEqual({ mode: "multiple-scripts" });

    const panel = read("../src/renderer/src/components/agent-panel.tsx");
    expect(panel).not.toContain("latestScript");
    expect(panel).not.toContain("脚本确认 开始生成");
    expect(panel).not.toContain("组合完整视频");
    expect(panel).not.toContain("activeScriptHasStoryboardFrames");
    expect(panel.match(/\n\s+生成静态效果图\n\s+<\/Button>/g)).toHaveLength(1);
    expect(panel.match(/\n\s+生成完整视频\n\s+<\/Button>/g)).toHaveLength(1);
    expect(panel).toContain("onClick={() => void generateStoryboardImages()}");
    expect(panel).toContain("onClick={() => void generateFullVideoPrompt()}");
    expect(panel).toContain("两条流程彼此独立");
  });
});
