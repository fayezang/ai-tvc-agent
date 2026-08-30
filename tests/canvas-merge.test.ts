import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeCanvasFromClient } from "../src/utility/canvas-merge.js";
import { writeAtomic } from "../src/utility/project-service.js";
import type { CanvasNode, CanvasSnapshot } from "../src/shared/contracts.js";

const node = (id: string, overrides: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind: "storyboard-frame",
  title: `${id} 静态效果图`,
  bodyPath: `nodes/${id}.md`,
  position: { x: 0, y: 0 },
  status: "generating",
  ...overrides
});

const canvas = (nodes: CanvasNode[], edges: CanvasSnapshot["edges"] = []): CanvasSnapshot => ({
  version: 1,
  nodes,
  edges,
  viewport: { x: 0, y: 0, zoom: 1 }
});

describe("the bug this fixes", () => {
  test("keeps nodes the backend created while the client debounce was pending", () => {
    // 真实复现：用户在生成分镜时动了一下画布，renderer 排期一次 260ms 保存；
    // 期间后台为每个镜头创建了节点；防抖到期后旧快照整体覆盖，节点被抹掉，
    // 后台随即报「找不到要更新的节点」。
    const onDisk = canvas([node("script-1", { kind: "script" }), node("shot-1"), node("shot-2")]);
    const staleFromClient = canvas([node("script-1", { kind: "script" })]);

    const merged = mergeCanvasFromClient(onDisk, staleFromClient);

    expect(merged.nodes.map((entry) => entry.id).sort()).toEqual(["script-1", "shot-1", "shot-2"]);
  });

  test("keeps the edges that connect those new nodes", () => {
    // 边一起丢的话，分镜节点会变成画布上无主的孤岛。
    const onDisk = canvas(
      [node("script-1", { kind: "script" }), node("shot-1")],
      [{ id: "e1", source: "script-1", target: "shot-1" }]
    );
    const staleFromClient = canvas([node("script-1", { kind: "script" })]);

    const merged = mergeCanvasFromClient(onDisk, staleFromClient);

    expect(merged.edges).toEqual([{ id: "e1", source: "script-1", target: "shot-1" }]);
  });

  test("does not let a stale client revert a status the backend advanced", () => {
    // renderer 手上的 status 可能停留在 generating，
    // 而后台已经把它推进到 completed。业务字段必须以磁盘为准。
    const onDisk = canvas([node("shot-1", { status: "completed", title: "shot-1 已完成" })]);
    const staleFromClient = canvas([node("shot-1", { status: "generating", title: "旧标题" })]);

    const merged = mergeCanvasFromClient(onDisk, staleFromClient);

    expect(merged.nodes[0]?.status).toBe("completed");
    expect(merged.nodes[0]?.title).toBe("shot-1 已完成");
  });
});

describe("what the client still owns", () => {
  test("takes position from the client so dragging is not undone", () => {
    // 布局是用户的直接操作，必须生效——否则拖完节点会弹回原位。
    const onDisk = canvas([node("shot-1", { position: { x: 0, y: 0 } })]);
    const fromClient = canvas([node("shot-1", { position: { x: 480, y: 260 } })]);

    const merged = mergeCanvasFromClient(onDisk, fromClient);

    expect(merged.nodes[0]?.position).toEqual({ x: 480, y: 260 });
  });

  test("takes size and viewport from the client", () => {
    const onDisk = canvas([node("shot-1", { width: 440, height: 300 })]);
    const fromClient: CanvasSnapshot = {
      ...canvas([node("shot-1", { width: 560, height: 500 })]),
      viewport: { x: -120, y: 40, zoom: 0.76 }
    };

    const merged = mergeCanvasFromClient(onDisk, fromClient);

    expect(merged.nodes[0]?.width).toBe(560);
    expect(merged.nodes[0]?.height).toBe(500);
    expect(merged.viewport).toEqual({ x: -120, y: 40, zoom: 0.76 });
  });

  test("lets the client remove an edge it drew", () => {
    const onDisk = canvas(
      [node("a"), node("b")],
      [{ id: "e1", source: "a", target: "b" }]
    );
    // 两个端点 renderer 都认识，说明这条边它有权决定去留。
    const fromClient = canvas([node("a"), node("b")], []);

    expect(mergeCanvasFromClient(onDisk, fromClient).edges).toEqual([]);
  });
});

describe("deletions stay deleted", () => {
  test("does not resurrect a node the backend already removed", () => {
    // 删除走的是 deleteNodes，会把正文移进 .agent/trash。
    // 若合并时把 renderer 快照里的残影加回来，用户删掉的节点会自己长回来，
    // 而且它的正文文件已经不在原处了。
    const onDisk = canvas([node("a")]);
    const clientStillShowsBoth = canvas([node("a"), node("deleted-b")]);

    const merged = mergeCanvasFromClient(onDisk, clientStillShowsBoth);

    expect(merged.nodes.map((entry) => entry.id)).toEqual(["a"]);
  });

  test("drops edges pointing at a removed node", () => {
    const onDisk = canvas([node("a")]);
    const clientStillShowsBoth = canvas(
      [node("a"), node("deleted-b")],
      [{ id: "e1", source: "a", target: "deleted-b" }]
    );

    // 悬空的边会让画布持有指向不存在节点的引用。
    expect(mergeCanvasFromClient(onDisk, clientStillShowsBoth).edges).toEqual([]);
  });
});

