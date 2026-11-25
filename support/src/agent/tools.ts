import { toolResult } from './projection.js';
import { productName } from '../../../api/src/brand.js';

// The agent's tools (design §4.1). Every account tool reads through the conversation's own stamp (Nightmail derives the
// person from the conversation): the model never passes, sees or chooses identity, and each tool sends only the query
// keys it declares, so an invented argument (a user, a conversation, a token) never reaches Nightmail. Each tool has a
// label for the panel's progress line (support/PROTOCOL.md §4.3) that never contains arguments.

export type Param =
  | { type: 'string'; description: string; optional?: boolean; max?: number; pattern?: string }
  | { type: 'number'; description: string; optional?: boolean; min?: number; max?: number }
  | { type: 'enum'; values: readonly string[]; description: string; optional?: boolean }
  | { type: 'strings'; description: string; optional?: boolean; max?: number };
export type ToolSpec = {
  name: string;
  description: string;
  params: Record<string, Param>;
  /** "Checking your Gmail bounces…" while running, "Checked your Gmail bounces" when done. */
  label: (args: Record<string, unknown>) => { running: string; done: string };
  execute: (args: Record<string, unknown>, host: ToolHost) => Promise<string>;
};

/** What the conversation gives its tools. */
export interface ToolHost {
  /** A GET under /v1/support for this conversation (path with query); throws ToolFailure with a customer-safe message. */
  read(path: string): Promise<unknown>;
  /** The workspace this conversation is about, when one is chosen. */
  workspaceId(): string | null;
  /** Values no tool result shows the model (projection.ts): the conversation's own person and ID. */
  hidden(): readonly string[];
  chooseWorkspace(workspaceId: string): Promise<string>;
  requestContentAccess(workspaceId: string, why: string): Promise<string>;
  fileTicket(input: TicketInput): Promise<string>;
  /** Email only: freezes this email's one answer (sent after the turn, only to the address that wrote). */
  reply(text: string): Promise<string>;
  /** Chat only: keeps a note about this conversation's person for their later chats (Nightmail picks person and workspace). */
  note(text: string): Promise<string>;
  /** Chat only, owners and admins: proposes one change the customer confirms signed in, on its card. Nothing runs here. */
  propose(proposal: ActionProposal): Promise<string>;
  /** Chat only, owners and admins: re-checks a domain's DNS now (no confirmation: it changes only the stored status). */
  recheckDomain(domainId: string): Promise<string>;
}
/** The longest note Nightmail keeps (NOTE_MAX_LENGTH in api/src/support-notes.ts). */
export const NOTE_MAX = 1000;
export const TICKET_TYPES = ['billing', 'bug', 'deliverability', 'account', 'abuse_report', 'privacy', 'legal', 'feature_request', 'other'] as const;
export type TicketType = typeof TICKET_TYPES[number];
export const TICKET_TOPICS = ['refund', 'billing_dispute', 'charge', 'credit', 'plan', 'account_closure', 'limit_increase', 'enforcement_review', 'access', 'security', 'legal', 'human_requested', 'guardrail', 'other'] as const;
/** The structured part of a ticket, by type (a bug's reproduction; a feature's use case). */
export type TicketDetails = {
  topic?: string;
  bug?: { reproSteps: string[]; affected: string; requestIds: string[]; errorCodes: string[]; expected: string; actual: string };
  deliverability?: { affected: string };
  featureRequest?: { useCase: string };
};
export type TicketInput = {
  type: TicketType; title: string; severity: 'P1' | 'P2' | 'P3'; summary: string; ask: string;
  tried: { tool: string; finding: string }[]; recommendation: string; evidence: Record<string, string[]>; details: TicketDetails;
};
export class ToolFailure extends Error {}

/**
 * The changes the agent can propose in chat (api/src/support-actions.ts), each with the IDs its body takes: built per kind,
 * so nothing else the model passes reaches Nightmail. Nightmail writes what the customer confirms; nothing here confirms.
 * `title` is what the model hears about one: fixed words for its kind, never Nightmail's sentence or the names in it.
 */
