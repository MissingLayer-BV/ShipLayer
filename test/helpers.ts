import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultManifest } from "../src/manifest.js";
import type { ShipLayerManifest } from "../src/types.js";

export function png(width: number, height: number, alpha = false): Buffer {
  const channels = alpha ? 4 : 3; const row = Buffer.alloc(1 + width * channels); const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer): Buffer => { const name = Buffer.from(type); const output = Buffer.alloc(12 + data.length); output.writeUInt32BE(data.length, 0); name.copy(output, 4); data.copy(output, 8); output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length); return output; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let index = 0; index < 8; index++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }

export function readyManifest(type: "free" | "paid-app" | "non-consumables" | "subscriptions" = "free"): ShipLayerManifest {
  const manifest = defaultManifest({ name: "Example", bundleId: "com.example.app", version: "1.0", build: "1", deviceFamilies: ["iphone"] });
  manifest.app.primaryCategory = "Productivity"; manifest.app.appStoreAppId = "1234567890"; manifest.contacts = { supportEmail: "support@example.com", supportUrl: "https://example.com/support", privacyUrl: "https://example.com/privacy", copyright: "2026 Example" };
  manifest.metadata.localizations["en-US"] = { name: "Example", description: "A complete App Store description.", keywords: ["example"] };
  manifest.review = { contact: { firstName: "Ada", lastName: "Reviewer", email: "ada@example.com", phone: "+12025550123" }, demoAccount: { required: false }, recordingScenarios: [{ id: "home", title: "Home", steps: ["Launch"] }] };
  manifest.screenshots.scenarios = [{ id: "home", title: "Home", steps: ["Launch"] }]; manifest.screenshots.configurations = [{ device: "iPhone 16 Pro Max", family: "iphone", locale: "en-US", requiredDimensions: { width: 1320, height: 2868 } }];
  manifest.build = { signing: "automatic", exportCompliance: "exempt", testFlightUpload: false }; manifest.confirmations = { privacy: "confirmed", legal: "confirmed", trader: "confirmed", paidAgreements: "confirmed", ageRating: "confirmed", contentRights: "confirmed" };
  if (type === "paid-app") manifest.monetization = { type: "paid-app", pricePointReference: "P1" };
  if (type === "non-consumables") manifest.monetization = { type: "non-consumables", paywallNavigation: "Tap Upgrade", restorePath: "Tap Restore Purchases", confirmation: "confirmed", products: [{ productId: "com.example.unlock", referenceName: "Example Unlimited", pricePointReference: "P1", familySharing: true, reviewNotes: "Tap Upgrade.", reviewScreenshot: "review/unlock.png", localizations: { "en-US": { displayName: "Example Unlimited", description: "Unlimited access." } } }] };
  if (type === "subscriptions") manifest.monetization = { type: "subscriptions", group: { referenceName: "Example Pro", localizations: { "en-US": { displayName: "Example Pro" } } }, baseTerritory: "USA", baseTerritoryConfirmation: "confirmed", paywallNavigation: "Tap Upgrade", restorePath: "Tap Restore Purchases", termsUrl: "https://example.com/terms", termsOfUse: { type: "apple-standard-eula", confirmation: "confirmed" }, privacyUrl: "https://example.com/privacy", disclosureConfirmation: "confirmed", confirmation: "confirmed", products: [{ productId: "com.example.pro.monthly", referenceName: "Example Pro Monthly", duration: "P1M", level: 1, pricePointReference: "P1", familySharing: true, reviewNotes: "Tap Upgrade.", reviewScreenshot: "review/monthly.png", localizations: { "en-US": { displayName: "Example Pro", description: "Monthly access." } }, introductoryOffer: { type: "free-trial", duration: "P3D" } }] };
  return manifest;
}

export async function writeReadyAssets(root: string, manifest: ShipLayerManifest): Promise<void> {
  const icon = path.join(root, "Assets.xcassets/AppIcon.appiconset"); await mkdir(icon, { recursive: true }); await writeFile(path.join(icon, "Contents.json"), JSON.stringify({ images: [{ filename: "icon.png", idiom: "ios-marketing", size: "1024x1024", scale: "1x" }], info: { version: 1, author: "xcode" } })); await writeFile(path.join(icon, "icon.png"), png(1024, 1024));
  const screenshotDir = path.join(root, manifest.screenshots.rawOutputDir, "iphone", "en-US"); await mkdir(screenshotDir, { recursive: true }); await writeFile(path.join(screenshotDir, "home.png"), png(1320, 2868));
  if (manifest.monetization.type === "non-consumables" || manifest.monetization.type === "subscriptions") for (const product of manifest.monetization.products) { const target = path.join(root, product.reviewScreenshot); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, png(1320, 2868)); }
}
