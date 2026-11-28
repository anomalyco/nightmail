import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/log.js';

// Required notices (src/sending/front-door.ts requiredNotice) reach people who unsubscribed from marketing, so only an operator
// turns them on, for one workspace, with a reason: Hosted or self-hosted alike.
export async function setRequiredNotices(db: Pick<Client, 'query'>, args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [wid, state] = positionals, reason = values.reason?.trim();
  if (positionals.length !== 2 || !wid || (state !== 'on' && state !== 'off') || !reason || reason.length < 10) throw new Error('Usage: set-required-notices.ts WORKSPACE_ID on|off --reason "why (at least 10 characters)"');
  // The row change and its audit must either both commit or neither commit.
  const { rows: [audit] } = await db.query(`WITH previous AS (
    SELECT id,required_notices FROM workspaces WHERE id=$1 FOR UPDATE
  ), changed AS (
    UPDATE workspaces w SET required_notices=$2 FROM previous p WHERE w.id=p.id
    RETURNING w.id,p.required_notices AS old_value,w.required_notices AS new_value
  ) INSERT INTO hosted_operator_audit(workspace_id,action,details)
    SELECT id,'set-required-notices',jsonb_build_object('old',old_value,'new',new_value,'reason',$3::text,'via','script') FROM changed RETURNING details`, [wid, state === 'on', reason]);
  if (!audit) throw new Error('No workspace with this ID.');
  log('info', { code: 'REQUIRED_NOTICES_CHANGED', workspaceId: wid, ...audit.details });
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await setRequiredNotices(db, process.argv.slice(2)); } finally { await db.end(); }
}
