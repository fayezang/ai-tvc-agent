import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations, type MigrationRunnerDatabase } from "../src/utility/migrations.js";
import {
  findDanglingJobs,
  triageDanglingJobs,
  type RecoveryDatabase
} from "../src/utility/job-recovery.js";
import type { VideoTaskState } from "../src/shared/video-task-states.js";

/**
 * 与 migrations.test.ts 同样使用 bun:sqlite：better-sqlite3 的原生模块
 * 按 Electron ABI 编译，在 bun 下加载即崩溃（SIGKILL）。
 * 这里跑的是真实 DDL、真实事务、真实磁盘文件，没有 mock。
 */
const withDatabase = <T>(run: (database: Database) => T): T => {
  const directory = mkdtempSync(join(tmpdir(), "tvc-recovery-"));
  const database = new Database(join(directory, "index.sqlite"));
  try {
    runMigrations(database as unknown as MigrationRunnerDatabase);
    return run(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

const asRecovery = (database: Database): RecoveryDatabase =>
  database as unknown as RecoveryDatabase;

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
       ) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?, '{}', NULL, ?, ?, 0)`
    )
    .run(job.id, job.providerTaskId, "bytedance/seedance-2", job.state, null, null, "shot-1", now, now);
};

const readJob = (
  database: Database,
  id: string
): { state: VideoTaskState; stage: string | null; error_json: string | null; revision: number } =>
  database.prepare("SELECT state, stage, error_json, revision FROM video_jobs WHERE id = ?").get(id) as {
    state: VideoTaskState;
    stage: string | null;
    error_json: string | null;
    revision: number;
  };

describe("finding dangling jobs", () => {
  test("picks up every state that was mid-flight when the app exited", () => {
    withDatabase((database) => {
      insertJob(database, { id: "uploading", state: "uploading", providerTaskId: null });
      insertJob(database, { id: "queued", state: "queued", providerTaskId: "t-1" });
      insertJob(database, { id: "generating", state: "generating", providerTaskId: "t-2" });
      insertJob(database, { id: "downloading", state: "downloading", providerTaskId: "t-3" });
      insertJob(database, { id: "validating", state: "validating", providerTaskId: "t-4" });

      const dangling = findDanglingJobs(asRecovery(database)).map((row) => row.id);
      expect(dangling.sort()).toEqual(
        ["downloading", "generating", "queued", "uploading", "validating"].sort()
      );
    });
  });

  test("leaves finished jobs alone", () => {
    withDatabase((database) => {
      for (const state of ["completed", "failed", "canceled", "expired"] as const) {
        insertJob(database, { id: state, state, providerTaskId: `t-${state}` });
      }

      expect(findDanglingJobs(asRecovery(database))).toEqual([]);
    });
  });

  test("leaves pre-submit jobs alone", () => {
    withDatabase((database) => {
      // 第三批的确认面板会产生这两态。它们在服务端并不存在，
      // 若被当成悬空任务就会被误判为失败，用户的草稿平白消失。
      insertJob(database, { id: "draft", state: "draft", providerTaskId: null });
      insertJob(database, { id: "awaiting", state: "awaiting-approval", providerTaskId: null });

      expect(findDanglingJobs(asRecovery(database))).toEqual([]);
    });
  });
});

describe("triaging dangling jobs", () => {
  test("routes jobs with a provider task id to recovering", () => {
    withDatabase((database) => {
      insertJob(database, { id: "job-1", state: "generating", providerTaskId: "task-1" });

      const result = triageDanglingJobs(asRecovery(database), { canQueryProvider: true });

      expect(result.recovering).toEqual(["job-1"]);
      expect(result.failed).toEqual([]);
      expect(readJob(database, "job-1").state).toBe("recovering");
    });
  });

  test("fails jobs that crashed before ORZ ever acknowledged them", () => {
    withDatabase((database) => {
      // 没有 provider_task_id 意味着提交请求没拿到回执。
      // 服务端不存在这个任务，查询无从查起。
      insertJob(database, { id: "job-2", state: "uploading", providerTaskId: null });

      const result = triageDanglingJobs(asRecovery(database), { canQueryProvider: true });

      expect(result.failed).toEqual(["job-2"]);
      const row = readJob(database, "job-2");
      expect(row.state).toBe("failed");
      const error = JSON.parse(row.error_json ?? "null") as { retryable: boolean; message: string };
      // 必须可重试：这次失败不是模型的问题，重新提交完全合理。
      expect(error.retryable).toBe(true);
      expect(error.message).toContain("服务端没有这个任务");
    });
  });

  test("holds jobs at interrupted when there is no key to query with", () => {
    withDatabase((database) => {
      insertJob(database, { id: "job-3", state: "generating", providerTaskId: "task-3" });

      const result = triageDanglingJobs(asRecovery(database), { canQueryProvider: false });

      // 不能写成 recovering：没有任何查询正在进行，
      // 那会是一个凭空捏造的进行中状态。
      expect(result.interrupted).toEqual(["job-3"]);
      expect(result.recovering).toEqual([]);
      expect(readJob(database, "job-3").state).toBe("interrupted");
    });
  });

  test("marks interrupted before deciding, so a second crash still tells the truth", () => {
    withDatabase((database) => {
      insertJob(database, { id: "job-4", state: "generating", providerTaskId: "task-4" });

      triageDanglingJobs(asRecovery(database), { canQueryProvider: true });

      // 分诊过程本身也可能被中断。每一步都落库，因此
      // revision 至少推进两次：generating → interrupted → recovering。
      expect(readJob(database, "job-4").revision).toBeGreaterThanOrEqual(2);
    });
  });

  test("is idempotent across repeated launches", () => {
    withDatabase((database) => {
      insertJob(database, { id: "job-5", state: "generating", providerTaskId: "task-5" });
      insertJob(database, { id: "job-6", state: "uploading", providerTaskId: null });

      triageDanglingJobs(asRecovery(database), { canQueryProvider: true });
      const second = triageDanglingJobs(asRecovery(database), { canQueryProvider: true });

      // 判失败的那条已到终态，第二次不该再被捡起来。
      expect(second.failed).toEqual([]);
      // recovering 仍是非终态，重启后理应继续恢复。
      expect(second.recovering).toEqual(["job-5"]);
    });
  });

  test("never issues a generation request", () => {
    // 恢复的全部意义是把已经付过的钱拿回来。
    // 若这里重新提交，用户会为同一个镜头被计费两次。
    const source = readFileSync(new URL("../src/utility/job-recovery.ts", import.meta.url), "utf8");
    expect(source).not.toContain("submitVideo");
    expect(source).not.toContain("generations");
    expect(source).not.toContain("fetch(");
  });
});
