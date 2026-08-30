/**
 * 视频任务状态机的单一事实源。
 *
 * 独立成模块而不是写在 contracts.ts 里，是因为 renderer 需要在运行时
 * 判断状态归属。contracts.ts 依赖 effect，把它作为值导入会把整个 Schema
 * 运行时打进 renderer 包；本模块没有任何依赖，三个进程都可以安全导入。
 *
 * contracts.ts 的 VideoTaskStateSchema 由本文件的 VIDEO_TASK_STATES 生成，
 * 因此状态清单只存在一份，不会出现 Schema 与判断逻辑分叉。
 */

export const VIDEO_TASK_STATES = [
  /** 第三批的提交前确认面板会用到，当前不流转。 */
  "draft",
  /** 第三批的提交前确认面板会用到，当前不流转。 */
  "awaiting-approval",
  "uploading",
  "queued",
  "generating",
  /** 应用退出时任务仍在执行，重启后发现它悬着。 */
  "interrupted",
  /** 已发现悬空任务，正在向 ORZ 查询它的真实状态。 */
  "recovering",
  "downloading",
  "validating",
  "completed",
  "failed",
  "canceled",
  "expired"
] as const;

export type VideoTaskState = (typeof VIDEO_TASK_STATES)[number];

/**
 * 已到达终态、不应再向 ORZ 轮询的状态。
 *
 * 此前 job-service 与 agent-panel 各自硬编码了一份清单。状态机的边界
 * 只能有一个定义处，否则新增状态时必然漏改其中一侧。
 */
export const TERMINAL_VIDEO_TASK_STATES: readonly VideoTaskState[] = [
  "completed",
  "failed",
  "canceled",
  "expired"
];

export const isTerminalVideoTaskState = (state: VideoTaskState): boolean =>
  TERMINAL_VIDEO_TASK_STATES.includes(state);

/**
 * 尚未送达 ORZ 的状态：服务端不存在与之对应的任务。
 * 启动恢复必须跳过它们——它们不是"悬空"，只是还没开始。
 */
export const PRE_SUBMIT_VIDEO_TASK_STATES: readonly VideoTaskState[] = ["draft", "awaiting-approval"];

export const isPreSubmitVideoTaskState = (state: VideoTaskState): boolean =>
  PRE_SUBMIT_VIDEO_TASK_STATES.includes(state);

/**
 * 需要持续跟踪的状态。
 *
 * interrupted 不在其中：它是等待恢复流程分诊的停留点，
 * 由恢复流程决定它转向 recovering 还是 failed，轮询器不该直接接手。
 */
export const POLLABLE_VIDEO_TASK_STATES: readonly VideoTaskState[] = [
  "uploading",
  "queued",
  "generating",
  "recovering",
  "downloading",
  "validating"
];

export const isPollableVideoTaskState = (state: VideoTaskState): boolean =>
  POLLABLE_VIDEO_TASK_STATES.includes(state);

/**
 * 应用退出时仍在进行、重启后需要分诊的状态。
 *
 * 等价于「既没到终态、也没停留在提交前」。用补集而非另列一份清单，
 * 保证将来新增中间态时自动被恢复流程覆盖，不会被静默遗漏。
 */
export const isRecoverableVideoTaskState = (state: VideoTaskState): boolean =>
  !isTerminalVideoTaskState(state) && !isPreSubmitVideoTaskState(state);
