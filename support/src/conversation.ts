import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';
import { openFollowUp, ticketEmail, type FiledTicket, type TicketContext } from './tickets.js';
import { external, type Outcome, type WorkRow } from './work.js';
import type { TicketInput } from './agent/tools.js';
import { deleteConversationUploads } from './attachments.js';
import { nightmailApi, type FiledConversation, type AgentAnswer, type Handoff } from './nightmail.js';
import { KEEP_AFTER_CLOSE_MS, type Alert, type Meta, type Notify, type FollowUp, type StaffReply } from './conversation/state.js';
import { ConversationStore } from './conversation/store.js';
import { Access } from './conversation/actions.js';
import { Inbox } from './conversation/inbox.js';
import { Chat } from './conversation/chat.js';
import { Email } from './conversation/email.js';
export { adoptFiledChat } from './conversation/inbox.js';

// One support conversation (chat or email) per Durable Object (design §1). It holds:
// - its conversation ID, the only identity it ever passes to Nightmail: Nightmail registered the conversation from its own
//   evidence (a handoff, or a message it received). The account is read through it: Nightmail derives the person from
//   that row on every request (the stamp). The ID comes from this object's storage, never from a tool argument, model
//   output, frame or header. An email conversation reads an account only once Nightmail bound it, from the message itself
//   (an aligned DMARC pass of the account's own verified address) or from its sender's signed-in confirmation of that one
//   message; it only reads (by role), never changes anything, keeps no notes and reads no content. Every answer it writes
//   for that person goes only after a release check: open here and with Nightmail, no less access than the turn ran with,
//   and the recipient still the account's verified address. Any other email gets general answers with a line pointing to
//   Help, or (unproven) a fixed reply with a sign-in for that message, its answer parked until that sign-in;
// - the transcript the panel sees, pending consent, a chat's proposed changes (by ID only: Nightmail keeps them, the
//   person decides them on the card, signed in, and every card and outcome is read again from Nightmail), and its work
//   (work.ts): each email, its answer or forward, and each ticket's team email and follow-up are items of their own,
//   retried until done without blocking the others;
// - the agent (OpenCode, agent/opencode.ts), whose tools are closures over this object's stamp, offered per turn
//   (toolNames): a chat's by role, a verified email's reads by role with reply and file_ticket, any other email's only
//   reply and file_ticket; an email answers through reply, once;
// - its place in Nightmail's staff inbox (api/src/support-inbox.ts): every transcript entry and the conversation's state
//   are mirrored there in order (a cursor over the transcript, retried until Nightmail has them), staff replies arrive as
//   `staff:` work items (a wake from Nightmail, or the five-minute sweep), and while staff have paused the agent it
//   records and mirrors what the customer writes but takes no turn and sends no answer (checked before each).
// A conversation opened before the stamp never reads again: its next email goes to a fresh, stamped conversation, its
// unsent answers are held for the team, and it closes (retireLegacy). The protocol to the panel is support/PROTOCOL.md.
//
// The pieces, each importing only the ones before it: conversation/state.ts (state, codecs, copy) → store.ts (storage,
// transcript, lifecycle) → actions.ts (the stamp, access checks, proposals, the agent's tools) → inbox.ts (the staff
// inbox, sign-ins and releases) → chat.ts and email.ts. This class only wires them to the Durable Object's entry points.

