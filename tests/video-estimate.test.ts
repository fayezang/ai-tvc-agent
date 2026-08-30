import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { VideoGenerationRequest } from "../src/shared/contracts.js";
import { ORZ_MODELS } from "../src/shared/orz-models.js";
import { PRICING_FETCHED_AT } from "../src/shared/orz-pricing.js";
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

  test("bills Veo for the full eight seconds it always generates", () => {
    // 本批最容易被漏掉、也最伤用户信任的一条：
    // 脚本要 5 秒，Veo 固定输出 8 秒，ORZ 按 8 秒计费。
    // 若按脚本时长报价，用户以为付 ¥103.68，实际付 ¥165.89。
    const estimate = estimateVideoCost(
      request({ modelId: ORZ_MODELS.veo, duration: 5, resolution: "720p" })
    );
    expect(estimate.requestedSeconds).toBe(5);
    expect(estimate.billedSeconds).toBe(8);
    expect(estimate.amount).toBe(165.89);
    expect(estimate.adjustments.join(" ")).toContain("计费按 8 秒计");
    expect(estimate.adjustments.join(" ")).toContain("裁剪至脚本要求的 5 秒");
  });

  test("picks the smallest tier that still covers the shot", () => {
    // Kling 有 5 与 10 两档。脚本要 7 秒 → 取 10 秒再裁，不取 5 秒。
    // 取更短的档会让画面时长不够，是静默损坏内容。
    const normalized = normalizeVideoParams({
      modelId: ORZ_MODELS.kling,
      duration: 7,
      resolution: "720p",
      aspectRatio: "16:9"
    });
    expect(normalized.duration).toBe(10);
    expect(normalized.adjustments.join(" ")).toContain("计费按 10 秒计");
  });

  test("warns instead of silently truncating when no tier is long enough", () => {
    // 脚本要 15 秒但 Kling 最长 10 秒 —— 这时无法靠裁剪解决，
    // 必须提示拆分镜头，不能假装没事。
    const normalized = normalizeVideoParams({
      modelId: ORZ_MODELS.kling,
      duration: 15,
      resolution: "720p",
      aspectRatio: "16:9"
    });
    expect(normalized.duration).toBe(10);
    expect(normalized.adjustments.join(" ")).toContain("请拆分该镜头");
  });

  test("clamps Seedance to its four-to-fifteen-second window", () => {
    expect(
      normalizeVideoParams({
        modelId: ORZ_MODELS.seedance,
        duration: 2,
        resolution: "720p",
        aspectRatio: "16:9"
      }).duration
    ).toBe(4);
    const tooLong = normalizeVideoParams({
      modelId: ORZ_MODELS.seedance,
      duration: 20,
      resolution: "720p",
      aspectRatio: "16:9"
    });
    expect(tooLong.duration).toBe(15);
    expect(tooLong.adjustments.join(" ")).toContain("最长 15 秒");
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

  test("returns a null amount when the resolution has no published price", () => {
    // Veo 接受 480p 入参但 ORZ 未对该档报价。规范化不会改它的分辨率
    // （模型确实支持），因此这里必须靠价格表返回 null。
    const estimate = estimateVideoCost(
      request({ modelId: ORZ_MODELS.veo, duration: 8, resolution: "480p" })
    );
    expect(estimate.amount).toBeNull();
    expect(estimate.amountPerSecond).toBeNull();
    expect(estimate.note).toContain("未对该档报价");
    // 秒数仍然要如实报告 —— 金额未知不代表时长未知。
    expect(estimate.billedSeconds).toBe(8);
  });

  test("never throws on an unregistered model", () => {
    // 估价环节崩掉会挡住整个确认流程，比给不出金额严重得多。
    const estimate = estimateVideoCost(request({ modelId: "minimax/hailuo-2-3" }));
    expect(estimate.amount).toBeNull();
    expect(estimate.adjustments.join(" ")).toContain("未注册");
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
