import type {
  ModelDefinition,
  ProviderVideoRouting,
  VideoGenerationRequest
} from "./contracts.js";

export const ORZ_BASE_URL = "https://orz.sh/api/proxy/v1";
export const ORZ_TOP_UP_URL = "https://orz.sh/dashboard/topup";

export const ORZ_MODELS = {
  deepseekR2: "deepseek/deepseek-r2",
  geminiFlashLite: "google/gemini-3-1-flash-lite",
  geminiFlash: "google/gemini-2-5-flash",
  kling: "kuaishou/kling-2-5-turbo",
  seedance: "bytedance/seedance-2",
  storyboard: "google/gemini-image-3-1",
  gptImageLow: "openai/gpt-image-2-low",
  gptImageMedium: "openai/gpt-image-2-medium",
  gptImageHigh: "openai/gpt-image-2-high"
} as const;

export interface OrzModelOption {
  id: string;
  name: string;
  description: string;
}

export const TEXT_MODEL_OPTIONS: readonly OrzModelOption[] = [
  {
    id: ORZ_MODELS.geminiFlashLite,
    name: "Gemini 3.1 Flash Lite",
    description: "低成本默认 · 已验证"
  },
  {
    id: ORZ_MODELS.geminiFlash,
    name: "Gemini 2.5 Flash",
    description: "稳定通用文本"
  }
] as const;

export const IMAGE_MODEL_OPTIONS: readonly OrzModelOption[] = [
  {
    id: ORZ_MODELS.gptImageLow,
    name: "GPT-Image 2 Low",
    description: "低成本测试默认"
  },
  {
    id: ORZ_MODELS.storyboard,
    name: "Gemini Image 3.1",
    description: "高质量静态分镜"
  },
  {
    id: ORZ_MODELS.gptImageMedium,
    name: "GPT-Image 2 Medium",
    description: "质量与成本平衡"
  },
  {
    id: ORZ_MODELS.gptImageHigh,
    name: "GPT-Image 2 High",
    description: "高质量关键帧"
  }
] as const;

export const DEFAULT_VIDEO_MODEL_ROUTING: ProviderVideoRouting = {
  hook: ORZ_MODELS.seedance,
  reveal: ORZ_MODELS.seedance,
  proof: ORZ_MODELS.seedance,
  cta: ORZ_MODELS.seedance
};

export const DEFAULT_PROVIDER_MODELS = {
  textModelId: ORZ_MODELS.geminiFlashLite,
  imageModelId: ORZ_MODELS.gptImageLow,
  videoModelRouting: DEFAULT_VIDEO_MODEL_ROUTING
} as const;

export type ShotRole = VideoGenerationRequest["role"];

export const SHOT_ROLE_MODEL: Readonly<Record<ShotRole, string>> = {
  ...DEFAULT_VIDEO_MODEL_ROUTING,
  "emotional-proof": DEFAULT_VIDEO_MODEL_ROUTING.cta,
  other: DEFAULT_VIDEO_MODEL_ROUTING.cta
};

export const resolveVideoModelForRole = (
  role: ShotRole,
  routing: ProviderVideoRouting = DEFAULT_VIDEO_MODEL_ROUTING
): string => {
  if (role === "emotional-proof") return routing.cta;
  if (role === "other") return routing.cta;
  return routing[role];
};

/**
 * 最终整片必须一次生成项目的精确时长。离散档位不匹配时不能向上取整后再
 * 假装稍后裁剪；在报价和建待确认任务之前就明确拒绝。
 */
export const assertExactVideoDuration = (modelId: string, duration: number): void => {
  const definition = MODEL_DEFINITIONS.find((model) => model.id === modelId && model.media === "video");
  if (!definition) return;
  const supported = definition.durations === "4-15"
    ? duration >= 4 && duration <= 15
    : definition.durations.includes(duration);
  if (!supported) {
    const range = definition.durations === "4-15"
      ? "4–15 秒内的任意整秒"
      : `${definition.durations.join(" / ")} 秒`;
    throw new Error(
      `${definition.name} 不支持项目要求的精确 ${duration} 秒整片时长（支持 ${range}）。` +
        "请在报价前更换支持该时长的模型。"
    );
  }
};

export const MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  {
    id: ORZ_MODELS.kling,
    name: "Kling 2.5 Turbo",
    provider: "ORZ",
    media: "video",
    durations: [5, 10],
    resolutions: ["720p", "1080p"],
    aspectRatios: ["16:9", "9:16", "1:1"]
  },
  {
    id: ORZ_MODELS.seedance,
    name: "Seedance 2",
    provider: "ORZ",
    media: "video",
    durations: "4-15",
    resolutions: ["480p", "720p", "1080p"],
    aspectRatios: ["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"]
  },
  {
    id: ORZ_MODELS.storyboard,
    name: "Gemini Image 3.1",
    provider: "ORZ",
    media: "image",
    durations: [],
    resolutions: ["1080p"],
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"]
  }
] as const;

export const VIDEO_MODEL_OPTIONS: readonly OrzModelOption[] = MODEL_DEFINITIONS
  .filter((model) => model.media === "video")
  .map((model) => ({
    id: model.id,
    name: model.name,
    description:
      model.id === ORZ_MODELS.kling
        ? "动作与快速运镜 · 5/10 秒"
        : "低成本测试默认 · 4–15 秒"
  }));
