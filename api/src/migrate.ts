import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { log } from './core.js';
import { envNames, setting } from './brand.js';
import { postgresConnection } from './adapters/node.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { deriveEncryptionKey, loadConfig, migrationSettings } from './config.js';
import { decrypt, reencryptWebhookSecrets } from './operations.js';
import { ensureRegionSettings } from './ses-region-state.js';

const rotation = envNames('ROOT_SECRET').some(name => process.env[`PREVIOUS_${name}`]) || process.env.ENCRYPTION_KEY ? loadConfig(process.env) : null;
const config = rotation ?? migrationSettings(process.env);

const client = new Client(postgresConnection(process.env.DATABASE_URL));
await client.connect();
try {
  await client.query("SET lock_timeout='10s'");
  await client.query('SELECT pg_advisory_lock(78291344)');
  await client.query('RESET lock_timeout');
  // Before workspaces existed (migration 038), installations had one internal namespace: never silently
  // strand an older tenant. Once the workspaces table exists, other workspaces are legitimate data.
  // The ledger was opensend_migrations, then bane_migrations, now nightmail_migrations: more than one table is ambiguous.
  const workspacesTable = await client.query(`SELECT to_regclass('public.workspaces') AS t, (SELECT count(*) FROM unnest(ARRAY['opensend_migrations','bane_migrations','nightmail_migrations']) n
    JOIN pg_class c ON c.oid=to_regclass(n) WHERE c.relkind='r')>1 AS ambiguous`);
  if (workspacesTable.rows[0].ambiguous) throw new Error('MIGRATION_LEDGER_AMBIGUOUS: more than one of opensend_migrations, bane_migrations and nightmail_migrations exists');
  const scopedTables = workspacesTable.rows[0]?.t ? { rows: [] as { table_name: string }[] }
    : await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'workspace_id'");
  for (const { table_name } of scopedTables.rows) {
    const table = table_name.replaceAll('"', '""');
    const foreign = await client.query(`SELECT 1 FROM public."${table}" WHERE workspace_id <> $1 LIMIT 1`, [config.workspaceId]);
    if (foreign.rowCount) throw new Error('LEGACY_WORKSPACE_MIGRATION_REQUIRED: non-default workspace data requires an explicit migration plan before this upgrade. No data was modified.');
  }
  // Fresh databases have neither table. Older schemas still include environment in the binding.
  const rootSecret = setting(process.env, 'ROOT_SECRET');
  if (!rotation && rootSecret !== undefined) {
    for (const table of ['operation_webhooks','mailbox_webhooks']) {
      if (!(await client.query('SELECT to_regclass($1) AS t',[table])).rows[0].t) continue;
      // Slack, Discord and forward endpoints have no signing secret (migration 322).
      const sample=(await client.query(`SELECT id,workspace_id,encrypted_secret,coalesce(to_jsonb(w)->>'environment','live') AS env FROM ${table} w WHERE encrypted_secret IS NOT NULL LIMIT 1`)).rows[0];
      if (!sample) continue;
      const binding=`${sample.workspace_id}:${sample.env}:${table==='mailbox_webhooks'?'mailbox:':''}${sample.id}`;
      try { await decrypt({config:{encryptionKey:deriveEncryptionKey(rootSecret)}},sample.encrypted_secret,binding); }
      catch { throw new Error('KEY_ROTATION_REQUIRED: NIGHTMAIL_ROOT_SECRET differs from the secret that encrypted the stored webhooks. Restore it or configure explicit rotation. No data was modified.'); }
      log('info', {code:'STORED_WEBHOOK_SECRET_DECRYPT_VERIFIED'});
      break;
    }
  }
  // The advisory lock serializes this rename with old and new migrators. bane_migrations stays as a view of the ledger
  // so an earlier release's migrator still finds its rows (remove after rename cleanup).
  await client.query(`DO $$ BEGIN
    SET LOCAL lock_timeout='1s';
    IF to_regclass('nightmail_migrations') IS NULL THEN
      IF to_regclass('opensend_migrations') IS NOT NULL THEN
        ALTER TABLE opensend_migrations RENAME TO nightmail_migrations;
      ELSIF to_regclass('bane_migrations') IS NOT NULL THEN
        ALTER TABLE bane_migrations RENAME TO nightmail_migrations;
        ALTER INDEX IF EXISTS bane_migrations_pkey RENAME TO nightmail_migrations_pkey;
      ELSE
        CREATE TABLE nightmail_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
      END IF;
    END IF;
    IF to_regclass('bane_migrations') IS NULL THEN CREATE VIEW bane_migrations AS SELECT * FROM nightmail_migrations; END IF;
  END $$`);
  // All migrators hold the same advisory lock. Read the ledger once under that lock, rather than paying a
  // database round trip for every already-applied file; still hash and compare each file in order.
  const ledger = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM nightmail_migrations');
  const applied = new Map(ledger.rows.map(({ name, checksum }) => [name, checksum]));
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(n => /^\d+_[a-z_]+\.sql$/.test(n)).sort()) {
    const source = await readFile(new URL(name, directory), 'utf8');
    const hash = createHash('sha256').update(source).digest('hex');
    if (applied.has(name)) {
      if (applied.get(name) !== hash) throw new Error(`MIGRATION_CHANGED: ${name} differs from the applied migration. Add a new migration instead.`);
      continue;
    }
    // Marked files contain one restartable concurrent index build per line. Separate query
    // messages matter: sending all the DDL together creates an implicit transaction in pg.
    if (source.startsWith('-- bane:batched\n')) {
      // Each page commits before the next page starts. A restart replays the idempotent pages.
      await client.query("SET lock_timeout='2s'; SET statement_timeout='60s'");
      let cursor='';
      for (;;) {
        const next:string|null=(await client.query(source,[cursor])).rows[0].cursor;
        if(next===null)break;if(next===cursor)throw new Error(`Stuck backfill cursor in ${name}`);cursor=next;
      }
      await client.query('INSERT INTO nightmail_migrations(name,checksum) VALUES ($1,$2)',[name,hash]);
      await client.query('RESET lock_timeout; RESET statement_timeout');continue;
    }
    if(source.startsWith('-- bane:no-transaction\n')) {
      // CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE (never blocks reads or writes) and waits for older snapshots.
      // Keep each wait bounded at 5 s and allow up to 12 retries (~60 s total) so busy tables do not abort deploys.
      await client.query("SET lock_timeout='5s'; SET statement_timeout='10min'");
      for(const statement of source.split('\n').map(s=>s.trim()).filter(s=>s && !s.startsWith('--'))) {
        const drop=/^DROP INDEX CONCURRENTLY IF EXISTS ([a-z_][a-z0-9_]*);$/i.exec(statement);
        const match=drop??/^CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS ([a-z_][a-z0-9_]*) ON .+;$/i.exec(statement);
        if(!match)throw new Error(`Invalid online index statement in ${name}`);
        const idx=match[1]!;
        // Both wait for every transaction that has used the table. A drop that times out leaves the index invalid but still
        // maintained (so updates of its columns are still not HOT); the next attempt finishes it.
        for(let attempt=1;;attempt++) {
          try {
            if(!drop&&(await client.query('SELECT FROM pg_index WHERE indexrelid=to_regclass($1) AND NOT indisvalid',[idx])).rowCount)await client.query(`DROP INDEX CONCURRENTLY "${idx}"`);
            await client.query(statement); break;
          } catch(error) {
            if((error as {code?:string}).code!=='55P03' || attempt>=12) throw error;
            log('warn',{code:'INDEX_LOCK_RETRY',migration:name,index:idx,attempt});
            await new Promise(resolve=>setTimeout(resolve,Math.min(1000,attempt*250)));
          }
        }
      }
      await client.query('INSERT INTO nightmail_migrations(name,checksum) VALUES ($1,$2)',[name,hash]);
      await client.query('RESET lock_timeout; RESET statement_timeout');
      log('info',{code:'MIGRATION_APPLIED',migration:name});continue;
    }
    // Bound DDL lock waits (3 s, retried on 55P03) and runaway statements (60 s default; 30 min with an explicit
    // -- bane:long-statement header for known long backfills) so blocked DDL never queues behind slow reads indefinitely.
    const statementTimeout = source.startsWith('-- bane:long-statement\n') ? '30min' : '60s';
    for (let attempt = 1; ; attempt++) {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='${statementTimeout}'`);
        await client.query(source);
        await client.query('INSERT INTO nightmail_migrations(name, checksum) VALUES ($1, $2)', [name, hash]);
        await client.query('COMMIT');
        log('info', { code: 'MIGRATION_APPLIED', migration: name });
        break;
      } catch (error) {
        await client.query('ROLLBACK');
        if ((error as { code?: string }).code !== '55P03' || attempt >= 10) throw error;
        log('warn', { code: 'MIGRATION_LOCK_RETRY', migration: name, attempt });
        await new Promise(resolve => setTimeout(resolve, Math.min(2000, attempt * 250)));
      }
    }
  }
  await ensureRegionSettings(drizzle(client), config);
  if (rotation) {
    const rekeyed = await reencryptWebhookSecrets(drizzle(client), rotation);
    if (rekeyed.conflicted) throw new Error('SECRET_REKEY_CONFLICT: concurrent changes occurred; rerun migrate before removing the previous secret.');
    log('info', { code: 'WEBHOOK_SECRETS_REKEYED', ...rekeyed });
  } else log('info', { code: 'WEBHOOK_SECRETS_REKEY_SKIPPED' });
} finally { await client.end(); }
