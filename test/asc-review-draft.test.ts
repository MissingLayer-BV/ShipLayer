import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultManifest } from '../src/manifest.js';
import { draftReview } from '../src/asc-review-draft.js';

const image = Buffer.from('not-a-real-png-but-bytes-are-enough');
const checksum = createHash('md5').update(image).digest('hex');

async function fixture() {
  const repository = await mkdtemp(join(tmpdir(), 'shiplayer-review-'));
  await mkdir(join(repository, 'review'));
  await writeFile(join(repository, 'review/plans.png'), image);
  const manifest = defaultManifest({ name: 'Example', bundleId: 'com.example.app', version: '1.0' });
  manifest.app.appStoreAppId = 'app';
  manifest.sync.mode = 'apply';
  manifest.review = { contact: { firstName: 'Ada', lastName: 'Reviewer', email: 'ada@example.com', phone: '+12025550123' }, demoAccount: { required: false }, notes: 'Sign in, then open Plans.', recordingScenarios: [] };
  const product = { productId: 'com.example.monthly', reviewNotes: 'Open Plans.', reviewScreenshot: 'review/plans.png' };
  manifest.monetization = {
    type: 'subscriptions', products: [product], consumables: [{ productId: 'com.example.pack', referenceName: 'Pack', reviewNotes: 'Open Plans, pick the pack.', reviewScreenshot: 'review/plans.png' }],
  } as unknown as typeof manifest.monetization;

  let state = 'PREPARE_FOR_SUBMISSION';
  let details: any;
  const subscription: any = { id: 'sub', attributes: { productId: 'com.example.monthly', reviewNote: null } };
  const purchase: any = { id: 'iap', attributes: { productId: 'com.example.pack', reviewNote: 'Open Plans, pick the pack.' } };
  const screenshots = new Map<string, any>();
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let pendingChecksumReads = 0;
  const notFound = () => { throw new Error('GET -> 404 NOT_FOUND'); };
  const client = {
    async get(path: string) {
      if (path.startsWith('/apps?')) return { data: [{ id: 'app' }] };
      if (path === '/apps/app/appStoreVersions?limit=200') return { data: [{ id: 'draft', attributes: { platform: 'IOS', versionString: '1.0', appVersionState: state } }] };
      if (path === '/appStoreVersions/draft/appStoreReviewDetail') return { data: details ?? [] };
      if (path === '/apps/app/subscriptionGroups?limit=200') return { data: [{ id: 'group' }] };
      if (path === '/subscriptionGroups/group/subscriptions?limit=200') return { data: [subscription] };
      if (path === '/apps/app/inAppPurchasesV2?limit=200') return { data: [purchase] };
      if (path === '/subscriptions/sub/appStoreReviewScreenshot') return screenshots.has('sub') ? { data: screenshots.get('sub') } : notFound();
      if (path.endsWith('/v2/inAppPurchases/iap/appStoreReviewScreenshot')) {
        if (!screenshots.has('iap')) return notFound();
        const resource = screenshots.get('iap');
        // Apple withholds the checksum while it is still processing the upload.
        if (resource.attributes.uploaded && pendingChecksumReads-- > 0) return { data: { ...resource, attributes: { ...resource.attributes, sourceFileChecksum: null } } };
        return { data: resource };
      }
      throw new Error(`Unexpected GET ${path}`);
    },
    async post(path: string, body: any) {
      calls.push({ method: 'POST', path, body });
      if (path === '/appStoreReviewDetails') { details = { id: 'details', attributes: body.data.attributes }; return { data: details }; }
      const owner = body.data.relationships.subscription ? 'sub' : 'iap';
      const resource = { id: `shot-${owner}`, attributes: { ...body.data.attributes, uploadOperations: [{ owner }] } };
      screenshots.set(owner, resource);
      return { data: resource };
    },
    async patch(path: string, body: any) {
      calls.push({ method: 'PATCH', path, body });
      if (path === '/subscriptions/sub') subscription.attributes.reviewNote = body.data.attributes.reviewNote;
      for (const resource of screenshots.values()) if (path.endsWith(`/${resource.id}`)) Object.assign(resource.attributes, body.data.attributes);
      if (path === '/appStoreReviewDetails/details') Object.assign(details.attributes, body.data.attributes);
      return { data: {} };
    },
    async delete(path: string) { calls.push({ method: 'DELETE', path }); },
    async uploadAsset(operations: unknown, bytes: Buffer) { calls.push({ method: 'UPLOAD', path: JSON.stringify(operations), body: bytes.length }); },
  };
  return { repository, manifest, client, calls, screenshots, delayChecksum(reads: number) { pendingChecksumReads = reads; }, setState(value: string) { state = value; }, seedScreenshot(owner: string, sum: string) { screenshots.set(owner, { id: `old-${owner}`, attributes: { sourceFileChecksum: sum } }); } };
}

