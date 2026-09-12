import { AppStoreConnectClient, credentialsFromEnvironment, dataOf, isEditableAppVersionState, type AscResource } from './asc.js';
import type { ShipLayerManifest } from './types.js';

type Client = Pick<AppStoreConnectClient, 'get' | 'post' | 'patch'>;
const resources = (value: unknown) => dataOf(value) as AscResource[];
const id = (value: AscResource) => {
  if (!value.id) throw new Error('Apple returned a resource without an ID.');
  return encodeURIComponent(value.id);
};

/** A deliberately separate draft operation: no builds, screenshots, release
 * notes, App Info, review details, or submission endpoints are written. */
export async function draftDescriptions(manifest: ShipLayerManifest, apply = false, confirmed = false, suppliedClient?: Client) {
  if (apply && (!confirmed || manifest.sync.mode !== 'apply')) {
    throw new Error('Draft writes require sync.mode: apply and --apply --yes-i-understand.');
  }
  const version = manifest.app.version;
  if (!version || !manifest.app.bundleId || !manifest.app.appStoreAppId) throw new Error('Explicit app ID, bundle ID, and version are required.');
  const locales = manifest.app.locales;
  if (!locales.length || new Set(locales).size !== locales.length) throw new Error('Unique locales are required.');
  for (const locale of locales) {
    const copy = manifest.metadata.localizations[locale];
    if (copy?.confirmation !== 'confirmed' || !copy.description?.trim() || copy.description.length > 4000) {
      throw new Error(`A confirmed description of 1–4000 characters is required for ${locale}.`);
    }
  }
  const credentials = credentialsFromEnvironment(manifest);
  if (!suppliedClient && !credentials) throw new Error('App Store Connect credentials are unavailable.');
  const client = suppliedClient ?? new AppStoreConnectClient(credentials!);
  const apps = resources(await client.get(`/apps?filter[bundleId]=${encodeURIComponent(manifest.app.bundleId)}&limit=2`));
  if (apps.length !== 1 || apps[0].id !== manifest.app.appStoreAppId) throw new Error('App identity does not match the manifest.');
  const appId = id(apps[0]);
  const versions = resources(await client.get(`/apps/${appId}/appStoreVersions?limit=200`)).filter(v => v.attributes?.platform === 'IOS');
  if (!versions.length || manifest.app.releaseKind !== 'update') throw new Error('This command only prepares updates for existing iOS apps.');
  const targets = versions.filter(v => v.attributes?.versionString === version);
  if (targets.length > 1) throw new Error('Ambiguous target version.');
  let target = targets[0];
  const assertDraft = (resource: AscResource) => {
    const state = resource.attributes?.appVersionState ?? resource.attributes?.appStoreState;
    if (!isEditableAppVersionState(state)) throw new Error(`Version ${version} is not an editable draft (${state}).`);
  };
  if (target) assertDraft(target);
  if (!target && versions.some(v => !['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE', 'DEVELOPER_REMOVED_FROM_SALE'].includes(String(v.attributes?.appVersionState ?? v.attributes?.appStoreState)))) {
    throw new Error('Another non-released version exists; inspect it before creating a new draft.');
  }
  let remote = target ? resources(await client.get(`/appStoreVersions/${id(target)}/appStoreVersionLocalizations?limit=200`)) : [];
  const lookup = (locale: string) => {
    const matches = remote.filter(item => item.attributes?.locale === locale);
    if (matches.length > 1) throw new Error(`Duplicate remote locale ${locale}.`);
    return matches[0];
  };
  const operations = [
    { resource: `version.${version}`, action: target ? 'read' : 'create', status: target ? 'already-matches' : 'planned' },
    ...locales.map(locale => {
      const item = lookup(locale);
      const matches = item?.attributes?.description === manifest.metadata.localizations[locale].description;
      return { resource: `description.${locale}`, action: matches ? 'read' : item ? 'update' : 'create', status: matches ? 'already-matches' : 'planned' };
    }),
  ];
  if (!apply) return { mode: 'preview', version, operations, submitted: false };
  if (!target) {
    const created = resources(await client.post('/appStoreVersions', { data: {
      type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: version, releaseType: 'MANUAL' },
      relationships: { app: { data: { type: 'apps', id: apps[0].id } } },
    } }));
    if (created.length !== 1) throw new Error('Version creation did not return one version. Partial changes may have occurred.');
    target = created[0];
    assertDraft(target);
    operations[0].status = 'applied';
    // Apple can copy localizations from the live version during creation.
    remote = resources(await client.get(`/appStoreVersions/${id(target)}/appStoreVersionLocalizations?limit=200`));
  }
  for (const [index, locale] of locales.entries()) {
    const description = manifest.metadata.localizations[locale].description;
    const item = lookup(locale);
    if (item?.attributes?.description === description) {
      operations[index + 1] = { resource: `description.${locale}`, action: 'read', status: 'already-matches' };
      continue;
    }
    // Recheck lifecycle before each write, including runs resumed after failure.
    const current = resources(await client.get(`/appStoreVersions/${id(target)}`));
    if (current.length !== 1) throw new Error('Target version disappeared. Partial changes may have occurred.');
    assertDraft(current[0]);
    if (item) await client.patch(`/appStoreVersionLocalizations/${id(item)}`, { data: { type: 'appStoreVersionLocalizations', id: item.id, attributes: { description } } });
    else await client.post('/appStoreVersionLocalizations', { data: {
      type: 'appStoreVersionLocalizations', attributes: { locale, description },
      relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: target.id } } },
    } });
    operations[index + 1] = { resource: `description.${locale}`, action: item ? 'update' : 'create', status: 'applied' };
  }
  remote = resources(await client.get(`/appStoreVersions/${id(target)}/appStoreVersionLocalizations?limit=200`));
  for (const locale of locales) {
    if (lookup(locale)?.attributes?.description !== manifest.metadata.localizations[locale].description) {
      throw new Error(`Read-back verification failed for ${locale}. Partial changes may have occurred.`);
    }
  }
  return { mode: 'apply', version, operations, verifiedLocales: locales.length, submitted: false };
}
