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
  test("sums real money from the snapshot taken at submit time", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "completed");
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");
        const chain = jobs.chain(projectRoot, first.id);

        // Seedance 1080p 原价 ¥4.896/s × 8s = ¥39.17（无参考图）。
        expect(chain.totalCost).toBe(39.17);
        expect(chain.currency).toBe("CNY");
        expect(chain.totalBilledSeconds).toBe(8);
        expect(chain.attemptsMissingCost).toBe(0);
        expect(chain.costNote).toContain("¥39.17");
      } finally {
        orz.stop();
      }
    });
  });

  test("accumulates cost across every attempt that produced a video", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "completed");
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");
        await jobs.retry(projectRoot, first.id, "key");
        const chain = jobs.chain(projectRoot, first.id);

        // 两次都成功产出 → 两次都真实计费。重试不是免费的，
        // 归集整条链的成本正是重试链存在的理由之一。
        expect(chain.totalCost).toBe(78.34);
        expect(chain.totalBilledSeconds).toBe(16);
      } finally {
        orz.stop();
      }
    });
  });

  test("charges nothing for attempts that never produced a video", async () => {
    await withProject(async ({ projectRoot, service }) => {
      let succeed = false;
      const orz = serveOrz(() => (succeed ? "completed" : "failed"));
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");
        succeed = true;
        await jobs.retry(projectRoot, first.id, "key");
        const chain = jobs.chain(projectRoot, first.id);

        // 失败那次不该计费。算进去会让用户以为被多收了一次。
        expect(chain.totalCost).toBe(39.17);
        expect(chain.totalBilledSeconds).toBe(8);
      } finally {
        orz.stop();
      }
    });
  });

  test("has no cost at all when every attempt failed", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "failed");
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");
        await jobs.retry(projectRoot, first.id, "key");
        const chain = jobs.chain(projectRoot, first.id);

        expect(chain.totalCost).toBeNull();
        expect(chain.totalBilledSeconds).toBe(0);
      } finally {
        orz.stop();
      }
    });
  });

  test("still reports a partial total when an older attempt has no snapshot", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "completed");
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");
        const second = await jobs.retry(projectRoot, first.id, "key");

        // 模拟 migration 0003 之前产生的行：有结果，但没有估价快照。
        const db = new Database(join(projectRoot, ".agent", "index.sqlite"));
        db.prepare("UPDATE video_jobs SET estimate_json = NULL WHERE id = ?").run(first.id);
        db.close();

        const chain = jobs.chain(projectRoot, first.id);
        // 一条缺失不该让整个金额消失——那会让升级前有过重试的用户
        // 永远看不到任何金额。给出已知部分，并说清有几条没算。
        expect(chain.totalCost).toBe(39.17);
        expect(chain.attemptsMissingCost).toBe(1);
        expect(chain.costNote).toContain("1 次尝试缺少价格快照");
        expect(chain.attempts.map((entry) => entry.id)).toEqual([first.id, second.id]);
      } finally {
        orz.stop();
      }
    });
  });

  test("falls back to null only when no attempt has a snapshot", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "completed");
      try {
        const jobs = service(orz.baseUrl);
        const first = await jobs.submit(request(projectRoot), "key");

        const db = new Database(join(projectRoot, ".agent", "index.sqlite"));
        db.prepare("UPDATE video_jobs SET estimate_json = NULL").run();
        db.close();

        const chain = jobs.chain(projectRoot, first.id);
        expect(chain.totalCost).toBeNull();
        expect(chain.attemptsMissingCost).toBe(1);
        expect(chain.costNote).toContain("无可用金额快照");
        // 金额未知不代表秒数未知——秒数仍要如实报告。
        expect(chain.totalBilledSeconds).toBe(8);
      } finally {
        orz.stop();
      }
    });
  });

  test("bills the seconds the model actually generated, not the script duration", async () => {
    await withProject(async ({ projectRoot, service }) => {
      const orz = serveOrz(() => "completed");
      try {
        const jobs = service(orz.baseUrl);
        // Veo 固定输出 8 秒。脚本只要 5 秒，但 ORZ 按 8 秒计费。
        // 按 request.duration 汇总会少算 3 秒、少算 ¥62.21。
        await jobs.submit(
          { ...request(projectRoot), modelId: "google/veo-3-1", duration: 5, resolution: "720p" },
          "key"
        );
        const rows = new Database(join(projectRoot, ".agent", "index.sqlite"));
        const only = rows.prepare("SELECT id FROM video_jobs").get() as { id: string };
        rows.close();

        const chain = jobs.chain(projectRoot, only.id);
        expect(chain.totalBilledSeconds).toBe(8);
        expect(chain.totalCost).toBe(165.89);
      } finally {
        orz.stop();
      }
    });
  });
});
