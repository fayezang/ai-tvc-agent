import { randomUUID } from "node:crypto";
import type { AgentWorkflowState, CanvasNode, ProjectState } from "../shared/contracts.js";
import { ProjectService } from "./project-service.js";

export interface CreativeDirectionDraft {
  title: string;
  oneLine: string;
  hook: string;
  proof: string;
  cta: string;
}

export interface ScriptShotDraft {
  shotId: string;
  duration: number;
  prompt: string;
  audioSfxPrompt: string;
  vo: string;
}

export interface FullVideoTimelineShot {
  shotId: string;
  start: number;
  end: number;
  duration: number;
  visualPrompt: string;
  audioSfxPrompt: string;
  vo: string;
}

export const buildFullVideoTimeline = (
  shots: readonly ScriptShotDraft[]
): FullVideoTimelineShot[] => {
  let cursor = 0;
  return shots.map((shot) => {
    const start = cursor;
    cursor += shot.duration;
    return {
      shotId: shot.shotId,
      start,
      end: cursor,
      duration: shot.duration,
      visualPrompt: shot.prompt,
      audioSfxPrompt: shot.audioSfxPrompt,
      vo: shot.vo
    };
  });
};

export interface StoryboardShotDraft {
  shot: string;
  duration: number;
  frameContent: string;
  productPosition: string;
  characterAction: string;
}

const escapeTableCell = (value: string): string =>
  value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();

const splitMarkdownTableRow = (line: string): string[] => {
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of line.trim().replace(/^\|/, "").replace(/\|$/, "")) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
};

export const replaceScriptPromptInMarkdown = (input: {
  markdown: string;
  shotId: string;
  prompt: string;
  nextVersion: number;
  parentVersion: number;
}): string => {
  const newline = input.markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = input.markdown.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line, index) => {
    if (index === 0 && /^#\s+脚本\s+V\d+\s*$/i.test(line)) return `# 脚本 V${input.nextVersion}`;
    if (/^\*\*创意来源：\*\*/.test(line)) {
      return `**创意来源：** 由脚本 V${input.parentVersion} 的 ${input.shotId} 静态图应用生成`;
    }
    if (!line.trimStart().startsWith("|") || splitMarkdownTableRow(line)[0] !== input.shotId) return line;

    const separators: number[] = [];
    let escaped = false;
    for (let characterIndex = 0; characterIndex < line.length; characterIndex += 1) {
      const character = line[characterIndex]!;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "|") {
        separators.push(characterIndex);
      }
    }
    if (separators.length < 6) throw new Error(`脚本镜头 ${input.shotId} 的表格行格式无效`);
    const start = separators[2]! + 1;
    const end = separators[3]!;
    const oldCell = line.slice(start, end);
    const leading = oldCell.match(/^\s*/)?.[0] ?? "";
    const trailing = oldCell.match(/\s*$/)?.[0] ?? "";
    replaced = true;
    return `${line.slice(0, start)}${leading}${escapeTableCell(input.prompt)}${trailing}${line.slice(end)}`;
  });
  if (!replaced) throw new Error(`基础脚本中没有镜头 ${input.shotId}`);
  return next.join(newline);
};

const containsCjk = (value: string): boolean => /[\u3400-\u9fff]/u.test(value);

export const parseScriptMarkdown = (markdown: string): ScriptShotDraft[] => {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const normalized = line.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    return normalized.startsWith("| 镜头编号 | 时长 | prompt |") &&
      normalized.includes("audio") && normalized.includes("sfx") && normalized.endsWith("| vo |");
  });
  if (headerIndex < 0) return [];
  const shots: ScriptShotDraft[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith("|")) break;
    const [shotId = "", duration = "", prompt = "", audioSfxPrompt = "", vo = ""] = splitMarkdownTableRow(line);
    const seconds = Number(duration.replace(/s$/i, "").trim());
    if (!shotId || !Number.isFinite(seconds)) continue;
    shots.push({ shotId, duration: seconds, prompt, audioSfxPrompt, vo: vo === "—" ? "" : vo });
  }
  return shots;
};

