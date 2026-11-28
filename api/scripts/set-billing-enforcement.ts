import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/log.js';

const MODES = ['off', 'shadow', 'enforce'] as const;
const usage = 'Usage: set-billing-enforcement.ts off|shadow|enforce [--receive-hold on|off] [--storage-from YYYY-MM-DD|none] [--bill-simulated on|off] --reason "why (at least 10 characters)"';
const flag = (value: string | undefined, name: string) => {
  if (value === undefined) return null;
  if (value !== 'on' && value !== 'off') throw new Error(`--${name} takes on or off.\n${usage}`);
  return value === 'on';
};

/**
 * Switches billing for the whole installation (billing_config, one row): off → shadow → enforce, and back. Shadow runs
 * the meters, settlement and ledger with usage posted at $0; enforce charges usage settled from then on. A database row,
 * not a deploy, so a rollback is this script with `shadow`. Run it in a transaction: the change, the settlement before
 * it and its audit row (workspace 'installation') commit together.
 *
 * Usage is priced under the mode of the hour it was metered in (migration 333): a switch that stops charging takes effect
 * from the current hour, one that starts charging from the next, as the mode history records it (318). Before the mode
 * changes, every workspace's usage is still settled (billing_settle_all), which waits for meter writes in flight
 * (migration 314's fence). Switching to off doesn't settle: the kill-switch never waits on the settler or the writers.
 * What it leaves unsettled is forgiven when it settles while billing is off, usually as billing comes back on.
 */
export async function setBillingEnforcement(db: Client, args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    reason: { type: 'string' }, 'receive-hold': { type: 'string' }, 'storage-from': { type: 'string' }, 'bill-simulated': { type: 'string' } } });
  const [mode] = positionals, reason = values.reason?.trim();
  if (positionals.length !== 1 || !MODES.includes(mode as typeof MODES[number]) || !reason || reason.length < 10) throw new Error(usage);
  const receiveHold = flag(values['receive-hold'], 'receive-hold'), billSimulated = flag(values['bill-simulated'], 'bill-simulated');
  const storage = values['storage-from'];
  if (storage !== undefined && storage !== 'none' && !(/^\d{4}-\d{2}-\d{2}$/.test(storage) && Number.isFinite(Date.parse(`${storage}T00:00:00Z`)))) throw new Error(`--storage-from takes a date (YYYY-MM-DD) or none.\n${usage}`);
  const { rows: [current] } = await db.query<{ mode: string }>(`SELECT mode FROM billing_config WHERE singleton FOR UPDATE`);
  if (current && current.mode !== mode && mode !== 'off') await db.query(`SELECT billing_settle_all()`);
  const { rows: [audit] } = await db.query(`WITH previous AS (
    SELECT mode,receive_hold,bill_simulated,storage_billing_from FROM billing_config WHERE singleton FOR UPDATE
  ), changed AS (
    UPDATE billing_config c SET mode=$1,
      receive_hold=coalesce($2::boolean,c.receive_hold),
      bill_simulated=coalesce($3::boolean,c.bill_simulated),
      storage_billing_from=CASE WHEN $4::text IS NULL THEN c.storage_billing_from WHEN $4='none' THEN NULL ELSE $4::date END,
      enforced_at=CASE WHEN $1='enforce' AND p.mode<>'enforce' THEN now() ELSE c.enforced_at END,
      updated_at=now()
    FROM previous p WHERE c.singleton
    RETURNING c.mode,c.receive_hold,c.bill_simulated,c.storage_billing_from,c.enforced_at
  ) INSERT INTO hosted_operator_audit(workspace_id,action,details)
    SELECT 'installation','set-billing-enforcement',jsonb_build_object('old',(SELECT to_jsonb(p) FROM previous p),'new',to_jsonb(c),'reason',$5::text,'via','script') FROM changed c
    RETURNING details`, [mode, receiveHold, billSimulated, storage ?? null, reason]);
  if (!audit) throw new Error('billing_config has no row: run the migrations first.');
  log('info', { code: 'BILLING_ENFORCEMENT_CHANGED', ...audit.details });
  return audit.details as { old: Record<string, unknown>; new: Record<string, unknown> };
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try {
    await db.query('BEGIN');
    await setBillingEnforcement(db, process.argv.slice(2));
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; } finally { await db.end(); }
}
