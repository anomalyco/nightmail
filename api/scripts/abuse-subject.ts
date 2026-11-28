import { drizzle } from 'drizzle-orm/node-postgres';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { abuseSubject, EXCLUSION_SOURCES, type ExclusionSource, type SubjectTarget } from '../src/abuse.js';
import { postgresConnection } from '../src/adapters/node.js';
import { loadConfig } from '../src/config.js';
import { log } from '../src/log.js';
import type { Runtime } from '../src/core/types.js';

// What abuse monitoring (src/abuse.ts) holds about one person or workspace, for an access, objection or erasure request
// that privacy@ has verified. It shows kinds and counts, never values, and never another customer's data.
//   node --import tsx scripts/abuse-subject.ts --user USER_ID | --workspace WORKSPACE_ID | --subject SUBJECT
//     [--erase | --exclude --reason "why" [--source objection|agreement|operator] | --include [--source ...]]
// --user covers the user, their sign-in subjects and the workspaces they own. --subject (with ACCOUNT_ISSUER) is for
// someone whose sign-in was never admitted; read the subject from scripts/list-signin-attempts.ts and confirm it with
// them, never by address alone. --erase deletes what is held, and nothing observed until now is recorded later.
// --exclude also stops recording, under one source (default: objection); --include lifts that source only.
// Each run is one transaction. Needs DATABASE_URL and the installation's configuration (the root secret).
export async function abuseSubjectCommand(db: Client, args: string[], env: Record<string, unknown> = process.env, database: Runtime['db'] = drizzle(db)) {
  const { values } = parseArgs({ args, options: { user: { type: 'string' }, workspace: { type: 'string' }, subject: { type: 'string' }, erase: { type: 'boolean' }, exclude: { type: 'boolean' }, include: { type: 'boolean' },
    reason: { type: 'string' }, source: { type: 'string' } } });
  const actions = [values.erase && 'erase', values.exclude && 'exclude', values.include && 'include'].filter(Boolean) as ('erase' | 'exclude' | 'include')[], reason = values.reason?.trim();
  const source = values.source as ExclusionSource | undefined, issuer = typeof env.ACCOUNT_ISSUER === 'string' ? env.ACCOUNT_ISSUER : undefined;
  if ([values.user, values.workspace, values.subject].filter(Boolean).length !== 1 || actions.length > 1 || (actions[0] === 'exclude' && (!reason || reason.length < 10)) || (source !== undefined && !EXCLUSION_SOURCES.includes(source))
    || (source !== undefined && actions[0] !== 'exclude' && actions[0] !== 'include') || (values.subject !== undefined && (/\s/.test(values.subject) || values.subject.length > 255)))
    throw new Error('Usage: abuse-subject.ts --user USER_ID | --workspace WORKSPACE_ID | --subject SUBJECT [--erase | --exclude --reason "why (at least 10 characters)" [--source objection|agreement|operator] | --include [--source ...]]');
  if (values.subject && (!issuer || !/^https:\/\/[^/]+$/.test(issuer))) throw new Error('Set ACCOUNT_ISSUER to the issuer the subject belongs to (https://account.anoma.ly in production).');
  const runtime = { db: database, config: loadConfig(env) };
  if (values.subject) {
    const { rows: [user] } = await db.query('SELECT user_id FROM nightmail_oidc_identities WHERE issuer=$1 AND subject=$2', [issuer, values.subject]);
    if (user) throw new Error(`That subject was admitted: use --user ${user.user_id}.`);
  }
  const target: SubjectTarget = values.user ? { user: values.user } : values.workspace ? { workspace: values.workspace } : { subject: { issuer: issuer!, subject: values.subject! } };
  const action = actions[0] ?? 'show', result = await abuseSubject(runtime, target, action, { source, reason });
  log('info', { code: 'ABUSE_SUBJECT', action, entities: result.entities, kinds: result.held.length, excluded: result.excluded.length });
  return result;
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { console.log(JSON.stringify(await abuseSubjectCommand(db, process.argv.slice(2)), null, 2)); } finally { await db.end(); }
}
