import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import type {
  ProviderConfiguration,
  ProviderStatus,
  ProviderValidation,
  ProviderVideoRouting
} from "../shared/contracts.js";
import {
  DEFAULT_PROVIDER_MODELS,
  IMAGE_MODEL_OPTIONS,
  ORZ_BASE_URL,
  TEXT_MODEL_OPTIONS,
  VIDEO_MODEL_OPTIONS
} from "../shared/orz-models.js";
import { OrzClient } from "../utility/providers/orz-client.js";
import { buildStoryboardImagePayload } from "../utility/providers/orz-image-adapter.js";

interface StoredProviderConfiguration {
  encryptedApiKey: string;
  textModelId: string;
  imageModelId: string;
  videoModelRouting: ProviderVideoRouting;
}

export interface ProviderSecrets {
  apiKey?: string;
  textModelId?: string;
  imageModelId?: string;
  videoModelRouting?: ProviderVideoRouting;
}

const knownTextModels = new Set(TEXT_MODEL_OPTIONS.map((model) => model.id));
const knownImageModels = new Set(IMAGE_MODEL_OPTIONS.map((model) => model.id));
const knownVideoModels = new Set(VIDEO_MODEL_OPTIONS.map((model) => model.id));

export class CredentialStore {
  private get path(): string {
    return join(app.getPath("userData"), "orz-provider.json");
  }

  status(): ProviderStatus {
    const stored = this.read();
    return {
      hasApiKey: Boolean(stored?.encryptedApiKey),
      textModelId: stored?.textModelId ?? null,
      imageModelId: stored?.imageModelId ?? null,
      videoModelRouting: stored?.videoModelRouting ?? null,
      baseUrl: ORZ_BASE_URL
    };
  }

