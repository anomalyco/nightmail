import { sql } from 'drizzle-orm';
import type { Ctx, Database, Runtime } from './core.js';
import { log } from './log.js';
import { WRITE_LIMITS } from './health-counters.js';

// Only this notice has a removal date. Earlier, undated deprecations stay as they are.
export const retiringOperations = new Map<string, string | null>([
  ['listInboxAppPasswords', 'listAppPasswords'],
  ['inviteWorkspaceMember', 'createWorkspaceInvitation'],
]);
const deprecatedFrom = new Date('2026-11-27T00:00:00Z');
const sunset = new Date('2027-02-25T23:59:59Z');
const sunsetDay = sunset.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export const noticeText = (replacement: string | null) => replacement
  ? `Deprecated: use \`${replacement}\`${replacement === 'listAppPasswords' ? ' with `inboxId`' : ''}. Removed after ${sunsetDay}.`
  : `Deprecated, with no replacement. Removed after ${sunsetDay}. Tell support if you rely on it.`;

type Call = { day: string; operation: string; workspace: string; calls: number };
type Writer = { opened: number; queue: Map<string, Call> };
const writers = new WeakMap<object, Writer>();
const MAX_QUEUED_KEYS = 256;
const lost = ({ operation, day, calls }: Call) => log('error', {
  code: 'DEPRECATED_CALL_WRITE_LOST', operation, deprecationDay: day, deprecationEvent: 'loss', lostWrites: calls,
});

function record(runtime: Runtime, call: Call) {
  // Share only plain data between requests for the same database, never a request's I/O.
  // Retire an owner after five seconds of admissions so even steady traffic cannot extend
  // its Worker's waitUntil indefinitely. The old owner still drains everything it accepted.
  const scope = runtime.deprecatedCallScope ?? runtime.deprecatedCallDb ?? runtime.db;
  const now = performance.now(), current = writers.get(scope);
  const key = JSON.stringify([call.day, call.operation, call.workspace]);
  if (current && now - current.opened < 5000) {
    const queued = current.queue.get(key);
    if (queued) queued.calls++;
    else if (current.queue.size < MAX_QUEUED_KEYS) current.queue.set(key, call);
    else lost(call);
    return;
  }

  const writer: Writer = { opened: now, queue: new Map([[key, call]]) };
  writers.set(scope, writer);
  const release = () => { if (writers.get(scope) === writer) writers.delete(scope); };
  const drain = async (db: Database) => {
    while (writer.queue.size) {
      const batch = Array.from(writer.queue.values());
      writer.queue.clear();
      try {
        await db.transaction(async tx => {
          await tx.execute(WRITE_LIMITS);
          await tx.execute(sql`INSERT INTO deprecated_call_days (day,operation,workspace_id,calls)
            SELECT day,operation,workspace,calls FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
              AS c(day date,operation text,workspace text,calls bigint) ORDER BY day,operation,workspace
            ON CONFLICT (day,operation,workspace_id) DO UPDATE SET calls=deprecated_call_days.calls+excluded.calls`);
        });
      } catch { batch.forEach(lost); }
    }
    // No await between observing the empty queue and relinquishing it: the last caller
    // never has to wait for a subsequent request to flush its count.
    release();
  };
  void Promise.resolve().then(() => {
    if (runtime.detach) return runtime.detach(background => drain(background.db));
    if (runtime.deprecatedCallDb) return drain(runtime.deprecatedCallDb);
    throw new Error('No independent counter connection');
  }).catch(() => { release(); writer.queue.forEach(lost); writer.queue.clear(); });
}

export function noticeResponse(c: Ctx, operation: string, workspace: string | undefined, day: string) {
  c.header('Deprecation', '@' + deprecatedFrom.getTime() / 1000);
  c.header('Sunset', sunset.toUTCString());
  const replacement = retiringOperations.get(operation);
  if (replacement) c.header('Link', `</docs/operations/${replacement}.md>; rel="successor-version"`, { append: true });

  record(c.env, { operation, day, workspace: workspace ?? '', calls: 1 });
}
