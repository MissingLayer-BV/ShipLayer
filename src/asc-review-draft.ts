import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { AppStoreConnectClient, credentialsFromEnvironment, dataOf, isEditableAppVersionState, type AscResource } from './asc.js';
import { resolveContained } from './fs.js';
import type { ShipLayerManifest } from './types.js';

type Client = Pick<AppStoreConnectClient, 'get' | 'post' | 'patch' | 'delete' | 'uploadAsset'>;
type Operation = { id: string; resource: string; fields: string[]; status: 'planned' | 'already-matches' | 'applied' };
type ReviewedProduct = { productId: string; reviewNotes: string; reviewScreenshot: string };
type RemoteProduct = { kind: 'subscription' | 'in-app-purchase'; resource: AscResource };

const resources = (value: unknown) => dataOf(value) as AscResource[];
const id = (resource: AscResource): string => {
  if (!resource.id) throw new Error('Apple returned a resource without an ID.');
  return encodeURIComponent(resource.id);
};
const V2 = 'https://api.appstoreconnect.apple.com/v2';

function desiredReviewDetails(manifest: ShipLayerManifest): Record<string, unknown> {
  const contact = manifest.review.contact;
  if (!contact?.firstName?.trim() || !contact.lastName?.trim() || !contact.email?.trim() || !contact.phone?.trim()) {
    throw new Error('review.contact needs firstName, lastName, email, and phone.');
  }
  if (!manifest.review.notes?.trim()) throw new Error('review.notes is required.');
  if (manifest.review.demoAccount?.required) throw new Error('A required demo account carries credentials; use the fully gated apply instead.');
  return {
    contactFirstName: contact.firstName, contactLastName: contact.lastName, contactEmail: contact.email,
    contactPhone: contact.phone, demoAccountRequired: false, notes: manifest.review.notes,
  };
}

function reviewedProducts(manifest: ShipLayerManifest): ReviewedProduct[] {
  const money = manifest.monetization;
  if (money.type !== 'subscriptions' && money.type !== 'non-consumables') return [];
  return [...money.products, ...(money.consumables ?? [])].map(({ productId, reviewNotes, reviewScreenshot }) => ({ productId, reviewNotes, reviewScreenshot }));
}

async function readScreenshot(repository: string, relativePath: string) {
  const filePath = await resolveContained(repository, relativePath, 'review screenshot');
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink() || details.size > 50 * 1024 * 1024) throw new Error(`Review screenshot ${relativePath} is not a safe bounded regular file.`);
  const bytes = await readFile(filePath);
  return { fileName: relativePath.split('/').pop()!, bytes, checksum: createHash('md5').update(bytes).digest('hex') };
}

/** Synchronize what App Review reads but the store never shows: the review
 * contact and notes of an existing editable draft, and the private review
 * note and review screenshot of each declared subscription or in-app
 * purchase. Products, prices, builds, and submission state are not changed. */
