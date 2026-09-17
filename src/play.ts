import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolveContained } from "./fs.js";
import { GooglePlayClient, playCredentialsFromEnvironment, type PlayFetchLike } from "./play-client.js";
import { PLAY_IMAGE_TYPES, PLAY_LISTING_ASSETS, readPlayMetadata, type PlayImage, type PlayImageType, type PlayListing } from "./play-metadata.js";
import { assertPlayApplyReady, playPolicyWarnings } from "./play-manifest.js";
import type { PlayApplyResult, PlayManifest, PlayOperation, PlayPlan, PlayScope } from "./play-types.js";

export interface PlayOptions { environment?: NodeJS.ProcessEnv; fetcher?: PlayFetchLike; userConfirmed?: boolean; reviewedPlan?: PlayPlan }

export async function planGooglePlayChanges(repository: string, manifest: PlayManifest, scope: PlayScope, options: PlayOptions = {}): Promise<PlayPlan> {
  requireRelease(manifest, scope);
  const metadata = await readPlayMetadata(repository, manifest, scope);
  const credentials = playCredentialsFromEnvironment(manifest, options.environment);
  if (!credentials) return { mode: "remote-preview", packageName: manifest.packageName, scope, operations: [], credentialsPresent: false, warnings: [`Neither ${manifest.sync.accessTokenEnv || "GOOGLE_PLAY_ACCESS_TOKEN"} nor ${manifest.sync.serviceAccountJsonEnv || "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"} is available; no Google Play request was made.`, ...playPolicyWarnings(manifest)], ephemeralEditDeleted: false };
  const client = await GooglePlayClient.connect(credentials, options.fetcher);
  const editId = await client.insertEdit(manifest.packageName);
  let deleted = false;
  try {
    const operations: PlayOperation[] = [];
    if (scope === "listings" || scope === "all") operations.push(...await listingPlan(client, manifest.packageName, editId, metadata));
    if (scope === "release" || scope === "all") operations.push(...await releasePlan(repository, client, manifest, editId, metadata));
    await client.deleteEdit(manifest.packageName, editId); deleted = true;
    return { mode: "remote-preview", packageName: manifest.packageName, scope, operations, credentialsPresent: true, warnings: ["Google Play exposes listing reads only inside an edit. ShipLayer created and deleted an ephemeral edit without validating or committing it.", ...playPolicyWarnings(manifest)], ephemeralEditDeleted: true };
  } finally {
    if (!deleted) await client.deleteEdit(manifest.packageName, editId).catch(() => undefined);
  }
}

export async function applyGooglePlayChanges(repository: string, manifest: PlayManifest, scope: PlayScope, options: PlayOptions): Promise<PlayApplyResult> {
  if (!options.userConfirmed) throw new Error("Google Play apply requires explicit user confirmation.");
  await assertPlayApplyReady(repository, manifest, scope);
  if (!options.reviewedPlan?.credentialsPresent || options.reviewedPlan.scope !== scope || options.reviewedPlan.packageName !== manifest.packageName) throw new Error("Google Play apply requires a reviewed remote preview for the same package and scope.");
  const current = await planGooglePlayChanges(repository, manifest, scope, options);
  if (fingerprint(current.operations) !== fingerprint(options.reviewedPlan.operations)) throw new Error("Google Play changed after the reviewed preview. Review a fresh plan before applying.");
  const credentials = playCredentialsFromEnvironment(manifest, options.environment);
  if (!credentials) throw new Error("Google Play credentials disappeared after preview.");
  const metadata = await readPlayMetadata(repository, manifest, scope);
  const client = await GooglePlayClient.connect(credentials, options.fetcher);
  const editId = await client.insertEdit(manifest.packageName);
  let closed = false;
  const applied: PlayOperation[] = current.operations.map((operation) => ({ ...operation }));
  try {
    if (scope === "listings" || scope === "all") await applyListings(client, manifest.packageName, editId, metadata, applied);
    if (scope === "release" || scope === "all") await applyRelease(repository, client, manifest, editId, metadata, applied);
    if (applied.every((operation) => operation.status === "already-matches")) {
      await client.deleteEdit(manifest.packageName, editId); closed = true;
      return { applied: false, committed: false, operations: applied, warnings: ["Every configured Google Play resource already matched; the edit was deleted without commit."] };
    }
    await client.validateEdit(manifest.packageName, editId);
    await client.commitEdit(manifest.packageName, editId); closed = true;
    return { applied: true, committed: true, operations: applied, warnings: [applyWarning(manifest, scope)] };
  } finally {
    if (!closed) await client.deleteEdit(manifest.packageName, editId).catch(() => undefined);
  }
}

