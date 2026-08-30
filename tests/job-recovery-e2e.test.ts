import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService, type JobDatabase } from "../src/utility/job-service.js";
import { runMigrations, type MigrationRunnerDatabase } from "../src/utility/migrations.js";
import { isIsoBaseMediaFile } from "../src/utility/video-assets.js";
import type { VideoTaskState } from "../src/shared/video-task-states.js";

/** 真实 MP4 文件头，与 video-assets.test.ts 同源，不是为通过测试编造的字节。 */
const MP4_HEADER = new Uint8Array([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31
]);

interface OrzRequestLog {
  readonly method: string;
  readonly path: string;
}

/**
 * 起一个真实的 ORZ 网关替身。
 *
 * 不 mock fetch：恢复流程要经过 HTTP 状态码处理、JSON 解析、
 * 二进制下载与 MP4 校验，这些只有走真实网络栈才算验证过。
 * 同时记录收到的每一个请求，用于断言恢复期间绝不提交新的生成任务。
 */
const serveOrz = (
  taskResponse: () => Record<string, unknown>
): { baseUrl: string; requests: OrzRequestLog[]; stop: () => void } => {
  const requests: OrzRequestLog[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      requests.push({ method: request.method, path: pathname });
      if (pathname.endsWith(".mp4")) {
        return new Response(MP4_HEADER, { headers: { "content-type": "video/mp4" } });
      }
      if (pathname.startsWith("/tasks/")) {
        return Response.json(taskResponse());
      }
      return new Response("unexpected call", { status: 500 });
    }
  });
  return {
    baseUrl: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true)
  };
};

