import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CanvasNode, CanvasSnapshot, ProjectState, ProjectSummary } from "../src/shared/contracts.js";
import { AgentService } from "../src/utility/agent-service.js";
import type { ProjectService } from "../src/utility/project-service.js";
import {
  buildFullVideoTimeline,
  parseScriptMarkdown,
  renderScriptMarkdown,
  type ScriptShotDraft
} from "../src/utility/workflow-service.js";

class FileProjectService {
  constructor(
    private readonly project: ProjectSummary,
    private canvas: CanvasSnapshot
  ) {}

  async open(): Promise<ProjectState> {
    return { project: this.project, canvas: this.canvas };
  }

  async readBody(projectRoot: string, bodyPath: string): Promise<string> {
    return readFile(join(projectRoot, bodyPath), "utf8");
  }

  async writeBody(projectRoot: string, bodyPath: string, markdown: string): Promise<void> {
    const path = join(projectRoot, bodyPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, markdown, "utf8");
  }

  async createNode(
    projectRoot: string,
    kind: CanvasNode["kind"],
    position: CanvasNode["position"]
  ): Promise<CanvasNode> {
    const id = randomUUID();
    const node: CanvasNode = {
      id,
      kind,
      title: kind,
      bodyPath: `nodes/${kind}-${id}.md`,
      position,
      width: 440,
      height: 300,
      status: "draft"
    };
    this.canvas = { ...this.canvas, nodes: [...this.canvas.nodes, node] };
    await this.writeBody(projectRoot, node.bodyPath, "");
    return node;
  }

  async saveCanvas(_projectRoot: string, canvas: CanvasSnapshot): Promise<CanvasSnapshot> {
    this.canvas = canvas;
    return canvas;
  }
}

const initialShots: ScriptShotDraft[] = [
  { shotId: "S1", duration: 2, prompt: "Original visual one", audioSfxPrompt: "Sound one", vo: "旁白一" },
  { shotId: "S2", duration: 2, prompt: "Original visual two", audioSfxPrompt: "Sound two", vo: "旁白二" },
  { shotId: "S3", duration: 1, prompt: "Original visual three", audioSfxPrompt: "Sound three", vo: "旁白三" }
];

