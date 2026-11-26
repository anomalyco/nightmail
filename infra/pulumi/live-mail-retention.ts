import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as cf from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';

const day = 86400;
const expire = (id: string, prefix: string, days: number) => ({
  id, enabled: true, conditions: { prefix }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: days * day } },
});
const abort = (days: number) => ({
  id: `abort-multipart-${days}d`, enabled: true, conditions: { prefix: '' }, abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: days * day } },
});
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

// R2 writes the whole ruleset in one PUT. Pin the four migration rules' identities, keys and
// deadlines (rounded UP to the provider's whole-second precision, never earlier) without
// publishing customer object keys in Git. Refuse a different inventory before replacing it.
export function liveMailRules(live: cf.GetR2BucketLifecycleResult['rules']) {
  const safeDate = (date: string) => new Date(Math.ceil(Date.parse(date) / 1000) * 1000).toISOString();
  const copies = live.filter(r => r.id.startsWith('nm-copy-expiry-')).sort(byId).map(r => {
    const date = r.deleteObjectsTransition?.condition?.date;
    const exact = { id: r.id, enabled: true, conditions: { prefix: r.conditions.prefix }, deleteObjectsTransition: { condition: { type: 'Date', date } } };
    if (!date || !isDeepStrictEqual(r, exact)) throw new Error('Unexpected action on a production copied-mail expiry rule.');
    exact.deleteObjectsTransition.condition.date = safeDate(date);
    return exact;
  });
  const fingerprint = copies.map(r => [r.id, r.conditions.prefix, r.deleteObjectsTransition.condition.date]);
  if (createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex') !== '53e8f2faae595a9afa44a0d1672075e68e746e0e33545df6d514c9b3d5912bf4') {
    throw new Error('Production copied-mail expiry rules changed; review the live lifecycle before updating it.');
  }
  const standard = live.filter(r => !r.id.startsWith('nm-copy-expiry-')).sort(byId);
  const ephemeral = expire('ephemeral-safety-45d', 'e/', 45);
  const previous = [expire('default-raw-90d', 'd/', 90), ephemeral, abort(1)].sort(byId);
  const desired = [expire('default-raw-91d', 'd/', 91), ephemeral, abort(3)].sort(byId);
  if (!isDeepStrictEqual(standard, previous) && !isDeepStrictEqual(standard, desired)) {
    throw new Error('Unexpected production mail lifecycle rules; do not overwrite them.');
  }
  // d/: raw download closes at 90 days. e/: at most a 30-day lease + 7 days' grace.
  // a/ attachments and k/ persistent mail have no age deadline. Aborts affect only unfinished uploads.
  return [...desired, ...copies];
}

export function productionMailLifecycle(accountId: string, bucketName: pulumi.Input<string>, provider: cf.Provider) {
  const scope = { accountId, bucketName };
  // getR2BucketLifecycle drops fractional seconds. Read the actual deadlines before rounding,
  // including on subsequent previews, so an operator's extension can never be rounded down.
  const rules = pulumi.output(bucketName).apply(async name => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${name}/lifecycle`,
      { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Cannot verify the existing mail lifecycle: HTTP ${res.status}`);
    const data = await res.json() as { success: boolean; result: cf.GetR2BucketLifecycleResult };
    if (!data.success || !Array.isArray(data.result?.rules)) throw new Error('Incomplete mail lifecycle response');
    return liveMailRules(data.result.rules);
  });
  return new cf.R2BucketLifecycle('nightmail-mail-lifecycle', { ...scope, jurisdiction: 'default', rules: pulumi.secret(rules) },
    { provider, protect: true });
}
