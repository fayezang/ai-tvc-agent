import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { CreateProjectRequestSchema, type ProjectSummary } from "../src/shared/contracts.js";
import { buildBriefRestatementMarkdown, buildInitialBrief } from "../src/utility/brief-flow.js";

const project: ProjectSummary = {
  id: "project-1",
  name: "有机奶京剧创意",
  rootPath: "/tmp/project-1",
  adDuration: 5,
  aspectRatio: "9:16",
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z"
};

describe("Notion homepage → Brief restatement flow", () => {
  test("allows an unstructured rich Brief while keeping duration and aspect ratio as options", () => {
    const decoded = Schema.decodeUnknownSync(CreateProjectRequestSchema)({
      name: "未命名创意",
      adDuration: 5,
      aspectRatio: "9:16",
      briefMarkdown: ""
    });
    expect(decoded.briefMarkdown).toBe("");
    expect(decoded.adDuration).toBe(5);
    expect(decoded.aspectRatio).toBe("9:16");
  });

  test("preserves homepage rich content before AI restatement", () => {
    const markdown = buildInitialBrief(project, "京剧花旦登场。\n\n![产品图](../assets/references/product.png)");
    expect(markdown).toContain("京剧花旦登场");
    expect(markdown).toContain("![产品图]");
    expect(markdown).toContain("画幅：9:16");
    expect(markdown).toContain("时长：5 秒");
  });

  test("writes exactly the five required AI-restated Brief sections", () => {
    const brief = buildBriefRestatementMarkdown(project, {
      productAndSellingPoint: "金典有机奶；核心卖点以用户输入为准",
      creativeIdea: "京剧花旦登场与产品亮相结合",
      visualStyle: "典雅、电影感"
    });

    expect(brief.match(/^## /gm)).toHaveLength(5);
    expect(brief).toContain("## 产品 + 核心卖点");
    expect(brief).toContain("## 创意点");
    expect(brief).toContain("## 画面风格");
    expect(brief).toContain("## 画幅\n\n9:16");
    expect(brief).toContain("## 时长\n\n5 秒");
  });
});
