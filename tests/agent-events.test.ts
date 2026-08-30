import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { AgentUiEventSchema } from "../src/shared/contracts.js";

const source = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const decodeEvent = Schema.decodeUnknownSync(AgentUiEventSchema);

const sampleJob = {
  id: "job-1",
  providerTaskId: "task-1",
  modelId: "bytedance/seedance-2",
  state: "generating" as const,
  progress: 0.5,
  stage: "生成中",
  outputUrls: [],
  localPaths: [],
  selectedOutputUrl: null,
  selectedLocalPath: null,
  error: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z"
};

describe("video-job events cross the IPC boundary", () => {
  test("the schema accepts a video-job event", () => {
    const event = decodeEvent({ type: "video-job", job: sampleJob });
    expect(event.type).toBe("video-job");
  });

  test("the preload whitelist covers every schema member", () => {
    // 白名单漏一个成员，对应事件会被静默丢弃——不报错，只是永远不到达
    // renderer。这是本轮最容易踩且最难排查的坑，必须由测试守住。
    //
    // 只在 AGENT_EVENT_TYPES 数组内匹配，不在整份文件里搜字符串：
    // 守卫函数体里也出现了 "video-job"，全文搜索会让删掉白名单条目的
    // 改动照样通过（已实测验证过这一点）。
    const preload = source("src/preload/index.ts");
    const whitelist = /const AGENT_EVENT_TYPES = \[([\s\S]*?)\] as const;/.exec(preload)?.[1];
    expect(whitelist, "找不到 AGENT_EVENT_TYPES 白名单").toBeTruthy();

    const members = AgentUiEventSchema.members.map((member) => {
      const literal = (member.fields as { type: { literals: readonly string[] } }).type;
      return literal.literals[0] as string;
    });
    expect(members).toContain("video-job");
    for (const type of members) {
      expect(whitelist, `preload 白名单缺少 ${type}`).toContain(`"${type}"`);
    }
  });

  test("the guard does not demand a requestId from video-job", () => {
    // video-job 由轮询器与启动恢复主动发出，不属于任何一次用户请求，
    // 因此没有 requestId。若沿用统一的 requestId 检查会把它全部挡掉。
    const preload = source("src/preload/index.ts");
    expect(preload).toContain('event.type === "video-job"');
  });

  test("a video-job event carries no requestId", () => {
    // 若将来给它补上 requestId，就必须同步放宽 preload 的分支，
    // 否则又会退回静默丢弃。这里把这个约定固定下来。
    const encoded = Schema.encodeUnknownSync(AgentUiEventSchema)({
      type: "video-job",
      job: sampleJob
    }) as Record<string, unknown>;
    expect(Object.keys(encoded).sort()).toEqual(["job", "type"]);
  });
});
