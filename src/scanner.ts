import path from "node:path";
import { parse } from "yaml";
import { readText, relative, walkRepository } from "./fs.js";
import type { AnalysisReport, Evidence, Finding } from "./types.js";

const PERMISSION_KEYS = ["NSCameraUsageDescription", "NSPhotoLibraryUsageDescription", "NSPhotoLibraryAddUsageDescription", "NSMicrophoneUsageDescription", "NSLocationWhenInUseUsageDescription", "NSUserTrackingUsageDescription", "NSContactsUsageDescription", "NSFaceIDUsageDescription"];
const APPLE_FRAMEWORKS = new Set(["URLSession", "StoreKit", "UserNotifications", "Photos", "AVFoundation", "CoreLocation", "Contacts"]);
const THIRD_PARTY_SDK_CANDIDATES = ["Alamofire", "Moya", "Firebase", "Sentry", "RevenueCat"];

export async function analyzeRepository(repository: string): Promise<AnalysisReport> {
  const root = path.resolve(repository); const walked = await walkRepository(root); const findings: Finding[] = []; const contradictions: string[] = []; const questions = new Set<string>();
  const byName = (name: string): string[] => walked.files.filter((file) => path.basename(file) === name);
  const projectYml = byName("project.yml"); const xcodeProjects = walked.files.filter((file) => file.endsWith("project.pbxproj")).map((file) => relative(root, path.dirname(file))); const workspaces = walked.files.filter((file) => file.endsWith("contents.xcworkspacedata")).map((file) => relative(root, path.dirname(file)));
  const settings: Record<string, Array<{ value: string; evidence: Evidence }>> = {};
  const push = (key: string, value: string, evidence: Evidence): void => { const normalized = value.trim().replace(/^["']|["']$/g, ""); const detectedKey = key === "bundleId" && /\.(?:tests|uitests)$/i.test(normalized) ? "testBundleId" : key; (settings[detectedKey] ||= []).push({ value: normalized, evidence }); };
  const scanText = async (file: string): Promise<void> => {
    const content = await readText(file); const source = relative(root, file);
    const kind: Evidence["kind"] = file.endsWith("Info.plist") ? "plist" : file.endsWith(".entitlements") ? "entitlement" : file.endsWith("PrivacyInfo.xcprivacy") ? "privacy-manifest" : file.endsWith(".storekit") ? "storekit" : file.endsWith("project.yml") || file.endsWith(".pbxproj") ? "project-setting" : "source-heuristic";
    const matched = (regex: RegExp, key: string): void => { for (const match of content.matchAll(regex)) push(key, match[1].trim(), { source, excerpt: match[0].slice(0, 220), confidence: kind === "source-heuristic" ? "medium" : "high", kind }); };
    matched(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\n]+)/g, "bundleId");
    matched(/MARKETING_VERSION\s*=\s*([^;\n]+)/g, "version"); matched(/CURRENT_PROJECT_VERSION\s*=\s*([^;\n]+)/g, "build"); matched(/IPHONEOS_DEPLOYMENT_TARGET\s*=\s*([^;\n]+)/g, "deploymentTarget"); matched(/TARGETED_DEVICE_FAMILY\s*=\s*([^;\n]+)/g, "deviceFamily");
    if (file.endsWith("project.yml")) {
      try { const yaml = parse(content) as Record<string, unknown>; const appName = typeof yaml.name === "string" ? yaml.name : undefined; if (appName) push("appName", appName, { source, excerpt: `name: ${appName}`, confidence: "high", kind: "project-setting" }); for (const key of ["PRODUCT_BUNDLE_IDENTIFIER", "MARKETING_VERSION", "CURRENT_PROJECT_VERSION", "IPHONEOS_DEPLOYMENT_TARGET"]) { const regex = new RegExp(`${key}["']?\\s*:\\s*["']?([^,}\\n"']+)`, "g"); matched(regex, ({ PRODUCT_BUNDLE_IDENTIFIER: "bundleId", MARKETING_VERSION: "version", CURRENT_PROJECT_VERSION: "build", IPHONEOS_DEPLOYMENT_TARGET: "deploymentTarget" } as Record<string, string>)[key]); } matched(/TARGETED_DEVICE_FAMILY["']?\s*:\s*["']?([0-9,]+)/g, "deviceFamily"); if (/ITSAppUsesNonExemptEncryption\s*:\s*false/.test(content)) push("encryption", "false", { source, excerpt: "ITSAppUsesNonExemptEncryption: false", confidence: "high", kind: "project-setting" }); else if (content.includes("ITSAppUsesNonExemptEncryption")) push("encryption", "declared", { source, confidence: "medium", kind: "project-setting" }); } catch { questions.add(`Could not parse ${source}; verify project settings manually.`); }
    }
    if (file.endsWith("Info.plist")) {
      for (const key of PERMISSION_KEYS) { const regex = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "g"); for (const match of content.matchAll(regex)) push(`permission:${key}`, match[1], { source, excerpt: match[0], confidence: "confirmed", kind }); }
      for (const match of content.matchAll(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<(true|false)\/>/g)) push("encryption", match[1], { source, excerpt: match[0], confidence: "confirmed", kind });
      for (const [name, tag] of [["bundleId", "CFBundleIdentifier"], ["version", "CFBundleShortVersionString"], ["build", "CFBundleVersion"]] as const) { const re = new RegExp(`<key>${tag}</key>\\s*<string>([^<]*)</string>`, "g"); for (const m of content.matchAll(re)) if (!m[1].includes("$(")) push(name, m[1], { source, excerpt: m[0], confidence: "confirmed", kind }); }
    }
    if (file.endsWith(".storekit")) { for (const match of content.matchAll(/"productID"\s*:\s*"([^"]+)"/g)) push("storekitProductId", match[1], { source, excerpt: match[0], confidence: "confirmed", kind }); }
    if (/\.(swift|m|mm|h)$/.test(file)) {
      for (const framework of APPLE_FRAMEWORKS) if (new RegExp(`\\b(?:import\\s+${framework}|${framework})\\b`).test(content)) push(`framework:${framework}`, framework, { source, excerpt: framework, confidence: "medium", kind: "source-heuristic" });
      for (const sdk of THIRD_PARTY_SDK_CANDIDATES) if (new RegExp(`\\b(?:import\\s+${sdk}|${sdk})\\b`).test(content)) push(`thirdPartySdkCandidate:${sdk}`, sdk, { source, excerpt: sdk, confidence: "medium", kind: "source-heuristic" });
      for (const match of content.matchAll(/https:\/\/[^\s"'<>]+/g)) push("endpoint", match[0].replace(/[),.;]+$/, ""), { source, excerpt: match[0], confidence: "low", kind: "source-heuristic" });
    }
    if (file.endsWith(".entitlements")) for (const match of content.matchAll(/<key>([^<]+)<\/key>/g)) push("entitlement", match[1], { source, excerpt: match[0], confidence: "confirmed", kind });
    if (file.endsWith("PrivacyInfo.xcprivacy")) push("privacyManifest", "present", { source, confidence: "confirmed", kind });
  };
  for (const file of walked.files.filter((file) => /(?:project\.yml|project\.pbxproj|Info\.plist|\.entitlements|PrivacyInfo\.xcprivacy|\.storekit|\.swift|\.m|\.mm|\.h)$/.test(file))) { try { await scanText(file); } catch { questions.add(`Unable to read or parse ${relative(root, file)}; inspect it manually.`); } }
  for (const [key, entries] of Object.entries(settings)) {
    const values = [...new Set(entries.map((entry) => entry.value))]; const primary = values[0]; if (values.length > 1 && ["bundleId", "version", "build", "deploymentTarget", "deviceFamily", "encryption"].includes(key)) contradictions.push(`${key} has conflicting values: ${values.join(", ")}.`);
    const processorCandidate = key.startsWith("thirdPartySdkCandidate:") || key === "endpoint";
    const appleFramework = key.startsWith("framework:");
    findings.push({ key, value: values.length === 1 ? primary : values, evidence: entries.map((entry) => entry.evidence), confidence: entries.some((entry) => entry.evidence.confidence === "confirmed") ? "confirmed" : entries.some((entry) => entry.evidence.confidence === "high") ? "high" : "medium", proposal: processorCandidate, message: processorCandidate ? "Heuristic finding only; confirm whether this is an external processor or declared data use." : appleFramework ? "Apple framework usage detected; this is not by itself an external processor or privacy declaration." : undefined });
  }
  if (!settings.bundleId) questions.add("Confirm the production bundle ID; no unambiguous product bundle ID was detected.");
  if (!settings.encryption) questions.add("Confirm export-compliance/encryption status.");
  if (!findings.some((finding) => finding.key.startsWith("permission:"))) questions.add("Confirm whether the app requests any protected-resource permissions outside Info.plist.");
  questions.add("Confirm App Privacy questionnaire answers and all third-party processor data handling; source heuristics are not declarations.");
  if (walked.truncated) questions.add(`Scanning stopped at the ${walked.files.length}-file safety limit; inspect excluded source manually.`);
  if (walked.filesOverLimit) questions.add(`${walked.filesOverLimit} oversized file(s) were skipped at the ${1_000_000}-byte content limit; inspect them manually.`);
  if (walked.unreadable.length) questions.add(`${walked.unreadable.length} unreadable path(s) were skipped; inspect them manually.`);
  if (walked.symlinksIgnored.length) questions.add(`${walked.symlinksIgnored.length} symlinked path(s) were ignored for containment safety; inspect them manually.`);
  return { schemaVersion: 1, repository: root, scannedAt: new Date().toISOString(), project: { xcodeProjects: xcodeProjects.sort(), workspaces: workspaces.sort(), projectYml: projectYml.map((file) => relative(root, file)).sort() }, findings: findings.sort((a, b) => a.key.localeCompare(b.key)), contradictions: contradictions.sort(), unresolvedQuestions: [...questions].sort(), ignored: { directories: walked.ignoredDirectories, filesOverLimit: walked.filesOverLimit, filesScanned: walked.files.length, unreadable: walked.unreadable, symlinksIgnored: walked.symlinksIgnored, truncated: walked.truncated } };
}

export function findValue(report: AnalysisReport, key: string): string | undefined { const value = report.findings.find((finding) => finding.key === key)?.value; return typeof value === "string" ? value : undefined; }
