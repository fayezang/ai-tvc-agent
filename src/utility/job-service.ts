import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { VideoGenerationRequest, VideoJob, VideoTaskState } from "../shared/contracts.js";
import { OrzClient, type OrzTaskResponse } from "./providers/orz-client.js";
import { resolveOrzAdapter } from "./providers/orz-adapters.js";

interface JobRow {
  id: string;
  provider_task_id: string | null;
  model_id: string;
  state: VideoTaskState;
  progress: number | null;
  stage: string | null;
  output_urls_json: string;
  selected_output_url: string | null;
  request_json: string;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

const mapProviderState = (status: OrzTaskResponse["status"]): VideoTaskState => {
  if (status === "pending") return "queued";
  if (status === "running" || status === "processing") return "generating";
  return status;
};

const rowToJob = (row: JobRow): VideoJob => ({
  id: row.id,
  providerTaskId: row.provider_task_id,
  modelId: row.model_id,
  state: row.state,
  progress: row.progress,
  stage: row.stage,
  outputUrls: JSON.parse(row.output_urls_json) as string[],
  error: row.error_json
    ? (JSON.parse(row.error_json) as { code: string; message: string; retryable: boolean })
    : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export class JobService {
  async submit(request: VideoGenerationRequest, apiKey: string): Promise<VideoJob> {
    const adapter = resolveOrzAdapter(request.modelId);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.insert(request.projectRoot, {
      id,
      providerTaskId: null,
      modelId: request.modelId,
      state: "uploading",
      progress: null,
      stage: "准备 ORZ 请求",
      outputUrls: [],
      error: null,
      createdAt: now,
      updatedAt: now
    }, request);
    try {
      const task = await new OrzClient(apiKey).submitVideo(adapter.build(request));
      return this.updateFromProvider(request.projectRoot, id, task);
    } catch (error) {
      return this.fail(request.projectRoot, id, error);
    }
  }

  async refresh(projectRoot: string, jobId: string, apiKey: string): Promise<VideoJob> {
    const row = this.getRow(projectRoot, jobId);
    if (!row.provider_task_id) return rowToJob(row);
    if (["completed", "failed", "canceled", "expired"].includes(row.state)) return rowToJob(row);
    try {
      const task = await new OrzClient(apiKey).getTask(row.provider_task_id);
      return this.updateFromProvider(projectRoot, jobId, task);
    } catch (error) {
      return this.fail(projectRoot, jobId, error);
    }
  }

  async cancel(projectRoot: string, jobId: string, apiKey: string): Promise<VideoJob> {
    const row = this.getRow(projectRoot, jobId);
    if (!row.provider_task_id) return this.patch(projectRoot, jobId, { state: "canceled", stage: "已取消" });
    try {
      const task = await new OrzClient(apiKey).cancelTask(row.provider_task_id);
      return this.updateFromProvider(projectRoot, jobId, task);
    } catch (error) {
      return this.fail(projectRoot, jobId, error);
    }
  }

  async retry(projectRoot: string, jobId: string, apiKey: string): Promise<VideoJob> {
    const row = this.getRow(projectRoot, jobId);
    const request = JSON.parse(row.request_json) as VideoGenerationRequest;
    return this.submit(request, apiKey);
  }

  selectVariant(projectRoot: string, jobId: string, outputUrl: string): VideoJob {
    const row = this.getRow(projectRoot, jobId);
    const outputUrls = JSON.parse(row.output_urls_json) as string[];
    if (!outputUrls.includes(outputUrl)) throw new Error("所选版本不属于该任务");
    const db = this.open(projectRoot);
    db.prepare("UPDATE video_jobs SET selected_output_url = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(outputUrl, new Date().toISOString(), jobId);
    db.close();
    return this.get(projectRoot, jobId);
  }

  get(projectRoot: string, jobId: string): VideoJob {
    return rowToJob(this.getRow(projectRoot, jobId));
  }

  private updateFromProvider(projectRoot: string, jobId: string, task: OrzTaskResponse): VideoJob {
    const state = mapProviderState(task.status);
    const outputUrls = task.output?.items?.flatMap((item) => (item.url ? [item.url] : [])) ?? [];
    return this.patch(projectRoot, jobId, {
      providerTaskId: task.task_id,
      state,
      progress: typeof task.progress === "number" ? task.progress : null,
      stage: task.stage ?? null,
      outputUrls,
      error: task.error
        ? {
            code: task.error.code ?? "ORZ_TASK_ERROR",
            message: task.error.message ?? "ORZ 任务失败",
            retryable: task.error.retryable ?? false
          }
        : null
    });
  }

  private fail(projectRoot: string, jobId: string, error: unknown): VideoJob {
    return this.patch(projectRoot, jobId, {
      state: "failed",
      stage: "请求失败",
      error: {
        code: "ORZ_REQUEST_FAILED",
        message: error instanceof Error ? error.message : "未知错误",
        retryable: true
      }
    });
  }

  private insert(projectRoot: string, job: VideoJob, request: VideoGenerationRequest): void {
    const db = this.open(projectRoot);
    db.prepare(`
      INSERT INTO video_jobs (
        id, provider_task_id, model_id, state, progress, stage, output_urls_json,
        request_json, error_json, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      job.id,
      job.providerTaskId,
      job.modelId,
      job.state,
      job.progress,
      job.stage,
      JSON.stringify(job.outputUrls),
      JSON.stringify(request),
      null,
      job.createdAt,
      job.updatedAt
    );
    db.close();
  }

  private patch(
    projectRoot: string,
    jobId: string,
    patch: Partial<Pick<JobRow, "state" | "progress" | "stage">> & {
      providerTaskId?: string;
      outputUrls?: string[];
      error?: VideoJob["error"];
    }
  ): VideoJob {
    const row = this.getRow(projectRoot, jobId);
    const next = {
      providerTaskId: patch.providerTaskId ?? row.provider_task_id,
      state: patch.state ?? row.state,
      progress: patch.progress === undefined ? row.progress : patch.progress,
      stage: patch.stage === undefined ? row.stage : patch.stage,
      outputUrlsJson: patch.outputUrls === undefined ? row.output_urls_json : JSON.stringify(patch.outputUrls),
      errorJson: patch.error === undefined ? row.error_json : patch.error ? JSON.stringify(patch.error) : null,
      updatedAt: new Date().toISOString()
    };
    const db = this.open(projectRoot);
    db.prepare(`
      UPDATE video_jobs SET provider_task_id = ?, state = ?, progress = ?, stage = ?,
        output_urls_json = ?, error_json = ?, updated_at = ?, revision = revision + 1
      WHERE id = ?
    `).run(
      next.providerTaskId,
      next.state,
      next.progress,
      next.stage,
      next.outputUrlsJson,
      next.errorJson,
      next.updatedAt,
      jobId
    );
    db.close();
    return this.get(projectRoot, jobId);
  }

  private getRow(projectRoot: string, jobId: string): JobRow {
    const db = this.open(projectRoot);
    const row = db.prepare("SELECT * FROM video_jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    db.close();
    if (!row) throw new Error(`找不到视频任务：${jobId}`);
    return row;
  }

  private open(projectRoot: string): Database.Database {
    const db = new Database(`${projectRoot}/.agent/index.sqlite`);
    db.pragma("journal_mode = WAL");
    return db;
  }
}
