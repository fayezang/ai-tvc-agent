import { describe, expect, test } from "bun:test";
import {
  parseCreativeDirectionsMarkdown,
  parseScriptMarkdown,
  parseStoryboardMarkdown,
  renderScriptMarkdown,
  validateCreativeDirections,
  validateScriptShots,
  validateStoryboardShots,
  type CreativeDirectionDraft,
  type ScriptShotDraft,
  type StoryboardShotDraft
} from "../src/utility/workflow-service.js";

const direction = (title: string, oneLine: string): CreativeDirectionDraft => ({
  title,
  oneLine,
  hook: `${title} 的开场钩子`,
  proof: `${title} 的可信证明`,
  cta: `${title} 的行动号召`
});

const shot = (order: number, duration: number): ScriptShotDraft => ({
  shotId: `S${order}`,
  duration,
  prompt: `Cinematic product shot ${order}, premium studio lighting`,
  audioSfxPrompt: `Synchronized cinematic ambience and sound effect ${order}`,
  vo: `这是镜头 ${order} 的旁白`
});

const storyboardShot = (shotName: string, duration: number): StoryboardShotDraft => ({
  shot: shotName,
  duration,
  frameContent: `${shotName} 画面内容`,
  productPosition: "画面正中",
  characterAction: "无人物"
});

describe("Notion PRD workflow invariants", () => {
  test("accepts exactly three materially distinct creative directions", () => {
    const result = validateCreativeDirections([
      direction("反常识开场", "把普通使用痛点变成一秒钟的视觉反转"),
      direction("感官证明", "用微距质感与声音直接证明产品体验"),
      direction("结果先行", "先展示理想结果再倒推产品成为关键")
    ]);
    expect(result).toHaveLength(3);
  });

  test("rejects any concept count other than three", () => {
    expect(() =>
      validateCreativeDirections([
        direction("方向一", "这是足够具体的第一个创意方向"),
        direction("方向二", "这是足够具体的第二个创意方向")
      ])
    ).toThrow("恰好为 3 个");
  });

  test("restores the three option cards from the persisted creative node", () => {
    const parsed = parseCreativeDirectionsMarkdown(`# 三个创意方向

## 1. 花旦登场篇

**一句话核心：** 花旦亮相时同步揭示产品

**Hook：** 戏曲亮相

**Proof：** 产品与水袖同框

**CTA：** 品味经典

## 2. 水袖共舞篇

**一句话核心：** 让水袖动作连接奶滴质感

**Hook：** 水袖掠过镜头

**Proof：** 奶滴微距

**CTA：** 纯净有机

## 3. 定格亮相篇

**一句话核心：** 京剧定格动作转为产品英雄镜头

**Hook：** 定格亮相

**Proof：** 包装英雄镜头

**CTA：** 金典收束
`);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((item) => item.title)).toEqual(["花旦登场篇", "水袖共舞篇", "定格亮相篇"]);
    expect(parsed[1]?.oneLine).toBe("让水袖动作连接奶滴质感");
  });

  test("accepts a script only when shot durations equal the selected ad duration", () => {
    const result = validateScriptShots(
      [shot(1, 3), shot(2, 4), shot(3, 3)],
      10
    );
    expect(result.map((item) => item.duration)).toEqual([3, 4, 3]);
  });

  test("rejects a script whose total duration drifts", () => {
    expect(() => validateScriptShots([shot(1, 3), shot(2, 4)], 8)).toThrow(
      "当前为 7 秒"
    );
  });

  test("supports any AI-decided shot count and fractional durations", () => {
    const result = validateScriptShots(
      [shot(1, 0.75), shot(2, 1.25), shot(3, 0.5), shot(4, 1), shot(5, 1.5)],
      5
    );
    expect(result).toHaveLength(5);
  });

  test("persists and parses the editable five-column script", () => {
    const markdown = renderScriptMarkdown(4, "视觉方向", [shot(1, 2), shot(2, 3)]);
    expect(markdown).toContain("| 镜头编号 | 时长 | Prompt | Audio & SFX | VO |");
    expect(parseScriptMarkdown(markdown)).toEqual([shot(1, 2), shot(2, 3)]);
  });

  test("requires English Prompt and Audio/SFX while allowing Chinese VO", () => {
    expect(() => validateScriptShots([{ ...shot(1, 5), prompt: "中文画面提示词" }], 5)).toThrow(
      "Prompt 必须使用英文"
    );
    expect(() => validateScriptShots([{ ...shot(1, 5), audioSfxPrompt: "中文音效提示词" }], 5)).toThrow(
      "Audio & SFX Prompt 必须使用英文"
    );
    expect(validateScriptShots([shot(1, 5)], 5)[0]?.vo).toContain("旁白");
  });

  test("accepts the requested five-column storyboard with fractional shot durations", () => {
    const result = validateStoryboardShots(
      [storyboardShot("S1", 1.5), storyboardShot("S2", 2), storyboardShot("S3", 1.5)],
      5
    );
    expect(result.map((item) => item.duration)).toEqual([1.5, 2, 1.5]);
    expect(result[0]?.productPosition).toBe("画面正中");
  });

  test("parses persisted five-column storyboard rows before image generation", () => {
    const parsed = parseStoryboardMarkdown(`# 分镜设计

三段式结构

| 镜头 | 时长 | 画面内容 | 产品位置 | 人物动作 |
| --- | ---: | --- | --- | --- |
| S1 | 1.5s | 产品特写 | 画面正中 | 无人物 |
| S2 | 2s | 手持产品 | 人物手中 | 双手递出 |
| S3 | 1.5s | packshot | 画面正中 | 无人物 |
`);
    expect(parsed).toHaveLength(3);
    expect(parsed[1]).toEqual({
      shot: "S2",
      duration: 2,
      frameContent: "手持产品",
      productPosition: "人物手中",
      characterAction: "双手递出"
    });
  });

  test("rejects a storyboard whose total duration drifts", () => {
    expect(() =>
      validateStoryboardShots([storyboardShot("S1", 1.5), storyboardShot("S2", 2)], 5)
    ).toThrow("当前为 3.5 秒");
  });
});
