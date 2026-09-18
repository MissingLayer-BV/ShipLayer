import path from "node:path";
import { lstat } from "node:fs/promises";
import { parse } from "yaml";
import { readText, resolveContained } from "./fs.js";
import type { Confirmation } from "./types.js";
import type { PlayManifest, PlayScope } from "./play-types.js";

export const PLAY_MANIFEST_NAME = "shiplayer-play.yml";
const CONFIRMATIONS = new Set<Confirmation>(["confirmed", "needs-human-confirmation", "not-applicable"]);

export async function readPlayManifest(repository: string): Promise<PlayManifest> {
  const file = await resolveContained(repository, PLAY_MANIFEST_NAME, "Google Play manifest");
  let raw: unknown;
  try { raw = parse(await readText(file)); }
  catch (error) { throw new Error(`Cannot read ${PLAY_MANIFEST_NAME}: ${message(error)}`); }
  if (!record(raw)) throw new Error(`${PLAY_MANIFEST_NAME} must contain a mapping.`);
  exactKeys(raw, new Set(["schemaVersion", "packageName", "metadata", "policy", "release", "sync"]), "manifest");
  if (raw.schemaVersion !== 1) throw new Error(`${PLAY_MANIFEST_NAME} schemaVersion must be 1.`);
  const packageName = requiredString(raw.packageName, "packageName");
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) throw new Error("packageName is not a valid Android application ID.");

  if (!record(raw.metadata)) throw new Error("metadata must be a mapping.");
  exactKeys(raw.metadata, new Set(["directory", "confirmation"]), "metadata");
  const metadata = {
    directory: requiredString(raw.metadata.directory, "metadata.directory"),
    confirmation: confirmation(raw.metadata.confirmation, "metadata.confirmation"),
  };
  await resolveContained(repository, metadata.directory, "Google Play metadata directory");

  let release: PlayManifest["release"];
  if (raw.release !== undefined) {
    if (!record(raw.release)) throw new Error("release must be a mapping.");
    exactKeys(raw.release, new Set(["versionCode", "versionName", "bundle", "track", "status", "confirmation"]), "release");
    if (!Number.isInteger(raw.release.versionCode) || Number(raw.release.versionCode) <= 0) throw new Error("release.versionCode must be a positive integer.");
    const status = requiredString(raw.release.status, "release.status");
    if (status !== "draft" && status !== "completed") throw new Error("release.status must be draft or completed.");
    const track = requiredString(raw.release.track, "release.track");
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(track)) throw new Error("release.track contains unsupported characters.");
    if (track === "production" && status !== "draft") throw new Error("ShipLayer only permits draft production releases; it never starts a production rollout.");
    release = {
      versionCode: Number(raw.release.versionCode),
      versionName: requiredString(raw.release.versionName, "release.versionName"),
      bundle: requiredString(raw.release.bundle, "release.bundle"),
      track,
      status,
      confirmation: confirmation(raw.release.confirmation, "release.confirmation"),
    };
    await resolveContained(repository, release.bundle, "Android App Bundle");
  }

  if (!record(raw.policy)) throw new Error("policy must be a mapping.");
  exactKeys(raw.policy, new Set(["contentRating", "targetAudience", "dataSafety", "adsDeclaration", "privacyPolicy", "contactEmail"]), "policy");
  const policy = {
    contentRating: confirmation(raw.policy.contentRating, "policy.contentRating"),
    targetAudience: confirmation(raw.policy.targetAudience, "policy.targetAudience"),
    dataSafety: confirmation(raw.policy.dataSafety, "policy.dataSafety"),
    adsDeclaration: confirmation(raw.policy.adsDeclaration, "policy.adsDeclaration"),
    privacyPolicy: confirmation(raw.policy.privacyPolicy, "policy.privacyPolicy"),
    contactEmail: confirmation(raw.policy.contactEmail, "policy.contactEmail"),
  };

  if (!record(raw.sync)) throw new Error("sync must be a mapping.");
  exactKeys(raw.sync, new Set(["mode", "accessTokenEnv", "serviceAccountJsonEnv"]), "sync");
  const mode = requiredString(raw.sync.mode, "sync.mode");
  if (mode !== "dry-run" && mode !== "apply") throw new Error("sync.mode must be dry-run or apply.");
  const accessTokenEnv = raw.sync.accessTokenEnv === undefined ? undefined : requiredString(raw.sync.accessTokenEnv, "sync.accessTokenEnv");
  if (accessTokenEnv && !/^[A-Z_][A-Z0-9_]*$/.test(accessTokenEnv)) throw new Error("sync.accessTokenEnv must name an uppercase environment variable.");
  const serviceAccountJsonEnv = raw.sync.serviceAccountJsonEnv === undefined ? undefined : requiredString(raw.sync.serviceAccountJsonEnv, "sync.serviceAccountJsonEnv");
  if (serviceAccountJsonEnv && !/^[A-Z_][A-Z0-9_]*$/.test(serviceAccountJsonEnv)) throw new Error("sync.serviceAccountJsonEnv must name an uppercase environment variable.");
  return { schemaVersion: 1, packageName, metadata, policy, release, sync: { mode, accessTokenEnv, serviceAccountJsonEnv } };
}