test('previews without writing, then creates review details, notes and both review screenshots', async () => {
  const f = await fixture();
  const preview = await draftReview(f.manifest, f.repository, false, false, f.client);
  assert.deepEqual(preview.operations.map(operation => operation.status), ['planned', 'planned', 'planned']);
  assert.deepEqual(preview.operations[1].fields, ['reviewNote', 'reviewScreenshot']);
  assert.deepEqual(preview.operations[2].fields, ['reviewScreenshot']);
  assert.equal(f.calls.length, 0);

  const applied = await draftReview(f.manifest, f.repository, true, true, f.client);
  assert.equal(applied.verifiedProducts, 2);
  assert.ok(f.calls.some(call => call.method === 'POST' && call.path === '/appStoreReviewDetails' && call.body.data.attributes.contactPhone === '+12025550123'));
  assert.ok(f.calls.some(call => call.method === 'POST' && call.path === '/subscriptionAppStoreReviewScreenshots'));
  const purchaseReservation = f.calls.find(call => call.method === 'POST' && call.path === '/inAppPurchaseAppStoreReviewScreenshots');
  assert.equal(purchaseReservation?.body.data.relationships.inAppPurchaseV2.data.id, 'iap');
  assert.equal(f.calls.filter(call => call.method === 'UPLOAD').length, 2);
  assert.ok(f.calls.some(call => call.method === 'PATCH' && call.body?.data.attributes.sourceFileChecksum === checksum));

  const again = await draftReview(f.manifest, f.repository, false, false, f.client);
  assert.deepEqual(again.operations.map(operation => operation.status), ['already-matches', 'already-matches', 'already-matches']);
});

test('replaces a stale review screenshot and keeps a current one', async () => {
  const f = await fixture();
  f.seedScreenshot('sub', 'stale');
  f.seedScreenshot('iap', checksum);
  await draftReview(f.manifest, f.repository, true, true, f.client);
  assert.ok(f.calls.some(call => call.method === 'DELETE' && call.path === '/subscriptionAppStoreReviewScreenshots/old-sub'));
  assert.ok(!f.calls.some(call => call.path === '/inAppPurchaseAppStoreReviewScreenshots'));
});

test('refuses writes without both gates, on a locked version, and with demo credentials', async () => {
  const f = await fixture();
  await assert.rejects(draftReview(f.manifest, f.repository, true, false, f.client), /explicit confirmation/);
  f.manifest.sync.mode = 'dry-run';
  await assert.rejects(draftReview(f.manifest, f.repository, true, true, f.client), /sync.mode: apply/);
  f.manifest.sync.mode = 'apply';
  f.setState('READY_FOR_DISTRIBUTION');
  await assert.rejects(draftReview(f.manifest, f.repository, true, true, f.client), /not an editable draft/);
  f.setState('PREPARE_FOR_SUBMISSION');
  f.manifest.review.demoAccount = { required: true };
  await assert.rejects(draftReview(f.manifest, f.repository, false, false, f.client), /fully gated apply/);
  assert.equal(f.calls.length, 0);
});

test('waits for Apple to finish processing an upload before verifying it', async () => {
  const f = await fixture();
  f.delayChecksum(3);
  const applied = await draftReview(f.manifest, f.repository, true, true, f.client, 0);
  assert.equal(applied.verifiedProducts, 2);
});
