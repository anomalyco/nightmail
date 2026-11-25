// From api/: AWS_PROFILE=<operator> node --import tsx scripts/backfill-feedback-forwarding.ts --account <id> [--apply]
// Defaults to both hosted pool regions. For a connected account, use its operator profile and repeat --region for its regions.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { SESv2Client, ListEmailIdentitiesCommand, GetEmailIdentityCommand, PutEmailIdentityFeedbackAttributesCommand, type Tag } from '@aws-sdk/client-sesv2';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { paceSetupSes } from '../src/ses-setup.js';

function managed(tags: Tag[] = []) {
  const owners = tags.filter(t => t.Key === 'nightmail:owner' || t.Key === 'bane:owner');
  if (owners.length) return owners.every(t => t.Value === 'nightmail' || t.Value === 'bane');
  // The original hosted create path wrote only this claim tag; a purpose or installation tag alone isn't ownership.
  return tags.some(t => (t.Key === 'bane:domain-claim' || t.Key === 'nightmail:domain-claim')
    && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(t.Value ?? ''));
}
const empty = () => ({ listed: 0, managed: 0, on: 0, off: 0, disabled: 0, errors: 0 });
export async function backfillFeedbackForwarding(client: SESv2Client, apply = false, report = console.log) {
  const counts = empty(), seen = new Set<string>();
  let token: string | undefined;
  do {
    let page;
    try {
      page = await client.send(new ListEmailIdentitiesCommand({ NextToken: token, PageSize: 1000 }));
      if (!Array.isArray(page.EmailIdentities) || (page.NextToken && seen.has(page.NextToken))) throw Error('SES returned an incomplete or repeated identity list page');
    } catch (error) {
      counts.errors++;
      report(`Inventory incomplete: ${String(error)}`);
      break; // Keep counts (including completed writes) from earlier pages.
    }
    for (const { IdentityType, IdentityName } of page.EmailIdentities) {
      counts.listed++;
      if (IdentityType !== 'DOMAIN') continue; // Nightmail creates domain identities only.
      if (!IdentityName) { counts.errors++; report('Inventory incomplete: SES returned a domain without a name'); continue; }
      try {
        const identity = await client.send(new GetEmailIdentityCommand({ EmailIdentity: IdentityName }));
        if (!managed(identity.Tags)) continue;
        counts.managed++;
        if (typeof identity.FeedbackForwardingStatus !== 'boolean') throw Error('Missing FeedbackForwardingStatus');
        if (!identity.FeedbackForwardingStatus) { counts.off++; report(`${IdentityName}: off`); continue; }
        counts.on++;
        if (apply) {
          await client.send(new PutEmailIdentityFeedbackAttributesCommand({ EmailIdentity: IdentityName, EmailForwardingEnabled: false }));
          counts.disabled++;
        }
        report(`${IdentityName}: ${apply ? 'disabled' : 'on'}`);
      } catch (error) {
        counts.errors++;
        report(`${IdentityName}: ERROR ${error instanceof Error ? error.name + ': ' + error.message : 'unknown'}`);
      }
    }
    token = page.NextToken;
    if (token) seen.add(token);
  } while (token);
  return counts;
}

async function main() {
  const { values: { account, region, apply } } = parseArgs({ options: { account: { type: 'string' }, region: { type: 'string', multiple: true }, apply: { type: 'boolean', default: false } } });
  const regions = [...new Set(region ?? ['us-east-2', 'us-east-1'])];
  if (!account || !/^\d{12}$/.test(account) || regions.some(r => !/^[a-z]{2}(-[a-z]+)+-\d+$/.test(r))) throw Error('Specify --account <12-digit AWS account> and optionally repeat --region <region>');
  const sts = new STSClient({ region: regions[0], ignoreConfiguredEndpointUrls: true });
  try { if ((await sts.send(new GetCallerIdentityCommand({}))).Account !== account) throw Error('AWS profile does not match --account'); }
  finally { sts.destroy(); }
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} account=${account}`);
  const total = empty();
  for (const region of regions) {
    const client = new SESv2Client({ region, ignoreConfiguredEndpointUrls: true, maxAttempts: 1 });
    // Use setup's 1/s control-plane pace and throttling retries, without the online setup job's five-minute deadline.
    paceSetupSes(client, { signal: new AbortController().signal, lastSesFinished: -Infinity, queue: Promise.resolve() });
    try {
      const counts = await backfillFeedbackForwarding(client, apply, line => console.log(region, line));
      console.log(region, JSON.stringify(counts));
      for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += counts[key];
    } catch (error) { total.errors++; console.error(region, 'inventory incomplete:', error); }
    finally { client.destroy(); }
  }
  console.log('TOTAL', JSON.stringify(total));
  if (total.errors) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
