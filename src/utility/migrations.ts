/**
 * 数据库 migration。
 *
 * 单一事实源为本文件的 TypeScript 常量，而非磁盘上的 .sql 文件。
 * 原因：Utility Process 经 electron-vite 打包后运行在 app.asar 内，
 * 运行时按相对路径读取 .sql 会因打包布局变化而失效。把 DDL 内联进
 * 代码可保证「从零建库」在开发态与打包态行为完全一致。
 *
 * 每条 migration 一旦发布就不可修改——已升级过的数据库不会重跑它。
 * 需要变更 schema 时追加新的 migration。
 */

export interface Migration {
  /** 单调递增且唯一。记录进 schema_migrations 后作为已执行标记。 */
  readonly id: string;
  readonly description: string;
  /** 在单个事务内执行的 DDL。 */
  readonly sql: string;
}

export const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";

export const migrations: readonly Migration[] = [
  {
    id: "0000_init",
    description: "节点索引、视频任务与 Agent 事务基础表",
    sql: `
      CREATE TABLE IF NOT EXISTS indexed_nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body_path TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS video_jobs (
        id TEXT PRIMARY KEY,
        provider_task_id TEXT,
        model_id TEXT NOT NULL,
        state TEXT NOT NULL,
        progress REAL,
        stage TEXT,
        output_urls_json TEXT NOT NULL,
        selected_output_url TEXT,
        request_json TEXT NOT NULL,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS agent_transactions (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        selected_node_ids_json TEXT NOT NULL,
        response TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    id: "0001_video_local_assets",
    description: "视频任务记录落盘路径与所属镜头",
    sql: `
      ALTER TABLE video_jobs ADD COLUMN local_paths_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE video_jobs ADD COLUMN shot_id TEXT;
    `
  }
];

/** 供测试与运维核对：schema_migrations 自身的建表语句。 */
export const schemaMigrationsDdl = `
  CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

/** 最小 SQLite 接口，避免本模块直接依赖 better-sqlite3 类型。 */
export interface MigrationRunnerDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(...params: readonly unknown[]): unknown[];
    run(...params: readonly unknown[]): unknown;
  };
}

/**
 * 按顺序执行尚未应用的 migration，并记录到 schema_migrations。
 * 幂等：重复调用不会重复执行。
 * 返回本次实际应用的 migration id，便于日志与测试断言。
 */
export const runMigrations = (
  database: MigrationRunnerDatabase,
  list: readonly Migration[] = migrations
): string[] => {
  database.exec(schemaMigrationsDdl);
  const appliedRows = database.prepare(`SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE}`).all() as Array<{
    id: string;
  }>;
  const applied = new Set(appliedRows.map((row) => row.id));
  const executed: string[] = [];
  for (const migration of list) {
    if (applied.has(migration.id)) continue;
    // 每条 migration 单独成事务：中途失败时已完成的部分保持已记录状态，
    // 失败的这条完全回滚，下次启动可从同一位置重试。
    database.exec("BEGIN");
    try {
      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (id, description, applied_at) VALUES (?, ?, ?)`
        )
        .run(migration.id, migration.description, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(
        `migration ${migration.id} 执行失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
    executed.push(migration.id);
  }
  return executed;
};
