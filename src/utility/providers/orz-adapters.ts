import type { VideoGenerationRequest } from "../../shared/contracts.js";
import { MODEL_DEFINITIONS, ORZ_MODELS } from "../../shared/orz-models.js";

export interface OrzGenerationPayload {
  model: string;
  input: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly modelId: string;
  build(request: VideoGenerationRequest): OrzGenerationPayload;
}

const assertModel = (request: VideoGenerationRequest, modelId: string): void => {
  if (request.modelId !== modelId) throw new Error(`Adapter ${modelId} 无法处理 ${request.modelId}`);
  const definition = MODEL_DEFINITIONS.find((item) => item.id === modelId);
  if (!definition) throw new Error(`未注册模型：${modelId}`);
  if (!definition.aspectRatios.includes(request.aspectRatio)) {
    throw new Error(`${definition.name} 不支持画幅 ${request.aspectRatio}`);
  }
  if (!definition.resolutions.includes(request.resolution)) {
    throw new Error(`${definition.name} 不支持分辨率 ${request.resolution}`);
  }
  if (definition.durations !== "4-15" && !definition.durations.includes(request.duration)) {
    throw new Error(`${definition.name} 不支持 ${request.duration} 秒时长`);
  }
};

const optionalCommon = (request: VideoGenerationRequest): Record<string, unknown> => ({
  ...(request.negativePrompt ? { negative_prompt: request.negativePrompt } : {}),
  ...(request.seed === undefined ? {} : { seed: request.seed })
});

class KlingAdapter implements ProviderAdapter {
  readonly modelId = ORZ_MODELS.kling;

  build(request: VideoGenerationRequest): OrzGenerationPayload {
    assertModel(request, this.modelId);
    const images = request.referenceImageUrls;
    return {
      model: this.modelId,
      input: {
        prompt: request.prompt,
        version: "2.5-turbo",
        duration: request.duration,
        aspect_ratio: request.aspectRatio,
        resolution: request.resolution.toUpperCase(),
        generate_audio: request.generateAudio,
        ...(images[0] ? { image_url: images[0] } : {}),
        ...(images.length > 1 ? { image_urls: images.slice(0, 3), usage: "Reference" } : {}),
        ...(images.length === 1 ? { usage: "FirstFrame" } : {}),
        ...optionalCommon(request)
      }
    };
  }
}

class SeedanceAdapter implements ProviderAdapter {
  readonly modelId = ORZ_MODELS.seedance;

  build(request: VideoGenerationRequest): OrzGenerationPayload {
    assertModel(request, this.modelId);
    return {
      model: this.modelId,
      input: {
        prompt: request.prompt,
        duration: request.duration,
        aspect_ratio: request.aspectRatio,
        resolution: request.resolution,
        generate_audio: request.generateAudio,
        web_search: false,
        ...(request.referenceImageUrls.length > 0
          ? { reference_image_urls: request.referenceImageUrls.slice(0, 9) }
          : {}),
        ...(request.referenceVideoUrls.length > 0
          ? { reference_video_urls: request.referenceVideoUrls.slice(0, 3) }
          : {}),
        ...(request.referenceAudioUrls.length > 0
          ? { reference_audio_urls: request.referenceAudioUrls.slice(0, 3) }
          : {}),
        ...optionalCommon(request)
      }
    };
  }
}

const registry = new Map<string, ProviderAdapter>([
  [ORZ_MODELS.kling, new KlingAdapter()],
  [ORZ_MODELS.seedance, new SeedanceAdapter()]
]);

export const resolveOrzAdapter = (modelId: string): ProviderAdapter => {
  const adapter = registry.get(modelId);
  if (!adapter) throw new Error(`ORZ Provider Adapter 未注册模型：${modelId}`);
  return adapter;
};

export const registeredVideoModelIds = (): readonly string[] => [...registry.keys()];
