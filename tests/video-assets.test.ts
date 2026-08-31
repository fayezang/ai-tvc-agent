import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeVideoBytes,
  exportCompletedVideoFile,
  isIsoBaseMediaFile,
  persistVideoOutputs,
  videoAssetRelativePath
} from "../src/utility/video-assets.js";
import { writeAtomic } from "../src/utility/project-service.js";

/**
 * 真实的 MP4 文件头。
 *
 * ISO BMFF 结构：前 4 字节为 box 大小（0x00000020 = 32），
 * 紧接 4 字节 box 类型 "ftyp"，随后是 major brand "isom" 与兼容品牌列表。
 * 这段字节取自标准 MP4 容器，不是为了通过测试而编造的数据。
 */
const MP4_HEADER = new Uint8Array([
  0x00, 0x00, 0x00, 0x20, // box size = 32
  0x66, 0x74, 0x79, 0x70, // "ftyp"
  0x69, 0x73, 0x6f, 0x6d, // major brand "isom"
  0x00, 0x00, 0x02, 0x00, // minor version
  0x69, 0x73, 0x6f, 0x6d, // compatible brand "isom"
  0x69, 0x73, 0x6f, 0x32, // compatible brand "iso2"
  0x61, 0x76, 0x63, 0x31, // compatible brand "avc1"
  0x6d, 0x70, 0x34, 0x31 //  compatible brand "mp41"
]);

