import { mkdir, readdir, readFile, stat, writeFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "Pods", "Carthage", "DerivedData", "build", ".build", "dist", ".swiftpm", "vendor", "release", "shiplayer-release"]);
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_FILES = 5_000;

export async function pathExists(filePath: string): Promise<boolean> { return existsSync(filePath); }
export async function ensureDirectory(directory: string): Promise<void> { await mkdir(directory, { recursive: true }); }
export async function readText(filePath: string): Promise<string> { return readFile(filePath, "utf8"); }
export async function writeText(filePath: string, content: string): Promise<void> { await ensureDirectory(path.dirname(filePath)); await writeFile(filePath, content, "utf8"); }
export async function copyFileTree(from: string, to: string): Promise<void> { await cp(from, to, { recursive: true }); }

export interface WalkResult { files: string[]; ignoredDirectories: string[]; filesOverLimit: number }
export async function walkRepository(root: string): Promise<WalkResult> {
  const files: string[] = []; const ignoredDirectories = new Set<string>(); let filesOverLimit = 0;
  async function walk(directory: string): Promise<void> {
    if (files.length >= MAX_FILES) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute);
      if (entry.isDirectory()) { if (IGNORED_DIRECTORIES.has(entry.name) || /^(?:shiplayer-)?release(?:-|$)/.test(entry.name)) { ignoredDirectories.add(relative || entry.name); continue; } await walk(absolute); }
      else if (entry.isFile()) { const details = await stat(absolute); if (details.size > MAX_FILE_BYTES) { filesOverLimit++; continue; } files.push(absolute); if (files.length >= MAX_FILES) return; }
    }
  }
  await walk(root); return { files, ignoredDirectories: [...ignoredDirectories].sort(), filesOverLimit };
}

export function relative(root: string, filePath: string): string { return path.relative(root, filePath).split(path.sep).join("/"); }
export function stableJson(value: unknown): string { return `${JSON.stringify(sortValue(value), null, 2)}\n`; }
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortValue(child)]));
  return value;
}
