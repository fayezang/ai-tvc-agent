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
  selectedOutputUrl: text("selected_output_url"),
  requestJson: text("request_json").notNull(),
  errorJson: text("error_json"),
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
