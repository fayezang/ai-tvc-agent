import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { Schema } from "effect";
import {
  CanvasSnapshotSchema,
  ProjectSummarySchema,
  type CanvasNode,
  type CanvasSnapshot,
  type CreateProjectRequest,
  type NodeKind,
  type NodeStatus,
  type ProjectState,
  type ProjectSummary
} from "../shared/contracts.js";
import { indexedNodes } from "./db-schema.js";
import { runMigrations } from "./migrations.js";
import {
  buildBriefRestatementMarkdown,
  buildInitialBrief,
  type BriefRestatement
} from "./brief-flow.js";

const decodeCanvas = Schema.decodeUnknownSync(CanvasSnapshotSchema);
const decodeProject = Schema.decodeUnknownSync(ProjectSummarySchema);

const nodeTitles: Readonly<Record<NodeKind, string>> = {
  brief: "Brief",
  "creative-direction": "创意方向",
  script: "结构化脚本",
  storyboard: "静态分镜",
  "storyboard-overview": "静态分镜总览",
  "storyboard-frame": "静态参考图",
  video: "视频版本",
  audio: "旁白与音乐",
  export: "导出"
};

const normalizeName = (name: string): string =>
  name.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").slice(0, 80) || "未命名项目";

const ensureInside = (root: string, relativePath: string): string => {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, relativePath);
  const pathFromRoot = relative(absoluteRoot, target);
  if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === ".." || resolve(target) === resolve(sep)) {
    throw new Error("文件路径超出项目目录");
  }
  return target;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const writeAtomic = async (path: string, contents: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

export class ProjectService {
  async create(parentPath: string, input: CreateProjectRequest): Promise<ProjectState> {
    const name = normalizeName(input.name);
    let rootPath = join(parentPath, name);
    if (await exists(rootPath)) rootPath = join(parentPath, `${name}-${randomUUID().slice(0, 8)}`);

    await mkdir(join(rootPath, ".agent"), { recursive: true });
    await mkdir(join(rootPath, "nodes"), { recursive: true });
    await mkdir(join(rootPath, "assets"), { recursive: true });
    await mkdir(join(rootPath, "outputs"), { recursive: true });

    const now = new Date().toISOString();
    const project: ProjectSummary = {
      id: randomUUID(),
      name,
      rootPath,
      adDuration: input.adDuration,
      aspectRatio: input.aspectRatio,
      createdAt: now,
      updatedAt: now
    };
    const briefNode: CanvasNode = {
      id: randomUUID(),
      kind: "brief",
      title: "Brief",
      bodyPath: "nodes/brief.md",
      position: { x: 120, y: 100 },
      width: 520,
      height: 480,
      status: "draft"
    };
    const canvas: CanvasSnapshot = {
      version: 1,
      nodes: [briefNode],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 }
    };

    await writeAtomic(join(rootPath, "project.json"), JSON.stringify(project, null, 2));
    await writeAtomic(join(rootPath, "canvas.json"), JSON.stringify(canvas, null, 2));
    const sourceMarkdown = await this.persistReferenceImages(rootPath, input.briefMarkdown.trim());
    await writeAtomic(join(rootPath, "nodes/brief-input.md"), sourceMarkdown);
    await writeAtomic(join(rootPath, briefNode.bodyPath), buildInitialBrief(project, sourceMarkdown));
    this.initializeIndex(rootPath, canvas);
    return { project, canvas };
  }

  async open(rootPath: string): Promise<ProjectState> {
    const project = decodeProject(JSON.parse(await readFile(join(rootPath, "project.json"), "utf8")));
    const canvas = decodeCanvas(JSON.parse(await readFile(join(rootPath, "canvas.json"), "utf8")));
    this.initializeIndex(rootPath, canvas);
    return { project: { ...project, rootPath }, canvas };
  }

  async saveCanvas(rootPath: string, canvas: CanvasSnapshot): Promise<CanvasSnapshot> {
    const decoded = decodeCanvas(canvas);
    await writeAtomic(join(rootPath, "canvas.json"), JSON.stringify(decoded, null, 2));
    this.indexNodes(rootPath, decoded);
    return decoded;
  }

  async readBody(rootPath: string, bodyPath: string): Promise<string> {
    return readFile(ensureInside(rootPath, bodyPath), "utf8");
  }

  async writeBody(rootPath: string, bodyPath: string, markdown: string): Promise<void> {
    await writeAtomic(ensureInside(rootPath, bodyPath), markdown);
    const canvas = decodeCanvas(JSON.parse(await readFile(join(rootPath, "canvas.json"), "utf8")));
    const node = canvas.nodes.find((candidate) => candidate.bodyPath === bodyPath);
    if (node) {
      const db = this.openIndex(rootPath);
      db.update(indexedNodes)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(indexedNodes.id, node.id))
        .run();
      db.$client.close();
    }
  }

  async createNode(rootPath: string, kind: NodeKind, position: { x: number; y: number }): Promise<CanvasNode> {
    const canvasPath = join(rootPath, "canvas.json");
    const canvas = decodeCanvas(JSON.parse(await readFile(canvasPath, "utf8")));
    const id = randomUUID();
    const bodyPath = `nodes/${kind}-${id}.md`;
    const node: CanvasNode = {
      id,
      kind,
      title: nodeTitles[kind],
      bodyPath,
      position,
      width: kind === "storyboard"
        ? 820
        : kind === "storyboard-overview"
          ? 920
          : kind === "storyboard-frame" || kind === "video"
            ? 560
            : 440,
      height: kind === "storyboard"
        ? 420
        : kind === "storyboard-overview"
          ? 620
          : kind === "storyboard-frame" || kind === "video"
            ? 360
            : 300,
      status: "draft"
    };
    const nextCanvas: CanvasSnapshot = { ...canvas, nodes: [...canvas.nodes, node] };
    await writeAtomic(ensureInside(rootPath, bodyPath), `# ${node.title}\n\n`);
    await this.saveCanvas(rootPath, nextCanvas);
    return node;
  }

  async updateNodeStatus(rootPath: string, nodeId: string, status: NodeStatus): Promise<CanvasNode> {
    const canvasPath = join(rootPath, "canvas.json");
    const canvas = decodeCanvas(JSON.parse(await readFile(canvasPath, "utf8")));
    const current = canvas.nodes.find((node) => node.id === nodeId);
    if (!current) throw new Error("找不到要更新的节点");
    const updated: CanvasNode = { ...current, status };
    const next: CanvasSnapshot = {
      ...canvas,
      nodes: canvas.nodes.map((node) => (node.id === nodeId ? updated : node))
    };
    await this.saveCanvas(rootPath, next);
    return updated;
  }

  async briefContext(rootPath: string): Promise<{ project: ProjectSummary; sourceMarkdown: string }> {
    const project = decodeProject(JSON.parse(await readFile(join(rootPath, "project.json"), "utf8")));
    const sourcePath = join(rootPath, "nodes/brief-input.md");
    const sourceMarkdown = (await exists(sourcePath)) ? await readFile(sourcePath, "utf8") : "";
    return { project: { ...project, rootPath }, sourceMarkdown };
  }

  async writeBriefRestatement(rootPath: string, restatement: BriefRestatement): Promise<CanvasNode> {
    const { project } = await this.briefContext(rootPath);
    const canvas = decodeCanvas(JSON.parse(await readFile(join(rootPath, "canvas.json"), "utf8")));
    const briefNode = canvas.nodes.find((node) => node.kind === "brief");
    if (!briefNode) throw new Error("项目缺少 Brief 节点");
    const markdown = buildBriefRestatementMarkdown(project, restatement);
    await writeAtomic(join(rootPath, briefNode.bodyPath), markdown);
    const updated: CanvasNode = { ...briefNode, title: "我理解的 Brief", status: "awaiting-approval" };
    const next: CanvasSnapshot = {
      ...canvas,
      nodes: canvas.nodes.map((node) => (node.id === briefNode.id ? updated : node))
    };
    await this.saveCanvas(rootPath, next);
    return updated;
  }

  async selectedContext(rootPath: string, nodeIds: readonly string[]): Promise<string> {
    const canvas = decodeCanvas(JSON.parse(await readFile(join(rootPath, "canvas.json"), "utf8")));
    const selected = nodeIds.length > 0 ? canvas.nodes.filter((node) => nodeIds.includes(node.id)) : canvas.nodes;
    const parts = await Promise.all(
      selected.map(async (node) => `## ${node.title} (${node.kind})\n${await this.readBody(rootPath, node.bodyPath)}`)
    );
    return parts.join("\n\n");
  }

  private initializeIndex(rootPath: string, canvas: CanvasSnapshot): void {
    const sqlite = new Database(join(rootPath, ".agent", "index.sqlite"));
    sqlite.pragma("journal_mode = WAL");
    try {
      runMigrations(sqlite);
    } finally {
      sqlite.close();
    }
    this.indexNodes(rootPath, canvas);
  }

  private indexNodes(rootPath: string, canvas: CanvasSnapshot): void {
    const db = this.openIndex(rootPath);
    const now = new Date().toISOString();
    for (const node of canvas.nodes) {
      db.insert(indexedNodes)
        .values({ id: node.id, kind: node.kind, title: node.title, bodyPath: node.bodyPath, updatedAt: now })
        .onConflictDoUpdate({
          target: indexedNodes.id,
          set: { kind: node.kind, title: node.title, bodyPath: node.bodyPath, updatedAt: now }
        })
        .run();
    }
    db.$client.close();
  }

  openIndex(rootPath: string): BetterSQLite3Database & { $client: Database.Database } {
    const sqlite = new Database(join(rootPath, ".agent", "index.sqlite"));
    sqlite.pragma("journal_mode = WAL");
    // 打开既有项目时同样执行 migration：旧项目的库可能缺少后续版本新增的表或列。
    // runMigrations 幂等，已应用过的不会重跑。
    runMigrations(sqlite);
    return drizzle(sqlite) as BetterSQLite3Database & { $client: Database.Database };
  }

  private async persistReferenceImages(rootPath: string, markdown: string): Promise<string> {
    const pattern = /!\[([^\]]*)\]\(data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)\)/g;
    let next = "";
    let cursor = 0;
    let count = 0;
    for (const match of markdown.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const alt = match[1] ?? "参考图";
      const rawExtension = match[2];
      const base64 = match[3];
      if (!rawExtension || !base64) continue;
      count += 1;
      if (count > 12) throw new Error("参考图最多 12 张");
      const bytes = Buffer.from(base64, "base64");
      if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("单张参考图不能超过 10MB");
      const extension = rawExtension.toLowerCase().replace("jpeg", "jpg");
      const relativePath = `assets/references/reference-${count}-${randomUUID().slice(0, 8)}.${extension}`;
      await writeAtomic(join(rootPath, relativePath), bytes);
      next += markdown.slice(cursor, match.index);
      next += `![${alt}](../${relativePath})`;
      cursor = match.index + match[0].length;
    }
    return next + markdown.slice(cursor);
  }
}