export const renderScriptMarkdown = (
  version: number,
  selectedDirection: string,
  shots: readonly ScriptShotDraft[]
): string => [
  `# 脚本 V${version}`,
  "",
  selectedDirection ? `**创意来源：** ${escapeTableCell(selectedDirection)}` : "",
  selectedDirection ? "" : "",
  "| 镜头编号 | 时长 | Prompt | Audio & SFX | VO |",
  "| --- | ---: | --- | --- | --- |",
  ...shots.map((shot) =>
    `| ${escapeTableCell(shot.shotId)} | ${shot.duration}s | ${escapeTableCell(shot.prompt)} | ${escapeTableCell(shot.audioSfxPrompt)} | ${escapeTableCell(shot.vo || "—")} |`
  )
].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n");

export const parseStoryboardMarkdown = (markdown: string): StoryboardShotDraft[] => {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) =>
    /^\|\s*镜头\s*\|\s*时长\s*\|\s*画面内容\s*\|\s*产品位置\s*\|\s*人物动作\s*\|?$/.test(line.trim())
  );
  if (headerIndex < 0) return [];
  const shots: StoryboardShotDraft[] = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith("|")) break;
    const [shot = "", duration = "", frameContent = "", productPosition = "", characterAction = ""] =
      splitMarkdownTableRow(line);
    const seconds = Number(duration.replace(/s$/i, "").trim());
    if (!shot || !Number.isFinite(seconds)) continue;
    shots.push({ shot, duration: seconds, frameContent, productPosition, characterAction });
  }
  return shots;
};

const fieldFromSection = (section: string, label: string): string => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return section.match(new RegExp(`\\*\\*${escaped}：\\*\\*\\s*([^\\n]+)`))?.[1]?.trim() ?? "";
};

export const parseCreativeDirectionsMarkdown = (markdown: string): CreativeDirectionDraft[] => {
  const headings = [...markdown.matchAll(/^##\s+\d+\.\s+(.+)$/gm)];
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? markdown.length;
    const section = markdown.slice(start, end);
    return {
      title: heading[1]?.trim() ?? "",
      oneLine: fieldFromSection(section, "一句话核心"),
      hook: fieldFromSection(section, "Hook"),
      proof: fieldFromSection(section, "Proof"),
      cta: fieldFromSection(section, "CTA")
    };
  });
};

export const validateCreativeDirections = (
  directions: readonly CreativeDirectionDraft[]
): readonly CreativeDirectionDraft[] => {
  if (directions.length !== 3) throw new Error("创意方向必须恰好为 3 个");
  const normalized = directions.map((direction) => direction.oneLine.trim().toLocaleLowerCase());
  if (normalized.some((line) => line.length < 8)) throw new Error("每个创意方向必须提供清晰的一句话核心");
  if (new Set(normalized).size !== 3) throw new Error("三个创意方向必须有实质差异");
  for (const direction of directions) {
    if (![direction.title, direction.hook, direction.proof, direction.cta].every((value) => value.trim())) {
      throw new Error("每个创意方向都必须包含标题、Hook、Proof 与 CTA");
    }
  }
  return directions;
};

export const validateScriptShots = (
  shots: readonly ScriptShotDraft[],
  expectedDuration: number
): readonly ScriptShotDraft[] => {
  if (shots.length === 0) throw new Error("脚本至少需要一个镜头");
  const ordered = [...shots];
  if (new Set(ordered.map((shot) => shot.shotId)).size !== ordered.length) throw new Error("镜头编号不能重复");
  if (ordered.some((shot) => !Number.isFinite(shot.duration) || shot.duration <= 0)) {
    throw new Error("每个镜头时长必须大于 0 秒");
  }
  const total = ordered.reduce((sum, shot) => sum + shot.duration, 0);
  if (Math.abs(total - expectedDuration) > 0.001) {
    throw new Error(`脚本总时长必须为 ${expectedDuration} 秒，当前为 ${total} 秒`);
  }
  for (const shot of ordered) {
    if (!/^S\d+$/i.test(shot.shotId.trim())) throw new Error(`镜头编号 ${shot.shotId || "空"} 必须使用 S1、S2… 格式`);
    if (!shot.prompt.trim()) throw new Error(`镜头 ${shot.shotId} 缺少 Prompt`);
    if (!shot.audioSfxPrompt.trim()) throw new Error(`镜头 ${shot.shotId} 缺少 Audio & SFX Prompt`);
    if (containsCjk(shot.prompt)) throw new Error(`镜头 ${shot.shotId} 的 Prompt 必须使用英文`);
    if (containsCjk(shot.audioSfxPrompt)) throw new Error(`镜头 ${shot.shotId} 的 Audio & SFX Prompt 必须使用英文`);
  }
  return ordered;
};

