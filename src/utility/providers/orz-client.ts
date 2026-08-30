import { ORZ_BASE_URL } from "../../shared/orz-models.js";
import type { OrzGenerationPayload } from "./orz-adapters.js";

export interface OrzTaskResponse {
  task_id: string;
  status: "pending" | "queued" | "running" | "processing" | "completed" | "failed" | "canceled" | "expired";
  progress?: number;
  stage?: string;
  output?: { items?: Array<{ url: string }> };
  error?: { code?: string; message?: string; retryable?: boolean };
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};

const firstString = (record: UnknownRecord, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return undefined;
};

const normalizeStatus = (value: unknown): OrzTaskResponse["status"] => {
  const status = String(value ?? "").toLowerCase();
  if (["pending", "queued", "running", "processing", "failed", "canceled", "expired"].includes(status)) {
    return status as OrzTaskResponse["status"];
  }
  if (["done", "completed", "success", "succeeded"].includes(status)) return "completed";
  if (["cancelled"].includes(status)) return "canceled";
  throw new Error(`ORZ 返回了未知任务状态：${status || "空"}`);
};

const resultItems = (raw: UnknownRecord): Array<{ url: string }> => {
  const output = asRecord(raw.output);
  const candidates = [
    raw.resultUrls,
    raw.result_urls,
    raw.outputUrls,
    raw.output_urls,
    output.items,
    output.urls
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const items = candidate.flatMap((item) => {
      if (typeof item === "string" && item) return [{ url: item }];
      const url = firstString(asRecord(item), ["url", "outputUrl", "output_url"]);
      return url ? [{ url }] : [];
    });
    if (items.length > 0) return items;
  }
  const single = firstString(raw, ["resultUrl", "result_url", "outputUrl", "output_url"]);
  return single ? [{ url: single }] : [];
};

export const normalizeOrzTaskResponse = (value: unknown): OrzTaskResponse => {
  const raw = asRecord(value);
  const taskId = firstString(raw, ["task_id", "taskId", "id"]);
  if (!taskId) throw new Error("ORZ 任务响应缺少 taskId");
  const errorRecord = asRecord(raw.error);
  const errorMessage = firstString(errorRecord, ["message"]) ?? firstString(raw, ["failMsg", "fail_msg"]);
  const items = resultItems(raw);
  return {
    task_id: taskId,
    status: normalizeStatus(raw.status),
    ...(typeof raw.progress === "number" ? { progress: raw.progress } : {}),
    ...(typeof raw.stage === "string" ? { stage: raw.stage } : {}),
    ...(items.length > 0 ? { output: { items } } : {}),
    ...(errorMessage
      ? {
          error: {
            ...(typeof errorRecord.code === "string" ? { code: errorRecord.code } : {}),
            message: errorMessage,
            ...(typeof errorRecord.retryable === "boolean" ? { retryable: errorRecord.retryable } : {})
          }
        }
      : {})
  };
};

const parseJson = async <T>(response: Response, stage: string): Promise<T> => {
  const raw = await response.text();
  let body: (T & { error?: { message?: string }; message?: string }) | null = null;
  try {
    body = JSON.parse(raw) as T & { error?: { message?: string }; message?: string };
  } catch {
    const contentType = response.headers.get("content-type") ?? "未知";
    throw new Error(
      `${stage}返回了非 JSON 内容（HTTP ${response.status}，Content-Type ${contentType}）：${raw.trim().slice(0, 300) || "空响应"}`
    );
  }
  if (!response.ok) {
    const message = body.error?.message ?? body.message ?? `ORZ 请求失败（HTTP ${response.status}）`;
    throw new Error(`${stage}失败（HTTP ${response.status}）：${message}`);
  }
  return body;
};

export class OrzClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = ORZ_BASE_URL
  ) {}

  async submitVideo(payload: OrzGenerationPayload): Promise<OrzTaskResponse> {
    return normalizeOrzTaskResponse(await this.request(`${this.baseUrl}/videos/generations`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload)
    }, "提交视频生成任务"));
  }

  async submitImage(payload: OrzGenerationPayload): Promise<OrzTaskResponse> {
    return normalizeOrzTaskResponse(await this.request(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload)
    }, "提交图片生成任务"));
  }

  async getTask(taskId: string): Promise<OrzTaskResponse> {
    return normalizeOrzTaskResponse(await this.request(`${this.baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
      headers: this.headers()
    }, `查询任务 ${taskId}`));
  }

  async cancelTask(taskId: string): Promise<OrzTaskResponse> {
    return normalizeOrzTaskResponse(await this.request(`${this.baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
      headers: this.headers()
    }, `取消任务 ${taskId}`));
  }

  /**
   * ORZ 的 image_url / image_urls 只接受公网 HTTPS、cdn.orz.sh 或临时 R2 链接，
   * 不接受 base64 data URL。本地参考图必须先经 Files API 换成真实 URL。
   */
  async uploadFile(
    fileName: string,
    bytes: Uint8Array,
    mimeType: string
  ): Promise<{ id: string; url?: string }> {
    const form = new FormData();
    form.set("purpose", "vision");
    form.set("file", new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeType }), fileName);
    const stage = `上传参考图 ${fileName}`;
    let lastError: unknown = new Error(`${stage}失败`);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/files`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(60_000)
        });
      } catch (error) {
        lastError = error;
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_200));
        continue;
      }
      const shouldRetryStatus = [429, 502, 503, 504].includes(response.status);
      try {
        return await parseJson<{ id: string; url?: string }>(response, stage);
      } catch (error) {
        lastError = error;
        const nonJson = error instanceof Error && /非 JSON 内容/.test(error.message);
        if (attempt >= 3 || (!shouldRetryStatus && !nonJson)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_200));
    }
    throw lastError;
  }

  /** 用当前图片模型发一次最小生图请求，验证图片链路是否真的可用。 */
  async probeImageModel(payload: OrzGenerationPayload): Promise<{
    ok: boolean;
    httpStatus: number | null;
    contentType: string | null;
    body: string;
  }> {
    try {
      const response = await fetch(`${this.baseUrl}/images/generations`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45_000)
      });
      const raw = await response.text();
      return {
        ok: response.ok,
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
        body: raw.trim().slice(0, 300)
      };
    } catch (error) {
      return {
        ok: false,
        httpStatus: null,
        contentType: null,
        body: error instanceof Error ? error.message : "无法连接 ORZ 图片接口"
      };
    }
  }

  private async request(url: string, init: RequestInit, stage: string): Promise<unknown> {
    let lastError: unknown = new Error(`${stage}失败`);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
      } catch (error) {
        lastError = error;
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_200));
        continue;
      }
      const shouldRetryStatus = [429, 502, 503, 504].includes(response.status);
      try {
        return await parseJson<unknown>(response, stage);
      } catch (error) {
        lastError = error;
        const nonJson = error instanceof Error && /非 JSON 内容/.test(error.message);
        if (attempt >= 4 || (!shouldRetryStatus && !nonJson)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_200));
    }
    throw lastError;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json"
    };
  }
}
