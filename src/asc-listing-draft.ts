import { AppStoreConnectClient, credentialsFromEnvironment, dataOf, isEditableAppVersionState, type AscResource } from './asc.js';
import type { ShipLayerManifest } from './types.js';

type Client = Pick<AppStoreConnectClient, 'get' | 'patch'>;
const resources = (value: unknown) => dataOf(value) as AscResource[];
const id = (resource: AscResource): string => {
  if (!resource.id) throw new Error('Apple returned a resource without an ID.');
  return encodeURIComponent(resource.id);
};

function desiredAttributes(manifest: ShipLayerManifest, locale: string): Record<string, string> {
  const copy = manifest.metadata.localizations[locale];
  if (!copy || copy.confirmation !== 'confirmed') throw new Error(`Confirmed App Store copy is required for ${locale}.`);
  if (!copy.description?.trim() || !copy.promotionalText?.trim()) throw new Error(`Description and promotional text are required for ${locale}.`);
  if (manifest.app.releaseKind === 'update' && !copy.whatsNew?.trim()) throw new Error(`What's New copy is required for ${locale}.`);
  return {
    description: copy.description,
    promotionalText: copy.promotionalText,
    ...(manifest.app.releaseKind === 'update' ? { whatsNew: copy.whatsNew! } : {}),
    ...(copy.keywords?.length ? { keywords: copy.keywords.join(',') } : {}),
    supportUrl: copy.supportUrl ?? manifest.contacts.supportUrl!,
    marketingUrl: copy.marketingUrl ?? manifest.contacts.marketingUrl!,
  };
}

/** Name, subtitle and Privacy Policy URL live on the App Info localization,
 * not on the version. Only fields the manifest actually declares are synced. */
function desiredAppInfoAttributes(manifest: ShipLayerManifest, locale: string): Record<string, string> {
  const copy = manifest.metadata.localizations[locale]!;
  const privacyPolicyUrl = copy.privacyPolicyUrl ?? manifest.contacts.privacyUrl;
  return {
    ...(copy.name?.trim() ? { name: copy.name } : {}),
    ...(copy.subtitle?.trim() ? { subtitle: copy.subtitle } : {}),
    ...(privacyPolicyUrl ? { privacyPolicyUrl } : {}),
  };
}

/** Synchronize the listing fields of an existing editable draft: the
 * version-localized copy, plus name, subtitle and Privacy Policy URL on an
 * existing localization of the editable App Info. It never creates a
 * localization, and no build, screenshots, review details, categories, or
 * submission state are changed. */
