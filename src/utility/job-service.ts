import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { VideoGenerationRequest, VideoJob, VideoTaskState } from "../shared/contracts.js";
import { isTerminalVideoTaskState } from "../shared/video-task-states.js";
import { OrzClient, type OrzTaskResponse } from "./providers/orz-client.js";
import { resolveOrzAdapter } from "./providers/orz-adapters.js";
import { persistVideoOutputs } from "./video-assets.js";

interface JobRow {
  id: string;
  provider_task_id: string | null;
  model_id: string;
  state: VideoTaskState;
  progress: number | null;
  stage: string | null;
  output_urls_json: string;
  local_paths_json: string;
  selected_output_url: string | null;
  shot_id: string | null;
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

/** 终态判断来自 shared/video-task-states.ts，本文件不再自持一份清单。 */
const isTerminal = isTerminalVideoTaskState;

const parseStringArray = (raw: string | null): string[] => {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
};

const rowToJob = (row: JobRow): VideoJob => {
  const outputUrls = parseStringArray(row.output_urls_json);
  const localPaths = parseStringArray(row.local_paths_json);
  const selectedOutputUrl = row.selected_output_url;
  // 选中版本的本地路径按该 URL 在输出列表中的位置对应。
  // 若这一版尚未成功落盘则为 null，UI 据此可提示"该版本仅存在于远程且会过期"。
  const selectedIndex = selectedOutputUrl ? outputUrls.indexOf(selectedOutputUrl) : -1;
  return {
    id: row.id,
    providerTaskId: row.provider_task_id,
    modelId: row.model_id,
    state: row.state,
    progress: row.progress,
    stage: row.stage,
    outputUrls,
    localPaths,
    selectedOutputUrl,
    selectedLocalPath: selectedIndex >= 0 ? (localPaths[selectedIndex] ?? null) : null,
    error: row.error_json
      ? (JSON.parse(row.error_json) as { code: string; message: string; retryable: boolean })
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

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
      localPaths: [],
      selectedOutputUrl: null,
      selectedLocalPath: null,
      error: null,
      createdAt: now,
      updatedAt: now
    }, request);
    try {
      const task = await new OrzClient(apiKey).submitVideo(adapter.build(request));
      return await this.updateFromProvider(request.projectRoot, id, task);
    } catch (error) {
      return this.fail(request.projectRoot, id, error);
    }
  }

  async refresh(projectRoot: string, jobId: string, apiKey: string): Promise<VideoJob> {
    const row = this.getRow(projectRoot, jobId);
    if (!row.provider_task_id) return rowToJob(row);
    if (isTerminal(row.state)) return rowToJob(row);
    try {
      const task = await new OrzClient(apiKey).getTask(row.provider_task_id);
      return await this.updateFromProvider(projectRoot, jobId, task);
    } catch (error) {
      return this.fail(projectRoot, jobId, error);
    }
  }

  async cancel(projectRoot: string, jobId: string, apiKey: string): Promise<VideoJob> {
    const row = this.getRow(projectRoot, jobId);
    if (!row.provider_task_id) return this.patch(projectRoot, jobId, { state: "canceled", stage: "已取消" });
    try {
      const task = await new OrzClient(apiKey).cancelTask(row.provider_task_id);
      return await this.updateFromProvider(projectRoot, jobId, task);
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
    const outputUrls = parseStringArray(row.output_urls_json);
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

  private async updateFromProvider(
    projectRoot: string,
    jobId: string,
    task: OrzTaskResponse
  ): Promise<VideoJob> {
    const state = mapProviderState(task.status);
    const outputUrls = task.output?.items?.flatMap((item) => (item.url ? [item.url] : [])) ?? [];
    const error = task.error
      ? {
          code: task.error.code ?? "ORZ_TASK_ERROR",
          message: task.error.message ?? "ORZ 任务失败",
          retryable: task.error.retryable ?? false
        }
      : null;

    // ORZ 报告完成时任务尚未真正结束：CDN 链接有时效（官方标注 14 天），
    // 只有把字节落到项目目录里，这个任务的产物才是持久的。
    if (state === "completed" && outputUrls.length > 0) {
      return this.persistCompleted(projectRoot, jobId, {
        providerTaskId: task.task_id,
        outputUrls,
        progress: typeof task.progress === "number" ? task.progress : null
      });
    }

    return this.patch(projectRoot, jobId, {
      providerTaskId: task.task_id,
      state,
      progress: typeof task.progress === "number" ? task.progress : null,
      stage: task.stage ?? null,
      outputUrls,
      error
    });
  }

  /**
   * 下载并校验 ORZ 产出，写入项目目录后才置为 completed。
   *
   * 期间状态依次为 downloading → validating，两者都是真实经历的阶段而非装饰：
   * 下载视频可能耗时数十秒，用户需要知道当前在做什么。
   */
  private async persistCompleted(
    projectRoot: string,
    jobId: string,
    input: { providerTaskId: string; outputUrls: string[]; progress: number | null }
  ): Promise<VideoJob> {
    this.patch(projectRoot, jobId, {
      providerTaskId: input.providerTaskId,
      state: "downloading",
      progress: input.progress,
      stage: `正在保存 ${input.outputUrls.length} 个视频版本到项目目录`,
      outputUrls: input.outputUrls,
      error: null
    });

    let persisted: Awaited<ReturnType<typeof persistVideoOutputs>>;
    try {
      persisted = await persistVideoOutputs({ projectRoot, jobId, urls: input.outputUrls });
    } catch (error) {
      return this.patch(projectRoot, jobId, {
        state: "failed",
        stage: "保存视频失败",
        error: {
          code: "VIDEO_PERSIST_FAILED",
          message: error instanceof Error ? error.message : "保存视频到项目目录时发生未知错误",
          retryable: true
        }
      });
    }

    // 校验在 persistVideoOutputs 内部随下载完成（MP4 ftyp 标识 + 非空）。
    // 这里单独置一次 validating，使该阶段在 UI 与日志中可见。
    this.patch(projectRoot, jobId, { state: "validating", stage: "正在校验视频文件" });

    const succeeded = persisted.failures.filter((failure) => failure === null).length;
    if (succeeded === 0) {
      const reasons = persisted.failures.filter((failure): failure is string => failure !== null);
      return this.patch(projectRoot, jobId, {
        state: "failed",
        stage: "视频保存失败",
        localPaths: [],
        error: {
          code: "VIDEO_DOWNLOAD_FAILED",
          // 保留全部失败原因：网关返回 HTML 错误页与网络超时的处理方式不同。
          message: `模型已生成视频，但全部下载失败：${reasons.join("；")}`,
          retryable: true
        }
      });
    }

    // 部分成功也置为 completed：已落盘的版本可用，不应因个别失败而丢弃全部结果。
    const partialNote =
      succeeded < input.outputUrls.length
        ? `已保存 ${succeeded}/${input.outputUrls.length} 个版本，其余版本下载失败`
        : `已保存 ${succeeded} 个视频版本到项目目录`;
    return this.patch(projectRoot, jobId, {
      state: "completed",
      progress: 1,
      stage: partialNote,
      localPaths: persisted.localPaths,
      error: null
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
        local_paths_json, shot_id, request_json, error_json, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      job.id,
      job.providerTaskId,
      job.modelId,
      job.state,
      job.progress,
      job.stage,
      JSON.stringify(job.outputUrls),
      JSON.stringify(job.localPaths),
      request.shotId,
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
      localPaths?: readonly string[];
      error?: VideoJob["error"];
    }
  ): VideoJob {
    const row = this.getRow(projectRoot, jobId);
    const next = {
      providerTaskId: patch.providerTaskId ?? row.provider_task_id,
      state: patch.state ?? row.state,
      progress: patch.progress === undefined ? row.progress : patch.progress,
      stage: patch.stage === undefined ? row.stage : patch.stage,
      outputUrlsJson:
        patch.outputUrls === undefined ? row.output_urls_json : JSON.stringify(patch.outputUrls),
      localPathsJson:
        patch.localPaths === undefined ? row.local_paths_json : JSON.stringify(patch.localPaths),
      errorJson: patch.error === undefined ? row.error_json : patch.error ? JSON.stringify(patch.error) : null,
      updatedAt: new Date().toISOString()
    };
    const db = this.open(projectRoot);
    db.prepare(`
      UPDATE video_jobs SET provider_task_id = ?, state = ?, progress = ?, stage = ?,
        output_urls_json = ?, local_paths_json = ?, error_json = ?, updated_at = ?,
        revision = revision + 1
      WHERE id = ?
    `).run(
      next.providerTaskId,
      next.state,
      next.progress,
      next.stage,
      next.outputUrlsJson,
      next.localPathsJson,
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
