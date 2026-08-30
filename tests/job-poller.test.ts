import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  JobPoller,
  nextPollInterval,
  POLL_INTERVAL_MAX_MS,
  POLL_INTERVAL_START_MS,
  type PollScheduler
} from "../src/utility/job-poller.js";
import type { VideoJob } from "../src/shared/contracts.js";
import type { VideoTaskState } from "../src/shared/video-task-states.js";

const job = (state: VideoTaskState, id = "job-1"): VideoJob => ({
  id,
  providerTaskId: "task-1",
  modelId: "bytedance/seedance-2",
  state,
  progress: null,
  stage: null,
  outputUrls: [],
  localPaths: [],
  selectedOutputUrl: null,
  selectedLocalPath: null,
  error: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z"
});

/**
 * 手动推进的时钟。
 *
 * 不 mock 定时器本身，而是把调度器作为依赖注入——轮询器真实地排期、
 * 真实地退避，只是由测试决定时间何时前进。否则验证「退避到 15 秒上限」
 * 就得真的等上一分钟。
 */
const manualScheduler = (): PollScheduler & {
  advance: () => Promise<number>;
  pendingDelay: () => number | null;
  pendingCount: () => number;
} => {
  let nextHandle = 1;
  const queue = new Map<number, { callback: () => void; delay: number }>();
  return {
    setTimeout(callback, ms) {
      const handle = nextHandle++;
      queue.set(handle, { callback, delay: ms });
      return handle;
    },
    clearTimeout(handle) {
      queue.delete(handle as number);
    },
    pendingDelay() {
      const first = [...queue.values()][0];
      return first ? first.delay : null;
    },
    pendingCount() {
      return queue.size;
    },
    /** 触发当前排队的那一次回调，返回它当时的延迟。 */
    async advance() {
      const entry = [...queue.entries()][0];
      if (!entry) throw new Error("没有排队中的轮询");
      const [handle, { callback, delay }] = entry;
      queue.delete(handle);
      callback();
      // 让 poll 内部的 await 链跑完。
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      return delay;
    }
  };
};

describe("backoff curve", () => {
  test("starts at 3 seconds and climbs to a 15 second ceiling", () => {
    expect(POLL_INTERVAL_START_MS).toBe(3_000);
    expect(POLL_INTERVAL_MAX_MS).toBe(15_000);

    const intervals: number[] = [];
    let current = POLL_INTERVAL_START_MS;
    for (let index = 0; index < 8; index += 1) {
      current = nextPollInterval(current);
      intervals.push(current);
    }
    // 逐步拉长而非一步到顶：刚提交时仍然反应灵敏。
    expect(intervals).toEqual([4_500, 6_750, 10_125, 15_000, 15_000, 15_000, 15_000, 15_000]);
  });

  test("never exceeds the ceiling no matter how long a task runs", () => {
    expect(nextPollInterval(POLL_INTERVAL_MAX_MS)).toBe(POLL_INTERVAL_MAX_MS);
    expect(nextPollInterval(1_000_000)).toBe(POLL_INTERVAL_MAX_MS);
  });
});

