import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("fixed desktop technology stack", () => {
  test("runs Electron through electron-vite instead of a browser framework", () => {
    expect(packageJson.scripts.dev).toBe("electron-vite dev");
    expect(packageJson.scripts.build).toContain("electron-vite build");
    expect(packageJson.dependencies.next).toBeUndefined();
    expect(packageJson.dependencies["@fal-ai/client"]).toBeUndefined();
  });

  test("contains every locked core dependency with an exact version", () => {
    const required = [
      "react",
      "react-dom",
      "tailwindcss",
      "@xyflow/react",
      "zustand",
      "motion",
      "@tiptap/react",
      "effect",
      "@mariozechner/pi-agent-core",
      "better-sqlite3",
      "drizzle-orm",
      "@assistant-ui/react",
      "@fontsource-variable/geist",
      "@fontsource-variable/geist-mono"
    ];
    for (const name of required) {
      const version = packageJson.dependencies[name] ?? packageJson.devDependencies[name];
      expect(version, name).toBeTruthy();
      expect(version?.startsWith("^") || version?.startsWith("~"), `${name} must be exact`).toBe(false);
    }
    expect(packageJson.devDependencies.electron).toBe("44.0.0");
    expect(packageJson.devDependencies["electron-vite"]).toBe("5.0.0");
    expect(packageJson.devDependencies["electron-builder"]).toBe("26.15.3");
  });

  test("locks Pi Agent Core to the audited package version and commit", () => {
    const lock = JSON.parse(
      readFileSync(new URL("../config/pi-agent.lock.json", import.meta.url), "utf8")
    ) as { package: string; version: string; commit: string };
    expect(lock.package).toBe("@mariozechner/pi-agent-core");
    expect(lock.version).toBe("0.73.1");
    expect(lock.commit).toBe("781152fc24841dc54b22284514604048ebe5e2c9");
  });
});

describe("migration readiness", () => {
  const rootUrl = (name: string): URL => new URL(`../${name}`, import.meta.url);

  test("keeps bun.lock as the single lockfile", () => {
    // 基线指定 Bun 作为包管理器。多份锁文件并存会导致新机器
    // 依赖解析结果与开发机不一致，属迁移阻断项。
    expect(existsSync(rootUrl("bun.lock"))).toBe(true);
    expect(existsSync(rootUrl("pnpm-lock.yaml"))).toBe(false);
    expect(existsSync(rootUrl("package-lock.json"))).toBe(false);
    expect(existsSync(rootUrl("pnpm-workspace.yaml"))).toBe(false);
  });

  test("documents every configurable variable in .env.example", () => {
    const example = readFileSync(rootUrl(".env.example"), "utf8");
    expect(example).toContain("ORZ_API_KEY=");
    expect(example).toContain("ORZ_BASE_URL=https://orz.sh/api/proxy/v1");
    // 必须说明密钥实际存放位置，避免使用者误以为需要把 Key 写进文件。
    expect(example).toContain("safeStorage");
  });

  test("removes the Next.js legacy tree from the repository", () => {
    // 这些目录不在 Electron 运行路径上，保留会污染代码搜索，
    // 并使新接手者误判本项目使用了 CutAgent。
    for (const path of ["src/app", "src/components", "src/lib", "src/types", "supabase"]) {
      expect(existsSync(rootUrl(path)), path).toBe(false);
    }
  });

  test("records the video backend decision so CutAgent needs no pinned commit", () => {
    const decision = readFileSync(rootUrl("docs/decisions/0001-video-backend.md"), "utf8");
    expect(decision).toContain("不需要锁定 CutAgent commit");
    // ffmpeg 命令序列是 CutAgent 唯一被移植的内容，必须完整留存，
    // 否则删除旧代码后第四批导出功能将失去依据。
    expect(decision).toContain("force_original_aspect_ratio=decrease");
    expect(decision).toContain("amix=inputs=2:duration=first");
  });

  test("records why project entry points are fixed at two", () => {
    // 启动包原文要求三个入口。移除「导入已有脚本」是显式决策，
    // 必须留档，否则会被后续 Agent 当成未完成项重新实现。
    const decision = readFileSync(rootUrl("docs/decisions/0002-project-entry-points.md"), "utf8");
    expect(decision).toContain("移除「导入已有脚本」入口");
    expect(decision).toContain("脚本是唯一事实来源");
  });
});

describe("cost estimation honesty", () => {
  const contracts = readFileSync(new URL("../src/shared/contracts.ts", import.meta.url), "utf8");
  const utilityIndex = readFileSync(new URL("../src/utility/index.ts", import.meta.url), "utf8");

  test("prices are denominated in the currency ORZ actually bills in", () => {
    // ORZ 按秒计费且以人民币计价。写死 USD 会让用户按错误汇率理解成本。
    expect(contracts).toContain('currency: Schema.Literal("CNY")');
    expect(contracts).not.toContain('Schema.Literal("USD")');
    expect(utilityIndex).toContain('currency: "CNY"');
  });

  test("never fabricates an amount when no price table is wired up", () => {
    // 价格表属第三批。在此之前必须返回 null 并说明原因，
    // 而不是填一个看起来合理的数字。
    expect(utilityIndex).toContain("amount: null");
    expect(utilityIndex).toContain("尚未接入价格表");
  });
});
