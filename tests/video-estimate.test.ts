import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { VideoGenerationRequest } from "../src/shared/contracts.js";
import { MODEL_DEFINITIONS, ORZ_MODELS } from "../src/shared/orz-models.js";
import { PRICING_FETCHED_AT, pricedResolutions } from "../src/shared/orz-pricing.js";
import { estimateVideoCost, normalizeVideoParams } from "../src/shared/video-estimate.js";

const request = (overrides: Partial<VideoGenerationRequest>): VideoGenerationRequest => ({
  projectRoot: "/tmp/project",
  shotId: "shot-1",
  role: "other",
  modelId: ORZ_MODELS.seedance,
  prompt: "A precise product shot",
  duration: 5,
  aspectRatio: "16:9",
  resolution: "720p",
  referenceImageUrls: [],
  referenceVideoUrls: [],
  referenceAudioUrls: [],
  generateAudio: false,
  ...overrides
});

describe("video cost estimation", () => {
  test("multiplies the per-second rate by the billed duration", () => {
    const estimate = estimateVideoCost(
      request({ resolution: "720p", duration: 10, referenceImageUrls: [] })
    );
    expect(estimate.amountPerSecond).toBe(2.16);
    expect(estimate.billedSeconds).toBe(10);
    expect(estimate.amount).toBe(21.6);
    expect(estimate.currency).toBe("CNY");
    expect(estimate.pricingFetchedAt).toBe(PRICING_FETCHED_AT);
  });

  test("rounds money to cents instead of leaking float noise", () => {
    // 2.88 × 15 在 IEEE 754 下是 43.199999999999996。
    // 确认面板上必须是 ¥43.2，不能是一串小数。
    const estimate = estimateVideoCost(
      request({
        resolution: "1080p",
        duration: 15,
        referenceImageUrls: ["https://example.com/frame.png"]
      })
    );
    expect(estimate.amountPerSecond).toBe(2.88);
    expect(estimate.amount).toBe(43.2);

    // 2.16 × 15 = 32.400000000000006
    const listPrice = estimateVideoCost(request({ resolution: "720p", duration: 15 }));
    expect(listPrice.amount).toBe(32.4);
  });

  test("blocks an inexact duration instead of quoting a longer tier", () => {
    expect(() => estimateVideoCost(
      request({ modelId: ORZ_MODELS.kling, duration: 7, resolution: "720p" })
    )).toThrow("不支持项目要求的精确 7 秒");
  });

  test("never rounds a discrete duration up", () => {
    const normalized = normalizeVideoParams({
      modelId: ORZ_MODELS.kling,
      duration: 7,
      resolution: "720p",
      aspectRatio: "16:9"
    });
    expect(normalized.duration).toBe(7);
    expect(normalized.adjustments.join(" ")).toContain("不会向上取整");
  });

  test("never truncates when no exact tier exists", () => {
    const normalized = normalizeVideoParams({
      modelId: ORZ_MODELS.kling,
      duration: 15,
      resolution: "720p",
      aspectRatio: "16:9"
    });
    expect(normalized.duration).toBe(15);
    expect(normalized.adjustments.join(" ")).toContain("必须更换模型");
  });

  test("does not clamp Seedance outside its supported window", () => {
    expect(
      normalizeVideoParams({
        modelId: ORZ_MODELS.seedance,
        duration: 2,
        resolution: "720p",
        aspectRatio: "16:9"
      }).duration
    ).toBe(2);
    const tooLong = normalizeVideoParams({
      modelId: ORZ_MODELS.seedance,
      duration: 20,
      resolution: "720p",
      aspectRatio: "16:9"
    });
    expect(tooLong.duration).toBe(20);
    expect(tooLong.adjustments.join(" ")).toContain("不会调整时长");
  });

  test("downgrades an unsupported resolution and says so", () => {
    // Kling 不支持 480p。降到它支持的最高档，并明确告知。
    const normalized = normalizeVideoParams({
      modelId: ORZ_MODELS.kling,
      duration: 5,
      resolution: "480p",
      aspectRatio: "16:9"
    });
    expect(normalized.resolution).toBe("1080p");
    expect(normalized.adjustments.join(" ")).toContain("不支持 480p");
  });

  test("downgrades an unsupported aspect ratio and says so", () => {
    // Kling 只支持 16:9 / 9:16 / 1:1。
    const normalized = normalizeVideoParams({
      modelId: ORZ_MODELS.kling,
      duration: 5,
      resolution: "720p",
      aspectRatio: "21:9"
    });
    expect(normalized.aspectRatio).toBe("16:9");
    expect(normalized.adjustments.join(" ")).toContain("不支持画幅 21:9");
  });

  test("applies the Seedance reference discount when the shot carries a still", () => {
    // 本产品每镜都带静态图作参考，这是实际长期走的那条路径。
    const withReference = estimateVideoCost(
      request({
        resolution: "720p",
        duration: 8,
        referenceImageUrls: ["https://example.com/frame.png"]
      })
    );
    expect(withReference.discounted).toBe(true);
    expect(withReference.amount).toBe(10.37);
    expect(withReference.note).toContain("带参考图折扣价");

    const withoutReference = estimateVideoCost(
      request({ resolution: "720p", duration: 8, referenceImageUrls: [] })
    );
    expect(withoutReference.discounted).toBe(false);
    expect(withoutReference.amount).toBe(17.28);
  });

  test("flags an unknown reference discount rather than implying the list price is final", () => {
    const estimate = estimateVideoCost(
      request({
        modelId: ORZ_MODELS.kling,
        duration: 10,
        resolution: "720p",
        referenceImageUrls: ["https://example.com/frame.png"]
      })
    );
    expect(estimate.discounted).toBe(false);
    expect(estimate.amount).toBe(20.9);
    expect(estimate.adjustments.join(" ")).toContain("折扣价未收录");
  });

  test("downgrades rather than quoting a tier ORZ has no price for", () => {
    // Kling 不支持 480p，规范化会把它降到 1080p，因此估价拿得到真实金额。
    // 这条同时守住一个不变量：当前模型集合里，凡是模型接受的分辨率
    // ORZ 都有报价。将来若加入「能接受但无报价」的模型，
    // normalizeVideoParams 不会改它的分辨率，金额就会变成 null —— 那时
    // 确认面板必须能显示「无法估算」，本条会先在这里失败提醒。
    const estimate = estimateVideoCost(
      request({ modelId: ORZ_MODELS.kling, duration: 10, resolution: "480p" })
    );
    expect(estimate.adjustments.join(" ")).toContain("不支持 480p");
    expect(estimate.amount).not.toBeNull();

    for (const model of MODEL_DEFINITIONS.filter((entry) => entry.media === "video")) {
      expect([...pricedResolutions(model.id)].sort()).toEqual([...model.resolutions].sort());
    }
  });

  test("never throws on an unregistered model", () => {
    // 估价环节崩掉会挡住整个确认流程，比给不出金额严重得多。
    // 已下架的 Hailuo 与 Veo 都走这条路径。
    for (const retired of ["minimax/hailuo-2-3", "google/veo-3-1"]) {
      const estimate = estimateVideoCost(request({ modelId: retired }));
      expect(estimate.amount).toBeNull();
      expect(estimate.amountPerSecond).toBeNull();
      expect(estimate.adjustments.join(" ")).toContain("未注册");
    }
  });

  test("submits exactly the parameters it quoted", () => {
    // 报价与提交必须共用同一套规范化。否则会出现「按 8 秒报了价，
    // 却拿 5 秒去提交」，被 Adapter 的 assertModel 直接拒掉。
    //
    // 规范化落在 JobService.submit —— 它是所有提交路径的唯一入口，
    // retry 也复用它。放在 IPC 分支那层会漏掉从 retry 进来的请求。
    const jobService = readFileSync(
      new URL("../src/utility/job-service.ts", import.meta.url),
      "utf8"
    );
    expect(jobService).toContain("normalizeVideoParams(incoming)");
    expect(jobService).toContain("duration: normalized.duration");
    expect(jobService).toContain("resolution: normalized.resolution");
    expect(jobService).toContain("aspectRatio: normalized.aspectRatio");

    // 旧的占位实现必须彻底消失。
    const utility = readFileSync(new URL("../src/utility/index.ts", import.meta.url), "utf8");
    expect(utility).not.toContain("尚未接入价格表");
  });
});
