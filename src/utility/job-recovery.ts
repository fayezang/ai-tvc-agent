/**
 * 启动恢复：把上次运行遗留的悬空任务重新纳入跟踪。
 *
 * 应用退出时正在执行的任务，在数据库里会永远停在 generating 之类的中间态。
 * 服务端那边任务照常跑完，本地却再也不会去看一眼——用户付了钱，视频却
 * 不会出现在项目里。
 *
 * 本模块只做数据库层面的分诊，不发任何网络请求。这样做有两个理由：
 * 1. 打开项目不能被 ORZ 的响应速度拖住，分诊必须是同步且快速的；
 * 2. 分诊逻辑因此可以用 bun:sqlite 做真实建库测试（better-sqlite3 的
 *    原生模块按 Electron ABI 编译，在 bun/node 下加载即崩溃）。
 *
 * 真正的状态查询由 JobService 在分诊之后异步进行。
 */

import { isRecoverableVideoTaskState, type VideoTaskState } from "../shared/video-task-states.js";

/** 最小 SQLite 接口，避免本模块直接依赖 better-sqlite3 类型。 */
export interface RecoveryDatabase {
  prepare(sql: string): {
    all(...params: readonly unknown[]): unknown[];
    run(...params: readonly unknown[]): unknown;
  };
}

interface DanglingRow {
  id: string;
  provider_task_id: string | null;
  state: VideoTaskState;
}

export interface TriageResult {
  /** 有 provider_task_id、可以向 ORZ 查询真实状态的任务。 */
  readonly recovering: readonly string[];
  /** 提交时就崩了，服务端没有这个任务，只能判失败并允许重试。 */
  readonly failed: readonly string[];
  /**
   * 已知悬空但当前无法查询（缺少 API Key）的任务，停留在 interrupted。
   * 不把它们写成 recovering，是因为没有任何查询正在进行——
   * 那会是一个凭空捏造的进行中状态。
   */
  readonly interrupted: readonly string[];
}

/**
 * 找出所有非终态、且已经越过提交前阶段的任务。
 *
 * 用「非终态」的补集而不是列举中间态：将来新增中间态时会自动被覆盖，
 * 不会因为漏加一个字面量而让某类任务永远失联。
 */
export const findDanglingJobs = (database: RecoveryDatabase): DanglingRow[] => {
  const rows = database
    .prepare("SELECT id, provider_task_id, state FROM video_jobs")
    .all() as DanglingRow[];
  return rows.filter((row) => isRecoverableVideoTaskState(row.state));
};

const setState = (
  database: RecoveryDatabase,
  jobId: string,
  state: VideoTaskState,
  stage: string,
  errorJson: string | null,
  now: string
): void => {
  database
    .prepare(
      `UPDATE video_jobs SET state = ?, stage = ?, error_json = ?, updated_at = ?,
         revision = revision + 1
       WHERE id = ?`
    )
    .run(state, stage, errorJson, now, jobId);
};

/**
 * 分诊悬空任务，返回各组的 jobId。
 *
 * 每一步都立即落库，而不是先在内存里算完再一次性写入：
 * 分诊过程本身也可能被中断，落库后即使再次崩溃，下次启动看到的
 * 仍是当时的真实状态。
 *
 * @param canQueryProvider 是否具备向 ORZ 查询的条件（即有无 API Key）。
 *   为 false 时有 provider_task_id 的任务停在 interrupted，不谎称在恢复。
 */
export const triageDanglingJobs = (
  database: RecoveryDatabase,
  options: { canQueryProvider: boolean; now?: string }
): TriageResult => {
  const now = options.now ?? new Date().toISOString();
  const dangling = findDanglingJobs(database);
  const recovering: string[] = [];
  const failed: string[] = [];
  const interrupted: string[] = [];

  for (const row of dangling) {
    // 先统一标记 interrupted：这是对已经发生的事实的记录——
    // 上次运行没能把它跑完。后续分支再从这里出发。
    setState(
      database,
      row.id,
      "interrupted",
      "上次运行结束时该任务仍在进行，正在确认它的真实状态",
      null,
      now
    );

    if (!row.provider_task_id) {
      // 没有 provider_task_id 意味着提交请求还没拿到回执就崩了。
      // 服务端不存在这个任务，查询无从查起，也不该重新提交——
      // 那会产生一次用户没有授权的真实计费。
      setState(
        database,
        row.id,
        "failed",
        "提交未完成",
        JSON.stringify({
          code: "VIDEO_JOB_INTERRUPTED_BEFORE_SUBMIT",
          message: "上次提交在收到 ORZ 回执前中断，服务端没有这个任务。可以安全地重新提交。",
          retryable: true
        }),
        now
      );
      failed.push(row.id);
      continue;
    }

    if (!options.canQueryProvider) {
      interrupted.push(row.id);
      continue;
    }

    setState(database, row.id, "recovering", "正在向 ORZ 查询该任务的真实状态", null, now);
    recovering.push(row.id);
  }

  return { recovering, failed, interrupted };
};