describe("merge is safe to repeat", () => {
  test("merging an already-merged snapshot changes nothing", () => {
    const onDisk = canvas(
      [node("script-1", { kind: "script" }), node("shot-1")],
      [{ id: "e1", source: "script-1", target: "shot-1" }]
    );
    const fromClient = canvas([node("script-1", { kind: "script", position: { x: 10, y: 20 } })]);

    const once = mergeCanvasFromClient(onDisk, fromClient);
    const twice = mergeCanvasFromClient(once, once);

    expect(twice).toEqual(once);
  });
});

describe("the merged result survives a real write", () => {
  test("round-trips through disk without losing the new nodes", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "tvc-canvas-"));
    try {
      const onDisk = canvas(
        [node("script-1", { kind: "script" }), node("shot-1"), node("shot-2")],
        [{ id: "e1", source: "script-1", target: "shot-1" }]
      );
      const merged = mergeCanvasFromClient(onDisk, canvas([node("script-1", { kind: "script" })]));

      const path = join(projectRoot, "canvas.json");
      await writeAtomic(path, JSON.stringify(merged, null, 2));
      const reloaded = JSON.parse(readFileSync(path, "utf8")) as CanvasSnapshot;

      expect(reloaded.nodes).toHaveLength(3);
      expect(reloaded.edges).toHaveLength(1);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("the client write path goes through the merge", () => {
  test("project.saveCanvas does not overwrite the file directly", () => {
    // 这是修复的落点。若这里退回 projectService.saveCanvas，
    // 竞争会原样复现，而且症状隐蔽——只在后台并发写入时才出现。
    const utility = readFileSync(new URL("../src/utility/index.ts", import.meta.url), "utf8");
    const handler = /case "project\.saveCanvas":([\s\S]*?)case "/.exec(utility)?.[1] ?? "";
    expect(handler).toContain("saveCanvasFromClient");
  });

  test("the client adopts the merged result instead of its own snapshot", () => {
    // 只在服务端合并还不够：若 renderer 把本地快照推回 App state，
    // 磁盘是对的而界面是旧的——画布和 Agent 面板都看不见新节点。
    const workspace = readFileSync(
      new URL("../src/renderer/src/components/canvas-workspace.tsx", import.meta.url),
      "utf8"
    );
    const persistBody = /const persist = useCallback\(([\s\S]*?)\n  \);/.exec(workspace)?.[1] ?? "";
    expect(persistBody).toContain(".then(onCanvasChange)");
    // 修复前是先 onCanvasChange(next) 再保存，等于用旧快照覆盖界面状态。
    expect(persistBody).not.toContain("onCanvasChange(next)");
  });
});

describe("the deterministic failure, not just a rare race", () => {
  /**
   * 用户报告的现象是「每次都失败」，而竞态通常是偶发的。
   *
   * 原因：生成图片要十几秒，远超 260ms 防抖。这期间 React Flow 只要
   * 测量一次节点尺寸（挂载、缩放、鼠标经过都会触发 dimensions 变更）
   * 就会排一次保存，而它手里的列表里没有后台刚建的分镜节点。
   * 于是「生成耗时 > 防抖窗口」就等价于「必然被覆盖」。
   */
  test("survives a save that lands in the middle of generating several shots", () => {
    const script = node("script-1", { kind: "script" });
    // 防抖开始那一刻：只有脚本节点。
    const clientSnapshotAtDebounceStart = canvas([script]);

    // 后台逐个镜头创建节点，每次都写盘。
    let onDisk = canvas([script]);
    for (const shotId of ["shot-1", "shot-2", "shot-3"]) {
      onDisk = canvas(
        [...onDisk.nodes, node(shotId)],
        [...onDisk.edges, { id: `e-${shotId}`, source: "script-1", target: shotId }]
      );
    }

    // 防抖到期，旧快照抵达。
    const merged = mergeCanvasFromClient(onDisk, clientSnapshotAtDebounceStart);

    // 三个镜头都还在，后续 updateNodeStatus 才找得到它们。
    expect(merged.nodes.map((entry) => entry.id)).toEqual([
      "script-1",
      "shot-1",
      "shot-2",
      "shot-3"
    ]);
    expect(merged.edges).toHaveLength(3);
  });

  test("survives repeated saves during one generation run", () => {
    // 缩放、鼠标经过都会再触发一次保存，一次生成期间可能来好几发。
    const script = node("script-1", { kind: "script" });
    const stale = canvas([script]);
    let onDisk = canvas([script, node("shot-1")]);

    for (let index = 0; index < 5; index += 1) {
      onDisk = mergeCanvasFromClient(onDisk, stale);
    }

    expect(onDisk.nodes.map((entry) => entry.id)).toEqual(["script-1", "shot-1"]);
  });
});

describe("the error message when a node really is missing", () => {
  test("names the node and the canvas size", () => {
    // 原文案只有「找不到要更新的节点」：既看不出是哪个节点，
    // 也分不清是画布被覆盖了还是用户真把节点删了。
    const service = readFileSync(
      new URL("../src/utility/project-service.ts", import.meta.url),
      "utf8"
    );
    expect(service).toContain("找不到要更新的节点 ${nodeId}");
    expect(service).toContain("canvas.nodes.length");
  });
});
