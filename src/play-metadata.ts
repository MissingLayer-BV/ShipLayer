import { createHash } from "node:crypto";
import path from "node:path";
import { lstat, readdir, readFile } from "node:fs/promises";
import { resolveContained } from "./fs.js";
import type { PlayManifest, PlayScope } from "./play-types.js";

export const PLAY_IMAGE_TYPES = ["phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots"] as const;
export type PlayImageType = typeof PLAY_IMAGE_TYPES[number];
export interface PlayListing { language: string; title: string; shortDescription: string; fullDescription: string; releaseNote?: string; images: Partial<Record<PlayImageType, PlayImage[]>> }
export interface PlayImage { filename: string; path: string; bytes: Buffer; sha256: string; contentType: "image/png" | "image/jpeg" }

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
    if (!images.phoneScreenshots?.length) throw new Error(`${language} requires at least one phone screenshot.`);
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
    const file = path.join(root, entry.name); const bytes = await regularFile(file, `${locale}/${imageType}/${entry.name}`);
    if (!bytes.length) throw new Error(`Screenshot is empty: ${locale}/${imageType}/${entry.name}`);
    const contentType = /\.png$/i.test(entry.name) ? "image/png" as const : "image/jpeg" as const;
    images.push({ filename: entry.name, path: file, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), contentType });
  }
  return images;
}
async function regularFile(file: string, label: string): Promise<Buffer> {
  const details = await lstat(file).catch(() => undefined);
  if (!details?.isFile() || details.isSymbolicLink()) throw new Error(`Missing or unsafe Google Play metadata file: ${label}`);
  return readFile(file);
}
