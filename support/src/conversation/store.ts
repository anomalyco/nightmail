import { platformBody, type MirroredState, type PlatformReply } from '../nightmail.js';
import type { Env } from '../env.js';
import { gate } from '../gate.js';
import { expectation, fileTicket, ticketEmail, type TicketContext, type TicketMessage } from '../tickets.js';
import { addressHash, newId } from '../tokens.js';
import { alertOnce, countToday, limits, registrableDomain, ticketAllowed } from '../limits.js';
import { external, WorkQueue, type WorkRow, type WorkState } from '../work.js';
import { attachmentLink, modelImage, type Attachment } from '../attachments.js';
import { type Customer } from '../agent/context.js';
import { spentBy, type Harness, type Usage } from '../agent/harness.js';
import { createHarness } from '../agent/opencode.js';
import { type TicketInput } from '../agent/tools.js';
import { productName } from '../../../api/src/brand.js';
import { log, logError } from '../log.js';
import { TURNS_PER_CONVERSATION, TOKEN_BUDGET, CONTEXT_MS, CHAT_IDLE_MS, EMAIL_IDLE_MS, KEEP_AFTER_CLOSE_MS, MODEL_LABEL, MIRROR_DELAYS, Meta, Transcript, briefOf, ticketNote, Outgoing, Snapshot, Route, Composed, Notify, Alert, FollowUp, EmailTurn, MirrorRow, mirrored, platformError, fileName, ticketPerson, spentUsd } from './state.js';

