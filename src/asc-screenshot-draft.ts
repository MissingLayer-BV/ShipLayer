import { AppStoreConnectClient, credentialsFromEnvironment, dataOf, type AscResource, type RemoteScreenshotGroup } from './asc.js';
import { localScreenshotSets, syncScreenshots, type LocalScreenshotSet } from './asc-apply.js';
import { inspectImage } from './image.js';
import type { AscOperation, ShipLayerManifest } from './types.js';

type Client = Pick<AppStoreConnectClient, 'get' | 'post' | 'patch' | 'delete' | 'uploadAsset'>;
const resources = (value: unknown) => dataOf(value) as AscResource[];
function id(resource: AscResource): string {
  if (!resource.id) throw new Error('Apple returned a resource without an ID.');
  return encodeURIComponent(resource.id);
}
function matches(local: LocalScreenshotSet, remote: AscResource[]): boolean {
  return local.screenshots.length === remote.length && local.screenshots.every((s, i) =>
    remote[i].attributes?.fileName === s.fileName &&
    String(remote[i].attributes?.sourceFileChecksum).toLowerCase() === s.checksum &&
    (remote[i].attributes?.assetDeliveryState as {state?: string})?.state === 'COMPLETE');
}

/** Synchronize only reviewed marketing screenshots in an existing unsubmitted
 * draft. No version creation, build attachment, metadata or submission writes. */
