import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultManifest } from '../src/manifest.js';
import { draftDescriptions } from '../src/asc-description-draft.js';

function fixture() {
  const manifest = defaultManifest({ name: 'Example', bundleId: 'com.example.app', version: '1.3' });
  manifest.app.appStoreAppId = 'app';
  manifest.app.releaseKind = 'update';
  manifest.app.locales = ['en-US', 'tr'];
  manifest.sync.mode = 'apply';
  manifest.metadata.localizations = {
    'en-US': { description: 'Daily study\n\n● Read', confirmation: 'confirmed' },
    tr: { description: 'Günlük çalışma\n\n● Oku', confirmation: 'confirmed' },
  };
  let target: any;
  let remote: any[] = [];
  const writes: Array<{path: string; body: any}> = [];
  const client = {
    async get(path: string) {
      if (path.startsWith('/apps?')) return { data: [{ id: 'app' }] };
      if (path === '/apps/app/appStoreVersions?limit=200') return { data: [
        { id: 'live', attributes: { platform: 'IOS', versionString: '1.2', appVersionState: 'READY_FOR_DISTRIBUTION' } },
        ...(target ? [target] : []),
      ] };
      if (path.endsWith('/appStoreVersionLocalizations?limit=200')) return { data: remote };
      if (path === '/appStoreVersions/draft') return { data: target };
      throw new Error(`Unexpected GET ${path}`);
    },
    async post(path: string, body: any) {
      writes.push({path, body});
      if (path === '/appStoreVersions') {
        target = { id: 'draft', attributes: { ...body.data.attributes, appVersionState: 'PREPARE_FOR_SUBMISSION' } };
        // Simulate Apple's copying existing live-version text.
        remote = [{ id: 'english', attributes: { locale: 'en-US', description: 'Old text', whatsNew: 'Keep me' } }];
        return { data: target };
      }
      assert.equal(path, '/appStoreVersionLocalizations');
      const item = { id: `locale-${remote.length}`, ...body.data };
      remote.push(item);
      return { data: item };
    },
    async patch(path: string, body: any) {
      writes.push({path, body});
      assert.deepEqual(Object.keys(body.data.attributes), ['description']);
      const item = remote.find(x => x.id === body.data.id);
      Object.assign(item.attributes, body.data.attributes);
      return { data: item };
    },
  };
  return { manifest, client, writes, setState(state: string) {
    target = { id: 'draft', attributes: { platform: 'IOS', versionString: '1.3', appVersionState: state } };
  } };
}

test('preview is read-only and does not require a build or release-note approval', async () => {
  const f = fixture();
  const result = await draftDescriptions(f.manifest, false, false, f.client);
  assert.equal(result.mode, 'preview');
  assert.equal(f.writes.length, 0);
  assert.equal(result.operations.length, 3);
});

test('creates only a draft and descriptions, reads back every locale, and is idempotent', async () => {
  const f = fixture();
  const first = await draftDescriptions(f.manifest, true, true, f.client);
  assert.equal(first.verifiedLocales, 2);
  assert.equal(first.submitted, false);
  assert.equal(f.writes.length, 3);
  const second = await draftDescriptions(f.manifest, true, true, f.client);
  assert.equal(f.writes.length, 3);
  assert.ok(second.operations.every(o => o.status === 'already-matches'));
});

test('updates descriptions after the developer cancels an App Review submission', async () => {
  const f = fixture();
  f.setState('DEVELOPER_REJECTED');
  const result = await draftDescriptions(f.manifest, true, true, f.client);
  assert.equal(result.verifiedLocales, 2);
  assert.equal(result.submitted, false);
});

test('rejects live versions, wrong identity, unapproved copy, and absent mutation gates', async () => {
  for (const state of ['READY_FOR_DISTRIBUTION', 'WAITING_FOR_REVIEW', 'IN_REVIEW']) {
    const f = fixture(); f.setState(state);
    await assert.rejects(draftDescriptions(f.manifest, true, true, f.client), /not an editable draft/);
    assert.equal(f.writes.length, 0);
  }
  const f = fixture();
  await assert.rejects(draftDescriptions(f.manifest, true, false, f.client), /require/);
  f.manifest.sync.mode = 'dry-run';
  await assert.rejects(draftDescriptions(f.manifest, true, true, f.client), /require/);
  f.manifest.app.appStoreAppId = 'wrong';
  await assert.rejects(draftDescriptions(f.manifest, false, false, f.client), /identity/);
  f.manifest.metadata.localizations.tr.confirmation = 'needs-human-confirmation';
  await assert.rejects(draftDescriptions(f.manifest, false, false, f.client), /confirmed description/);
  assert.equal(f.writes.length, 0);
});
