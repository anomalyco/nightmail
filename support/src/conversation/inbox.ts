import { nightmailApi, NightmailError, platformBody, type Scope, type FiledConversation, type PlatformReply } from '../nightmail.js';
import type { Env } from '../env.js';
import { plainText } from '../gate.js';
import { external, type Outcome, type WorkRow } from '../work.js';
import { productName } from '../../../api/src/brand.js';
import { log, logError } from '../log.js';
import { Meta, Snapshot, StaffReply, AGENT_SUBJECT, answerJob, answerProgress, signInStep, staffDelivery, type StaffDeliveryRow } from './state.js';
import type { ConversationStore } from './store.js';
import type { Access } from './actions.js';

export class Inbox {
  constructor(readonly s: ConversationStore, readonly a: Access) {}
  /** /chat/resume asks before it mints a token: an email conversation continues by email; anything else must be joinable. */
  /**
   * A chat Nightmail opened from a message the dashboard filed while the chat couldn't take it (api/src/support-
   * conversations.ts fileChatTicket): this object never registered it, and adopts it as openChat would have opened it,
   * for its person and workspace as Nightmail holds them, without registering again (Nightmail already has it). Its filed
   * messages come in with it (takeFiled). An object that already holds it only takes them in.
   */
  async adoptFiled(f: FiledConversation): Promise<{ ok: boolean }> {
    if (!this.s.meta()) {
      if (!f.filed || !f.workspace || f.status === 'closed') return { ok: false };
      const meta = this.s.fresh(f.id, 'chat'), workspace = { id: f.workspace.id, name: f.workspace.name };
      Object.assign(meta, { userId: f.user.id, email: f.user.email, name: f.user.name, role: f.workspace.role, workspace, workspaces: [{ ...workspace, role: f.workspace.role }],
        verified: 'handoff' as const, page: f.page, requestIds: f.requestIds, bound: f.workspace.id, registered: true, mode: 'member' as const, greeted: true,
        status: f.status === 'ticketed' ? 'ticketed' as const : 'open' as const });
      this.s.save(meta);
      log('info', { event: 'chat', code: 'FILED_CHAT_ADOPTED', conversation: f.id });
    }
    this.takeIn(f.messages);
    await this.s.arm();
    return { ok: true };
  }
  /**
   * The messages the dashboard filed into this chat while it couldn't take them, read from Nightmail and each taken into
   * the transcript once, under its own ID (so the mirror leaves it as it is). No turn for any of them: they are a ticket
   * for a person, and the agent is paused for it. On a resume, a wake and every panel connection.
   */
  async takeFiled(): Promise<{ taken: number }> {
    const meta = this.s.meta();
    if (!meta || meta.channel !== 'chat' || !meta.registered || meta.status === 'closed') return { taken: 0 };
    try {
      const reply = await this.s.env.BANE.filedConversation(meta.conversationId);
      if (reply.status !== 200 || !reply.body.messages.length) return { taken: 0 };
      return { taken: this.takeIn(reply.body.messages) };
    } catch (error) { logError(error, { event: 'chat', code: 'FILED_READ_FAILED' }, 'warn'); return { taken: 0 }; }
  }
  /**
   * Records each filed message the transcript lacks, oldest first. One whose words the person already sent here within the
   * hour is that same message (the chat dropped after it arrived, and the dashboard filed it too), as Nightmail counts it:
   * not taken twice.
   */
  takeIn(messages: FiledConversation['messages']) {
    let taken = 0;
    for (const m of [...messages].sort((a, b) => a.at.localeCompare(b.at))) {
      if (this.s.sql.exec('SELECT 1 FROM _support_transcript WHERE id = ?', m.id).toArray().length) continue;
      const since = new Date(Date.parse(m.at) - 3_600_000).toISOString();
      if (this.s.sql.exec("SELECT 1 FROM _support_transcript WHERE role = 'user' AND text = ? AND at >= ?", m.text, since).toArray().length) continue;
      this.s.record({ id: m.id, role: 'user', kind: null, text: m.text, at: m.at, tools: [] }, false);
      taken++;
    }
    if (taken) { this.s.update(m => { m.lastActivity = Date.now(); }); log('info', { event: 'chat', code: 'FILED_MESSAGES_TAKEN', taken }); }
    return taken;
  }
  /**
   * Who paused the agent here, if anyone: staff, or an emailed ticket (later mail goes to the ticket). A conversation
   * Nightmail hasn't registered is never paused. `strict`: a send waits (throws, so its work is retried) when Nightmail
   * can't say; a chat turn goes ahead.
   */
  async pausedBy(meta: Meta, strict: boolean): Promise<'staff' | 'ticket' | null> {
    try {
      const reply = await this.s.env.BANE.inboxState(meta.conversationId);
      if (reply.status === 404) return null;
      const state = platformBody(reply);
      return state.agentState !== 'paused' ? null : state.pausedBy === 'ticket' ? 'ticket' : 'staff';
    } catch (error) {
      if (strict) throw error instanceof NightmailError ? error : new NightmailError(503, 'INBOX_STATE_UNAVAILABLE', 'The inbox state could not be read');
      logError(error, { event: 'inbox', code: 'INBOX_STATE_UNAVAILABLE' }, 'warn');
      return null;
    }
  }
  /**
   * Nightmail's wake (worker.ts /hooks/nightmail-wake), after a staff reply or a sign-in, or the sweep's for an answer
   * parked for a sign-in (ledger.ts). It carries only the ID, so nothing here trusts it beyond asking Nightmail again:
   * the answers whose sign-in Nightmail's scope now lists are released (signIns), then the staff replies are pulled.
   */
  async wake(): Promise<{ ok: boolean; queued: number; released?: number }> {
    const meta = this.s.meta();
    if (!meta) return { ok: false, queued: 0 };
    // Closed: its parked answers were held at close; the ledger hears so again.
    if (meta.status === 'closed') { await this.s.work.mirror(); return { ok: false, queued: 0 }; }
    const released = await this.signIns() + await this.releases();
    if (meta.channel === 'chat') await this.takeFiled();
    const pulled = platformBody(await this.s.env.BANE.pullOutbox(meta.conversationId));
    return { ok: true, queued: await this.deliver({ replies: pulled.data }), released };
  }
  /**
   * Answers parked for their sender's sign-in, each released once Nightmail's scope lists that very message as signed in
   * (only a parked row changes, and the queue runs a row only once it is pending): its answer is then written for the
   * person Nightmail bound. One whose sender passed the checks a general answer needs (`general`), still unclaimed at the
   * end of the claim wait (CLAIM_WAIT_MS after its sign-in reply), is released `unclaimed` instead: a general answer, which
   * gets no account access at all. Nothing is decided from a scope Nightmail couldn't give. Any other parked answer waits
   * for its own sign-in, checked again later (SIGNIN_CHECKS, and at the claim wait's end), and the ledger learns its next
   * check, so the sweep asks the least recently checked conversations first.
   */
  async signIns(): Promise<number> {
    const meta = this.s.meta();
    if (!meta?.registered || meta.channel !== 'email' || meta.status === 'closed') return 0;
    // Parked for a sign-in, and (written for nobody yet) an unclaimed answer still queued or blocked: a claim that
    // arrives before it is written makes it an answer from the account after all.
    const rows = this.s.sql.exec<{ id: string; state: string; payload: string; result: string }>(`SELECT id, state, payload, result FROM _support_work WHERE kind = 'answer' AND json_extract(payload, '$.signin') = 1
      AND (state = 'parked' OR (state IN ('pending', 'blocked') AND json_extract(result, '$.unclaimed') = 1 AND json_extract(result, '$.verified') IS NULL))`).toArray();
    if (!rows.length) return 0;
    // Who signed in: null when Nightmail couldn't say.
    let signed: Set<string> | null = null;
    try {
      const scope = await this.a.stamped<Scope>('GET', '/v1/support/scope');
      if (scope.status === 200) signed = new Set(scope.body.conversation.signedIn ?? []);
      // An unbound conversation's scope is refused: nobody has signed in yet.
      else if (scope.status === 403 || scope.status === 404) signed = new Set();
    } catch (error) { logError(error, { event: 'email', code: 'SIGNIN_CHECK_FAILED' }, 'warn'); }
    const now = Date.now();
    let released = 0;
    const moved = (written: number, code: string) => { if (written) { released++; log('info', { event: 'email', code, conversation: meta.conversationId }); } };
    for (const row of rows) {
      const step = signInStep(answerJob(JSON.parse(row.payload)), answerProgress(JSON.parse(row.result)), row.state === 'parked', signed, now);
      if (step?.to === 'release') moved(this.s.sql.exec("UPDATE _support_work SET state = 'pending', due_at = ?1, updated_at = ?1 WHERE id = ?2 AND state = 'parked'", now, row.id).rowsWritten, 'EMAIL_SIGNED_IN');
      else if (step?.to === 'unclaimed') moved(this.s.sql.exec("UPDATE _support_work SET state = 'pending', due_at = ?1, result = json_set(result, '$.unclaimed', json('true')), updated_at = ?1 WHERE id = ?2 AND state = 'parked'", now, row.id).rowsWritten, 'EMAIL_UNCLAIMED');
      else if (step?.to === 'claim') moved(this.s.sql.exec("UPDATE _support_work SET due_at = ?1, result = json_remove(result, '$.unclaimed'), updated_at = ?1 WHERE id = ?2 AND state IN ('pending', 'blocked') AND json_extract(result, '$.verified') IS NULL", now, row.id).rowsWritten, 'EMAIL_SIGNED_IN');
      else if (step?.to === 'recheck') this.s.sql.exec("UPDATE _support_work SET due_at = ?1, result = json_set(result, '$.checks', ?2), updated_at = ?3 WHERE id = ?4 AND state = 'parked'", step.dueAt, step.checks, now, row.id);
    }
    if (released) await this.s.arm();
    await this.s.work.mirror();
    return released;
  }
  /**
   * "Answer me by email instead" (api/src/support-conversations.ts releaseGeneralAnswer): whoever opened the sign-in link
   * emailed to this conversation's address asked for a general answer, and Nightmail lists the conversation as due. That
   * email's parked answer is released now, `unclaimed` and `released`: the general-answers-only turn (no scope read, no
   * account tool, no account data), to this conversation's address in its thread, without the sender checks (pressing it
   * read the mailbox they couldn't prove), and any other email of theirs still waiting here joins it. Once: only a parked
   * row changes, a follow-up is never one, and an answer the limits already refused after a release waits for a person.
   */
  async releases(): Promise<number> {
    const meta = this.s.meta();
    if (!meta?.registered || meta.channel !== 'email' || meta.status === 'closed') return 0;
    const waiting = this.s.sql.exec<{ id: string; payload: string; result: string }>("SELECT id, payload, result FROM _support_work WHERE kind = 'answer' AND state = 'parked' AND json_extract(payload, '$.signin') = 1 AND json_extract(payload, '$.followup') IS NULL ORDER BY created_at").toArray();
    if (!waiting.length) return 0;
    let due: string[];
    try { due = platformBody(await external(this.s.env.BANE.generalAnswers(meta.conversationId))).data.filter(d => d.conversationId === meta.conversationId).map(d => d.messageId); }
    catch (error) { logError(error, { event: 'email', code: 'RELEASE_CHECK_FAILED' }, 'warn'); return 0; }
    const messageOf = (w: { payload: string }) => answerJob(JSON.parse(w.payload)).base.messageId;
    const anchor = waiting.find(w => due.includes(messageOf(w)));
    const progress = anchor ? answerProgress(JSON.parse(anchor.result)) : null;
    if (!anchor || !progress || (progress.phase === 'capped_unclaimed' && progress.released)) return 0;
    const others = waiting.filter(w => w !== anchor), now = Date.now();
    const also = [...'also' in progress ? progress.also : [], ...others.map(messageOf)];
    const released = this.s.ctx.storage.transactionSync(() => {
      if (!this.s.sql.exec("UPDATE _support_work SET state = 'pending', due_at = ?1, result = json_set(json_remove(result, '$.capped'), '$.unclaimed', json('true'), '$.released', json('true'), '$.also', json(?2)), updated_at = ?1 WHERE id = ?3 AND state = 'parked'",
        now, JSON.stringify(also), anchor.id).rowsWritten) return false;
      for (const other of others) this.s.sql.exec("UPDATE _support_work SET state = 'done', result = json_set(result, '$.joinedTo', ?1), updated_at = ?2 WHERE id = ?3 AND state = 'parked'", anchor.id, now, other.id);
      return true;
    });
    if (!released) return 0;
    log('info', { event: 'email', code: 'EMAIL_RELEASED', conversation: meta.conversationId, joined: others.length });
    await this.s.arm();
    await this.s.work.mirror();
    return 1;
  }
  /** Whether an answer parked for a sign-in is due a check (the alarm's, beside the sweep's wake). */
  signInDue() { return this.s.sql.exec("SELECT 1 FROM _support_work WHERE kind = 'answer' AND state = 'parked' AND json_extract(payload, '$.signin') = 1 AND due_at <= ? LIMIT 1", Date.now()).toArray().length > 0; }
  /** Staff replies for this conversation (from its wake, or the sweep's pull of every conversation's): each one item. */
  async deliver({ replies }: { replies: (StaffReply & { conversationId?: string })[] }): Promise<number> {
    const meta = this.s.meta();
    if (!meta) return 0;
    let queued = 0;
    for (const reply of replies) {
      if (reply.conversationId && reply.conversationId !== meta.conversationId) continue;
      if (this.s.work.insert({ kind: 'staff', id: `staff:${reply.id}`, payload: { id: reply.id, text: reply.text, staffName: reply.staffName } satisfies StaffReply })) queued++;
    }
    if (queued) await this.s.arm();
    return queued;
  }
  /**
   * One staff reply, delivered once. Email: a reply in the thread to its last customer message, only to the address whose
   * mail passed DMARC there. Chat: into the transcript and every open socket, or, with none open, an email to the account
   * address the dashboard handoff vouched for. Then Nightmail records it sent; one that can't be delivered is marked failed.
   */
  async staffReply(item: WorkRow, reply: StaffReply): Promise<Outcome> {
    const progress: StaffDeliveryRow = JSON.parse(item.result), save = () => this.s.work.checkpoint(item.id, progress), state = staffDelivery(progress);
    const meta = this.s.meta()!, author = reply.staffName ?? `The ${productName} team`, at = new Date().toISOString();
    const recipient = meta.email && (meta.verified || meta.dmarcSender === meta.email) ? meta.email : null;
    const settle = async (status: 'sent' | 'failed') => {
      if (status === 'sent' && !progress.sent) { progress.sent = true; save(); }
      platformBody(await external(this.s.env.BANE.markDelivery(meta.conversationId, reply.id, status)));
      return { result: progress };
    };
    // Settled on an earlier try, and only Nightmail's record of it failed: that is all that is retried, never the send.
    if (state.phase === 'failed') return settle('failed');
    if (state.phase === 'sent') return settle('sent');
    try {
      if (meta.channel === 'email') {
        const last = meta.lastInbound, agent = meta.verified === 'agent';
        // An agent's report its person hasn't written back on: the reply goes in the thread of the email that answered it,
        // or starts that thread when none went yet (the answer was held, capped or never came).
        if (!recipient || (!last && !agent)) { progress.failed = recipient ? 'no message to reply to' : 'sender not verified'; save(); return settle('failed'); }
        if (!progress.emailed) {
          if (last) await external(nightmailApi(this.s.env).reply(last.threadId, { replyToMessageId: last.messageId, text: reply.text, to: recipient, addressId: this.s.route({ addressIds: last.addressIds } as Snapshot, last.messageId, 'reply').addressId }, `staff-${reply.id}`));
          else if (meta.agentSent) await external(nightmailApi(this.s.env).reply(meta.agentSent.threadId, { replyToMessageId: meta.agentSent.messageId, text: reply.text, to: recipient, addressId: this.s.env.SUPPORT_ADDRESS_ID ?? null }, `staff-${reply.id}`));
          else {
            const sent = await external(nightmailApi(this.s.env).startThread({ to: [recipient], subject: AGENT_SUBJECT, text: [reply.text, '', '—', 'Reply to this email to continue.'].join('\n') }, `staff-${reply.id}`));
            this.s.update(m => { m.threadId = sent.threadId; m.agentSent = { messageId: sent.id, threadId: sent.threadId }; });
            await external(this.s.env.DB.prepare('UPDATE conversations SET thread_id = ?, updated_at = ? WHERE id = ?').bind(sent.threadId, Date.now(), meta.conversationId).run());
          }
          progress.emailed = true; save();
        }
      } else {
        const open = this.s.ctx.getWebSockets().length > 0;
        if (!progress.recorded) {
          this.s.update(m => { m.lastActivity = Date.now(); });
          this.s.record({ id: reply.id, role: 'staff', kind: 'staff', text: reply.text, at, tools: [], author });
          this.s.broadcast({ type: 'message.start', messageId: reply.id, kind: 'staff', author });
          this.s.broadcast({ type: 'message.end', messageId: reply.id, text: reply.text, redacted: false });
          progress.recorded = true; save();
        }
        if (!open && !progress.emailed) {
          if (!recipient) { progress.failed = 'no account address'; save(); return settle('failed'); }
          const first = meta.name?.split(/\s+/)[0] ?? 'there';
          // The panel shows a reply as Markdown; by email it is plain text, as the agent's email answers are.
          await external(nightmailApi(this.s.env).startThread({ to: [recipient], subject: `Re: your ${productName} support chat`, text: [`Hi ${first},`, '', plainText(reply.text), '', `${author}, ${productName}`].join('\n') }, `staff-${reply.id}`));
          progress.emailed = true; save();
        }
      }
    } catch (error) {
      // A reply Nightmail refuses for good (no reply target, recipients changed): failed, so staff see it wasn't sent.
      if (error instanceof NightmailError && error.status >= 400 && error.status < 500 && error.status !== 429 && !['IDEMPOTENCY_IN_PROGRESS'].includes(error.code)) {
        progress.failed = error.code; save();
        return settle('failed');
      }
      throw error;
    }
    if (meta.channel === 'email' && !progress.recorded) { this.s.record({ id: reply.id, role: 'staff', kind: 'staff', text: reply.text, at, tools: [], author }); progress.recorded = true; save(); }
    return settle('sent');
  }
}