export async function draftListing(
  manifest: ShipLayerManifest,
  selectedLocales: string[],
  apply = false,
  confirmed = false,
  suppliedClient?: Client,
) {
  if (apply && (!confirmed || manifest.sync.mode !== 'apply')) throw new Error('Draft listing writes require sync.mode: apply and explicit confirmation.');
  if (!manifest.app.appStoreAppId || !manifest.app.bundleId || !manifest.app.version) throw new Error('Explicit app identity and target version are required.');
  if (!selectedLocales.length || new Set(selectedLocales).size !== selectedLocales.length) throw new Error('One or more unique locales are required.');
  for (const locale of selectedLocales) if (!manifest.app.locales.includes(locale)) throw new Error(`Locale ${locale} is not configured in the manifest.`);

  const desired = new Map(selectedLocales.map(locale => [locale, desiredAttributes(manifest, locale)]));
  const credentials = credentialsFromEnvironment(manifest);
  if (!suppliedClient && !credentials) throw new Error('App Store Connect credentials are unavailable.');
  const client = suppliedClient ?? new AppStoreConnectClient(credentials!);
  const apps = resources(await client.get(`/apps?filter[bundleId]=${encodeURIComponent(manifest.app.bundleId)}&limit=2`));
  if (apps.length !== 1 || apps[0].id !== manifest.app.appStoreAppId) throw new Error('App identity does not match.');
  const versions = resources(await client.get(`/apps/${id(apps[0])}/appStoreVersions?limit=200`)).filter(version =>
    version.attributes?.platform === 'IOS' && version.attributes?.versionString === manifest.app.version
  );
  if (versions.length !== 1) throw new Error('Exactly one existing target iOS draft is required.');
  const version = versions[0];
  const assertDraft = (resource: AscResource) => {
    const state = resource.attributes?.appVersionState ?? resource.attributes?.appStoreState;
    if (!isEditableAppVersionState(state)) throw new Error(`Version ${manifest.app.version} is not an editable draft (${state}).`);
  };
  assertDraft(version);

  const readLocalizations = async () => resources(await client.get(`/appStoreVersions/${id(version)}/appStoreVersionLocalizations?limit=200`));
  let remote = await readLocalizations();
  const lookup = (locale: string) => {
    const matches = remote.filter(item => item.attributes?.locale === locale);
    if (matches.length !== 1) throw new Error(`Exactly one existing localization is required for ${locale}.`);
    return matches[0];
  };
  const differences = (locale: string) => Object.fromEntries(Object.entries(desired.get(locale)!).filter(([key, value]) => lookup(locale).attributes?.[key] !== value));
  // App Info: only the editable record (a live app also keeps a read-only one).
  const desiredAppInfo = new Map(selectedLocales.map(locale => [locale, desiredAppInfoAttributes(manifest, locale)]));
  const editableAppInfos = resources(await client.get(`/apps/${id(apps[0])}/appInfos?limit=200`)).filter(info =>
    isEditableAppVersionState(info.attributes?.state ?? info.attributes?.appStoreState)
  );
  if (editableAppInfos.length > 1) throw new Error('More than one editable App Info exists.');
  const appInfo = editableAppInfos[0];
  const readAppInfoLocalizations = async () => appInfo ? resources(await client.get(`/appInfos/${id(appInfo)}/appInfoLocalizations?limit=200`)) : [];
  let remoteAppInfo = await readAppInfoLocalizations();
  const lookupAppInfo = (locale: string) => {
    const matches = remoteAppInfo.filter(item => item.attributes?.locale === locale);
    if (matches.length > 1) throw new Error(`More than one App Info localization exists for ${locale}.`);
    return matches[0];
  };
  const appInfoDifferences = (locale: string) => {
    const existing = lookupAppInfo(locale);
    if (!existing) return {};
    return Object.fromEntries(Object.entries(desiredAppInfo.get(locale)!).filter(([key, value]) => existing.attributes?.[key] !== value));
  };
  const appInfoStatus = (locale: string) => !appInfo ? 'not-editable' : !lookupAppInfo(locale) ? 'missing-localization'
    : Object.keys(appInfoDifferences(locale)).length ? 'planned' : 'already-matches';

  const operations = selectedLocales.map(locale => {
    const changed = differences(locale);
    return {
      locale, fields: Object.keys(changed), status: Object.keys(changed).length ? 'planned' : 'already-matches',
      appInfoFields: Object.keys(appInfoDifferences(locale)), appInfoStatus: appInfoStatus(locale),
    };
  });
  if (!apply) return { mode: 'preview', version: manifest.app.version, operations, submitted: false };

  for (const [index, locale] of selectedLocales.entries()) {
    const changed = differences(locale);
    const appInfoChanged = appInfoDifferences(locale);
    if (Object.keys(appInfoChanged).length) {
      const localization = lookupAppInfo(locale)!;
      await client.patch(`/appInfoLocalizations/${id(localization)}`, {
        data: { type: 'appInfoLocalizations', id: localization.id, attributes: appInfoChanged },
      });
      operations[index].appInfoStatus = 'applied';
    }
    if (!Object.keys(changed).length) continue;
    const current = resources(await client.get(`/appStoreVersions/${id(version)}`));
    if (current.length !== 1) throw new Error('Target draft disappeared. Partial changes may have occurred.');
    assertDraft(current[0]);
    const localization = lookup(locale);
    await client.patch(`/appStoreVersionLocalizations/${id(localization)}`, {
      data: { type: 'appStoreVersionLocalizations', id: localization.id, attributes: changed },
    });
    operations[index].status = 'applied';
  }

  remote = await readLocalizations();
  remoteAppInfo = await readAppInfoLocalizations();
  for (const locale of selectedLocales) {
    const appInfoLocalization = lookupAppInfo(locale);
    if (appInfoLocalization) for (const [key, value] of Object.entries(desiredAppInfo.get(locale)!)) {
      if (appInfoLocalization.attributes?.[key] !== value) throw new Error(`Read-back verification failed for App Info ${locale}.${key}. Partial changes may have occurred.`);
    }
    for (const [key, value] of Object.entries(desired.get(locale)!)) {
      if (lookup(locale).attributes?.[key] !== value) throw new Error(`Read-back verification failed for ${locale}.${key}. Partial changes may have occurred.`);
    }
  }
  return { mode: 'apply', version: manifest.app.version, operations, verifiedLocales: selectedLocales.length, submitted: false };
}