  configure(configuration: ProviderConfiguration): ProviderStatus {
    const current = this.read();
    const apiKey = configuration.apiKey.trim();
    const textModelId = configuration.textModelId.trim();
    const imageModelId = configuration.imageModelId.trim();
    const videoModelRouting = configuration.videoModelRouting;

    if (!apiKey && !current?.encryptedApiKey) throw new Error("请先填写 ORZ API Key");
    if (!knownTextModels.has(textModelId)) throw new Error("请选择已支持的 ORZ 文本模型");
    if (!knownImageModels.has(imageModelId)) throw new Error("请选择已支持的 ORZ 图片模型");
    if (Object.values(videoModelRouting).some((modelId) => !knownVideoModels.has(modelId))) {
      throw new Error("请选择已经注册 Provider Adapter 的 ORZ 视频模型");
    }
    if (apiKey && !safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储当前不可用，已拒绝以明文保存 ORZ API Key");
    }

    const stored: StoredProviderConfiguration = {
      encryptedApiKey: apiKey
        ? safeStorage.encryptString(apiKey).toString("base64")
        : current!.encryptedApiKey,
      textModelId,
      imageModelId,
      videoModelRouting
    };
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, this.path);
    return this.status();
  }

  async validate(): Promise<ProviderValidation> {
    const stored = this.read();
    if (!stored?.encryptedApiKey) {
      return { ok: false, httpStatus: null, message: "尚未保存 ORZ API Key" };
    }

    try {
      const { apiKey, textModelId } = this.secrets();
      if (!apiKey || !textModelId) {
        return { ok: false, httpStatus: null, message: "ORZ API Key 或文本模型 ID 缺失" };
      }
      const response = await fetch(`${ORZ_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: textModelId,
          messages: [{ role: "user", content: "只回复 OK" }],
          max_tokens: 8,
          stream: false
        })
      });
      const body = await response.text();
      if (response.ok) {
        return { ok: true, httpStatus: response.status, message: "API Key 和文本模型已通过 ORZ 实际请求验证" };
      }

      let detail = body.trim();
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
        detail = parsed.error?.message ?? parsed.message ?? detail;
      } catch {
        // Preserve the plain-text provider response.
      }
      const hint =
        response.status === 403
          ? "ORZ 或上游模型拒绝了请求；这不是本地保存失败"
          : response.status === 401
            ? "API Key 无效或已撤销"
            : response.status === 402
              ? "ORZ 余额不足"
              : "ORZ 文本模型验证失败";
      return {
        ok: false,
        httpStatus: response.status,
        message: `${hint}（HTTP ${response.status}${detail ? `：${detail.slice(0, 240)}` : ""}）`
      };
    } catch (error) {
      return {
        ok: false,
        httpStatus: null,
        message: error instanceof Error ? error.message : "无法连接 ORZ"
      };
    }
  }

  /**
   * 单独验证图片链路。文本模型可用不代表图片模型可用：
   * 图片走 /images/generations 异步接口，且可能被 Cloudflare 挡回 HTML 错误页，
   * 所以这里必须把 HTTP 状态、Content-Type 和原始响应片段一起回报。
   */
  async validateImageModel(): Promise<ProviderValidation> {
    const stored = this.read();
    if (!stored?.encryptedApiKey) {
      return { ok: false, httpStatus: null, message: "尚未保存 ORZ API Key" };
    }
    const { apiKey, imageModelId } = this.secrets();
    if (!apiKey || !imageModelId) {
      return { ok: false, httpStatus: null, message: "ORZ API Key 或图片模型 ID 缺失" };
    }
    const probe = await new OrzClient(apiKey).probeImageModel(
      buildStoryboardImagePayload(
        {
          shotId: "connection-test",
          prompt: "A plain light grey studio background, minimal test frame",
          aspectRatio: "1:1",
          referenceImageUrls: [],
          count: 1,
          outputFormat: "png"
        },
        imageModelId
      )
    );
    if (probe.ok) {
      return {
        ok: true,
        httpStatus: probe.httpStatus,
        message: `图片模型 ${imageModelId} 已通过实际提交验证（HTTP ${probe.httpStatus}）。该测试会创建一个真实生图任务并按次计费。`
      };
    }
    const isHtml = (probe.contentType ?? "").includes("html") || probe.body.trimStart().startsWith("<");
    const hint = isHtml
      ? "ORZ 或 Cloudflare 返回了 HTML 错误页，而不是 JSON。通常是网关临时故障或触发了防护，请稍后重试"
      : probe.httpStatus === 401
        ? "API Key 无效或已撤销"
        : probe.httpStatus === 402
          ? "ORZ 余额不足"
          : probe.httpStatus === 429
            ? "触发限流，请稍后重试"
            : `图片模型 ${imageModelId} 验证失败`;
    return {
      ok: false,
      httpStatus: probe.httpStatus,
      message: `${hint}（阶段：提交图片生成任务；模型 ${imageModelId}；HTTP ${probe.httpStatus ?? "无响应"}；Content-Type ${probe.contentType ?? "未知"}）：${probe.body || "空响应"}`
    };
  }

  clear(): ProviderStatus {
    const stored = this.read();
    if (stored) {
      const temporaryPath = `${this.path}.${randomUUID()}.cleared`;
      writeFileSync(temporaryPath, "{}", { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, this.path);
    }
    return this.status();
  }

  secrets(): ProviderSecrets {
    const stored = this.read();
    if (!stored?.encryptedApiKey) return {};
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储当前不可用，无法读取 ORZ API Key");
    return {
      apiKey: safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, "base64")),
      textModelId: stored.textModelId,
      imageModelId: stored.imageModelId,
      videoModelRouting: stored.videoModelRouting
    };
  }

  private read(): StoredProviderConfiguration | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredProviderConfiguration>;
      if (!parsed.encryptedApiKey || !parsed.textModelId) return null;
      return {
        encryptedApiKey: parsed.encryptedApiKey,
        textModelId: knownTextModels.has(parsed.textModelId)
          ? parsed.textModelId
          : DEFAULT_PROVIDER_MODELS.textModelId,
        imageModelId:
          parsed.imageModelId && knownImageModels.has(parsed.imageModelId)
            ? parsed.imageModelId
            : DEFAULT_PROVIDER_MODELS.imageModelId,
        videoModelRouting:
          parsed.videoModelRouting && Object.values(parsed.videoModelRouting).every((id) => knownVideoModels.has(id))
            ? parsed.videoModelRouting
            : { ...DEFAULT_PROVIDER_MODELS.videoModelRouting }
      };
    } catch {
      return null;
    }
  }
}
