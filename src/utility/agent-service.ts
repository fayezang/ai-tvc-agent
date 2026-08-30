import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import Database from "better-sqlite3";
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Model, type TextContent } from "@mariozechner/pi-ai";
import type {
  AgentReply,
  AgentUiEvent,
  AgentWorkflowState,
  CanvasNode,
  GenerateVideoPromptResult,
  StoryboardImageState
} from "../shared/contracts.js";
import { ORZ_BASE_URL } from "../shared/orz-models.js";
import type { BriefRestatement } from "./brief-flow.js";
import { ProjectService, writeAtomic } from "./project-service.js";
import { buildStoryboardImagePayload } from "./providers/orz-image-adapter.js";
import { OrzClient, type OrzTaskResponse } from "./providers/orz-client.js";
import { streamOrzRest } from "./providers/orz-text-stream.js";
import {
  composeStoryboard,
  cropStoryboardTile,
  type StoryboardTileLayout
} from "./storyboard-image-processing.js";
import {
  type CreativeDirectionDraft,
  type ScriptShotDraft,
  type StoryboardShotDraft,
  parseScriptMarkdown,
  validateScriptShots,
  parseStoryboardMarkdown,
  WorkflowService
} from "./workflow-service.js";

const systemPrompt = `你是本地 AI TVC Agent 的创意生产代理。严格遵守以下产品流程：
1. 先复述 Brief；确认动作只通过右侧 Agent 的结构化按钮完成。
2. Brief 确认后由右侧操作卡生成恰好 3 个创意方向，并通过单选项 + 可选补充进行选择。
3. 用户提交所选创意方向后由结构化操作直接生成脚本；不得再次要求用户输入文字确认。
4. 脚本使用“镜头编号、时长、Prompt、Audio & SFX、VO”五列表格。Prompt 与 Audio & SFX 必须是英文；镜头数量与各镜头时长由 AI 决定，总时长必须严格等于项目时长。
5. 不虚构产品卖点、数据、背书或用户没有提供的事实。
6. 只讨论当前 TVC 工作流，不扩展到角色训练、LoRA、专业剪辑时间线、团队协作或其它产品功能。
7. 界面中的结构化操作负责确认和选择；不得要求用户在对话里键入“确认”、方向编号或方向名称。
8. 用户要求修改“我理解的 Brief”时，必须调用 update_brief_restatement 工具更新原节点，不能新建第二个 Brief。
9. 如果用户在普通对话里尝试确认 Brief 或选择方向，简短提醒其使用右侧操作卡，不得自行进入下一阶段。
使用简洁中文回复。`;

const createOrzModel = (textModelId: string, maxTokens = 8192): Model<"openai-completions"> => ({
  id: textModelId,
  name: `${textModelId} via ORZ`,
  api: "openai-completions",
  provider: "orz",
  baseUrl: ORZ_BASE_URL,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
    supportsStrictMode: false,
    maxTokensField: "max_tokens"
  }
});

const assistantText = (agent: Agent): string => {
  const message = [...agent.state.messages].reverse().find((candidate) => candidate.role === "assistant");
  if (!message || message.role !== "assistant") return "";
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
};

const assertAgentSucceeded = (agent: Agent): void => {
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
  const lastAssistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
  if (lastAssistant?.role === "assistant" && lastAssistant.errorMessage) {
    throw new Error(lastAssistant.errorMessage);
  }
};

const providerErrorMessage = (error: unknown, textModelId: string): string => {
  const raw = error instanceof Error ? error.message : "Agent 运行失败";
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: unknown }).status) : null;
  if (status === 403 || /\b403\b|request was blocked/i.test(raw)) {
    return `ORZ 返回 403：已读取 API Key，但 ${textModelId} 的实际模型请求被 ORZ 或上游拒绝。请在 ORZ 模型页用同一 Key 运行一次；这不是本地 Brief 内容校验错误。`;
  }
  if (status === 401 || /\b401\b/.test(raw)) return "ORZ API Key 无效或已撤销，请更新后重试。";
  if (status === 402 || /\b402\b/.test(raw)) return "ORZ 余额不足，请充值后重试。";
  if (status === 429 || /\b429\b/.test(raw)) return "ORZ 请求过于频繁，请稍后重试。";
  return raw;
};

const structuredText = async (input: {
  apiKey: string;
  textModelId: string;
  systemPrompt: string;
  prompt: string;
  maxTokens: number;
}): Promise<string> => {
  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model: createOrzModel(input.textModelId, input.maxTokens),
      thinkingLevel: "off",
      tools: [],
      messages: []
    },
    getApiKey: (provider) => (provider === "orz" ? input.apiKey : undefined),
    streamFn: streamOrzRest,
    toolExecution: "sequential"
  });
  try {
    await agent.prompt(input.prompt);
    assertAgentSucceeded(agent);
    const raw = assistantText(agent);
    if (!raw) throw new Error("ORZ 文本模型返回了空内容");
    return raw;
  } catch (error) {
    throw new Error(providerErrorMessage(error, input.textModelId));
  }
};

