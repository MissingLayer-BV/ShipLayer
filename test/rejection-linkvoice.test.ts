// Regression tests for LinkVoice 1.0 (2), rejected on 2026-09-23 under 2.1(a) (Sign in with Apple
// failed on device: the unsigned archive dropped the entitlement), 2.1(b) (subscriptions and the
// consumable were READY_TO_SUBMIT but never submitted) and 5.1.1(i)/5.1.2(i) (AI consent was only a
// sign-in agreement line; see the override test in app-review-gates.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { productSubmissionReadiness, type AscResource } from "../src/asc.js";
import { signingGates } from "../src/signing-gates.js";
import type { CheckResult, ShipLayerManifest } from "../src/types.js";

const product = (productId: string, state: string): AscResource => ({ id: productId, attributes: { productId, state } });

test("products the app sells but App Review never received become a manual pre-submission step", () => {
  const rejected = productSubmissionReadiness({
    subscriptions: [product("com.LinkVoice.subscription.basic.monthly", "READY_TO_SUBMIT"), product("com.LinkVoice.subscription.pro.monthly", "READY_TO_SUBMIT")],
    inAppPurchases: [product("com.LinkVoice.credits.standard", "READY_TO_SUBMIT")]
  });
  assert.equal(rejected.warnings.length, 1);
  assert.match(rejected.warnings[0], /3 product\(s\).*2\.1\(b\)/);
  assert.equal(rejected.operations[0]?.id, "manual.submit-products");
  assert.match(rejected.operations[0]?.description ?? "", /com\.LinkVoice\.credits\.standard/);

  const incomplete = productSubmissionReadiness({ subscriptions: [product("pro", "MISSING_METADATA")], inAppPurchases: [] });
  assert.match(incomplete.warnings.join("\n"), /Not ready to submit: subscription pro \(MISSING_METADATA\)/);

  const submitted = productSubmissionReadiness({ subscriptions: [product("pro", "WAITING_FOR_REVIEW"), product("basic", "APPROVED")], inAppPurchases: [product("pack", "REMOVED_FROM_SALE")] });
  assert.deepEqual(submitted, { warnings: [], operations: [] });
});

async function signInRepository(script: string, entitlements = "<key>com.apple.developer.applesignin</key><array><string>Default</string></array>"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "shiplayer-signing-"));
  await mkdir(path.join(root, "App"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "App/App.entitlements"), `<plist version="1.0"><dict>${entitlements}</dict></plist>\n`);
  await writeFile(path.join(root, "App/AccountService.swift"), "import AuthenticationServices\nlet request = ASAuthorizationAppleIDProvider().createRequest()\n");
  await writeFile(path.join(root, "scripts/deliver.sh"), script);
  return root;
}

function manifestWith(deviceSignInTest?: NonNullable<ShipLayerManifest["build"]["deviceSignInTest"]>): ShipLayerManifest {
  return { app: { build: "3", deviceFamilies: ["iphone", "ipad"] }, build: { signing: "automatic", deviceSignInTest } } as unknown as ShipLayerManifest;
}

async function run(root: string, manifest: ShipLayerManifest): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  await signingGates(root, manifest, (id, severity, message, remediation) => results.push({ id, severity, message, remediation }));
  return results;
}

const severity = (results: CheckResult[], id: string) => results.find((item) => item.id === id)?.severity;

test("an unsigned xcodebuild archive blocks while the project declares entitlements", async () => {
  const unsigned = await signInRepository("xcodebuild archive -scheme App \\\n    CODE_SIGNING_ALLOWED=NO \\\n    CODE_SIGNING_REQUIRED=NO\n");
  const blocked = await run(unsigned, manifestWith());
  assert.equal(severity(blocked, "signing.unsigned-archive-entitlements"), "block");
  assert.match(blocked.find((item) => item.id === "signing.unsigned-archive-entitlements")?.message ?? "", /com\.apple\.developer\.applesignin/);

  const adHoc = await signInRepository("# Build 2 archived with CODE_SIGNING_ALLOWED=NO and lost the entitlement.\nxcodebuild archive -scheme App CODE_SIGN_IDENTITY=- AD_HOC_CODE_SIGNING_ALLOWED=YES\n");
  assert.equal(severity(await run(adHoc, manifestWith()), "signing.unsigned-archive-entitlements"), undefined, "a comment is not a build step");

  const noEntitlements = await signInRepository("xcodebuild archive CODE_SIGNING_ALLOWED=NO\n", "");
  assert.equal(severity(await run(noEntitlements, manifestWith()), "signing.unsigned-archive-entitlements"), "pass");
});

test("Sign in with Apple needs its entitlement and a confirmed device test of the exact build on every family", async () => {
  const missing = await signInRepository("", "<key>aps-environment</key><string>production</string>");
  assert.equal(severity(await run(missing, manifestWith()), "signing.sign-in-with-apple-entitlement"), "block");

  const root = await signInRepository("");
  assert.equal(severity(await run(root, manifestWith()), "signing.sign-in-with-apple-entitlement"), "pass");
  assert.equal(severity(await run(root, manifestWith()), "signing.device-sign-in-test"), "block");
  const oldBuild = await run(root, manifestWith({ build: "2", devices: ["iphone", "ipad"], confirmation: "confirmed" }));
  assert.match(oldBuild.find((item) => item.id === "signing.device-sign-in-test")?.message ?? "", /build 2, not build 3/);
  const phoneOnly = await run(root, manifestWith({ build: "3", devices: ["iphone"], confirmation: "confirmed" }));
  assert.match(phoneOnly.find((item) => item.id === "signing.device-sign-in-test")?.message ?? "", /does not cover ipad/);
  assert.equal(severity(await run(root, manifestWith({ build: "3", devices: ["iphone", "ipad"], confirmation: "needs-human-confirmation" })), "signing.device-sign-in-test"), "block");
  assert.equal(severity(await run(root, manifestWith({ build: "3", devices: ["iphone", "ipad"], confirmation: "confirmed" })), "signing.device-sign-in-test"), "pass");
});