/**
 * A conversation Nightmail named that this Worker doesn't hold (D1 has no row): adopted if Nightmail opened it from a
 * filed message, as a chat for its person and workspace (and only for `userId` when a resume names it): the object as
 * openChat would have opened it, then a D1 row as startChat writes. False otherwise, or when Nightmail can't say now.
 */
export async function adoptFiledChat(env: Env, id: string, userId?: string): Promise<boolean> {
  let reply: PlatformReply<FiledConversation>;
  try { reply = await env.BANE.filedConversation(id); } catch (error) { logError(error, { event: 'chat', code: 'FILED_READ_FAILED' }, 'warn'); return false; }
  if (reply.status !== 200) return false;
  const f = reply.body;
  if (!f.filed || !f.workspace || f.status === 'closed' || (userId !== undefined && f.user.id !== userId)) return false;
  // The object first, the D1 row after: every path adopts only while the row is missing, so a failure between the two
  // (a deploy, an overload) is finished by the next resume, wake or sweep. Both steps repeat safely: an object that holds
  // the chat only takes messages in, and the row is written once.
  if (!(await env.CONVERSATION.get(env.CONVERSATION.idFromName(id)).adoptFiled(f)).ok) return false;
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO conversations (id, channel, user_id, email, workspace_id, workspace_name, status, created_at, updated_at) VALUES (?, 'chat', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING`).bind(f.id, f.user.id, f.user.email, f.workspace.id, f.workspace.name, f.status === 'ticketed' ? 'ticketed' : 'open', now, now).run();
  return true;
}