const POLICY_LABELS: Record<keyof PlayManifest["policy"], string> = {
  contentRating: "content rating",
  targetAudience: "target audience",
  dataSafety: "data safety section",
  adsDeclaration: "ads declaration",
  privacyPolicy: "privacy policy",
  contactEmail: "contact email",
};

export function playPolicyWarnings(manifest: PlayManifest): string[] {
  return (Object.keys(POLICY_LABELS) as Array<keyof PlayManifest["policy"]>)
    .filter((field) => manifest.policy[field] === "needs-human-confirmation")
    .map((field) => `Google Play policy '${POLICY_LABELS[field]}' is not human-confirmed; apply will be blocked until it is confirmed.`);
}

export function assertPlayPolicyReady(manifest: PlayManifest): void {
  for (const field of ["contentRating", "targetAudience", "dataSafety", "adsDeclaration", "contactEmail"] as const) {
    if (manifest.policy[field] !== "confirmed") throw new Error(`Google Play apply requires policy.${field}: confirmed. Complete the ${POLICY_LABELS[field]} questionnaire in Play Console first.`);
  }
  if (manifest.policy.privacyPolicy !== "confirmed" && manifest.policy.privacyPolicy !== "not-applicable") throw new Error("Google Play apply requires policy.privacyPolicy: confirmed (or not-applicable when the app collects no personal or sensitive data).");
}

export async function assertPlayApplyReady(repository: string, manifest: PlayManifest, scope: PlayScope): Promise<void> {
  if (manifest.sync.mode !== "apply") throw new Error("Google Play apply is blocked because sync.mode is dry-run.");
  assertPlayPolicyReady(manifest);
  if ((scope === "listings" || scope === "all") && manifest.metadata.confirmation !== "confirmed") throw new Error("Google Play listing apply requires metadata.confirmation: confirmed.");
  if (scope === "release" || scope === "all") {
    if (!manifest.release) throw new Error("Google Play release scope requires a release configuration.");
    if (manifest.release.confirmation !== "confirmed") throw new Error("Google Play release apply requires release.confirmation: confirmed.");
    const bundle = await resolveContained(repository, manifest.release.bundle, "Android App Bundle");
    const details = await lstat(bundle).catch(() => undefined);
    if (!details?.isFile() || details.isSymbolicLink()) throw new Error(`Android App Bundle does not exist as a regular file: ${manifest.release.bundle}`);
  }
}

export function parsePlayScope(value: string | undefined): PlayScope {
  const scope = value || "listings";
  if (scope !== "listings" && scope !== "release" && scope !== "all") throw new Error("--scope must be listings, release, or all.");
  return scope;
}

function confirmation(value: unknown, label: string): Confirmation {
  if (typeof value !== "string" || !CONFIRMATIONS.has(value as Confirmation)) throw new Error(`${label} must be confirmed, needs-human-confirmation, or not-applicable.`);
  return value as Confirmation;
}
function requiredString(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`); return value.trim(); }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void { const unknown = Object.keys(value).filter((key) => !allowed.has(key)); if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}.`); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
