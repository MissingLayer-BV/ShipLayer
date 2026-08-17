import assert from "node:assert/strict";
import test from "node:test";
import { defaultManifest, validateManifest } from "../src/manifest.js";

test("default manifest is structurally valid and requires human confirmations", () => {
  const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" });
  validateManifest(manifest);
  assert.equal(manifest.confirmations.privacy, "needs-human-confirmation");
});

test("subscription validation allows equal service levels but rejects duplicate IDs", () => {
  const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app" });
  manifest.monetization = { type: "subscriptions", group: { referenceName: "Pro" }, baseTerritory: "USA", paywallNavigation: "Tap Upgrade", restorePath: "Tap Restore", termsUrl: "https://example.com/terms", privacyUrl: "https://example.com/privacy", disclosureConfirmation: "confirmed", confirmation: "confirmed", products: [
    { productId: "com.example.pro", referenceName: "Pro Monthly", duration: "P1M", level: 1, pricePointReference: "P1", familySharing: true, reviewNotes: "Tap Upgrade", reviewScreenshot: "review/monthly.png", localizations: { "en-US": { displayName: "Pro", description: "Monthly" } } },
    { productId: "com.example.pro.yearly", referenceName: "Pro Yearly", duration: "P1Y", level: 1, pricePointReference: "P2", familySharing: true, reviewNotes: "Tap Upgrade", reviewScreenshot: "review/yearly.png", localizations: { "en-US": { displayName: "Pro Yearly", description: "Yearly" } } }
  ] };
  validateManifest(manifest);
  manifest.monetization.products[1].productId = "com.example.pro";
  assert.throws(() => validateManifest(manifest), /duplicate product ID/);
});

test("strict monetization union rejects mixed and incomplete product shapes", () => {
  const free = defaultManifest({ name: "Example", bundleId: "com.example.app" }) as unknown as { monetization: unknown };
  free.monetization = { type: "free", products: [] };
  assert.throws(() => validateManifest(free), /Invalid shiplayer/);
  const paid = defaultManifest({ name: "Example", bundleId: "com.example.app" }) as unknown as { monetization: unknown };
  paid.monetization = { type: "paid-app", pricePointReference: "P1", restorePath: "Settings" };
  assert.throws(() => validateManifest(paid), /Invalid shiplayer/);
  const incomplete = defaultManifest({ name: "Example", bundleId: "com.example.app" }) as unknown as { monetization: unknown };
  incomplete.monetization = { type: "subscriptions", group: { referenceName: "Pro" }, baseTerritory: "USA", products: [{ productId: "com.example.pro", duration: "P5M" }] };
  assert.throws(() => validateManifest(incomplete), /Invalid shiplayer/);
});

test("subscription offer semantics reject invalid price combinations and missing configured locales", () => {
  const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app", locales: ["en-US", "de-DE"] });
  manifest.metadata.localizations["de-DE"] = {};
  manifest.monetization = { type: "subscriptions", group: { referenceName: "Pro" }, baseTerritory: "USA", paywallNavigation: "Tap Upgrade", restorePath: "Tap Restore", termsUrl: "https://example.com/terms", privacyUrl: "https://example.com/privacy", disclosureConfirmation: "confirmed", confirmation: "confirmed", products: [{ productId: "com.example.pro", referenceName: "Pro", duration: "P1M", level: 1, pricePointReference: "P1", familySharing: false, reviewNotes: "Tap Upgrade", reviewScreenshot: "review/pro.png", introductoryOffer: { type: "free-trial", duration: "P1W", pricePointReference: "P0" }, localizations: { "en-US": { displayName: "Pro", description: "Monthly" } } }] };
  assert.throws(() => validateManifest(manifest), /free-trial|de-DE/);
  manifest.monetization.products[0].introductoryOffer = { type: "free-trial", duration: "P1W" };
  manifest.monetization.products[0].localizations["de-DE"] = { displayName: "Pro", description: "Monatlich" };
  validateManifest(manifest);
});

test("Apple script locales and modeled introductory offers validate precisely", () => {
  const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app", locales: ["zh-Hans"] });
  manifest.app.primaryLocale = "zh-Hans"; manifest.metadata.localizations = { "zh-Hans": {} };
  manifest.monetization = { type: "subscriptions", group: { referenceName: "Pro" }, baseTerritory: "USA", paywallNavigation: "Tap Upgrade", restorePath: "Tap Restore", termsUrl: "https://example.com/terms", privacyUrl: "https://example.com/privacy", disclosureConfirmation: "confirmed", confirmation: "confirmed", products: [{ productId: "com.example.pro", referenceName: "Pro", duration: "P1M", level: 1, pricePointReference: "P1", familySharing: false, reviewNotes: "Tap Upgrade", reviewScreenshot: "review/pro.png", introductoryOffer: { type: "free-trial", duration: "P3D" }, localizations: { "zh-Hans": { displayName: "Pro", description: "Monthly" } } }] };
  validateManifest(manifest);
  manifest.monetization.products[0].introductoryOffer = { type: "pay-as-you-go", duration: "P2W", pricePointReference: "P1", numberOfPeriods: 3 };
  validateManifest(manifest);
  manifest.monetization.products[0].introductoryOffer = { type: "pay-as-you-go", duration: "P2W", pricePointReference: "P1" };
  assert.throws(() => validateManifest(manifest), /numberOfPeriods/);
  const badUrl = defaultManifest({ name: "Example", bundleId: "com.example.app" }); badUrl.contacts.supportUrl = "https://";
  assert.throws(() => validateManifest(badUrl), /Invalid shiplayer/);
});
