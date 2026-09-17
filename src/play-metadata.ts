import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { lstat, readdir, readFile } from "node:fs/promises";
import { resolveContained } from "./fs.js";
import { inspectImage } from "./image.js";
import type { PlayManifest, PlayScope } from "./play-types.js";

export const PLAY_IMAGE_TYPES = ["phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots"] as const;
// Single-file store-listing assets (same supply `images/` directory, not per-type folders).
// The Play API addresses them through the same images endpoints as screenshots.
export const PLAY_LISTING_ASSETS = ["icon", "featureGraphic"] as const;
export type PlayImageType = typeof PLAY_IMAGE_TYPES[number] | typeof PLAY_LISTING_ASSETS[number];
const MAX_PLAY_SCREENSHOT_BYTES = 8 * 1024 * 1024;
export interface PlayListing { language: string; title: string; shortDescription: string; fullDescription: string; releaseNote?: string; images: Partial<Record<PlayImageType, PlayImage[]>> }
export interface PlayImage { filename: string; path: string; size: number; sha256: string; contentType: "image/png" | "image/jpeg" }

export async function readPlayMetadata(repository: string, manifest: PlayManifest, scope: PlayScope = "listings"): Promise<Map<string, PlayListing>> {
  const root = await resolveContained(repository, manifest.metadata.directory, "Google Play metadata directory");
  const details = await lstat(root).catch(() => undefined);
  if (!details?.isDirectory() || details.isSymbolicLink()) throw new Error(`Google Play metadata directory does not exist: ${manifest.metadata.directory}`);
  const entries = await readdir(root, { withFileTypes: true });
  const unsafeLocale = entries.find((entry) => entry.isSymbolicLink());
  if (unsafeLocale) throw new Error(`Google Play metadata cannot contain a symlink: ${unsafeLocale.name}`);
  const locales = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name).sort();
  if (!locales.length) throw new Error("Google Play metadata contains no locale directories.");
  const listings = new Map<string, PlayListing>();
  for (const language of locales) {
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) throw new Error(`Invalid Google Play locale directory: ${language}`);
    const localeRoot = path.join(root, language);
    const title = await textFile(localeRoot, "title.txt", 30);
    const shortDescription = await textFile(localeRoot, "short_description.txt", 80);
    const fullDescription = await textFile(localeRoot, "full_description.txt", 4000);
    const releaseNote = manifest.release && scope !== "listings" ? await optionalTextFile(path.join(localeRoot, "changelogs"), `${manifest.release.versionCode}.txt`, 500) : undefined;
    const images: Partial<Record<PlayImageType, PlayImage[]>> = {};
    for (const imageType of PLAY_IMAGE_TYPES) {
      const loaded = await imageFiles(path.join(localeRoot, "images", imageType), language, imageType);
      if (loaded) images[imageType] = loaded;
    }
    // Google Play requires a 512x512 PNG hi-res icon and a 1024x500 feature graphic
    // (PNG or JPEG without transparency) for every listing, alongside screenshots.
    images.icon = await listingAsset(localeRoot, language, ["icon.png"], 512, 512, "Hi-res icon", ["image/png"], true);
    images.featureGraphic = await listingAsset(localeRoot, language, ["featureGraphic.png", "featureGraphic.jpg", "featureGraphic.jpeg"], 1024, 500, "Feature graphic", ["image/png", "image/jpeg"], false);
    if ((images.phoneScreenshots?.length || 0) < 2) throw new Error(`${language} requires at least two phone screenshots; Google Play does not publish a listing with fewer.`);
    listings.set(language, { language, title, shortDescription, fullDescription, releaseNote, images });
  }
  return listings;
}

