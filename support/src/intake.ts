import { DurableObject } from 'cloudflare:workers';
import { baneApi, BaneError, senderOf, type InboundMessage } from './bane.js';
import type { Env } from './env.js';
import { attachmentLink, safeName, storeImage } from './attachments.js';
import { cleanImage, ImageRejected, IMAGE_TYPES, MAX_IMAGE_BYTES } from './image.js';
import { countToday, holdOverCap, mailAllowed, ticketAllowed } from './limits.js';
import { fileTicket, INTAKE_MODEL, ticketEmail, type FiledTicket, type TicketContext } from './tickets.js';
import type { TicketInput, TicketType } from './agent/tools.js';
import { addressHash, MissingSecret, newId } from './tokens.js';
import { external, WorkQueue, type NewWork, type Outcome, type WorkRow } from './work.js';
import { productName } from '../../api/src/brand.js';

// abuse@, privacy@ and legal@ (owner decision): straight into the ticket system, never to the AI agent and never
// forwarded. One SupportIntake object per Nightmail thread at those addresses; there is no OpenCode here and no model call.
// Each message becomes (or adds to) one typed ticket with the sender and its DMARC/verification result, the subject and
// text (as untrusted quotes), image attachments checked and stripped like screenshots (other files are listed, to be
// opened in Nightmail's inbox), an email to the team, and one fixed acknowledgement per sender per day. Same caps as the
// support address (review M5).

export const INTAKE = { abuse: { type: 'abuse_report', severity: 'P3', label: 'abuse' }, privacy: { type: 'privacy', severity: 'P2', label: 'privacy' }, legal: { type: 'legal', severity: 'P2', label: 'legal' } } as const;
export type Mailbox = keyof typeof INTAKE;
const MAX_FILES = 5;
const MAX_IMAGE_ATTEMPTS = 3; // Optional evidence, not a retry limit on the message or any of its obligations.
type Incoming = { threadId: string; messageId: string; mailbox: Mailbox; address?: string | null };
type Decision = {
  message?: InboundMessage; admission?: Awaited<ReturnType<typeof mailAllowed>>;
  charges?: Record<string, Awaited<ReturnType<typeof countToday>>>;
  parts?: Record<string, string>; attachments?: TicketContext['attachments']; imageFailures?: Record<string, number>;
  ticket?: { id: string } | { reason: string };
};
type Ticket = { ctx: TicketContext; input: TicketInput; ticketId: string; messageId: string };
/**
 * An intake ticket names no account, only the sender as contact data. A ticket item an earlier build queued may still
 * carry the customer it looked up from the sender's address: whatever the payload says, that is dropped here.
 */
const unowned = (ctx: TicketContext): TicketContext => ({ ...ctx, verified: null, sender: ctx.sender ?? ctx.customer?.email ?? null,
  customer: { userId: null, email: null, name: null, role: null, workspaces: [] } });
type Send = { path: string; body: object; key: string };
type Receipt = { id: string; due_at: number; notified_at: number | null; evidence: string; notes: string };