const structuredVisionText = async (input: {
  apiKey: string;
  textModelId: string;
  systemPrompt: string;
  prompt: string;
  imageUrls: readonly string[];
  maxTokens: number;
}): Promise<string> => {
  type VisionResponse = {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    error?: { message?: string };
    message?: string;
  };
  const response = await fetch(`${ORZ_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.textModelId,
      stream: false,
      max_tokens: input.maxTokens,
      messages: [
        { role: "system", content: input.systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: input.prompt },
            ...input.imageUrls.map((url, index) => ({
              type: "image_url",
              image_url: { url },
              metadata: { shotOrder: index + 1 }
            }))
          ]
        }
      ]
    })
  });
  const raw = await response.text();
  let parsed: VisionResponse | null = null;
  try {
    parsed = JSON.parse(raw) as VisionResponse;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const detail = parsed?.error?.message ?? parsed?.message ?? raw.trim().slice(0, 320);
    throw new Error(`ORZ 多模态请求失败（HTTP ${response.status}）：${detail || "空响应"}`);
  }
  if (!parsed) {
    throw new Error(`ORZ 多模态请求返回了非 JSON 内容：${raw.trim().slice(0, 240)}`);
  }
  const content = parsed.choices?.[0]?.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part.text ?? "").join("")
      : "";
  if (!text.trim()) throw new Error("多模态模型没有返回完整视频 Prompt");
  return text.trim();
};

const jsonObject = (raw: string): Record<string, unknown> => {
  const json = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("文本模型没有返回可用的结构化结果");
  }
  return parsed as Record<string, unknown>;
};

const stringValue = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? record[key].trim() : "";

const recordValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const waitForImageTask = async (
  client: OrzClient,
  initial: OrzTaskResponse,
  timeoutMs = 180_000
): Promise<OrzTaskResponse> => {
  let task = initial;
  const deadline = Date.now() + timeoutMs;
  while (
    task.status === "pending" ||
    task.status === "queued" ||
    task.status === "running" ||
    task.status === "processing"
  ) {
    if (Date.now() >= deadline) throw new Error(`图片任务 ${task.task_id} 等待超时`);
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    task = await client.getTask(task.task_id);
  }
  if (task.status !== "completed") {
    throw new Error(task.error?.message ?? `图片任务未完成（${task.status}）`);
  }
  return task;
};

const imageExtension = (contentType: string, url = ""): "png" | "jpg" | "webp" => {
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  const urlExtension = extname(new URL(url, "https://local.invalid").pathname).toLowerCase();
  if (urlExtension === ".webp") return "webp";
  if (urlExtension === ".jpg" || urlExtension === ".jpeg") return "jpg";
  return "png";
};

interface StoryboardImageArtifact {
  shot: string;
  duration: number;
  relativePath: string;
  dataUrl: string;
}

interface StoryboardImageManifestEntry {
  shot: string;
  duration: number;
  promptHash: string;
  modelId: string;
  relativePath: string;
  sourceUrl?: string;
}

interface StoryboardImageManifest {
  version: 1;
  images: StoryboardImageManifestEntry[];
  overview?: {
    relativePath: string;
    sourceHash: string;
    width: number;
    height: number;
    tiles: StoryboardTileLayout[];
  };
}

const storyboardManifestPath = "assets/storyboards/manifest.json";

interface StoryboardNodeImageVersion {
  id: string;
  prompt: string;
  modelId: string;
  status: "generating" | "ready" | "failed";
  relativePath?: string;
  sourceUrl?: string;
  error?: string;
  createdAt: string;
}

interface StoryboardNodeManifest {
  version: 1;
  nodeId: string;
  shotId: string;
  duration: number;
  sourceScriptNodeId: string;
  imageSetId: string;
  selectedVersionId?: string | undefined;
  versions: StoryboardNodeImageVersion[];
}

const storyboardNodeManifestPath = (nodeId: string): string =>
  `assets/storyboards/nodes/${nodeId}.json`;

const readStoryboardNodeManifest = async (projectRoot: string, nodeId: string): Promise<StoryboardNodeManifest> => {
  const parsed = JSON.parse(
    await readFile(join(projectRoot, storyboardNodeManifestPath(nodeId)), "utf8")
  ) as StoryboardNodeManifest;
  if (parsed.version !== 1 || parsed.nodeId !== nodeId || !Array.isArray(parsed.versions)) {
    throw new Error("静态图版本记录损坏，请从脚本重新生成这一组图片");
  }
  return parsed;
};

const writeStoryboardNodeManifest = async (
  projectRoot: string,
  manifest: StoryboardNodeManifest
): Promise<void> => {
  await writeAtomic(
    join(projectRoot, storyboardNodeManifestPath(manifest.nodeId)),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
};

const dataUrlFromRelativePath = async (projectRoot: string, relativePath: string): Promise<string> => {
  const bytes = await readFile(join(projectRoot, relativePath));
  const extension = imageExtension("", relativePath);
  const mimeType = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
};

const storyboardImageStateFromManifest = async (
  projectRoot: string,
  manifest: StoryboardNodeManifest
): Promise<StoryboardImageState> => ({
  nodeId: manifest.nodeId,
  shotId: manifest.shotId,
  duration: manifest.duration,
  sourceScriptNodeId: manifest.sourceScriptNodeId,
  imageSetId: manifest.imageSetId,
  selectedVersionId: manifest.selectedVersionId ?? null,
  versions: await Promise.all(manifest.versions.map(async (version) => ({
    id: version.id,
    prompt: version.prompt,
    modelId: version.modelId,
    status: version.status,
    dataUrl: version.status === "ready" && version.relativePath
      ? await dataUrlFromRelativePath(projectRoot, version.relativePath)
      : null,
    error: version.error ?? null,
    createdAt: version.createdAt
  })))
});

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const isPng = (bytes: Uint8Array): boolean =>
  [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);

/**
 * ORZ 的 image_url / image_urls 只接受公网 HTTPS、cdn.orz.sh 或临时 R2 链接，
 * 传 base64 data URL 会被判为 image_invalid。因此本地参考图必须先上传换成真实 URL。
 * 上传结果按内容哈希缓存，避免同一张参考图重复上传和重复计费。
 */
const referenceUploadCachePath = "assets/references/uploads.json";

interface ReferenceUploadCache {
  version: 1;
  entries: Record<string, { url: string; uploadedAt: string }>;
}

const readReferenceUploadCache = async (projectRoot: string): Promise<ReferenceUploadCache> => {
  try {
    const parsed = JSON.parse(
      await readFile(join(projectRoot, referenceUploadCachePath), "utf8")
    ) as ReferenceUploadCache;
    if (parsed.version !== 1 || typeof parsed.entries !== "object" || !parsed.entries) {
      return { version: 1, entries: {} };
    }
    return parsed;
  } catch {
    return { version: 1, entries: {} };
  }
};

const projectReferenceImageUrls = async (
  projectRoot: string,
  client: OrzClient
): Promise<string[]> => {
  const directory = join(projectRoot, "assets/references");
  let entries: string[];
  try {
    entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, 8);
  } catch {
    return [];
  }
  if (entries.length === 0) return [];
  const urls: string[] = [];
  for (const name of entries) {
    // 参考图是可选增强项：单张上传失败不应阻断整批生图，纯文本 Prompt 仍然可用。
    const url = await uploadLocalImage(projectRoot, `assets/references/${name}`, client)
      .catch(() => null);
    if (url) urls.push(url);
  }
  return urls;
};

/** 把项目内的本地图片换成 ORZ 可访问的真实 URL，并按内容哈希缓存避免重复上传计费。 */
const uploadLocalImage = async (
  projectRoot: string,
  relativePath: string,
  client: OrzClient
): Promise<string | null> => {
  const bytes = await readFile(join(projectRoot, relativePath));
  // ORZ vision 单张参考图上限 10MB。
  if (bytes.byteLength > 10 * 1024 * 1024) return null;
  const hash = createHash("sha256").update(bytes).digest("hex");
  const cache = await readReferenceUploadCache(projectRoot);
  const cached = cache.entries[hash];
  if (cached?.url) return cached.url;

  const name = relativePath.split("/").at(-1) ?? "reference.png";
  const extension = imageExtension("", name);
  const mimeType = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
  const uploaded = await client.uploadFile(name, bytes, mimeType);
  // 优先用可直接访问的 CDN URL；只有 file id 时按 ORZ 的 file:// 引用语法传递。
  const reference = uploaded.url ?? (uploaded.id ? `file://${uploaded.id}` : "");
  if (!reference) return null;
  await writeAtomic(
    join(projectRoot, referenceUploadCachePath),
    `${JSON.stringify(
      {
        ...cache,
        entries: { ...cache.entries, [hash]: { url: reference, uploadedAt: new Date().toISOString() } }
      },
      null,
      2
    )}\n`
  );
  return reference;
};

const readStoryboardManifest = async (projectRoot: string): Promise<StoryboardImageManifest> => {
  try {
    const parsed = JSON.parse(await readFile(join(projectRoot, storyboardManifestPath), "utf8")) as StoryboardImageManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.images)) throw new Error("invalid manifest");
    return parsed;
  } catch {
    return { version: 1, images: [] };
  }
};

