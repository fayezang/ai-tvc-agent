import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrations,
  runMigrations,
  SCHEMA_MIGRATIONS_TABLE,
  type MigrationRunnerDatabase
} from "../src/utility/migrations.js";

/**
 * 用 `bun:sqlite` 而非 `better-sqlite3` 执行本套测试。
 *
 * 生产代码在 Electron 内使用 better-sqlite3，但其原生模块由
 * `electron-builder install-app-deps` 针对 Electron ABI 编译，
 * 在 bun / node 运行时加载会直接崩溃（SIGKILL），无法用于测试。
 *
 * `runMigrations` 接受最小接口 MigrationRunnerDatabase 而非具体驱动，
 * 因此可以换用同为真实 SQLite 引擎的 bun:sqlite 验证。
 * 这里执行的是真实 DDL、真实事务、真实磁盘文件，没有任何 mock。
 */
const withDatabase = <T>(run: (database: Database) => T): T => {
  const directory = mkdtempSync(join(tmpdir(), "tvc-migration-"));
  const database = new Database(join(directory, "index.sqlite"));
  try {
    return run(database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
};

const asRunner = (database: Database): MigrationRunnerDatabase =>
  database as unknown as MigrationRunnerDatabase;

const tableNames = (database: Database): string[] =>
  (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>).map((row) => row.name);

describe("schema migrations", () => {
  test("builds the full schema from an empty database", () => {
    withDatabase((database) => {
      const executed = runMigrations(asRunner(database));

      expect(executed).toEqual(migrations.map((migration) => migration.id));
      const tables = tableNames(database);
      for (const expected of ["indexed_nodes", "video_jobs", "agent_transactions"]) {
        expect(tables, expected).toContain(expected);
      }
      expect(tables).toContain(SCHEMA_MIGRATIONS_TABLE);
    });
  });

  test("creates every column the services read and write", () => {
    withDatabase((database) => {
      runMigrations(asRunner(database));

      const columns = (table: string): string[] =>
        (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (row) => row.name
        );

      expect(columns("video_jobs")).toEqual([
        "id",
        "provider_task_id",
        "model_id",
        "state",
        "progress",
        "stage",
        "output_urls_json",
        "selected_output_url",
        "request_json",
        "error_json",
        "created_at",
        "updated_at",
        "revision",
        // 0001 追加：视频必须落盘，远程 CDN 链接有时效，不能作为唯一资产。
        "local_paths_json",
        "shot_id",
        // 0002 追加：重试链。旧实现每次重试新建一行且与原行毫无关联，
        // 用户看到两条孤立记录，无法知道哪次是哪次的重试。
        "parent_job_id",
        "root_job_id",
        "attempt"
      ]);
      expect(columns("indexed_nodes")).toEqual(["id", "kind", "title", "body_path", "updated_at"]);
    });
  });

  test("is idempotent so reopening a project never reapplies work", () => {
    withDatabase((database) => {
      runMigrations(asRunner(database));
      const second = runMigrations(asRunner(database));

      expect(second).toEqual([]);
      const applied = database
        .prepare(`SELECT COUNT(*) AS total FROM ${SCHEMA_MIGRATIONS_TABLE}`)
        .get() as { total: number };
      expect(applied.total).toBe(migrations.length);
    });
  });

  test("applies only the migrations a partially upgraded database is missing", () => {
    withDatabase((database) => {
      // 模拟旧版本项目：只跑过第一条 migration。
      const first = migrations[0];
      expect(first).toBeDefined();
      runMigrations(asRunner(database), [first!]);

      const executed = runMigrations(asRunner(database));
      expect(executed).toEqual(migrations.slice(1).map((migration) => migration.id));
    });
  });

  test("upgrades an existing project without losing its rows", () => {
    withDatabase((database) => {
      // 旧版本建库，写入一条任务。
      const first = migrations[0];
      runMigrations(asRunner(database), [first!]);
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO video_jobs (
            id, provider_task_id, model_id, state, progress, stage,
            output_urls_json, request_json, created_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
        )
        .run("job-old", "task-1", "model-a", "completed", 1, null, "[]", "{}", now, now);

      // 升级到最新版本：既有数据必须保留，新列以默认值补齐。
      runMigrations(asRunner(database));

      const row = database.prepare("SELECT * FROM video_jobs WHERE id = ?").get("job-old") as {
        id: string;
        local_paths_json: string;
        shot_id: string | null;
        root_job_id: string | null;
        attempt: number;
      };
      expect(row.id).toBe("job-old");
      // 默认空数组而非 NULL：读取端可以直接 JSON.parse，无需处理两种缺失形态。
      expect(row.local_paths_json).toBe("[]");
      expect(row.shot_id).toBeNull();
      // 0002 回填：升级前的任务各自成链，自己就是自己的根。
      // 留 NULL 会让按链查询漏掉全部历史任务。
      expect(row.root_job_id).toBe("job-old");
      expect(row.attempt).toBe(1);
    });
  });

  test("rolls back and reports the failing migration id", () => {
    withDatabase((database) => {
      expect(() =>
        runMigrations(asRunner(database), [
          { id: "9999_broken", description: "invalid ddl", sql: "CREATE TABLE ((( ;" }
        ])
      ).toThrow("9999_broken");

      // 失败的 migration 不得被记为已应用，否则下次启动会跳过它。
      const rows = database.prepare(`SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE}`).all() as Array<{
        id: string;
      }>;
      expect(rows.map((row) => row.id)).not.toContain("9999_broken");
    });
  });

  test("keeps migration ids unique and ordered", () => {
    const ids = migrations.map((migration) => migration.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});