export const validateStoryboardShots = (
  shots: readonly StoryboardShotDraft[],
  expectedDuration: number
): readonly StoryboardShotDraft[] => {
  if (shots.length === 0) throw new Error("分镜设计至少需要一个镜头");
  const total = shots.reduce((sum, shot) => sum + shot.duration, 0);
  if (shots.some((shot) => !Number.isFinite(shot.duration) || shot.duration <= 0)) {
    throw new Error("每个分镜时长必须大于 0 秒");
  }
  if (Math.abs(total - expectedDuration) > 0.001) {
    throw new Error(`分镜总时长必须为 ${expectedDuration} 秒，当前为 ${total} 秒`);
  }
  for (const [index, shot] of shots.entries()) {
    if (![shot.shot, shot.frameContent, shot.productPosition, shot.characterAction].every((value) => value.trim())) {
      throw new Error(`分镜 ${index + 1} 缺少镜头、画面内容、产品位置或人物动作`);
    }
  }
  return shots;
};

export class WorkflowService {
  constructor(private readonly projects: ProjectService) {}

  async state(projectRoot: string): Promise<AgentWorkflowState> {
    const state = await this.projects.open(projectRoot);
    const latest = (kind: CanvasNode["kind"]): CanvasNode | undefined =>
      [...state.canvas.nodes].reverse().find((node) => node.kind === kind);
    const brief = latest("brief");
    const creative = latest("creative-direction");
    const script = latest("script");
    const storyboard = latest("storyboard");
    let directions: CreativeDirectionDraft[] = [];
    if (creative) {
      directions = parseCreativeDirectionsMarkdown(
        await this.projects.readBody(projectRoot, creative.bodyPath)
      );
    }
    const storyboardMarkdown = storyboard
      ? await this.projects.readBody(projectRoot, storyboard.bodyPath)
      : "";
    const storyboardShots = parseStoryboardMarkdown(storyboardMarkdown);
    let imageCount = 0;
    try {
      const manifest = JSON.parse(
        await this.projects.readBody(projectRoot, "assets/storyboards/manifest.json")
      ) as { images?: Array<{ shot?: string }> };
      const shotIds = new Set(storyboardShots.map((shot) => shot.shot));
      imageCount = new Set(
        (manifest.images ?? []).map((image) => image.shot).filter((shot): shot is string => Boolean(shot && shotIds.has(shot)))
      ).size;
    } catch {
      imageCount = 0;
    }
    const overview = latest("storyboard-overview");
    const splitCount = state.canvas.nodes.filter((node) => node.kind === "storyboard-frame" && node.shotId).length;
    return {
      brief: brief ? { nodeId: brief.id, status: brief.status } : null,
      creative: creative
        ? { nodeId: creative.id, status: creative.status, directions }
        : null,
      script: script ? { nodeId: script.id, status: script.status } : null,
      storyboard: storyboard
        ? {
            nodeId: storyboard.id,
            status: storyboard.status,
            imageCount,
            shotCount: storyboardShots.length,
            overviewReady: Boolean(overview && overview.status === "completed"),
            splitCount
          }
        : null
    };
  }

  async createCreativeDirections(
    projectRoot: string,
    directions: readonly CreativeDirectionDraft[]
  ): Promise<CanvasNode> {
    const valid = validateCreativeDirections(directions);
    const markdown = [
      "# 三个创意方向",
      "",
      "> 请在右侧 Agent 的选项卡中选择一个方向，并可补充或融合你的想法。提交后将直接生成脚本。",
      "",
      ...valid.flatMap((direction, index) => [
        `## ${index + 1}. ${direction.title}`,
        "",
        `**一句话核心：** ${direction.oneLine}`,
        "",
        `**Hook：** ${direction.hook}`,
        "",
        `**Proof：** ${direction.proof}`,
        "",
        `**CTA：** ${direction.cta}`,
        ""
      ])
    ].join("\n");
    return this.appendNode(projectRoot, "creative-direction", "brief", markdown);
  }

  async createScript(
    projectRoot: string,
    selectedDirection: string,
    shots: readonly ScriptShotDraft[]
  ): Promise<CanvasNode> {
    const state = await this.projects.open(projectRoot);
    const valid = validateScriptShots(shots, state.project.adDuration);
    const creative = [...state.canvas.nodes].reverse().find((node) => node.kind === "creative-direction");
    return this.createScriptVersionNode(projectRoot, {
      version: 1,
      source: creative,
      selectedDirection,
      shots: valid
    });
  }

