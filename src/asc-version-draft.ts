import { AppStoreConnectClient, credentialsFromEnvironment, dataOf, isEditableAppVersionState, type AscResource } from './asc.js';
import type { ShipLayerManifest } from './types.js';

type Client = Pick<AppStoreConnectClient, 'get' | 'patch'>;
type Operation = { id: string; resource: string; detail: string; status: 'planned' | 'already-matches' | 'applied' };

const resources = (value: unknown) => dataOf(value) as AscResource[];
const id = (resource: AscResource): string => {
  if (!resource.id) throw new Error('Apple returned a resource without an ID.');
  return encodeURIComponent(resource.id);
};
const categoryId = (name: string | undefined) => name?.toUpperCase().replaceAll('&', 'AND').replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
const isMissing = (error: unknown) => /\b404\b|NOT_FOUND/i.test(String((error as Error)?.message ?? error));

/** Synchronize the release settings of an existing editable draft: copyright
 * and release mode, the declared categories on the editable App Info, and the
 * declared build. Listing copy, screenshots, review material, pricing, and
 * submission state are not changed. */
export async function draftVersion(manifest: ShipLayerManifest, apply = false, confirmed = false, suppliedClient?: Client) {
  if (apply && (!confirmed || manifest.sync.mode !== 'apply')) throw new Error('Draft version writes require sync.mode: apply and explicit confirmation.');
  const { appStoreAppId, bundleId, version: versionString, build: buildNumber } = manifest.app;
  if (!appStoreAppId || !bundleId || !versionString || !buildNumber) throw new Error('Explicit app identity, target version, and build are required.');
  if (!manifest.contacts.copyright?.trim()) throw new Error('contacts.copyright is required.');
  const primary = categoryId(manifest.app.primaryCategory);
  const secondary = categoryId(manifest.app.secondaryCategory);
  if (!primary) throw new Error('app.primaryCategory is required.');
  const desiredVersion: Record<string, string> = {
    copyright: manifest.contacts.copyright,
    releaseType: manifest.app.releaseMode === 'automatic' ? 'AFTER_APPROVAL' : manifest.app.releaseMode === 'manual' ? 'MANUAL' : '',
  };
  if (!desiredVersion.releaseType) throw new Error('A scheduled release needs a date; set it in App Store Connect or use the fully gated apply.');

  const credentials = credentialsFromEnvironment(manifest);
  if (!suppliedClient && !credentials) throw new Error('App Store Connect credentials are unavailable.');
  const client = suppliedClient ?? new AppStoreConnectClient(credentials!);
  const apps = resources(await client.get(`/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=2`));
  if (apps.length !== 1 || apps[0].id !== appStoreAppId) throw new Error('App identity does not match.');
  const readVersion = async () => {
    const versions = resources(await client.get(`/apps/${id(apps[0])}/appStoreVersions?limit=200`)).filter(item =>
      item.attributes?.platform === 'IOS' && item.attributes?.versionString === versionString
    );
    if (versions.length !== 1) throw new Error('Exactly one existing target iOS draft is required.');
    const state = versions[0].attributes?.appVersionState ?? versions[0].attributes?.appStoreState;
    if (!isEditableAppVersionState(state)) throw new Error(`Version ${versionString} is not an editable draft (${state}).`);
    return versions[0];
  };
  const version = await readVersion();
  const versionDifferences = (resource: AscResource) => Object.fromEntries(Object.entries(desiredVersion).filter(([key, value]) => resource.attributes?.[key] !== value));

  const appInfos = resources(await client.get(`/apps/${id(apps[0])}/appInfos?limit=200`)).filter(info =>
    isEditableAppVersionState(info.attributes?.state ?? info.attributes?.appStoreState)
  );
  if (appInfos.length !== 1) throw new Error('Exactly one editable App Info is required to set categories.');
  const appInfo = appInfos[0];
  const readCategory = async (relationship: 'primaryCategory' | 'secondaryCategory') => {
    try { return resources(await client.get(`/appInfos/${id(appInfo)}/${relationship}`))[0]?.id; }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
  };
  const categoryDifferences = async () => {
    const changed: Record<string, unknown> = {};
    if (await readCategory('primaryCategory') !== primary) changed.primaryCategory = { data: { type: 'appCategories', id: primary } };
    if (secondary && await readCategory('secondaryCategory') !== secondary) changed.secondaryCategory = { data: { type: 'appCategories', id: secondary } };
    return changed;
  };

  const builds = resources(await client.get(`/builds?filter[app]=${id(apps[0])}&filter[version]=${encodeURIComponent(buildNumber)}&filter[preReleaseVersion.version]=${encodeURIComponent(versionString)}&limit=10`))
    .filter(build => build.attributes?.processingState === 'VALID' && build.attributes?.expired !== true);
  if (builds.length !== 1) throw new Error(`Exactly one valid, unexpired build ${buildNumber} of version ${versionString} is required (found ${builds.length}). Upload it and wait for processing.`);
  const build = builds[0];
  const readSelectedBuild = async () => {
    try { return resources(await client.get(`/appStoreVersions/${id(version)}/build`))[0]?.id; }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
  };

  const changedVersion = versionDifferences(version);
  const changedCategories = await categoryDifferences();
  const buildAttached = await readSelectedBuild() === build.id;
  const operations: Operation[] = [
    { id: 'version.update', resource: 'App Store version', detail: Object.keys(changedVersion).join(', ') || 'copyright and release mode', status: Object.keys(changedVersion).length ? 'planned' : 'already-matches' },
    { id: 'categories.update', resource: 'App Info categories', detail: [primary, secondary].filter(Boolean).join(', '), status: Object.keys(changedCategories).length ? 'planned' : 'already-matches' },
    { id: 'build.attach', resource: 'Build', detail: `build ${buildNumber} of ${versionString}`, status: buildAttached ? 'already-matches' : 'planned' },
  ];
  if (!apply) return { mode: 'preview', version: versionString, operations, submitted: false };

  if (Object.keys(changedVersion).length) {
    await client.patch(`/appStoreVersions/${id(version)}`, { data: { type: 'appStoreVersions', id: version.id, attributes: changedVersion } });
    operations[0].status = 'applied';
  }
  if (Object.keys(changedCategories).length) {
    await client.patch(`/appInfos/${id(appInfo)}`, { data: { type: 'appInfos', id: appInfo.id, relationships: changedCategories } });
    operations[1].status = 'applied';
  }
  if (!buildAttached) {
    await client.patch(`/appStoreVersions/${id(version)}/relationships/build`, { data: { type: 'builds', id: build.id } });
    operations[2].status = 'applied';
  }

  if (Object.keys(versionDifferences(await readVersion())).length) throw new Error('Read-back verification failed for the version settings. Partial changes may have occurred.');
  if (Object.keys(await categoryDifferences()).length) throw new Error('Read-back verification failed for the categories. Partial changes may have occurred.');
  if (await readSelectedBuild() !== build.id) throw new Error('Read-back verification failed for the attached build. Partial changes may have occurred.');
  return { mode: 'apply', version: versionString, operations, submitted: false };
}
