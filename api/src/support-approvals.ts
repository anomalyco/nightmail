import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Config, DbExecutor } from './core.js';

// Approvals: a decision staff make with one click from an email, never by the click alone. Something proposes an
// action on a support conversation (Nightmail's staff email today; the agent, for a risky action, later), and the email
// carries a signed link to the conversation with that action ready to confirm. Mail scanners follow links, so opening
// the link does nothing: an operator signed in to the dashboard (the operator role) confirms or declines it there, once,
// before it expires. Each kind says in fixed words what it does, and runs through the same code as the dashboard's own
// button for it. A new kind is a new entry in KINDS (its words and its run), nothing else.

/** How long a proposal can be approved. */
export const APPROVAL_HOURS = 72;

/**
 * What a kind runs with: the same code as the dashboard's own buttons, inside the decision's transaction, as the operator
 * who approved it. wake: Retry now; sendDraft: Send on a held answer, as the agent wrote it (refused when it needs a fresh
 * reply, or a newer reply reached the customer first).
 */
type Deps = { wake: (conversationId: string) => Promise<boolean>; sendDraft: (messageId: string) => Promise<{ id: string }> };
export type ApprovalKind = {
  /** The button and the confirm step's title: what approving does, in a few words. */
  label: string;
  /** What happens, in one sentence, for the confirm step. Fixed words: nothing a proposer or customer wrote. */
  effect: string;
  /** Risky actions (limits, pauses, money, deleting, access) are proposed by the agent and only ever run from here. */
  risky: boolean;
  run(deps: Deps, conversationId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
};
export const KINDS: Record<'retry_work' | 'send_held_answer', ApprovalKind> = {
  retry_work: {
    label: 'Retry the stuck work', risky: false,
    effect: 'The support platform is woken for this conversation and tries the work it could not finish again, as Retry now does.',
    run: async (deps, conversationId) => ({ woken: await deps.wake(conversationId) }),
  },
  // payload: { messageId } of the held answer. Only proposed for one held by the output check or a pause; one held
  // because access shrank or written by an earlier build needs a fresh reply, and sendDraft refuses it anyway.
  send_held_answer: {
    label: 'Send the held answer', risky: false,
    effect: 'The answer the agent wrote goes to the customer as written, as a staff reply in your name (by email as plain text). It isn’t sent if a newer reply reached them first.',
    run: async (deps, _conversationId, payload) => ({ replyId: (await deps.sendDraft(String(payload.messageId ?? ''))).id }),
  },
};
export type KindName = keyof typeof KINDS;
export const isKind = (kind: string): kind is KindName => Object.hasOwn(KINDS, kind);

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const approvalId = () => `apr_${Array.from(crypto.getRandomValues(new Uint8Array(26)), b => BASE32[b & 31]).join('')}`;
const key = (secret: string) => hkdfSync('sha256', secret, 'opensend:keys:v1', 'support-approval:v1', 32);
/** An approval's expiry as the link signs it: milliseconds since the epoch. */
export const EXPIRES_MS = sql`(extract(epoch FROM expires_at) * 1000)::float8 AS expires_ms`;
/** The link's signature: this approval, for this conversation, until it expires. */
export const approvalToken = (secret: string, a: { id: string; conversationId: string; expiresAt: Date }) =>
  createHmac('sha256', Buffer.from(key(secret))).update(`${a.id}.${a.conversationId}.${a.expiresAt.getTime()}`).digest('base64url');
export function validToken(secret: string, a: { id: string; conversationId: string; expiresAt: Date }, token: string) {
  const want = Buffer.from(approvalToken(secret, a)), got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}
/** The dashboard link an email carries: the conversation, with this approval ready to confirm after sign-in. */
export const approvalLink = (config: Pick<Config, 'publicUrl' | 'authSecret'>, a: { id: string; conversationId: string; expiresAt: Date }) =>
  `${new URL(config.publicUrl).origin}/support/${a.conversationId}?approval=${a.id}&token=${approvalToken(config.authSecret, a)}`;

/**
 * Proposes an action on a conversation, or answers the one of the same kind already waiting there (unexpired), so a
 * repeated proposal never stacks. The caller holds the conversation's transaction.
 */
export async function propose(tx: DbExecutor, p: { conversationId: string; kind: KindName; reason: string; proposedBy: 'nightmail' | 'agent'; payload?: Record<string, unknown> }) {
  const { rows: [open] } = await tx.execute<{ id: string; expires_ms: number }>(sql`SELECT id, ${EXPIRES_MS} FROM support_approvals
    WHERE conversation_id = ${p.conversationId} AND kind = ${p.kind} AND payload = ${JSON.stringify(p.payload ?? {})}::jsonb AND state = 'proposed' AND expires_at > now() + interval '1 hour' ORDER BY created_at DESC LIMIT 1`);
  if (open) return { id: open.id, conversationId: p.conversationId, expiresAt: new Date(Number(open.expires_ms)) };
  const { rows: [made] } = await tx.execute<{ id: string; expires_ms: number }>(sql`INSERT INTO support_approvals(id, conversation_id, kind, payload, proposed_by, reason, expires_at)
    VALUES (${approvalId()}, ${p.conversationId}, ${p.kind}, ${JSON.stringify(p.payload ?? {})}::jsonb, ${p.proposedBy}, ${p.reason.slice(0, 400)}, date_trunc('milliseconds', now() + make_interval(hours => ${APPROVAL_HOURS})))
    RETURNING id, ${EXPIRES_MS}`);
  return { id: made!.id, conversationId: p.conversationId, expiresAt: new Date(Number(made!.expires_ms)) };
}