const ACTION_FIELDS: Record<string, { required: readonly ActionField[]; optional?: readonly ActionField[]; title: string }> = {
  retry_webhook_delivery: { required: ['webhookId', 'deliveryId'], title: 'retry a webhook delivery' },
  test_webhook: { required: ['webhookId'], title: 'send a test to a webhook' },
  retry_inbound_delivery: { required: ['webhookId', 'deliveryId'], title: 'retry an inbound webhook delivery' },
  test_inbound_webhook: { required: ['webhookId'], title: 'send a test to an inbound webhook' },
  redeliver_message: { required: ['messageId'], optional: ['webhookId'], title: 'redeliver a received message' },
  pause_campaign: { required: ['campaignId'], title: 'pause a campaign' },
};
type ActionField = 'webhookId' | 'deliveryId' | 'messageId' | 'campaignId';
export const ACTION_KINDS = ['retry_webhook_delivery', 'test_webhook', 'retry_inbound_delivery', 'test_inbound_webhook', 'redeliver_message', 'pause_campaign'] as const;
export type ActionKind = typeof ACTION_KINDS[number];
export type ActionProposal = { kind: ActionKind } & Partial<Record<ActionField, string>>;
/** What a kind does, in a few fixed words ("retry a webhook delivery"). */
export const actionTitle = (kind: string) => ACTION_FIELDS[kind]?.title ?? 'a change';
/** The IDs Nightmail's proposal body takes (its own pattern), checked here as well as by the tool's schema. */
const ACTION_ID = '^[A-Za-z0-9_-]{1,120}$', ACTION_ID_PATTERN = new RegExp(ACTION_ID);
const actionId = (value: unknown) => {
  const s = String(value ?? '');
  if (!ACTION_ID_PATTERN.test(s)) throw new ToolFailure('That ID is not valid. Use an ID from an earlier tool result for this customer.');
  return s;
};
const present = (value: unknown) => value !== undefined && value !== null && value !== '';
/** The model's propose_action arguments as the body for its kind: its required IDs, its optional one, and nothing else. */
export function actionProposal(args: Record<string, unknown>): ActionProposal {
  const kind = String(args.kind ?? '') as ActionKind, fields = (ACTION_KINDS as readonly string[]).includes(kind) ? ACTION_FIELDS[kind]! : null;
  if (!fields) throw new ToolFailure(`Pick kind from: ${ACTION_KINDS.join(', ')}.`);
  const body: ActionProposal = { kind };
  for (const key of fields.required) {
    if (!present(args[key])) throw new ToolFailure(`${kind} needs ${fields.required.join(' and ')}, from an earlier tool result for this customer.`);
    body[key] = actionId(args[key]);
  }
  for (const key of fields.optional ?? []) if (present(args[key])) body[key] = actionId(args[key]);
  return body;
}

const DAYS = /^\d{1,2}$/;
const ID = '^[A-Za-z0-9_.:-]{1,120}$', ID_PATTERN = new RegExp(ID);
/** An ID the model passes (a path segment or the workspace), checked here as well as by the tool's schema. */
function id(value: unknown) {
  const s = String(value ?? '');
  if (!ID_PATTERN.test(s)) throw new ToolFailure('That ID is not valid. Use an ID from an earlier tool result for this customer.');
  return s;
}
const sinceParam: Param = { type: 'number', description: 'How many days back to look (1–30). Default 7.', optional: true, min: 1, max: 30 };
const workspaceParam: Param = { type: 'string', description: 'Narrow to one of the customer’s workspaces (an ID from account_context). Omit to use the conversation’s workspace.', optional: true, max: 100, pattern: ID };

/**
 * The query string of one tool's read: the workspace (the argument, else the conversation's), then only `keys`, the
 * tool's own declared parameters (`days` and `hours` become `since`). Anything else the model passes is dropped.
 */
