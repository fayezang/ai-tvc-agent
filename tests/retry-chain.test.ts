import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobService, type JobDatabase } from "../src/utility/job-service.js";
import { runMigrations, type MigrationRunnerDatabase } from "../src/utility/migrations.js";
import type { VideoGenerationRequest } from "../src/shared/contracts.js";

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
  resolution: "1080p",
  referenceImageUrls: [],
  referenceVideoUrls: [],
  referenceAudioUrls: [],
  generateAudio: true
});

/**
 * ORZ 网关替身。每次提交返回一个新的 task id，
 * 由 outcome 决定这一次尝试是成功还是失败。
 */
const serveOrz = (
  outcome: () => "completed" | "failed"
): { baseUrl: string; stop: () => void } => {
  let submitted = 0;
  let origin = "";
  const server = Bun.serve({
    port: 0,
    fetch(req): Response {
      const { pathname } = new URL(req.url);
      if (pathname.endsWith(".mp4")) {
        return new Response(MP4_HEADER, { headers: { "content-type": "video/mp4" } });
      }
      if (pathname.endsWith("/videos/generations")) {
        submitted += 1;
        const state = outcome();
        return Response.json(
          state === "completed"
            ? {
                task_id: `task-${submitted}`,
                status: "completed",
                output: { items: [{ url: `${origin}/result-${submitted}.mp4` }] }
              }
            : {
                task_id: `task-${submitted}`,
                status: "failed",
                error: { code: "MODEL_ERROR", message: "模型生成失败", retryable: true }
              }
        );
      }
      return new Response("unexpected", { status: 500 });
    }
  });
  origin = `http://localhost:${server.port}`;
  return { baseUrl: origin, stop: () => server.stop(true) };
};

const withProject = async <T>(
  run: (context: { projectRoot: string; service: (baseUrl: string) => JobService }) => Promise<T>
): Promise<T> => {
  const projectRoot = mkdtempSync(join(tmpdir(), "tvc-chain-"));
  mkdirSync(join(projectRoot, ".agent"), { recursive: true });
  const setup = new Database(join(projectRoot, ".agent", "index.sqlite"));
  runMigrations(setup as unknown as MigrationRunnerDatabase);
  setup.close();
  try {
    return await run({
      projectRoot,
      service: (baseUrl) =>
        new JobService(baseUrl, (path) => new Database(path) as unknown as JobDatabase)
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
};

describe("retry chains", () => {
  test("keeps the original row and links the new attempt to it", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "failed");
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");
        const second = await jobs.retry(projectRoot, first.id, "key");

        // 原行必须保留：它记录着那次尝试真实发生过、失败在哪一步。
        // 旧实现直接新建 jobId 且旧行残留但毫无关联，用户看到两条孤立记录。
        expect(jobs.get(projectRoot, first.id).id).toBe(first.id);
        expect(second.id).not.toBe(first.id);
        expect(second.parentJobId).toBe(first.id);
        expect(second.rootJobId).toBe(first.id);
        expect(second.attempt).toBe(2);
      } finally {
        orz.stop();
      }
    });
  });

  test("a first submit is its own chain root", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "failed");
      try {
        const first = await service(orz.baseUrl).submit(request(projectRoot), "key");

        // 不等到第一次重试才建立链身份，否则单次任务查链时会落空。
        expect(first.parentJobId).toBeNull();
        expect(first.rootJobId).toBe(first.id);
        expect(first.attempt).toBe(1);
      } finally {
        orz.stop();
      }
    });
  });

  test("every attempt in a long chain shares one root", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "failed");
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");
        const second = await jobs.retry(projectRoot, first.id, "key");
        const third = await jobs.retry(projectRoot, second.id, "key");

        expect([second.rootJobId, third.rootJobId]).toEqual([first.id, first.id]);
        expect([first.attempt, second.attempt, third.attempt]).toEqual([1, 2, 3]);

        const chain = jobs.chain(projectRoot, third.id);
        expect(chain.attempts.map((entry) => entry.id)).toEqual([first.id, second.id, third.id]);
      } finally {
        orz.stop();
      }
    });
  });

  test("retrying from an older attempt does not reuse an attempt number", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "failed");
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");
        await jobs.retry(projectRoot, first.id, "key"); // attempt 2
        // 用户完全可能从链里更早的一次失败发起重试。
        // 若按父任务的 attempt 加一，这里会重号成 2。
        const third = await jobs.retry(projectRoot, first.id, "key");

        expect(third.attempt).toBe(3);
        expect(third.parentJobId).toBe(first.id);
        const chain = jobs.chain(projectRoot, first.id);
        const numbers = chain.attempts.map((entry) => entry.attempt);
        expect(new Set(numbers).size).toBe(numbers.length);
      } finally {
        orz.stop();
      }
    });
  });

  test("the chain can be queried from any attempt in it", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "failed");
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");
        const second = await jobs.retry(projectRoot, first.id, "key");

        // 从根查和从末端查必须得到同一条链。
        expect(jobs.chain(projectRoot, first.id).attempts).toHaveLength(2);
        expect(jobs.chain(projectRoot, second.id).rootJobId).toBe(first.id);
      } finally {
        orz.stop();
      }
    });
  });

  test("keeps unrelated jobs out of the chain", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "failed");
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");
        await jobs.retry(projectRoot, first.id, "key");
        // 另一个镜头的任务，与上面那条链无关。
        const unrelated = await jobs.submit(request(projectRoot), "key");

        const chain = jobs.chain(projectRoot, first.id);
        expect(chain.attempts.map((entry) => entry.id)).not.toContain(unrelated.id);
        expect(jobs.chain(projectRoot, unrelated.id).attempts).toHaveLength(1);
      } finally {
        orz.stop();
      }
    });
  });
});

describe("chain cost accounting", () => {
  test("counts billed seconds only for attempts that produced a video", async () => {
    await withProject(async ({ projectRoot, service }) => {
      let succeed = false;
      const orz = serveOrz(() => (succeed ? "completed" : "failed"));
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");
        succeed = true;
        const second = await jobs.retry(projectRoot, first.id, "key");

        expect(second.state).toBe("completed");
        const chain = jobs.chain(projectRoot, first.id);
        // 只有成功那次产生计费。把失败的尝试也算进去会虚高整条链的用量。
        expect(chain.totalBilledSeconds).toBe(8);
        expect(chain.attempts).toHaveLength(2);
      } finally {
        orz.stop();
      }
    });
  });

  test("reports zero seconds when every attempt failed", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "failed");
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");
        await jobs.retry(projectRoot, first.id, "key");

        expect(jobs.chain(projectRoot, first.id).totalBilledSeconds).toBe(0);
      } finally {
        orz.stop();
      }
    });
  });

  test("refuses to invent a price before the rate table exists", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "completed");
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");
        const chain = jobs.chain(projectRoot, first.id);

        // 价格表属第三批。在它接入之前给出金额，等于按猜测的单价
        // 告诉用户他花了多少钱——比不给更糟。
        expect(chain.totalCost).toBeNull();
        expect(chain.currency).toBe("CNY");
        expect(chain.costNote).toContain("秒");
        expect(chain.totalBilledSeconds).toBe(8);
      } finally {
        orz.stop();
      }
    });
  });
});
