import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
