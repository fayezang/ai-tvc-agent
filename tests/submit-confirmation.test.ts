import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VideoGenerationRequest } from "../src/shared/contracts.js";
import { JobService, type JobDatabase } from "../src/utility/job-service.js";
import { runMigrations, type MigrationRunnerDatabase } from "../src/utility/migrations.js";
import { triageDanglingJobs } from "../src/utility/job-recovery.js";

const MP4_HEADER = new Uint8Array([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31
]);

const request = (projectRoot: string): VideoGenerationRequest => ({
  projectRoot,
  shotId: "shot-1",
  role: "other",
  modelId: "bytedance/seedance-2",
  prompt: "一只猫跳上窗台",
  duration: 8,
  aspectRatio: "9:16",
  resolution: "720p",
  referenceImageUrls: ["https://example.com/frame.png"],
  referenceVideoUrls: [],
  referenceAudioUrls: [],
  generateAudio: true
});

const withProject = async <T>(
  run: (context: { projectRoot: string; createService: (baseUrl: string) => JobService }) => Promise<T>
): Promise<T> => {
  const projectRoot = mkdtempSync(join(tmpdir(), "tvc-confirm-"));
  mkdirSync(join(projectRoot, ".agent"), { recursive: true });
  const setup = new Database(join(projectRoot, ".agent", "index.sqlite"));
  runMigrations(setup as unknown as MigrationRunnerDatabase);
  setup.close();
  try {
    return await run({
      projectRoot,
      createService: (baseUrl) => new JobService(baseUrl, (path) => new Database(path) as unknown as JobDatabase)
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
};

const serveOrz = (): { baseUrl: string; requests: () => number; stop: () => void } => {
  let count = 0;
  let origin = "";
  const server = Bun.serve({
    port: 0,
    fetch(req): Response {
      const { pathname } = new URL(req.url);
      count += 1;
      if (pathname.endsWith(".mp4")) return new Response(MP4_HEADER, { headers: { "content-type": "video/mp4" } });
      if (pathname.endsWith("/videos/generations")) {
        return Response.json({
          task_id: "task-1",
          status: "completed",
          output: { items: [{ url: `${origin}/result.mp4` }] }
        });
      }
      return new Response("unexpected", { status: 500 });
    }
  });
  origin = `http://localhost:${server.port}`;
  return { baseUrl: origin, requests: () => count, stop: () => server.stop(true) };
};

describe("submit confirmation", () => {
  test("prepare creates an awaiting-approval row without contacting ORZ", async () => {
    await withProject(async ({ projectRoot, createService }) => {
      const orz = serveOrz();
      try {
        const service = createService(orz.baseUrl);
        const prepared = service.prepare(request(projectRoot));

        expect(orz.requests()).toBe(0);
        expect(prepared.job.state).toBe("awaiting-approval");
        expect(prepared.job.providerTaskId).toBeNull();
        expect(prepared.estimate.amount).toBe(10.37);
        expect(prepared.estimate.discounted).toBe(true);
      } finally {
        orz.stop();
      }
    });
  });

  test("approve is the only action that contacts ORZ", async () => {
    await withProject(async ({ projectRoot, createService }) => {
      const orz = serveOrz();
      try {
        const service = createService(orz.baseUrl);
        const prepared = service.prepare(request(projectRoot));
        expect(orz.requests()).toBe(0);

        const job = await service.approve(projectRoot, prepared.job.id, "key");
        // 一次提交 + 一次下载，说明真正花钱的请求只发生在确认之后。
        expect(orz.requests()).toBe(2);
        expect(job.state).toBe("completed");
        expect(job.providerTaskId).toBe("task-1");
      } finally {
        orz.stop();
      }
    });
  });

  test("discard never contacts ORZ and leaves an auditable canceled row", async () => {
    await withProject(async ({ projectRoot, createService }) => {
      const orz = serveOrz();
      try {
        const service = createService(orz.baseUrl);
        const prepared = service.prepare(request(projectRoot));
        const discarded = service.discard(projectRoot, prepared.job.id);

        expect(orz.requests()).toBe(0);
        expect(discarded.state).toBe("canceled");
        expect(discarded.stage).toContain("未提交");
      } finally {
        orz.stop();
      }
    });
  });

  test("refuses to approve the same prepared job twice", async () => {
    await withProject(async ({ projectRoot, createService }) => {
      const orz = serveOrz();
      try {
        const service = createService(orz.baseUrl);
        const prepared = service.prepare(request(projectRoot));
        await service.approve(projectRoot, prepared.job.id, "key");
        await expect(service.approve(projectRoot, prepared.job.id, "key")).rejects.toThrow("只有等待确认");
        // 第二次没有再次请求 ORZ，避免双扣费。
        expect(orz.requests()).toBe(2);
      } finally {
        orz.stop();
      }
    });
  });

  test("does not recover an awaiting-approval job after restart", async () => {
    await withProject(async ({ projectRoot, createService }) => {
      const orz = serveOrz();
      try {
        const service = createService(orz.baseUrl);
        const prepared = service.prepare(request(projectRoot));
        const db = new Database(join(projectRoot, ".agent", "index.sqlite"));
        const triage = triageDanglingJobs(db as unknown as Parameters<typeof triageDanglingJobs>[0], { canQueryProvider: true });
        const row = db.prepare("SELECT state FROM video_jobs WHERE id = ?").get(prepared.job.id) as { state: string };
        db.close();

        expect(triage.recovering).toEqual([]);
        expect(triage.failed).toEqual([]);
        expect(row.state).toBe("awaiting-approval");
        expect(orz.requests()).toBe(0);
      } finally {
        orz.stop();
      }
    });
  });

  test("two pending retries receive distinct attempt numbers and neither contacts ORZ", async () => {
    await withProject(async ({ projectRoot, createService }) => {
      const orz = serveOrz();
      try {
        const service = createService(orz.baseUrl);
        // 先造一个历史失败行；兼容路径只用于此测试准备数据。
        const original = await service.submit(request(projectRoot), "key");
        const firstRetry = service.retry(projectRoot, original.id);
        const secondRetry = service.retry(projectRoot, original.id);

        expect(firstRetry.job.state).toBe("awaiting-approval");
        expect(secondRetry.job.state).toBe("awaiting-approval");
        expect([firstRetry.job.attempt, secondRetry.job.attempt]).toEqual([2, 3]);
        // 原 submit 会有两次请求；两次 retry prepare 追加的请求数必须为零。
        expect(orz.requests()).toBe(2);
      } finally {
        orz.stop();
      }
    });
  });
});
