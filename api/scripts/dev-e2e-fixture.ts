// Only dev's named, verified E2E workspace is first-party: its live marketing must not wait for the outside
// customer share (100 of 200 recipients in the Ohio SES sandbox). Keep a finite operator daily cap of at least
// 100,000 for this fixture. SES's own daily quota, transactional reserve and sending rate still apply.
// One atomic, audited transition. Never lower a larger override or change an already exempt workspace.
//   STAGE=dev PUBLIC_URL=https://dev.nightmail.dev NIGHTMAIL_E2E_DOMAIN_ID=dom_... DATABASE_URL=... node --import tsx scripts/dev-e2e-fixture.ts
import type { Client } from 'pg';
import { log } from '../src/core.js';

export const DEV_E2E_SEND_CAP = 100_000;
const FIXTURE_DOMAINS = ['e2e.bane.mx', 'e2e-va.bane.mx'];
const reason = 'First-party dev E2E fixture on the shared SES sandbox (scripts/dev-e2e-fixture.ts)';

export async function applyDevE2eFixture(db: Pick<Client, 'query'>, env: Record<string, string | undefined>) {
  if (env.STAGE !== 'dev' || !['https://dev.nightmail.dev', 'https://dev.bane.mx'].includes(env.PUBLIC_URL ?? '')) throw new Error('The dev E2E fixture capacity applies only to dev (STAGE=dev, PUBLIC_URL=https://dev.nightmail.dev).');
  const domainId = env.NIGHTMAIL_E2E_DOMAIN_ID ?? env.BANE_E2E_DOMAIN_ID;
  if (!domainId || !/^dom_[0-9a-f]{32}$/.test(domainId)) throw new Error('NIGHTMAIL_E2E_DOMAIN_ID must name the fixture domain.');
  // The workspace the live E2E requires (prepare()): named E2E, owning the fixture domain, with a shared Hosted
  // connection and both fixture claims verified.
  const { rows } = await db.query<{ id: string; exempt: boolean; current: number | null; details: Record<string, unknown> | null }>(`
    WITH fixture AS (
      SELECT w.id, w.exempt_hosted_quotas, w.send_cap_override FROM workspaces w
      JOIN operation_domains d ON d.workspace_id = w.id AND d.id = $1 AND d.name = $2
      WHERE w.name = 'E2E'
        AND EXISTS (SELECT FROM provider_connections c WHERE c.workspace_id = w.id AND c.kind = 'shared')
        AND (SELECT count(*) FROM domain_claims c WHERE c.workspace_id = w.id AND c.name = ANY($3) AND c.sending_state = 'verified') = cardinality($3::text[])
      FOR UPDATE OF w
    ), changed AS (
      UPDATE workspaces w SET exempt_hosted_quotas = true, send_cap_override = greatest(f.send_cap_override, $4::int) FROM fixture f
      WHERE w.id = f.id AND NOT f.exempt_hosted_quotas
      RETURNING w.id, f.send_cap_override AS old, w.send_cap_override AS new_cap
    ), audit AS (
      INSERT INTO hosted_operator_audit (workspace_id, action, details)
      SELECT id, 'set-dev-e2e-fixture-policy', jsonb_build_object('old', old, 'new', new_cap, 'exemptBefore', false, 'exemptAfter', true, 'reason', $5::text) FROM changed
      RETURNING details
    )
    SELECT f.id, f.exempt_hosted_quotas AS exempt, f.send_cap_override AS current, (SELECT details FROM audit) AS details FROM fixture f`,
    [domainId, FIXTURE_DOMAINS[0], FIXTURE_DOMAINS, DEV_E2E_SEND_CAP, reason]);
  if (rows.length !== 1) throw new Error('No unique E2E fixture workspace owns the fixture domain with both fixture claims verified; nothing changed.');
  const [row] = rows;
  log('info', row!.details ? { code: 'DEV_E2E_FIXTURE_CAPACITY_SET', workspaceId: row!.id, ...row!.details } : { code: 'DEV_E2E_FIXTURE_CAPACITY_UNCHANGED', workspaceId: row!.id, exempt: row!.exempt, sendCapOverride: row!.current });
  return { workspaceId: row!.id, changed: !!row!.details };
}

/** One read per region before the first send. Use the deployment's existing dev role with a
 * GetAccount-only session policy; the GitHub job itself runs in a different AWS account. */
