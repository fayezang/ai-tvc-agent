import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { VideoGenerationRequest } from "../src/shared/contracts.js";
import {
  DEFAULT_PROVIDER_MODELS,
  MODEL_DEFINITIONS,
  ORZ_MODELS,
  SHOT_ROLE_MODEL,
  resolveVideoModelForRole
} from "../src/shared/orz-models.js";
import { registeredVideoModelIds, resolveOrzAdapter } from "../src/utility/providers/orz-adapters.js";
import { buildStoryboardImagePayload } from "../src/utility/providers/orz-image-adapter.js";
import { normalizeOrzTaskResponse } from "../src/utility/providers/orz-client.js";

const request = (overrides: Partial<VideoGenerationRequest>): VideoGenerationRequest => ({
  projectRoot: "/tmp/project",
  shotId: "shot-1",
  role: "other",
  modelId: ORZ_MODELS.seedance,
  prompt: "A precise product shot",
  duration: 5,
  aspectRatio: "16:9",
  resolution: "1080p",
  referenceImageUrls: [],
  referenceVideoUrls: [],
  referenceAudioUrls: [],
  generateAudio: false,
  ...overrides
});

describe("ORZ Provider Adapter Registry", () => {
  test("normalizes the documented ORZ image task response", () => {
    expect(normalizeOrzTaskResponse({ taskId: "tk-1", status: "pending" })).toEqual({
      task_id: "tk-1",
      status: "pending"
    });
    expect(
      normalizeOrzTaskResponse({
        taskId: "tk-1",
        status: "done",
        resultUrls: ["https://cdn.orz.sh/images/shot.png"],
        failMsg: null
      })
    ).toEqual({
      task_id: "tk-1",
      status: "completed",
      output: { items: [{ url: "https://cdn.orz.sh/images/shot.png" }] }
    });
  });

  test("never sends base64 data URLs as ORZ reference images", () => {
    // ORZ 文档明确：image_url / image_urls 只接受公网 HTTPS、cdn.orz.sh 或 file:// 引用，
    // 传 base64 data URL 会被判为 image_invalid。参考图必须先经 Files API 换成真实 URL。
    const service = readFileSync(
      new URL("../src/utility/agent-service.ts", import.meta.url),
      "utf8"
    );
    expect(service).not.toContain("projectReferenceDataUrls");
    expect(service).toContain("client.uploadFile(name, bytes, mimeType)");
    expect(service).toContain("referenceImageUrls: projectReferences");
    // 图片链路必须独立于文本链路验证。
    const credentials = readFileSync(
      new URL("../src/main/credential-store.ts", import.meta.url),
      "utf8"
    );
    expect(credentials).toContain("validateImageModel");
    expect(credentials).toContain("probeImageModel");
  });

  test("uses the verified low-cost models for first-run testing", () => {
    expect(DEFAULT_PROVIDER_MODELS.textModelId).toBe(ORZ_MODELS.geminiFlashLite);
    expect(DEFAULT_PROVIDER_MODELS.imageModelId).toBe(ORZ_MODELS.gptImageLow);
    expect(DEFAULT_PROVIDER_MODELS.videoModelRouting).toEqual({
      hook: ORZ_MODELS.seedance,
      reveal: ORZ_MODELS.seedance,
      proof: ORZ_MODELS.seedance,
      cta: ORZ_MODELS.seedance
    });
  });

  test("routes every non-special role to Seedance and contains no legacy video provider", () => {
    expect(SHOT_ROLE_MODEL.cta).toBe(ORZ_MODELS.seedance);
    expect(SHOT_ROLE_MODEL["emotional-proof"]).toBe(ORZ_MODELS.seedance);
    expect(SHOT_ROLE_MODEL.other).toBe(ORZ_MODELS.seedance);
    expect(registeredVideoModelIds()).toEqual([
      ORZ_MODELS.kling,
      ORZ_MODELS.seedance
    ]);
  });

  test("no longer ships the models we decided not to publish", () => {
    // Hailuo 2.3：¥36/s 且任意分辨率同价，5 秒即 ¥180，比 Seedance 1080p 贵约 7 倍。
    // Veo 3.1：¥20.736/s，固定 8 秒即 ¥165.89，且时长无法匹配任意脚本镜头。
    // 本产品定位低成本试验，两者都不发布，也就不必把这些数量级带进价格表。
    for (const retired of ["minimax/hailuo-2-3", "google/veo-3-1"]) {
      expect(registeredVideoModelIds()).not.toContain(retired);
      expect(MODEL_DEFINITIONS.some((model) => model.id === retired)).toBe(false);
      expect(() => resolveOrzAdapter(retired)).toThrow("未注册模型");
    }
  });

  test("uses the saved video routing instead of a per-request model ID", () => {
    const routing = {
      hook: ORZ_MODELS.seedance,
      reveal: ORZ_MODELS.kling,
      proof: ORZ_MODELS.seedance,
      cta: ORZ_MODELS.kling
    };
    expect(resolveVideoModelForRole("hook", routing)).toBe(ORZ_MODELS.seedance);
    expect(resolveVideoModelForRole("reveal", routing)).toBe(ORZ_MODELS.kling);
    expect(resolveVideoModelForRole("emotional-proof", routing)).toBe(ORZ_MODELS.kling);
  });

  test("builds Seedance 2 REST input with lowercase resolution and typed reference arrays", () => {
    const payload = resolveOrzAdapter(ORZ_MODELS.seedance).build(
      request({
        referenceImageUrls: ["https://example.com/frame.png"],
        referenceVideoUrls: ["https://example.com/reference.mp4"],
        generateAudio: true
      })
    );
    expect(payload).toEqual({
      model: "bytedance/seedance-2",
      input: {
        prompt: "A precise product shot",
        duration: 5,
        aspect_ratio: "16:9",
        resolution: "1080p",
        generate_audio: true,
        web_search: false,
        reference_image_urls: ["https://example.com/frame.png"],
        reference_video_urls: ["https://example.com/reference.mp4"]
      }
    });
  });

  test("builds Kling with its own REST shape", () => {
    const kling = resolveOrzAdapter(ORZ_MODELS.kling).build(
      request({ modelId: ORZ_MODELS.kling, role: "hook", duration: 5, resolution: "720p" })
    );
    expect(kling.input.version).toBe("2.5-turbo");
    expect(kling.input.resolution).toBe("720P");
    expect(kling.input.duration).toBe(5);
  });

  test("rejects durations unsupported by a concrete provider", () => {
    // Kling 只有 5 与 10 两档。7 秒不在其中，Adapter 必须拒掉而不是静默取整——
    // 取整属于 normalizeVideoParams 的职责，且必须在报价时就发生。
    expect(() =>
      resolveOrzAdapter(ORZ_MODELS.kling).build(
        request({ modelId: ORZ_MODELS.kling, role: "reveal", duration: 7, resolution: "720p" })
      )
    ).toThrow("不支持 7 秒时长");
  });

  test("builds each static storyboard shot for Gemini Image 3.1 through ORZ", () => {
    expect(
      buildStoryboardImagePayload({
        shotId: "shot-2",
        prompt: "产品英雄镜头，严格保持参考图包装",
        negativePrompt: "错误文字，变形包装",
        aspectRatio: "9:16",
        referenceImageUrls: ["https://example.com/product.png"],
        count: 2,
        outputFormat: "png"
      })
    ).toEqual({
      model: "google/gemini-image-3-1",
      input: {
        prompt: "产品英雄镜头，严格保持参考图包装",
        version: "3.1",
        aspect_ratio: "9:16",
        n: 2,
        output_format: "png",
        storage_mode: "Temporary",
        image_url: "https://example.com/product.png",
        negative_prompt: "错误文字，变形包装"
      }
    });
  });

  test("switches the saved storyboard image model through the image adapter", () => {
    const payload = buildStoryboardImagePayload(
      {
        shotId: "shot-3",
        prompt: "保持品牌包装一致的静态产品分镜",
        aspectRatio: "16:9",
        referenceImageUrls: [],
        count: 1,
        outputFormat: "webp"
      },
      ORZ_MODELS.gptImageMedium
    );
    expect(payload.model).toBe(ORZ_MODELS.gptImageMedium);
    expect(payload.input.version).toBe("image2_medium");
    expect(payload.input.input_fidelity).toBe("high");
  });
});