export class ConversationStore {
  constructor(readonly ctx: DurableObjectState, private readonly envOf: () => Env) {
    this.sql = ctx.storage.sql;
    this.work = new WorkQueue(ctx.storage, { db: envOf().DB, flow: 'support', object: ctx.id.toString() });
  }
  get env(): Env { return this.envOf(); }
  readonly sql: SqlStorage;
  readonly work: WorkQueue;
  /** OpenCode, booting or booted: started in the background when a chat opens or reconnects, awaited by the first turn. */
  booting: Promise<Harness> | null = null;
  /** The DMARC verdict of the email being answered, for the ticket it may file. */
  currentDmarc: string | null = null;
  /**
   * The email turn running now: its reply tool freezes that email's one answer. `verified`: it reads the account (by
   * role); `lost`: a scope it was offered gave less than the turn ran with, so the turn stops and its answer is held.
   */
  emailTurn: EmailTurn | null = null;
  /** The account summary of the last member turn (<account>), reused for CONTEXT_MS. */
  context: { workspaceId: string; at: number; text: string } | null = null;
  abort: AbortController | null = null;
  /** Frame sequence: increases across restarts (it starts from the clock), without a storage write per streamed delta. */
  seq = Date.now() * 1000;
  /** One inbox mirror at a time, so the cursor only moves forward. */
  mirroring: Promise<void> = Promise.resolve();
  /** A stamped request during the chat turn running now was refused: the turn stops and the chat ends after it. */
  accessLost = false;
  /** This chat turn's ticket was refused by the ticket caps (fileTicket): it ends with no answer, passed to the team. */
  chatUnticketed = false;
  /**
   * What an earlier build left queued, settled once as this object loads:
   * - an answer whose text an earlier build wrote (it may have read an account) is never sent: held, and shown to the team
   *   as a held draft in the staff inbox. This build's answers carry their mode ('general' or 'verified');
   * - answers an earlier build parked until a sign-in or an address confirmation (no `signin` marker of this build's):
   *   never answered. Held, never sent; their messages stay in the staff inbox. A confirm link not sent yet is held too.
   */
  settleParked() {
    const now = Date.now(), at = new Date(now).toISOString();
    const written = this.sql.exec<{ id: string; result: string }>(`SELECT id, result FROM _support_work WHERE kind = 'answer' AND state IN ('pending', 'blocked', 'parked')
      AND (json_extract(result, '$.model') IS NOT NULL OR json_type(result, '$.text') = 'text') AND coalesce(json_extract(result, '$.mode'), '') NOT IN ('general', 'verified')`).toArray();
    for (const row of written) {
      const progress = JSON.parse(row.result) as Composed;
      progress.held ??= newId('msg');
      this.sql.exec("UPDATE _support_work SET state = 'held', result = ?, updated_at = ? WHERE id = ?", JSON.stringify(progress), now, row.id);
      this.record({ id: progress.held, role: 'assistant', kind: 'held', text: typeof progress.text === 'string' ? progress.text : progress.model ?? '', at, tools: [], channel: 'email', reason: 'earlier' }, false);
    }
    const settled = this.sql.exec("UPDATE _support_work SET state = 'held', updated_at = ? WHERE (kind = 'answer' AND state = 'parked' AND json_extract(payload, '$.signin') IS NULL) OR (kind = 'confirm' AND state IN ('pending', 'blocked'))", now).rowsWritten;
    if (written.length) log('warn', { event: 'email', code: 'EARLIER_ANSWERS_HELD', held: written.length });
    return settled + written.length > 0;
  }
  /**
   * The earlier inbox (`_support_inbox`, from the builds before the work queue): what it still holds becomes work once,
   * in one transaction with dropping the table. What that inbox finished or decided isn't done again here, and the frozen
   * idempotency keys refuse a second send of anything it sent.
   */
  importLegacy() {
    if (!this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_support_inbox'").toArray().length) return false;
    const now = Date.now(), finished = "('answered','dropped','held','rerouted')", decided = "('awaiting_confirmation','confirmed')", ofMessage = "json_extract(payload,'$.messageId') IN (SELECT message_id FROM _support_inbox WHERE state IN";
    // Only 'new' runs. 'failed' (six tries spent, possibly days ago) is kept for the record and never run again: a late
    // reply or link for old mail would only confuse. A message waiting for (or past) its confirmation was already decided
    // and its link sent: only its answer is left.
    return this.ctx.storage.transactionSync(() => {
      const written = [
      this.sql.exec(`INSERT INTO _support_work(id,kind,state,payload,due_at,attempts,last_error,created_at,updated_at)
        SELECT 'msg:'||message_id,'message',CASE state WHEN 'new' THEN 'pending' WHEN 'held' THEN 'held' WHEN 'failed' THEN 'dead' ELSE 'done' END,
          json_object('messageId',message_id,'threadId',thread_id,'deliveryId',delivery_id),received_at,attempts,
          CASE state WHEN 'failed' THEN 'permanent:0:LEGACY_FAILED' END,received_at,?
        FROM _support_inbox WHERE NOT EXISTS (SELECT 1 FROM _support_work WHERE id='msg:'||message_id)`, now),
      this.sql.exec(`INSERT INTO _support_work(id,kind,state,payload,parent,due_at,created_at,updated_at)
        SELECT 'answer:'||message_id,'answer',CASE state WHEN 'confirmed' THEN 'pending' ELSE 'parked' END,
          json_object('messageId',message_id,'threadId',thread_id,'legacy',1),'msg:'||message_id,?1,?1,?1
        FROM _support_inbox WHERE state IN ${decided} AND NOT EXISTS (SELECT 1 FROM _support_work WHERE id='answer:'||message_id)`, now),
      this.sql.exec(`UPDATE _support_work SET state='done',updated_at=? WHERE state IN ('pending','blocked','parked')
        AND kind IN ('message','answer','confirm','forward') AND ${ofMessage} ${finished})`, now),
      this.sql.exec(`UPDATE _support_work SET state='done',updated_at=? WHERE state IN ('pending','blocked') AND kind='message' AND ${ofMessage} ${decided})`, now),
      this.sql.exec(`UPDATE _support_work SET state='pending',due_at=?1,updated_at=?1 WHERE state='parked' AND kind='answer' AND ${ofMessage} ('confirmed'))`, now),
      ].some(r => r.rowsWritten > 0);
      this.sql.exec('DROP TABLE _support_inbox');
      return written;
    });
  }
  /** A message or its answer that finished: one log line. */
  finished(item: WorkRow, state: WorkState) {
    const { messageId } = JSON.parse(item.payload) as { messageId?: string };
    if (!messageId || !['message', 'answer'].includes(item.kind) || state === 'pending' || state === 'blocked' || state === 'parked') return;
    log(state === 'dead' ? 'error' : 'info', { event: 'email', channel: 'support', code: state === 'dead' ? 'EMAIL_FAILED' : undefined, kind: item.kind, state, messageId, attempt: item.attempts });
  }
  /**
   * OpenCode keeps its tables in this SQLite too, and bootstraps its schema only into a database without other tables,
   * except names starting with `_`. Ours are `_support_*`, so OpenCode can boot after them; a conversation from before
   * (`support_*`, created after OpenCode's) is renamed once.
   */
  createTables() {
    const existing = new Set(this.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(t => t.name));
    for (const table of ['meta', 'transcript', 'client_ids', 'inbox', 'attachments', 'consent']) {
      if (existing.has(`support_${table}`) && !existing.has(`_support_${table}`)) this.sql.exec(`ALTER TABLE support_${table} RENAME TO _support_${table}`);
    }
    // A grant from before the stamp (support_grant): Nightmail no longer has grants, so there is nothing to keep or revoke.
    this.sql.exec(`DROP TABLE IF EXISTS _support_grant; DROP TABLE IF EXISTS support_grant;
      CREATE TABLE IF NOT EXISTS _support_meta (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS _support_transcript (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, kind TEXT, text TEXT NOT NULL, at TEXT NOT NULL, tools TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS _support_client_ids (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS _support_attachments (id TEXT PRIMARY KEY, key TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER, height INTEGER, source TEXT NOT NULL, name TEXT NOT NULL, message_id TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS _support_consent (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_name TEXT NOT NULL, why TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS _support_actions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_check_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS _support_theirs (value TEXT NOT NULL, access TEXT NOT NULL, PRIMARY KEY (value, access));`);
    // A staff reply's author, an entry that arrived by email (the inbox marks a delivered agent answer sent), a customer
    // email's Nightmail message, and why an answer was held.
    const columns = new Set(this.sql.exec<{ name: string }>('PRAGMA table_info(_support_transcript)').toArray().map(c => c.name));
    for (const column of ['author', 'channel', 'source', 'reason']) if (!columns.has(column)) this.sql.exec(`ALTER TABLE _support_transcript ADD COLUMN ${column} TEXT`);
  }
  meta(): Meta | null {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM _support_meta WHERE id = 1').toArray()[0];
    return row ? JSON.parse(row.value) as Meta : null;
  }
  save(meta: Meta) { this.sql.exec('INSERT INTO _support_meta (id, value) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value', JSON.stringify(meta)); }
  update(change: (meta: Meta) => void) { const meta = this.meta(); if (!meta) throw new Error('conversation not opened'); change(meta); this.save(meta); return meta; }
  /**
   * Adds a model turn's usage to the conversation's counters; `turns`: whether it counts as a turn (a nudge doesn't). A
   * failed turn's goes to `failed` instead, which no limit reads.
   */
  charge(usage: Usage, turns: number, failed = false) {
    return this.update(m => {
      const into = failed ? m.failed ??= { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 } : m;
      into.turns += turns; into.inputTokens += usage.inputTokens; into.outputTokens += usage.outputTokens; into.cacheReadTokens = (into.cacheReadTokens ?? 0) + usage.cacheReadTokens; into.costUsd += usage.costUsd;
      m.lastActivity = Date.now();
    });
  }
  /**
   * The counters in D1: the turns and tokens the limits read, and cost_usd, everything spent (failed turns included). The
   * inbox gets them with the next mirror, which is how Nightmail counts the spend (api/src/support-ai-cost.ts).
   */
  saveUsage(meta: Meta) {
    return this.env.DB.prepare('UPDATE conversations SET turns = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, updated_at = ? WHERE id = ?').bind(meta.turns, meta.inputTokens, meta.outputTokens, spentUsd(meta), Date.now(), meta.conversationId).run();
  }
  /** A turn that threw after its model calls began still spent: counted as a failed turn's, saved and mirrored. */
  chargeLost(error: unknown, turns: number) {
    const lost = spentBy(error);
    if (!lost) return;
    const meta = this.charge(lost, turns, true);
    this.ctx.waitUntil(this.saveUsage(meta).then(() => {}, e => logError(e, { event: 'turn', code: 'USAGE_NOT_SAVED' }, 'warn')));
    this.mirrorSoon();
  }
  fresh(conversationId: string, channel: Meta['channel']): Meta {
    return { conversationId, channel, status: 'open', userId: null, email: null, name: null, role: null, workspace: null, workspaces: [], verified: null, contentAccess: false, page: null, handoffMessage: null,
      requestIds: [], threadId: null, greeted: false, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ticketId: null, lastActivity: Date.now(), closedAt: null };
  }
  customer(meta: Meta): Customer {
    return { channel: meta.channel, userId: meta.userId, name: meta.name, email: meta.email, role: meta.role, workspace: meta.workspace, workspaces: meta.workspaces, verified: meta.verified, contentAccess: meta.contentAccess, page: meta.page };
  }
  /** This conversation's ID, read from storage, once this object is checked to be the one named for it. */
  own(): string {
    const id = this.meta()?.conversationId;
    if (!id || !this.ctx.id.equals(this.env.CONVERSATION.idFromName(id))) throw new Error('This object does not hold the conversation it was asked about.');
    return id;
  }
  /** Values removed from everything the model reads (projection.ts): the person's account ID and this conversation's ID. */
  hidden() { const meta = this.meta(); return [meta?.userId, meta?.conversationId].filter((v): v is string => !!v); }
  /** The model session ends for good: its history (and anything it read) is never used for another turn. */
  async retireModel() {
    this.context = null; this.booting = null;
    this.sql.exec('DELETE FROM _support_theirs');
    this.update(m => { m.modelRetired = true; });
    await this.ctx.storage.delete(['support:opencode-session', 'support:opencode-model']);
  }
  /** `mirror`: send it to the staff inbox now (false while the object loads: the alarm's mirror takes it). */
  record(t: Transcript, mirror = true) {
    // An entry is written once (a retried work item records the same ID again).
    const written = this.sql.exec('INSERT INTO _support_transcript (id, role, kind, text, at, tools, author, channel, source, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING', t.id, t.role, t.kind, t.text, t.at,
      JSON.stringify(t.attachments?.length ? { tools: t.tools, attachments: t.attachments } : t.tools), t.author ?? null, t.channel ?? null, t.source ?? null, t.reason ?? null).rowsWritten;
    if (written && mirror) this.mirrorSoon();
  }
  /** Sends what the inbox hasn't seen yet, in the background (the caller never waits on Nightmail). */
  mirrorSoon() { this.ctx.waitUntil(this.mirror()); }
  /** Mirrors in order: one run at a time, from the cursor. */
  mirror() { return this.mirroring = this.mirroring.then(() => this.pushMirror()).catch(error => logError(error, { event: 'inbox', code: 'MIRROR_FAILED' }, 'warn')); }
  /** What the inbox lists about this conversation: its subject, ticket, counters, blocked work and an emailed ticket's pause. */
  inboxSnapshot(meta: Meta): MirroredState {
    const blocked = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM _support_work WHERE state = 'blocked'").one().n;
    return { ...meta.subject ? { subject: meta.subject.slice(0, 200) } : {}, ...meta.ticket ? { ticket: { id: meta.ticket.id, type: meta.ticket.type, severity: meta.ticket.severity, ...meta.ticket.brief ? { brief: meta.ticket.brief } : {} } } : {}, turns: meta.turns, costUsd: Math.round(spentUsd(meta) * 10_000) / 10_000, blockedWork: blocked,
      // After an emailed ticket the team owns the thread: the agent answers no later mail (compose), so the inbox shows it paused.
      ...meta.channel === 'email' && meta.status === 'ticketed' ? { pauseForTicket: true as const } : {} };
  }
  async pushMirror() {
    let meta = this.meta();
    if (!meta) return;
    try {
      for (let round = 0; round < 10; round++) {
        const rows = this.sql.exec<MirrorRow & { seq: number }>(
          'SELECT seq, id, role, kind, text, at, tools, channel, source, reason FROM _support_transcript WHERE seq > ? ORDER BY seq LIMIT 50', meta.mirrored ?? 0).toArray();
        if (!rows.length) break;
        // Staff replies are the inbox's own: they are never mirrored back.
        const files = new Map(this.attachments().map(a => [a.id, a])), messages = rows.filter(r => r.role !== 'staff').map(r => mirrored(r, files));
        if (messages.length && !this.reachable(await this.env.BANE.mirrorMessages(meta.conversationId, messages))) return;
        meta = this.update(m => { m.mirrored = rows.at(-1)!.seq; });
      }
      // A ticket filed by an earlier build has no brief: read once from its row (none there: never asked again; a failed
      // read waits for the next mirror).
      if (meta.ticket && meta.ticket.brief === undefined) {
        const row = await this.env.DB.prepare('SELECT title, summary, ask, recommendation FROM tickets WHERE id = ?').bind(meta.ticket.id).first<{ title: string; summary: string; ask: string; recommendation: string }>()
          .catch(error => { logError(error, { event: 'inbox', code: 'TICKET_BRIEF_UNREAD' }, 'warn'); return undefined; });
        if (row !== undefined) meta = this.update(m => { if (m.ticket) m.ticket.brief = row ? briefOf(row) : null; });
      }
      const state = this.inboxSnapshot(meta), wanted = JSON.stringify(state);
      if (wanted !== meta.mirroredState) {
        if (!this.reachable(await this.env.BANE.mirrorState(meta.conversationId, state))) return;
        meta = this.update(m => { m.mirroredState = wanted; });
      }
      if (meta.mirrorDueAt || meta.mirrorAttempts) this.update(m => { m.mirrorDueAt = null; m.mirrorAttempts = 0; });
    } catch (error) {
      // Nightmail is unreachable or refused it: try again later, from the same place.
      const attempts = (meta.mirrorAttempts ?? 0) + 1, minutes = MIRROR_DELAYS[Math.min(attempts, MIRROR_DELAYS.length) - 1]!;
      this.update(m => { m.mirrorAttempts = attempts; m.mirrorDueAt = Date.now() + minutes * 60_000; });
      logError(error, { event: 'inbox', code: 'MIRROR_RETRY', attempts }, 'warn');
      await this.arm();
    }
  }
  /**
   * Whether Nightmail took a mirror call. A conversation it hasn't registered (404) waits, without retrying, until the
   * next entry or registration; anything else that isn't a success is retried.
   */
  reachable(reply: PlatformReply<unknown>) {
    if (reply.status === 404) { if (this.meta()?.mirrorDueAt) this.update(m => { m.mirrorDueAt = null; m.mirrorAttempts = 0; }); return false; }
    platformBody(reply);
    return true;
  }
  broadcast(message: Outgoing) {
    const frame = JSON.stringify({ v: 1, ...message, seq: ++this.seq });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(frame); } catch { /* closed */ } }
  }
  sendTo(ws: WebSocket, message: Outgoing) {
    try { ws.send(JSON.stringify({ v: 1, ...message, seq: ++this.seq })); } catch { /* closed */ }
  }
  /**
   * A chat notice; `waiting` when it asks them to do something first, `status` when it only records their choice,
   * `unanswered` when it says their message went to the team (none of these is a reply in the inbox).
   */
  notice(text: string, kind: 'notice' | 'waiting' | 'status' | 'unanswered' = 'notice') {
    const id = newId('msg');
    this.record({ id, role: 'assistant', kind, text, at: new Date().toISOString(), tools: [] });
    this.broadcast({ type: 'message.start', messageId: id, kind: 'notice' });
    this.broadcast({ type: 'message.end', messageId: id, text, redacted: false });
  }
  /** OpenCode for this conversation, booted once; a failed boot is retried by the next caller. Never once retired. */
  agent(): Promise<Harness> {
    if (this.meta()?.modelRetired) return Promise.reject(new Error('The model session of this conversation was retired.'));
    this.booting ??= createHarness(this.env, this.ctx.storage).catch(error => { this.booting = null; throw error; });
    return this.booting;
  }
  /** Boots OpenCode in the background, so the first turn finds it ready. */
  warm() {
    if (!this.env.CONSOLE_GATEWAY_KEY || this.meta()?.modelRetired) return;
    this.ctx.waitUntil(this.agent().then(() => undefined, error => logError(error, { event: 'chat', code: 'AGENT_BOOT_FAILED' }, 'warn')));
  }
  /** Guards every turn: the conversation's limits, the spend budget, and the model key. */
  admit(meta: Meta): 'closed' | 'turns' | 'budget' | null {
    if (meta.status === 'closed') return 'closed';
    if (meta.turns >= TURNS_PER_CONVERSATION) return 'turns';
    if (meta.inputTokens + meta.outputTokens + (meta.cacheReadTokens ?? 0) / 10 >= TOKEN_BUDGET) return 'budget';
    return null;
  }
  /**
   * The person a daily cap counts against: a chat's user, an email's sender address (always: whatever account an older
   * conversation stored, the address that writes is what an email cap counts).
   */
  async person(meta: Meta) { return meta.channel === 'chat' && meta.userId ? `user:${meta.userId}` : `sender:${await addressHash(meta.email ?? meta.conversationId)}`; }
  /**
   * The daily turn caps, before any model call. Signed-in chats and verified customer emails draw from the customer
   * reserve (`global:turns`), within their person's cap and their workspace's. General (non-member) emails draw from their
   * own per-domain and daily budget so they can never exhaust the customer reserve.
   */
  async turnAllowed(meta: Meta, count = countToday, verifiedEmail = false, agent = false): Promise<{ ok: boolean; global: boolean; workspace?: true }> {
    const cap = limits(this.env), email = meta.channel === 'email';
    // An agent's report: the agents' own pool (Nightmail caps it per credential and workspace), never people's turns.
    if (agent) return (await count(this.env, 'global:turns:agents', cap.turnsAgentsPerDay)).ok ? { ok: true, global: false } : { ok: false, global: true };
    if (!(await count(this.env, `${await this.person(meta)}:${email ? 'email_turns' : 'turns'}`, email ? cap.turnsPerEmailSender : cap.turnsPerPerson)).ok) return { ok: false, global: false };
    if (email && !verifiedEmail) {
      const domain = registrableDomain(meta.email ?? meta.conversationId);
      if (domain && !(await count(this.env, `domain:${await addressHash(domain)}:email_turns`, cap.turnsPerEmailDomain)).ok) return { ok: false, global: false };
      if (!(await count(this.env, 'global:turns:general', cap.turnsGeneralPerDay)).ok) return { ok: false, global: true };
      return { ok: true, global: false };
    }
    if (email && verifiedEmail && meta.userId && !(await count(this.env, `user:${meta.userId}:turns`, cap.turnsPerPerson)).ok) return { ok: false, global: false };
    // The workspace the conversation is about (a chat's, or the one a verified email chose): all its people together.
    if (meta.workspace && !(await count(this.env, `workspace:${meta.workspace.id}:turns`, cap.turnsPerWorkspace)).ok) return { ok: false, global: false, workspace: true };
    if (!(await count(this.env, 'global:turns', cap.turnsPerDay)).ok) { await alertOnce(this.env, 'turns', cap.turnsPerDay); return { ok: false, global: true }; }
    return { ok: true, global: false };
  }
  /**
   * The conversation so far as the team's ticket email quotes it (tickets.ts): every message as written, but no notice and
   * no held answer (what the gate or a narrowed scope held stays in the staff inbox, out of email).
   */
  ticketMessages(): TicketMessage[] {
    return this.sql.exec<{ role: Transcript['role']; text: string; at: string }>("SELECT role, text, at FROM _support_transcript WHERE coalesce(kind, '') NOT IN ('notice', 'waiting', 'status', 'unanswered', 'held', 'ticket_note') ORDER BY seq").toArray()
      .map(r => ({ who: r.role === 'user' ? 'customer' as const : r.role === 'staff' ? 'staff' as const : 'agent' as const, at: r.at, text: r.text }));
  }
  /**
   * `pool`: 'caps' counts a new ticket against the ticket caps (the person's 3 a day, everyone's 60); 'passed' is a chat
   * message the agent couldn't answer (passToTeam), which counts against neither, so a model outage never uses up the
   * tickets the agent's own escalations and verified emails need. Those stay bounded by one ticket per conversation, the
   * person's open conversations and the staff email throttle. `note`: added to an existing ticket, it is mirrored as a
   * ticket note (false: the customer's email it adds is in the timeline already).
   */
  async harnessTicket(meta: Meta, input: TicketInput, dmarc: string | null = null, pool: 'caps' | 'passed' = 'caps', note = true): Promise<ReturnType<typeof fileTicket> extends Promise<infer T> ? T & { refused?: 'person' | 'global' } : never> {
    const ctx = await this.ticketCtx(meta, dmarc);
    // A new ticket counts against the person's cap and its budget (verified customers have their own reserve: R1);
    // adding to an existing one doesn't.
    const exists = await this.env.DB.prepare('SELECT id FROM tickets WHERE conversation_id = ?').bind(meta.conversationId).first();
    if (!exists && pool === 'caps') {
      // A chat's person, or the person Nightmail bound an email conversation to; any other email ticket counts against its
      // sender's address.
      const verifiedUserId = ticketPerson(meta);
      const allowed = await ticketAllowed(this.env, { verifiedUserId, mailbox: 'support', sender: meta.email, dmarcPass: dmarc === 'PASS' });
      if (!allowed.ok) { log('warn', { event: 'ticket', code: 'TICKET_CAP', scope: allowed.scope, reason: allowed.reason }); return { id: '', created: false, dueAt: 0, replyTo: null, refused: allowed.scope }; }
    }
    const filed = await fileTicket(this.env, ctx, input);
    // Added to the ticket it already has: the staff inbox hears of it as a ticket note (what was filed and what they
    // asked), which brings a resolved ticket or a conversation marked done back to Needs you. A customer's own email
    // (`note` false) is in the timeline already.
    if (!filed.created && note) this.record({ id: newId('msg'), role: 'assistant', kind: 'ticket_note', text: ticketNote(filed.id, input), at: new Date().toISOString(), tools: [] });
    if (filed.created) {
      // Emailing the team and, for a chat, opening the customer's follow-up thread are work of their own, retried until
      // sent. Each is the request built now (its screenshot links signed once), from the address configured now.
      const category = input.details.topic ?? input.type, expect = expectation(input);
      // A conversation Nightmail registered: the ticket reaches the team through Nightmail's staff mail (one thread per
      // conversation, api/src/support-staff-mail.ts), from the brief mirrored with it, and the row says it was handed
      // over. Any other (from before registration) is emailed from here, as before.
      if (meta.registered) await this.env.DB.prepare('UPDATE tickets SET notified_at = ? WHERE id = ? AND notified_at IS NULL').bind(Date.now(), filed.id).run();
      this.ctx.storage.transactionSync(() => {
        this.update(m => { m.ticketId = filed.id; m.status = 'ticketed'; m.ticket = { id: filed.id, type: input.type, severity: input.severity, category, replyTo: filed.replyTo, expect, brief: briefOf(input) }; });
        if (!meta.registered) this.work.insert({ kind: 'notify', id: `notify:${filed.id}`, payload: { ticketId: filed.id, key: `ticket-${filed.id}`,
          input: { addressId: this.env.SUPPORT_ADDRESS_ID, to: [this.env.TICKET_TO], ...ticketEmail(this.env, ctx, filed, input, this.ticketMessages()) } } satisfies Notify });
        if (meta.channel === 'chat') this.work.insert({ kind: 'followup', id: `followup:${filed.id}`, payload: { addressId: this.env.SUPPORT_ADDRESS_ID, ctx, ticket: filed } satisfies FollowUp });
      });
      log('info', { event: 'ticket', code: 'TICKET_FILED', ticket: filed.id, type: input.type, channel: meta.channel });
      this.mirrorSoon();
      await this.arm();
      if (meta.channel === 'chat') this.broadcast({ type: 'ticket.filed', ticketId: filed.id, ticketType: input.type, category, replyTo: filed.replyTo, expect });
    }
    return filed;
  }
  /**
   * Where replies to a message are sent from, and under which key. Chosen once, when the reply is queued, so a retry never
   * switches sender or key: SUPPORT_ADDRESS_ID when the message reached it, else the address it came in on (another
   * support address the key also holds, such as the one before a move) under a key of its own.
   */
  route(message: Snapshot, messageId: string, purpose: 'reply'): Route {
    const key = `${purpose}-${messageId}`, own = this.env.SUPPORT_ADDRESS_ID;
    if (own && message.addressIds && !message.addressIds.includes(own)) return { addressId: null, key: `${key}:received` };
    return { addressId: own || null, key };
  }
  /** A fresh model session for a general turn, so nothing an account turn read reaches it (the conversation goes on). */
  async freshSession() {
    this.context = null;
    this.sql.exec('DELETE FROM _support_theirs');
    this.update(m => { m.accountRead = false; });
    await this.ctx.storage.delete(['support:opencode-session', 'support:opencode-tools']);
  }
  async ticketCtx(meta: Meta, dmarc: string | null = null): Promise<TicketContext> {
    const attachments = await Promise.all(this.attachments().map(async a => ({ id: a.id, name: a.name, type: a.type, size: a.size, url: await attachmentLink(this.env, meta.conversationId, a) })));
    // A chat's ticket is its person's (the handoff Nightmail registered it from), and a bound email conversation's the
    // person Nightmail stamps (its scope: never an address). Any other email ticket names no account, only the address that
    // wrote (M3), whatever an older conversation stored.
    const verified = ticketPerson(meta) ? meta.verified as 'handoff' | 'dmarc' | 'signin' | 'agent' : null;
    return { conversationId: meta.conversationId, channel: meta.channel, threadId: meta.threadId, costUsd: spentUsd(meta), model: MODEL_LABEL, attachments, verified, dmarc, sender: verified ? null : meta.email,
      customer: verified ? { userId: meta.userId, email: meta.email, name: meta.name, role: meta.role, workspaces: meta.workspace ? [meta.workspace] : meta.workspaces.map(w => ({ id: w.id, name: w.name })) }
        : { userId: null, email: null, name: null, role: null, workspaces: [] } };
  }
  attachments(): Attachment[] {
    return this.sql.exec<{ id: string; key: string; type: string; size: number; width: number | null; height: number | null; source: Attachment['source']; name: string }>('SELECT id, key, type, size, width, height, source, name FROM _support_attachments ORDER BY created_at').toArray();
  }
  /** Images the model sees with this turn, and the notes for those it can't (too large to send). */
  async turnImages(ids: string[]) {
    const all = this.attachments(), images: { uri: string; name: string }[] = [], notes: string[] = [];
    for (const id of ids) {
      const a = all.find(x => x.id === id);
      if (!a) continue;
      const image = await modelImage(this.env, a);
      if (image) images.push(image); else notes.push(`${fileName(a.name)} is too large for you to view; it is kept for the team and attaches to any ticket.`);
    }
    return { images, notes };
  }
  idle(meta: Meta) { return meta.channel === 'chat' ? CHAT_IDLE_MS : EMAIL_IDLE_MS; }
  /**
   * The conversation's own next step for the alarm, beside its work: the idle close (now, if it has passed), then the
   * deletion after retention. Past retention with work left there is none: the work's due times set the alarm.
   */
  deadline() {
    const meta = this.meta();
    if (!meta) return null;
    const own = !meta.closedAt ? meta.lastActivity + this.idle(meta) : meta.closedAt + KEEP_AFTER_CLOSE_MS > Date.now() || !this.work.open() ? meta.closedAt + KEEP_AFTER_CLOSE_MS : null;
    // A mirror that failed is retried at its time, beside the rest; so is the next check of an answer parked for a sign-in.
    const parked = meta.status === 'closed' ? null : this.sql.exec<{ due: number | null }>("SELECT min(due_at) AS due FROM _support_work WHERE kind = 'answer' AND state = 'parked' AND json_extract(payload, '$.signin') = 1").one().due;
    return [own, meta.mirrorDueAt ?? null, parked].reduce<number | null>((soonest, at) => at === null ? soonest : soonest === null ? at : Math.min(soonest, at), null);
  }
  arm() { return this.work.arm(this.deadline()); }
  /**
   * Closes the conversation here, and durably with Nightmail: the `close` item is stored with the local closure, before
   * anything is acknowledged, and retried until Nightmail says closed (or never knew it). Retention waits for it.
   */
  async close(reason: 'idle' | 'limit' | 'ended') {
    this.ctx.storage.transactionSync(() => {
      this.update(m => { m.status = 'closed'; m.closedAt ??= Date.now(); });
      this.work.insert({ kind: 'close', id: 'close', payload: {} });
      // Answers still waiting for their sender's sign-in are never answered now: held, for the team.
      this.sql.exec("UPDATE _support_work SET state = 'held', updated_at = ? WHERE kind = 'answer' AND state = 'parked'", Date.now());
    });
    this.context = null;
    // A turn still running stops, chat or email: nothing more it calls (an action included) runs, and its answer isn't
    // kept (an email's is withheld before it sends: releasable).
    this.abort?.abort();
    this.emailTurn?.stop.abort();
    this.broadcast({ type: 'closed', reason });
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'closed'); } catch { /* gone */ } }
    // Tried now; the alarm retries it.
    try { await this.closeRemote(); this.sql.exec("UPDATE _support_work SET state = 'done', last_error = NULL, updated_at = ? WHERE id = 'close' AND state IN ('pending', 'blocked')", Date.now()); }
    catch (error) { logError(error, { event: 'support', code: 'CLOSE_FAILED' }, 'warn'); }
    await this.arm();
  }
  /** Nightmail refuses every later request for the conversation, and D1 says closed. */
  async closeRemote() {
    const meta = this.meta()!;
    const closed = await external(this.env.BANE.closeConversation(this.own()));
    if (closed.status !== 200 && closed.status !== 404) throw platformError(closed, 'CLOSE_FAILED');
    await external(this.env.DB.prepare("UPDATE conversations SET status = 'closed', closed_at = coalesce(closed_at, ?), updated_at = ? WHERE id = ?").bind(meta.closedAt, Date.now(), meta.conversationId).run());
  }
  /** Opened before the stamp and bound to a person (an account or a verification Nightmail never registered). */
  beforeStamp(meta: Meta) { return !meta.registered && (!!meta.userId || !!meta.verified || !!meta.retired); }
  /**
   * Retires a conversation from before the stamp, once: none of its unsent answers is ever sent (each is held, and the
   * team gets one email listing them), its model session ends, and it closes like any other.
   */
  async retireLegacy() {
    const meta = this.meta()!;
    if (meta.retired) return;
    const open = this.sql.exec<{ id: string; payload: string; result: string }>("SELECT id, payload, result FROM _support_work WHERE kind = 'answer' AND state IN ('pending', 'blocked', 'parked') ORDER BY created_at").toArray();
    const drafts = open.map(row => {
      const { messageId } = JSON.parse(row.payload) as { messageId: string }, done = JSON.parse(row.result) as Composed;
      const text = typeof done.text === 'string' ? done.text : typeof done.model === 'string' ? done.model : null;
      return `- Message ${messageId}: ${text ? `a draft, never sent:\n\n${text.slice(0, 1500).replace(/^/gm, '    ')}` : 'not answered yet.'}`;
    });
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE _support_work SET state = 'held', updated_at = ? WHERE kind = 'answer' AND state IN ('pending', 'blocked', 'parked')", now);
      this.sql.exec("UPDATE _support_work SET state = 'done', updated_at = ? WHERE kind = 'confirm' AND state IN ('pending', 'blocked', 'parked')", now);
      if (drafts.length) this.work.insert({ kind: 'alert', id: 'alert:held', payload: { key: `held-${meta.conversationId}`, input: { addressId: this.env.SUPPORT_ADDRESS_ID, to: [this.env.TICKET_TO],
        subject: `[${productName} support] Unsent answers held in ${meta.conversationId}`,
        text: [`A support conversation from before the current release had ${drafts.length} unsent answer${drafts.length > 1 ? 's' : ''}. None was sent, and the conversation is closed. Reply to the customer in the thread if they still need an answer.`, '',
          `Conversation: ${meta.conversationId}`, `Thread: ${meta.threadId ?? 'none'}`, `Channel: ${meta.channel}`, '', ...drafts].join('\n') } } satisfies Alert });
      this.update(m => { m.retired = true; });
    });
    log('warn', { event: meta.channel, code: 'LEGACY_RETIRED', conversation: meta.conversationId, held: drafts.length });
    await this.retireModel();
    if (meta.status !== 'closed') await this.close('ended');
    else { this.work.insert({ kind: 'close', id: 'close', payload: {} }); await this.arm(); }
  }
}
