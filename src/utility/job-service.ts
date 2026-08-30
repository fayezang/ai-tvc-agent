import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  VideoEstimate,
  VideoGenerationRequest,
  VideoJob,
  VideoJobChain,
  VideoPreparation,
  VideoTaskState
} from "../shared/contracts.js";
import { estimateVideoCost, normalizeVideoParams } from "../shared/video-estimate.js";
import {
  isPreSubmitVideoTaskState,
  isTerminalVideoTaskState
} from "../shared/video-task-states.js";
import { triageDanglingJobs, type TriageResult } from "./job-recovery.js";
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
  parent_job_id: string | null;
  root_job_id: string | null;
  attempt: number;
  estimate_json: string | null;
  billed_seconds: number | null;
  pricing_fetched_at: string | null;
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
    parentJobId: row.parent_job_id,
    // 升级前的旧行可能没有回填到（理论上 migration 0002 已回填，
    // 这里再兜一层，保证读取端永远拿到一个非空的链标识）。
    rootJobId: row.root_job_id ?? row.id,
    attempt: row.attempt ?? 1,
    error: row.error_json
      ? (JSON.parse(row.error_json) as { code: string; message: string; retryable: boolean })
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

/**
 * 读回提交时的估价快照。
 *
 * 快照是历史事实，可能来自任意早期版本的价格表，因此这里只做宽松校验：
 * 拿不到可信的 amount 就返回 null，交由调用方按「缺快照」处理，
 * 绝不因为一条格式异常的旧记录让整条链的汇总崩掉。
 */
const parseEstimateSnapshot = (raw: string | null): VideoEstimate | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VideoEstimate>;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as VideoEstimate;
  } catch {
    return null;
  }
};

/**
 * JobService 需要的最小 SQLite 接口。
 *
 * 与 migrations.ts 的 MigrationRunnerDatabase 同理：生产环境用
 * better-sqlite3，但它的原生模块按 Electron ABI 编译，在 bun/node 下
 * 加载即崩溃（SIGKILL）。依赖接口而非具体驱动，才能用同为真实 SQLite
 * 引擎的 bun:sqlite 验证「恢复 → 落盘」这条完整链路。
 */
export interface JobDatabase {
  prepare(sql: string): {
    get(...params: readonly unknown[]): unknown;
    run(...params: readonly unknown[]): unknown;
    all(...params: readonly unknown[]): unknown[];
  };
  close(): void;
}

export type JobDatabaseOpener = (path: string) => JobDatabase;

const openBetterSqlite: JobDatabaseOpener = (path) => {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  return db as unknown as JobDatabase;
};

export class JobService {
  /**
   * baseUrl 与 openDatabase 都可注入，默认为真实 ORZ 网关与 better-sqlite3。
   *
   * 这是为了让恢复与轮询能对着 Bun.serve 起的真实 HTTP 服务、真实 SQLite
   * 文件做端到端验证：「恢复时发现任务已完成 → 视频落盘」横跨查询、下载、
   * 校验、写盘四步，只有整条跑通才算验证过。本项目不 mock 网络与文件系统。
   */
  constructor(
    private readonly baseUrl?: string,
    private readonly openDatabase: JobDatabaseOpener = openBetterSqlite
  ) {}

  private client(apiKey: string): OrzClient {
    return this.baseUrl ? new OrzClient(apiKey, this.baseUrl) : new OrzClient(apiKey);
  }

