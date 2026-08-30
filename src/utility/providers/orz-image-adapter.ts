import { IMAGE_MODEL_OPTIONS, ORZ_MODELS } from "../../shared/orz-models.js";
import type { OrzGenerationPayload } from "./orz-adapters.js";

export interface StoryboardImageRequest {
  shotId: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  referenceImageUrls: readonly string[];
  count: 1 | 2 | 3 | 4;
  outputFormat: "png" | "jpeg" | "webp";
}

const imageVersions: Readonly<Record<string, string>> = {
  [ORZ_MODELS.storyboard]: "3.1",
  [ORZ_MODELS.gptImageLow]: "image2_low",
  [ORZ_MODELS.gptImageMedium]: "image2_medium",
  [ORZ_MODELS.gptImageHigh]: "image2_high"
};

export const buildStoryboardImagePayload = (
  request: StoryboardImageRequest,
  modelId: string = ORZ_MODELS.storyboard
): OrzGenerationPayload => {
  if (!request.prompt.trim()) throw new Error(`镜头 ${request.shotId} 缺少静态分镜提示词`);
  if (!IMAGE_MODEL_OPTIONS.some((model) => model.id === modelId)) {
    throw new Error(`ORZ 图片 Provider Adapter 未注册模型：${modelId}`);
  }
  const references = request.referenceImageUrls.slice(0, 9);
  return {
    model: modelId,
    input: {
      prompt: request.prompt,
      version: imageVersions[modelId],
      aspect_ratio: request.aspectRatio,
      n: request.count,
      output_format: request.outputFormat,
      storage_mode: "Temporary",
      ...(modelId.startsWith("openai/gpt-image-2-") ? { input_fidelity: "high" } : {}),
      ...(references[0] ? { image_url: references[0] } : {}),
      ...(references.length > 1 ? { image_urls: references } : {}),
      ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {})
    }
  };
};