async function textFile(root: string, filename: string, limit: number): Promise<string> {
  const value = (await regularFile(path.join(root, filename), filename)).toString("utf8").trim();
  if (!value) throw new Error(`${filename} is empty.`);
  if (value.length > limit) throw new Error(`${filename} exceeds Google Play's ${limit}-character limit.`);
  return value;
}
async function optionalTextFile(root: string, filename: string, limit: number): Promise<string> {
  const file = path.join(root, filename); const details = await lstat(file).catch(() => undefined);
  if (!details) throw new Error(`Missing release note: ${path.relative(path.dirname(root), file)}`);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Release note must be a regular file: ${file}`);
  const value = (await readFile(file, "utf8")).trim();
  if (!value) throw new Error(`Release note is empty: ${file}`);
  if (value.length > limit) throw new Error(`Release note exceeds Google Play's ${limit}-character limit: ${file}`);
  return value;
}
async function imageFiles(root: string, locale: string, imageType: PlayImageType): Promise<PlayImage[] | undefined> {
  const details = await lstat(root).catch(() => undefined);
  if (!details) return undefined;
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${locale}/${imageType} must be a real directory.`);
  const directoryEntries = await readdir(root, { withFileTypes: true });
  const unsafe = directoryEntries.find((entry) => entry.isSymbolicLink());
  if (unsafe) throw new Error(`${locale}/${imageType} cannot contain a symlink: ${unsafe.name}`);
  const entries = directoryEntries.filter((entry) => entry.isFile() && /\.(?:png|jpe?g)$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > 8) throw new Error(`${locale}/${imageType} contains ${entries.length} screenshots; Google Play permits at most 8.`);
  const images: PlayImage[] = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name); const details = await lstat(file);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Screenshot must be a regular file: ${locale}/${imageType}/${entry.name}`);
    if (!details.size) throw new Error(`Screenshot is empty: ${locale}/${imageType}/${entry.name}`);
    if (details.size > MAX_PLAY_SCREENSHOT_BYTES) throw new Error(`Screenshot exceeds Google Play's 8MB limit: ${locale}/${imageType}/${entry.name}`);
    const contentType = /\.png$/i.test(entry.name) ? "image/png" as const : "image/jpeg" as const;
    // Google Play accepts screenshots with at least one side 320px or larger and
    // neither side above 3840px. Decode every file: a corrupt image must fail here,
    // not mid-apply after the edit was opened.
    const decoded = await inspectImage(file);
    if (!decoded) throw new Error(`Screenshot is corrupt or unreadable: ${locale}/${imageType}/${entry.name}`);
    if (Math.max(decoded.width, decoded.height) < 320) throw new Error(`Screenshot is smaller than Google Play's 320px minimum: ${locale}/${imageType}/${entry.name} is ${decoded.width}x${decoded.height}.`);
    if (decoded.width > 3840 || decoded.height > 3840) throw new Error(`Screenshot exceeds Google Play's 3840px maximum: ${locale}/${imageType}/${entry.name} is ${decoded.width}x${decoded.height}.`);
    images.push({ filename: entry.name, path: file, size: details.size, sha256: await sha256File(file), contentType });
  }
  return images;
}

async function listingAsset(localeRoot: string, language: string, filenames: string[], width: number, height: number, label: string, contentTypes: Array<PlayImage["contentType"]>, allowAlpha: boolean): Promise<PlayImage[]> {
  for (const filename of filenames) {
    const file = path.join(localeRoot, "images", filename);
    const details = await lstat(file).catch(() => undefined);
    if (!details) continue;
    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${language}/images/${filename}`);
    if (!details.size) throw new Error(`${label} is empty: ${language}/images/${filename}`);
    const decoded = await inspectImage(file);
    if (!decoded) throw new Error(`${label} is corrupt or unreadable: ${language}/images/${filename}`);
    if (decoded.width !== width || decoded.height !== height) throw new Error(`${label} must be exactly ${width}x${height}px; ${language}/images/${filename} is ${decoded.width}x${decoded.height}.`);
    if (!contentTypes.includes(decoded.format === "png" ? "image/png" : "image/jpeg")) throw new Error(`${label} must be ${contentTypes.join(" or ")}: ${language}/images/${filename}`);
    if (!allowAlpha && decoded.alpha) throw new Error(`${label} must not contain transparency: ${language}/images/${filename}`);
    const contentType = decoded.format === "png" ? "image/png" as const : "image/jpeg" as const;
    return [{ filename, path: file, size: details.size, sha256: await sha256File(file), contentType }];
  }
  throw new Error(`${language} requires ${label} (${filenames.join(" or ")}) for the store listing.`);
}
async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
async function regularFile(file: string, label: string): Promise<Buffer> {
  const details = await lstat(file).catch(() => undefined);
  if (!details?.isFile() || details.isSymbolicLink()) throw new Error(`Missing or unsafe Google Play metadata file: ${label}`);
  return readFile(file);
}
