import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultManifest } from '../src/manifest.js';
import { draftVersion } from '../src/asc-version-draft.js';

function fixture() {
  const manifest = defaultManifest({ name: 'Example', bundleId: 'com.example.app', version: '1.0' });
  manifest.app.appStoreAppId = 'app';
  manifest.app.build = '7';
  manifest.app.primaryCategory = 'Utilities';
  manifest.app.secondaryCategory = 'Food & Drink';
  manifest.app.releaseMode = 'manual';
  manifest.contacts.copyright = '2026 Example B.V.';
  manifest.sync.mode = 'apply';
  const remote = { version: { copyright: null as string | null, releaseType: 'AFTER_APPROVAL' }, primary: undefined as string | undefined, secondary: undefined as string | undefined, build: undefined as string | undefined };
  let state = 'PREPARE_FOR_SUBMISSION';
  let builds: any[] = [{ id: 'build-7', attributes: { version: '7', processingState: 'VALID', expired: false } }];
  const writes: Array<{ path: string; body: any }> = [];
  const one = (value: string | undefined) => { if (!value) throw new Error('GET -> 404 NOT_FOUND'); return { data: { id: value } }; };
  const client = {
    async get(path: string) {
      if (path.startsWith('/apps?')) return { data: [{ id: 'app' }] };
      if (path === '/apps/app/appStoreVersions?limit=200') return { data: [{ id: 'draft', attributes: { platform: 'IOS', versionString: '1.0', appVersionState: state, ...remote.version } }] };
      if (path === '/apps/app/appInfos?limit=200') return { data: [{ id: 'live', attributes: { state: 'READY_FOR_DISTRIBUTION' } }, { id: 'info', attributes: { state: 'PREPARE_FOR_SUBMISSION' } }] };
      if (path === '/appInfos/info/primaryCategory') return one(remote.primary);
      if (path === '/appInfos/info/secondaryCategory') return one(remote.secondary);
      if (path.startsWith('/builds?')) { assert.match(path, /filter\[version\]=7/); assert.match(path, /preReleaseVersion\.version\]=1\.0/); return { data: builds }; }
      if (path === '/appStoreVersions/draft/build') return one(remote.build);
      throw new Error(`Unexpected GET ${path}`);
    },
    async patch(path: string, body: any) {
      writes.push({ path, body });
      if (path === '/appStoreVersions/draft') Object.assign(remote.version, body.data.attributes);
      if (path === '/appInfos/info') { remote.primary = body.data.relationships.primaryCategory?.data.id ?? remote.primary; remote.secondary = body.data.relationships.secondaryCategory?.data.id ?? remote.secondary; }
      if (path === '/appStoreVersions/draft/relationships/build') remote.build = body.data.id;
      return { data: {} };
    },
  };
  return { manifest, client, writes, remote, setState(value: string) { state = value; }, setBuilds(value: any[]) { builds = value; } };
}

test('previews, then sets release settings, categories and the build, and is idempotent', async () => {
  const f = fixture();
  const preview = await draftVersion(f.manifest, false, false, f.client);
  assert.deepEqual(preview.operations.map(operation => operation.status), ['planned', 'planned', 'planned']);
  assert.equal(f.writes.length, 0);
  await draftVersion(f.manifest, true, true, f.client);
  assert.deepEqual(f.remote, { version: { copyright: '2026 Example B.V.', releaseType: 'MANUAL' }, primary: 'UTILITIES', secondary: 'FOOD_AND_DRINK', build: 'build-7' });
  const again = await draftVersion(f.manifest, true, true, f.client);
  assert.deepEqual(again.operations.map(operation => operation.status), ['already-matches', 'already-matches', 'already-matches']);
  assert.equal(f.writes.length, 3);
});

test('needs both gates, an editable draft, and exactly one valid build', async () => {
  const f = fixture();
  await assert.rejects(draftVersion(f.manifest, true, false, f.client), /explicit confirmation/);
  f.setBuilds([{ id: 'processing', attributes: { version: '7', processingState: 'PROCESSING', expired: false } }]);
  await assert.rejects(draftVersion(f.manifest, false, false, f.client), /Exactly one valid, unexpired build/);
  f.setBuilds([{ id: 'expired', attributes: { version: '7', processingState: 'VALID', expired: true } }]);
  await assert.rejects(draftVersion(f.manifest, false, false, f.client), /found 0/);
  f.setState('WAITING_FOR_REVIEW');
  await assert.rejects(draftVersion(f.manifest, false, false, f.client), /not an editable draft/);
  assert.equal(f.writes.length, 0);
});
