import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 删除节点时的磁盘清理。
 *
 * 此前删除只修改 canvas.json，nodes/*.md 与分镜 manifest 会永久残留，
 * 项目目录随使用不断累积无主文件。
 *
 * ProjectService 依赖 better-sqlite3，其原生模块由 electron-builder 针对
 * Electron ABI 编译，在 bun/node 下加载即崩溃，无法在测试中实例化。
 * 因此这里对不依赖数据库的文件系统语义做真实验证：真实目录、真实文件、
 * 真实 rename，配合源码断言锁定行为契约。
 */

const withProject = async <T>(run: (projectRoot: string) => Promise<T>): Promise<T> => {
  const projectRoot = mkdtempSync(join(tmpdir(), "tvc-delete-"));
  try {
    return await run(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
};

/** 复刻 deleteNodes 的回收逻辑，用于验证文件系统语义。 */
const moveToTrash = async (
  projectRoot: string,
  relativePaths: readonly string[],
  stamp: string
): Promise<string[]> => {
  const { rename } = await import("node:fs/promises");
  const moved: string[] = [];
  for (const relativePath of relativePaths) {
    const source = join(projectRoot, relativePath);
    if (!existsSync(source)) continue;
    const destination = join(projectRoot, ".agent", "trash", stamp, relativePath);
    await mkdir(join(destination, ".."), { recursive: true });
    await rename(source, destination);
    moved.push(join(".agent", "trash", stamp, relativePath));
  }
  return moved;
};

describe("node deletion cleans the disk", () => {
  test("moves the node body out of nodes/ and into the trash", async () => {
    await withProject(async (projectRoot) => {
      await mkdir(join(projectRoot, "nodes"), { recursive: true });
      await writeFile(join(projectRoot, "nodes/script-v1.md"), "# 脚本 V1\n", "utf8");

      const moved = await moveToTrash(projectRoot, ["nodes/script-v1.md"], "2026-08-30T00-00-00");

      // 原位置必须消失，否则下次索引重建会把已删节点找回来。
      expect(existsSync(join(projectRoot, "nodes/script-v1.md"))).toBe(false);
      expect(moved).toHaveLength(1);
      // 内容必须完好，删除是可恢复操作而非销毁。
      expect(readFileSync(join(projectRoot, moved[0]!), "utf8")).toBe("# 脚本 V1\n");
    });
  });

  test("also removes the storyboard manifest that belongs to the node", async () => {
    await withProject(async (projectRoot) => {
      await mkdir(join(projectRoot, "nodes"), { recursive: true });
      await mkdir(join(projectRoot, "assets/storyboards/nodes"), { recursive: true });
      await writeFile(join(projectRoot, "nodes/frame.md"), "frame", "utf8");
      await writeFile(join(projectRoot, "assets/storyboards/nodes/node-1.json"), "{}", "utf8");

      const moved = await moveToTrash(
        projectRoot,
        ["nodes/frame.md", "assets/storyboards/nodes/node-1.json"],
        "2026-08-30T00-00-01"
      );

      expect(moved).toHaveLength(2);
      expect(existsSync(join(projectRoot, "assets/storyboards/nodes/node-1.json"))).toBe(false);
    });
  });

  test("tolerates a node whose files were already gone", async () => {
    await withProject(async (projectRoot) => {
      // 用户可能已在 Finder 里删过文件；删除节点不应因此报错。
      const moved = await moveToTrash(projectRoot, ["nodes/missing.md"], "2026-08-30T00-00-02");
      expect(moved).toEqual([]);
    });
  });

  test("keeps separate deletions apart by timestamp", async () => {
    await withProject(async (projectRoot) => {
      await mkdir(join(projectRoot, "nodes"), { recursive: true });
      await writeFile(join(projectRoot, "nodes/a.md"), "first", "utf8");
      await moveToTrash(projectRoot, ["nodes/a.md"], "2026-08-30T00-00-03");

      // 同名节点再次出现并被删除时，不能覆盖上一次的回收内容。
      await writeFile(join(projectRoot, "nodes/a.md"), "second", "utf8");
      await moveToTrash(projectRoot, ["nodes/a.md"], "2026-08-30T00-00-04");

      const batches = readdirSync(join(projectRoot, ".agent/trash")).sort();
      expect(batches).toEqual(["2026-08-30T00-00-03", "2026-08-30T00-00-04"]);
      expect(readFileSync(join(projectRoot, ".agent/trash/2026-08-30T00-00-03/nodes/a.md"), "utf8")).toBe(
        "first"
      );
    });
  });
});

describe("source guarantees", () => {
  const projectService = readFileSync(
    new URL("../src/utility/project-service.ts", import.meta.url),
    "utf8"
  );
  const canvasWorkspace = readFileSync(
    new URL("../src/renderer/src/components/canvas-workspace.tsx", import.meta.url),
    "utf8"
  );

  test("deleteNodes drops dangling edges along with the node", () => {
    // 保留指向已删节点的边会让画布持有无效引用。
    expect(projectService).toContain("async deleteNodes(");
    expect(projectService).toContain("!targets.has(edge.source) && !targets.has(edge.target)");
  });

  test("deleteNodes recycles files instead of destroying them", () => {
    expect(projectService).toContain(".agent");
    expect(projectService).toContain("trash");
    expect(projectService).toContain("movedToTrash");
  });

  test("deleteNodes clears the search index entry", () => {
    // 索引残留会让已删节点继续出现在 Agent 的上下文里。
    expect(projectService).toContain("db.delete(indexedNodes)");
  });

  test("the canvas routes removals through the main process", () => {
    // 仅本地 applyNodeChanges 会让磁盘文件永久残留。
    expect(canvasWorkspace).toContain(".deleteNodes({ projectRoot: project.rootPath, nodeIds: removedIds })");
    expect(canvasWorkspace).toContain('change.type === "remove"');
  });
});
