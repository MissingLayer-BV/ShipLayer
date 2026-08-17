import { lstat, readFile } from "node:fs/promises";

export interface ImageDetails { width: number; height: number; alpha: boolean; format: "png" | "jpeg" }

/** A deliberately small structural validator. It is not an image decoder, but rejects
 * truncated headers/chunks and files that only imitate dimensions. */
export async function inspectImage(filePath: string): Promise<ImageDetails | undefined> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) return undefined;
    const bytes = await readFile(filePath);
    return inspectPng(bytes) || inspectJpeg(bytes);
  } catch { return undefined; }
}

function inspectPng(bytes: Buffer): ImageDetails | undefined {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) return undefined;
  let offset = 8; let width = 0; let height = 0; let alpha = false; let seenHeader = false; let seenData = false; let seenEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); const dataStart = offset + 8; const end = dataStart + length;
    if (length > bytes.length || end + 4 > bytes.length) return undefined;
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(dataStart, end); const expectedCrc = bytes.readUInt32BE(end);
    if (crc32(Buffer.concat([Buffer.from(type), data])) !== expectedCrc) return undefined;
    if (!seenHeader) {
      if (type !== "IHDR" || length !== 13) return undefined;
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (!width || !height || data[8] !== 8 || ![0, 2, 3, 4, 6].includes(data[9])) return undefined;
      alpha = data[9] === 4 || data[9] === 6; seenHeader = true;
    } else if (type === "tRNS") alpha = true;
    else if (type === "IDAT") seenData = true;
    else if (type === "IEND") { if (length !== 0 || !seenData || end + 4 !== bytes.length) return undefined; seenEnd = true; break; }
    offset = end + 4;
  }
  return seenHeader && seenData && seenEnd ? { width, height, alpha, format: "png" } : undefined;
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
  return seenStart && width && height ? { width, height, alpha: false, format: "jpeg" } : undefined;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let index = 0; index < 8; index++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
