import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultManifest } from '../src/manifest.js';
import { draftListing } from '../src/asc-listing-draft.js';

function fixture() {
  const manifest = defaultManifest({ name: 'Example', bundleId: 'com.example.app', version: '1.3' });
  manifest.app.appStoreAppId = 'app';
  manifest.app.releaseKind = 'update';
  manifest.app.locales = ['en-US', 'tr'];
  manifest.sync.mode = 'apply';
  manifest.contacts.supportUrl = 'https://example.com/support';
  manifest.contacts.marketingUrl = 'https://example.com';
  manifest.metadata.localizations = {
    'en-US': {
      description: 'Daily study', promotionalText: 'Read and reflect', whatsNew: 'Refined reader',
      keywords: ['quran', 'study'], confirmation: 'confirmed',
    },
    tr: {
      description: 'Günlük çalışma', promotionalText: 'Oku ve düşün', whatsNew: 'Yenilenen okuyucu',
      confirmation: 'confirmed',
    },
  };
  let remote = [{ id: 'english', attributes: { locale: 'en-US', description: 'Old', promotionalText: 'Old', whatsNew: 'Old' } }];
  const writes: Array<{ path: string; body: any }> = [];
  const client = {
    async get(path: string) {
      if (path.startsWith('/apps?')) return { data: [{ id: 'app' }] };
      if (path === '/apps/app/appStoreVersions?limit=200') return { data: [{ id: 'draft', attributes: { platform: 'IOS', versionString: '1.3', appVersionState: 'PREPARE_FOR_SUBMISSION' } }] };
      if (path === '/appStoreVersions/draft/appStoreVersionLocalizations?limit=200') return { data: remote };
      if (path === '/appStoreVersions/draft') return { data: [{ id: 'draft', attributes: { appVersionState: 'PREPARE_FOR_SUBMISSION' } }] };
      throw new Error(`Unexpected GET ${path}`);
    },
    async patch(path: string, body: any) {
      writes.push({ path, body });
      remote = remote.map(item => item.id === body.data.id ? { ...item, attributes: { ...item.attributes, ...body.data.attributes } } : item);
      return { data: remote[0] };
    },
  };
  return { manifest, client, writes };
}

test('previews and applies only selected draft listing locales', async () => {
  const f = fixture();
  const preview = await draftListing(f.manifest, ['en-US'], false, false, f.client);
  assert.equal(preview.operations[0].status, 'planned');
  assert.equal(f.writes.length, 0);
  const applied = await draftListing(f.manifest, ['en-US'], true, true, f.client);
  assert.equal(applied.verifiedLocales, 1);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(Object.keys(f.writes[0].body.data.attributes).sort(), ['description', 'keywords', 'marketingUrl', 'promotionalText', 'supportUrl', 'whatsNew']);
});

test('rejects unconfigured locales and missing mutation gates', async () => {
  const f = fixture();
  await assert.rejects(draftListing(f.manifest, ['fr-FR'], false, false, f.client), /not configured/);
  await assert.rejects(draftListing(f.manifest, ['en-US'], true, false, f.client), /explicit confirmation/);
  assert.equal(f.writes.length, 0);
});