const withProject = async <T>(
  run: (context: {
    projectRoot: string;
    database: Database;
    service: (baseUrl: string) => JobService;
  }) => Promise<T>
): Promise<T> => {
  const projectRoot = mkdtempSync(join(tmpdir(), "tvc-recover-"));
  mkdirSync(join(projectRoot, ".agent"), { recursive: true });
  const databasePath = join(projectRoot, ".agent", "index.sqlite");
  const database = new Database(databasePath);
  runMigrations(database as unknown as MigrationRunnerDatabase);
  try {
    // 注入 bun:sqlite：better-sqlite3 的原生模块按 Electron ABI 编译，
    // 在 bun 下加载即崩溃。这里用的仍是真实 SQLite 引擎与真实磁盘文件。
    //
    // 每次调用新开一个连接，与生产代码逐次 open/close 的行为一致——
    // 若复用同一个连接，服务关闭它之后后续操作都会失败。
    const openDatabase = (path: string): JobDatabase =>
      new Database(path) as unknown as JobDatabase;
    return await run({
      projectRoot,
      database,
      service: (baseUrl) => new JobService(baseUrl, openDatabase)
    });
  } finally {
    database.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
};

const insertJob = (
  database: Database,
  job: { id: string; state: VideoTaskState; providerTaskId: string | null }
): void => {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO video_jobs (
         id, provider_task_id, model_id, state, progress, stage, output_urls_json,
         local_paths_json, shot_id, request_json, error_json, created_at, updated_at, revision
       ) VALUES (?, ?, ?, ?, NULL, NULL, '[]', '[]', 'shot-1', '{}', NULL, ?, ?, 0)`
    )
    .run(job.id, job.providerTaskId, "bytedance/seedance-2", job.state, now, now);
};

describe("recovering interrupted jobs on project open", () => {
  test("persists the video to disk when ORZ finished it while the app was closed", async () => {
    await withProject(async ({ projectRoot, database, service }) => {
      const orz = serveOrz(() => ({
        task_id: "task-1",
        status: "completed",
        output: { items: [{ url: `${orz.baseUrl}/result.mp4` }] }
      }));
      try {
        insertJob(database, { id: "job-1", state: "generating", providerTaskId: "task-1" });

        const result = await service(orz.baseUrl).recoverInterrupted(projectRoot, "key-1");

        // 这是本项验收的核心：任务在服务端早已完成，恢复时必须把字节
        // 真正写进项目目录，而不是直接置 completed 只留一个会过期的 URL。
        const job = result.recovered[0];
        expect(job?.state).toBe("completed");
        expect(job?.localPaths).toEqual(["assets/videos/job-1/0.mp4"]);
        const written = new Uint8Array(readFileSync(join(projectRoot, "assets/videos/job-1/0.mp4")));
        expect(isIsoBaseMediaFile(written)).toBe(true);
        expect(written.byteLength).toBe(MP4_HEADER.byteLength);
      } finally {
        orz.stop();
      }
    });
  });

  test("never submits a new generation while recovering", async () => {
    await withProject(async ({ projectRoot, database, service }) => {
      const orz = serveOrz(() => ({
        task_id: "task-2",
        status: "completed",
        output: { items: [{ url: `${orz.baseUrl}/result.mp4` }] }
      }));
      try {
        insertJob(database, { id: "job-2", state: "generating", providerTaskId: "task-2" });

        await service(orz.baseUrl).recoverInterrupted(projectRoot, "key-1");

        // 重新生成会产生一次用户没有授权的真实计费。
        // 恢复只允许 GET 查询与下载产物。
        expect(orz.requests.some((entry) => entry.path.includes("/videos/generations"))).toBe(false);
        expect(orz.requests.every((entry) => entry.method === "GET")).toBe(true);
      } finally {
        orz.stop();
      }
    });
  });

  test("keeps tracking a job that is still running on the server", async () => {
    await withProject(async ({ projectRoot, database, service }) => {
      const orz = serveOrz(() => ({ task_id: "task-3", status: "running", progress: 0.4 }));
      try {
        insertJob(database, { id: "job-3", state: "generating", providerTaskId: "task-3" });

        const result = await service(orz.baseUrl).recoverInterrupted(projectRoot, "key-1");

        expect(result.recovered[0]?.state).toBe("generating");
        expect(result.recovered[0]?.progress).toBe(0.4);
      } finally {
        orz.stop();
      }
    });
  });

  test("fails a job whose submit never reached ORZ, and does not call out for it", async () => {
    await withProject(async ({ projectRoot, database, service }) => {
      const orz = serveOrz(() => ({ task_id: "unused", status: "completed" }));
      try {
        insertJob(database, { id: "job-4", state: "uploading", providerTaskId: null });

        const result = await service(orz.baseUrl).recoverInterrupted(projectRoot, "key-1");

        expect(result.failed[0]?.state).toBe("failed");
        expect(result.failed[0]?.error?.retryable).toBe(true);
        // 没有 task id 可查，也不该猜一个去问。
        expect(orz.requests).toEqual([]);
      } finally {
        orz.stop();
      }
    });
  });

  test("reports every recovered job as it is decided", async () => {
    await withProject(async ({ projectRoot, database, service }) => {
      const orz = serveOrz(() => ({ task_id: "task-5", status: "running" }));
      try {
        insertJob(database, { id: "job-5", state: "generating", providerTaskId: "task-5" });
        insertJob(database, { id: "job-6", state: "uploading", providerTaskId: null });

        const seen: string[] = [];
        await service(orz.baseUrl).recoverInterrupted(projectRoot, "key-1", (job) => seen.push(job.id));

        // UI 靠这些推送更新，漏掉任何一条都会让任务在界面上失联。
        expect(seen.sort()).toEqual(["job-5", "job-6"]);
      } finally {
        orz.stop();
      }
    });
  });

  test("holds jobs at interrupted instead of guessing when no key is configured", async () => {
    await withProject(async ({ projectRoot, database, service }) => {
      const orz = serveOrz(() => ({ task_id: "task-7", status: "completed" }));
      try {
        insertJob(database, { id: "job-7", state: "generating", providerTaskId: "task-7" });

        const result = await service(orz.baseUrl).recoverInterrupted(projectRoot, null);

        expect(result.interrupted[0]?.state).toBe("interrupted");
        expect(result.recovered).toEqual([]);
        expect(orz.requests).toEqual([]);
      } finally {
        orz.stop();
      }
    });
  });

  test("does not leave a half-written file when the download returns an error page", async () => {
    await withProject(async ({ projectRoot, database, service }) => {
      // 处理函数只会在 serve 返回之后被调用，因此这里赋值不存在竞态。
      let origin = "";
      const server = Bun.serve({
        port: 0,
        fetch(request): Response {
          const { pathname } = new URL(request.url);
          if (pathname.endsWith(".mp4")) {
            // 网关异常时返回 HTML 而非视频，是真实发生过的故障形态。
            return new Response("<!DOCTYPE html><html>502</html>", {
              headers: { "content-type": "text/html" }
            });
          }
          return Response.json({
            task_id: "task-8",
            status: "completed",
            output: { items: [{ url: `${origin}/result.mp4` }] }
          });
        }
      });
      origin = `http://localhost:${server.port}`;
      try {
        insertJob(database, { id: "job-8", state: "generating", providerTaskId: "task-8" });

        const result = await service(origin).recoverInterrupted(projectRoot, "key-1");

        // 落盘失败就不能算完成，否则用户会拿到一个无法播放的 .mp4。
        expect(result.recovered[0]?.state).toBe("failed");
        expect(result.recovered[0]?.error?.retryable).toBe(true);
        expect(existsSync(join(projectRoot, "assets/videos/job-8/0.mp4"))).toBe(false);
      } finally {
        server.stop(true);
      }
    });
    // 下载失败会真实退避重试 4 次（1.5 + 3 + 4.5 秒）。
    // 这里放宽超时而不是调小重试次数：瞬时故障是网关的常态，
    // 为了让测试跑得快就削弱生产重试，等于拿真实可靠性换测试时长。
  }, 20_000);
});