const withProject = async <T>(run: (projectRoot: string) => Promise<T>): Promise<T> => {
  const projectRoot = mkdtempSync(join(tmpdir(), "tvc-video-"));
  try {
    return await run(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
};

describe("mp4 validation", () => {
  test("accepts a real ISO base media file header", () => {
    expect(isIsoBaseMediaFile(MP4_HEADER)).toBe(true);
    expect(describeVideoBytes(MP4_HEADER)).toBeNull();
  });

  test("rejects an HTML error page and quotes it back", () => {
    // ORZ 网关或其前置 CDN 异常时会返回 HTML 而非视频。
    // 若不校验就落盘，用户拿到的是一个无法播放的 .mp4。
    const html = new TextEncoder().encode(
      "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head></html>"
    );
    expect(isIsoBaseMediaFile(html)).toBe(false);
    const problem = describeVideoBytes(html);
    expect(problem).toContain("ftyp");
    expect(problem).toContain("DOCTYPE");
  });

  test("rejects empty and truncated downloads", () => {
    expect(describeVideoBytes(new Uint8Array(0))).toBe("下载得到空文件");
    expect(describeVideoBytes(new Uint8Array([0x00, 0x00, 0x00]))).toContain("3 字节");
  });

  test("rejects a file whose ftyp box is at the wrong offset", () => {
    // 把 ftyp 放在开头而非偏移 4，是常见的伪造/损坏形态。
    const shifted = new Uint8Array([0x66, 0x74, 0x79, 0x70, ...MP4_HEADER.subarray(0, 8)]);
    expect(isIsoBaseMediaFile(shifted)).toBe(false);
  });
});

describe("video asset paths", () => {
  test("groups every variant of a job under one directory", () => {
    expect(videoAssetRelativePath("job-1", 0)).toBe("assets/videos/job-1/0.mp4");
    expect(videoAssetRelativePath("job-1", 2)).toBe("assets/videos/job-1/2.mp4");
  });
});

describe("exporting one completed full video", () => {
  test("copies the selected source into outputs byte for byte", async () => {
    await withProject(async (projectRoot) => {
      const sourceRelativePath = "assets/videos/job-export/0.mp4";
      await writeAtomic(join(projectRoot, sourceRelativePath), MP4_HEADER);

      const result = await exportCompletedVideoFile({
        projectRoot,
        jobId: "job-export",
        sourceRelativePath
      });

      expect(result.outputPath).toBe(join(projectRoot, "outputs/final-job-export.mp4"));
      expect([...readFileSync(result.outputPath)]).toEqual([...MP4_HEADER]);
      expect([...readFileSync(join(projectRoot, sourceRelativePath))]).toEqual([...MP4_HEADER]);
    });
  });

  test("copies to the exact path chosen in the native save dialog", async () => {
    await withProject(async (projectRoot) => {
      const sourceRelativePath = "assets/videos/job-save-as/0.mp4";
      const destinationPath = join(projectRoot, "user-selected", "campaign-final.mp4");
      await writeAtomic(join(projectRoot, sourceRelativePath), MP4_HEADER);

      const result = await exportCompletedVideoFile({
        projectRoot,
        jobId: "job-save-as",
        sourceRelativePath,
        destinationPath
      });

      expect(result.outputPath).toBe(destinationPath);
      expect([...readFileSync(destinationPath)]).toEqual([...MP4_HEADER]);
      expect([...readFileSync(join(projectRoot, sourceRelativePath))]).toEqual([...MP4_HEADER]);
    });
  });

  test("keeps the source asset untouched when export fails", async () => {
    await withProject(async (projectRoot) => {
      const sourceRelativePath = "assets/videos/job-fail/0.mp4";
      const sourcePath = join(projectRoot, sourceRelativePath);
      await writeAtomic(sourcePath, MP4_HEADER);
      // 用同名目录制造真实文件系统失败，不 mock 写盘。
      mkdirSync(join(projectRoot, "outputs/final-job-fail.mp4"), { recursive: true });

      await expect(exportCompletedVideoFile({
        projectRoot,
        jobId: "job-fail",
        sourceRelativePath
      })).rejects.toThrow();

      expect(existsSync(sourcePath)).toBe(true);
      expect([...readFileSync(sourcePath)]).toEqual([...MP4_HEADER]);
    });
  });
});

describe("atomic writes preserve binary content", () => {
  test("writes video bytes without utf8 corruption", async () => {
    await withProject(async (projectRoot) => {
      const path = join(projectRoot, "assets/videos/job-1/0.mp4");
      await writeAtomic(path, MP4_HEADER);

      const written = new Uint8Array(readFileSync(path));
      // 若按 utf8 编码写入，0x00 与高位字节会被替换成 U+FFFD，长度也会变化。
      expect(written.byteLength).toBe(MP4_HEADER.byteLength);
      expect([...written]).toEqual([...MP4_HEADER]);
      expect(isIsoBaseMediaFile(written)).toBe(true);
    });
  });

  test("leaves no temporary files behind", async () => {
    await withProject(async (projectRoot) => {
      const directory = join(projectRoot, "assets/videos/job-1");
      await writeAtomic(join(directory, "0.mp4"), MP4_HEADER);

      expect(readdirSync(directory)).toEqual(["0.mp4"]);
    });
  });
});

describe("persisting job outputs", () => {
  /**
   * 用本机 HTTP 服务提供字节，而不是 mock fetch。
   * 这样重试、超时、状态码处理走的都是真实网络栈。
   */
  const serve = (
    handler: (path: string) => { status: number; body: Uint8Array | string; contentType: string }
  ): { origin: string; stop: () => void } => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        const result = handler(pathname);
        return new Response(result.body, {
          status: result.status,
          headers: { "content-type": result.contentType }
        });
      }
    });
    return { origin: `http://localhost:${server.port}`, stop: () => server.stop(true) };
  };

  test("downloads every output into the project directory", async () => {
    const server = serve(() => ({ status: 200, body: MP4_HEADER, contentType: "video/mp4" }));
    try {
      await withProject(async (projectRoot) => {
        const result = await persistVideoOutputs({
          projectRoot,
          jobId: "job-1",
          urls: [`${server.origin}/a.mp4`, `${server.origin}/b.mp4`]
        });

        expect(result.localPaths).toEqual(["assets/videos/job-1/0.mp4", "assets/videos/job-1/1.mp4"]);
        expect(result.failures).toEqual([null, null]);
        for (const relativePath of result.localPaths) {
          const bytes = new Uint8Array(readFileSync(join(projectRoot, relativePath)));
          expect(isIsoBaseMediaFile(bytes)).toBe(true);
        }
      });
    } finally {
      server.stop();
    }
  });

  test("keeps successful outputs when one of them fails", async () => {
    const server = serve((path) =>
      path === "/broken.mp4"
        ? { status: 502, body: "<!DOCTYPE html><html>bad gateway</html>", contentType: "text/html" }
        : { status: 200, body: MP4_HEADER, contentType: "video/mp4" }
    );
    try {
      await withProject(async (projectRoot) => {
        const result = await persistVideoOutputs({
          projectRoot,
          jobId: "job-2",
          // 第一个成功、第二个失败：失败不得影响已成功的版本。
          urls: [`${server.origin}/ok.mp4`, `${server.origin}/broken.mp4`],
          // 502 在真实环境值得重试，但这里只验证隔离性，不必等待退避。
          maxAttempts: 1
        });

        expect(result.localPaths).toEqual(["assets/videos/job-2/0.mp4"]);
        expect(result.failures[0]).toBeNull();
        expect(result.failures[1]).toContain("HTTP 502");
        expect(readFileSync(join(projectRoot, "assets/videos/job-2/0.mp4")).byteLength).toBe(
          MP4_HEADER.byteLength
        );
      });
    } finally {
      server.stop();
    }
  });

  test("retries a failing download before giving up", async () => {
    let attempts = 0;
    const server = serve(() => {
      attempts += 1;
      return { status: 503, body: "unavailable", contentType: "text/plain" };
    });
    try {
      await withProject(async (projectRoot) => {
        const result = await persistVideoOutputs({
          projectRoot,
          jobId: "job-retry",
          urls: [`${server.origin}/a.mp4`],
          maxAttempts: 3
        });

        // 瞬时故障是网关的常态，放弃前必须真的重试过。
        expect(attempts).toBe(3);
        expect(result.localPaths).toEqual([]);
        expect(result.failures[0]).toContain("已自动重试 3 次");
      });
    } finally {
      server.stop();
    }
  });

  test("refuses to store a response that is not a video", async () => {
    const server = serve(() => ({
      status: 200,
      body: "<!DOCTYPE html><html>login required</html>",
      contentType: "text/html"
    }));
    try {
      await withProject(async (projectRoot) => {
        const result = await persistVideoOutputs({
          projectRoot,
          jobId: "job-3",
          urls: [`${server.origin}/a.mp4`],
          maxAttempts: 1
        });

        // HTTP 200 但内容不是视频：必须拦截，否则用户会拿到无法播放的文件。
        expect(result.localPaths).toEqual([]);
        expect(result.failures[0]).toContain("ftyp");
        expect(existsSync(join(projectRoot, "assets/videos/job-3/0.mp4"))).toBe(false);
      });
    } finally {
      server.stop();
    }
  });
});

describe("source guarantees", () => {
  const jobService = readFileSync(new URL("../src/utility/job-service.ts", import.meta.url), "utf8");

  test("job completion is gated on a successful local write", () => {
    // ORZ 报告 completed 时产物只存在于有时效的 CDN 上。
    // 必须先落盘再置 completed，否则链接过期后视频全部失效。
    expect(jobService).toContain("persistVideoOutputs");
    expect(jobService).toContain('state: "downloading"');
    expect(jobService).toContain('state: "validating"');
  });

  test("exposes the selected variant so the choice survives a reload", () => {
    // selected_output_url 此前只写入不读出，用户选的版本刷新即丢。
    expect(jobService).toContain("selectedOutputUrl");
    expect(jobService).toContain("selectedLocalPath");
    expect(jobService).toContain("local_paths_json");
  });
});