describe("batch 4 final-video workflow", () => {
  test("applies image prompts as a cumulative V1 → V2 → V3 → V4 chain without network", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "tvc-batch4-"));
    const now = new Date().toISOString();
    const scriptV1: CanvasNode = {
      id: "script-v1",
      kind: "script",
      title: "脚本 V1",
      bodyPath: "nodes/script-v1.md",
      position: { x: 100, y: 100 },
      width: 920,
      height: 420,
      status: "awaiting-approval",
      scriptVersion: 1
    };
    const frames = [1, 2, 3].map((number): CanvasNode => ({
      id: `frame-${number}`,
      kind: "storyboard-frame",
      title: `S${number} 静态效果图`,
      bodyPath: `nodes/frame-${number}.md`,
      position: { x: number * 100, y: 700 },
      status: "completed",
      shotId: `S${number}`,
      sourceScriptNodeId: scriptV1.id,
      imageSetId: "set-v1"
    }));
    const project: ProjectSummary = {
      id: "project-1",
      name: "Batch 4 test",
      rootPath: projectRoot,
      adDuration: 5,
      aspectRatio: "16:9",
      createdAt: now,
      updatedAt: now
    };
    const fileProjects = new FileProjectService(project, {
      version: 1,
      nodes: [scriptV1, ...frames],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 }
    });
    const service = new AgentService(fileProjects as unknown as ProjectService);
    const prompts = ["Revised visual one", "Revised visual two", "Revised visual three"];
    let networkCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      networkCalls += 1;
      throw new Error("network is forbidden while applying a prompt");
    }) as unknown as typeof fetch;

    try {
      await mkdir(join(projectRoot, "nodes"), { recursive: true });
      const customV1 = renderScriptMarkdown(1, "Initial", initialShots).replace(
        "| S2 | 2s | Original visual two | Sound two | 旁白二 |",
        "|  S2  |   2s   |  Original visual two  |  Sound two   |  旁白二  |"
      );
      await writeFile(join(projectRoot, scriptV1.bodyPath), customV1);
      for (const [index, frame] of frames.entries()) {
        const manifestPath = join(projectRoot, "assets/storyboards/nodes", `${frame.id}.json`);
        await mkdir(dirname(manifestPath), { recursive: true });
        await writeFile(manifestPath, JSON.stringify({
          version: 1,
          nodeId: frame.id,
          shotId: `S${index + 1}`,
          duration: initialShots[index]!.duration,
          sourceScriptNodeId: scriptV1.id,
          imageSetId: "set-v1",
          selectedVersionId: `image-${index + 1}`,
          versions: [{
            id: `image-${index + 1}`,
            prompt: prompts[index],
            modelId: "image-model",
            status: "ready",
            createdAt: now
          }]
        }));
        await service.applyStoryboardImage({ projectRoot, nodeId: frame.id });
      }

      const state = await fileProjects.open();
      const scripts = state.canvas.nodes
        .filter((node) => node.kind === "script")
        .sort((left, right) => (left.scriptVersion ?? 0) - (right.scriptVersion ?? 0));
      expect(scripts.map((node) => node.title)).toEqual(["脚本 V1", "脚本 V2", "脚本 V3", "脚本 V4"]);
      const versions = await Promise.all(scripts.map(async (node) =>
        parseScriptMarkdown(await fileProjects.readBody(projectRoot, node.bodyPath))
      ));
      expect(versions[1]!.map((shot) => shot.prompt)).toEqual([prompts[0]!, initialShots[1]!.prompt, initialShots[2]!.prompt]);
      expect(versions[2]!.map((shot) => shot.prompt)).toEqual([prompts[0]!, prompts[1]!, initialShots[2]!.prompt]);
      expect(versions[3]!.map((shot) => shot.prompt)).toEqual(prompts);
      const finalMarkdown = await fileProjects.readBody(projectRoot, scripts[3]!.bodyPath);
      expect(finalMarkdown).toContain("|  S2  |   2s   |  Revised visual two  |  Sound two   |  旁白二  |");
      for (const version of versions) {
        expect(version.map(({ shotId, duration, audioSfxPrompt, vo }) => ({ shotId, duration, audioSfxPrompt, vo })))
          .toEqual(initialShots.map(({ shotId, duration, audioSfxPrompt, vo }) => ({ shotId, duration, audioSfxPrompt, vo })));
      }
      expect(state.canvas.edges.filter((edge) => scripts.some((script) => script.id === edge.target)).map((edge) => edge.source))
        .toEqual([scripts[0]!.id, scripts[1]!.id, scripts[2]!.id]);
      expect(networkCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("turns the complete five-column script into one ordered text timeline", () => {
    const markdown = renderScriptMarkdown(4, "Final", initialShots);
    const timeline = buildFullVideoTimeline(parseScriptMarkdown(markdown));
    expect(timeline.map((shot) => `${shot.shotId}:${shot.start}-${shot.end}`)).toEqual([
      "S1:0-2",
      "S2:2-4",
      "S3:4-5"
    ]);
    expect(timeline.map((shot) => shot.visualPrompt)).toEqual(initialShots.map((shot) => shot.prompt));
    expect(timeline.map((shot) => shot.audioSfxPrompt)).toEqual(initialShots.map((shot) => shot.audioSfxPrompt));
    expect(timeline.map((shot) => shot.vo)).toEqual(initialShots.map((shot) => shot.vo));
  });

  test("the full-video translation path has no image selection, reads, uploads, or vision call", async () => {
    const source = await readFile(new URL("../src/utility/agent-service.ts", import.meta.url), "utf8");
    const method = source.slice(source.indexOf("async generateVideoPrompt"), source.indexOf("async splitStoryboardOverview"));
    expect(method).not.toContain("imageNodeIds");
    expect(method).not.toContain("readStoryboardNodeManifest");
    expect(method).not.toContain("dataUrlFromRelativePath");
    expect(method).not.toContain("uploadLocalImage");
    expect(method).not.toContain("structuredVisionText");
    expect(method).toContain("buildFullVideoTimeline(shots)");
    expect(method).toContain("structuredText({");
  });
});
