import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readPlayManifest } from "../src/play-manifest.js";
import { readPlayMetadata } from "../src/play-metadata.js";
import { planGooglePlayChanges } from "../src/play.js";
import { assertPlayPolicyReady } from "../src/play-manifest.js";
import { png } from "./helpers.js";

const POLICY_CONFIRMED = `policy:
  contentRating: confirmed
  targetAudience: confirmed
  dataSafety: confirmed
  adsDeclaration: confirmed
  privacyPolicy: confirmed
  contactEmail: confirmed
`;

async function metadataRoot(yml: string, files: Record<string, Buffer | string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-play-meta-"));
  await writeFile(path.join(root, "shiplayer-play.yml"), yml);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

function manifestYml(policy = POLICY_CONFIRMED): string {
  return `schemaVersion: 1
packageName: com.example.kevser
metadata:
  directory: build/play-metadata
  confirmation: confirmed
${policy}sync:
  mode: dry-run
`;
}

function validFiles(): Record<string, Buffer | string> {
  return {
    "build/play-metadata/en-US/title.txt": "Kevser\n",
    "build/play-metadata/en-US/short_description.txt": "Daily study\n",
    "build/play-metadata/en-US/full_description.txt": "Read and reflect every day.\n",
    "build/play-metadata/en-US/images/phoneScreenshots/01.png": png(1080, 1920),
    "build/play-metadata/en-US/images/phoneScreenshots/02.png": png(1080, 1920),
    "build/play-metadata/en-US/images/icon.png": png(512, 512),
    "build/play-metadata/en-US/images/featureGraphic.png": png(1024, 500),
  };
}

test("Google Play requires a hi-res icon and feature graphic", async () => {
  const files = validFiles(); delete files["build/play-metadata/en-US/images/icon.png"];
  const root = await metadataRoot(manifestYml(), files);
  await assert.rejects(async () => readPlayMetadata(root, await readPlayManifest(root), "listings"), /Hi-res icon/);
  const files2 = validFiles(); delete files2["build/play-metadata/en-US/images/featureGraphic.png"];
  const root2 = await metadataRoot(manifestYml(), files2);
  await assert.rejects(async () => readPlayMetadata(root2, await readPlayManifest(root2), "listings"), /Feature graphic/);
});

test("Google Play rejects wrong-size or transparent listing assets", async () => {
  const files = validFiles(); files["build/play-metadata/en-US/images/icon.png"] = png(256, 256);
  const root = await metadataRoot(manifestYml(), files);
  await assert.rejects(async () => readPlayMetadata(root, await readPlayManifest(root), "listings"), /exactly 512x512/);
  const files2 = validFiles(); files2["build/play-metadata/en-US/images/featureGraphic.png"] = png(1024, 500, true);
  const root2 = await metadataRoot(manifestYml(), files2);
  await assert.rejects(async () => readPlayMetadata(root2, await readPlayManifest(root2), "listings"), /transparency/);
});

test("Google Play requires two phone screenshots within 320px and 3840px", async () => {
  const files = validFiles();
  delete files["build/play-metadata/en-US/images/phoneScreenshots/02.png"];
  const root = await metadataRoot(manifestYml(), files);
  await assert.rejects(async () => readPlayMetadata(root, await readPlayManifest(root), "listings"), /at least two phone screenshots/);
  const files2 = validFiles();
  files2["build/play-metadata/en-US/images/phoneScreenshots/01.png"] = png(100, 100);
  files2["build/play-metadata/en-US/images/phoneScreenshots/02.png"] = png(100, 100);
  const root2 = await metadataRoot(manifestYml(), files2);
  await assert.rejects(async () => readPlayMetadata(root2, await readPlayManifest(root2), "listings"), /320px minimum/);
  const files3 = validFiles();
  files3["build/play-metadata/en-US/images/phoneScreenshots/01.png"] = png(4000, 200);
  files3["build/play-metadata/en-US/images/phoneScreenshots/02.png"] = png(4000, 200);
  const root3 = await metadataRoot(manifestYml(), files3);
  await assert.rejects(async () => readPlayMetadata(root3, await readPlayManifest(root3), "listings"), /3840px maximum/);
  const root4 = await metadataRoot(manifestYml(), validFiles());
  const listings = await readPlayMetadata(root4, await readPlayManifest(root4), "listings");
  assert.ok(listings.get("en-US")?.images.icon?.length === 1);
  assert.ok(listings.get("en-US")?.images.featureGraphic?.length === 1);
  assert.equal(listings.get("en-US")?.images.phoneScreenshots?.length, 2);
});

test("Google Play plan warns on unconfirmed policy without credentials", async () => {
  const root = await metadataRoot(manifestYml(POLICY_CONFIRMED.replace("contentRating: confirmed", "contentRating: needs-human-confirmation")), validFiles());
  const plan = await planGooglePlayChanges(root, await readPlayManifest(root), "listings", { environment: {} });
  assert.equal(plan.credentialsPresent, false);
  assert.ok(plan.warnings.some((warning) => warning.includes("content rating")));
});

test("Google Play apply requires confirmed policy questionnaires", async () => {
  const root = await metadataRoot(manifestYml(), validFiles());
  const manifest = await readPlayManifest(root);
  assertPlayPolicyReady(manifest);
  manifest.policy.privacyPolicy = "not-applicable";
  assertPlayPolicyReady(manifest);
  manifest.policy.adsDeclaration = "needs-human-confirmation";
  assert.throws(() => assertPlayPolicyReady(manifest), /policy\.adsDeclaration/);
});
