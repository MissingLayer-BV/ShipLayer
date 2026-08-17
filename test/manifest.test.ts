import assert from "node:assert/strict";
import test from "node:test";
import { defaultManifest, validateManifest } from "../src/manifest.js";

test("default manifest is structurally valid and requires human confirmations", () => {
  const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" });
  validateManifest(manifest);
  assert.equal(manifest.confirmations.privacy, "needs-human-confirmation");
});

test("subscription validation rejects duplicate IDs and levels", () => {
  const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" });
  manifest.monetization = { type: "subscriptions", group: { referenceName: "Pro" }, baseTerritory: "USA", paywallNavigation: "Tap Upgrade", restorePath: "Tap Restore", confirmation: "confirmed", products: [
    { productId: "com.example.pro", referenceName: "Pro Monthly", duration: "P1M", level: 1, localizations: { "en-US": { displayName: "Pro", description: "Monthly" } } },
    { productId: "com.example.pro", referenceName: "Pro Yearly", duration: "P1Y", level: 1, localizations: { "en-US": { displayName: "Pro Yearly", description: "Yearly" } } }
  ] };
  assert.throws(() => validateManifest(manifest), /duplicate product ID/);
});