function query(args: Record<string, unknown>, host: ToolHost, keys: readonly string[] = []) {
  const q = new URLSearchParams(), workspace = args.workspaceId !== undefined && args.workspaceId !== null && args.workspaceId !== '' ? id(args.workspaceId) : host.workspaceId();
  if (workspace) q.set('workspaceId', workspace);
  for (const key of keys) {
    const value = args[key];
    if (key === 'workspaceId' || value === undefined || value === null || value === '' || typeof value === 'object') continue;
    if (key === 'days') { if (DAYS.test(String(value))) q.set('since', new Date(Date.now() - Number(value) * 86_400_000).toISOString()); continue; }
    if (key === 'hours') { if (DAYS.test(String(value))) q.set('since', new Date(Date.now() - Math.min(72, Number(value)) * 3_600_000).toISOString()); continue; }
    q.set(key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
const seg = (value: unknown) => encodeURIComponent(id(value));
const read = (path: (a: Record<string, unknown>, h: ToolHost) => string) => async (args: Record<string, unknown>, host: ToolHost) => toolResult(await host.read(path(args, host)), host.hidden());
const fixed = (running: string, done: string) => () => ({ running, done });
const providerName = (p: unknown) => typeof p === 'string' && p ? ({ gmail: 'Gmail', microsoft: 'Outlook', yahoo: 'Yahoo', apple: 'iCloud', proton: 'Proton', gmx: 'GMX' } as Record<string, string>)[p] ?? p : null;

export const TOOLS: ToolSpec[] = [
  { name: 'account_context', description: 'Start here for any account question: who the customer is, their workspaces and roles, sending setup and limits, domains and verification, failures in the last 24 hours, open enforcement, recent changes and request IDs.',
    params: { workspaceId: workspaceParam }, label: fixed('Looking up your account…', 'Looked up your account'), execute: read((a, h) => `/v1/support/context${query(a, h)}`) },
  { name: 'list_workspaces', description: 'The customer’s workspaces with their role, sending connection and resource counts.', params: { workspaceId: workspaceParam },
    label: fixed('Listing your workspaces…', 'Listed your workspaces'), execute: read((a, h) => `/v1/support/workspaces${query(a, h)}`) },
  { name: 'list_domains', description: 'Domains with sending verification (DKIM, MAIL FROM, DMARC) and receiving state.', params: { workspaceId: workspaceParam },
    label: fixed('Checking your domains…', 'Checked your domains'), execute: read((a, h) => `/v1/support/domains${query(a, h)}`) },
  { name: 'get_standing', description: 'Sender standing per workspace: pauses and reasons, limit overrides, score, step and daily limit, 60 days of history and why a higher limit is or is not needed (no daily limit in good standing), plus the last 24 hours by status.',
    params: { workspaceId: workspaceParam }, label: fixed('Checking your sending standing…', 'Checked your sending standing'), execute: read((a, h) => `/v1/support/standing${query(a, h)}`) },
  { name: 'get_billing', description: 'Balance and the billing ledger (top-ups, usage, refunds, credits) of workspaces the customer owns or administers.',
    params: { workspaceId: workspaceParam }, label: fixed('Checking your billing…', 'Checked your billing'), execute: read((a, h) => `/v1/support/billing${query(a, h)}`) },
  { name: 'get_audit', description: 'The Activity trail (who changed what, when) for workspaces the customer owns or administers, newest first.',
    params: { workspaceId: workspaceParam, action: { type: 'string', description: 'Only actions starting with this, e.g. "api_key." or "domain."', optional: true, max: 60 }, limit: { type: 'number', description: '1–50, default 20', optional: true, min: 1, max: 50 } },
    label: fixed('Reading your activity log…', 'Read your activity log'), execute: read((a, h) => `/v1/support/audit${query(a, h, ['action', 'limit'])}`) },
  { name: 'list_emails', description: 'Sent or received mail, newest first: addresses, subject, status and error codes (never bodies).',
    params: { workspaceId: workspaceParam, direction: { type: 'enum', values: ['sent', 'received'], description: 'Default sent.', optional: true }, status: { type: 'string', description: 'e.g. bounced, failed, suppressed, delivered', optional: true, max: 40 },
      days: sinceParam, limit: { type: 'number', description: '1–50, default 25', optional: true, min: 1, max: 50 }, cursor: { type: 'string', description: 'nextCursor from the previous page', optional: true, max: 200 } },
    label: fixed('Looking through your emails…', 'Looked through your emails'), execute: read((a, h) => `/v1/support/emails${query(a, h, ['direction', 'status', 'days', 'limit', 'cursor'])}`) },
  { name: 'get_email', description: 'One email with its delivery events; its body only when the customer allowed content access.',
    params: { emailId: { type: 'string', description: 'The email ID', max: 120, pattern: ID }, workspaceId: workspaceParam },
    label: fixed('Opening that email…', 'Opened that email'), execute: read((a, h) => `/v1/support/emails/${seg(a.emailId)}${query({ workspaceId: a.workspaceId }, h)}`) },
  { name: 'list_events', description: 'Delivery events of sent mail (send, delivery, bounce, complaint, reject, open, click), newest first.',
    params: { workspaceId: workspaceParam, emailId: { type: 'string', description: 'Only this email', optional: true, max: 120, pattern: ID }, type: { type: 'string', description: 'e.g. bounce, complaint', optional: true, max: 40 }, days: sinceParam },
    label: fixed('Checking delivery events…', 'Checked delivery events'), execute: read((a, h) => `/v1/support/events${query(a, h, ['emailId', 'type', 'days'])}`) },
  { name: 'list_webhook_deliveries', description: 'Webhook deliveries with attempts, last HTTP status and error (never payloads or URLs).',
    params: { workspaceId: workspaceParam, status: { type: 'enum', values: ['pending', 'delivered', 'failed', 'paused'], description: 'Filter by status', optional: true }, days: sinceParam },
    label: fixed('Checking your webhook deliveries…', 'Checked your webhook deliveries'), execute: read((a, h) => `/v1/support/webhook-deliveries${query(a, h, ['status', 'days'])}`) },
  { name: 'api_errors', description: `The customer’s own failed API and dashboard requests (their apps, SDK, MCP or agents included) from ${productName}’s request logs, which keep about 3 days: grouped by route, status and error code, with counts, first and last seen and sample request IDs to open with explain_request. Use it for "I get 500s", "my integration fails", or to find the request behind an error.`,
    params: { workspaceId: workspaceParam, status: { type: 'enum', values: ['error', '5xx', '4xx'], description: 'Default error (any 4xx or 5xx)', optional: true },
      hours: { type: 'number', description: 'How many hours back (1–72). Default 24.', optional: true, min: 1, max: 72 },
      route: { type: 'string', description: 'Only this route template, e.g. "/v1/emails/send"', optional: true, max: 200 }, code: { type: 'string', description: 'Only this error code, e.g. INTERNAL_ERROR', optional: true, max: 80 } },
    label: fixed('Reading your recent logs…', 'Read your recent logs'), execute: read((a, h) => `/v1/support/requests${query({ status: 'error', ...a }, h, ['status', 'hours', 'route', 'code'])}`) },
  { name: 'explain_request', description: 'One API request ID (req_…) the customer quotes or api_errors found: its request log lines (route, status, error code, duration) and what it changed (audit entries, campaign launches, routing versions).',
    params: { requestId: { type: 'string', description: 'req_ followed by 32 hex characters', max: 40, pattern: '^req_[0-9a-f]{32}$' }, workspaceId: workspaceParam },
    label: fixed('Looking into this request…', 'Looked into this request'), execute: read((a, h) => `/v1/support/requests/${seg(a.requestId)}${query({ workspaceId: a.workspaceId }, h)}`) },
  { name: 'delivery_metrics', description: 'Delivery, bounce, complaint, open, click and unsubscribe rates over time, with numerators and denominators, optionally grouped by recipient provider, campaign, sending domain or stream. Includes findings[] computed from the thresholds.',
    params: { workspaceId: workspaceParam, days: { ...sinceParam, description: 'Days back (1–30). Default 14.' } as Param, granularity: { type: 'enum', values: ['day', 'hour'], description: 'hour only for ≤ 3 days', optional: true },
      groupBy: { type: 'enum', values: ['none', 'campaign', 'from_domain', 'provider', 'stream'], description: 'How to split the numbers', optional: true }, stream: { type: 'enum', values: ['transactional', 'marketing', 'all'], description: 'Default all', optional: true },
      campaignId: { type: 'string', description: 'Only this campaign', optional: true, max: 120, pattern: ID }, fromDomain: { type: 'string', description: 'Only mail from this domain', optional: true, max: 253 } },
    label: a => a.groupBy === 'provider' ? { running: 'Comparing results by mailbox provider…', done: 'Compared results by mailbox provider' } : a.groupBy === 'campaign' ? { running: 'Comparing your campaigns…', done: 'Compared your campaigns' } : { running: 'Checking your delivery numbers…', done: 'Checked your delivery numbers' },
    execute: read((a, h) => `/v1/support/deliverability/metrics${query({ days: 14, ...a }, h, ['days', 'granularity', 'groupBy', 'stream', 'campaignId', 'fromDomain'])}`) },
  { name: 'bounce_reasons', description: 'Bounces, deferrals and complaints grouped by provider, type and SMTP status with a normalized diagnostic, first and last seen and top campaigns; first-send bounce rate for new contacts. Includes findings[].',
    params: { workspaceId: workspaceParam, days: sinceParam, provider: { type: 'enum', values: ['gmail', 'microsoft', 'yahoo', 'apple', 'proton', 'gmx', 'other'], description: 'Only this recipient provider', optional: true },
      type: { type: 'enum', values: ['bounce', 'deferral', 'complaint'], description: 'Default all', optional: true }, campaignId: { type: 'string', description: 'Only this campaign', optional: true, max: 120, pattern: ID }, fromDomain: { type: 'string', description: 'Only mail from this domain', optional: true, max: 253 } },
    label: a => { const p = providerName(a.provider); return p ? { running: `Checking your ${p} bounces…`, done: `Checked your ${p} bounces` } : { running: 'Checking your bounces…', done: 'Checked your bounces' }; },
    execute: read((a, h) => `/v1/support/deliverability/bounces${query(a, h, ['days', 'provider', 'type', 'campaignId', 'fromDomain'])}`) },
  { name: 'domain_health', description: 'One sending domain in depth: verification, live SPF/DMARC/BIMI records, DKIM and SPF alignment, sending volume and warm-up age, marketing vs transactional mix. Includes findings[].',
    params: { domainId: { type: 'string', description: 'The domain ID from list_domains', max: 120, pattern: ID }, workspaceId: workspaceParam },
    label: fixed('Checking your domain’s DNS…', 'Checked your domain’s DNS'), execute: read((a, h) => `/v1/support/domains/${seg(a.domainId)}/health${query({ workspaceId: a.workspaceId }, h)}`) },
  { name: 'screen_rejections', description: `${productName}’s content screen over the last days: hourly screened and rejected counts and the last 50 rejections with subject, error code and what the content check objected to, in words. It has no scores: nothing says how close a message was.`,
    params: { workspaceId: workspaceParam, days: { type: 'number', description: '1–7, default 7', optional: true, min: 1, max: 7 } },
    label: fixed('Checking content screen rejections…', 'Checked content screen rejections'), execute: read((a, h) => `/v1/support/screen${query(a, h, ['days'])}`) },
  { name: 'list_campaigns', description: 'Recent campaigns: state, audience and size, tracking, From, subject, stats and pacing.',
    params: { workspaceId: workspaceParam, days: sinceParam, state: { type: 'string', description: 'e.g. sent, sending, paused, draft', optional: true, max: 40 } },
    label: fixed('Looking at your campaigns…', 'Looked at your campaigns'), execute: read((a, h) => `/v1/support/campaigns${query(a, h, ['days', 'state'])}`) },
  { name: 'get_campaign', description: 'One campaign with its stats and pacing; its content only when the customer allowed content access.',
    params: { campaignId: { type: 'string', description: 'The campaign ID', max: 120, pattern: ID }, workspaceId: workspaceParam },
    label: fixed('Opening that campaign…', 'Opened that campaign'), execute: read((a, h) => `/v1/support/campaigns/${seg(a.campaignId)}${query({ workspaceId: a.workspaceId }, h)}`) },
  { name: 'lint_email', description: 'Structural checks on one sent email: size, parts, unsubscribe headers, alignment, subject; with content access also links, images vs text, shorteners, unresolved tokens.',
    params: { emailId: { type: 'string', description: 'The email ID', max: 120, pattern: ID }, workspaceId: workspaceParam },
    label: fixed('Checking that email’s structure…', 'Checked that email’s structure'), execute: read((a, h) => `/v1/support/emails/${seg(a.emailId)}/lint${query({ workspaceId: a.workspaceId }, h)}`) },
  { name: 'lint_campaign', description: 'The same checks as lint_email for a campaign’s current content.',
    params: { campaignId: { type: 'string', description: 'The campaign ID', max: 120, pattern: ID }, workspaceId: workspaceParam },
    label: fixed('Checking that campaign’s structure…', 'Checked that campaign’s structure'), execute: read((a, h) => `/v1/support/campaigns/${seg(a.campaignId)}/lint${query({ workspaceId: a.workspaceId }, h)}`) },
  { name: 'audience_health', description: 'List hygiene per list or workspace: consent mix, suppressions by reason, engagement recency and stale share, role and typo addresses, provider mix, and recent imports with their first-send bounce and complaint rates. No addresses. When sampled is true on a view, present its counts and shares explicitly as estimates from sampleSize contacts, never as exact totals.',
    params: { workspaceId: workspaceParam, listId: { type: 'string', description: 'Only this list', optional: true, max: 120, pattern: ID } },
    label: fixed('Checking your audience’s health…', 'Checked your audience’s health'), execute: read((a, h) => `/v1/support/audience/health${query(a, h, ['listId'])}`) },
  { name: 'choose_workspace', description: 'When the customer has several workspaces and you need account data, call this with the workspace they named (an ID from the verified list in <customer>). Narrows access to that one workspace.',
    params: { workspaceId: { type: 'string', description: 'A workspace ID from <customer>', max: 100, pattern: ID } },
    label: fixed('Switching to that workspace…', 'Switched workspace'), execute: (a, h) => h.chooseWorkspace(String(a.workspaceId)) },
  { name: 'request_content_access', description: 'Ask the customer to let you read the content (bodies, HTML) of their emails and campaigns in one workspace, for this conversation only. Use only when the content is the likely cause. Say why in one sentence.',
    params: { workspaceId: workspaceParam, why: { type: 'string', description: 'One sentence the customer will see, e.g. "To check why the screen rejected your Nov 3 promo, I need to read its HTML."', max: 240 } },
    label: fixed('Asking for content access…', 'Asked for content access'), execute: (a, h) => h.requestContentAccess(String(a.workspaceId ?? h.workspaceId() ?? ''), String(a.why ?? '')) },
  { name: 'file_ticket', description: `Pass this conversation to the ${productName} team. One per conversation; calling again adds facts to the same ticket. Pick the type that fits and fill its fields: a bug needs reproSteps and affected (plus the request IDs and error codes you saw).`,
    params: {
      type: { type: 'enum', values: TICKET_TYPES, description: `billing (refunds, disputes, charges, credit), bug (${productName} software misbehaving), deliverability (inboxing, bounces, reputation, limits from sending quality), account (access, closure, limits, enforcement, security), abuse_report, privacy (GDPR/CCPA requests, data deletion or export), legal (DPA, subpoenas, law enforcement, sanctions), feature_request, other` },
      title: { type: 'string', description: 'A short subject line for the team, ≤ 80 characters, e.g. "Webhook test returns 500 for every endpoint"', max: 80 },
      severity: { type: 'enum', values: ['P1', 'P2', 'P3'], description: 'P1: security or sending fully down; P2: legal, pause review, degraded sending, a bug blocking work; P3: everything else' },
      topic: { type: 'enum', values: TICKET_TOPICS, description: 'The specific ask within the type, e.g. refund, limit_increase, enforcement_review, human_requested', optional: true },
      summary: { type: 'string', description: 'Three sentences for the team: the situation, the cause if known, what the customer wants', max: 1200 },
      ask: { type: 'string', description: 'The customer’s request in their own words (a short quote)', max: 600 },
      tried: { type: 'strings', description: 'What you checked and found, one "tool: finding" per item', max: 12 },
      recommendation: { type: 'string', description: 'The exact action you recommend, with the evidence (e.g. "Refund the duplicate $25 top-up of Nov 3: two identical top-ups 40 s apart in the ledger")', max: 800 },
      evidence: { type: 'strings', description: 'IDs that back it up: request, email, campaign, domain IDs', optional: true, max: 20 },
      reproSteps: { type: 'strings', description: 'bug: numbered steps to reproduce, as the customer did them', optional: true, max: 10 },
      affected: { type: 'string', description: 'bug: the API route or dashboard page (e.g. "POST /v1/webhooks/{id}/test" or "Domains → Check now"); deliverability: the provider, domain or campaign', optional: true, max: 200 },
      requestIds: { type: 'strings', description: 'bug: request IDs (req_…) of the failing calls', optional: true, max: 10 },
      errorCodes: { type: 'strings', description: 'bug: error codes and statuses seen (e.g. "500 INTERNAL_ERROR")', optional: true, max: 10 },
      expected: { type: 'string', description: 'bug: what should have happened', optional: true, max: 400 },
      actual: { type: 'string', description: 'bug: what happened instead', optional: true, max: 400 },
      useCase: { type: 'string', description: 'feature_request: what they are trying to do and why', optional: true, max: 600 },
    },
    label: fixed(`Passing this to the ${productName} team…`, `Passed this to the ${productName} team`),
    execute: (a, h) => h.fileTicket(ticketInput(a)) },
  { name: 'reply', description: 'Email only: your answer to this email, the only text the customer receives. Call it once, as your last step, with the whole email in plain text, from "Hi," to the sign-off. It goes to the sender only, in this thread, when your turn ends; a second call is refused.',
    params: { text: { type: 'string', description: 'The whole email in plain text, under 250 words, signed "Nightmail support (AI)"', max: 6000 } },
    label: fixed('Writing the reply…', 'Wrote the reply'), execute: (a, h) => h.reply(String(a.text ?? '')) },
  { name: 'add_note', description: `Keep a short note about this customer for a later support chat with them: a durable fact that would help next time, such as their setup, what was tried and what it showed, a preference, or something you or the ${productName} team promised. The customer never sees notes. Never put secrets, credentials, codes or keys in one, and never copy their messages or email content wholesale: write the fact in a sentence or two. At most one or two per conversation.`,
    params: { text: { type: 'string', description: `The note, under ${NOTE_MAX} characters, e.g. "Sends from news.acme.com through Cloudflare DNS; DKIM CNAMEs were proxied, fixed Nov 4."`, max: NOTE_MAX } },
    label: fixed('Noting that for next time…', 'Noted that for next time'), execute: (a, h) => h.note(String(a.text ?? '')) },
  { name: 'propose_action', description: `Propose one change for the customer to confirm on a card in this chat, signed in to ${productName}: retry a failed webhook delivery (retry_webhook_delivery: webhookId, deliveryId), send a test event to a webhook (test_webhook: webhookId), the same for receiving webhooks (retry_inbound_delivery: webhookId, deliveryId; test_inbound_webhook: webhookId), redeliver a received message to its route's webhooks (redeliver_message: messageId, optionally webhookId for one endpoint), or pause a sending campaign (pause_campaign: campaignId). Take the IDs from earlier tool results, and propose only what they show would help. ${productName} writes what the customer sees, and nothing changes until they press Confirm on the card: never on your call, and never on anything they type. At most 3 open at once.`,
    params: {
      kind: { type: 'enum', values: ACTION_KINDS, description: 'The change' },
      webhookId: { type: 'string', description: 'The webhook (retry and test kinds; optional for redeliver_message)', optional: true, max: 120, pattern: ACTION_ID },
      deliveryId: { type: 'string', description: 'The failed delivery (retry kinds)', optional: true, max: 120, pattern: ACTION_ID },
      messageId: { type: 'string', description: 'The received message (redeliver_message)', optional: true, max: 120, pattern: ACTION_ID },
      campaignId: { type: 'string', description: 'The campaign (pause_campaign)', optional: true, max: 120, pattern: ACTION_ID },
    },
    label: fixed('Preparing a change for you to confirm…', 'Prepared a change for you to confirm'), execute: async (a, h) => h.propose(actionProposal(a)) },
  { name: 'recheck_domain', description: `Re-check a sending domain's DNS now, as the customer's own Check now does, after they changed a record: ${productName} queues a verification and answers the stored status. It needs no confirmation and changes nothing but that status. Read domain_health again in a minute for the result.`,
    params: { domainId: { type: 'string', description: 'The domain ID from list_domains', max: 120, pattern: ACTION_ID } },
    label: fixed('Re-checking your domain’s DNS…', 'Re-checked your domain’s DNS'), execute: async (a, h) => h.recheckDomain(actionId(a.domainId)) },
];
export const TOOL_NAMES = TOOLS.map(t => t.name);

/**
 * Tools whose /v1/support routes Nightmail lets only owners and admins read (SUPPORT_CEILINGS in
 * api/src/support-conversations.ts), and the changes only they may make: offered only for a workspace in scope with one
 * of those roles.
 */
export const MANAGER_TOOLS: ReadonlySet<string> = new Set(['list_domains', 'domain_health', 'list_webhook_deliveries', 'get_billing', 'get_audit', 'api_errors', 'explain_request', 'propose_action', 'recheck_domain']);
/** An unverified email reads no account: its turns answer through reply and can file a ticket, nothing else. */
const EMAIL_TOOLS: ReadonlySet<string> = new Set(['reply', 'file_ticket']);
/**
 * Everything a verified email may call: account status, domains, standing and aggregate deliverability summaries (by role),
 * workspace choice, reply and file_ticket. Individual sent-mail metadata, delivery events, campaigns, screens, audience
 * data, billing, the activity trail, request logs, webhook deliveries, changes, notes and content access require the
 * signed-in dashboard Help chat (and Nightmail enforces the same boundary).
 */
export const EMAIL_TOOLS_VERIFIED: ReadonlySet<string> = new Set(['account_context', 'list_workspaces', 'list_domains', 'domain_health', 'get_standing',
  'delivery_metrics', 'bounce_reasons', 'choose_workspace', 'reply', 'file_ticket']);
export type Turn = { channel: 'chat'; manager: boolean } | { channel: 'email'; verified?: false } | { channel: 'email'; verified: true; manager: boolean };
/**
 * The tools one turn may call. A chat's: account tools by role (the owner/admin ones only for a manager), workspace
 * choice, content access, tickets, add_note and the changes, never reply (chat text streams). A verified email's: the
 * reads of EMAIL_TOOLS_VERIFIED by role, workspace choice, reply and file_ticket. Any other email's: reply and file_ticket
 * only. OpenCode's session permissions offer exactly these; the plugin refuses any other call.
 */
export function toolNames(turn: Turn): string[] {
  if (turn.channel === 'email' && !turn.verified) return TOOL_NAMES.filter(name => EMAIL_TOOLS.has(name));
  if (turn.channel === 'email') return TOOL_NAMES.filter(name => EMAIL_TOOLS_VERIFIED.has(name) && (!MANAGER_TOOLS.has(name) || turn.manager));
  return TOOL_NAMES.filter(name => name !== 'reply' && (!MANAGER_TOOLS.has(name) || turn.manager));
}

const list = (value: unknown, max: number, each = 400) => (Array.isArray(value) ? value : []).slice(0, max).map(v => String(v).trim().slice(0, each)).filter(Boolean);
/** The model's file_ticket arguments as a ticket; a bug without its reproduction is refused, so the model adds it. */
export function ticketInput(a: Record<string, unknown>): TicketInput {
  const type = (TICKET_TYPES as readonly string[]).includes(String(a.type)) ? a.type as TicketType : 'other';
  const details: TicketDetails = {};
  if (a.topic && (TICKET_TOPICS as readonly string[]).includes(String(a.topic))) details.topic = String(a.topic);
  if (type === 'bug') {
    const bug = { reproSteps: list(a.reproSteps, 10), affected: String(a.affected ?? '').trim().slice(0, 200), requestIds: list(a.requestIds, 10, 40).filter(r => /^req_[0-9a-f]{32}$/.test(r)),
      errorCodes: list(a.errorCodes, 10, 80), expected: String(a.expected ?? '').trim().slice(0, 400), actual: String(a.actual ?? '').trim().slice(0, 400) };
    if (!bug.reproSteps.length || !bug.affected) throw new ToolFailure('A bug ticket needs reproSteps (how to make it happen) and affected (the API route or dashboard page). Add them, with the request IDs and error codes you saw, and call file_ticket again.');
    details.bug = bug;
  }
  if (type === 'deliverability' && a.affected) details.deliverability = { affected: String(a.affected).trim().slice(0, 200) };
  if (type === 'feature_request') {
    if (!String(a.useCase ?? '').trim()) throw new ToolFailure('A feature request needs useCase: what the customer is trying to do and why.');
    details.featureRequest = { useCase: String(a.useCase).trim().slice(0, 600) };
  }
  return {
    type, title: String(a.title ?? '').trim().slice(0, 80) || type.replace('_', ' '), severity: (['P1', 'P2', 'P3'].includes(String(a.severity)) ? a.severity : 'P3') as TicketInput['severity'],
    summary: String(a.summary ?? '').slice(0, 1200), ask: String(a.ask ?? '').slice(0, 600),
    tried: list(a.tried, 12).map(item => { const [tool, ...rest] = item.split(':'); return { tool: (tool ?? '').trim().slice(0, 60), finding: rest.join(':').trim().slice(0, 400) }; }),
    recommendation: String(a.recommendation ?? '').slice(0, 800), evidence: { ids: list(a.evidence, 20, 120) }, details,
  };
}
