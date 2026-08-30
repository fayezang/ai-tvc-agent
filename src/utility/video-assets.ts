import { join } from "node:path";
import { writeAtomic } from "./project-service.js";

/**
 * 视频资产落盘。
 *
 * ORZ 返回的是有时效的 CDN 链接（官方标注 14 天过期）。若只把 URL 存进
 * 数据库，过期后项目中所有已生成视频会集体失效且无法找回。因此任务完成后
 * 必须把字节下载到项目目录内，使项目目录整体复制后仍然自洽。
 *
 * 落盘流程与静态图保持一致：下载（带重试）→ 校验 → 原子写入。
 */

/** 单次下载超时。视频体积远大于图片，给足时间但不无限等待。 */
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** 单个输出的重试次数。与静态图链路保持一致。 */
const MAX_ATTEMPTS = 4;

/** 重试退避基数，实际等待为 attempt * BACKOFF_BASE_MS（线性退避）。 */
const BACKOFF_BASE_MS = 1_500;

export interface DownloadedVideo {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * 判断字节流是否为 ISO BMFF 容器（MP4 / MOV / M4V）。
 *
 * 结构：前 4 字节是 box 大小（大端），紧接着 4 字节 box 类型。
 * 有效文件的第一个 box 类型为 "ftyp"，即偏移 4-8 处为 66 74 79 70。
 *
 * 这是轻量校验，用于拦截网关返回 HTML 错误页、空响应或截断内容的情况。
 * 完整的流完整性校验需要 ffprobe，属于导出功能的范围，本模块不引入。
 */
export const isIsoBaseMediaFile = (bytes: Uint8Array): boolean => {
  if (bytes.byteLength < 12) return false;
  return (
    bytes[4] === 0x66 && // f
    bytes[5] === 0x74 && // t
    bytes[6] === 0x79 && // y
    bytes[7] === 0x70 //   p
  );
};

/** 校验失败时给出可读原因，而不是笼统的“文件无效”。 */
export const describeVideoBytes = (bytes: Uint8Array): string | null => {
  if (bytes.byteLength === 0) return "下载得到空文件";
  if (bytes.byteLength < 12) return `文件仅 ${bytes.byteLength} 字节，不足以构成有效视频`;
  if (!isIsoBaseMediaFile(bytes)) {
    // 网关异常时常返回 HTML 错误页，把开头字节还原成文本更利于定位。
    const head = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.subarray(0, 64))
      .replace(/\s+/g, " ")
      .trim();
    return `不是有效的 MP4 文件（缺少 ftyp 标识）。响应开头：${head.slice(0, 60)}`;
  }
  return null;
};

/**
 * 任务输出在项目内的相对路径。
 * 按 jobId 分目录，使同一任务的多个候选版本聚在一起，删除任务时可整目录清理。
 */
export const videoAssetRelativePath = (jobId: string, index: number): string =>
  `assets/videos/${jobId}/${index}.mp4`;

export const downloadVideoWithRetry = async (
  url: string,
  label: string,
  maxAttempts = MAX_ATTEMPTS
): Promise<DownloadedVideo> => {
  let lastError = "未知网络错误";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { Accept: "video/mp4,video/*;q=0.8,*/*;q=0.5" },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const problem = describeVideoBytes(bytes);
      if (problem) throw new Error(problem);
      return { bytes, contentType: response.headers.get("content-type") ?? "" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * BACKOFF_BASE_MS));
      }
    }
  }
  throw new Error(`${label} 下载失败，已自动重试 ${maxAttempts} 次：${lastError}`);
};

export interface PersistedVideoOutputs {
  /** 与传入 urls 顺序一致的项目内相对路径。 */
  readonly localPaths: readonly string[];
  /** 逐个 URL 的失败原因，成功项为 null。用于向用户说明哪些版本没能保存。 */
  readonly failures: readonly (string | null)[];
}

/**
 * 把任务的全部输出落盘到项目目录。
 *
 * 单个输出失败不影响其余输出：失败项在 localPaths 中缺席，
 * 原因记录在 failures 中。调用方据此决定任务的最终状态。
 */
export const persistVideoOutputs = async (input: {
  projectRoot: string;
  jobId: string;
  urls: readonly string[];
  /** 单个输出的下载重试次数。默认值面向真实网络；测试可调低以免等待退避。 */
  maxAttempts?: number;
}): Promise<PersistedVideoOutputs> => {
  const localPaths: string[] = [];
  const failures: (string | null)[] = [];
  for (const [index, url] of input.urls.entries()) {
    try {
      const { bytes } = await downloadVideoWithRetry(
        url,
        `视频版本 ${index + 1}`,
        input.maxAttempts ?? MAX_ATTEMPTS
      );
      const relativePath = videoAssetRelativePath(input.jobId, index);
      await writeAtomic(join(input.projectRoot, relativePath), bytes);
      localPaths.push(relativePath);
      failures.push(null);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { localPaths, failures };
};