  async submit(
    incoming: VideoGenerationRequest,
    apiKey: string,
    lineage?: { parentJobId: string; rootJobId: string; attempt: number }
  ): Promise<VideoJob> {
    // 规范化放在这里，因为 submit 是所有提交路径的唯一入口（retry 也复用它）。
    // 放在调用方会漏：未规范化的请求会被 adapter 的 assertModel 拒掉，
    // 而估价却已按规范化后的参数报了价 —— 用户看到的价必须是真能提交的那一档。
    const normalized = normalizeVideoParams(incoming);
    const request: VideoGenerationRequest = {
      ...incoming,
      duration: normalized.duration,
      resolution: normalized.resolution,
      aspectRatio: normalized.aspectRatio
    };
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
      parentJobId: lineage?.parentJobId ?? null,
      // 首次提交时自己就是链的根，无需等到第一次重试才建立链身份。
      rootJobId: lineage?.rootJobId ?? id,
      attempt: lineage?.attempt ?? 1,
      error: null,
      createdAt: now,
      updatedAt: now
    }, request, incoming);
    try {
      const task = await this.client(apiKey).submitVideo(adapter.build(request));
      return await this.updateFromProvider(request.projectRoot, id, task);
    } catch (error) {
      return this.fail(request.projectRoot, id, error);
    }
  }

  /**
   * 提交前准备：建一条待确认记录并返回估价。
   *
   * **本方法不发任何网络请求。** 这是它存在的全部意义 —— 用户在看到金额
   * 之前，不该产生任何服务端痕迹与任何计费。参考图上传（POST /files）也
   * 推迟到 approve 之后，因为上传本身可能计费，而用户完全可能放弃。
   *
   * 返回的估价即写入数据库的快照，用户看到的和后续归集用的是同一份数字。
   */
  prepare(
    incoming: VideoGenerationRequest,
    lineage?: { parentJobId: string; rootJobId: string; attempt: number }
  ): VideoPreparation {
    const normalized = normalizeVideoParams(incoming);
    const request: VideoGenerationRequest = {
      ...incoming,
      duration: normalized.duration,
      resolution: normalized.resolution,
      aspectRatio: normalized.aspectRatio
    };
    // 提前解析一次 Adapter：宁可在用户点确认之前就报错，
    // 也不要让他确认了一个根本提交不出去的请求。
    resolveOrzAdapter(request.modelId);
    const estimate = estimateVideoCost(incoming);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.insert(
      request.projectRoot,
      {
        id,
        providerTaskId: null,
        modelId: request.modelId,
        state: "awaiting-approval",
        progress: null,
        stage: "等待确认",
        outputUrls: [],
        localPaths: [],
        selectedOutputUrl: null,
        selectedLocalPath: null,
        parentJobId: lineage?.parentJobId ?? null,
        rootJobId: lineage?.rootJobId ?? id,
        attempt: lineage?.attempt ?? 1,
        error: null,
        createdAt: now,
        updatedAt: now
      },
      request,
      incoming
    );
    return { job: this.get(request.projectRoot, id), estimate };
  }

  /**
   * 确认并真正提交。
   *
   * 只接受 awaiting-approval 态。其他状态一律拒绝 —— 这道检查同时挡住了
   * 重复点击确认按钮导致的重复计费，以及对一个已经在跑（或已结束）的任务
   * 再次提交。
   *
   * 提交用的是 prepare 时落库的那份请求，不接受调用方再传参数：
   * 用户批准的是那一份，不能在批准之后被换掉。
   */
  async approve(projectRoot: string, jobId: string, apiKey: string): Promise<VideoJob> {
    const row = this.getRow(projectRoot, jobId);
    if (row.state !== "awaiting-approval") {
      throw new Error(
        `任务 ${jobId} 当前状态为 ${row.state}，只有等待确认的任务可以提交。` +
          `若要重新生成，请发起一次重试。`
      );
    }
    const request = JSON.parse(row.request_json) as VideoGenerationRequest;
    const adapter = resolveOrzAdapter(request.modelId);
    this.patch(projectRoot, jobId, { state: "uploading", stage: "准备 ORZ 请求" });
    try {
      const task = await this.client(apiKey).submitVideo(adapter.build(request));
      return await this.updateFromProvider(projectRoot, jobId, task);
    } catch (error) {
      return this.fail(projectRoot, jobId, error);
    }
  }

  /**
   * 放弃一条待确认的任务。
   *
   * 同样不发任何网络请求 —— 服务端从来不知道这个任务存在，没有什么可取消的。
   * 记录保留为 canceled 而非删除：用户曾经准备生成什么、当时报价多少，
   * 是有价值的历史。
   */
  discard(projectRoot: string, jobId: string): VideoJob {
    const row = this.getRow(projectRoot, jobId);
    if (!isPreSubmitVideoTaskState(row.state)) {
      throw new Error(
        `任务 ${jobId} 当前状态为 ${row.state}，已经提交给 ORZ，不能作为待确认任务放弃。` +
          `请改用取消。`
      );
    }
    return this.patch(projectRoot, jobId, { state: "canceled", stage: "已放弃，未提交" });
  }

  async refresh(projectRoot: string, jobId: string, apiKey: string): Promise<VideoJob> {
    const row = this.getRow(projectRoot, jobId);
    if (!row.provider_task_id) return rowToJob(row);
    if (isTerminal(row.state)) return rowToJob(row);
    try {
      const task = await this.client(apiKey).getTask(row.provider_task_id);
      return await this.updateFromProvider(projectRoot, jobId, task);
    } catch (error) {
      return this.fail(projectRoot, jobId, error);
    }
  }

  async cancel(projectRoot: string, jobId: string, apiKey: string): Promise<VideoJob> {
    const row = this.getRow(projectRoot, jobId);
    if (!row.provider_task_id) return this.patch(projectRoot, jobId, { state: "canceled", stage: "已取消" });
    try {
      const task = await this.client(apiKey).cancelTask(row.provider_task_id);
      return await this.updateFromProvider(projectRoot, jobId, task);
    } catch (error) {
      return this.fail(projectRoot, jobId, error);
    }
  }

  /**
   * 重试：建一条待确认的新尝试并返回估价，**不直接提交**。
   *
   * 重试和首次提交一样真实计费，而用户恰恰最容易在连续失败后反复点重试。
   * 因此它走同一条确认路径 —— 实际提交仍由 approve 完成。
   *
   * 原 job 行完整保留——它记录着那次尝试真实发生过、失败在哪一步、
   * 花了多少时间。删掉或改写它等于抹掉用户已经付过的那次成本。
   * 新 job 通过 parent_job_id / root_job_id 挂到同一条链上。
   */
  retry(projectRoot: string, jobId: string): VideoPreparation;
  /**
   * @deprecated 仅供第二批遗留的内部调用兼容；Renderer/IPC 不得传 apiKey。
   * 有 apiKey 时立即 approve 的旧行为只保留到相关测试迁移完成。
   */
  retry(projectRoot: string, jobId: string, apiKey: string): Promise<VideoJob>;
  retry(projectRoot: string, jobId: string, apiKey?: string): VideoPreparation | Promise<VideoJob> {
    const row = this.getRow(projectRoot, jobId);
    const request = JSON.parse(row.request_json) as VideoGenerationRequest;
    const rootJobId = row.root_job_id ?? row.id;
    // attempt 取整条链的最大值加一，而不是父任务的 attempt 加一：
    // 用户可能从链中任意一次失败的尝试发起重试，若按父任务递增会产生重号。
    // maxAttempt 统计包含 awaiting-approval 的行，因此连开两个待确认重试
    // 也不会撞号。
    const preparation = this.prepare(request, {
      parentJobId: row.id,
      rootJobId,
      attempt: this.maxAttempt(projectRoot, rootJobId) + 1
    });
    // 正式 UI 与 IPC 不会传 apiKey，永远返回 awaiting-approval。
    // 这一分支仅让第二批的直接服务调用保持兼容，待测试迁移后删除。
    return apiKey ? this.approve(projectRoot, preparation.job.id, apiKey) : preparation;
  }

  /**
   * 一条重试链的全部尝试与累计用量。
   *
   * 传入链中任意一次尝试的 jobId 均可，都会归到同一条链。
   */
  chain(projectRoot: string, jobId: string): VideoJobChain {
    const row = this.getRow(projectRoot, jobId);
    const rootJobId = row.root_job_id ?? row.id;
    const db = this.open(projectRoot);
    let rows: JobRow[];
    try {
      rows = db
        .prepare("SELECT * FROM video_jobs WHERE root_job_id = ? OR id = ? ORDER BY attempt ASC")
        .all(rootJobId, rootJobId) as JobRow[];
    } finally {
      db.close();
    }

    const attempts = rows.map(rowToJob);
    // 只计入真正产出了视频的尝试。提交失败、被取消、或崩在提交前的尝试
    // 不产生费用，把它们算进去会虚高整条链的账。
    const billedRows = rows.filter((current) => current.state === "completed");

    let totalBilledSeconds = 0;
    let knownCost = 0;
    let attemptsMissingCost = 0;
    let hasAnyCost = false;

    for (const current of billedRows) {
      // 计费秒数优先取快照的 billed_seconds：模型只有离散时长档时，
      // 实际生成（并计费）的秒数大于脚本时长。Kling 只有 5 / 10 两档，
      // 脚本要 7 秒时按 request.duration 汇总会少算 3 秒。
      // 按 request.duration 汇总会少算 3 秒。
      if (typeof current.billed_seconds === "number") {
        totalBilledSeconds += current.billed_seconds;
      } else {
        const request = JSON.parse(current.request_json) as Partial<VideoGenerationRequest>;
        totalBilledSeconds += typeof request.duration === "number" ? request.duration : 0;
      }

      const snapshot = parseEstimateSnapshot(current.estimate_json);
      if (snapshot?.amount != null) {
        knownCost += snapshot.amount;
        hasAnyCost = true;
      } else {
        // 升级前产生的行没有快照，或该模型该分辨率当时就没有报价。
        // 两种情况都不回填猜测值，只计数并在说明里点明。
        attemptsMissingCost += 1;
      }
    }

    // 一条缺失不该让整个金额消失 —— 那会让升级前有过重试的用户
    // 永远看不到任何金额。只有全部产出尝试都缺快照时才返回 null。
    const totalCost = hasAnyCost ? Math.round(knownCost * 100) / 100 : null;

    const missingNote =
      attemptsMissingCost > 0
        ? `其中 ${attemptsMissingCost} 次尝试缺少价格快照，未计入金额。`
        : "";

    return {
      rootJobId,
      attempts,
      totalBilledSeconds,
      currency: "CNY",
      totalCost,
      attemptsMissingCost,
      costNote:
        `整条链共 ${attempts.length} 次尝试，其中 ${billedRows.length} 次成功产出，` +
        `累计计费时长 ${totalBilledSeconds} 秒，` +
        `${totalCost === null ? "无可用金额快照" : `累计约 ¥${totalCost}`}。` +
        `${missingNote}金额按各次提交时的估价快照汇总，以 ORZ 控制台实时计费为准。`
    };
  }

  private maxAttempt(projectRoot: string, rootJobId: string): number {
    const db = this.open(projectRoot);
    try {
      const row = db
        .prepare("SELECT MAX(attempt) AS highest FROM video_jobs WHERE root_job_id = ? OR id = ?")
        .get(rootJobId, rootJobId) as { highest: number | null } | undefined;
      return row?.highest ?? 1;
    } finally {
      db.close();
    }
  }

  /**
   * 启动恢复：分诊上次运行遗留的悬空任务，并把可查询的那些问回 ORZ。
   *
   * 绝不重新提交。只查询已有 provider_task_id 的任务——重新生成会产生
   * 一次用户没有授权的真实计费，而恢复的目的恰恰是把已经付过的钱拿回来。
   *
   * 查询走 refresh，因此若服务端那边任务其实已经完成，会经由
   * updateFromProvider → persistCompleted 正常落盘，而不是直接置
   * completed 留下一个只有远程 URL 的空壳。
   */
  async recoverInterrupted(
    projectRoot: string,
    apiKey: string | null,
    onJobUpdate?: (job: VideoJob) => void
  ): Promise<{ recovered: VideoJob[]; failed: VideoJob[]; interrupted: VideoJob[] }> {
    const db = this.open(projectRoot);
    let triage: TriageResult;
    try {
      triage = triageDanglingJobs(db, { canQueryProvider: Boolean(apiKey) });
    } finally {
      db.close();
    }

    const failed = triage.failed.map((jobId) => this.get(projectRoot, jobId));
    const interrupted = triage.interrupted.map((jobId) => this.get(projectRoot, jobId));
    // 分诊结论先推给 UI：判失败的任务用户马上就能重试，
    // 不必等前面那些还在查询的任务全部返回。
    for (const job of [...failed, ...interrupted]) onJobUpdate?.(job);

    // 查询逐个进行而非并发：恢复常常一次涉及多个任务，
    // 并发打过去容易触发 ORZ 限流，反而让本可恢复的任务失败。
    const recovered: VideoJob[] = [];
    for (const jobId of triage.recovering) {
      if (!apiKey) continue;
      const job = await this.refresh(projectRoot, jobId, apiKey);
      onJobUpdate?.(job);
      recovered.push(job);
    }

    return { recovered, failed, interrupted };
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

  private insert(
    projectRoot: string,
    job: VideoJob,
    request: VideoGenerationRequest,
    originalRequest: VideoGenerationRequest = request
  ): void {
    // 估价在插入时算一次并存成快照。价格表随时会变，事后用当前单价重算
    // 历史任务会失真 —— 用户当时看到并批准的那个金额才是该保留的事实。
    //
    // 传原始请求而非规范化后的：estimateVideoCost 内部会自己规范化，
    // 这样 requestedSeconds 才是脚本真正要求的秒数，而不是取整后的结果。
    const estimate = estimateVideoCost(originalRequest);
    const db = this.open(projectRoot);
    db.prepare(`
      INSERT INTO video_jobs (
        id, provider_task_id, model_id, state, progress, stage, output_urls_json,
        local_paths_json, shot_id, request_json, error_json,
        parent_job_id, root_job_id, attempt,
        estimate_json, billed_seconds, pricing_fetched_at,
        created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
      job.parentJobId,
      job.rootJobId,
      job.attempt,
      JSON.stringify(estimate),
      estimate.billedSeconds,
      estimate.pricingFetchedAt,
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

  private open(projectRoot: string): JobDatabase {
    return this.openDatabase(`${projectRoot}/.agent/index.sqlite`);
  }
}
