import { describe, expect, test } from "bun:test";
import { buildStoryboardImagePayload } from "../src/utility/providers/orz-image-adapter.js";
import { parseScriptMarkdown, renderScriptMarkdown } from "../src/utility/workflow-service.js";
import { ORZ_MODELS } from "../src/shared/orz-models.js";

/**
 * Notion 规范 §3.5 硬规则：
 *
 *   「图片生成使用的 Prompt 必须等于脚本对应列的内容，不得二次改写。
 *     参考图作为独立参数传递，不修改 Prompt 文本。」
 *
 * 这条规则是「脚本是唯一事实来源」的直接推论。一旦某层顺手给 Prompt 拼上
 * 画幅、镜号或风格词，用户在脚本里看到的和模型真正收到的就不是同一句话，
 * 之后所有关于「为什么生成的图不对」的排查都会走错方向。
 *
 * 行为本身一直是对的，但此前没有测试守住 —— 任何人在 adapter 或上游加一句
 * 字符串拼接都不会被发现。
 */
describe("storyboard prompt fidelity", () => {
  const scriptPrompt =
    "Close-up of the matte black bottle rotating slowly on wet slate, cold rim light";

  test("passes the script prompt through to ORZ byte for byte", () => {
    const payload = buildStoryboardImagePayload({
      shotId: "S1",
      prompt: scriptPrompt,
      aspectRatio: "16:9",
      referenceImageUrls: [],
      count: 1,
      outputFormat: "png"
    });

    expect(payload.input.prompt).toBe(scriptPrompt);
  });

  test("survives a round trip through the script markdown table", () => {
    // 真实链路是「模型写出表格 → 解析 → 取 prompt 列 → 送图片模型」。
    // 表格渲染与解析各自都可能吃掉或转义字符，所以要走完整往返而不是
    // 直接断言常量。
    const rendered = renderScriptMarkdown(1, "冷峻质感", [
      { shotId: "S1", duration: 5, prompt: scriptPrompt, audioSfxPrompt: "Low rumble", vo: "" }
    ]);
    const [shot] = parseScriptMarkdown(rendered);

    expect(shot?.prompt).toBe(scriptPrompt);

    const payload = buildStoryboardImagePayload({
      shotId: shot!.shotId,
      prompt: shot!.prompt,
      aspectRatio: "16:9",
      referenceImageUrls: [],
      count: 1,
      outputFormat: "png"
    });

    expect(payload.input.prompt).toBe(scriptPrompt);
  });

  test("carries reference images as separate parameters instead of folding them into the prompt", () => {
    const references = [
      "https://cdn.orz.sh/file-product.png",
      "https://cdn.orz.sh/file-character.png"
    ];
    const payload = buildStoryboardImagePayload({
      shotId: "S2",
      prompt: scriptPrompt,
      aspectRatio: "16:9",
      referenceImageUrls: references,
      count: 1,
      outputFormat: "png"
    });

    expect(payload.input.prompt).toBe(scriptPrompt);
    expect(payload.input.image_url).toBe(references[0]);
    expect(payload.input.image_urls).toEqual(references);
    // 参考图 URL 绝不能出现在 Prompt 文本里。
    for (const reference of references) {
      expect(payload.input.prompt).not.toContain(reference);
    }
  });

  test("keeps the prompt identical across every image model", () => {
    // 不同模型走不同的 version / input_fidelity 分支，Prompt 不受影响。
    const models = [
      ORZ_MODELS.storyboard,
      ORZ_MODELS.gptImageLow,
      ORZ_MODELS.gptImageMedium,
      ORZ_MODELS.gptImageHigh
    ];

    for (const modelId of models) {
      const payload = buildStoryboardImagePayload(
        {
          shotId: "S3",
          prompt: scriptPrompt,
          aspectRatio: "9:16",
          referenceImageUrls: [],
          count: 1,
          outputFormat: "png"
        },
        modelId
      );
      expect(payload.input.prompt).toBe(scriptPrompt);
    }
  });

  test("does not append the aspect ratio or shot id to the prompt", () => {
    const payload = buildStoryboardImagePayload({
      shotId: "S4",
      prompt: scriptPrompt,
      aspectRatio: "4:3",
      referenceImageUrls: [],
      count: 1,
      outputFormat: "png"
    });

    expect(payload.input.prompt).not.toContain("4:3");
    expect(payload.input.prompt).not.toContain("S4");
    expect(payload.input.aspect_ratio).toBe("4:3");
  });

  test("refuses an empty prompt instead of substituting a placeholder", () => {
    // 「零 mock」约定：拿不到真实 Prompt 就报错，不能塞占位词
    // 让用户以为生成成功了。
    expect(() =>
      buildStoryboardImagePayload({
        shotId: "S5",
        prompt: "   ",
        aspectRatio: "16:9",
        referenceImageUrls: [],
        count: 1,
        outputFormat: "png"
      })
    ).toThrow(/S5/);
  });
});
