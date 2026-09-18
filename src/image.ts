import { lstat, readFile } from "node:fs/promises";
import jpeg from "jpeg-js";

export interface ImageDetails { width: number; height: number; alpha: boolean; format: "png" | "jpeg" }
const MAX_IMAGE_FILE_BYTES = 50 * 1024 * 1024;
const MAX_DECODED_BYTES = 80 * 1024 * 1024;

/**
 * Read enough of an image to prove that its pixels can be decoded without following
 * symlinks or accepting unbounded input. This is a validation helper, not an image
 * transformation pipeline.
 */
export async function inspectImage(filePath: string): Promise<ImageDetails | undefined> {
  try {
    const stat = await lstat(filePath); if (stat.isSymbolicLink() || stat.size > MAX_IMAGE_FILE_BYTES) return undefined;
    const bytes = await readFile(filePath);
    return await inspectPng(bytes) || inspectJpeg(bytes);
  } catch { return undefined; }
}

async function inspectPng(bytes: Buffer): Promise<ImageDetails | undefined> {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) return undefined;
  let offset = 8; let width = 0; let height = 0; let alpha = false; let colorType = 0; let seenHeader = false; let seenData = false; let seenPalette = false; let seenEnd = false; const compressedData: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); const dataStart = offset + 8; const end = dataStart + length;
    if (length > bytes.length || end + 4 > bytes.length) return undefined;
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(dataStart, end); const expectedCrc = bytes.readUInt32BE(end);
    if (crc32(Buffer.concat([Buffer.from(type), data])) !== expectedCrc) return undefined;
    if (!seenHeader) {
      if (type !== "IHDR" || length !== 13) return undefined;
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (!width || !height || data[8] !== 8 || ![0, 2, 3, 4, 6].includes(data[9]) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return undefined;
      colorType = data[9]; alpha = colorType === 4 || colorType === 6; seenHeader = true;
    } else if (type === "tRNS") alpha = true;
    else if (type === "PLTE") seenPalette = true;
    else if (type === "IDAT") { seenData = true; compressedData.push(data); }
    else if (type === "IEND") { if (length !== 0 || !seenData || end + 4 !== bytes.length) return undefined; seenEnd = true; break; }
    offset = end + 4;
  }
  if (!seenHeader || !seenData || !seenEnd || (colorType === 3 && !seenPalette)) return undefined;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]; const expected = height * (1 + width * channels);
  if (!channels || !Number.isSafeInteger(expected) || expected > MAX_DECODED_BYTES) return undefined;
  try {
    const raw = (await import("node:zlib")).inflateSync(Buffer.concat(compressedData), { maxOutputLength: MAX_DECODED_BYTES });
    if (raw.length !== expected) return undefined;
    for (let row = 0; row < height; row++) if (raw[row * (1 + width * channels)] > 4) return undefined;
  } catch { return undefined; }
  return { width, height, alpha, format: "png" };
}

function inspectJpeg(bytes: Buffer): ImageDetails | undefined {
  if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return undefined;
  let offset = 2; let width = 0; let height = 0; let seenStart = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) break;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) return undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) return undefined;
      height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); if (!width || !height) return undefined;
    }
    if (marker === 0xda) { seenStart = true; break; }
    offset += length;
  }
  if (!seenStart || !width || !height || width * height * 4 > MAX_DECODED_BYTES) return undefined;
  try { const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: Math.ceil(MAX_DECODED_BYTES / (1024 * 1024)), formatAsRGBA: true }); return decoded.width === width && decoded.height === height && decoded.data.length === width * height * 4 ? { width, height, alpha: false, format: "jpeg" } : undefined; }
  catch { return undefined; }
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let index = 0; index < 8; index++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