  async createNextScriptVersion(
    projectRoot: string,
    input: { baseScriptNodeId: string; shotId: string; prompt: string }
  ): Promise<CanvasNode> {
    const state = await this.projects.open(projectRoot);
    const base = state.canvas.nodes.find((node) => node.id === input.baseScriptNodeId && node.kind === "script");
    if (!base) throw new Error("找不到作为新版本基础的脚本节点");
    const baseMarkdown = await this.projects.readBody(projectRoot, base.bodyPath);
    const baseShots = validateScriptShots(
      parseScriptMarkdown(baseMarkdown),
      state.project.adDuration
    );
    if (!baseShots.some((shot) => shot.shotId === input.shotId)) {
      throw new Error(`基础脚本中没有镜头 ${input.shotId}`);
    }
    const nextVersion = Math.max(
      0,
      ...state.canvas.nodes
        .filter((node) => node.kind === "script")
        .map((node) => node.scriptVersion ?? Number(node.title.match(/V(\d+)/i)?.[1] ?? 1))
    ) + 1;
    const markdown = replaceScriptPromptInMarkdown({
      markdown: baseMarkdown,
      shotId: input.shotId,
      prompt: input.prompt,
      nextVersion,
      parentVersion: base.scriptVersion ?? 1
    });
    const shots = validateScriptShots(parseScriptMarkdown(markdown), state.project.adDuration);
    return this.createScriptVersionNode(projectRoot, {
      version: nextVersion,
      source: base,
      selectedDirection: `由脚本 V${base.scriptVersion ?? 1} 的 ${input.shotId} 静态图应用生成`,
      shots,
      markdown
    });
  }

  async createStoryboardFrameNode(
    projectRoot: string,
    input: {
      sourceScriptNodeId: string;
      imageSetId: string;
      shotId: string;
      shotIndex: number;
      prompt: string;
    }
  ): Promise<CanvasNode> {
    const before = await this.projects.open(projectRoot);
    const source = before.canvas.nodes.find((node) => node.id === input.sourceScriptNodeId && node.kind === "script");
    if (!source) throw new Error("找不到静态图对应的脚本节点");
    const existingSetCount = new Set(
      before.canvas.nodes
        .filter((node) => node.kind === "storyboard-frame" && node.sourceScriptNodeId === source.id && node.imageSetId)
        .map((node) => node.imageSetId)
    ).size;
    const created = await this.projects.createNode(projectRoot, "storyboard-frame", {
      x: source.position.x + input.shotIndex * 580,
      y: source.position.y + (source.height ?? 300) + 120 + existingSetCount * 500
    });
    await this.projects.writeBody(
      projectRoot,
      created.bodyPath,
      `# ${input.shotId} 静态效果图\n\n生成中…\n\n## Prompt\n\n${input.prompt}\n`
    );
    const after = await this.projects.open(projectRoot);
    const node: CanvasNode = {
      ...created,
      title: `${input.shotId} 静态效果图`,
      shotId: input.shotId,
      sourceScriptNodeId: source.id,
      imageSetId: input.imageSetId,
      width: 560,
      height: 500,
      status: "generating"
    };
    await this.projects.saveCanvas(projectRoot, {
      ...after.canvas,
      nodes: after.canvas.nodes.map((candidate) => candidate.id === node.id ? node : candidate),
      edges: [...after.canvas.edges, { id: randomUUID(), source: source.id, target: node.id }]
    });
    return node;
  }

  async createStoryboard(
    projectRoot: string,
    designSummary: string,
    shots: readonly StoryboardShotDraft[]
  ): Promise<CanvasNode> {
    const state = await this.projects.open(projectRoot);
    const valid = validateStoryboardShots(shots, state.project.adDuration);
    const markdown = [
      "# 分镜设计",
      "",
      escapeTableCell(designSummary),
      "",
      "| 镜头 | 时长 | 画面内容 | 产品位置 | 人物动作 |",
      "| --- | ---: | --- | --- | --- |",
      ...valid.map((shot) =>
        `| ${escapeTableCell(shot.shot)} | ${shot.duration}s | ${escapeTableCell(shot.frameContent)} | ${escapeTableCell(shot.productPosition)} | ${escapeTableCell(shot.characterAction)} |`
      )
    ].join("\n");
    return this.appendNode(projectRoot, "storyboard", "script", markdown);
  }

