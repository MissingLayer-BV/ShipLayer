import { mkdir, readdir, readFile, lstat, stat, writeFile, cp, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "Pods", "Carthage", "DerivedData", "build", ".build", "dist", ".swiftpm", "vendor", "release", "shiplayer-release", ".shiplayer-staging", ".next", ".turbo", "coverage", ".cache", ".tools", ".wrangler", ".wrangler-dry-run"]);
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_ENTRIES = 5_000;

export async function pathExists(filePath: string): Promise<boolean> { return existsSync(filePath); }
export async function ensureDirectory(directory: string): Promise<void> { await mkdir(directory, { recursive: true }); }
export async function readText(filePath: string): Promise<string> { return readFile(filePath, "utf8"); }
export async function writeText(filePath: string, content: string): Promise<void> { await ensureDirectory(path.dirname(filePath)); await writeFile(filePath, content, "utf8"); }
export async function copyFileTree(from: string, to: string): Promise<void> { await cp(from, to, { recursive: true }); }

export interface WalkResult { files: string[]; assetFiles: string[]; ignoredDirectories: string[]; filesOverLimit: number; filesOverLimitPaths: string[]; unreadable: string[]; symlinksIgnored: string[]; symlinkDirectoriesIgnored: string[]; symlinkFilesIgnored: string[]; entriesVisited: number; truncated: boolean }
export async function walkRepository(root: string): Promise<WalkResult> {
  const files: string[] = []; const assetFiles: string[] = []; const ignoredDirectories = new Set<string>(); const unreadable = new Set<string>(); const symlinksIgnored = new Set<string>(); const symlinkDirectoriesIgnored = new Set<string>(); const symlinkFilesIgnored = new Set<string>(); const filesOverLimitPaths = new Set<string>(); let filesOverLimit = 0; let entriesVisited = 0; let truncated = false;
  async function walk(directory: string): Promise<void> {
    if (entriesVisited >= MAX_ENTRIES) { truncated = true; return; }
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { unreadable.add(relative(root, directory)); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entriesVisited >= MAX_ENTRIES) { truncated = true; return; }
      entriesVisited++;
      const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute);
      if (entry.isSymbolicLink()) {
        // Never traverse a link, even if it points back into the repository.
        // We only classify it so preflight can conservatively block an omitted
        // source tree while allowing an unrelated linked README to remain a warn.
        symlinksIgnored.add(relative);
        try { if ((await stat(absolute)).isDirectory()) symlinkDirectoriesIgnored.add(relative); else symlinkFilesIgnored.add(relative); }
        catch { unreadable.add(relative); }
        continue;
      }
      if (entry.isDirectory()) { if (IGNORED_DIRECTORIES.has(entry.name) || /^(?:shiplayer-)?release(?:-|$)/.test(entry.name)) { ignoredDirectories.add(relative || entry.name); continue; } await walk(absolute); }
      else if (entry.isFile()) { try { const details = await stat(absolute); assetFiles.push(absolute); if (details.size > MAX_FILE_BYTES) { filesOverLimit++; filesOverLimitPaths.add(relative); continue; } files.push(absolute); } catch { unreadable.add(relative); } }
    }
  }
  await walk(root); return { files, assetFiles: assetFiles.sort(), ignoredDirectories: [...ignoredDirectories].sort(), filesOverLimit, filesOverLimitPaths: [...filesOverLimitPaths].sort(), unreadable: [...unreadable].sort(), symlinksIgnored: [...symlinksIgnored].sort(), symlinkDirectoriesIgnored: [...symlinkDirectoriesIgnored].sort(), symlinkFilesIgnored: [...symlinkFilesIgnored].sort(), entriesVisited, truncated };
}

export function relative(root: string, filePath: string): string { return path.relative(root, filePath).split(path.sep).join("/"); }
export function stableJson(value: unknown): string { return `${JSON.stringify(sortValue(value), null, 2)}\n`; }
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortValue(child)]));
  return value;
}

export function safeRelativePath(input: string, label: string): string {
  if (!input || input.includes("\0") || path.isAbsolute(input)) throw new Error(`${label} must be a non-empty relative path.`);
  const normalized = path.posix.normalize(input.split(path.sep).join("/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`${label} must stay within the repository and cannot contain traversal components.`);
  return normalized;
}
export async function resolveContained(root: string, input: string, label: string): Promise<string> {
  const relativePath = safeRelativePath(input, label); const canonicalRoot = await realpath(root); const candidate = path.resolve(canonicalRoot, relativePath);
  if (candidate === canonicalRoot || !candidate.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error(`${label} resolves outside the repository.`);
  let cursor = canonicalRoot;
  for (const part of relativePath.split("/")) { cursor = path.join(cursor, part); try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`${label} cannot traverse symlinks.`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  return candidate;
}
