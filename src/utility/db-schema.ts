import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const indexedNodes = sqliteTable("indexed_nodes", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  bodyPath: text("body_path").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const videoJobs = sqliteTable("video_jobs", {
  id: text("id").primaryKey(),
  providerTaskId: text("provider_task_id"),
  modelId: text("model_id").notNull(),
  state: text("state").notNull(),
  progress: real("progress"),
  stage: text("stage"),
  outputUrlsJson: text("output_urls_json").notNull(),
  localPathsJson: text("local_paths_json").notNull().default("[]"),
  selectedOutputUrl: text("selected_output_url"),
  shotId: text("shot_id"),
  requestJson: text("request_json").notNull(),
  errorJson: text("error_json"),
  /** 上一次尝试。首次提交为 null。 */
  parentJobId: text("parent_job_id"),
  /** 整条重试链共享的根任务 id。 */
  rootJobId: text("root_job_id"),
  attempt: integer("attempt").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  revision: integer("revision").notNull().default(0)
});

export const agentTransactions = sqliteTable("agent_transactions", {
  id: text("id").primaryKey(),
  prompt: text("prompt").notNull(),
  selectedNodeIdsJson: text("selected_node_ids_json").notNull(),
  response: text("response"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});
