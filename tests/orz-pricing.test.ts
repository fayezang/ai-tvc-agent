import { describe, expect, test } from "bun:test";
import { MODEL_DEFINITIONS, ORZ_MODELS } from "../src/shared/orz-models.js";
import {
  PRICING_DISCLAIMER,
  PRICING_FETCHED_AT,
  definedVideoModelIds,
  lookupVideoPrice,
  pricedResolutions,
  pricedVideoModelIds
} from "../src/shared/orz-pricing.js";

describe("ORZ video pricing table", () => {
  test("carries a fetch date and a live-billing disclaimer", () => {
    // 价格随时变动。任何展示金额的界面都要能引用这两个常量，
    // 否则用户无法判断看到的数字有多新。
    expect(PRICING_FETCHED_AT).toBe("2026-08-30");
    expect(PRICING_DISCLAIMER).toContain("ORZ 控制台");
  });

  test("covers exactly the video models the app can submit", () => {
    // 漏一个模型 → 用户能提交一个估不出价的任务。
    // 多一个模型 → 价格表留着已下架模型的报价。
    expect([...pricedVideoModelIds()].sort()).toEqual([...definedVideoModelIds()].sort());
  });

  test("prices Seedance at list rate without references", () => {
    const price = lookupVideoPrice(ORZ_MODELS.seedance, "1080p", false);
    expect(price.amountPerSecond).toBe(4.896);
    expect(price.discounted).toBe(false);
    expect(price.reason).toBeNull();
    expect(price.referenceDiscountUnknown).toBe(false);
  });

  test("applies the documented Seedance reference discount on every tier", () => {
    // 本产品每镜都带静态图作参考，因此这条折扣路径是实际长期走的那条。
    expect(lookupVideoPrice(ORZ_MODELS.seedance, "480p", true).amountPerSecond).toBe(0.576);
    expect(lookupVideoPrice(ORZ_MODELS.seedance, "720p", true).amountPerSecond).toBe(1.296);
    expect(lookupVideoPrice(ORZ_MODELS.seedance, "1080p", true).amountPerSecond).toBe(2.88);
    expect(lookupVideoPrice(ORZ_MODELS.seedance, "720p", true).discounted).toBe(true);
  });

  test("never extrapolates the 40 percent discount to other models", () => {
    // 40% 是从 Seedance 两组数字算出来的实测值，不是 ORZ 通用系数。
    // Kling 的折扣价规范未收录 → 用原价，并标记折扣未知。
    const kling = lookupVideoPrice(ORZ_MODELS.kling, "720p", true);
    expect(kling.amountPerSecond).toBe(2.09);
    expect(kling.discounted).toBe(false);
    expect(kling.referenceDiscountUnknown).toBe(true);

    const kling1080 = lookupVideoPrice(ORZ_MODELS.kling, "1080p", true);
    expect(kling1080.amountPerSecond).toBe(3.46);
    expect(kling1080.referenceDiscountUnknown).toBe(true);
  });

  test("returns null instead of guessing when a tier has no published price", () => {
    const kling = lookupVideoPrice(ORZ_MODELS.kling, "480p", false);
    expect(kling.amountPerSecond).toBeNull();
    expect(typeof kling.reason).toBe("string");
    expect(kling.reason).toContain("480p");
  });

  test("keeps the missing 480p tier out of any numeric fallback", () => {
    // 断言它不是「恰好等于别的档位」——近似填数是本项目明令禁止的。
    for (const withReference of [true, false]) {
      expect(lookupVideoPrice(ORZ_MODELS.kling, "480p", withReference).amountPerSecond).toBeNull();
    }
  });

  test("separates what a model accepts from what ORZ prices", () => {
    // Kling 的能力档与价格档都是 720p / 1080p，此处确认查表只返回可计价的档；
    // Seedance 三档齐全。模型能接受的入参与 ORZ 对哪些档报价是两件独立的事。
    const klingDefinition = MODEL_DEFINITIONS.find((model) => model.id === ORZ_MODELS.kling);
    expect(klingDefinition?.resolutions).not.toContain("480p");
    expect(pricedResolutions(ORZ_MODELS.kling)).toEqual(["720p", "1080p"]);
    expect(pricedResolutions(ORZ_MODELS.seedance)).toEqual(["480p", "720p", "1080p"]);
  });

  test("reports an unknown model instead of throwing", () => {
    // 已下架的 Hailuo、Veo 与任何拼错的 ID 都走这条路径：
    // 估价环节不该因为一个未知模型崩掉整个确认流程。
    for (const retired of ["minimax/hailuo-2-3", "google/veo-3-1"]) {
      const removed = lookupVideoPrice(retired, "1080p", true);
      expect(removed.amountPerSecond).toBeNull();
      expect(removed.reason).toContain("未收录");
      expect(pricedResolutions(retired)).toEqual([]);
    }
  });

  test("keeps 1080p meaningfully more expensive than 720p on Seedance", () => {
    // 支撑第三批把默认分辨率从 1080p 降到 720p 的那个判断：单价差约 2.2 倍。
    const tier720 = lookupVideoPrice(ORZ_MODELS.seedance, "720p", true).amountPerSecond ?? 0;
    const tier1080 = lookupVideoPrice(ORZ_MODELS.seedance, "1080p", true).amountPerSecond ?? 0;
    expect(tier1080 / tier720).toBeGreaterThan(2);
  });
});