  async addStoryboardImages(
    projectRoot: string,
    images: readonly { shot: string; duration: number; relativePath: string; dataUrl: string }[],
    status: "generating" | "completed" = "completed"
  ): Promise<CanvasNode> {
    const state = await this.projects.open(projectRoot);
    const storyboard = [...state.canvas.nodes].reverse().find((node) => node.kind === "storyboard");
    if (!storyboard) throw new Error("项目缺少分镜设计节点");
    const current = await this.projects.readBody(projectRoot, storyboard.bodyPath);
    const withoutPreviousImages = current.replace(/\n## 静态图片分镜[\s\S]*$/, "").trimEnd();
    const markdown = [
      withoutPreviousImages,
      "",
      "## 静态图片分镜",
      "",
      ...images.flatMap((image) => [
        `### ${image.shot} · ${image.duration}s`,
        "",
        `![${image.shot} 静态分镜](${image.dataUrl})`,
        "",
        `本地文件：${image.relativePath}`,
        ""
      ])
    ].join("\n");
    await this.projects.writeBody(projectRoot, storyboard.bodyPath, markdown);
    return this.projects.updateNodeStatus(projectRoot, storyboard.id, status);
  }

  async upsertStoryboardOverview(
    projectRoot: string,
    image: { relativePath: string; dataUrl: string; width: number; height: number }
  ): Promise<CanvasNode> {
    const before = await this.projects.open(projectRoot);
    const storyboard = [...before.canvas.nodes].reverse().find((node) => node.kind === "storyboard");
    if (!storyboard) throw new Error("项目缺少分镜设计节点");
    const oldStoryboardMarkdown = await this.projects.readBody(projectRoot, storyboard.bodyPath);
    await this.projects.writeBody(
      projectRoot,
      storyboard.bodyPath,
      oldStoryboardMarkdown.replace(/\n## 静态图片分镜[\s\S]*$/, "").trimEnd()
    );

    let overview = [...before.canvas.nodes].reverse().find((node) => node.kind === "storyboard-overview");
    if (!overview) {
      overview = await this.projects.createNode(projectRoot, "storyboard-overview", {
        x: storyboard.position.x + (storyboard.width ?? 820) + 120,
        y: storyboard.position.y
      });
    }
    await this.projects.writeBody(
      projectRoot,
      overview.bodyPath,
      `![静态分镜总览](${image.dataUrl})\n`
    );
    const current = await this.projects.open(projectRoot);
    const displayWidth = 920;
    const displayHeight = Math.max(360, Math.round(displayWidth * image.height / image.width) + 48);
    const updatedOverview: CanvasNode = {
      ...overview,
      title: "静态分镜总览",
      width: displayWidth,
      height: displayHeight,
      status: "completed"
    };
    const hasEdge = current.canvas.edges.some(
      (edge) => edge.source === storyboard.id && edge.target === overview?.id
    );
    await this.projects.saveCanvas(projectRoot, {
      ...current.canvas,
      nodes: current.canvas.nodes.map((node) => node.id === overview?.id ? updatedOverview : node),
      edges: hasEdge
        ? current.canvas.edges
        : [...current.canvas.edges, { id: randomUUID(), source: storyboard.id, target: overview.id }]
    });
    await this.projects.updateNodeStatus(projectRoot, storyboard.id, "completed");
    return updatedOverview;
  }

  async createStoryboardFrames(
    projectRoot: string,
    frames: readonly {
      shot: string;
      relativePath: string;
      dataUrl: string;
      width: number;
      height: number;
    }[]
  ): Promise<readonly CanvasNode[]> {
    let state = await this.projects.open(projectRoot);
    const overview = [...state.canvas.nodes].reverse().find((node) => node.kind === "storyboard-overview");
    if (!overview) throw new Error("项目缺少静态分镜总览图");
    const frameNodes: CanvasNode[] = [];
    for (const [index, frame] of frames.entries()) {
      let node = state.canvas.nodes.find(
        (candidate) => candidate.kind === "storyboard-frame" && candidate.shotId === frame.shot
      );
      if (!node) {
        node = await this.projects.createNode(projectRoot, "storyboard-frame", {
          x: overview.position.x + index * 540,
          y: overview.position.y + (overview.height ?? 620) + 120
        });
        state = await this.projects.open(projectRoot);
      }
      await this.projects.writeBody(projectRoot, node.bodyPath, `![${frame.shot} 静态参考图](${frame.dataUrl})\n`);
      frameNodes.push({
        ...node,
        shotId: frame.shot,
        title: `${frame.shot} 静态参考图`,
        width: 480,
        height: Math.max(300, Math.round(480 * frame.height / frame.width) + 48),
        status: "awaiting-approval"
      });
    }
    state = await this.projects.open(projectRoot);
    const frameById = new Map(frameNodes.map((node) => [node.id, node]));
    const edgeTargets = new Set(
      state.canvas.edges.filter((edge) => edge.source === overview.id).map((edge) => edge.target)
    );
    await this.projects.saveCanvas(projectRoot, {
      ...state.canvas,
      nodes: state.canvas.nodes.map((node) => frameById.get(node.id) ?? node),
      edges: [
        ...state.canvas.edges,
        ...frameNodes
          .filter((node) => !edgeTargets.has(node.id))
          .map((node) => ({ id: randomUUID(), source: overview.id, target: node.id }))
      ]
    });
    return frameNodes;
  }

  private async appendNode(
    projectRoot: string,
    kind: "creative-direction" | "script" | "storyboard",
    sourceKind: "brief" | "creative-direction" | "script",
    markdown: string
  ): Promise<CanvasNode> {
    const before: ProjectState = await this.projects.open(projectRoot);
    const source = [...before.canvas.nodes].reverse().find((node) => node.kind === sourceKind);
    const existing = [...before.canvas.nodes].reverse().find((node) => node.kind === kind);
    if (existing) {
      await this.projects.writeBody(projectRoot, existing.bodyPath, markdown);
      return this.projects.updateNodeStatus(projectRoot, existing.id, "awaiting-approval");
    }
    const maxX = before.canvas.nodes.reduce((maximum, node) => Math.max(maximum, node.position.x), 0);
    const created = await this.projects.createNode(projectRoot, kind, {
      x: source ? source.position.x + (source.width ?? 440) + 120 : maxX + 560,
      y: source?.position.y ?? 100
    });
    await this.projects.writeBody(projectRoot, created.bodyPath, markdown);
    const after = await this.projects.open(projectRoot);
    const node: CanvasNode = { ...created, status: "awaiting-approval" };
    await this.projects.saveCanvas(projectRoot, {
      ...after.canvas,
      nodes: after.canvas.nodes.map((candidate) => (candidate.id === node.id ? node : candidate)),
      edges: source
        ? [...after.canvas.edges, { id: randomUUID(), source: source.id, target: node.id }]
        : after.canvas.edges
    });
    return node;
  }

  private async createScriptVersionNode(
    projectRoot: string,
    input: {
      version: number;
      source?: CanvasNode | undefined;
      selectedDirection: string;
      shots: readonly ScriptShotDraft[];
      markdown?: string | undefined;
    }
  ): Promise<CanvasNode> {
    const before = await this.projects.open(projectRoot);
    const maxX = before.canvas.nodes.reduce((maximum, node) => Math.max(maximum, node.position.x), 0);
    const created = await this.projects.createNode(projectRoot, "script", {
      x: input.source
        ? input.source.kind === "script"
          ? input.source.position.x
          : input.source.position.x + (input.source.width ?? 440) + 120
        : maxX + 560,
      y: input.source?.kind === "script"
        ? input.source.position.y + (input.source.height ?? 300) + 120
        : input.source?.position.y ?? 100
    });
    await this.projects.writeBody(
      projectRoot,
      created.bodyPath,
      input.markdown ?? renderScriptMarkdown(input.version, input.selectedDirection, input.shots)
    );
    const after = await this.projects.open(projectRoot);
    const node: CanvasNode = {
      ...created,
      title: `脚本 V${input.version}`,
      scriptVersion: input.version,
      width: 920,
      height: 420,
      status: "awaiting-approval"
    };
    await this.projects.saveCanvas(projectRoot, {
      ...after.canvas,
      nodes: after.canvas.nodes.map((candidate) => candidate.id === node.id ? node : candidate),
      edges: input.source
        ? [...after.canvas.edges, { id: randomUUID(), source: input.source.id, target: node.id }]
        : after.canvas.edges
    });
    return node;
  }
}
