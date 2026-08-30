import { deflateSync, inflateSync } from "node:zlib";

interface DecodedPng {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface StoryboardTileLayout {
  shot: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComposedStoryboard {
  bytes: Uint8Array;
  width: number;
  height: number;
  tiles: StoryboardTileLayout[];
}

const pngSignature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Buffer => {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const output = Buffer.alloc(data.byteLength + 12);
  output.writeUInt32BE(data.byteLength, 0);
  body.copy(output, 4);
  output.writeUInt32BE(crc32(body), data.byteLength + 8);
  return output;
};

const paeth = (left: number, up: number, upperLeft: number): number => {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
};

export const decodePng = (input: Uint8Array): DecodedPng => {
  const bytes = Buffer.from(input);
  if (!pngSignature.every((value, index) => bytes[index] === value)) {
    throw new Error("静态分镜拼版只接受 ORZ 返回的 PNG 图片");
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0) {
    throw new Error("静态分镜 PNG 必须是 8-bit 非交错格式");
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  if (![0, 2, 3, 4, 6].includes(colorType)) throw new Error(`不支持的 PNG 色彩类型：${colorType}`);
  const rowLength = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  const raw = new Uint8Array(rowLength * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset] ?? 0;
    sourceOffset += 1;
    for (let x = 0; x < rowLength; x += 1) {
      const value = inflated[sourceOffset + x] ?? 0;
      const destination = y * rowLength + x;
      const left = x >= channels ? raw[destination - channels] ?? 0 : 0;
      const up = y > 0 ? raw[destination - rowLength] ?? 0 : 0;
      const upperLeft = y > 0 && x >= channels ? raw[destination - rowLength - channels] ?? 0 : 0;
      raw[destination] = filter === 0
        ? value
        : filter === 1
          ? (value + left) & 0xff
          : filter === 2
            ? (value + up) & 0xff
            : filter === 3
              ? (value + Math.floor((left + up) / 2)) & 0xff
              : filter === 4
                ? (value + paeth(left, up, upperLeft)) & 0xff
                : value;
    }
    sourceOffset += rowLength;
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    if (colorType === 6) {
      pixels.set(raw.subarray(source, source + 4), target);
    } else if (colorType === 2) {
      pixels[target] = raw[source] ?? 0;
      pixels[target + 1] = raw[source + 1] ?? 0;
      pixels[target + 2] = raw[source + 2] ?? 0;
      pixels[target + 3] = 255;
    } else if (colorType === 4) {
      const gray = raw[source] ?? 0;
      pixels[target] = gray;
      pixels[target + 1] = gray;
      pixels[target + 2] = gray;
      pixels[target + 3] = raw[source + 1] ?? 255;
    } else if (colorType === 3) {
      const paletteIndex = raw[source] ?? 0;
      pixels[target] = palette?.[paletteIndex * 3] ?? 0;
      pixels[target + 1] = palette?.[paletteIndex * 3 + 1] ?? 0;
      pixels[target + 2] = palette?.[paletteIndex * 3 + 2] ?? 0;
      pixels[target + 3] = transparency?.[paletteIndex] ?? 255;
    } else {
      const gray = raw[source] ?? 0;
      pixels[target] = gray;
      pixels[target + 1] = gray;
      pixels[target + 2] = gray;
      pixels[target + 3] = 255;
    }
  }
  return { width, height, pixels };
};

export const encodePng = (image: DecodedPng): Uint8Array => {
  const rowLength = image.width * 4;
  const raw = Buffer.alloc((rowLength + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const target = y * (rowLength + 1);
    raw[target] = 0;
    Buffer.from(image.pixels.subarray(y * rowLength, (y + 1) * rowLength)).copy(raw, target + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from(pngSignature),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array())
  ]);
};

const copyCover = (
  source: DecodedPng,
  target: Uint8Array,
  targetWidth: number,
  targetHeight: number,
  destinationX: number,
  destinationY: number,
  destinationWidth: number,
  destinationHeight: number
): void => {
  const scale = Math.max(destinationWidth / source.width, destinationHeight / source.height);
  const visibleWidth = destinationWidth / scale;
  const visibleHeight = destinationHeight / scale;
  const startX = (source.width - visibleWidth) / 2;
  const startY = (source.height - visibleHeight) / 2;
  for (let y = 0; y < destinationHeight; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.max(0, Math.round(startY + (y + 0.5) / scale)));
    for (let x = 0; x < destinationWidth; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.max(0, Math.round(startX + (x + 0.5) / scale)));
      const sourceIndex = (sourceY * source.width + sourceX) * 4;
      const targetIndex = ((destinationY + y) * targetWidth + destinationX + x) * 4;
      target.set(source.pixels.subarray(sourceIndex, sourceIndex + 4), targetIndex);
    }
  }
};

