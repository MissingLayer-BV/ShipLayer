import { Ajv2020 } from "ajv/dist/2020.js";
import { parse, stringify } from "yaml";
import path from "node:path";
import { readText, safeRelativePath, writeText } from "./fs.js";
import schema from "./schema.json" with { type: "json" };
import type { ShipLayerManifest } from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

export function manifestPath(repo: string): string { return path.join(repo, "shiplayer.yml"); }
export function defaultManifest(input: Partial<ShipLayerManifest["app"]> = {}): ShipLayerManifest {
  const app = { name: input.name || "", bundleId: input.bundleId || "", deviceFamilies: input.deviceFamilies || ["iphone", "ipad"], locales: input.locales || ["en-US"], primaryLocale: input.primaryLocale || "en-US", availability: input.availability || "all", releaseMode: input.releaseMode || "manual", ...input } as ShipLayerManifest["app"];
  return { schemaVersion: 1, app, contacts: {}, metadata: { localizations: { [app.primaryLocale]: {} } }, permissions: [], dataProcessing: [], externalProcessors: [], review: { demoAccount: { required: false }, recordingScenarios: [] }, screenshots: { scenarios: [], configurations: screenshotConfigs(app.primaryLocale, app.deviceFamilies), rawOutputDir: "release/raw-screenshots", marketingProjectPath: "design/app-store-screenshots" }, monetization: { type: "free" }, build: { signing: "unknown", exportCompliance: "unknown", testFlightUpload: false }, sync: { mode: "dry-run", appStoreConnectKeyIdEnv: "APP_STORE_CONNECT_KEY_ID", issuerIdEnv: "APP_STORE_CONNECT_ISSUER_ID", privateKeyPathEnv: "APP_STORE_CONNECT_PRIVATE_KEY_PATH" }, confirmations: { privacy: "needs-human-confirmation", legal: "needs-human-confirmation", trader: "needs-human-confirmation", paidAgreements: "needs-human-confirmation", ageRating: "needs-human-confirmation", contentRights: "needs-human-confirmation" } };
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
  const manifest = candidate as unknown as ShipLayerManifest;
  const errors: string[] = [];
  const ids = new Set<string>();
  const add = (id: string, field: string): void => { if (ids.has(id)) errors.push(`duplicate product ID '${id}' in ${field}`); ids.add(id); };
  for (const locale of manifest.app.locales) if (!manifest.metadata.localizations[locale]) errors.push(`metadata.localizations is missing configured locale ${locale}`);
  for (const [label, candidatePath] of [["screenshots.rawOutputDir", manifest.screenshots.rawOutputDir], ["screenshots.marketingProjectPath", manifest.screenshots.marketingProjectPath]] as const) {
    if (!candidatePath) continue;
    try { safeRelativePath(candidatePath, label); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (manifest.monetization.type === "non-consumables") for (const product of manifest.monetization.products) {
    add(product.productId, "non-consumables");
    for (const locale of manifest.app.locales) if (!product.localizations[locale]) errors.push(`non-consumable ${product.productId} needs ${locale} localization`);
    try { safeRelativePath(product.reviewScreenshot, `review screenshot for ${product.productId}`); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  if (manifest.monetization.type === "subscriptions") {
    for (const product of manifest.monetization.products) {
      add(product.productId, "subscriptions");
      for (const locale of manifest.app.locales) if (!product.localizations[locale]) errors.push(`subscription ${product.productId} needs ${locale} localization`);
      try { safeRelativePath(product.reviewScreenshot, `review screenshot for ${product.productId}`); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      const offer = product.introductoryOffer;
      if (offer && offer.type === "free-trial" && (offer.pricePointReference || offer.numberOfPeriods)) errors.push(`free-trial ${product.productId} cannot have a pricePointReference or numberOfPeriods`);
      if (offer && offer.type !== "free-trial" && !offer.pricePointReference) errors.push(`paid introductory offer ${product.productId} needs a pricePointReference`);
      if (offer?.type === "pay-as-you-go" && (!offer.numberOfPeriods || offer.numberOfPeriods < 1 || offer.numberOfPeriods > 12)) errors.push(`pay-as-you-go ${product.productId} needs numberOfPeriods between 1 and 12`);
      if (offer?.type === "pay-up-front" && offer.numberOfPeriods) errors.push(`pay-up-front ${product.productId} cannot have numberOfPeriods`);
    }
  }
  if (!manifest.app.locales.includes(manifest.app.primaryLocale)) errors.push("app.primaryLocale must appear in app.locales");
  if (errors.length) throw new Error(`Invalid shiplayer.yml:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}
