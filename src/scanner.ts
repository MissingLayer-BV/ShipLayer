import path from "node:path";
import { parse } from "yaml";
import { readText, relative, walkRepository } from "./fs.js";
import type { AnalysisReport, Evidence, Finding } from "./types.js";
import { isXCUITestSourcePath, stripCodeComments } from "./evidence.js";
import { redactedCredentialPath, urlContainsCredentialMaterial } from "./secrets.js";

const PERMISSION_KEYS = ["NSCameraUsageDescription", "NSPhotoLibraryUsageDescription", "NSPhotoLibraryAddUsageDescription", "NSMicrophoneUsageDescription", "NSLocationWhenInUseUsageDescription", "NSUserTrackingUsageDescription", "NSContactsUsageDescription", "NSFaceIDUsageDescription"];
const APPLE_FRAMEWORKS = new Set(["URLSession", "StoreKit", "UserNotifications", "Photos", "AVFoundation", "CoreLocation", "Contacts"]);
const THIRD_PARTY_SDK_CANDIDATES = ["Alamofire", "Moya", "Firebase", "Sentry", "RevenueCat"];
// The permission-flow gates (src/preflight.ts) ask one question per category: "can the user
// dismiss a custom screen between requesting this feature and the system permission prompt?"
// (App Review 5.1.1(iv)). This list is the single source of truth for valid
// shiplayer.yml permissionFlows[].category values (see schema.json's permissionFlow $defs entry)
// and for which runtime APIs below are recognized. camera/microphone share one Apple API
// (AVCaptureDevice.requestAccess) distinguished only by its argument.
export const PERMISSION_FLOW_CATEGORIES = ["camera", "microphone", "photo-library", "location", "notifications", "contacts", "calendar", "reminders", "media-library", "speech-recognition", "motion", "tracking"] as const;
export type PermissionFlowCategory = (typeof PERMISSION_FLOW_CATEGORIES)[number];
export interface PermissionRequestSite { category: PermissionFlowCategory; index: number; excerpt: string; label: string; }
// Deliberately literal/heuristic API-shape matching, not a full Swift parse — consistent with
// every other detector in this file. Each pattern must include a real anchor (a distinctive type
// name, or an argument shape) rather than a bare generic method name alone, to keep false
// positives low; some Apple APIs (requestAccess, requestAuthorization) are shared across several
// unrelated frameworks, so those patterns require the owning type or a distinguishing argument.
const PERMISSION_REQUEST_PATTERNS: Array<{ category: PermissionFlowCategory; label: string; pattern: RegExp }> = [
  { category: "camera", label: "AVCaptureDevice.requestAccess(for: .video)", pattern: /\bAVCaptureDevice\.requestAccess\s*\(\s*for:\s*\.video\b/g },
  { category: "microphone", label: "AVCaptureDevice.requestAccess(for: .audio)", pattern: /\bAVCaptureDevice\.requestAccess\s*\(\s*for:\s*\.audio\b/g },
  { category: "microphone", label: "AVAudioApplication/AVAudioSession.requestRecordPermission", pattern: /\bAVAudioApplication\.requestRecordPermission\b|\.requestRecordPermission\s*[({]/g },
  { category: "photo-library", label: "PHPhotoLibrary.requestAuthorization", pattern: /\bPHPhotoLibrary\.requestAuthorization\b/g },
  { category: "location", label: "CLLocationManager requestWhenInUseAuthorization/requestAlwaysAuthorization", pattern: /\.requestWhenInUseAuthorization\s*\(\s*\)|\.requestAlwaysAuthorization\s*\(\s*\)/g },
  { category: "notifications", label: "UNUserNotificationCenter.requestAuthorization", pattern: /\bUNUserNotificationCenter\b[\s\S]{0,120}?\.requestAuthorization\s*\(|\.requestAuthorization\s*\(\s*options:\s*\[[^\]]{0,120}?\.(?:alert|badge|sound)\b/g },
  { category: "contacts", label: "CNContactStore.requestAccess", pattern: /\bCNContactStore\b[\s\S]{0,120}?\.requestAccess\s*\(|\.requestAccess\s*\(\s*for:\s*\.contacts\b/g },
  { category: "calendar", label: "EKEventStore requestAccess(to: .event)/requestFullAccessToEvents", pattern: /\.requestAccess\s*\(\s*to:\s*\.event\b|\.requestFullAccessToEvents\s*\(/g },
  { category: "reminders", label: "EKEventStore requestAccess(to: .reminder)/requestFullAccessToReminders", pattern: /\.requestAccess\s*\(\s*to:\s*\.reminder\b|\.requestFullAccessToReminders\s*\(/g },
  { category: "media-library", label: "MPMediaLibrary.requestAuthorization", pattern: /\bMPMediaLibrary\.requestAuthorization\b/g },
  { category: "speech-recognition", label: "SFSpeechRecognizer.requestAuthorization", pattern: /\bSFSpeechRecognizer\.requestAuthorization\b/g },
  { category: "motion", label: "CMMotionActivityManager", pattern: /\bCMMotionActivityManager\s*\(\s*\)/g },
  { category: "tracking", label: "ATTrackingManager.requestTrackingAuthorization", pattern: /\bATTrackingManager\.requestTrackingAuthorization\b/g },
];
/**
 * Finds runtime permission-request API call sites in `content` (a caller-prepared string — pass
 * raw source for a lightweight proposal, or comment/conditional-compilation-stripped source for a
 * gate that must not trust dead code). Exported so src/preflight.ts's permission-flow gates can
 * re-run the exact same detection against cleaned evidence text instead of keeping a second,
 * potentially-drifting copy of this pattern table.
 */
export function findPermissionRequestSites(content: string): PermissionRequestSite[] {
  const sites: PermissionRequestSite[] = [];
  for (const { category, label, pattern } of PERMISSION_REQUEST_PATTERNS) for (const match of content.matchAll(pattern)) sites.push({ category, index: match.index ?? 0, excerpt: match[0].slice(0, 160), label });
  return sites.sort((left, right) => left.index - right.index);
}
// Apple's required-reason API categories (enforced since May 2024): calling one of these
// APIs without declaring NSPrivacyAccessedAPITypes with an approved reason in
// PrivacyInfo.xcprivacy is a routine App Review rejection. Patterns are deliberately
// anchored to distinctive API shapes (C functions, FileManager/URL resource keys) rather
// than bare property names like `creationDate`, which also exist on EventKit types and
// would false-positive on calendar code.
export const REQUIRED_REASON_API_CATEGORIES = ["NSPrivacyAccessedAPICategoryUserDefaults", "NSPrivacyAccessedAPICategoryFileTimestamp", "NSPrivacyAccessedAPICategorySystemBootTime", "NSPrivacyAccessedAPICategoryDiskSpace", "NSPrivacyAccessedAPICategoryActiveKeyboards"] as const;
export type RequiredReasonApiCategory = (typeof REQUIRED_REASON_API_CATEGORIES)[number];
const REQUIRED_REASON_API_PATTERNS: Array<{ category: RequiredReasonApiCategory; label: string; pattern: RegExp }> = [
  { category: "NSPrivacyAccessedAPICategoryUserDefaults", label: "UserDefaults", pattern: /\b(?:NSUserDefaults|UserDefaults)\b/g },
  { category: "NSPrivacyAccessedAPICategoryFileTimestamp", label: "file timestamp API", pattern: /\battributesOfItem\(|\battributesOfFileSystem\(|NSURL(?:ContentModification|Creation|ContentAccess)DateKey|\bstat\(|\bfstat\(|\blstat\(|getattrlist\(|fgetattrlist\(/g },
  { category: "NSPrivacyAccessedAPICategorySystemBootTime", label: "systemUptime", pattern: /\bsystemUptime\b/g },
  { category: "NSPrivacyAccessedAPICategoryDiskSpace", label: "disk space API", pattern: /\bvolumeAvailableCapacity|\bvolumeTotalCapacity|\bstatfs\(|\bstatvfs\(|\bfstatfs\(/g },
  { category: "NSPrivacyAccessedAPICategoryActiveKeyboards", label: "activeInputModes", pattern: /\bactiveInputModes\b/g },
];
export function findRequiredReasonApiSites(content: string): Array<{ category: RequiredReasonApiCategory; label: string; excerpt: string }> {
  const sites: Array<{ category: RequiredReasonApiCategory; label: string; excerpt: string }> = [];
  for (const { category, label, pattern } of REQUIRED_REASON_API_PATTERNS) for (const match of content.matchAll(pattern)) sites.push({ category, label, excerpt: match[0].slice(0, 160) });
  return sites;
}
const PRIVACY_DATA_TYPE_MAP: Record<string, string> = { NSPrivacyCollectedDataTypeName: "Name", NSPrivacyCollectedDataTypeEmailAddress: "Email Address", NSPrivacyCollectedDataTypePhoneNumber: "Phone Number", NSPrivacyCollectedDataTypePhysicalAddress: "Physical Address", NSPrivacyCollectedDataTypeOtherUserContactInfo: "Other User Contact Info", NSPrivacyCollectedDataTypePhotosorVideos: "Photos or Videos", NSPrivacyCollectedDataTypeDeviceID: "Device ID", NSPrivacyCollectedDataTypeUserID: "User ID", NSPrivacyCollectedDataTypeOtherFinancialInfo: "Other Financial Info", NSPrivacyCollectedDataTypePurchases: "Purchases", NSPrivacyCollectedDataTypeProductInteraction: "Product Interaction", NSPrivacyCollectedDataTypeCrashData: "Crash Data", NSPrivacyCollectedDataTypePerformanceData: "Performance Data" };
const PRIVACY_PURPOSE_MAP: Record<string, string> = { NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising: "Third-Party Advertising", NSPrivacyCollectedDataTypePurposeDeveloperAdvertising: "Developer’s Advertising or Marketing", NSPrivacyCollectedDataTypePurposeAnalytics: "Analytics", NSPrivacyCollectedDataTypePurposeProductPersonalization: "Product Personalization", NSPrivacyCollectedDataTypePurposeAppFunctionality: "App Functionality", NSPrivacyCollectedDataTypePurposeOther: "Other Purposes" };

export async function analyzeRepository(repository: string): Promise<AnalysisReport> {
  const root = path.resolve(repository); const walked = await walkRepository(root); const findings: Finding[] = []; const contradictions: string[] = []; const questions = new Set<string>();
  const byName = (name: string): string[] => walked.files.filter((file) => path.basename(file) === name);
  const discoveredProjectYml = new Set(byName("project.yml")); const validProjectYml = new Set<string>(); const xcodeProjects = walked.files.filter((file) => file.endsWith("project.pbxproj")).map((file) => relative(root, path.dirname(file))); const workspaces = walked.files.filter((file) => file.endsWith("contents.xcworkspacedata")).map((file) => relative(root, path.dirname(file)));
  const settings: Record<string, Array<{ value: string; evidence: Evidence }>> = {};
  const push = (key: string, value: string, evidence: Evidence): void => {
    const normalized = key === "endpoint" ? normalizeEndpoint(value) : value.trim().replace(/^["']|["']$/g, "");
    // A variable indirection is evidence that needs human review, not a source
    // value that can contradict a confirmed release identity.
    if (["bundleId", "version", "build", "deploymentTarget", "deviceFamily", "encryption"].includes(key) && /\$\([^)]*\)/.test(normalized)) return;
    const finalSegment = normalized.split(".").at(-1) || "";
    const detectedKey = key === "endpoint" ? `endpoint:${normalized}` : key === "bundleId" && /(?:ui)?tests$/i.test(finalSegment) ? "testBundleId" : key;
    // Every endpoint ingestion route (source, Info.plist, and build settings) must retain the
    // same sanitized value in its evidence excerpt. Keeping a raw build-setting/XML excerpt
    // would otherwise leak a credential even though the finding key is normalized.
    const safeEvidence = key === "endpoint" && evidence.excerpt
      ? { ...evidence, excerpt: `Endpoint: ${normalized}` }
      : evidence;
    (settings[detectedKey] ||= []).push({ value: normalized, evidence: safeEvidence });
  };
  const scanText = async (file: string): Promise<void> => {
    const content = await readText(file); const source = relative(root, file);
    const projectSettingSource = file.endsWith("project.yml") || file.endsWith(".pbxproj") || file.endsWith(".xcconfig");
    const kind: Evidence["kind"] = file.endsWith("Info.plist") ? "plist" : file.endsWith(".entitlements") ? "entitlement" : file.endsWith("PrivacyInfo.xcprivacy") ? "privacy-manifest" : file.endsWith(".storekit") ? "storekit" : projectSettingSource ? "project-setting" : "source-heuristic";
    // XcodeGen's project.yml is structured data: scanning all text would mix
    // Debug/Staging values with the release configuration. Other setting
    // sources use the focused text parser below.
    const productionSettings = projectSettingSource && !file.endsWith("project.yml") ? productionSettingText(file, content, source, questions) : content;
    const matched = (regex: RegExp, key: string, input = content): void => { for (const match of input.matchAll(regex)) push(key, match[1].trim(), { source, excerpt: match[0].slice(0, 220), confidence: kind === "source-heuristic" ? "medium" : "high", kind }); };
    if (projectSettingSource && !file.endsWith("project.yml")) {
      matched(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\n]+)/g, "bundleId", productionSettings);
      matched(/MARKETING_VERSION\s*=\s*([^;\n]+)/g, "version", productionSettings); matched(/CURRENT_PROJECT_VERSION\s*=\s*([^;\n]+)/g, "build", productionSettings); matched(/IPHONEOS_DEPLOYMENT_TARGET\s*=\s*([^;\n]+)/g, "deploymentTarget", productionSettings); matched(/TARGETED_DEVICE_FAMILY\s*=\s*([^;\n]+)/g, "deviceFamily", productionSettings); matched(/CODE_SIGN_STYLE\s*=\s*([^;\n]+)/g, "codeSignStyle", productionSettings);
      for (const permission of PERMISSION_KEYS) {
        const escaped = permission.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const purposePattern = new RegExp(`INFOPLIST_KEY_${escaped}\\s*(?:=|:)\\s*(?:\\\"([^\\\"]*)\\\"|'([^']*)'|([^;\\n]+))`, "g");
        for (const match of productionSettings.matchAll(purposePattern)) {
          const purpose = (match[1] || match[2] || match[3] || "").trim();
          if (purpose && !/\$\([^)]*\)/.test(purpose)) push(`permission:${permission}`, purpose, { source, excerpt: `${permission}: ${purpose}`.slice(0, 220), confidence: "high", kind });
        }
      }
      for (const match of productionSettings.matchAll(/INFOPLIST_KEY_ITSAppUsesNonExemptEncryption\s*(?:=|:)\s*(YES|NO|true|false)\b/gi)) {
        const declared = /^(?:YES|true)$/i.test(match[1]) ? "true" : "false";
        push("encryption", declared, { source, excerpt: "INFOPLIST_KEY_ITSAppUsesNonExemptEncryption", confidence: "high", kind });
      }
      // A build setting can be a literal endpoint (e.g. a user-defined API base URL), not only
      // Apple's own known keys. Detect any such literal so it becomes a disposable finding rather
      // than an invisible proxy target only reachable via a $(VARIABLE) indirection elsewhere.
      for (const match of productionSettings.matchAll(/^[ \t]*[A-Za-z_][A-Za-z0-9_]*\s*=\s*["']?(https?:\/\/[^\s;"']+)["']?/gm)) push("endpoint", match[1], { source, excerpt: match[0].slice(0, 220), confidence: "medium", kind });
    }
    if (discoveredProjectYml.has(file) && scanXcodeGenProject(content, source, push, questions)) validProjectYml.add(source);
    if (file.endsWith("Info.plist")) {
      for (const key of PERMISSION_KEYS) { const regex = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "g"); for (const match of content.matchAll(regex)) push(`permission:${key}`, match[1], { source, excerpt: match[0], confidence: "confirmed", kind }); }
      // Any Info.plist string value that is itself a literal URL — not only the named permission
      // keys above — is production endpoint evidence (e.g. a custom base-URL key).
      for (const match of content.matchAll(/<key>[^<]+<\/key>\s*<string>(https?:\/\/[^<]+)<\/string>/g)) push("endpoint", match[1], { source, excerpt: match[0].slice(0, 220), confidence: "medium", kind });
      for (const match of content.matchAll(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<(true|false)\s*\/>/g)) push("encryption", match[1], { source, excerpt: match[0], confidence: "confirmed", kind });
      for (const [name, tag] of [["bundleId", "CFBundleIdentifier"], ["version", "CFBundleShortVersionString"], ["build", "CFBundleVersion"]] as const) { const re = new RegExp(`<key>${tag}</key>\\s*<string>([^<]*)</string>`, "g"); for (const m of content.matchAll(re)) if (!m[1].includes("$(")) push(name, m[1], { source, excerpt: m[0], confidence: "confirmed", kind }); }
    }
    if (file.endsWith(".storekit")) { for (const match of content.matchAll(/"productID"\s*:\s*"([^"]+)"/g)) push("storekitProductId", match[1], { source, excerpt: match[0], confidence: "confirmed", kind }); }
    const nativeSource = /\.(swift|m|mm|h)$/.test(file); const webRuntimeSource = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(file);
    if (nativeSource || webRuntimeSource) {
      // Comment-stripped once and reused below: permission requests, required-reason
        // APIs, and endpoint literals must all ignore commented-out code.
      const executableSource = stripCodeComments(content);
      if (nativeSource) {
        for (const framework of APPLE_FRAMEWORKS) if (new RegExp(`\\bimport\\s+${framework}\\b|\\b${framework}\\s*\\.`).test(content)) push(`framework:${framework}`, framework, { source, excerpt: framework, confidence: "medium", kind: "source-heuristic" });
        if (/\.displayPrice\b|\bProductView\s*\(/.test(content)) push("storekitLocalizedPrice", "StoreKit localized price display", { source, excerpt: content.match(/.{0,80}(?:\.displayPrice\b|\bProductView\s*\().{0,80}/s)?.[0].slice(0, 220), confidence: "high", kind: "source-heuristic" });
        if (/\.purchase\s*\(/.test(content)) push("storekitPurchaseCall", "StoreKit purchase call", { source, excerpt: content.match(/.{0,80}\.purchase\s*\(.{0,80}/s)?.[0].slice(0, 220), confidence: "high", kind: "source-heuristic" });
        if (/\bSKPaymentQueue\b|\bSKPaymentTransactionObserver\b/.test(content)) push("storekitLegacyPaymentQueue", "StoreKit 1 payment queue", { source, excerpt: content.match(/.{0,80}(?:SKPaymentQueue|SKPaymentTransactionObserver).{0,80}/s)?.[0].slice(0, 220), confidence: "high", kind: "source-heuristic" });
        // Comment-stripped so a commented-out permission-request call cannot propose (and, via
        // preflight.ts's permission-flow gates re-reading this same evidence file, cannot satisfy)
        // a permission-flow declaration for dead code. Each detected category becomes exactly one
        // aggregated finding (via `push`'s existing key-grouping), just like `permission:` above.
        for (const site of findPermissionRequestSites(executableSource)) push(`permissionFlow:${site.category}`, site.label, { source, excerpt: site.excerpt, confidence: "medium", kind: "source-heuristic" });
        // Required-reason API usage is comment-stripped for the same reason: only live
        // code calling these APIs obliges a PrivacyInfo.xcprivacy declaration.
        for (const site of findRequiredReasonApiSites(executableSource)) push(`requiredReasonApi:${site.category}`, site.label, { source, excerpt: site.excerpt, confidence: "medium", kind: "source-heuristic" });
      }
      for (const sdk of THIRD_PARTY_SDK_CANDIDATES) {
        const pattern = nativeSource ? new RegExp(`\\bimport\\s+${sdk}\\b|\\b${sdk}\\s*\\.`) : new RegExp(`(?:\\bimport\\s+(?:[^;\\n]*?\\s+from\\s+)?|\\brequire\\s*\\()?["']${sdk}["']|\\bfrom\\s+["']${sdk}["']`);
        if (pattern.test(content)) push(`thirdPartySdkCandidate:${sdk}`, sdk, { source, excerpt: sdk, confidence: "medium", kind: "source-heuristic" });
      }
      // A URL that only exists inside a `//`/`/* */` comment (e.g. documenting a local
      // dev-proxy flag) is not live code, and must not become an endpoint/insecure-endpoint
      // finding that then has no legitimate way to be cleared short of deleting the comment.
      for (const match of executableSource.matchAll(/https?:\/\/[^\s"'<>`]+/gi)) {
        const dynamicAt = match[0].indexOf("${");
        const literal = dynamicAt >= 0 ? match[0].slice(0, dynamicAt) : match[0];
        const endpoint = normalizeEndpoint(literal.replace(/[),.;]+$/, ""));
        if (!endpoint) { questions.add(`${source} contains a malformed HTTP(S) endpoint literal; inspect the contained source manually.`); continue; }
        const runtimeNetworkRequest = isRuntimeNetworkRequestLiteral(executableSource, match.index ?? 0, nativeSource, webRuntimeSource);
        push("endpoint", endpoint, { source, excerpt: `${runtimeNetworkRequest ? "Runtime network request endpoint" : "Endpoint"}: ${endpoint}`, confidence: runtimeNetworkRequest ? "medium" : "low", kind: "source-heuristic", runtimeNetworkRequest });
        if (dynamicAt >= 0) questions.add(`${source} contains a dynamic endpoint expression beginning ${endpoint}; verify the resolved destination manually.`);
      }
    }
    if (file.endsWith(".entitlements")) for (const match of content.matchAll(/<key>([^<]+)<\/key>/g)) push("entitlement", match[1], { source, excerpt: match[0], confidence: "confirmed", kind });
    if (file.endsWith("PrivacyInfo.xcprivacy")) {
      push("privacyManifest", "present", { source, confidence: "confirmed", kind });
      let parsedEntries = 0;
      for (const dictionary of content.matchAll(/<dict>([\s\S]*?)<\/dict>/g)) {
        const entry = dictionary[1];
        const accessType = entry.match(/<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
        if (accessType) {
          if (!(REQUIRED_REASON_API_CATEGORIES as readonly string[]).includes(accessType)) { push("privacyManifestUnparsed", accessType, { source, excerpt: dictionary[0].slice(0, 220), confidence: "confirmed", kind }); questions.add(`PrivacyInfo.xcprivacy declares an unrecognized accessed-API type ${accessType}; map it to Apple's required-reason API list manually.`); continue; }
          const reasons = entry.match(/<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
          const reasonCount = reasons ? [...reasons.matchAll(/<string>[^<]+<\/string>/g)].length : 0;
          if (!reasonCount) { push("privacyManifestUnparsed", `${accessType}:missing-reasons`, { source, excerpt: dictionary[0].slice(0, 220), confidence: "confirmed", kind }); questions.add(`PrivacyInfo.xcprivacy declares accessed-API type ${accessType} without an approved reason; add one manually.`); continue; }
          push(`privacyManifestAccessedAPI:${accessType}`, `${reasonCount} approved reason(s)`, { source, excerpt: dictionary[0].slice(0, 220), confidence: "confirmed", kind }); parsedEntries++;
          continue;
        }
        const dataType = entry.match(/<key>NSPrivacyCollectedDataType<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
        if (!dataType) continue;
        const category = PRIVACY_DATA_TYPE_MAP[dataType]; if (!category) { push("privacyManifestUnparsed", dataType, { source, excerpt: dictionary[0].slice(0, 220), confidence: "confirmed", kind }); questions.add(`PrivacyInfo.xcprivacy declares ${dataType}; map it to an App Privacy category manually.`); continue; }
        const linked = entry.match(/<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*<(true|false)\/>/)?.[1]; const tracking = entry.match(/<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<(true|false)\/>/)?.[1];
        const purposes = [...entry.matchAll(/<string>(NSPrivacyCollectedDataTypePurpose[^<]+)<\/string>/g)].map((match) => PRIVACY_PURPOSE_MAP[match[1]]).filter((value): value is string => Boolean(value));
        if (!linked || !tracking || !purposes.length) { push("privacyManifestUnparsed", `${category}:incomplete`, { source, excerpt: dictionary[0].slice(0, 220), confidence: "confirmed", kind }); questions.add(`PrivacyInfo.xcprivacy collected-data entry for ${category} is incomplete or unsupported; review it manually.`); continue; }
        push(`privacyManifestData:${category}`, JSON.stringify({ linkedToIdentity: linked === "true", usedForTracking: tracking === "true", purposes: [...new Set(purposes)].sort() }), { source, excerpt: dictionary[0].slice(0, 220), confidence: "confirmed", kind }); parsedEntries++;
      }
      if (!parsedEntries && /NSPrivacyCollectedDataType/.test(content)) questions.add(`PrivacyInfo.xcprivacy contains collected-data declarations ShipLayer could not parse; review them manually.`);
    }
  };
  for (const file of walked.files.filter((file) => /(?:project\.yml|project\.pbxproj|Info\.plist|\.xcconfig|\.entitlements|PrivacyInfo\.xcprivacy|\.storekit|\.swift|\.m|\.mm|\.h|\.ts|\.tsx|\.js|\.jsx|\.mjs|\.cjs|\.mts|\.cts)$/.test(file))) {
    if (isScannerToolingSource(relative(root, file))) continue;
    if (isTestOnlySource(relative(root, file))) { questions.add(`Excluded conventional test-only source ${relative(root, file)} from production privacy heuristics.`); continue; }
    try { await scanText(file); } catch { questions.add(`Unable to read or parse ${relative(root, file)}; inspect it manually.`); }
  }
  for (const [key, entries] of Object.entries(settings)) {
    const values = [...new Set(entries.map((entry) => entry.value))]; const primary = values[0]; if (values.length > 1 && ["bundleId", "version", "build", "deploymentTarget", "deviceFamily", "encryption"].includes(key)) contradictions.push(`${key} has conflicting values: ${values.join(", ")}.`);
    if (key === "bundleId" && values.length > 1) {
      const sorted = [...values].sort((left, right) => left.length - right.length || left.localeCompare(right)); const appBundle = sorted[0]; const secondary = sorted.slice(1);
      if (secondary.every((candidate) => candidate.startsWith(`${appBundle}.`))) {
        const contradictionIndex = contradictions.findIndex((item) => item.startsWith("bundleId has conflicting values:"));
        if (contradictionIndex >= 0) contradictions.splice(contradictionIndex, 1);
        const appEntries = entries.filter((entry) => entry.value === appBundle); findings.push({ key: "bundleId", value: appBundle, evidence: appEntries.map((entry) => entry.evidence), confidence: appEntries.some((entry) => entry.evidence.confidence === "confirmed") ? "confirmed" : "high" });
        findings.push({ key: "secondaryBundleId", value: secondary, evidence: entries.filter((entry) => secondary.includes(entry.value)).map((entry) => entry.evidence), confidence: "medium", proposal: true, message: "Secondary target bundle IDs may be app extensions/widgets. Confirm their target types and release configuration manually." });
        questions.add(`Confirm whether secondary bundle IDs (${secondary.join(", ")}) are extensions/widgets rather than additional App Store apps.`); continue;
      }
    }
    const processorCandidate = key.startsWith("thirdPartySdkCandidate:") || key.startsWith("endpoint:");
    const appleFramework = key.startsWith("framework:");
    const permissionFlowCandidate = key.startsWith("permissionFlow:");
    const requiredReasonCandidate = key.startsWith("requiredReasonApi:");
    findings.push({ key, value: values.length === 1 ? primary : values, evidence: entries.map((entry) => entry.evidence), confidence: entries.some((entry) => entry.evidence.confidence === "confirmed") ? "confirmed" : entries.some((entry) => entry.evidence.confidence === "high") ? "high" : "medium", proposal: processorCandidate || permissionFlowCandidate || requiredReasonCandidate, message: processorCandidate ? "Heuristic finding only; confirm whether this is an external processor or declared data use." : appleFramework ? "Apple framework usage detected; this is not by itself an external processor or privacy declaration." : permissionFlowCandidate ? "Heuristic finding only; confirms a runtime permission-request API call was detected, not that the app truly reaches the system prompt this way." : requiredReasonCandidate ? "Heuristic finding only; declare this accessed-API category in PrivacyInfo.xcprivacy with an approved reason, or confirm the call site is not a required-reason API." : undefined });
  }
  if (!settings.bundleId) questions.add("Confirm the production bundle ID; no unambiguous product bundle ID was detected.");
  if (!settings.encryption) questions.add("Confirm export-compliance/encryption status.");
  if (!findings.some((finding) => finding.key.startsWith("permission:"))) questions.add("Confirm whether the app requests any protected-resource permissions outside Info.plist.");
  questions.add("Confirm App Privacy questionnaire answers and all third-party processor data handling; source heuristics are not declarations.");
  if (walked.truncated) questions.add(`Scanning stopped at the ${walked.entriesVisited}-entry safety limit; inspect excluded source manually.`);
  if (walked.filesOverLimit) questions.add(`${walked.filesOverLimit} oversized file(s) were skipped at the ${1_000_000}-byte content limit; inspect them manually.`);
  if (walked.unreadable.length) questions.add(`${walked.unreadable.length} unreadable path(s) were skipped; inspect them manually.`);
  if (walked.symlinksIgnored.length) questions.add(`${walked.symlinksIgnored.length} symlinked path(s) were ignored for containment safety; inspect them manually.`);
  return { schemaVersion: 1, repository: root, scannedAt: new Date().toISOString(), project: { xcodeProjects: xcodeProjects.sort(), workspaces: workspaces.sort(), projectYml: [...validProjectYml].sort() }, findings: findings.sort((a, b) => a.key.localeCompare(b.key)), contradictions: contradictions.sort(), unresolvedQuestions: [...questions].sort(), ignored: { directories: walked.ignoredDirectories, filesOverLimit: walked.filesOverLimit, filesOverLimitPaths: walked.filesOverLimitPaths, filesScanned: walked.files.length, entriesVisited: walked.entriesVisited, unreadable: walked.unreadable, symlinksIgnored: walked.symlinksIgnored, symlinkDirectoriesIgnored: walked.symlinkDirectoriesIgnored, symlinkFilesIgnored: walked.symlinkFilesIgnored, truncated: walked.truncated } };
}

function isTestOnlySource(source: string): boolean { const parts = source.split("/"); const basename = parts.at(-1) || ""; return parts.some((component) => /(?:UI)?Tests$|^(?:scripts?|benchmarks?)$/i.test(component)) || /(?:\.test|\.spec)\.[cm]?[jt]sx?$/i.test(basename) || /(?:UI)?Tests?\.xcconfig$/i.test(basename); }
function isScannerToolingSource(source: string): boolean { const parts = source.split("/"); return parts.includes("app-store-screenshots") || (parts.at(-1) || "").endsWith(".d.ts"); }

type ScannerFindingPush = (key: string, value: string, evidence: Evidence) => void;

const XCODEGEN_SETTINGS: Record<string, string> = {
  PRODUCT_BUNDLE_IDENTIFIER: "bundleId",
  MARKETING_VERSION: "version",
  CURRENT_PROJECT_VERSION: "build",
  IPHONEOS_DEPLOYMENT_TARGET: "deploymentTarget",
  TARGETED_DEVICE_FAMILY: "deviceFamily",
  CODE_SIGN_STYLE: "codeSignStyle",
};

/**
 * XcodeGen configuration maps are not source text. In particular, a Debug
 * bundle identifier is an alternate build configuration, not an app
 * extension. Parse the YAML shape so release settings remain evidence while
 * settings from genuine target entries retain their own bundle identities.
 */
function scanXcodeGenProject(content: string, source: string, push: ScannerFindingPush, questions: Set<string>): boolean {
  let document: unknown;
  // Build settings are semantically strings to Xcode. The failsafe schema
  // preserves values such as 1.0 and 17.0 rather than coercing them to 1/17.
  try { document = parse(content, { schema: "failsafe" }); } catch { questions.add(`Could not parse ${source}; verify project settings manually.`); return false; }
  const project = asRecord(document);
  if (!project) { questions.add(`Could not parse ${source}; verify project settings manually.`); return false; }
  const appName = stringValue(project.name);
  // `project.yml` is a generic filename. A syntactically valid YAML mapping is not enough to
  // justify installing XcodeGen on a paid macOS runner: XcodeGen requires the resolved project
  // to have a name, and ShipLayer deliberately does not follow arbitrary include graphs here.
  if (!appName) { questions.add(`${source} has no non-empty top-level XcodeGen project name; verify whether it is an XcodeGen spec manually.`); return false; }
  push("appName", appName, { source, excerpt: "XcodeGen project name", confidence: "high", kind: "project-setting" });

  const ignoredConfigurations = new Set<string>();
  const variants = (candidate: unknown, label: string): XcodeGenSettingsVariant[] => {
    const settings = asRecord(candidate);
    if (!settings) return [];
    const base = scalarSettings(Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "base" && key !== "configs")), label);
    mergeSettings(base, scalarSettings(settings.base, `${label}.base`));
    const configurations = asRecord(settings.configs);
    if (!configurations) return [{ values: base }];
    const candidates = Object.entries(configurations)
      .sort(([left], [right]) => left.localeCompare(right))
      .filter(([configuration]) => {
        if (!isAlternateConfigurationName(configuration)) return true;
        ignoredConfigurations.add(`${label}.${configuration}`);
        return false;
      });
    if (!candidates.length) return [{ values: base }];
    // Release is the conventional archive configuration. If it is present,
    // select it rather than merging multiple independent release variants.
    const release = candidates.find(([configuration]) => /^release$/i.test(configuration));
    return (release ? [release] : candidates).map(([configuration, value]) => ({
      configuration,
      values: mergeSettings(new Map(base), scalarSettings(value, `${label}.configs.${configuration}`)),
    }));
  };
  const emit = (items: XcodeGenSettingsVariant[], secondaryTarget: boolean): void => {
    for (const item of items) for (const [setting, details] of [...item.values.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (secondaryTarget && setting !== "PRODUCT_BUNDLE_IDENTIFIER" && setting !== "ITSAppUsesNonExemptEncryption" && setting !== "INFOPLIST_KEY_ITSAppUsesNonExemptEncryption" && !PERMISSION_KEYS.some((permission) => setting === `INFOPLIST_KEY_${permission}`)) continue;
      emitXcodeGenSetting(setting, details, source, push);
    }
  };
  const rootVariants = variants(project.settings, "settings");
  const targets = asRecord(project.targets);
  const applicationTargets: Array<{ label: string; variants: XcodeGenSettingsVariant[] }> = [];
  const secondaryTargets: Array<{ label: string; variants: XcodeGenSettingsVariant[] }> = [];
  if (targets) for (const [target, targetValue] of Object.entries(targets).sort(([left], [right]) => left.localeCompare(right))) {
    const targetDefinition = asRecord(targetValue);
    if (!targetDefinition) continue;
    const type = stringValue(targetDefinition.type)?.toLowerCase();
    if (!type) { questions.add(`XcodeGen target ${target} has no declared type; do not infer its release identity manually.`); continue; }
    const effective = mergeRootAndTargetVariants(rootVariants, variants(targetDefinition.settings, `targets.${target}.settings`));
    if (type === "application") applicationTargets.push({ label: target, variants: effective });
    else secondaryTargets.push({ label: target, variants: effective });
  }

  // Target settings override root settings in XcodeGen. When application
  // targets exist, their effective release settings are the production
  // evidence—not a conflicting union with root defaults.
  if (applicationTargets.length) for (const target of applicationTargets) emit(target.variants, false);
  else emit(rootVariants, false);
  for (const target of secondaryTargets) emit(target.variants, true);
  if (ignoredConfigurations.size) questions.add(`Excluded alternate XcodeGen build configuration(s) ${[...ignoredConfigurations].sort().join(", ")} from production release-setting inference.`);
  return true;
}

interface XcodeGenSettingValue { value: string; label: string; }
interface XcodeGenSettingsVariant { configuration?: string; values: Map<string, XcodeGenSettingValue>; }

function scalarSettings(candidate: unknown, label: string): Map<string, XcodeGenSettingValue> {
  const settings = asRecord(candidate); const values = new Map<string, XcodeGenSettingValue>();
  if (!settings) return values;
  for (const [setting, rawValue] of Object.entries(settings).sort(([left], [right]) => left.localeCompare(right))) {
    const value = scalarSettingValue(rawValue);
    if (value !== undefined && !/\$\([^)]*\)/.test(value)) values.set(setting, { value, label });
  }
  return values;
}
function mergeSettings(target: Map<string, XcodeGenSettingValue>, source: Map<string, XcodeGenSettingValue>): Map<string, XcodeGenSettingValue> {
  for (const [key, value] of source) target.set(key, value);
  return target;
}
function mergeRootAndTargetVariants(root: XcodeGenSettingsVariant[], target: XcodeGenSettingsVariant[]): XcodeGenSettingsVariant[] {
  if (!target.length) return root.map((item) => ({ configuration: item.configuration, values: new Map(item.values) }));
  const defaults = root.filter((item) => item.configuration === undefined);
  const merged: XcodeGenSettingsVariant[] = [];
  for (const targetVariant of target) {
    // Xcode configuration names are conventional labels rather than strict
    // identifiers. Treat `release` and `Release` as the same configuration
    // when applying the normal target-over-project precedence.
    const roots = root.filter((item) => item.configuration?.toLowerCase() === targetVariant.configuration?.toLowerCase());
    const inherited = roots.length ? roots : defaults.length ? defaults : root.length === 1 ? root : [];
    if (!inherited.length) { merged.push({ configuration: targetVariant.configuration, values: new Map(targetVariant.values) }); continue; }
    for (const rootVariant of inherited) merged.push({
      configuration: targetVariant.configuration || rootVariant.configuration,
      values: mergeSettings(new Map(rootVariant.values), targetVariant.values),
    });
  }
  return merged;
}
function emitXcodeGenSetting(setting: string, details: XcodeGenSettingValue, source: string, push: ScannerFindingPush): void {
  const evidence: Evidence = { source, excerpt: `XcodeGen ${details.label}.${setting}`, confidence: "high", kind: "project-setting" };
  const finding = XCODEGEN_SETTINGS[setting];
  if (finding) { push(finding, details.value, evidence); return; }
  if (setting === "ITSAppUsesNonExemptEncryption" || setting === "INFOPLIST_KEY_ITSAppUsesNonExemptEncryption") {
    if (/^(?:yes|true)$/i.test(details.value)) push("encryption", "true", evidence);
    else if (/^(?:no|false)$/i.test(details.value)) push("encryption", "false", evidence);
    else push("encryption", "declared", { ...evidence, confidence: "medium" });
    return;
  }
  for (const permission of PERMISSION_KEYS) if (setting === `INFOPLIST_KEY_${permission}` && details.value.trim()) push(`permission:${permission}`, details.value.trim(), evidence);
  if (/^https?:\/\//i.test(details.value.trim())) push("endpoint", details.value.trim(), evidence);
}

function asRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function scalarSettingValue(value: unknown): string | undefined { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value).trim() : undefined; }

function productionSettingText(file: string, content: string, source: string, questions: Set<string>): string {
  if (file.endsWith(".xcconfig") && isAlternateConfigurationName(path.basename(file))) {
    questions.add(`Excluded alternate build configuration ${source} from production release-setting inference.`);
    return "";
  }
  if (!file.endsWith(".pbxproj")) return stripProjectSettingComments(content);
  const scoped = scopedPbxReleaseSettings(content, source, questions);
  if (scoped !== undefined) return scoped;
  const configurations = [...content.matchAll(/\/\*\s*([^*]+?)\s*\*\/\s*=\s*\{[\s\S]*?buildSettings\s*=\s*\{([\s\S]*?)\};[\s\S]*?name\s*=\s*([^;]+);/g)];
  if (!configurations.length) return stripProjectSettingComments(content);
  const alternate = configurations.filter((match) => isAlternateConfigurationName(match[3].trim()) || isAlternateConfigurationName(match[1].trim()));
  if (alternate.length) questions.add(`Excluded alternate Xcode build configuration(s) ${alternate.map((match) => match[3].trim() || match[1].trim()).sort().join(", ")} from production release-setting inference.`);
  return stripProjectSettingComments(configurations.filter((match) => !alternate.includes(match)).map((match) => match[2]).join("\n"));
}

interface PbxObjectBlock { id: string; body: string; }
interface PbxConfiguration { id: string; name: string; settings: Map<string, string>; }

/**
 * Returns effective Release settings when a conventional pbxproj contains
 * enough target/configuration-list structure to scope them safely. Target
 * values override PBXProject values; extensions contribute only their bundle,
 * permission, and encryption evidence. Undefined deliberately falls back to
 * the legacy single-target reader for small/plain project fixtures.
 */
function scopedPbxReleaseSettings(content: string, source: string, questions: Set<string>): string | undefined {
  const objects = pbxObjectBlocks(content);
  const configurations = new Map<string, PbxConfiguration>();
  const configurationLists = new Map<string, string[]>();
  const nativeTargets: Array<{ listId?: string; application: boolean }> = [];
  const projectLists: string[] = [];
  for (const object of objects) {
    const isa = pbxAssignment(object.body, "isa");
    if (isa === "XCBuildConfiguration") {
      const name = pbxAssignment(object.body, "name");
      const settingsBlock = pbxAssignmentBlock(object.body, "buildSettings", "{", "}");
      if (name && settingsBlock !== undefined) configurations.set(object.id, { id: object.id, name: unquotePbx(name), settings: pbxSettings(settingsBlock) });
      continue;
    }
    if (isa === "XCConfigurationList") {
      const members = pbxAssignmentBlock(object.body, "buildConfigurations", "(", ")") || "";
      configurationLists.set(object.id, [...members.matchAll(/\b[A-Za-z0-9_]{8,}\b/g)].map((match) => match[0]).filter((id) => configurations.has(id)));
      continue;
    }
    if (isa === "PBXNativeTarget") {
      const listId = pbxReference(pbxAssignment(object.body, "buildConfigurationList"));
      const productType = unquotePbx(pbxAssignment(object.body, "productType") || "");
      nativeTargets.push({ listId, application: productType === "com.apple.product-type.application" });
      continue;
    }
    if (isa === "PBXProject") {
      const listId = pbxReference(pbxAssignment(object.body, "buildConfigurationList"));
      if (listId) projectLists.push(listId);
    }
  }
  // A target-aware map is available only when at least one real native target
  // points at a recognized configuration list. Otherwise the historic
  // single-target parsing remains the least surprising read-only fallback.
  const associatedTargets = nativeTargets.filter((target) => target.listId && configurationLists.has(target.listId));
  if (!associatedTargets.length) return undefined;

  const selected = (listId: string | undefined): PbxConfiguration[] => {
    if (!listId) return [];
    const candidates = (configurationLists.get(listId) || []).map((id) => configurations.get(id)).filter((item): item is PbxConfiguration => Boolean(item))
      .filter((item) => !isAlternateConfigurationName(item.name));
    const release = candidates.filter((item) => /^release$/i.test(item.name));
    return (release.length ? release : candidates).sort((left, right) => left.id.localeCompare(right.id));
  };
  const rootByName = new Map<string, Map<string, string>>();
  for (const listId of projectLists.sort()) for (const configuration of selected(listId)) rootByName.set(configuration.name.toLowerCase(), configuration.settings);
  const inherited = (configuration: PbxConfiguration): Map<string, string> => mergePbxSettings(new Map(rootByName.get(configuration.name.toLowerCase()) || []), configuration.settings);
  const primary: Map<string, string>[] = [];
  const secondary: Map<string, string>[] = [];
  for (const target of associatedTargets) {
    const effective = selected(target.listId).map(inherited);
    if (target.application) primary.push(...effective);
    else secondary.push(...effective);
  }
  const effectivePrimary = primary.length ? primary : [...rootByName.values()].map((settings) => new Map(settings));
  if (!effectivePrimary.length) {
    questions.add("Could not identify a primary application Release configuration in " + source + "; verify target selection manually.");
    return "";
  }
  const output: string[] = [];
  for (const settings of effectivePrimary) output.push(pbxSettingsText(settings));
  for (const settings of secondary) output.push(pbxSettingsText(settings, true));
  return output.filter(Boolean).join("\n");
}

function pbxObjectBlocks(content: string): PbxObjectBlock[] {
  const blocks: PbxObjectBlock[] = []; const header = /(?:^|[\n\r\t ])([A-Za-z0-9_]{8,})(?:\s*\/\*[^*]*\*\/)?\s*=\s*\{/g;
  for (const match of content.matchAll(header)) {
    const open = content.indexOf("{", (match.index || 0) + match[0].length - 1); const close = pbxClosingDelimiter(content, open, "{", "}");
    if (close === undefined) continue;
    blocks.push({ id: match[1], body: content.slice(open + 1, close) });
    header.lastIndex = close + 1;
  }
  return blocks;
}
function pbxClosingDelimiter(content: string, open: number, opening: string, closing: string): number | undefined {
  if (open < 0 || content[open] !== opening) return undefined;
  let depth = 0; let quote = false;
  for (let index = open; index < content.length; index++) {
    const character = content[index];
    if (quote) { if (character === "\\" && index + 1 < content.length) { index++; continue; } if (character === "\"") quote = false; continue; }
    if (character === "\"") { quote = true; continue; }
    if (character === "/" && content[index + 1] === "*") { const closeComment = content.indexOf("*/", index + 2); if (closeComment < 0) return undefined; index = closeComment + 1; continue; }
    if (character === opening) depth++;
    else if (character === closing && --depth === 0) return index;
  }
  return undefined;
}
function pbxAssignment(body: string, key: string): string | undefined { return body.match(new RegExp("\\b" + key + "\\s*=\\s*([^;]+);"))?.[1]?.trim(); }
function pbxReference(value: string | undefined): string | undefined { return value?.match(/[A-Za-z0-9_]{8,}/)?.[0]; }
function pbxAssignmentBlock(body: string, key: string, opening: string, closing: string): string | undefined {
  const match = body.match(new RegExp("\\b" + key + "\\s*=\\s*\\" + opening));
  if (!match || match.index === undefined) return undefined;
  const open = body.indexOf(opening, match.index + match[0].length - 1); const end = pbxClosingDelimiter(body, open, opening, closing);
  return end === undefined ? undefined : body.slice(open + 1, end);
}
function unquotePbx(value: string): string { return value.trim().replace(/^"|"$/g, ""); }
function pbxSettings(body: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const match of body.matchAll(/\b([A-Za-z][A-Za-z0-9_]+)\s*=\s*([^;]+);/g)) settings.set(match[1], match[2].trim());
  return settings;
}
function mergePbxSettings(target: Map<string, string>, source: Map<string, string>): Map<string, string> {
  for (const [key, value] of source) target.set(key, value);
  return target;
}
function pbxSettingsText(settings: Map<string, string>, secondaryTarget = false): string {
  const permitted = (setting: string): boolean => !secondaryTarget || setting === "PRODUCT_BUNDLE_IDENTIFIER" || setting === "ITSAppUsesNonExemptEncryption" || setting === "INFOPLIST_KEY_ITSAppUsesNonExemptEncryption" || PERMISSION_KEYS.some((permission) => setting === "INFOPLIST_KEY_" + permission);
  return [...settings.entries()].filter(([setting]) => permitted(setting)).sort(([left], [right]) => left.localeCompare(right)).map(([setting, value]) => setting + " = " + value + ";").join("\n");
}

function isAlternateConfigurationName(name: string): boolean { return /(?:^|[ _.-])(?:debug|staging|development|dev)(?:$|[ _.-])/i.test(name) || /^(?:debug|staging|development|dev)$/i.test(name); }
function stripProjectSettingComments(content: string): string { return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1"); }

/**
 * Marks a literal only when it appears directly inside a bounded, recognizable request call.
 * This records source syntax, not reachability: a human still decides the endpoint's processor
 * disposition and the structured attestation still carries the retention fact. The distinction is
 * intentionally narrow because a docs-looking path can be a real API, while a bare policy URL is
 * not enough to call a runtime request.
 */
function isRuntimeNetworkRequestLiteral(content: string, literalIndex: number, nativeSource: boolean, webRuntimeSource: boolean): boolean {
  const before = content.slice(Math.max(0, literalIndex - 640), literalIndex);
  if (nativeSource) {
    // Direct `URLSession.shared.dataTask(with: URL(string: "https://…")!)`,
    // `data(from:)`, `uploadTask`, and `downloadTask` forms. Do not infer through variables or
    // arbitrary control flow: those require a human endpoint disposition rather than a heuristic.
    if (/\bURLSession(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*\s*\.\s*(?:dataTask|data|uploadTask|downloadTask)\s*\([^;{}]{0,640}$/s.test(before)) return true;
  }
  if (webRuntimeSource) {
    // Direct fetch/request/axios calls, plus the common axios/request object `url`/`uri` form.
    // A literal assigned to a link or documentation constant intentionally does not match.
    if (/(?:\b(?:await\s+)?(?:fetch|request|axios(?:\s*\.\s*(?:request|get|post|put|patch|delete|head))?)\s*\(\s*["'`]?)$/s.test(before)) return true;
    if (/\b(?:axios(?:\s*\.\s*request)?|request)\s*\(\s*\{[^{}]{0,480}\b(?:url|uri)\s*:\s*["'`]?$/s.test(before)) return true;
  }
  return false;
}
function normalizeEndpoint(value: string): string {
  const raw = value.trim().replace(/[),.;`]+$/, "");
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    // Never let URL userinfo, query values, or fragments enter reports or
    // generated packages. Parameter *names* retain a useful, deterministic
    // identity without persisting credentials or opaque customer data.
    const parameterNames = [...new Set([...url.searchParams.keys()])].sort();
    const query = parameterNames.length ? `?${parameterNames.map((name) => encodeURIComponent(name)).join("&")}` : "";
    // Userinfo and credential-bearing query/fragment values make the entire literal sensitive,
    // even when no path marker identifies which segment holds the value. Do not preserve a raw
    // path merely because the credential happened to be carried elsewhere in the same URL.
    const safePath = redactedCredentialPath(url.pathname) || (urlContainsCredentialMaterial(url) ? "/:redacted" : url.pathname);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${safePath}${query}`;
  } catch { return ""; }
}

export function findValue(report: AnalysisReport, key: string): string | undefined { const value = report.findings.find((finding) => finding.key === key)?.value; return typeof value === "string" ? value : undefined; }

// --- screenshot UI-test harness detection ------------------------------------------------------
// A screenshot scenario legitimately only exists in a UI-test target, so this pass deliberately
// re-reads exactly the XCUITest sources the main loop above excludes from production evidence
// (via isXCUITestSourcePath, not isNonProductionSourcePath — see evidence.ts). It only ever
// proposes screenshots.scenarios entries; it must never feed privacy/purchase/AI findings.

export interface DetectedScreenshotScenario { id: string; title: string; launchArguments: string[]; launchArgumentsDetermined: boolean; sourceFile: string; testFunction?: string }
export interface DetectedScreenshotHarness { scenarios: DetectedScreenshotScenario[]; sourceFiles: string[] }

/**
 * Looks for the exact contract ShipLayer's own generated template uses (see
 * screenshotHarnessTemplate in generator.ts): a helper shaped `func <name>(named x: String)` that
 * builds `XCTAttachment(screenshot: XCUIScreen.main.screenshot())` and keeps it. Detection is
 * intentionally literal rather than a full Swift parse — a file must contain both the attachment
 * construction and the screenshot call before any extraction runs at all, so an unrelated helper
 * named e.g. `named(...)` elsewhere cannot produce a false positive.
 */
export async function detectScreenshotHarness(repository: string): Promise<DetectedScreenshotHarness> {
  const root = path.resolve(repository);
  const walked = await walkRepository(root);
  const scenarios: DetectedScreenshotScenario[] = [];
  const sourceFiles: string[] = [];
  const usedIds = new Set<string>();
  for (const file of walked.files) {
    const source = relative(root, file);
    if (!isXCUITestSourcePath(source)) continue;
    let content: string;
    try { content = await readText(file); } catch { continue; }
    if (!/XCTAttachment\s*\(\s*screenshot\s*:/.test(content) || !/XCUIScreen\.main\.screenshot\s*\(\s*\)/.test(content)) continue;
    const helperName = screenshotHelperName(content);
    const callPattern = new RegExp(`\\b${escapeRegExp(helperName)}\\s*\\(\\s*named:\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*\\)`, "g");
    let sawCall = false;
    for (const match of content.matchAll(callPattern)) {
      const rawName = unescapeSwiftString(match[1]);
      if (!rawName.trim()) continue;
      const index = match.index ?? 0;
      const { launchArguments, determined } = nearestLaunchArguments(content, index);
      const testFunction = nearestFunctionName(content, index);
      const id = uniqueScenarioId(rawName, usedIds);
      scenarios.push({ id, title: rawName.trim().slice(0, 200), launchArguments, launchArgumentsDetermined: determined, sourceFile: source, testFunction });
      sawCall = true;
    }
    if (sawCall) sourceFiles.push(source);
  }
  return { scenarios, sourceFiles: sourceFiles.sort() };
}

function screenshotHelperName(content: string): string {
  const match = content.match(/\bfunc\s+(\w+)\s*\(\s*named\s+\w+\s*:\s*String\s*\)/);
  return match ? match[1] : "keepScreenshot";
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function unescapeSwiftString(value: string): string { return value.replace(/\\(.)/g, "$1"); }

/** Balances `[` / `]` while skipping quoted string content, ignoring Swift's escape syntax within them. */
function swiftBracketEnd(content: string, open: number): number | undefined {
  let depth = 0; let quote = false;
  for (let index = open; index < content.length; index++) {
    const character = content[index];
    if (quote) { if (character === "\\" && index + 1 < content.length) { index++; continue; } if (character === "\"") quote = false; continue; }
    if (character === "\"") { quote = true; continue; }
    if (character === "[") depth++;
    else if (character === "]" && --depth === 0) return index;
  }
  return undefined;
}

/** Splits a Swift array literal's inner text on top-level commas only — commas nested inside a
 * quoted string, a call's parentheses, or a nested collection literal do not split. Trailing
 * commas (Swift's multi-line array convention) produce no trailing empty element. */
function splitSwiftArrayElements(inner: string): string[] {
  const elements: string[] = []; let depth = 0; let quote = false; let current = "";
  for (let index = 0; index < inner.length; index++) {
    const character = inner[index];
    if (quote) { current += character; if (character === "\\" && index + 1 < inner.length) { current += inner[++index]; continue; } if (character === "\"") quote = false; continue; }
    if (character === "\"") { quote = true; current += character; continue; }
    if (character === "(" || character === "[" || character === "{") { depth++; current += character; continue; }
    if (character === ")" || character === "]" || character === "}") { depth--; current += character; continue; }
    if (character === "," && depth === 0) { elements.push(current); current = ""; continue; }
    current += character;
  }
  if (current.trim().length) elements.push(current);
  return elements.map((element) => element.trim()).filter((element) => element.length > 0);
}

/**
 * The nearest enclosing `func name(...) { ... }` body-start position strictly before
 * `beforeIndex` — used to bound launch-argument search to the SAME method a keepScreenshot call
 * lives in, rather than the whole file. Returns undefined when no enclosing function can be
 * located (search then finds nothing, which is treated as "could not determine" rather than
 * silently falling back to an unbounded, cross-method search).
 */
function nearestFunctionBodyStart(content: string, beforeIndex: number): number | undefined {
  const pattern = /\bfunc\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/g;
  let declarationEnd: number | undefined;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index >= beforeIndex) break;
    declarationEnd = index + match[0].length;
  }
  if (declarationEnd === undefined) return undefined;
  const brace = content.indexOf("{", declarationEnd);
  return brace === -1 || brace > beforeIndex ? undefined : brace;
}

/**
 * The launch arguments visibly in effect at `beforeIndex`: the nearest preceding
 * `.launchArguments = [...]` assignment, bounded to the SAME enclosing function's body — an
 * assignment belonging to an earlier, already-closed method must never be attributed to a later
 * one that sets no array of its own (e.g. because it launches through a shared helper).
 * `determined: false` means ShipLayer could not establish real launch arguments for this
 * scenario — either no bounded assignment was found, or the array is not entirely literal string
 * elements. A single non-literal element (an enum member, an interpolated variable) is never
 * dropped and the rest kept: doing that silently shifts every later element one flag to the left,
 * corrupting `-key value` pairing rather than just losing one argument. The whole array is
 * dropped instead.
 */
function nearestLaunchArguments(content: string, beforeIndex: number): { launchArguments: string[]; determined: boolean } {
  const bodyStart = nearestFunctionBodyStart(content, beforeIndex);
  if (bodyStart === undefined) return { launchArguments: [], determined: false };
  const pattern = /\.launchArguments\s*=\s*\[/g;
  let best: { open: number; close: number } | undefined;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index < bodyStart) continue;
    if (index >= beforeIndex) break;
    const open = index + match[0].length - 1;
    const close = swiftBracketEnd(content, open);
    if (close === undefined) continue;
    best = { open, close };
  }
  if (!best) return { launchArguments: [], determined: false };
  const inner = content.slice(best.open + 1, best.close);
  const rawElements = splitSwiftArrayElements(inner);
  // A syntactically valid quoted string is not necessarily a fixed literal value: Swift string
  // interpolation ("\\(expression)") is itself backslash-escape-shaped and passes literalPattern,
  // which would let a computed value such as "\\(storeName)" through as if it were the fixed text
  // "(storeName)" — a fabricated, confidently-wrong value, not merely a missing one. Any element
  // containing an interpolation marker is treated exactly like a bare non-literal element: the
  // whole array is dropped and this scenario's arguments are undetermined.
  const literalPattern = /^"(?:[^"\\]|\\.)*"$/;
  const hasInterpolation = (element: string): boolean => /\\\(/.test(element);
  if (!rawElements.every((element) => literalPattern.test(element) && !hasInterpolation(element))) return { launchArguments: [], determined: false };
  const launchArguments = rawElements.map((element) => unescapeSwiftString(element.slice(1, -1))).filter((value) => value.length > 0).slice(0, 20);
  return { launchArguments, determined: true };
}

/** The nearest enclosing `func name(...)` declaration before `beforeIndex`, for traceable-but-not-fabricated scenario steps. */
function nearestFunctionName(content: string, beforeIndex: number): string | undefined {
  const pattern = /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let name: string | undefined;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index >= beforeIndex) break;
    name = match[1];
  }
  return name;
}
function uniqueScenarioId(name: string, used: Set<string>): string {
  const base = (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "scenario");
  const normalizedBase = /^[a-z0-9]/.test(base) ? base : `scenario-${base}`;
  let candidate = normalizedBase; let suffix = 2;
  while (used.has(candidate)) candidate = `${normalizedBase}-${suffix++}`;
  used.add(candidate);
  return candidate;
}