const glyphs: Readonly<Record<string, readonly string[]>> = {
  S: ["11111", "10000", "10000", "11111", "00001", "00001", "11111"],
  "0": ["111", "101", "101", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "010", "010", "111"],
  "2": ["111", "001", "001", "111", "100", "100", "111"],
  "3": ["111", "001", "001", "111", "001", "001", "111"],
  "4": ["101", "101", "101", "111", "001", "001", "001"],
  "5": ["111", "100", "100", "111", "001", "001", "111"],
  "6": ["111", "100", "100", "111", "101", "101", "111"],
  "7": ["111", "001", "001", "010", "010", "100", "100"],
  "8": ["111", "101", "101", "111", "101", "101", "111"],
  "9": ["111", "101", "101", "111", "001", "001", "111"],
  "-": ["000", "000", "000", "111", "000", "000", "000"]
};

const fill = (
  pixels: Uint8Array,
  width: number,
  x: number,
  y: number,
  rectangleWidth: number,
  rectangleHeight: number,
  color: readonly [number, number, number, number]
): void => {
  for (let row = Math.max(0, y); row < Math.min(y + rectangleHeight, pixels.byteLength / 4 / width); row += 1) {
    for (let column = Math.max(0, x); column < Math.min(x + rectangleWidth, width); column += 1) {
      const index = (row * width + column) * 4;
      const alpha = color[3] / 255;
      pixels[index] = Math.round(color[0] * alpha + (pixels[index] ?? 0) * (1 - alpha));
      pixels[index + 1] = Math.round(color[1] * alpha + (pixels[index + 1] ?? 0) * (1 - alpha));
      pixels[index + 2] = Math.round(color[2] * alpha + (pixels[index + 2] ?? 0) * (1 - alpha));
      pixels[index + 3] = 255;
    }
  }
};

const drawLabel = (pixels: Uint8Array, width: number, x: number, y: number, label: string): void => {
  const normalized = label.toUpperCase().replace(/[^S0-9-]/g, "").slice(0, 6) || "S";
  const scale = 5;
  const glyphWidth = (character: string): number => glyphs[character]?.[0]?.length ?? 3;
  const textWidth = [...normalized].reduce((sum, character) => sum + glyphWidth(character) * scale + scale, 0) - scale;
  fill(pixels, width, x, y, textWidth + 24, 7 * scale + 20, [0, 0, 0, 178]);
  let cursor = x + 12;
  for (const character of normalized) {
    const glyph = glyphs[character] ?? glyphs.S!;
    for (const [row, line] of glyph.entries()) {
      for (const [column, bit] of [...line].entries()) {
        if (bit === "1") fill(pixels, width, cursor + column * scale, y + 10 + row * scale, scale, scale, [255, 255, 255, 255]);
      }
    }
    cursor += glyphWidth(character) * scale + scale;
  }
};

const ratioValue = (ratio: string): number => {
  const [width = 16, height = 9] = ratio.split(":").map(Number);
  return width > 0 && height > 0 ? width / height : 16 / 9;
};

export const composeStoryboard = (
  frames: readonly { shot: string; bytes: Uint8Array }[],
  aspectRatio: string
): ComposedStoryboard => {
  if (frames.length === 0) throw new Error("没有可拼版的静态分镜");
  const decoded = frames.map((frame) => ({ shot: frame.shot, image: decodePng(frame.bytes) }));
  const columns = Math.ceil(Math.sqrt(frames.length));
  const rows = Math.ceil(frames.length / columns);
  const padding = 16;
  const canvasWidth = ratioValue(aspectRatio) < 1 ? 1200 : 1920;
  const tileWidth = Math.floor((canvasWidth - padding * (columns + 1)) / columns);
  const tileHeight = Math.max(1, Math.round(tileWidth / ratioValue(aspectRatio)));
  const canvasHeight = padding + rows * (tileHeight + padding);
  const pixels = new Uint8Array(canvasWidth * canvasHeight * 4);
  for (let index = 0; index < pixels.byteLength; index += 4) {
    pixels[index] = 9;
    pixels[index + 1] = 10;
    pixels[index + 2] = 12;
    pixels[index + 3] = 255;
  }
  const tiles: StoryboardTileLayout[] = [];
  decoded.forEach((frame, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const itemsInRow = Math.min(columns, frames.length - row * columns);
    const rowOffset = itemsInRow < columns ? ((columns - itemsInRow) * (tileWidth + padding)) / 2 : 0;
    const x = Math.round(padding + rowOffset + column * (tileWidth + padding));
    const y = padding + row * (tileHeight + padding);
    copyCover(frame.image, pixels, canvasWidth, canvasHeight, x, y, tileWidth, tileHeight);
    drawLabel(pixels, canvasWidth, x + 14, y + 14, frame.shot);
    tiles.push({ shot: frame.shot, x, y, width: tileWidth, height: tileHeight });
  });
  return {
    bytes: encodePng({ width: canvasWidth, height: canvasHeight, pixels }),
    width: canvasWidth,
    height: canvasHeight,
    tiles
  };
};

export const cropStoryboardTile = (overview: Uint8Array, tile: StoryboardTileLayout): Uint8Array => {
  const source = decodePng(overview);
  const pixels = new Uint8Array(tile.width * tile.height * 4);
  for (let y = 0; y < tile.height; y += 1) {
    const start = ((tile.y + y) * source.width + tile.x) * 4;
    pixels.set(source.pixels.subarray(start, start + tile.width * 4), y * tile.width * 4);
  }
  return encodePng({ width: tile.width, height: tile.height, pixels });
};