export async function devSandboxSendPreflight() {
  if (process.env.STAGE !== 'dev' || !['https://dev.nightmail.dev', 'https://dev.bane.mx'].includes(process.env.PUBLIC_URL ?? '')) throw new Error('SES preflight requires the verified dev deployment.');
  const [{ STSClient, AssumeRoleCommand }, { SESv2Client, GetAccountCommand }] = await Promise.all([import('@aws-sdk/client-sts'), import('@aws-sdk/client-sesv2')]);
  const sts = new STSClient({ region: 'us-east-1' });
  try {
    const { Credentials: c } = await sts.send(new AssumeRoleCommand({
      RoleArn: 'arn:aws:iam::905840579680:role/nightmail-deploy', RoleSessionName: 'nightmail-dev-e2e-quota', DurationSeconds: 900,
      Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'ses:GetAccount', Resource: '*', Condition: { StringEquals: { 'aws:RequestedRegion': ['us-east-1','us-east-2'] } } }] }),
    }));
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error('No dev quota reader credentials.');
    const credentials = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
    // Ohio: bounce, complaint, campaign recipient and two inbox legs. Virginia: one draft test.
    return await Promise.all(([['us-east-2', 5], ['us-east-1', 1]] as const).map(async ([region, needed]) => {
      const ses = new SESv2Client({ region, credentials });
      try {
        const a = await ses.send(new GetAccountCommand({})), max = a.SendQuota?.Max24HourSend, used = a.SendQuota?.SentLast24Hours;
        if (a.SendingEnabled !== true || typeof a.ProductionAccessEnabled !== 'boolean' || !(a.SendQuota?.MaxSendRate && a.SendQuota.MaxSendRate > 0) ||
          max === undefined || used === undefined || !Number.isFinite(max) || !Number.isFinite(used) || used < 0 || (max <= 0 && max !== -1)) throw new Error(`Missing or disabled dev SES quota in ${region}.`);
        return { region, max, used, needed, exhausted: !a.ProductionAccessEnabled && max > 0 && used >= max - needed };
      } finally { ses.destroy(); }
    }));
  } finally { sts.destroy(); }
}

/** A campaign can report ses_daily_quota when GetAccount couldn't refresh, too. Only a fresh
 * provider sample on the fixture's shared Ohio account proves its 200/day sandbox has no
 * marketing capacity (dev keeps the last 10% for transactional mail). No AWS call or write. */
export async function devSandboxMarketingQuotaExhausted(campaignId: string) {
  if (process.env.STAGE !== 'dev' || !['https://dev.nightmail.dev', 'https://dev.bane.mx'].includes(process.env.PUBLIC_URL ?? '') || !process.env.DATABASE_URL) return false;
  const [{ Client }, { postgresConnection }] = await Promise.all([import('pg'), import('../src/adapters/node.js')]);
  const db = new Client({ ...postgresConnection(process.env.DATABASE_URL), connectionTimeoutMillis: 3000, statement_timeout: 3000, options: '-c default_transaction_read_only=on' });
  try {
    await db.connect();
    const result = await db.query(`SELECT 1 FROM sending_campaigns c JOIN workspaces w ON w.id=c.workspace_id
      JOIN operation_domains d ON d.workspace_id=w.id AND d.id=$2 AND d.name='e2e.bane.mx'
      JOIN provider_connections p ON p.workspace_id=w.id AND p.kind='shared' AND p.region='us-east-2'
      JOIN provider_account_limits l ON l.aws_account_id=p.aws_account_id AND l.region=p.region
      WHERE c.id=$1 AND w.name='E2E' AND c.state='sending' AND c.waiting_reason='ses_daily_quota'
        AND c.total=1 AND c.expanded=0 AND l.checked_at BETWEEN now()-interval '1 minute' AND now()
        AND l.max_24_hour_send=200 AND l.max_send_rate=1 AND l.sent_last_24_hours>=180 LIMIT 1`, [campaignId, process.env.NIGHTMAIL_E2E_DOMAIN_ID ?? process.env.BANE_E2E_DOMAIN_ID]);
    return result.rowCount === 1;
  } catch {
    throw new Error('Could not confirm the dev SES sandbox quota from the fixture.');
  } finally { await db.end(); }
}

if (import.meta.main) {
  const [{ Client }, { postgresConnection }] = await Promise.all([import('pg'), import('../src/adapters/node.js')]);
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await applyDevE2eFixture(db, process.env); } finally { await db.end(); }
}