export async function draftScreenshots(repository: string, manifest: ShipLayerManifest, apply = false, confirmed = false, suppliedClient?: Client) {
  if (apply && (!confirmed || manifest.sync.mode !== 'apply')) throw new Error('Draft screenshot writes require sync.mode: apply and explicit confirmation.');
  if (!manifest.app.appStoreAppId || !manifest.app.bundleId || !manifest.app.version) throw new Error('Explicit app identity and target version are required.');
  if (!manifest.screenshots.scenarios.length || manifest.screenshots.scenarios.length > 10) throw new Error('One to ten reviewed scenarios are required.');
  for (const scenario of manifest.screenshots.scenarios) {
    if (scenario.confirmation !== 'confirmed' || !scenario.caption?.trim()) throw new Error('Screenshot captions must be confirmed.');
    for (const locale of manifest.app.locales) if (locale !== manifest.app.primaryLocale && (scenario.localizations?.[locale]?.confirmation !== 'confirmed' || !scenario.localizations[locale].caption?.trim())) throw new Error(`Unconfirmed caption ${locale}/${scenario.id}.`);
  }
  const local = await localScreenshotSets(repository, manifest);
  const expected = new Set(manifest.app.locales.flatMap(locale => manifest.app.deviceFamilies.map(family => `${family}/${locale}`)));
  for (const set of local) {
    if (!expected.delete(`${set.family}/${set.locale}`)) throw new Error('Duplicate or unexpected screenshot configuration.');
    if (set.source !== 'marketing' || set.screenshots.length !== manifest.screenshots.scenarios.length) throw new Error('Complete marketing decks are required; raw fallback is not allowed.');
    const config = manifest.screenshots.configurations.find(c => c.family === set.family && c.locale === set.locale)!;
    for (const screenshot of set.screenshots) {
      const image = await inspectImage(screenshot.filePath);
      if (!image || image.alpha || image.width !== config.requiredDimensions.width || image.height !== config.requiredDimensions.height) throw new Error(`Invalid screenshot ${set.locale}/${screenshot.fileName}.`);
    }
  }
  if (expected.size) throw new Error('Missing screenshot configurations.');
  const credentials = credentialsFromEnvironment(manifest);
  if (!suppliedClient && !credentials) throw new Error('App Store Connect credentials are unavailable.');
  const client = suppliedClient ?? new AppStoreConnectClient(credentials!, undefined, 60_000);
  const apps = resources(await client.get(`/apps?filter[bundleId]=${encodeURIComponent(manifest.app.bundleId)}&limit=2`));
  if (apps.length !== 1 || apps[0].id !== manifest.app.appStoreAppId) throw new Error('App identity does not match.');
  const versions = resources(await client.get(`/apps/${id(apps[0])}/appStoreVersions?limit=200`)).filter(v => v.attributes?.platform === 'IOS' && v.attributes?.versionString === manifest.app.version);
  if (versions.length !== 1) throw new Error('Exactly one existing target iOS draft is required.');
  const version = versions[0];
  const assertDraft = (v: AscResource) => {
    if ((v.attributes?.appVersionState ?? v.attributes?.appStoreState) !== 'PREPARE_FOR_SUBMISSION') throw new Error('Target version is not an unsubmitted editable draft.');
  };
  assertDraft(version);
  const locales = resources(await client.get(`/appStoreVersions/${id(version)}/appStoreVersionLocalizations?limit=200`));
  const localizationIds = new Map<string, string>();
  for (const locale of manifest.app.locales) {
    const found = locales.filter(l => l.attributes?.locale === locale);
    if (found.length !== 1) throw new Error(`Exactly one existing localization is required for ${locale}.`);
    localizationIds.set(locale, found[0].id!);
  }
  const readGroup = async (set: LocalScreenshotSet): Promise<RemoteScreenshotGroup | undefined> => {
    const localizationId = localizationIds.get(set.locale)!;
    const sets = resources(await client.get(`/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}/appScreenshotSets?limit=200`)).filter(s => s.attributes?.screenshotDisplayType === set.displayType);
    if (sets.length > 1) throw new Error('Ambiguous screenshot display type.');
    if (!sets.length) return undefined;
    const screenshots = resources(await client.get(`/appScreenshotSets/${id(sets[0])}/appScreenshots?limit=200`));
    const order = resources(await client.get(`/appScreenshotSets/${id(sets[0])}/relationships/appScreenshots?limit=200`));
    const byId = new Map(screenshots.map(s => [s.id, s]));
    if (order.length !== screenshots.length || new Set(order.map(s => s.id)).size !== order.length || order.some(s => !byId.has(s.id))) throw new Error('Screenshot relationship and resource lists disagree.');
    return {localizationId, set: sets[0], screenshots: order.map(s => byId.get(s.id)!)};
  };
  const plan = [];
  for (const set of local) {
    const remote = await readGroup(set);
    plan.push({locale:set.locale, family:set.family, count:set.screenshots.length, status:matches(set, remote?.screenshots ?? []) ? 'already-matches' : 'planned', previousCount:remote?.screenshots.length ?? 0, incomplete:remote?.screenshots.filter(s => (s.attributes?.assetDeliveryState as {state?:string})?.state !== 'COMPLETE').map(s => ({id:s.id,fileName:s.attributes?.fileName,state:s.attributes?.assetDeliveryState})) ?? []});
  }
  if (!apply) return {mode:'preview', version:manifest.app.version, sets:plan, submitted:false};
  const operations: AscOperation[] = [];
  let verifiedScreenshots = 0;
  for (const set of local) {
    const current = resources(await client.get(`/appStoreVersions/${id(version)}`));
    if (current.length !== 1) throw new Error('Target draft disappeared.');
    assertDraft(current[0]);
    const remote = await readGroup(set);
    // Incomplete assets must not be accepted as matching by checksum alone.
    if (remote && remote.screenshots.some(s => (s.attributes?.assetDeliveryState as {state?: string})?.state !== 'COMPLETE')) throw new Error(`Pending or failed Apple processing in ${set.family}/${set.locale}; inspect before retrying: ${JSON.stringify(remote.screenshots.map(s => ({id:s.id,fileName:s.attributes?.fileName,state:s.attributes?.assetDeliveryState})))}.`);
    await syncScreenshots(client, {screenshotGroups: remote ? [remote] : []}, localizationIds, [set], operations);
    let verified = await readGroup(set);
    for (let attempt = 0; attempt < 30 && (!verified || !matches(set, verified.screenshots)); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5_000));
      verified = await readGroup(set);
    }
    if (!verified || !matches(set, verified.screenshots)) throw new Error(`Screenshot read-back failed for ${set.family}/${set.locale}: ${JSON.stringify({expected:set.screenshots.map(s => ({fileName:s.fileName,checksum:s.checksum})),actual:verified?.screenshots.map(s => ({fileName:s.attributes?.fileName,checksum:s.attributes?.sourceFileChecksum,state:s.attributes?.assetDeliveryState}))})}`);
    verifiedScreenshots += set.screenshots.length;
    process.stderr.write(`Verified ${set.family}/${set.locale}: ${set.screenshots.length} screenshots\n`);
  }
  return {mode:'apply', version:manifest.app.version, verifiedSets:local.length, verifiedScreenshots, operations, submitted:false};
}
