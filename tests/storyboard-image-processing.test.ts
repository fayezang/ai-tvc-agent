import { describe, expect, test } from "bun:test";
import {
  composeStoryboard,
  cropStoryboardTile,
  decodePng,
  encodePng
} from "../src/utility/storyboard-image-processing.js";

const solidPng = (red: number, green: number, blue: number): Uint8Array => {
  const width = 160;
  const height = 90;
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < pixels.byteLength; index += 4) {
    pixels[index] = red;
    pixels[index + 1] = green;
    pixels[index + 2] = blue;
    pixels[index + 3] = 255;
  }
  return encodePng({ width, height, pixels });
};

describe("Notion storyboard overview composition", () => {
  test("composes every shot in script order and crops the same overview instead of generating again", () => {
    const overview = composeStoryboard([
      { shot: "S1", bytes: solidPng(220, 30, 30) },
      { shot: "S2", bytes: solidPng(30, 220, 30) },
      { shot: "S3", bytes: solidPng(30, 30, 220) }
    ], "16:9");

    expect(overview.tiles.map((tile) => tile.shot)).toEqual(["S1", "S2", "S3"]);
    expect(overview.tiles).toHaveLength(3);
    expect(overview.width).toBe(1920);
    expect(decodePng(overview.bytes).height).toBe(overview.height);

    const s2 = overview.tiles[1]!;
    const cropped = decodePng(cropStoryboardTile(overview.bytes, s2));
    expect(cropped.width).toBe(s2.width);
    expect(cropped.height).toBe(s2.height);
    const center = ((Math.floor(cropped.height / 2) * cropped.width) + Math.floor(cropped.width / 2)) * 4;
    expect(cropped.pixels[center + 1]).toBeGreaterThan(180);
  });
});
