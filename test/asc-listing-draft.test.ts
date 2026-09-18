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
  let state = 'PREPARE_FOR_SUBMISSION';
  let appInfoState = 'PREPARE_FOR_SUBMISSION';
  let appInfoRemote = [{ id: 'info-english', attributes: { locale: 'en-US', name: 'Example', subtitle: 'Old subtitle' } }];
  const writes: Array<{ path: string; body: any }> = [];
  const client = {
    async get(path: string) {
      if (path.startsWith('/apps?')) return { data: [{ id: 'app' }] };
      if (path === '/apps/app/appStoreVersions?limit=200') return { data: [{ id: 'draft', attributes: { platform: 'IOS', versionString: '1.3', appVersionState: state } }] };
      if (path === '/appStoreVersions/draft/appStoreVersionLocalizations?limit=200') return { data: remote };
      if (path === '/apps/app/appInfos?limit=200') return { data: [{ id: 'live', attributes: { state: 'READY_FOR_DISTRIBUTION' } }, { id: 'info', attributes: { state: appInfoState } }] };
      if (path === '/appInfos/info/appInfoLocalizations?limit=200') return { data: appInfoRemote };
      if (path === '/appStoreVersions/draft') return { data: [{ id: 'draft', attributes: { appVersionState: state } }] };
      throw new Error(`Unexpected GET ${path}`);
    },
    async patch(path: string, body: any) {
      writes.push({ path, body });
      appInfoRemote = appInfoRemote.map(item => item.id === body.data.id ? { ...item, attributes: { ...item.attributes, ...body.data.attributes } } : item);
      remote = remote.map(item => item.id === body.data.id ? { ...item, attributes: { ...item.attributes, ...body.data.attributes } } : item);
      return { data: remote[0] };
    },
  };
  return { manifest, client, writes, setState(value: string) { state = value; }, setAppInfoState(value: string) { appInfoState = value; } };
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

test('updates listing fields after the developer cancels an App Review submission', async () => {
  const f = fixture();
  f.setState('DEVELOPER_REJECTED');
  const result = await draftListing(f.manifest, ['en-US'], true, true, f.client);
  assert.equal(result.verifiedLocales, 1);
});

test('rejects unconfigured locales and missing mutation gates', async () => {
  const f = fixture();
  await assert.rejects(draftListing(f.manifest, ['fr-FR'], false, false, f.client), /not configured/);
  await assert.rejects(draftListing(f.manifest, ['en-US'], true, false, f.client), /explicit confirmation/);
  assert.equal(f.writes.length, 0);
});

test('syncs declared name and subtitle to the editable App Info localization only', async () => {
  const f = fixture();
  f.manifest.metadata.localizations['en-US'].name = 'Example';
  f.manifest.metadata.localizations['en-US'].subtitle = 'New subtitle';
  const preview = await draftListing(f.manifest, ['en-US'], false, false, f.client);
  assert.deepEqual(preview.operations[0].appInfoFields, ['subtitle']);
  assert.equal(preview.operations[0].appInfoStatus, 'planned');
  assert.equal(f.writes.length, 0);
  const applied = await draftListing(f.manifest, ['en-US'], true, true, f.client);
  assert.equal(applied.operations[0].appInfoStatus, 'applied');
  const appInfoWrite = f.writes.find(write => write.path === '/appInfoLocalizations/info-english');
  assert.deepEqual(appInfoWrite?.body.data.attributes, { subtitle: 'New subtitle' });
  assert.equal(appInfoWrite?.body.data.type, 'appInfoLocalizations');
});

test('leaves App Info alone when none is editable or the locale has no localization', async () => {
  const f = fixture();
  f.manifest.metadata.localizations['en-US'].subtitle = 'New subtitle';
  f.setAppInfoState('READY_FOR_DISTRIBUTION');
  const locked = await draftListing(f.manifest, ['en-US'], true, true, f.client);
  assert.equal(locked.operations[0].appInfoStatus, 'not-editable');
  assert.ok(f.writes.every(write => !write.path.startsWith('/appInfoLocalizations/')));
  const g = fixture();
  g.manifest.metadata.localizations.tr.subtitle = 'Yeni';
  const preview = await draftListing(g.manifest, ['tr'], false, false, g.client).catch(error => error);
  // tr has no version localization in the fixture, so the existing guard still rejects it first.
  assert.ok(preview instanceof Error);
});