export class SupportConversation extends DurableObject<Env> {
  private readonly s: ConversationStore;
  private readonly i: Inbox;
  private readonly c: Chat;
  private readonly e: Email;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.s = new ConversationStore(ctx, () => this.env);
    const a = new Access(this.s);
    this.i = new Inbox(this.s, a);
    this.c = new Chat(this.s, a, this.i);
    this.e = new Email(this.s, a, this.i);
    // Only our own tables here, so opening a chat never waits on OpenCode: it boots in the background (warm()).
    void ctx.blockConcurrencyWhile(async () => { this.s.createTables(); const imported = this.s.importLegacy(), settled = this.s.settleParked(); if (imported || settled) await this.s.arm(); });
  }
  protected get work() { return this.s.work; }
  protected meta() { return this.s.meta(); }
  protected save(meta: Meta) { this.s.save(meta); }

  openChat(input: { conversationId: string; handoff: Handoff; token: string }) { return this.c.openChat(input); }
  admits(input: { userId: string }) { return this.c.admits(input); }
  addAttachment(input: Parameters<Chat['addAttachment']>[0]) { return this.c.addAttachment(input); }
  override fetch(request: Request) { return this.c.fetch(request); }
  override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) { return this.c.webSocketMessage(ws, raw); }
  override webSocketClose(ws: WebSocket, code: number) { return this.c.webSocketClose(ws, code); }
  startAgentAnswer(p: AgentAnswer) { return this.e.startAgentAnswer(p); }
  enqueueInbound(input: Parameters<Email['enqueueInbound']>[0]) { return this.e.enqueueInbound(input); }
  adoptFiled(f: FiledConversation) { return this.i.adoptFiled(f); }
  takeFiled() { return this.i.takeFiled(); }
  wake() { return this.i.wake(); }
  deliver(input: { replies: (StaffReply & { conversationId?: string })[] }) { return this.i.deliver(input); }

  /**
   * The cron sweep (ledger.ts): a ticket's team email or chat follow-up that no item here covers (filed before this queue),
   * rebuilt from its D1 row. An existing item, in any state, is left as it is. A conversation already deleted after its
   * retention comes back closed, only to send it.
   */
  async ensure({ kind, ctx, input, ticket }: { kind: 'notify' | 'followup'; ctx: TicketContext; input: TicketInput; ticket: FiledTicket }) {
    if (!this.s.meta()) this.s.save({ ...this.s.fresh(ctx.conversationId, ctx.channel), status: 'closed', closedAt: Date.now(), ticketId: ticket.id });
    // Nightmail's staff mail tells the team about a conversation it registered (harnessTicket): only the row is marked.
    if (kind === 'notify' && this.s.meta()!.registered) {
      await this.env.DB.prepare('UPDATE tickets SET notified_at = ? WHERE id = ? AND notified_at IS NULL').bind(Date.now(), ticket.id).run();
      return { added: false };
    }
    const added = this.s.work.insert(kind === 'notify'
      ? { kind, id: `notify:${ticket.id}`, payload: { ticketId: ticket.id, key: `ticket-${ticket.id}`, input: { addressId: this.env.SUPPORT_ADDRESS_ID, to: [this.env.TICKET_TO], ...ticketEmail(this.env, ctx, ticket, input) } } satisfies Notify }
      : { kind, id: `followup:${ticket.id}`, payload: { addressId: this.env.SUPPORT_ADDRESS_ID, ctx, ticket } satisfies FollowUp });
    if (added) await this.s.arm();
    return { added };
  }
  /** The sweep (replay.ts), once a key covers its addresses again: blocked work runs now. */
  async retryBlocked() {
    if (!this.s.meta()) return { woken: 0 };
    const woken = this.s.work.retryBlocked();
    await this.s.arm();
    return { woken };
  }
  /** One work item: an email's (email.ts), or the conversation's own (its opening, close, a ticket's emails, a staff reply). */
  private async run(item: WorkRow): Promise<Outcome> {
    const payload = JSON.parse(item.payload);
    switch (item.kind) {
      case 'message': case 'answer': case 'confirm': case 'forward': return this.e.run(item);
      case 'close': await this.s.closeRemote(); return {};
      // A chat opening whose answer from Nightmail was never handled: closed here, and with Nightmail (the close item).
      case 'opening': if (!this.s.meta()!.registered && this.s.meta()!.status !== 'closed') await this.s.close('ended'); return {};
      case 'alert': { const { key, input } = payload as Alert; await external(nightmailApi(this.s.env).startThread(input, key)); return {}; }
      case 'notify': {
        const { ticketId, key, input } = payload as Notify;
        const row = await external(this.s.env.DB.prepare('SELECT notified_at FROM tickets WHERE id = ?').bind(ticketId).first<{ notified_at: number | null }>());
        if (!row) throw new Error('Missing ticket');
        if (row.notified_at === null) {
          await external(nightmailApi(this.s.env).startThread(input, key));
          await external(this.s.env.DB.prepare('UPDATE tickets SET notified_at = ? WHERE id = ?').bind(Date.now(), ticketId).run());
        }
        return {};
      }
      case 'followup': {
        // openFollowUp sends from SUPPORT_ADDRESS_ID: the address configured when the ticket was filed, on every try.
        const { addressId, ctx, ticket } = payload as FollowUp;
        const sent = await external(openFollowUp({ ...this.s.env, SUPPORT_ADDRESS_ID: addressId! }, ctx, ticket));
        if (sent) this.s.update(m => { m.threadId ??= sent.threadId; });
        return {};
      }
      case 'staff': return this.i.staffReply(item, payload as StaffReply);
      default: throw new Error('Unknown work kind');
    }
  }
  override async alarm() {
    if (!this.s.meta()) return;
    // Answers parked for a sign-in whose check is due (the claim wait's end among them): asked here, the sweep's wake too.
    if (this.i.signInDue()) await this.i.signIns();
    await this.s.work.drain(item => this.run(item), (item, state) => this.s.finished(item, state), () => this.s.deadline());
    // The inbox: what a failed mirror left, and the state this drain changed (blocked work, a ticket).
    await this.s.mirror();
    let meta = this.s.meta()!;
    const now = Date.now();
    if (!meta.closedAt && now >= meta.lastActivity + this.s.idle(meta)) { await this.s.close('idle'); meta = this.s.meta()!; }
    // Deleted once retention has passed and no work is left to do (parked answers go with it).
    if (meta.closedAt && now >= meta.closedAt + KEEP_AFTER_CLOSE_MS && !this.s.work.open()) {
      // A ticket's screenshots stay for the team until the bucket's lifecycle rule (90 days) removes them.
      if (!meta.ticketId) await deleteConversationUploads(this.env, meta.conversationId);
      await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll(); return;
    }
    await this.s.arm();
  }
}