describe("polling a job", () => {
  test("backs off across successive polls instead of holding at 3 seconds", async () => {
    const scheduler = manualScheduler();
    const emitted: VideoJob[] = [];
    const poller = new JobPoller({
      refresh: async () => job("generating"),
      emit: (updated) => emitted.push(updated),
      scheduler
    });

    poller.track("/tmp/project", job("queued"));

    const delays: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      delays.push(await scheduler.advance());
    }

    // 这正是修复前的缺陷：固定 3 秒会让一个几分钟的任务打上百次请求。
    expect(delays).toEqual([3_000, 4_500, 6_750, 10_125]);
    expect(emitted).toHaveLength(4);
  });

  test("stops once the job reaches a terminal state", async () => {
    const scheduler = manualScheduler();
    const poller = new JobPoller({
      refresh: async () => job("completed"),
      emit: () => {},
      scheduler
    });

    poller.track("/tmp/project", job("generating"));
    await scheduler.advance();

    // 终态之后再查只是白白消耗配额。
    expect(poller.trackedJobIds).toEqual([]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  test("emits the terminal state before it stops", async () => {
    const scheduler = manualScheduler();
    const emitted: VideoJob[] = [];
    const poller = new JobPoller({
      refresh: async () => job("completed"),
      emit: (updated) => emitted.push(updated),
      scheduler
    });

    poller.track("/tmp/project", job("generating"));
    await scheduler.advance();

    // 漏掉这一次推送，UI 会永远停在最后一个中间态。
    expect(emitted.map((entry) => entry.state)).toEqual(["completed"]);
  });

  test("refuses to track a job that has already finished", () => {
    const scheduler = manualScheduler();
    const poller = new JobPoller({ refresh: async () => job("completed"), emit: () => {}, scheduler });

    poller.track("/tmp/project", job("completed"));

    expect(poller.trackedJobIds).toEqual([]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  test("does not double-schedule a job that is already tracked", () => {
    const scheduler = manualScheduler();
    const poller = new JobPoller({ refresh: async () => job("generating"), emit: () => {}, scheduler });

    poller.track("/tmp/project", job("generating"));
    poller.track("/tmp/project", job("generating"));
    poller.track("/tmp/project", job("generating"));

    // 重复排期会让同一个任务的请求量翻倍。
    expect(scheduler.pendingCount()).toBe(1);
    expect(poller.trackedJobIds).toEqual(["job-1"]);
  });

  test("keeps tracking after a transient query failure, but backs off", async () => {
    const scheduler = manualScheduler();
    let attempts = 0;
    const errors: string[] = [];
    const poller = new JobPoller({
      refresh: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("ETIMEDOUT");
        return job("generating");
      },
      emit: () => {},
      onError: (jobId) => errors.push(jobId),
      scheduler
    });

    poller.track("/tmp/project", job("generating"));
    await scheduler.advance();

    // 网络抖动是常态。注销任务会让它彻底失联，只能等下次启动恢复。
    expect(errors).toEqual(["job-1"]);
    expect(poller.trackedJobIds).toEqual(["job-1"]);
    expect(scheduler.pendingDelay()).toBe(4_500);
  });

  test("stop cancels a pending poll", () => {
    const scheduler = manualScheduler();
    const poller = new JobPoller({ refresh: async () => job("generating"), emit: () => {}, scheduler });

    poller.track("/tmp/project", job("generating"));
    poller.stop("job-1");

    expect(scheduler.pendingCount()).toBe(0);
    expect(poller.trackedJobIds).toEqual([]);
  });

  test("stop during an in-flight request suppresses both the emit and the next poll", async () => {
    const scheduler = manualScheduler();
    const emitted: VideoJob[] = [];
    // 用一个可外部兑现的 Promise 把查询卡在飞行途中，
    // 以便在它返回之前调用 stop。
    let release = (): void => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const poller = new JobPoller({
      refresh: async () => {
        await inFlight;
        return job("generating");
      },
      emit: (updated) => emitted.push(updated),
      scheduler
    });

    poller.track("/tmp/project", job("generating"));
    const pending = scheduler.advance();
    poller.stop("job-1");
    release();
    await pending;
    await Promise.resolve();

    // 取消之后再推状态，UI 会显示一个用户已经放弃的任务。
    expect(emitted).toEqual([]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  test("tracks several jobs independently", async () => {
    const scheduler = manualScheduler();
    const poller = new JobPoller({
      refresh: async (_root, jobId) => job("generating", jobId),
      emit: () => {},
      scheduler
    });

    poller.track("/tmp/project", job("generating", "job-a"));
    poller.track("/tmp/project", job("generating", "job-b"));

    expect(poller.trackedJobIds.sort()).toEqual(["job-a", "job-b"]);
    poller.stopAll();
    expect(poller.trackedJobIds).toEqual([]);
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("the renderer no longer polls", () => {
  test("agent-panel has no setInterval", () => {
    // 修复前 renderer 每 3 秒轮询一次，且随组件卸载而停止——
    // 任务在服务端继续跑，本地却不再跟踪。
    const panel = readFileSync(
      new URL("../src/renderer/src/components/agent-panel.tsx", import.meta.url),
      "utf8"
    );
    // 去掉注释再判断：注释里解释「此前这里有一个 setInterval」是有价值的，
    // 但不能因此放宽对真实代码的检查。
    const code = panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("setInterval");
    expect(code).not.toContain("clearInterval");
    // 改为接收 Utility Process 推送的 video-job 事件。
    expect(code).toContain('event.type === "video-job"');
  });

  test("the poller lives in the utility process", () => {
    const utility = readFileSync(new URL("../src/utility/index.ts", import.meta.url), "utf8");
    expect(utility).toContain("JobPoller");
    // 提交与恢复回来的任务都要接管，否则它们只被查一次就再次失联。
    expect(utility).toContain("trackJob");
  });
});
