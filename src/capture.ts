import { access, copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { resolveContained, walkRepository } from "./fs.js";
import { detectScreenshotHarness } from "./scanner.js";
import { inspectImage } from "./image.js";
import { acceptedDimensionsForConfig } from "./preflight.js";
import type { ShipLayerManifest } from "./types.js";

export interface CapturePlan { executable: false; prerequisites: string[]; commands: string[]; instructions: string[]; detectedHarness: { sourceFiles: string[]; scenarioCount: number } }
export async function createCapturePlan(repository: string, manifest: ShipLayerManifest): Promise<CapturePlan> {
  const walked = await walkRepository(repository); const project = walked.files.find((file) => file.endsWith("project.pbxproj")); const workspace = walked.files.find((file) => file.endsWith("contents.xcworkspacedata")); const prerequisites: string[] = [];
  if (process.platform !== "darwin") prerequisites.push("Simulator capture requires macOS with Xcode.");
  if (!(await commandAvailable("xcodebuild")) || !(await commandAvailable("xcrun"))) prerequisites.push("Install Xcode command-line tools: xcode-select --install");
  if (!project && !workspace) prerequisites.push("No Xcode project/workspace was found.");
  const harness = await detectScreenshotHarness(repository);
  const unconfirmed = manifest.screenshots.scenarios.filter((scenario) => scenario.confirmation !== "confirmed");
  const instructions: string[] = [];
  if (harness.sourceFiles.length) {
    instructions.push(`Detected an existing screenshot UI-test harness in ${harness.sourceFiles.join(", ")} (${harness.scenarios.length} keepScreenshot(named:) call(s)).`);
    if (unconfirmed.length) instructions.push(`${unconfirmed.length} declared screenshot scenario(s) are still needs-human-confirmation: ${unconfirmed.map((scenario) => scenario.id).join(", ")}. Verify each one's real on-screen navigation, then set confirmation: confirmed in shiplayer.yml before check will pass.`);
  } else {
    instructions.push("No screenshot UI-test harness was detected (no keepScreenshot(named:)-shaped XCTAttachment(screenshot:)/XCUIScreen.main.screenshot() call in a *UITests source). ShipLayer cannot infer test actions or fabricate screenshots from launch arguments.");
    instructions.push("Run shiplayer prepare to generate a fillable template and its contract at screenshots/ui-test-harness-template.swift and screenshots/ui-test-harness-contract.md in the release package. Add real, verified navigation, add the file to a UI Testing target, then re-run shiplayer init --force (or hand-edit shiplayer.yml) so screenshots.scenarios reflects it.");
  }
  instructions.push("Run shiplayer prepare to also generate a manually-installed, workflow_dispatch-only capture workflow at screenshots/capture-workflow.yml. A human must copy it into the app repository's own .github/workflows/, review it, and press \"Run workflow\" themselves — ShipLayer never installs, commits, or dispatches it.");
  instructions.push(`Once you have exported PNG screenshot attachments (from the workflow's uploaded artifact, or a local .xcresult export), ingest them with: shiplayer capture <repo> --from <dir> --family <iphone|ipad> --locale <locale>. This copies and validates each file (readable PNG/JPEG, no alpha, an accepted App Store dimension, and internal consistency with what is already ingested) into ${manifest.screenshots.rawOutputDir}/{family}/{locale}/<scenario-id>.png; it never fabricates or invents a screenshot.`);
  instructions.push("No paid cloud CI is used automatically; the generated workflow is workflow_dispatch-only and stays uninstalled until a human copies and runs it.");
  return { executable: false, prerequisites, commands: [], instructions, detectedHarness: { sourceFiles: harness.sourceFiles, scenarioCount: harness.scenarios.length } };
}
export async function executeCapturePlan(plan: CapturePlan): Promise<Array<{ exitCode: number; command: string }>> { throw new Error(`Capture execution is unavailable until a repository-declared screenshot harness adapter is implemented.\n${plan.prerequisites.map((item) => `- ${item}`).join("\n")}`); }

export interface IngestOptions { from: string; family: "iphone" | "ipad"; locale: string }
export interface IngestedFile { scenarioId: string; sourceFile: string; destinationFile: string; width: number; height: number; format: "png" | "jpeg" }
export interface SkippedFile { sourceFile: string; reason: string }
export interface IngestResult { destinationDirectory: string; ingested: IngestedFile[]; skipped: SkippedFile[] }

/**
 * Ingestion is a safe local file operation, unlike generic xcodebuild execution above: it never
 * runs a simulator or a build, only copies and validates files a human already produced (from the
 * generated workflow's uploaded artifact, or a local .xcresult export). Every file is independently
 * re-validated by shiplayer check afterward; this is a convenience pass, not the authoritative gate.
 */
export async function ingestCaptures(repository: string, manifest: ShipLayerManifest, options: IngestOptions): Promise<IngestResult> {
  if (!manifest.app.deviceFamilies.includes(options.family)) throw new Error(`${options.family} is not a declared device family in app.deviceFamilies.`);
  if (!manifest.app.locales.includes(options.locale)) throw new Error(`${options.locale} is not a declared locale in app.locales.`);
  if (!manifest.screenshots.scenarios.length) throw new Error("screenshots.scenarios is empty; declare at least one scenario before ingesting captures.");
  const config = manifest.screenshots.configurations.find((item) => item.family === options.family && item.locale === options.locale);
  if (!config) throw new Error(`No screenshots.configurations entry exists for ${options.family}/${options.locale}; add one before ingesting captures for it.`);
  const sourceRoot = path.resolve(options.from);
  let sourceStat; try { sourceStat = await lstat(sourceRoot); } catch { throw new Error(`--from directory does not exist: ${sourceRoot}`); }
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error(`--from must be a real, non-symlinked directory: ${sourceRoot}`);
  // Recursive: xcresulttool's own attachment-export layout is not guaranteed to be flat (it may
  // nest attachments under per-test subdirectories), and a non-recursive scan would silently
  // ingest nothing from those with no skipped entry to explain why.
  const entries = (await collectImageFiles(sourceRoot)).map((file) => path.relative(sourceRoot, file));
  const destinationRelative = `${manifest.screenshots.rawOutputDir}/${options.family}/${options.locale}`;
  const destinationDirectory = await resolveContained(repository, destinationRelative, "screenshots.rawOutputDir");
  await mkdir(destinationDirectory, { recursive: true });
  const acceptedForConfig = acceptedDimensionsForConfig(config);
  let reference = await existingReferenceDimensions(destinationDirectory, acceptedForConfig);
  const ingested: IngestedFile[] = []; const skipped: SkippedFile[] = []; const usedScenarios = new Set<string>();
  for (const relativeSource of entries) {
    const sourceFile = path.join(sourceRoot, relativeSource);
    const sourceDetails = await lstat(sourceFile);
    if (sourceDetails.isSymbolicLink()) { skipped.push({ sourceFile: relativeSource, reason: "symlinked source files are refused" }); continue; }
    // Inspect before matching a scenario, so an unreadable/corrupt/zero-byte file is reported as
    // exactly that rather than as a misleading "no scenario matches this filename".
    const image = await inspectImage(sourceFile);
    if (!image) { skipped.push({ sourceFile: relativeSource, reason: "unreadable, oversized, symlinked, or not a valid PNG/JPEG" }); continue; }
    const scenario = matchScenario(path.basename(relativeSource), manifest.screenshots.scenarios);
    if (!scenario) { skipped.push({ sourceFile: relativeSource, reason: "no declared screenshot scenario matches this filename" }); continue; }
    if (usedScenarios.has(scenario.id)) { skipped.push({ sourceFile: relativeSource, reason: `scenario '${scenario.id}' was already ingested from another file in this batch` }); continue; }
    if (image.alpha) { skipped.push({ sourceFile: relativeSource, reason: "has an alpha channel; Apple rejects screenshots with transparency" }); continue; }
    if (!acceptedForConfig.has(`${image.width}x${image.height}`) && !acceptedForConfig.has(`${image.height}x${image.width}`)) { skipped.push({ sourceFile: relativeSource, reason: `${image.width}x${image.height} is not an accepted dimension for this ${options.family} configuration (expected one of ${[...acceptedForConfig].join(", ") || "none — the configured requiredDimensions itself is not a recognized App Store size"})` }); continue; }
    // Exact match only — a portrait capture and its landscape transpose are not "the same size"
    // for one screenshot set, even though both may individually be accepted dimensions.
    if (reference && (image.width !== reference.width || image.height !== reference.height)) { skipped.push({ sourceFile: relativeSource, reason: `${image.width}x${image.height} differs from ${reference.source} (${reference.width}x${reference.height}); App Store Connect requires one uniform size per screenshot set` }); continue; }
    const destinationFile = path.join(destinationDirectory, `${scenario.id}${image.format === "jpeg" ? ".jpg" : ".png"}`);
    const destinationExisting = await lstatIfExists(destinationFile);
    if (destinationExisting?.isSymbolicLink()) { skipped.push({ sourceFile: relativeSource, reason: "destination file is a symlink; refusing to overwrite" }); continue; }
    await copyFile(sourceFile, destinationFile);
    usedScenarios.add(scenario.id); reference ||= { width: image.width, height: image.height, source: relativeSource };
    ingested.push({ scenarioId: scenario.id, sourceFile: relativeSource, destinationFile: path.relative(repository, destinationFile), width: image.width, height: image.height, format: image.format });
  }
  return { destinationDirectory: path.relative(repository, destinationDirectory), ingested, skipped };
}

const MAX_INGEST_ENTRIES = 5_000;
/** Recursively collects PNG/JPEG file paths under `root`, refusing to descend into or return a
 * symlinked directory/file (matching the containment posture used everywhere else in this repo). */
async function collectImageFiles(root: string): Promise<string[]> {
  const files: string[] = []; let visited = 0;
  async function walk(directory: string): Promise<void> {
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > MAX_INGEST_ENTRIES) return;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (entry.isFile() && /\.(?:png|jpe?g)$/i.test(entry.name)) files.push(full);
    }
  }
  await walk(root);
  return files.sort();
}
async function existingReferenceDimensions(directory: string, acceptedForConfig: Set<string>): Promise<{ width: number; height: number; source: string } | undefined> {
  let existing: string[]; try { existing = await readdir(directory); } catch { return undefined; }
  for (const name of existing.filter((item) => /\.(?:png|jpe?g)$/i.test(item)).sort()) {
    const details = await inspectImage(path.join(directory, name));
    if (details && !details.alpha && (acceptedForConfig.has(`${details.width}x${details.height}`) || acceptedForConfig.has(`${details.height}x${details.width}`))) return { width: details.width, height: details.height, source: name };
  }
  return undefined;
}
async function lstatIfExists(target: string) { try { return await lstat(target); } catch { return undefined; } }
/** Matches an exported attachment filename to a declared scenario: an exact/`<id>-*` stem match first
 * (preferring the longest/most-specific id on a tie between overlapping ids), falling back to a
 * slugified match only when it is unambiguous. Never guesses across a genuine tie. */
function matchScenario(filename: string, scenarios: ShipLayerManifest["screenshots"]["scenarios"]): { id: string } | undefined {
  const stem = path.basename(filename, path.extname(filename));
  const exact = scenarios.filter((scenario) => stem === scenario.id || stem.startsWith(`${scenario.id}-`));
  if (exact.length) return exact.reduce((best, candidate) => candidate.id.length > best.id.length ? candidate : best);
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const candidates = scenarios.filter((scenario) => slug === scenario.id || slug.startsWith(`${scenario.id}-`) || (scenario.id.length > 2 && slug.includes(scenario.id)));
  return candidates.length === 1 ? candidates[0] : undefined;
}
async function commandAvailable(command: string): Promise<boolean> { const candidates = process.env.PATH?.split(path.delimiter).map((directory) => path.join(directory, command)) || []; for (const candidate of candidates) try { await access(candidate, constants.X_OK); return true; } catch { /* next */ } return false; }
