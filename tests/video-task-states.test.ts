import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  isPollableVideoTaskState,
  isPreSubmitVideoTaskState,
  isRecoverableVideoTaskState,
  isTerminalVideoTaskState,
  POLLABLE_VIDEO_TASK_STATES,
  PRE_SUBMIT_VIDEO_TASK_STATES,
  TERMINAL_VIDEO_TASK_STATES,
  VIDEO_TASK_STATES
} from "../src/shared/video-task-states.js";

const source = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("video task state machine", () => {
  test("declares the two states batch 2 introduces", () => {
    // interrupted / recovering 是启动恢复的分诊入口。
    // 没有它们，重启后悬空的任务只能被粗暴地当作失败。
    expect(VIDEO_TASK_STATES).toContain("interrupted");
    expect(VIDEO_TASK_STATES).toContain("recovering");
  });

  test("partitions every declared state exactly once", () => {
    // 声明了却不属于任何分区的状态，等于没人处理它——
    // 这正是 11 态里有 4 个从未流转过的根因。
    for (const state of VIDEO_TASK_STATES) {
      const memberships = [
        isTerminalVideoTaskState(state),
        isPreSubmitVideoTaskState(state),
        isPollableVideoTaskState(state)
      ].filter(Boolean).length;
      // interrupted 是唯一的例外：它既不是终态、也不在提交前、也不轮询，
      // 而是等待恢复流程分诊的停留点。
      if (state === "interrupted") {
        expect(memberships, state).toBe(0);
        continue;
      }
      expect(memberships, state).toBe(1);
    }
  });

  test("treats interrupted and recovering as recoverable, terminals as not", () => {
    expect(isRecoverableVideoTaskState("interrupted")).toBe(true);
    expect(isRecoverableVideoTaskState("recovering")).toBe(true);
    expect(isRecoverableVideoTaskState("generating")).toBe(true);
    for (const state of TERMINAL_VIDEO_TASK_STATES) {
      expect(isRecoverableVideoTaskState(state), state).toBe(false);
    }
    // 提交前的任务在服务端不存在，恢复流程碰它只会误判为失败。
    for (const state of PRE_SUBMIT_VIDEO_TASK_STATES) {
      expect(isRecoverableVideoTaskState(state), state).toBe(false);
    }
  });

  test("never polls a state that has already finished", () => {
    for (const state of POLLABLE_VIDEO_TASK_STATES) {
      expect(isTerminalVideoTaskState(state), state).toBe(false);
    }
  });

  test("keeps draft and awaiting-approval unused until batch 3", () => {
    // 这两态属于第三批的提交前确认面板。本轮若提前流转它们，
    // 会让恢复流程把「用户还没点提交」的任务判成悬空任务。
    const jobService = source("src/utility/job-service.ts");
    expect(jobService).not.toContain('state: "draft"');
    expect(jobService).not.toContain('state: "awaiting-approval"');
  });
});

describe("single source of truth", () => {
  test("contracts derives the schema instead of re-listing the states", () => {
    // 重新罗列一遍字面量会让 Schema 与判断函数各自演化，
    // 新增状态时必然漏改一侧。
    const contracts = source("src/shared/contracts.ts");
    expect(contracts).toContain("Schema.Literal(...VIDEO_TASK_STATES)");
  });

  test("no consumer keeps its own hardcoded terminal list", () => {
    // 修复前 job-service.ts 与 agent-panel.tsx 各有一份
    // ["completed", "failed", "canceled", "expired"]。
    const hardcoded = /\[\s*"completed",\s*"failed",\s*"canceled",\s*"expired"\s*\]/;
    for (const path of [
      "src/utility/job-service.ts",
      "src/renderer/src/components/agent-panel.tsx"
    ]) {
      expect(hardcoded.test(source(path)), path).toBe(false);
      expect(source(path), path).toContain("isTerminalVideoTaskState");
    }
  });

  test("the state machine module stays dependency-free", () => {
    // renderer 需要在运行时判断状态。若本模块导入 effect，
    // 整个 Schema 运行时会被打进 renderer 包。
    const stateMachine = source("src/shared/video-task-states.ts");
    expect(stateMachine).not.toContain("from \"effect\"");
    expect(stateMachine).not.toContain("import ");
  });
});

// 「interrupted / recovering 真实被使用而非仅声明」由 tests/job-recovery.test.ts 断言：
// 使用它们的是启动恢复流程，在那里验证才有真实上下文。