async function listingPlan(client: GooglePlayClient, packageName: string, editId: string, metadata: Map<string, PlayListing>): Promise<PlayOperation[]> {
  const remote = new Map((await client.listings(packageName, editId)).map((row) => [String(row.language || ""), row]));
  const operations: PlayOperation[] = [];
  for (const [language, listing] of metadata) {
    const current = remote.get(language);
    const matches = current?.title === listing.title && current?.shortDescription === listing.shortDescription && current?.fullDescription === listing.fullDescription;
    operations.push(operation(`listing.${language}`, current ? "update" : "create", `listing/${language}`, `${matches ? "Listing matches" : current ? "Update listing" : "Create listing"} for ${language}.`, matches));
    for (const imageType of [...PLAY_IMAGE_TYPES, ...PLAY_LISTING_ASSETS]) {
      const local = listing.images[imageType]; if (!local) continue;
      // Google returns 404 for images.list when the locale listing does not exist yet.
      // A new listing necessarily has no remote screenshots, so skip that impossible read.
      const images = current ? await client.images(packageName, editId, language, imageType) : [];
      const remoteHashes = images.map((image) => String(image.sha256 || "").toLowerCase());
      const localHashes = local.map((image) => image.sha256);
      const imageMatches = remoteHashes.length === localHashes.length && remoteHashes.every((hash, index) => hash === localHashes[index]);
      operations.push(operation(`screenshots.${language}.${imageType}`, "upload", `screenshots/${language}/${imageType}`, `${imageMatches ? "Screenshot order and hashes match" : `Replace ${images.length} remote screenshot(s) with ${local.length} reviewed screenshot(s)`} for ${language}/${imageType}.`, imageMatches));
    }
  }
  return operations;
}

async function releasePlan(repository: string, client: GooglePlayClient, manifest: PlayManifest, editId: string, metadata: Map<string, PlayListing>): Promise<PlayOperation[]> {
  const release = manifest.release!;
  const bundlePath = await resolveContained(repository, release.bundle, "Android App Bundle");
  const bundleHash = await sha256File(bundlePath);
  const bundles = await client.bundles(manifest.packageName, editId);
  const sameCode = bundles.find((bundle) => Number(bundle.versionCode) === release.versionCode);
  if (sameCode && String(sameCode.sha256 || "").toLowerCase() !== bundleHash) throw new Error(`Google Play already has version code ${release.versionCode} with a different bundle hash. Increment versionCode before upload.`);
  const operations = [operation(`bundle.${release.versionCode}`, "upload", `bundle/${release.versionCode}`, sameCode ? `Bundle ${release.versionCode} hash matches.` : `Upload ${release.versionName} bundle with version code ${release.versionCode}.`, Boolean(sameCode))];
  const track = await client.track(manifest.packageName, editId, release.track);
  const desired = desiredRelease(manifest, metadata);
  const matching = records(track.releases).find((candidate) => strings(candidate.versionCodes).includes(String(release.versionCode)));
  if (matching && String(matching.status) === "completed" && release.status === "draft") throw new Error(`Version code ${release.versionCode} is already completed on ${release.track}; ShipLayer will not downgrade it to draft.`);
  const matches = matching ? releaseEquals(matching, desired) : false;
  operations.push(operation(`track.${release.track}.${release.versionCode}`, "update", `track/${release.track}`, matches ? `${release.track} release ${release.versionCode} matches.` : `Create or update ${release.status} ${release.track} release ${release.versionCode}.`, matches));
  return operations;
}

async function applyListings(client: GooglePlayClient, packageName: string, editId: string, metadata: Map<string, PlayListing>, operations: PlayOperation[]): Promise<void> {
  for (const [language, listing] of metadata) {
    const listingOperation = find(operations, `listing.${language}`);
    if (listingOperation.status === "planned") {
      await client.updateListing(packageName, editId, language, { language, title: listing.title, shortDescription: listing.shortDescription, fullDescription: listing.fullDescription });
      listingOperation.status = "applied";
    }
    for (const imageType of [...PLAY_IMAGE_TYPES, ...PLAY_LISTING_ASSETS]) {
      const local = listing.images[imageType]; if (!local) continue;
      const imageOperation = find(operations, `screenshots.${language}.${imageType}`);
      if (imageOperation.status === "planned") {
        await client.deleteImages(packageName, editId, language, imageType);
        for (let index = 0; index < local.length; index++) await uploadReviewedImage(client, packageName, editId, language, imageType, local, index);
        imageOperation.status = "applied";
      }
    }
  }
}

