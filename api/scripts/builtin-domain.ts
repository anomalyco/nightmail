import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { postgresConnection } from '../src/adapters/node.js';
import { setting } from '../src/brand.js';
import { BUILTIN_APEX_LOCALS } from '../src/builtin-limits.js';
import { ensureBuiltinApex, resetBuiltinBreaker, revokeBuiltinDomain } from '../src/builtin-domain.js';

// No API endpoint. Operator actions on built-in domains; a dry run shows what would change, --apply needs a reason,
// which is written to hosted_operator_audit with the signed-in operator.
//
// revoke: turns a workspace's built-in domain off for good (abuse): its sending and receiving stop at once, its label is
// never given out again, and the domain.builtin job removes the parent identity from the workspace's SES tenant. The
// workspace's own domains, its mail and its inboxes stay.
//   node --import tsx scripts/builtin-domain.ts revoke WORKSPACE_ID [--apply --reason "why"]
//
// reset-breaker: turns built-in sending back on for every workspace after the parent's circuit breaker tripped (too many
// bounces or complaints across all built-in domains, builtin-domain.ts builtinBreaker). Find and revoke the senders behind
// it first. The next sweep checks the parent identity and verifies the domains again; the breaker counts only mail sent
// from the reset on. --parent defaults to NIGHTMAIL_BUILTIN_DOMAIN.
//   node --import tsx scripts/builtin-domain.ts reset-breaker [--parent nightmail.email] [--apply --reason "why"]
//
// apex: the parent's own role addresses (abuse@, postmaster@, dmarc@, tls-reports@ nightmail.email) for the platform
// workspace (NIGHTMAIL_PLATFORM_DOMAIN_WORKSPACE): a receiving host for the parent under that workspace's built-in domain,
// and each --route's role address routed to that workspace's inboxes or webhooks (builtin-domain.ts ensureBuiltinApex).
// Mail to them arrives once the parent's MX points at SES; mail to any other address at the parent is dropped.
//   node --import tsx scripts/builtin-domain.ts apex --route abuse=mbx_…,mwh_… --route dmarc=mbx_… [--apply --reason "why"]
const usage = 'Usage: builtin-domain.ts revoke WORKSPACE_ID [--apply --reason "why"] | reset-breaker [--parent NAME] [--apply --reason "why"] | apex --route LOCAL=ID[,ID…] … [--apply --reason "why"]';
if (import.meta.main) {
  const { positionals: [command, wid, ...rest], values: v } = parseArgs({ allowPositionals: true, options: { apply: { type: 'boolean' }, reason: { type: 'string' }, parent: { type: 'string' }, route: { type: 'string', multiple: true } } });
  const parent = (v.parent ?? process.env.NIGHTMAIL_BUILTIN_DOMAIN ?? '').trim().toLowerCase();
  const valid = command === 'revoke' ? !!wid && !rest.length && /^ws_[0-9a-f]{32}$/.test(wid) && !v.parent && !v.route
    : command === 'reset-breaker' ? !wid && !!parent && !v.route
    : command === 'apex' && !wid && !v.parent && !!v.route?.length;
  if (!valid) throw new Error(usage);
  // apex: LOCAL=ID[,ID…], each a role address of the parent and the workspace's inbox (mbx_) or webhook (mwh_) IDs.
  const routes = Object.fromEntries((v.route ?? []).map(entry => {
    const [local = '', ids = ''] = entry.split('='), to = ids.split(',').map(s => s.trim()).filter(Boolean);
    if (!(BUILTIN_APEX_LOCALS as readonly string[]).includes(local) || !to.length || to.some(id => !/^(?:mbx|mwh)_[0-9a-f]{32}$/.test(id))) throw new Error(`--route ${entry}: use ${BUILTIN_APEX_LOCALS.join('|')}=mbx_…[,mwh_…].`);
    return [local, to];
  }));
  const reason = v.reason?.trim();
  if (v.apply && (!reason || reason.length < 10)) throw new Error('--apply needs --reason "why (at least 10 characters)"; it is written to hosted_operator_audit.');
  const db = new Client(postgresConnection(process.env.DATABASE_URL)); await db.connect();
  const sts = new STSClient({ ignoreConfiguredEndpointUrls: true, maxAttempts: 1 });
  try {
    if (command === 'apex') {
      const platform = setting(process.env, 'PLATFORM_DOMAIN_WORKSPACE'), config = { multiTenant: true, builtinDomain: parent || undefined, platformDomainWorkspace: platform } as Parameters<typeof ensureBuiltinApex>[0]['config'];
      if (!parent || !platform) throw new Error('Set NIGHTMAIL_BUILTIN_DOMAIN and NIGHTMAIL_PLATFORM_DOMAIN_WORKSPACE as production has them.');
      if (!v.apply) {
        const host = (await db.query(`SELECT b.name AS builtin,(SELECT json_build_object('id',m.id,'status',m.status) FROM mailbox_domains m WHERE m.workspace_id=b.workspace_id AND m.receiving_host=$2) AS apex
          FROM builtin_domains b WHERE b.workspace_id=$1 AND b.revoked_at IS NULL`, [platform, parent])).rows[0];
        const targets = (await db.query(`SELECT id FROM mailboxes WHERE workspace_id=$1 AND id=ANY($2) UNION ALL SELECT id FROM mailbox_webhooks WHERE workspace_id=$1 AND id=ANY($2)`, [platform, Object.values(routes).flat()])).rows.map(r => r.id);
        console.log(JSON.stringify({ workspace: platform, parent, through: host?.builtin ?? null, apexHost: host?.apex ?? 'to be created', routes, unknownDestinations: Object.values(routes).flat().filter(id => !targets.includes(id)) }, null, 2));
        process.exit(0);
      }
      const operator = (await sts.send(new GetCallerIdentityCommand({}))).Arn;
      if (!operator) throw new Error('No signed-in operator.');
      const host = await ensureBuiltinApex({ db: drizzle(db), config }, routes, operator, reason!);
      console.log(JSON.stringify({ workspace: platform, parent, apexHost: host, routes }, null, 2));
    } else {
      const row = command === 'revoke'
        ? (await db.query('SELECT name,revoked_at FROM builtin_domains WHERE workspace_id=$1', [wid])).rows[0]
        : (await db.query('SELECT name,ok,problem,tripped_at,trip,reset_at FROM builtin_parent WHERE name=$1', [parent])).rows[0];
      if (!row) throw new Error(command === 'revoke' ? 'This workspace has no built-in domain.' : `No built-in domain parent ${parent} is recorded.`);
      if (!v.apply) {
        console.log(JSON.stringify(command === 'revoke' ? { workspace: wid, domain: row.name, revokedAt: row.revoked_at, action: row.revoked_at ? 'nothing (already revoked)' : 'revoke' }
          : { parent, trippedAt: row.tripped_at, trip: row.trip, lastReset: row.reset_at, action: row.tripped_at ? 'reset' : 'nothing (not tripped)' }, null, 2));
        process.exit(0);
      }
      const operator = (await sts.send(new GetCallerIdentityCommand({}))).Arn;
      if (!operator) throw new Error('No signed-in operator.');
      await db.query('BEGIN');
      if (command === 'revoke') {
        const name = await revokeBuiltinDomain(drizzle(db), wid!, reason!, operator);
        await db.query('COMMIT');
        console.log(JSON.stringify({ workspace: wid, domain: row.name, revoked: !!name }, null, 2));
      } else {
        const trip = await resetBuiltinBreaker(drizzle(db), parent, reason!, operator);
        await db.query('COMMIT');
        console.log(JSON.stringify({ parent, reset: !!trip, trip }, null, 2));
      }
    }
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
  finally { await db.end(); sts.destroy(); }
}