export async function draftReview(
  manifest: ShipLayerManifest,
  repository: string,
  apply = false,
  confirmed = false,
  suppliedClient?: Client,
  readBackDelayMs = 1500,
) {
  if (apply && (!confirmed || manifest.sync.mode !== 'apply')) throw new Error('Draft review writes require sync.mode: apply and explicit confirmation.');
  if (!manifest.app.appStoreAppId || !manifest.app.bundleId || !manifest.app.version) throw new Error('Explicit app identity and target version are required.');
  const desiredDetails = desiredReviewDetails(manifest);
  const products = await Promise.all(reviewedProducts(manifest).map(async product => ({ ...product, screenshot: await readScreenshot(repository, product.reviewScreenshot) })));

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
  const state = version.attributes?.appVersionState ?? version.attributes?.appStoreState;
  if (!isEditableAppVersionState(state)) throw new Error(`Version ${manifest.app.version} is not an editable draft (${state}).`);

  const readDetails = async () => resources(await client.get(`/appStoreVersions/${id(version)}/appStoreReviewDetail`))[0];
  const detailDifferences = (existing: AscResource | undefined) =>
    Object.fromEntries(Object.entries(desiredDetails).filter(([key, value]) => (existing?.attributes?.[key] ?? null) !== value));

  const remoteProducts = new Map<string, RemoteProduct>();
  if (products.length) {
    for (const group of resources(await client.get(`/apps/${id(apps[0])}/subscriptionGroups?limit=200`))) {
      for (const subscription of resources(await client.get(`/subscriptionGroups/${id(group)}/subscriptions?limit=200`))) {
        remoteProducts.set(String(subscription.attributes?.productId), { kind: 'subscription', resource: subscription });
      }
    }
    for (const purchase of resources(await client.get(`/apps/${id(apps[0])}/inAppPurchasesV2?limit=200`))) {
      remoteProducts.set(String(purchase.attributes?.productId), { kind: 'in-app-purchase', resource: purchase });
    }
  }
  const remoteFor = (productId: string) => {
    const remote = remoteProducts.get(productId);
    if (!remote) throw new Error(`Product ${productId} does not exist in App Store Connect; create it there first.`);
    return remote;
  };
  const screenshotPath = (remote: RemoteProduct) => remote.kind === 'subscription'
    ? `/subscriptions/${id(remote.resource)}/appStoreReviewScreenshot`
    : `${V2}/inAppPurchases/${id(remote.resource)}/appStoreReviewScreenshot`;
  const readReviewScreenshot = async (remote: RemoteProduct): Promise<AscResource | undefined> => {
    try { return resources(await client.get(screenshotPath(remote)))[0]; }
    catch (error) { if (/\b404\b|NOT_FOUND/i.test(String((error as Error)?.message ?? error))) return undefined; throw error; }
  };
  const productDifferences = async (product: (typeof products)[number]) => {
    const remote = remoteFor(product.productId);
    const fields: string[] = [];
    if ((remote.resource.attributes?.reviewNote ?? '') !== product.reviewNotes) fields.push('reviewNote');
    const existing = await readReviewScreenshot(remote);
    const current = existing && String(existing.attributes?.sourceFileChecksum ?? '').toLowerCase() === product.screenshot.checksum
      && String((existing.attributes?.assetDeliveryState as { state?: string } | undefined)?.state ?? 'COMPLETE') !== 'FAILED';
    if (!current) fields.push('reviewScreenshot');
    return { remote, fields, existing };
  };

  const operations: Operation[] = [];
  const existingDetails = await readDetails();
  const changedDetails = detailDifferences(existingDetails);
  operations.push({ id: 'review-details', resource: 'App Review details', fields: Object.keys(changedDetails), status: Object.keys(changedDetails).length ? 'planned' : 'already-matches' });
  const productPlans = [];
  for (const product of products) {
    const plan = await productDifferences(product);
    productPlans.push({ product, ...plan });
    operations.push({ id: `product-review.${product.productId}`, resource: `Review material for ${product.productId}`, fields: plan.fields, status: plan.fields.length ? 'planned' : 'already-matches' });
  }
  if (!apply) return { mode: 'preview', version: manifest.app.version, operations, submitted: false };

  if (Object.keys(changedDetails).length) {
    if (!existingDetails) await client.post('/appStoreReviewDetails', { data: { type: 'appStoreReviewDetails', attributes: desiredDetails, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } } } });
    else await client.patch(`/appStoreReviewDetails/${id(existingDetails)}`, { data: { type: 'appStoreReviewDetails', id: existingDetails.id, attributes: changedDetails } });
    operations[0].status = 'applied';
  }
  for (const [index, { product, remote, fields, existing }] of productPlans.entries()) {
    if (!fields.length) continue;
    const subscription = remote.kind === 'subscription';
    if (fields.includes('reviewNote')) {
      await client.patch(subscription ? `/subscriptions/${id(remote.resource)}` : `${V2}/inAppPurchases/${id(remote.resource)}`, {
        data: { type: subscription ? 'subscriptions' : 'inAppPurchases', id: remote.resource.id, attributes: { reviewNote: product.reviewNotes } },
      });
    }
    if (fields.includes('reviewScreenshot')) {
      const type = subscription ? 'subscriptionAppStoreReviewScreenshots' : 'inAppPurchaseAppStoreReviewScreenshots';
      if (existing) await client.delete(`/${type}/${id(existing)}`);
      const reservation = resources(await client.post(`/${type}`, {
        data: {
          type, attributes: { fileName: product.screenshot.fileName, fileSize: product.screenshot.bytes.length },
          relationships: subscription
            ? { subscription: { data: { type: 'subscriptions', id: remote.resource.id } } }
            : { inAppPurchaseV2: { data: { type: 'inAppPurchases', id: remote.resource.id } } },
        },
      }))[0];
      if (!reservation?.id) throw new Error(`Apple returned no reservation for the ${product.productId} review screenshot. Partial changes may have occurred.`);
      await client.uploadAsset(reservation.attributes?.uploadOperations, product.screenshot.bytes);
      await client.patch(`/${type}/${id(reservation)}`, { data: { type, id: reservation.id, attributes: { uploaded: true, sourceFileChecksum: product.screenshot.checksum } } });
    }
    operations[index + 1].status = 'applied';
  }

  // Read everything back. Apple reports a committed upload's checksum only once
  // it has processed the asset, which can take a few seconds.
  if (Object.keys(detailDifferences(await readDetails())).length) throw new Error('Read-back verification failed for App Review details. Partial changes may have occurred.');
  for (const { product, remote } of productPlans) {
    let screenshot = await readReviewScreenshot(remote);
    for (let attempt = 0; attempt < 40 && String(screenshot?.attributes?.sourceFileChecksum ?? '').toLowerCase() !== product.screenshot.checksum; attempt++) {
      await new Promise(resolve => setTimeout(resolve, readBackDelayMs));
      screenshot = await readReviewScreenshot(remote);
    }
    if (String(screenshot?.attributes?.sourceFileChecksum ?? '').toLowerCase() !== product.screenshot.checksum) {
      throw new Error(`Read-back verification failed for the ${product.productId} review screenshot. Partial changes may have occurred.`);
    }
  }
  return { mode: 'apply', version: manifest.app.version, operations, verifiedProducts: products.length, submitted: false };
}
