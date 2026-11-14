// Wrangler define is selected independently for each hosted Worker bundle. Node,
// self-hosted installations, and stages not yet switched retain the original names.
declare const NIGHTMAIL_AWS_NAMES: boolean;
export const TAG_PREFIX = typeof NIGHTMAIL_AWS_NAMES !== 'undefined' && NIGHTMAIL_AWS_NAMES ? 'nightmail' : 'bane';
export const mailKindTag = (bucket:string) => /^nightmail-\d{12}-mail-us-east-2$/.test(bucket) ? 'nightmail-kind' : 'bane-kind';
type Tag = { Key?: string; Value?: string };
export const tagKey = (name: 'owner' | 'installation-id' | 'purpose' | 'domain-claim') => `${TAG_PREFIX}:${name}`;
export const ownerTag = { Key: tagKey('owner'), Value: TAG_PREFIX };
const name = (key: string | undefined) => key?.match(/^(?:nightmail|bane):(.+)$/)?.[1] ?? key;
const same = (have: Tag, want: Tag) => name(have.Key) === name(want.Key)
  && (have.Value === want.Value || name(want.Key) === 'owner' && ['nightmail', 'bane'].includes(have.Value ?? '') && ['nightmail', 'bane'].includes(want.Value ?? ''));
/** Whether a resource carries every wanted tag, under either prefix. */
export const hasTags = (have: Tag[] | undefined, want: Tag[]) => want.every(w => have?.some(h => same(h, w)) ?? false);