async function uploadReviewedImage(client: GooglePlayClient, packageName: string, editId: string, language: string, imageType: PlayImageType, desired: PlayImage[], index: number): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const image = desired[index];
      await client.uploadImage(packageName, editId, language, imageType, await readFile(image.path), image.contentType);
      return;
    } catch (error) {
      lastError = error;
      const remoteHashes = (await client.images(packageName, editId, language, imageType)).map((image) => String(image.sha256 || "").toLowerCase());
      const before = desired.slice(0, index).map((image) => image.sha256);
      const including = desired.slice(0, index + 1).map((image) => image.sha256);
      if (sameSequence(remoteHashes, including)) return;
      if (!sameSequence(remoteHashes, before)) throw new Error(`Google Play returned an ambiguous screenshot state after an upload failure for ${language}/${imageType}; the edit was not committed.`);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Google Play screenshot upload failed for ${language}/${imageType}.`);
}

function sameSequence(left: string[], right: string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }

async function applyRelease(repository: string, client: GooglePlayClient, manifest: PlayManifest, editId: string, metadata: Map<string, PlayListing>, operations: PlayOperation[]): Promise<void> {
  const release = manifest.release!;
  const bundleOperation = find(operations, `bundle.${release.versionCode}`);
  if (bundleOperation.status === "planned") {
    const bundlePath = await resolveContained(repository, release.bundle, "Android App Bundle");
    const uploaded = await client.uploadBundle(manifest.packageName, editId, await readFile(bundlePath));
    if (Number(uploaded.versionCode) !== release.versionCode) throw new Error(`Uploaded bundle reports version code ${String(uploaded.versionCode)}, expected ${release.versionCode}.`);
    bundleOperation.status = "applied";
  }
  const trackOperation = find(operations, `track.${release.track}.${release.versionCode}`);
  if (trackOperation.status === "planned") {
    const current = await client.track(manifest.packageName, editId, release.track);
    const others = records(current.releases).filter((candidate) =>
      !strings(candidate.versionCodes).includes(String(release.versionCode)) &&
      !(release.status === "completed" && String(candidate.status) === "completed")
    );
    await client.updateTrack(manifest.packageName, editId, release.track, { track: release.track, releases: [...others, desiredRelease(manifest, metadata)] });
    trackOperation.status = "applied";
  }
}

function desiredRelease(manifest: PlayManifest, metadata: Map<string, PlayListing>): Record<string, unknown> {
  const release = manifest.release!;
  return { name: release.versionName, versionCodes: [String(release.versionCode)], releaseNotes: [...metadata.values()].map((listing) => ({ language: listing.language, text: listing.releaseNote! })).sort((left, right) => left.language.localeCompare(right.language)), status: release.status };
}
function releaseEquals(remote: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  const normalizeNotes = (value: unknown) => records(value).map((note) => ({ language: String(note.language || ""), text: String(note.text || "") })).sort((a, b) => a.language.localeCompare(b.language));
  return String(remote.name || "") === desired.name && String(remote.status || "") === desired.status && JSON.stringify(strings(remote.versionCodes).sort()) === JSON.stringify(strings(desired.versionCodes).sort()) && JSON.stringify(normalizeNotes(remote.releaseNotes)) === JSON.stringify(normalizeNotes(desired.releaseNotes));
}
function operation(id: string, action: PlayOperation["action"], resource: string, description: string, matches: boolean): PlayOperation { return { id, action, resource, description, safety: "requires-apply", status: matches ? "already-matches" : "planned" }; }
function find(operations: PlayOperation[], id: string): PlayOperation { const found = operations.find((item) => item.id === id); if (!found) throw new Error(`Reviewed Google Play plan is missing ${id}.`); return found; }
function fingerprint(operations: PlayOperation[]): string { return JSON.stringify(operations.map(({ id, action, resource, description, status }) => ({ id, action, resource, description, status }))); }
function requireRelease(manifest: PlayManifest, scope: PlayScope): void { if ((scope === "release" || scope === "all") && !manifest.release) throw new Error("Google Play release scope requires a release configuration."); }
function applyWarning(manifest: PlayManifest, scope: PlayScope): string {
  if (scope === "listings") return "The Google Play listing edit was validated and committed. No app bundle or track was changed.";
  if (manifest.release?.track === "production") return "The Google Play edit was validated and committed. The production release remains draft; ShipLayer did not start rollout.";
  return `The Google Play edit was validated and committed to the ${manifest.release?.track} testing track; no production release was changed.`;
}
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }
async function sha256File(file: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer); return hash.digest("hex"); }
