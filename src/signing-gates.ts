import path from "node:path";
import { readText, relative, walkRepository } from "./fs.js";
import { isFixtureOrTestEvidencePath, isNonProductionEvidenceDirectory, stripCodeComments } from "./evidence.js";
import type { CheckResult, ShipLayerManifest } from "./types.js";

type Add = (id: string, severity: CheckResult["severity"], message: string, remediation?: string) => void;

const SIGN_IN_WITH_APPLE = /\b(?:ASAuthorizationAppleIDProvider|SignInWithAppleButton|ASAuthorizationAppleIDButton)\b/;
const APPLE_SIGN_IN_ENTITLEMENT = "com.apple.developer.applesignin";
// An xcodebuild archive with signing disabled carries no entitlements, and exportArchive re-signs
// with whatever the archived binary already has, so capabilities the profile allows are silently
// dropped. LinkVoice 1.0 (2) shipped that way and Sign in with Apple failed in review (2026-09-23).
const UNSIGNED_ARCHIVE = /CODE_SIGNING_ALLOWED\s*[=:]\s*["']?NO\b/;

/**
 * Checks that only fail on a device: entitlements the source needs, build scripts that strip them,
 * and a human-confirmed sign-in test of the exact build under review.
 */
export async function signingGates(repository: string, manifest: ShipLayerManifest, add: Add): Promise<void> {
  const root = path.resolve(repository);
  const walked = await walkRepository(root);
  const files = walked.files.map((file) => ({ absolute: file, relative: relative(root, file) }));

  const entitlements = new Map<string, string[]>();
  for (const file of files.filter((item) => item.relative.endsWith(".entitlements") && !isFixtureOrTestEvidencePath(item.relative))) {
    const keys = [...(await readText(file.absolute)).matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
    entitlements.set(file.relative, keys);
  }

  const signInSources: string[] = [];
  for (const file of files.filter((item) => /\.(?:swift|m|mm)$/.test(item.relative) && !isFixtureOrTestEvidencePath(item.relative))) {
    if (SIGN_IN_WITH_APPLE.test(stripCodeComments(await readText(file.absolute)))) signInSources.push(file.relative);
  }

  const unsignedArchives: string[] = [];
  for (const file of files.filter((item) => isBuildScript(item.relative))) {
    const text = stripShellComments(await readText(file.absolute));
    if (/\bxcodebuild\b[\s\S]*\barchive\b|\barchive\b[\s\S]*\bxcodebuild\b|\bgym\b|build_app\b/.test(text) && UNSIGNED_ARCHIVE.test(text)) unsignedArchives.push(file.relative);
  }

  const declaredKeys = [...entitlements.values()].flat();
  if (unsignedArchives.length && declaredKeys.length) {
    add("signing.unsigned-archive-entitlements", "block", `${unsignedArchives.join(", ")} archives with CODE_SIGNING_ALLOWED=NO, so the exported app loses the entitlements declared in ${[...entitlements.keys()].join(", ")} (${[...new Set(declaredKeys)].join(", ")}). Export re-signs with the entitlements the archived binary carries, not the profile's.`, "Archive signed (or ad-hoc signed with CODE_SIGN_IDENTITY=- and AD_HOC_CODE_SIGNING_ALLOWED=YES), then check `codesign -d --entitlements :-` on the exported .app before uploading.");
  } else if (unsignedArchives.length) {
    add("signing.unsigned-archive-entitlements", "pass", `${unsignedArchives.join(", ")} archives unsigned, and no production entitlements file declares capabilities that would be lost.`);
  }

  if (!signInSources.length) return;
  if (declaredKeys.includes(APPLE_SIGN_IN_ENTITLEMENT)) add("signing.sign-in-with-apple-entitlement", "pass", `Sign in with Apple is used (${signInSources.join(", ")}) and ${APPLE_SIGN_IN_ENTITLEMENT} is declared.`);
  else add("signing.sign-in-with-apple-entitlement", "block", `Sign in with Apple is used in ${signInSources.join(", ")}, but no production entitlements file declares ${APPLE_SIGN_IN_ENTITLEMENT}.`, "Add the Sign in with Apple capability to the app target and its App ID.");

  // Simulators and debug builds cannot show a stripped entitlement or a backend audience mismatch;
  // only the exported build on real hardware can, on every device family the app ships to.
  const test = manifest.build.deviceSignInTest;
  const families = manifest.app.deviceFamilies?.length ? manifest.app.deviceFamilies : ["iphone" as const];
  const missingFamilies = families.filter((family) => !test?.devices.includes(family));
  const ready = test?.confirmation === "confirmed" && test.build === manifest.app.build && !missingFamilies.length;
  if (ready) add("signing.device-sign-in-test", "pass", `Sign-in was confirmed on ${test.devices.join(" and ")} with build ${test.build}.`);
  else add("signing.device-sign-in-test", "block", !test ? "Sign in with Apple has no recorded device test of the build under review." : test.build !== manifest.app.build ? `The recorded sign-in test used build ${test.build}, not build ${manifest.app.build}.` : missingFamilies.length ? `The recorded sign-in test does not cover ${missingFamilies.join(", ")}.` : "The recorded sign-in test is not confirmed.", `Install build ${manifest.app.build || "?"} from TestFlight on ${families.join(" and ")} hardware, sign in with Apple (and every other provider) from a fresh install, then record build.deviceSignInTest { build, devices, confirmation: confirmed }.`);
}

// Scripts and CI workflows are exactly where archives are made, so unlike production-evidence
// paths they are included; only fixtures, samples and docs are skipped.
function isBuildScript(file: string): boolean {
  if (isNonProductionEvidenceDirectory(file)) return false;
  return /(?:^|\/)(?:Fastfile|Makefile|Gymfile)$|\.(?:sh|bash|zsh|ya?ml|rb)$/.test(file) && !/(?:^|\/)shiplayer\.ya?ml$/.test(file);
}

function stripShellComments(text: string): string {
  return text.split("\n").map((line) => line.replace(/(^|\s)#.*$/, "$1")).join("\n");
}