const artifactFromFile = async (
  projectRoot: string,
  entry: Pick<StoryboardImageManifestEntry, "shot" | "duration" | "relativePath">
): Promise<StoryboardImageArtifact> => {
  const bytes = await readFile(join(projectRoot, entry.relativePath));
  const extension = imageExtension("", entry.relativePath);
  const mimeType = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
  return {
    shot: entry.shot,
    duration: entry.duration,
    relativePath: entry.relativePath,
    dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`
  };
};

const downloadImageWithRetry = async (
  url: string,
  shot: string,
  maxAttempts = 4
): Promise<{ bytes: Uint8Array; contentType: string }> => {
  let lastError = "未知网络错误";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { Accept: "image/png,image/jpeg,image/webp,image/*;q=0.8" },
        signal: AbortSignal.timeout(45_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error("返回了空文件");
      return { bytes, contentType: response.headers.get("content-type") ?? "" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_500));
      }
    }
  }
  throw new Error(`镜头 ${shot} 图片下载失败，已自动重试 ${maxAttempts} 次：${lastError}`);
};

const findLegacyStoryboardImage = async (input: {
  projectRoot: string;
  safeShot: string;
  storyboardModifiedAt: number;
}): Promise<string | null> => {
  const directory = join(input.projectRoot, "assets/storyboards");
  try {
    const candidates = await Promise.all(
      (await readdir(directory, { withFileTypes: true }))
        .filter((entry) =>
          entry.isFile() &&
          entry.name.startsWith(`${input.safeShot}-`) &&
          /\.png$/i.test(entry.name)
        )
        .map(async (entry) => {
          const relativePath = `assets/storyboards/${entry.name}`;
          return { relativePath, modifiedAt: (await stat(join(input.projectRoot, relativePath))).mtimeMs };
        })
    );
    return candidates
      .filter((candidate) => candidate.modifiedAt >= input.storyboardModifiedAt)
      .sort((a, b) => b.modifiedAt - a.modifiedAt)[0]?.relativePath ?? null;
  } catch {
    return null;
  }
};

export class AgentService {
  private readonly workflow: WorkflowService;

  constructor(private readonly projects: ProjectService) {
    this.workflow = new WorkflowService(projects);
  }

  async workflowState(projectRoot: string): Promise<AgentWorkflowState> {
    return this.workflow.state(projectRoot);
  }

  async confirmBrief(input: {
    projectRoot: string;
    apiKey: string;
    textModelId: string;
  }): Promise<AgentReply> {
    const state = await this.workflow.state(input.projectRoot);
    if (!state.brief) throw new Error("项目缺少 Brief 节点");
    const briefContext = await this.projects.selectedContext(input.projectRoot, [state.brief.nodeId]);
    const raw = await structuredText({
      apiKey: input.apiKey,
      textModelId: input.textModelId,
      maxTokens: 4096,
      systemPrompt: `你负责为 TVC Brief 发散创意。只输出 JSON 对象，不要 Markdown、代码围栏或解释。对象只有 directions 字段，它必须是恰好 3 个对象的数组；每个对象只有 title、oneLine、hook、proof、cta 五个非空字符串字段。三个方向必须有实质差异，不虚构产品数据、背书或用户未提供的卖点。`,
      prompt: `根据以下已经由用户在界面中确认的 Brief，生成恰好 3 个差异化创意方向。\n\n${briefContext}`
    });
    const parsed = jsonObject(raw);
    const values = Array.isArray(parsed.directions) ? parsed.directions : [];
    const directions: CreativeDirectionDraft[] = values.map((value) => {
      const record = recordValue(value);
      return {
        title: stringValue(record, "title"),
        oneLine: stringValue(record, "oneLine"),
        hook: stringValue(record, "hook"),
        proof: stringValue(record, "proof"),
        cta: stringValue(record, "cta")
      };
    });
    await this.workflow.createCreativeDirections(input.projectRoot, directions);
    await this.projects.updateNodeStatus(input.projectRoot, state.brief.nodeId, "approved");
    return {
      id: randomUUID(),
      text: "Brief 已确认，并生成了 3 个创意方向。请直接使用下方选项选择一个方向，也可以补充或融合你的想法；提交后会立即生成脚本。",
      createdAt: new Date().toISOString()
    };
  }

  async generateScript(input: {
    projectRoot: string;
    directionIndex: number;
    supplement: string;
    apiKey: string;
    textModelId: string;
  }): Promise<AgentReply> {
    const state = await this.workflow.state(input.projectRoot);
    const direction = state.creative?.directions[input.directionIndex];
    if (!state.creative || !direction) throw new Error("找不到所选创意方向，请重新生成三个方向");
    const project = await this.projects.open(input.projectRoot);
    const contextIds = [state.brief?.nodeId, state.creative.nodeId].filter((id): id is string => Boolean(id));
    const projectContext = await this.projects.selectedContext(input.projectRoot, contextIds);
    const selectedDirection = {
      ...direction,
      supplement: input.supplement.trim()
    };
    const raw = await structuredText({
      apiKey: input.apiKey,
      textModelId: input.textModelId,
      maxTokens: 8192,
      systemPrompt: `你负责把用户已通过界面选择的创意方向直接写成结构化 TVC 脚本。只输出 JSON 对象，不要 Markdown、代码围栏、解释或再次确认。对象只有 shots 字段。shots 是非空数组，每个对象只能有 shotId、duration、prompt、audioSfxPrompt、vo 五个字段。shotId 依次使用 S1、S2、S3……；duration 是大于 0 的秒数，可以包含小数；prompt 必须是可直接用于文生图的英文提示词；audioSfxPrompt 必须是英文声音描述；vo 是需要尽量逐字朗读的旁白，可使用项目所需语言或为空。镜头数量和每镜时长由你根据创意自行决定，不设置镜头数量上限，但所有 duration 之和必须严格等于项目总时长。不得虚构产品数据、认证或用户未提供的卖点。`,
      prompt: `直接生成脚本，不要提问。\n项目总时长：${project.project.adDuration} 秒。你自行决定镜头数量和各镜头时长，但总和必须严格等于 ${project.project.adDuration}。\n画幅：${project.project.aspectRatio ?? "16:9"}\n\n用户选择的创意方向：\n${JSON.stringify(selectedDirection, null, 2)}\n\n项目上下文：\n${projectContext}`
    });
    const parsed = jsonObject(raw);
    const values = Array.isArray(parsed.shots) ? parsed.shots : [];
    const shots: ScriptShotDraft[] = values.map((value, index) => {
      const record = recordValue(value);
      return {
        shotId: stringValue(record, "shotId") || `S${index + 1}`,
        duration: Number(record.duration ?? 0),
        prompt: stringValue(record, "prompt"),
        audioSfxPrompt: stringValue(record, "audioSfxPrompt"),
        vo: stringValue(record, "vo")
      };
    });
    const selectedLabel = input.supplement.trim()
      ? `${direction.title}（补充：${input.supplement.trim()}）`
      : direction.title;
    await this.workflow.createScript(input.projectRoot, selectedLabel, shots);
    await this.projects.updateNodeStatus(input.projectRoot, state.creative.nodeId, "approved");
    if (state.brief && state.brief.status !== "approved") {
      await this.projects.updateNodeStatus(input.projectRoot, state.brief.nodeId, "approved");
    }
    return {
      id: randomUUID(),
      text: `已按“${direction.title}”生成脚本 V1：镜头数量和时长由 AI 自行决定，总时长为 ${project.project.adDuration} 秒。五列表格可直接编辑。`,
      createdAt: new Date().toISOString()
    };
  }

  async generateStoryboardImages(input: {
    projectRoot: string;
    apiKey: string;
    imageModelId: string;
    scriptNodeId: string;
  }): Promise<AgentReply> {
    const project = await this.projects.open(input.projectRoot);
    const scriptNode = project.canvas.nodes.find(
      (node) => node.id === input.scriptNodeId && node.kind === "script"
    );
    if (!scriptNode) throw new Error("请先选择要生成静态图的脚本版本");
    const shots = validateScriptShots(
      parseScriptMarkdown(await this.projects.readBody(input.projectRoot, scriptNode.bodyPath)),
      project.project.adDuration
    );
    // 同一脚本重复点击"脚本确认 开始生成"时，复用上一批次里已经成功的镜头节点，
    // 只补生失败或缺失的镜头：已成功的图片必须保留，也不再重复计费。
    const previousSetId = [...project.canvas.nodes]
      .reverse()
      .find((node) =>
        node.kind === "storyboard-frame" &&
        node.sourceScriptNodeId === scriptNode.id &&
        node.imageSetId
      )?.imageSetId;
    const existingByShot = new Map<string, { node: CanvasNode; manifest: StoryboardNodeManifest }>();
    if (previousSetId) {
      for (const node of project.canvas.nodes) {
        if (node.kind !== "storyboard-frame" || node.imageSetId !== previousSetId || !node.shotId) continue;
        const manifest = await readStoryboardNodeManifest(input.projectRoot, node.id).catch(() => null);
        if (manifest) existingByShot.set(node.shotId, { node, manifest });
      }
    }
    const reusableShotIds = new Set(
      shots
        .filter((shot) => {
          const existing = existingByShot.get(shot.shotId);
          if (!existing) return false;
          const selected = existing.manifest.versions.find(
            (candidate) =>
              candidate.id === existing.manifest.selectedVersionId && candidate.status === "ready"
          );
          // 只有当图片已成功、且 Prompt 与当前脚本这一行完全一致时才算可复用。
          return Boolean(selected && selected.prompt === shot.prompt);
        })
        .map((shot) => shot.shotId)
    );
    const imageSetId = reusableShotIds.size > 0 && previousSetId ? previousSetId : randomUUID();
    const client = new OrzClient(input.apiKey);
    const aspectRatio = project.project.aspectRatio === "21:9"
      ? "16:9"
      : (project.project.aspectRatio ?? "16:9");
    const projectReferences = await projectReferenceImageUrls(input.projectRoot, client);
    let completedCount = reusableShotIds.size;
    const failures: string[] = [];

    for (const [shotIndex, shot] of shots.entries()) {
      if (reusableShotIds.has(shot.shotId)) continue;
      // 失败镜头原地重试，避免每次重跑都堆出一排废弃节点。
      const reused = existingByShot.get(shot.shotId);
      const node = reused && reused.node.imageSetId === imageSetId
        ? reused.node
        : await this.workflow.createStoryboardFrameNode(input.projectRoot, {
            sourceScriptNodeId: scriptNode.id,
            imageSetId,
            shotId: shot.shotId,
            shotIndex,
            prompt: shot.prompt
          });
      const previousVersions = reused && reused.node.id === node.id ? reused.manifest.versions : [];
      const version: StoryboardNodeImageVersion = {
        id: randomUUID(),
        prompt: shot.prompt,
        modelId: input.imageModelId,
        status: "generating",
        createdAt: new Date().toISOString()
      };
      const base: StoryboardNodeManifest = {
        version: 1,
        nodeId: node.id,
        shotId: shot.shotId,
        duration: shot.duration,
        sourceScriptNodeId: scriptNode.id,
        imageSetId,
        versions: [...previousVersions, version]
      };
      await writeStoryboardNodeManifest(input.projectRoot, base);
      await this.projects.updateNodeStatus(input.projectRoot, node.id, "generating");
      let settled: StoryboardNodeImageVersion;
      try {
        settled = await this.generateImageVersion({
          projectRoot: input.projectRoot,
          client,
          modelId: input.imageModelId,
          nodeId: node.id,
          imageSetId,
          shotId: shot.shotId,
          prompt: shot.prompt,
          aspectRatio,
          referenceImageUrls: projectReferences,
          versionId: version.id
        });
        completedCount += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知图片生成错误";
        settled = { ...version, status: "failed", error: message };
        failures.push(`${shot.shotId}：${message}`);
      }
      // 单个镜头失败只影响它自己，循环继续，其余镜头照常生成。
      const manifest: StoryboardNodeManifest = {
        ...base,
        versions: [...previousVersions, settled],
        selectedVersionId: settled.status === "ready" ? settled.id : reused?.manifest.selectedVersionId
      };
      await writeStoryboardNodeManifest(input.projectRoot, manifest);
      await this.writeStoryboardNodeBody(input.projectRoot, node.bodyPath, manifest);
      await this.projects.updateNodeStatus(
        input.projectRoot,
        node.id,
        manifest.selectedVersionId ? "completed" : "failed"
      );
    }
    await this.projects.updateNodeStatus(input.projectRoot, scriptNode.id, "approved");
    const reusedNote = reusableShotIds.size > 0
      ? `其中 ${reusableShotIds.size} 个镜头沿用上一批已成功的图片，没有重复生成和计费。`
      : "";
    return {
      id: randomUUID(),
      text: failures.length === 0
        ? `已严格使用脚本第三列 Prompt 生成 ${completedCount}/${shots.length} 张独立静态效果图。${reusedNote}每张图都可以查看 Prompt、手动重新生成或应用到下一个脚本版本。`
        : `已完成 ${completedCount}/${shots.length} 张静态效果图；${reusedNote}失败镜头可在对应图片卡片中单独重试，成功的图片不受影响。${failures.join("；")}`,
      createdAt: new Date().toISOString()
    };
  }

  async storyboardImageState(input: { projectRoot: string; nodeId: string }): Promise<StoryboardImageState> {
    return storyboardImageStateFromManifest(
      input.projectRoot,
      await readStoryboardNodeManifest(input.projectRoot, input.nodeId)
    );
  }

  async regenerateStoryboardImage(input: {
    projectRoot: string;
    nodeId: string;
    prompt: string;
    apiKey: string;
    imageModelId: string;
  }): Promise<StoryboardImageState> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Prompt 不能为空");
    const project = await this.projects.open(input.projectRoot);
    const node = project.canvas.nodes.find((candidate) => candidate.id === input.nodeId && candidate.kind === "storyboard-frame");
    if (!node) throw new Error("找不到要重新生成的静态图节点");
    const manifest = await readStoryboardNodeManifest(input.projectRoot, input.nodeId);
    const pending: StoryboardNodeImageVersion = {
      id: randomUUID(),
      prompt,
      modelId: input.imageModelId,
      status: "generating",
      createdAt: new Date().toISOString()
    };
    // 每次生成都追加一个新版本，绝不覆盖旧版本。
    await writeStoryboardNodeManifest(input.projectRoot, {
      ...manifest,
      versions: [...manifest.versions, pending]
    });
    await this.projects.updateNodeStatus(input.projectRoot, node.id, "generating");
    const aspectRatio = project.project.aspectRatio === "21:9" ? "16:9" : (project.project.aspectRatio ?? "16:9");
    const client = new OrzClient(input.apiKey);
    let version: StoryboardNodeImageVersion;
    try {
      version = await this.generateImageVersion({
        projectRoot: input.projectRoot,
        client,
        modelId: input.imageModelId,
        nodeId: node.id,
        imageSetId: manifest.imageSetId,
        shotId: manifest.shotId,
        prompt,
        aspectRatio,
        referenceImageUrls: await projectReferenceImageUrls(input.projectRoot, client),
        versionId: pending.id
      });
    } catch (error) {
      version = {
        ...pending,
        status: "failed",
        error: error instanceof Error ? error.message : "未知图片生成错误"
      };
    }
    // 新版本失败时保留原来的选中版本，旧图继续显示。
    const next: StoryboardNodeManifest = {
      ...manifest,
      versions: [...manifest.versions, version],
      selectedVersionId: version.status === "ready" ? version.id : manifest.selectedVersionId
    };
    await writeStoryboardNodeManifest(input.projectRoot, next);
    await this.writeStoryboardNodeBody(input.projectRoot, node.bodyPath, next);
    await this.projects.updateNodeStatus(
      input.projectRoot,
      node.id,
      next.selectedVersionId ? "completed" : "failed"
    );
    return storyboardImageStateFromManifest(input.projectRoot, next);
  }

  async selectStoryboardImageVersion(input: {
    projectRoot: string;
    nodeId: string;
    versionId: string;
  }): Promise<StoryboardImageState> {
    const project = await this.projects.open(input.projectRoot);
    const node = project.canvas.nodes.find((candidate) => candidate.id === input.nodeId && candidate.kind === "storyboard-frame");
    if (!node) throw new Error("找不到静态图节点");
    const manifest = await readStoryboardNodeManifest(input.projectRoot, input.nodeId);
    const version = manifest.versions.find((candidate) => candidate.id === input.versionId);
    if (!version || version.status !== "ready") throw new Error("只能选择已经生成成功的图片版本");
    manifest.selectedVersionId = version.id;
    await writeStoryboardNodeManifest(input.projectRoot, manifest);
    await this.writeStoryboardNodeBody(input.projectRoot, node.bodyPath, manifest);
    return storyboardImageStateFromManifest(input.projectRoot, manifest);
  }

  async applyStoryboardImage(input: {
    projectRoot: string;
    nodeId: string;
    baseScriptNodeId?: string | undefined;
    apiKey: string;
    textModelId: string;
  }): Promise<AgentReply> {
    const manifest = await readStoryboardNodeManifest(input.projectRoot, input.nodeId);
    const selected = manifest.versions.find((version) => version.id === manifest.selectedVersionId && version.status === "ready");
    if (!selected) throw new Error("请先选择一个生成成功的图片版本");
    const project = await this.projects.open(input.projectRoot);
    const baseScriptNodeId = input.baseScriptNodeId ?? manifest.sourceScriptNodeId;
    const base = project.canvas.nodes.find((node) => node.id === baseScriptNodeId && node.kind === "script");
    if (!base) throw new Error("请先选择一个脚本节点作为新版本基础");
    const shots = validateScriptShots(
      parseScriptMarkdown(await this.projects.readBody(input.projectRoot, base.bodyPath)),
      project.project.adDuration
    );
    const shot = shots.find((candidate) => candidate.shotId === manifest.shotId);
    if (!shot) throw new Error(`所选脚本中没有镜头 ${manifest.shotId}`);
    const raw = await structuredText({
      apiKey: input.apiKey,
      textModelId: input.textModelId,
      maxTokens: 2048,
      systemPrompt: `Convert this still-image prompt into a production-ready image-to-video prompt. 只输出 JSON 对象，且只有 videoPrompt 一个字符串字段，值必须是英文。保留主体、产品、服装、场景、构图和风格，增加明确的主体动作、镜头运动、节奏、时间变化和连续性。不要修改 Audio & SFX 或 VO，不要生成新的镜头，不要添加解释。`,
      prompt: `镜头：${shot.shotId}\n时长：${shot.duration} 秒\n静态图片 Prompt：${selected.prompt}\nAudio & SFX：${shot.audioSfxPrompt}\nVO（必须尽量逐字保留）：${shot.vo || "无"}`
    });
    const videoPrompt = stringValue(jsonObject(raw), "videoPrompt");
    if (!videoPrompt) throw new Error("文本模型没有返回视频 Prompt");
    const created = await this.workflow.createNextScriptVersion(input.projectRoot, {
      baseScriptNodeId: base.id,
      shotId: manifest.shotId,
      videoPrompt
    });
    return {
      id: randomUUID(),
      text: `已把 ${manifest.shotId} 应用到${created.title}。新节点是上一版本的完整副本，只替换该镜头的视频 Prompt；时长、Audio & SFX 和 VO 均已保留。`,
      createdAt: new Date().toISOString()
    };
  }

  async generateVideoPrompt(input: {
    projectRoot: string;
    scriptNodeId: string;
    imageNodeIds: readonly string[];
    apiKey: string;
    textModelId: string;
  }): Promise<GenerateVideoPromptResult> {
    const project = await this.projects.open(input.projectRoot);
    const script = project.canvas.nodes.find((node) => node.id === input.scriptNodeId && node.kind === "script");
    if (!script) throw new Error("请先选择一个脚本版本");
    const shots = validateScriptShots(
      parseScriptMarkdown(await this.projects.readBody(input.projectRoot, script.bodyPath)),
      project.project.adDuration
    );
    if (input.imageNodeIds.length !== shots.length) {
      throw new Error(
        `必须选择 ${shots.length} 张图片：当前脚本有 ${shots.length} 个镜头，但选择了 ${input.imageNodeIds.length} 张`
      );
    }
    const manifests = await Promise.all(
      input.imageNodeIds.map((nodeId) => readStoryboardNodeManifest(input.projectRoot, nodeId))
    );
    const manifestByShot = new Map(manifests.map((manifest) => [manifest.shotId, manifest]));
    if (manifestByShot.size !== shots.length || shots.some((shot) => !manifestByShot.has(shot.shotId))) {
      throw new Error("每个镜头必须且只能选择一张静态图，不能缺少镜头或重复选择同一镜头");
    }
    const ordered = shots.map((shot) => {
      const manifest = manifestByShot.get(shot.shotId)!;
      const version = manifest.versions.find(
        (candidate) => candidate.id === manifest.selectedVersionId && candidate.status === "ready" && candidate.relativePath
      );
      if (!version?.relativePath) throw new Error(`${shot.shotId} 没有选中可用的图片版本`);
      return { shot, manifest, version };
    });
    // 多模态理解读得懂 data URL；但随后提交给视频模型的 reference_image_urls
    // 必须是 ORZ 可访问的真实链接，两者来源不同，不能混用。
    const visionImageUrls = await Promise.all(
      ordered.map(({ version }) => dataUrlFromRelativePath(input.projectRoot, version.relativePath!))
    );
    const client = new OrzClient(input.apiKey);
    const referenceImageUrls: string[] = [];
    for (const { shot, version } of ordered) {
      const uploaded = version.sourceUrl && /^https?:\/\//i.test(version.sourceUrl)
        ? version.sourceUrl
        : await uploadLocalImage(input.projectRoot, version.relativePath!, client);
      if (!uploaded) {
        throw new Error(`${shot.shotId} 的静态图无法上传到 ORZ，暂时不能提交视频生成，请重试或重新生成该镜头图片`);
      }
      referenceImageUrls.push(uploaded);
    }
    let cursor = 0;
    const timeline = ordered.map(({ shot, version }) => {
      const start = cursor;
      cursor += shot.duration;
      return {
        shotId: shot.shotId,
        start,
        end: cursor,
        duration: shot.duration,
        selectedImagePrompt: version.prompt,
        scriptPrompt: shot.prompt,
        audioSfxPrompt: shot.audioSfxPrompt,
        vo: shot.vo
      };
    });
    const prompt = await structuredVisionText({
      apiKey: input.apiKey,
      textModelId: input.textModelId,
      maxTokens: 4096,
      imageUrls: visionImageUrls,
      systemPrompt: `你是 TVC 视频导演。根据按镜头顺序提供的全部参考图和时间轴，生成一整段可直接交给视频模型的英文 Prompt。只输出最终 Prompt，不要 Markdown 代码围栏或解释。必须覆盖全部镜头，不得添加额外镜头，不得改变产品外观或品牌文字。明确每个时间段、镜头运动、主体动作、服装与包装连续性、灯光与色彩连续性、转场、Audio & SFX 和 VO 的时间位置。要求视频模型生成原生声音；VO 原文必须用引号保留，并写明 Speak every VO line as literally and verbatim as possible, without rewriting.`,
      prompt: `项目画幅：${project.project.aspectRatio ?? "16:9"}\n项目总时长：${project.project.adDuration} 秒\n以下 JSON 的顺序与随后图片顺序完全一致：\n${JSON.stringify(timeline, null, 2)}`
    });
    return {
      prompt,
      scriptNodeId: script.id,
      imageNodeIds: ordered.map(({ manifest }) => manifest.nodeId),
      referenceImageUrls,
      duration: project.project.adDuration,
      shotCount: shots.length,
      aspectRatio: project.project.aspectRatio ?? "16:9"
    };
  }

  async splitStoryboardOverview(input: { projectRoot: string }): Promise<AgentReply> {
    const manifest = await readStoryboardManifest(input.projectRoot);
    const overview = manifest.overview;
    if (!overview) throw new Error("请先生成静态分镜总览图，再切分镜头");
    const overviewPath = join(input.projectRoot, overview.relativePath);
    if (!(await fileExists(overviewPath))) throw new Error("静态分镜总览图文件不存在，请重新生成总览图");
    const overviewBytes = await readFile(overviewPath);
    const frames = [];
    for (const tile of overview.tiles) {
      const bytes = cropStoryboardTile(overviewBytes, tile);
      const safeShot = tile.shot.replace(/[^a-zA-Z0-9_-]/g, "-") || "shot";
      const relativePath = `assets/storyboards/cuts/${safeShot}-${overview.sourceHash.slice(0, 12)}.png`;
      await writeAtomic(join(input.projectRoot, relativePath), bytes);
      frames.push({
        shot: tile.shot,
        relativePath,
        dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
        width: tile.width,
        height: tile.height
      });
    }
    await this.workflow.createStoryboardFrames(input.projectRoot, frames);
    return {
      id: randomUUID(),
      text: `已从总览图本地切分 ${frames.length} 个镜头并写入无限画布；本次没有调用图片模型，也没有产生新的模型费用。`,
      createdAt: new Date().toISOString()
    };
  }

  async restateBrief(input: {
    projectRoot: string;
    apiKey: string;
    textModelId: string;
  }): Promise<AgentReply> {
    const createdAt = new Date().toISOString();
    const { project, sourceMarkdown } = await this.projects.briefContext(input.projectRoot);
    const agent = new Agent({
      initialState: {
        systemPrompt: `你负责复述广告 Brief。只输出一个 JSON 对象，不要 Markdown、代码围栏或解释。JSON 必须只有三个字符串字段：productAndSellingPoint、creativeIdea、visualStyle。不得虚构用户未提供的产品卖点；缺失信息写“首页输入中未明确，请补充或直接编辑”。`,
        model: createOrzModel(input.textModelId, 2048),
        thinkingLevel: "off",
        tools: [],
        messages: []
      },
      getApiKey: (provider) => (provider === "orz" ? input.apiKey : undefined),
      streamFn: streamOrzRest,
      toolExecution: "sequential"
    });

    try {
      await agent.prompt(`请根据以下首页输入复述 Brief。画幅和时长由系统固定，不要自行修改。\n\n画幅：${project.aspectRatio ?? "16:9"}\n时长：${project.adDuration} 秒\n\n首页富文本输入：\n${sourceMarkdown || "（用户暂未填写文字描述）"}`);
      assertAgentSucceeded(agent);
      const raw = assistantText(agent);
      if (!raw) throw new Error("ORZ 文本模型没有返回 Brief 复述");
      const json = raw.match(/\{[\s\S]*\}/)?.[0];
      let restatement: BriefRestatement;
      try {
        const parsed = JSON.parse(json ?? raw) as Partial<BriefRestatement>;
        restatement = {
          productAndSellingPoint: String(parsed.productAndSellingPoint ?? ""),
          creativeIdea: String(parsed.creativeIdea ?? ""),
          visualStyle: String(parsed.visualStyle ?? "")
        };
      } catch {
        restatement = {
          productAndSellingPoint: "首页输入中未明确，请补充或直接编辑。",
          creativeIdea: raw,
          visualStyle: "首页输入中未明确，请补充或直接编辑。"
        };
      }
      await this.projects.writeBriefRestatement(input.projectRoot, restatement);
      return {
        id: randomUUID(),
        text: `我已经根据首页输入生成“我理解的 Brief”。你可以直接编辑卡片，或在对话中告诉我如何修改；确认后再进入 3 个创意方向。`,
        createdAt
      };
    } catch (error) {
      throw new Error(providerErrorMessage(error, input.textModelId));
    }
  }

  async prompt(input: {
    projectRoot: string;
    prompt: string;
    selectedNodeIds: readonly string[];
    selectedContext: string;
    apiKey: string;
    textModelId: string;
    requestId: string;
    emit: (event: AgentUiEvent) => void;
  }): Promise<AgentReply> {
    const transactionId = randomUUID();
    const createdAt = new Date().toISOString();
    this.insertTransaction(input.projectRoot, transactionId, input.prompt, input.selectedNodeIds, createdAt);

    const model = createOrzModel(input.textModelId);

    const briefParameters = Type.Object({
      productAndSellingPoint: Type.String(),
      creativeIdea: Type.String(),
      visualStyle: Type.String()
    });
    const updateBriefRestatement: AgentTool<typeof briefParameters> = {
      name: "update_brief_restatement",
      label: "更新我理解的 Brief",
      description: "当用户纠正产品卖点、创意点或画面风格时，更新现有 Brief 节点。画幅和时长沿用项目设置。",
      parameters: briefParameters,
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        const node = await this.projects.writeBriefRestatement(input.projectRoot, params);
        input.emit({ type: "project-changed", requestId: input.requestId });
        return {
          content: [{ type: "text", text: "已更新“我理解的 Brief”，等待用户确认。" }],
          details: { nodeId: node.id, kind: node.kind, status: node.status }
        };
      }
    };

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: "off",
        tools: [updateBriefRestatement],
        messages: []
      },
      getApiKey: (provider) => (provider === "orz" ? input.apiKey : undefined),
      streamFn: streamOrzRest,
      toolExecution: "sequential"
    });

    agent.subscribe((event) => {
      if (event.type === "agent_start") input.emit({ type: "agent-start", requestId: input.requestId });
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        input.emit({ type: "text-delta", requestId: input.requestId, delta: event.assistantMessageEvent.delta });
      }
      if (event.type === "tool_execution_start") {
        input.emit({
          type: "tool-start",
          requestId: input.requestId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args
        });
      }
      if (event.type === "tool_execution_end") {
        input.emit({
          type: "tool-end",
          requestId: input.requestId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError
        });
      }
      if (event.type === "agent_end") input.emit({ type: "agent-end", requestId: input.requestId });
    });

    try {
      const context = input.selectedContext.trim() || "项目中暂时没有可用节点内容。";
      await agent.prompt(`以下是当前项目上下文：\n\n${context}\n\n用户请求：\n${input.prompt}`);
      assertAgentSucceeded(agent);
      const text = assistantText(agent);
      if (!text) throw new Error("ORZ 文本模型返回了空内容");
      this.finishTransaction(input.projectRoot, transactionId, text, "completed");
      return { id: transactionId, text, createdAt: new Date().toISOString() };
    } catch (error) {
      const message = providerErrorMessage(error, input.textModelId);
      input.emit({ type: "agent-error", requestId: input.requestId, message });
      this.finishTransaction(input.projectRoot, transactionId, message, "failed");
      throw new Error(message);
    }
  }

  private async generateImageVersion(input: {
    projectRoot: string;
    client: OrzClient;
    modelId: string;
    nodeId: string;
    imageSetId: string;
    shotId: string;
    prompt: string;
    aspectRatio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
    referenceImageUrls: readonly string[];
    versionId: string;
  }): Promise<StoryboardNodeImageVersion> {
    const submitted = await input.client.submitImage(
      buildStoryboardImagePayload(
        {
          shotId: input.shotId,
          prompt: input.prompt,
          aspectRatio: input.aspectRatio,
          referenceImageUrls: input.referenceImageUrls,
          count: 1,
          outputFormat: "png"
        },
        input.modelId
      )
    );
    const completed = await waitForImageTask(input.client, submitted);
    const outputUrl = completed.output?.items?.find((item) => item.url)?.url;
    if (!outputUrl) throw new Error(`镜头 ${input.shotId} 没有返回图片地址`);
    const downloaded = await downloadImageWithRetry(outputUrl, input.shotId);
    if (!isPng(downloaded.bytes)) throw new Error(`镜头 ${input.shotId} 返回了非 PNG 图片`);
    const safeShot = input.shotId.replace(/[^a-zA-Z0-9_-]/g, "-") || "shot";
    const relativePath = `assets/storyboards/sets/${input.imageSetId}/${safeShot}-${input.nodeId.slice(0, 8)}-${input.versionId.slice(0, 8)}.png`;
    await writeAtomic(join(input.projectRoot, relativePath), downloaded.bytes);
    return {
      id: input.versionId,
      prompt: input.prompt,
      modelId: input.modelId,
      status: "ready",
      relativePath,
      sourceUrl: outputUrl,
      createdAt: new Date().toISOString()
    };
  }

  private async writeStoryboardNodeBody(
    projectRoot: string,
    bodyPath: string,
    manifest: StoryboardNodeManifest
  ): Promise<void> {
    const selected = manifest.versions.find(
      (version) => version.id === manifest.selectedVersionId && version.status === "ready" && version.relativePath
    );
    const lastFailed = [...manifest.versions].reverse().find((version) => version.status === "failed");
    const image = selected?.relativePath
      ? `![${manifest.shotId} 静态效果图](${await dataUrlFromRelativePath(projectRoot, selected.relativePath)})\n\n`
      : "";
    const prompt = selected?.prompt ?? manifest.versions.at(-1)?.prompt ?? "";
    await this.projects.writeBody(
      projectRoot,
      bodyPath,
      `# ${manifest.shotId} 静态效果图\n\n${image}## Prompt\n\n${prompt}\n${lastFailed?.error ? `\n> 最近一次生成失败：${lastFailed.error}\n` : ""}`
    );
  }

  private insertTransaction(
    projectRoot: string,
    id: string,
    prompt: string,
    selectedNodeIds: readonly string[],
    createdAt: string
  ): void {
    const db = new Database(`${projectRoot}/.agent/index.sqlite`);
    db.prepare(`
      INSERT INTO agent_transactions (
        id, prompt, selected_node_ids_json, response, status, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, 'running', ?, ?)
    `).run(id, prompt, JSON.stringify(selectedNodeIds), createdAt, createdAt);
    db.close();
  }

  private finishTransaction(projectRoot: string, id: string, response: string, status: "completed" | "failed"): void {
    const db = new Database(`${projectRoot}/.agent/index.sqlite`);
    db.prepare("UPDATE agent_transactions SET response = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(response, status, new Date().toISOString(), id);
    db.close();
  }
}
