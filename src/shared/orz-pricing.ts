/**
 * ORZ 视频模型价格表。
 *
 * 数据来源：Notion《现成能力调用规范 v2（ORZ 底座）》§3.4，口径 1 积分 ≈ ¥0.072。
 * ORZ 按秒计费、人民币计价。
 *
 * 两条硬规则贯穿本模块：
 *
 * 1. **模型无该分辨率的价格档时返回 null 并说明原因，绝不用邻近档位近似。**
 *    近似出来的金额会让用户按错误的数字做决策，比不给金额更糟。
 *
 * 2. **参考图折扣只按规范明确给出的数字生效。** 规范在 Seedance 上给了三档折扣价
 *    （由此算得约便宜 40%），但 Kling 没有给。40% 是 Seedance 的实测结果，
 *    不是 ORZ 的通用系数，不能外推到别的模型。
 *
 * 价格随时可能变动，任何展示金额的界面都必须同时展示 PRICING_FETCHED_AT，
 * 并说明以 ORZ 控制台实时计费为准。
 */

import { MODEL_DEFINITIONS, ORZ_MODELS } from "./orz-models.js";

/** 价格抓取日期。展示金额的地方必须一并展示它。 */
export const PRICING_FETCHED_AT = "2026-08-30";

/** 展示金额时必须附带的口径说明。 */
export const PRICING_DISCLAIMER = "以 ORZ 控制台实时计费为准";

export type VideoResolution = "480p" | "720p" | "1080p";

/**
 * 单一分辨率档的报价，单位为元／秒。
 *
 * `list` 为原价。`withReference` 仅在规范明确给出折扣价时填写，否则为 null，
 * 表示「该模型的参考图折扣未收录」而非「没有折扣」——实际可能更便宜。
 */
interface ResolutionPrice {
  readonly list: number;
  readonly withReference: number | null;
}

interface ModelPricing {
  readonly modelId: string;
  /** 未列出的分辨率即无价格档。注意它与模型能否接受该入参是两件事。 */
  readonly perSecond: Partial<Record<VideoResolution, ResolutionPrice>>;
  /**
   * 该模型没有某些分辨率价格档的原因，用于 lookupVideoPrice 的 reason。
   * 措辞面向用户，会直接出现在确认面板上。
   */
  readonly missingReason: string;
}

/**
 * Kling 的特殊之处：ORZ 只对 720p 与 1080p 报价，没有 480p 档。
 *
 * 模型能接受哪些入参、与 ORZ 对哪些档报价，是两件独立的事，必须分别建模。
 * 否则查表会误以为「模型支持该分辨率 ⇒ 一定查得到价」。
 */
const PRICING: readonly ModelPricing[] = [
  {
    modelId: ORZ_MODELS.seedance,
    perSecond: {
      "480p": { list: 1.008, withReference: 0.576 },
      "720p": { list: 2.16, withReference: 1.296 },
      "1080p": { list: 4.896, withReference: 2.88 }
    },
    missingReason: ""
  },
  {
    modelId: ORZ_MODELS.kling,
    perSecond: {
      "720p": { list: 2.09, withReference: null },
      "1080p": { list: 3.46, withReference: null }
    },
    missingReason: "Kling 2.5-turbo 无 480p 档位"
  }
];

const byModelId = new Map(PRICING.map((entry) => [entry.modelId, entry]));

export interface PriceLookup {
  /** 元／秒。拿不到真实报价时为 null，此时 reason 必有值。 */
  readonly amountPerSecond: number | null;
  /** 是否用了参考图折扣价。amountPerSecond 为 null 时恒为 false。 */
  readonly discounted: boolean;
  /** 无报价的原因。有报价时为 null。 */
  readonly reason: string | null;
  /**
   * 该模型带参考图时是否可能比返回值更便宜。
   *
   * Kling 的折扣价规范未收录，此时返回原价并置本标志，
   * 确认面板据此提示「实际可能更低」，而不是让用户以为原价就是终价。
   */
  readonly referenceDiscountUnknown: boolean;
}

/**
 * 查某模型某分辨率的每秒单价。
 *
 * hasReferenceInput 表示本次请求是否带参考图。本产品每镜都带静态图作参考，
 * 因此 Seedance 实际长期走折扣价——确认面板必须让用户看到这个差异。
 */
export const lookupVideoPrice = (
  modelId: string,
  resolution: VideoResolution,
  hasReferenceInput: boolean
): PriceLookup => {
  const pricing = byModelId.get(modelId);
  if (!pricing) {
    return {
      amountPerSecond: null,
      discounted: false,
      reason: `价格表未收录模型 ${modelId}`,
      referenceDiscountUnknown: false
    };
  }

  const tier = pricing.perSecond[resolution];
  if (!tier) {
    return {
      amountPerSecond: null,
      discounted: false,
      reason: pricing.missingReason || `${modelId} 无 ${resolution} 价格档`,
      referenceDiscountUnknown: false
    };
  }

  if (hasReferenceInput && tier.withReference !== null) {
    return {
      amountPerSecond: tier.withReference,
      discounted: true,
      reason: null,
      referenceDiscountUnknown: false
    };
  }

  return {
    amountPerSecond: tier.list,
    discounted: false,
    reason: null,
    // 带了参考图却没有折扣价可用 —— 说明这个模型的折扣未收录，不是没有折扣。
    referenceDiscountUnknown: hasReferenceInput && tier.withReference === null
  };
};

/** 该模型有报价的分辨率档，供 UI 只展示可计价的选项。 */
export const pricedResolutions = (modelId: string): readonly VideoResolution[] => {
  const pricing = byModelId.get(modelId);
  if (!pricing) return [];
  return (["480p", "720p", "1080p"] as const).filter((resolution) => pricing.perSecond[resolution]);
};

/**
 * 价格表覆盖的模型集合必须与 MODEL_DEFINITIONS 中的视频模型完全一致。
 *
 * 漏一个模型意味着用户能提交一个我们估不出价的任务；多一个意味着价格表里
 * 留着已下架模型的报价。由测试守住，避免两处清单各自演化。
 */
export const pricedVideoModelIds = (): readonly string[] => PRICING.map((entry) => entry.modelId);

export const definedVideoModelIds = (): readonly string[] =>
  MODEL_DEFINITIONS.filter((model) => model.media === "video").map((model) => model.id);
