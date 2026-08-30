/**
 * Utility Process 内的视频任务轮询器。
 *
 * 此前轮询写在 renderer：`setInterval` 每 3 秒一次，固定间隔不退避。
 * 三个问题——
 *   1. 窗口关闭或组件卸载即停止。任务在 ORZ 那边继续跑，本地却不再跟踪，
 *      于是又变成一个悬空任务，只能等下次启动恢复。
 *   2. 每一 tick 走三跳 IPC（renderer → main → utility → main → renderer）。
 *   3. 视频动辄几分钟，固定 3 秒意味着一次生成打上百次请求。
 *
 * 放进 Utility Process 后，轮询与窗口生命周期解耦；间隔从 3 秒起逐步退避
 * 到 15 秒上限，长任务的请求量下降一个数量级，而刚提交时仍然反应灵敏。
 */

import type { VideoJob } from "../shared/contracts.js";
import { isTerminalVideoTaskState } from "../shared/video-task-states.js";

export const POLL_INTERVAL_START_MS = 3_000;
export const POLL_INTERVAL_MAX_MS = 15_000;
/**
 * 每次退避的倍数。
 *
 * 1.5 而非 2：从 3 秒翻倍到 15 秒只需 3 次，太快就失去了「刚提交时反应灵敏」
 * 的意义；1.5 需要 5 次，前一分钟内保持在 10 秒以内，之后才稳定到上限。
 */
export const POLL_BACKOFF_FACTOR = 1.5;

/**
 * 下一次轮询的间隔。
 *
 * 纯函数，便于直接验证退避曲线，不必等真实时间流逝。
 */
export const nextPollInterval = (current: number): number =>
  Math.min(Math.round(current * POLL_BACKOFF_FACTOR), POLL_INTERVAL_MAX_MS);

/** 可注入的定时器，便于测试用假时钟驱动而不必真的等待。 */
export interface PollScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface TrackedJob {
  readonly projectRoot: string;
  intervalMs: number;
  handle: unknown;
  /** 已排队的下一次执行是否应当取消（stop 与正在飞行的请求竞争时用）。 */
  stopped: boolean;
}

export interface JobPollerOptions {
  /** 查询任务的真实状态。由 JobService.refresh 提供。 */
  readonly refresh: (projectRoot: string, jobId: string) => Promise<VideoJob>;
  /** 每次拿到新状态后推送给 UI。 */
  readonly emit: (job: VideoJob) => void;
  /** 轮询出错时上报，不中断其余任务。 */
  readonly onError?: (jobId: string, error: unknown) => void;
  readonly scheduler?: PollScheduler;
}

export class JobPoller {
  private readonly tracked = new Map<string, TrackedJob>();
  private readonly scheduler: PollScheduler;

  constructor(private readonly options: JobPollerOptions) {
    this.scheduler = options.scheduler ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    };
  }

  /** 当前正在跟踪的任务 id，供测试与诊断使用。 */
  get trackedJobIds(): string[] {
    return [...this.tracked.keys()];
  }

  /**
   * 开始跟踪一个任务。
   *
   * 已在跟踪的任务不会被重复排期——重复 track 会让同一个任务的请求量翻倍，
   * 而提交后立刻收到一次状态推送很容易触发这种重复。
   */
  track(projectRoot: string, job: VideoJob): void {
    if (isTerminalVideoTaskState(job.state)) return;
    if (this.tracked.has(job.id)) return;
    const entry: TrackedJob = {
      projectRoot,
      intervalMs: POLL_INTERVAL_START_MS,
      handle: null,
      stopped: false
    };
    this.tracked.set(job.id, entry);
    this.schedule(job.id, entry);
  }

  stop(jobId: string): void {
    const entry = this.tracked.get(jobId);
    if (!entry) return;
    entry.stopped = true;
    if (entry.handle !== null) this.scheduler.clearTimeout(entry.handle);
    this.tracked.delete(jobId);
  }

  /** 停止全部轮询。应用退出前调用，避免留下悬空定时器。 */
  stopAll(): void {
    for (const jobId of this.trackedJobIds) this.stop(jobId);
  }

  private schedule(jobId: string, entry: TrackedJob): void {
    entry.handle = this.scheduler.setTimeout(() => {
      void this.poll(jobId, entry);
    }, entry.intervalMs);
  }

  private async poll(jobId: string, entry: TrackedJob): Promise<void> {
    if (entry.stopped) return;
    let job: VideoJob;
    try {
      job = await this.options.refresh(entry.projectRoot, jobId);
    } catch (error) {
      this.options.onError?.(jobId, error);
      // 查询失败不注销任务：网络抖动是常态，注销会让任务彻底失联。
      // 但仍然退避，避免网关故障时把请求打成风暴。
      if (!entry.stopped) {
        entry.intervalMs = nextPollInterval(entry.intervalMs);
        this.schedule(jobId, entry);
      }
      return;
    }

    // stop 可能在请求飞行途中被调用。此时不再推送，也不再排期。
    if (entry.stopped) return;

    this.options.emit(job);

    if (isTerminalVideoTaskState(job.state)) {
      this.tracked.delete(jobId);
      return;
    }

    entry.intervalMs = nextPollInterval(entry.intervalMs);
    this.schedule(jobId, entry);
  }
}
