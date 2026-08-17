import { Ajv2020 } from "ajv/dist/2020.js";
import { parse, stringify } from "yaml";
import path from "node:path";
import { readText, writeText } from "./fs.js";
import schema from "./schema.json" with { type: "json" };
import type { ShipLayerManifest } from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

export function manifestPath(repo: string): string { return path.join(repo, "shiplayer.yml"); }
export function defaultManifest(input: Partial<ShipLayerManifest["app"]> = {}): ShipLayerManifest {
  const app = { name: input.name || "", bundleId: input.bundleId || "", deviceFamilies: input.deviceFamilies || ["iphone", "ipad"], locales: input.locales || ["en-US"], primaryLocale: input.primaryLocale || "en-US", availability: input.availability || "all", releaseMode: input.releaseMode || "manual", ...input } as ShipLayerManifest["app"];
  return { schemaVersion: 1, app, contacts: {}, metadata: { localizations: { [app.primaryLocale]: {} } }, permissions: [], dataProcessing: [], externalProcessors: [], review: { demoAccount: { required: false }, recordingScenarios: [] }, screenshots: { scenarios: [], configurations: screenshotConfigs(app.primaryLocale, app.deviceFamilies), rawOutputDir: "release/raw-screenshots", marketingProjectPath: "design/app-store-screenshots" }, monetization: { type: "free" }, build: { signing: "unknown", exportCompliance: "unknown", testFlightUpload: false }, sync: { mode: "dry-run", appStoreConnectKeyIdEnv: "APP_STORE_CONNECT_KEY_ID", issuerIdEnv: "APP_STORE_CONNECT_ISSUER_ID", privateKeyPathEnv: "APP_STORE_CONNECT_PRIVATE_KEY_PATH" }, confirmations: { privacy: "needs-human-confirmation", legal: "needs-human-confirmation", trader: "needs-human-confirmation", paidAgreements: "needs-human-confirmation" } };
}

function screenshotConfigs(locale: string, families: Array<"iphone" | "ipad">): ShipLayerManifest["screenshots"]["configurations"] {
  const configs: ShipLayerManifest["screenshots"]["configurations"] = [];
  if (families.includes("iphone")) configs.push({ device: "iPhone 16 Pro Max", family: "iphone", locale, requiredDimensions: { width: 1320, height: 2868 } });
  if (families.includes("ipad")) configs.push({ device: "iPad Pro 13-inch (M4)", family: "ipad", locale, requiredDimensions: { width: 2064, height: 2752 } });
  return configs;
}

export async function readManifest(repo: string): Promise<ShipLayerManifest> {
  const filePath = manifestPath(repo); const document = parse(await readText(filePath));
  if (!document || typeof document !== "object") throw new Error(`Manifest ${filePath} must contain a YAML object.`);
  validateManifest(document); return document as unknown as ShipLayerManifest;
}
export async function writeManifest(repo: string, manifest: ShipLayerManifest): Promise<void> { validateManifest(manifest); await writeText(manifestPath(repo), stringify(manifest, { sortMapEntries: true })); }
export function validateManifest(candidate: unknown): asserts candidate is ShipLayerManifest {
  if (!validateSchema(candidate)) throw new Error(`Invalid shiplayer.yml:\n${(validateSchema.errors || []).map((error: { instancePath?: string; message?: string }) => `- ${error.instancePath || "/"} ${error.message || "is invalid"}`).join("\n")}`);
  const manifest = candidate as unknown as ShipLayerManifest; const ids = new Set<string>();
  const add = (id: string, field: string): void => { if (ids.has(id)) throw new Error(`Invalid shiplayer.yml: duplicate product ID '${id}' in ${field}.`); ids.add(id); };
  if (manifest.monetization.type === "non-consumables") for (const product of manifest.monetization.products) add(product.productId, "non-consumables");
  if (manifest.monetization.type === "subscriptions") {
    const levels = new Set<number>();
    for (const product of manifest.monetization.products) { add(product.productId, "subscriptions"); if (levels.has(product.level)) throw new Error(`Invalid shiplayer.yml: subscription level ${product.level} is duplicated.`); levels.add(product.level); if (!product.localizations[manifest.app.primaryLocale]) throw new Error(`Invalid shiplayer.yml: subscription ${product.productId} needs ${manifest.app.primaryLocale} localization.`); }
    if (!manifest.monetization.paywallNavigation.trim() || !manifest.monetization.restorePath.trim()) throw new Error("Invalid shiplayer.yml: subscriptions require paywallNavigation and restorePath.");
  }
  if (!manifest.app.locales.includes(manifest.app.primaryLocale)) throw new Error("Invalid shiplayer.yml: app.primaryLocale must appear in app.locales.");
}
