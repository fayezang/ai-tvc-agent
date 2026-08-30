/**
 * 视频生成成本估算。
 *
 * 职责有两层：
 *
 * 1. **参数规范化** —— 把脚本给出的请求，对齐到目标模型真正能接受的时长、
 *    分辨率与画幅，并把每一处调整记成一条面向用户的说明。
 * 2. **金额计算** —— 用 orz-pricing 的单价乘以**实际计费秒数**。
 *
 * 第二点是本模块存在的理由。脚本镜头时长与模型可生成时长不是同一概念：
 * Veo 3.1 固定输出 8 秒，脚本要 5 秒时系统会生成 8 秒再裁剪，但 ORZ
 * **按 8 秒计费**。若按脚本时长报价，用户会以为在付 5 秒的钱，
 * 在 ¥20.736/s 下差出 ¥62.2。所以 billedSeconds 与 requestedSeconds
 * 必须分开返回，且 adjustments 要把这件事说清楚。
 *
 * 本模块是纯函数，不发任何网络请求，因此可以在提交前反复调用。
 */

import type { AspectRatio, VideoEstimate, VideoGenerationRequest } from "./contracts.js";
import { MODEL_DEFINITIONS } from "./orz-models.js";
import {
  PRICING_DISCLAIMER,
  PRICING_FETCHED_AT,
  type VideoResolution,
  lookupVideoPrice
} from "./orz-pricing.js";

/** 规范化后真正会发给 ORZ 的参数。 */
export interface NormalizedVideoParams {
  readonly duration: number;
  readonly resolution: VideoResolution;
  readonly aspectRatio: AspectRatio;
  readonly adjustments: readonly string[];
}

const RESOLUTION_ORDER: readonly VideoResolution[] = ["480p", "720p", "1080p"];

/** 金额取整到分。0.576 × 7 一类的乘法会产生 43.199999999999996 这种尾数。 */
const toCents = (value: number): number => Math.round(value * 100) / 100;

/**
 * 把请求对齐到模型能力。
 *
 * 每处调整都记一条说明 —— 规范 §3.5 要求自动模式必须输出「时长取整或画幅降级」，
 * 静默改参数是明确禁止的。
 */
export const normalizeVideoParams = (
  request: Pick<VideoGenerationRequest, "modelId" | "duration" | "resolution" | "aspectRatio">
): NormalizedVideoParams => {
  const definition = MODEL_DEFINITIONS.find((model) => model.id === request.modelId);
  const adjustments: string[] = [];

  if (!definition) {
    return {
      duration: request.duration,
      resolution: request.resolution,
      aspectRatio: request.aspectRatio,
      adjustments: [`模型 ${request.modelId} 未注册，无法校验参数`]
    };
  }

  let duration = request.duration;
  if (definition.durations === "4-15") {
    // 连续区间：只做边界收敛。
    if (duration < 4) {
      duration = 4;
      adjustments.push(`${definition.name} 最短 4 秒，已上调至 4 秒`);
    } else if (duration > 15) {
      duration = 15;
      adjustments.push(`${definition.name} 最长 15 秒，已下调至 15 秒`);
    }
  } else if (!definition.durations.includes(duration)) {
    // 离散档位：取「不短于脚本时长」的最小档，保证素材够裁；
    // 没有更长的档时退回最长档。裁剪由 trimStart / trimEnd 完成，
    // 脚本总时长不因此改变。
    const longerTiers = definition.durations.filter((tier) => tier >= duration);
    const picked = longerTiers.length > 0 ? Math.min(...longerTiers) : Math.max(...definition.durations);
    if (picked > duration) {
      adjustments.push(
        `${definition.name} 时长固定为 ${definition.durations.join(" / ")} 秒，` +
          `将生成 ${picked} 秒后裁剪至脚本要求的 ${duration} 秒；计费按 ${picked} 秒计`
      );
    } else {
      adjustments.push(
        `${definition.name} 最长 ${picked} 秒，短于脚本要求的 ${duration} 秒；` +
          `请拆分该镜头，否则画面时长不足`
      );
    }
    duration = picked;
  }

  let resolution = request.resolution;
  if (!definition.resolutions.includes(resolution)) {
    // 降到该模型支持的最高档，不越级上调 —— 上调会让用户多付钱。
    const supported = RESOLUTION_ORDER.filter((tier) => definition.resolutions.includes(tier));
    const picked = supported[supported.length - 1];
    if (picked) {
      adjustments.push(`${definition.name} 不支持 ${resolution}，已改为 ${picked}`);
      resolution = picked;
    }
  }

  let aspectRatio = request.aspectRatio;
  if (!definition.aspectRatios.includes(aspectRatio)) {
    const picked = definition.aspectRatios[0];
    if (picked) {
      adjustments.push(`${definition.name} 不支持画幅 ${aspectRatio}，已改为 ${picked}`);
      aspectRatio = picked;
    }
  }

  return { duration, resolution, aspectRatio, adjustments };
};

/**
 * 估算一次视频生成的成本。
 *
 * hasReferenceInput 由请求是否带参考图决定。本产品每镜都带静态图，
 * 因此 Seedance 长期走折扣价，确认面板必须让用户看到这个差异。
 */
export const estimateVideoCost = (
  request: Pick<
    VideoGenerationRequest,
    "modelId" | "duration" | "resolution" | "aspectRatio" | "referenceImageUrls"
  >
): VideoEstimate => {
  const normalized = normalizeVideoParams(request);
  const hasReferenceInput = request.referenceImageUrls.length > 0;
  const price = lookupVideoPrice(request.modelId, normalized.resolution, hasReferenceInput);
  const adjustments = [...normalized.adjustments];

  if (price.referenceDiscountUnknown) {
    adjustments.push("该模型的参考图折扣价未收录，实际可能低于此估算");
  }

  const base = {
    modelId: request.modelId,
    currency: "CNY" as const,
    billedSeconds: normalized.duration,
    requestedSeconds: request.duration,
    discounted: price.discounted,
    pricingFetchedAt: PRICING_FETCHED_AT
  };

  if (price.amountPerSecond === null) {
    // 拿不到真实单价就不给金额。按邻近档位近似出来的数字会让用户
    // 依据错误的成本做决策，比不给金额更糟。
    return {
      ...base,
      amount: null,
      amountPerSecond: null,
      adjustments,
      note: `${price.reason ?? "无可用报价"}；无法估算金额，${PRICING_DISCLAIMER}`
    };
  }

  return {
    ...base,
    amount: toCents(price.amountPerSecond * normalized.duration),
    amountPerSecond: price.amountPerSecond,
    adjustments,
    note:
      `按 ${normalized.resolution} ${price.discounted ? "带参考图折扣价" : "原价"} ` +
      `¥${price.amountPerSecond}/秒 × ${normalized.duration} 秒估算` +
      `（价格抓取于 ${PRICING_FETCHED_AT}，${PRICING_DISCLAIMER}）`
  };
};
