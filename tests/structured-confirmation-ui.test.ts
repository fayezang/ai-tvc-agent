import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
    expect(agentPanel).toContain("脚本确认 开始生成");
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
    expect(workflow).toContain("shot.shotId === input.shotId ? { ...shot, prompt:");
    expect(service).toContain("Convert this still-image prompt into a production-ready image-to-video prompt");
  });

  test("requires all shots and shows a paid confirmation before native-audio generation", () => {
    const agentPanel = read("../src/renderer/src/components/agent-panel.tsx");
    const service = read("../src/utility/agent-service.ts");
    expect(agentPanel).toContain("生成完整视频 Prompt");
    expect(agentPanel).toContain("完整视频 Prompt（生成前可编辑）");
    expect(agentPanel).toContain("查看报价");
    expect(agentPanel).toContain("确认支付并生成");
    expect(agentPanel).toContain("放弃，不产生费用");
    expect(agentPanel).toContain("pricingFetchedAt");
    expect(agentPanel).toContain("generateAudio: true");
    expect(service).toContain("必须选择 ${shots.length} 张图片");
    expect(service).toContain("每个镜头必须且只能选择一张静态图");
    expect(service).toContain("Speak every VO line as literally and verbatim as possible");
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
});
