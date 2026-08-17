import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { walkRepository } from "./fs.js";
import type { ShipLayerManifest } from "./types.js";

export interface CapturePlan { executable: boolean; prerequisites: string[]; commands: string[]; instructions: string[] }
export async function createCapturePlan(repository: string, manifest: ShipLayerManifest): Promise<CapturePlan> {
  const walked = await walkRepository(repository); const project = walked.files.find((file) => file.endsWith("project.pbxproj")); const xcodeProject = project ? path.dirname(project) : undefined; const prerequisites: string[] = [];
  const xcodebuild = await commandAvailable("xcodebuild"); const xcrun = await commandAvailable("xcrun"); if (!xcodebuild || !xcrun) prerequisites.push("Install Xcode command-line tools on macOS: xcode-select --install"); if (!xcodeProject) prerequisites.push("Point ShipLayer at a native Xcode project; no .xcodeproj/project.pbxproj was found.");
  const scheme = process.env.SHIPLAYER_SCHEME || "<YOUR_SCHEME>"; if (scheme === "<YOUR_SCHEME>") prerequisites.push("Set SHIPLAYER_SCHEME to the app scheme before executing capture.");
  const deviceCommands = manifest.screenshots.configurations.flatMap((config) => manifest.screenshots.scenarios.map((scenario) => { const launch = scenario.launchArguments?.map((argument) => `-launchArg ${shell(argument)}`).join(" ") || ""; const destination = config.family === "ipad" ? "platform=iOS Simulator,name=iPad Pro 13-inch (M4)" : "platform=iOS Simulator,name=iPhone 16 Pro Max"; return `xcodebuild test -project ${shell(xcodeProject || "<YOUR_PROJECT>.xcodeproj")} -scheme ${shell(scheme)} -destination ${shell(destination)} ${launch} # scenario: ${scenario.id}`; }));
  const commands = ["# ShipLayer does not use paid cloud CI. Review commands before executing.", "# First list an available simulator runtime:", "xcrun simctl list devices available", ...deviceCommands];
  return { executable: prerequisites.length === 0, prerequisites, commands, instructions: ["Use UI tests or a configured screenshot test target that reads the scenario launch arguments.", `Save raw images under ${manifest.screenshots.rawOutputDir}/{iphone|ipad}/{locale}/.`, "Open screenshots/app-store-screenshots.project.json in the app-store-screenshots workflow to compose marketing assets.", "Do not upload screenshots until preflight checks dimensions and transparency."] };
}
export async function executeCapturePlan(plan: CapturePlan): Promise<{ exitCode: number; command: string }[]> { if (!plan.executable) throw new Error(`Capture cannot execute:\n${plan.prerequisites.map((item) => `- ${item}`).join("\n")}`); const commands = plan.commands.filter((command) => command.startsWith("xcodebuild")); const results: Array<{ exitCode: number; command: string }> = []; for (const command of commands) results.push({ command, exitCode: await runShell(command) }); return results; }
async function commandAvailable(command: string): Promise<boolean> { const candidates = process.env.PATH?.split(path.delimiter).map((directory) => path.join(directory, command)) || []; for (const candidate of candidates) try { await access(candidate, constants.X_OK); return true; } catch { /* try next */ } return false; }
function runShell(command: string): Promise<number> { return new Promise((resolve, reject) => { const child = spawn("/bin/sh", ["-lc", command], { stdio: "inherit" }); child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); }); }
function shell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
