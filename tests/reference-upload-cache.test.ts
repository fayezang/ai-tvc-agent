import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadLocalImage } from "../src/utility/agent-service.js";
import { OrzClient } from "../src/utility/providers/orz-client.js";

/**
 * Notion 规范 §3.2 硬规则：
 *
 *   「本地图片必须先经 POST /files 换成真实 URL，并按 sha256 缓存
 *     避免重复上传与重复计费。」
 *
 * 上传在 ORZ 侧计费，而本产品每镜都带参考图、用户又会反复重试 ——
 * 缓存一旦失效就是持续漏钱，且没有任何界面提示。
 *
 * 这些测试不 mock 网络：用 Bun.serve 起真实 HTTP 服务数请求次数，
 * 用 mkdtemp 建真实项目目录。
 */

const roots: string[] = [];

const makeProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "orz-upload-cache-"));
  roots.push(root);
  await mkdir(join(root, "assets/references"), { recursive: true });
  return root;
};

/** 最小 PNG 头字节，取自标准容器而非随手编的字节。 */
const pngBytes = (marker: number): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker]);

interface FakeOrz {
  url: string;
  uploads: number;
  names: string[];
  stop: () => void;
}

const serveOrz = (respond: (count: number) => Response): FakeOrz => {
  const state = { uploads: 0, names: [] as string[] };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (!new URL(request.url).pathname.endsWith("/files")) {
        return new Response("not found", { status: 404 });
      }
      state.uploads += 1;
      const form = await request.formData();
      const file = form.get("file");
      state.names.push(file instanceof File ? file.name : "");
      return respond(state.uploads);
    }
  });
  return {
    url: `http://localhost:${server.port}`,
    get uploads() {
      return state.uploads;
    },
    get names() {
      return state.names;
    },
    stop: () => server.stop(true)
  };
};

const okUpload = (count: number): Response =>
  Response.json({ id: `file-${count}`, url: `https://cdn.orz.sh/file-${count}.png` });

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reference image upload cache", () => {
  test("uploads once and serves the second request from cache", async () => {
    const orz = serveOrz(okUpload);
    try {
      const root = await makeProject();
      await writeFile(join(root, "assets/references/product.png"), pngBytes(1));
      const client = new OrzClient("test-key", orz.url);

      const first = await uploadLocalImage(root, "assets/references/product.png", client);
      const second = await uploadLocalImage(root, "assets/references/product.png", client);

      expect(first).toBe("https://cdn.orz.sh/file-1.png");
      expect(second).toBe(first);
      // 关键断言：第二次调用**没有**碰网络。
      expect(orz.uploads).toBe(1);
    } finally {
      orz.stop();
    }
  });

  test("keys the cache on content, not on the file name", async () => {
    const orz = serveOrz(okUpload);
    try {
      const root = await makeProject();
      // 同一份字节，两个不同文件名。
      await writeFile(join(root, "assets/references/a.png"), pngBytes(7));
      await writeFile(join(root, "assets/references/b.png"), pngBytes(7));
      const client = new OrzClient("test-key", orz.url);

      const first = await uploadLocalImage(root, "assets/references/a.png", client);
      const second = await uploadLocalImage(root, "assets/references/b.png", client);

      expect(second).toBe(first);
      expect(orz.uploads).toBe(1);
    } finally {
      orz.stop();
    }
  });

  test("re-uploads when the bytes change under the same path", async () => {
    const orz = serveOrz(okUpload);
    try {
      const root = await makeProject();
      const path = join(root, "assets/references/hero.png");
      await writeFile(path, pngBytes(1));
      const client = new OrzClient("test-key", orz.url);

      const first = await uploadLocalImage(root, "assets/references/hero.png", client);
      // 用户换了图但沿用同一个文件名 —— 必须重传，否则会拿旧图去生成。
      await writeFile(path, pngBytes(2));
      const second = await uploadLocalImage(root, "assets/references/hero.png", client);

      expect(second).not.toBe(first);
      expect(orz.uploads).toBe(2);
    } finally {
      orz.stop();
    }
  });

  test("persists the cache to disk so a restart does not re-upload", async () => {
    const orz = serveOrz(okUpload);
    try {
      const root = await makeProject();
      await writeFile(join(root, "assets/references/product.png"), pngBytes(3));

      // 两个独立 client 实例，模拟应用重启后重新构造。
      const before = await uploadLocalImage(
        root,
        "assets/references/product.png",
        new OrzClient("test-key", orz.url)
      );
      const after = await uploadLocalImage(
        root,
        "assets/references/product.png",
        new OrzClient("test-key", orz.url)
      );

      expect(after).toBe(before);
      expect(orz.uploads).toBe(1);

      const cache = JSON.parse(await readFile(join(root, "assets/references/uploads.json"), "utf8"));
      expect(cache.version).toBe(1);
      expect(Object.keys(cache.entries)).toHaveLength(1);
      // 缓存键必须是 64 位十六进制 sha256，不是路径。
      expect(Object.keys(cache.entries)[0]).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      orz.stop();
    }
  });

  test("falls back to the file:// reference when ORZ returns no CDN url", async () => {
    // ORZ 有时只给 file id。规范允许 file://file-xxx 引用语法，
    // 但绝不能退回 base64 data URL（会被判 image_invalid）。
    const orz = serveOrz((count) => Response.json({ id: `file-${count}` }));
    try {
      const root = await makeProject();
      await writeFile(join(root, "assets/references/product.png"), pngBytes(4));
      const client = new OrzClient("test-key", orz.url);

      const reference = await uploadLocalImage(root, "assets/references/product.png", client);

      expect(reference).toBe("file://file-1");
      expect(reference).not.toContain("base64");
      expect(reference).not.toContain("data:");
    } finally {
      orz.stop();
    }
  });

  test("does not cache a failed upload", async () => {
    // 失败不该被记成"已上传"，否则用户永远拿不到这张参考图，
    // 且没有任何重试机会。
    let calls = 0;
    const orz = serveOrz(() => {
      calls += 1;
      return calls <= 3 ? new Response("upstream boom", { status: 500 }) : okUpload(calls);
    });
    try {
      const root = await makeProject();
      await writeFile(join(root, "assets/references/product.png"), pngBytes(5));
      const client = new OrzClient("test-key", orz.url);

      await expect(
        uploadLocalImage(root, "assets/references/product.png", client)
      ).rejects.toThrow();

      // 缓存文件要么不存在，要么不含这张图的条目。
      const cached = await readFile(join(root, "assets/references/uploads.json"), "utf8").catch(
        () => null
      );
      if (cached) expect(Object.keys(JSON.parse(cached).entries)).toHaveLength(0);
    } finally {
      orz.stop();
    }
  });

  test("skips images above the ORZ vision size limit instead of paying to fail", async () => {
    const orz = serveOrz(okUpload);
    try {
      const root = await makeProject();
      // ORZ vision 单张上限 10MB。超限的图连传都不该传。
      await writeFile(join(root, "assets/references/huge.png"), new Uint8Array(10 * 1024 * 1024 + 1));
      const client = new OrzClient("test-key", orz.url);

      const reference = await uploadLocalImage(root, "assets/references/huge.png", client);

      expect(reference).toBeNull();
      expect(orz.uploads).toBe(0);
    } finally {
      orz.stop();
    }
  });
});
