import { sql, eq, and } from 'drizzle-orm';
import { ApiError, id, type Actor, type Ctx } from './core.js';
import { mailboxes } from './db/mailbox.js';
import { principal } from './mail-gateway.js';
import { boundMailBucket, mailKey, withMailObjects } from './mail-objects.js';
import { mimeIndex } from './mailbox-mime-index.js';
import { stripBlindRecipients, submissionParties } from './mailbox-mime.js';
import { sendFromMailbox, resolveAttachments } from './mailbox-send.js';
import { protocolScoreCap } from './sender-score.js';
import {savePreview} from './protocol-preview.js';
import { sealedPassthrough, submittedFile, type Submitted } from './protocol-submit.js';
import { parseSubmission, sealedMime } from './submission-mime.js';

/** An app password's SMTP submission: sent from its inbox and kept, as the app wrote it without blind recipients, in
 *  its Sent folder. When the copy doesn't fit the inbox's quota the message is still sent, without the copy, and the
 *  answer says so (sentCopy false). */
export async function contentWrite(c: Ctx, p: Submitted) {
  const rt = c.env;
  const auth = principal(rt, 'smtp', sql`p.id=${p.kid}`);
  const ownership = sql`ARRAY(SELECT lower(address) FROM mailbox_addresses WHERE workspace_id=a.w AND mailbox_id=a.b)`;
  const who = (await rt.db.execute<{ w: string; b: string; domain: string; owned: string[] }>(
    sql`WITH a AS (${auth}) SELECT a.*,b.domain_id AS domain,${ownership} AS owned FROM a JOIN mailboxes b ON b.id=a.b`,
  )).rows[0];
  if (!who) throw new ApiError(403, 'CREDENTIAL_REVOKED', 'Protocol access denied.');
  // The submission's buffer is its own: Bcc goes in place, so a large message isn't held twice.
  const raw = stripBlindRecipients(p.raw, true);
  const parsed = await parseSubmission(raw);
  if (!parsed) throw new ApiError(422, 'MIME_LIMIT', 'Message could not be safely parsed.');
  const m = parsed.mail;
  const mid = id('msg'),
    bucket = boundMailBucket(rt) ?? (!rt.config.multiTenant ? 'local:' : null);
  if (!bucket) throw new ApiError(503, 'MAIL_STORE_UNAVAILABLE', 'Kept mail storage unavailable.');
  const key = mailKey(who.w, 'kept', who.b, mid),
    index = mimeIndex(raw);
  const { from: sender, senders, to, cc, bcc } = submissionParties(m, p);
  const ownsSenders = (addresses: string[]) => !!senders?.every(a => addresses.includes(a));
  const denied = () => new ApiError(403, 'SENDER_NOT_OWNED', 'Use an address owned by this inbox.');
  if (!sender || !ownsSenders(who.owned)) throw denied();
  const mime = sealedMime(raw) ? await sealedPassthrough(rt, who.w, raw, sender, m.sender?.address) : undefined;
  // Uploads reserve quota and commit immutable objects using their own transactions.
  // Never ask for a second connection while the Worker holds its only one.
  const attachments = mime ? [] : await resolveAttachments(rt, {id:who.b, workspaceId:who.w, domainId:who.domain}, parsed.files.map(submittedFile), sender);
  const cap = await protocolScoreCap(rt, who.w);
  const persist = () => withMailObjects(rt, who.w, '', bucket, (objects) => objects.put(key, raw, 'message/rfc822'));
  // An uncertain transaction outcome must not remove a committed object. Orphan cleanup
  // must prove no membership references the immutable key before deleting it.
  return rt.db.transaction(async (tx) => {
    const box = (
      await tx
        .select()
        .from(mailboxes)
        .where(and(eq(mailboxes.id, who.b), eq(mailboxes.workspaceId, who.w)))
        .for('no key update')
    )[0];
    // Acquire the issuer/revoker's fence BEFORE taking the statement snapshot used to authorize.
    await tx.execute(sql`SELECT FROM inbox_state WHERE workspace_id=${who.w} AND inbox_id=${who.b} FOR UPDATE`);
    // A quota is only what the inbox sets (null: none), as for received mail and APPEND.
    const active = (
      await tx.execute<{ owned: string[]; suppressed: boolean; space: boolean }>(
        sql`WITH a AS (${auth}) SELECT ${ownership} AS owned,
          ((b.quota_messages IS NULL OR s.messages<b.quota_messages) AND (b.quota_bytes IS NULL OR s.bytes+${raw.length}<=b.quota_bytes)) AS space,
          EXISTS(SELECT FROM audience_contacts WHERE workspace_id=a.w AND email=ANY(${sql.param(p.to.map(v=>v.toLowerCase()))}::text[]) AND suppressed) AS suppressed
          FROM a JOIN inbox_state s ON s.inbox_id=a.b JOIN mailboxes b ON b.id=a.b FOR UPDATE OF s`,
      )
    ).rows[0];
    if (!box || !active) throw new ApiError(403, 'CREDENTIAL_REVOKED', 'Protocol access denied.');
    if (!ownsSenders(active.owned)) throw denied();
    // A full inbox doesn't stop mail going out: only its Sent copy is left out. Otherwise hold inbox_state until the
    // membership insert charges these bytes and one message; do not charge the counters twice.
    const stored = active.space;
    // SMTP submissions have no reply-author suppression exemption. Don't acknowledge
    // known undeliverable mail; dispatch still rechecks for changes after this commit.
    if (active.suppressed) throw new ApiError(422, 'RECIPIENT_INELIGIBLE', 'Recipient is not eligible for delivery.');
    const stamp = m?.messageId?.trim() ?? null;
    // An inbox has no daily or monthly cap of its own (inbox_state.protocol_daily and protocol_monthly are no longer
    // read): only the workspace's daily limit, which the send admission applies again.
    const used = (
      await tx.execute<{ day: number }>(
        sql`SELECT coalesce(sum(accepted),0)::int AS day FROM inbox_protocol_sends WHERE inbox_id=${who.b} AND day=(now() AT TIME ZONE 'UTC')::date`,
      )
    ).rows[0]!;
    if (used.day + p.to.length > cap)
      throw new ApiError(429, 'INBOX_SEND_LIMIT', 'The workspace’s daily sending limit is reached.');
    const actor: Actor = { workspaceId: who.w, keyId: p.kid, domains: [], permissions: ['send'] };
    c.set('actor', actor);
    const { message } = await sendFromMailbox(rt, tx, {
      scope: { workspaceId: who.w },
      actor,
      mailbox: box,
      from: sender,
      fromName: m.from?.name,
      to,
      cc,
      bcc,
      replyTo: (m.replyTo ?? []).flatMap((a) => (a.address ? [a.address] : [])),
      subject: m.subject || '(no subject)',
      text: m.text ?? ' ',
      html: m.html,
      attachments,
      mime,
      inReplyTo: m.inReplyTo && /^<[^<>\s\x00-\x1f]{1,990}>$/.test(m.inReplyTo) ? m.inReplyTo.slice(1, -1) : null,
      references: (m.references ?? '')
        .split(/\s+/)
        .filter((v) => /^<[^<>\s\x00-\x1f]{1,990}>$/.test(v))
        .slice(-64)
        .map((v) => v.slice(1, -1)),
      headers: [],
      screen: true,
      tracking: false,
      protocolArchive: { mid, key, bucket, bytes: raw.length, mime: index, clientId: stamp, stored },
    });
    await tx.execute(
      sql`INSERT INTO inbox_protocol_sends VALUES(${who.b},(now() AT TIME ZONE 'UTC')::date,${p.to.length}) ON CONFLICT(inbox_id,day) DO UPDATE SET accepted=inbox_protocol_sends.accepted+excluded.accepted`,
    );
    if (stored) {
      await persist();
      await savePreview(tx,mid,key,raw,raw.length);
    }
    return { id: message.sendingEmailId!, sentCopy: stored };
  });
}
