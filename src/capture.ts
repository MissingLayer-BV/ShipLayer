import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { walkRepository } from "./fs.js";
import type { ShipLayerManifest } from "./types.js";

export interface CapturePlan { executable: false; prerequisites: string[]; commands: string[]; instructions: string[] }
export async function createCapturePlan(repository: string, manifest: ShipLayerManifest): Promise<CapturePlan> {
  const walked = await walkRepository(repository); const project = walked.files.find((file) => file.endsWith("project.pbxproj")); const workspace = walked.files.find((file) => file.endsWith("contents.xcworkspacedata")); const prerequisites: string[] = [];
  if (process.platform !== "darwin") prerequisites.push("Simulator capture requires macOS with Xcode.");
  if (!(await commandAvailable("xcodebuild")) || !(await commandAvailable("xcrun"))) prerequisites.push("Install Xcode command-line tools: xcode-select --install");
  if (!project && !workspace) prerequisites.push("No Xcode project/workspace was found.");
  prerequisites.push("Declare a screenshot UI-test harness in the app repository. ShipLayer cannot infer test actions or fabricate screenshots from launch arguments.");
  const target = workspace ? `workspace ${path.dirname(workspace)}` : project ? `project ${path.dirname(project)}` : "project/workspace";
  return { executable: false, prerequisites, commands: [], instructions: [`ShipLayer will not run a generic xcodebuild command because it would not capture screenshots by itself.`, `Create a deterministic screenshot UI-test target in the ${target} that saves actual app images for every configuration.`, `Use configurations under ${manifest.screenshots.rawOutputDir}/{iphone|ipad}/{locale}/, then run shiplayer check before upload.`, "No paid cloud CI is used automatically."] };
}
export async function executeCapturePlan(plan: CapturePlan): Promise<Array<{ exitCode: number; command: string }>> { throw new Error(`Capture execution is unavailable until a repository-declared screenshot harness adapter is implemented.\n${plan.prerequisites.map((item) => `- ${item}`).join("\n")}`); }
async function commandAvailable(command: string): Promise<boolean> { const candidates = process.env.PATH?.split(path.delimiter).map((directory) => path.join(directory, command)) || []; for (const candidate of candidates) try { await access(candidate, constants.X_OK); return true; } catch { /* next */ } return false; }