export class SupportIntake extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly work: WorkQueue;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS intake_meta (id INTEGER PRIMARY KEY CHECK (id = 1), conversation_id TEXT NOT NULL)');
    this.work = new WorkQueue(ctx.storage, { db: env.DB, flow: 'intake', object: ctx.id.toString() });
    if (this.importLegacy()) ctx.blockConcurrencyWhile(() => this.work.arm());
  }

  /**
   * The earlier inbox (`intake_inbox`, from the builds before the work queue): each row becomes a message once, finished
   * ones kept for webhook dedupe, in one transaction with dropping the table. Old 'failed' meant retries exhausted: it runs
   * again under the queue's rules. A row queued before the address it was sent to was kept names the team instead.
   */
  private importLegacy() {
    if (!this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'intake_inbox'").toArray().length) return false;
    const address = this.sql.exec("SELECT 1 FROM pragma_table_info('intake_inbox') WHERE name = 'address'").toArray().length ? 'address' : 'NULL';
    return this.ctx.storage.transactionSync(() => {
      const imported = this.sql.exec(`INSERT INTO _support_work(id,kind,state,payload,due_at,attempts,created_at,updated_at)
        SELECT 'msg:'||message_id,'message',CASE WHEN state IN ('done','held') THEN state ELSE 'pending' END,
          json_object('messageId',message_id,'threadId',thread_id,'mailbox',mailbox,'address',${address}),received_at,attempts,received_at,?
        FROM intake_inbox WHERE NOT EXISTS (SELECT 1 FROM _support_work WHERE id='msg:'||message_id)`, Date.now()).rowsWritten > 0;
      this.sql.exec('DROP TABLE intake_inbox');
      return imported;
    });
  }

  async enqueue(input: Incoming) {
    this.work.insert({ id: `msg:${input.messageId}`, kind: 'message', payload: input });
    await this.work.arm();
    return { ok: true };
  }

  /** The sweep (replay.ts), once a key covers its addresses again: blocked work runs now. */
  async retryBlocked() {
    const woken = this.work.retryBlocked();
    await this.work.arm();
    return { woken };
  }

  override async alarm() {
    await this.work.drain(item => this.run(item), () => {});
  }

  private async run(item: WorkRow): Promise<Outcome> {
    const payload = JSON.parse(item.payload);
    switch (item.kind) {
      case 'message': return this.decide(item, payload);
      case 'ticket': return this.ticket(item, payload);
      case 'ack': await this.send(payload, this.env.BANE_INTAKE_INBOX_KEY, 'BANE_INTAKE_INBOX_KEY'); return {};
      case 'notify': {
        const { ticketId, request } = payload;
        const row = await external(this.env.DB.prepare('SELECT notified_at FROM tickets WHERE id=?').bind(ticketId).first<{ notified_at: number | null }>());
        if (!row) throw new Error('Missing ticket');
        if (row.notified_at === null) {
          await this.send(request, this.env.BANE_SUPPORT_INBOX_KEY, 'BANE_SUPPORT_INBOX_KEY');
          await external(this.env.DB.prepare('UPDATE tickets SET notified_at=? WHERE id=?').bind(Date.now(), ticketId).run());
        }
        return {};
      }
      default: throw new Error('Unknown work kind');
    }
  }

  /** The route, recipients, sender and key come from storage, never from today's configuration. Only credentials rotate. */
  private async send(request: Send, credential: string | undefined, secret: string) {
    if (!credential) throw new MissingSecret(secret);
    const response = await external(this.env.BANE_API.fetch(`${this.env.BANE_ORIGIN}${request.path}`, { method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'idempotency-key': request.key, 'user-agent': 'bane-support' }, body: JSON.stringify(request.body) }));
    if (!response.ok) {
      const body = await response.json<{ error?: { code?: string; requestId?: string } }>().catch(() => null);
      throw new BaneError(response.status, body?.error?.code ?? 'BANE_ERROR', 'Intake send failed', body?.error?.requestId ?? response.headers.get('x-request-id'), response.headers.get('retry-after'));
    }
    await response.body?.cancel();
  }

  private receipt(conversationId: string) {
    return external(this.env.DB.prepare('SELECT id,due_at,notified_at,evidence,notes FROM tickets WHERE conversation_id=?').bind(conversationId).first<Receipt>());
  }

  private async ticket(item: WorkRow, queued: Ticket): Promise<Outcome> {
    const { input, ticketId, messageId } = queued, ctx = unowned(queued.ctx);
    let row = await this.receipt(ctx.conversationId);
    // The first message is in evidence; subsequent messages are in notes. Either D1 write may have committed
    // before this object observed its response. Never append another copy on retry.
    if (!row || !(JSON.parse(row.evidence).ids?.includes(messageId) || JSON.parse(row.notes).some((n: { details?: { messageId?: string } }) => n.details?.messageId === messageId))) {
      const details = { ...input.details, messageId };
      await external(fileTicket(this.env, ctx, row ? { ...input, details } : input, item.created_at, ticketId));
      row = await this.receipt(ctx.conversationId);
    }
    if (!row) throw new Error('Missing ticket');
    const result = { ticketId: row.id };
    if (row.notified_at !== null) return { result };
    return { result, children: [this.notify({ id: row.id, dueAt: row.due_at }, ctx, input)] };
  }

  /** The team's email for a ticket, built now and sent as built on every try. */
  private notify(ticket: Pick<FiledTicket, 'id' | 'dueAt'>, ctx: TicketContext, input: TicketInput): NewWork {
    if (!this.env.SUPPORT_ADDRESS_ID || !this.env.TICKET_TO) throw new BaneError(503, 'SUPPORT_NOT_CONFIGURED', 'Missing ticket mail route');
    const request: Send = { path: '/v1/inbound/threads', key: `ticket-${ticket.id}`, body: { addressId: this.env.SUPPORT_ADDRESS_ID, to: [this.env.TICKET_TO], ...ticketEmail(this.env, ctx, ticket, input) } };
    return { kind: 'notify', id: `notify:${ticket.id}`, payload: { ticketId: ticket.id, request } };
  }

  /**
   * The cron sweep (ledger.ts): a ticket's team email that no item here covers (filed before this queue), rebuilt from
   * its D1 row. An existing item, in any state, is left as it is.
   */
  async ensure({ ctx, input, ticket }: { ctx: TicketContext; input: TicketInput; ticket: FiledTicket }) {
    const added = this.work.insert(this.notify(ticket, ctx, input));
    if (added) await this.work.arm();
    return { added };
  }

  /** The conversation row a thread's ticket hangs off (tickets.conversation_id), created once. */
  private async conversationId(threadId: string) {
    const known = this.sql.exec<{ conversation_id: string }>('SELECT conversation_id FROM intake_meta WHERE id = 1').toArray()[0]?.conversation_id;
    if (known) return known;
    const id = newId('conv'), now = Date.now();
    await this.env.DB.prepare("INSERT INTO conversations (id, channel, thread_id, status, created_at, updated_at) VALUES (?, 'email', ?, 'ticketed', ?, ?) ON CONFLICT (thread_id) DO NOTHING").bind(id, `intake:${threadId}`, now, now).run();
    const row = await this.env.DB.prepare('SELECT id FROM conversations WHERE thread_id = ?').bind(`intake:${threadId}`).first<{ id: string }>();
    this.sql.exec('INSERT INTO intake_meta (id, conversation_id) VALUES (1, ?) ON CONFLICT (id) DO NOTHING', row!.id);
    return row!.id;
  }

  private async decide(item: WorkRow, next: Incoming): Promise<Outcome> {
    const { messageId, threadId, mailbox } = next, api = baneApi(this.env, 'intake');
    const progress: Decision = JSON.parse(item.result), save = () => this.work.checkpoint(item.id, progress);
    if (!progress.message) {
      // Retain only what the decision uses, not an unbounded body or the full headers.
      const m = await external(api.message(messageId));
      progress.message = { id: m.id, direction: m.direction, threadId: m.threadId, subject: m.subject?.slice(0, 200) ?? null,
        from: senderOf(m), authentication: m.authentication, automated: m.automated, messageId: m.messageId, text: m.text?.slice(0, 4000), attachments: m.attachments };
      save();
    }
    const message = progress.message;
    const sender = senderOf(message) ?? 'unknown', hash = await addressHash(sender);
    const dmarc = String(message.authentication?.dmarc ?? 'NONE').toUpperCase(), dmarcPass = dmarc === 'PASS';
    const count: typeof countToday = async (env, key, limit) => {
      const charges = progress.charges ??= {};
      if (!charges[key]) { charges[key] = await external(countToday(env, key, limit)); save(); }
      return charges[key];
    };
    const hold = async (reason: string) => {
      if (await external(this.env.DB.prepare('SELECT 1 FROM overflow WHERE message_id=? AND channel=? AND reason=?').bind(messageId, mailbox, reason).first())) return;
      await external(holdOverCap(this.env, { channel: mailbox, reason, sender, dmarc, subject: message.subject, text: message.text ?? null, messageId, threadId }, count));
    };
    if (!progress.admission) { progress.admission = await external(mailAllowed(this.env, mailbox, sender, dmarcPass, count)); save(); }
    const result = { admission: progress.admission };
    if (!progress.admission.ok) { await hold(progress.admission.reason); return { state: 'held', result }; }
    const automatic = message.automated === true || /^(?:mailer-daemon|postmaster|no-?reply|bounces?)@/i.test(sender);
    // Who wrote: only the address and its DMARC verdict, as contact data. Intake mail never names an account, whoever owns
    // the address: the ticket shows an unverified sender.
    const verified: TicketContext['verified'] = null, customer: TicketContext['customer'] = { userId: null, email: null, name: null, role: null, workspaces: [] };
    const conversationId = await external(this.conversationId(threadId));
    // Attachments: images like screenshots (checked, stripped, 5 MB, 5 per thread); other files are listed only.
    const files = message.attachments ?? [], stored: { id: string; name: string; type: string; size: number; url: string }[] = [], listed: string[] = [];
    const parts = progress.parts ??= {}, failures = progress.imageFailures ??= {};
    let already: number | undefined, omitted = 0;
    for (const part of files) {
      const name = safeName(part.filename, 'attachment');
      const description = `${name} (${String(part.contentType).slice(0, 60)}, ${Math.ceil(part.size / 1024)} KB)`;
      if (!(IMAGE_TYPES as readonly string[]).includes(String(part.contentType).toLowerCase()) || part.size > MAX_IMAGE_BYTES) { listed.push(description); continue; }
      if ((failures[part.id] ?? 0) >= MAX_IMAGE_ATTEMPTS) { omitted++; continue; }
      try {
        const saved = progress.attachments?.find(a => a.id === parts[part.id]);
        if (saved) { stored.push(saved); continue; }
        if (already === undefined) {
          const { objects } = await external(this.env.UPLOADS.list({ prefix: `conversations/${conversationId}/` }));
          already = objects.filter(o => !Object.values(parts).some(id => o.key.startsWith(`conversations/${conversationId}/${id}.`))).length;
        }
        if (already + stored.length >= MAX_FILES) { listed.push(description); continue; }
        const bytes = await external(api.part(messageId, part.id, MAX_IMAGE_BYTES));
        if (!bytes) { listed.push(`${name} (too large)`); continue; }
        const clean = cleanImage(bytes);
        if (!parts[part.id]) { parts[part.id] = newId('att'); save(); }
        const id = parts[part.id]!, url = await attachmentLink(this.env, conversationId, { id });
        const image = await external(storeImage(this.env, conversationId, id, clean, 'email', name));
        const attachment = { id, name: image.name, type: image.type, size: image.size, url };
        stored.push(attachment); (progress.attachments ??= []).push(attachment); save();
      } catch (e) {
        const permanent = e instanceof ImageRejected || (e instanceof BaneError && [404, 410].includes(e.status));
        failures[part.id] = permanent ? MAX_IMAGE_ATTEMPTS : (failures[part.id] ?? 0) + 1;
        save();
        if (failures[part.id]! < MAX_IMAGE_ATTEMPTS) throw e;
        omitted++;
      }
    }
    const config = INTAKE[next.mailbox], text = (message.text ?? '').slice(0, 4000), subject = (message.subject ?? '(no subject)').replace(/[\r\n]+/g, ' ').trim();
    const input: TicketInput = {
      type: config.type as TicketType, title: subject.slice(0, 80) || '(no subject)', severity: config.severity, ask: text.slice(0, 600),
      summary: `An email to ${next.mailbox}@ (filed without the AI agent). Subject: “${subject.slice(0, 200)}”.\n\n${text.slice(0, 900)}`,
      tried: [], recommendation: `Read it in ${productName}’s inbox (${mailbox}@ thread ${threadId}) and reply there.${omitted ? ` ${omitted === 1 ? 'One attachment' : `${omitted} attachments`} could not be stored.` : ''}${listed.length ? ` Other attachments, not opened here: ${listed.join('; ')}.` : ''}${automatic ? ' It was sent automatically (no acknowledgement was sent).' : ''}`,
      evidence: { ids: [messageId] }, details: { topic: mailbox },
    };
    const ctx: TicketContext = { conversationId, channel: 'email', threadId, costUsd: 0, model: INTAKE_MODEL, attachments: stored, verified, dmarc, sender, customer };
    // Tickets come from separate budgets (R1): this address's own budget, by sender, so spoofed abuse@ mail can't use up
    // legal@, privacy@ or a customer's escalation.
    const children: NewWork[] = [];
    // Two messages can be due before the first ticket item runs. Reserve only one ticket ID and budget slot per thread.
    if (!progress.ticket) {
      const existing = await this.receipt(conversationId);
      const reserved = this.sql.exec<{ id: string }>("SELECT json_extract(result,'$.ticket.id') AS id FROM _support_work WHERE kind='message' AND json_extract(result,'$.ticket.id') IS NOT NULL LIMIT 1").toArray()[0]?.id;
      if (existing || reserved) progress.ticket = { id: existing?.id ?? reserved! };
      else {
        const allowed = await external(ticketAllowed(this.env, { verifiedUserId: null, mailbox, sender, dmarcPass }, count));
        progress.ticket = allowed.ok ? { id: newId('tkt') } : { reason: allowed.reason };
      }
      save();
    }
    const ticketId = 'id' in progress.ticket ? progress.ticket.id : null;
    if ('reason' in progress.ticket) await hold(progress.ticket.reason);
    if (ticketId) children.push({ kind: 'ticket', id: `ticket:${conversationId}:${messageId}`, payload: { ticketId, messageId, ctx, input } satisfies Ticket });
    // One fixed acknowledgement per sender per mailbox per day; never to automatic mail.
    if (!automatic && (await count(this.env, `sender:${hash}:ack:${mailbox}`, 1)).ok) {
      // Named for the address it was sent to, and sent from it (addressId null). A message queued before the address was
      // kept names the team instead, never an address it may not have been sent to.
      const wrote = next.address ?? `${productName}’s ${INTAKE[next.mailbox].label} team`;
      const text = `Hi,\n\nThanks for writing to ${wrote}. We've received your message${ticketId ? ` and logged it as ${ticketId}` : ''}. A person at ${productName} will reply by email.\n\n${productName}`;
      children.push({ kind: 'ack', id: `ack:${messageId}`, payload: { path: `/v1/inbound/threads/${encodeURIComponent(message.threadId ?? threadId)}/reply`, key: `ack-${messageId}`,
        body: { replyToMessageId: messageId, text, to: [sender], cc: [], expectedRecipients: { to: [sender], cc: [], bcc: [] }, subject: `Re: your message to ${wrote}` } } satisfies Send });
    }
    return { state: ticketId ? 'done' : 'held', result: { ...result, ticket: progress.ticket }, children };
  }
}
