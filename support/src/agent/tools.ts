import { toolResult } from './projection.js';
import { productName } from '../../../api/src/brand.js';

// The agent's tools (design §4.1). Every account tool is a closure over the conversation's grant: the model never
// passes, sees or chooses identity, and can only narrow to a workspace already in the grant. Each tool has a label
// for the panel's progress line (support/PROTOCOL.md §4.3) that never contains arguments.

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
  /** A grant-scoped GET under /v1/support (path with query); throws ToolFailure with a customer-safe message. */
  read(path: string): Promise<unknown>;
  /** The workspace this conversation is about, when one is chosen. */
  workspaceId(): string | null;
  chooseWorkspace(workspaceId: string): Promise<string>;
  requestContentAccess(workspaceId: string, why: string): Promise<string>;
  fileTicket(input: TicketInput): Promise<string>;
}
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

const DAYS = /^\d{1,2}$/;
const ID = '^[A-Za-z0-9_.:-]{1,120}$';
const sinceParam: Param = { type: 'number', description: 'Days back, 1–30 (default 7)', optional: true, min: 1, max: 30 };

function query(args: Record<string, unknown>, host: ToolHost, map: Record<string, string> = {}) {
  // Always the conversation's workspace: a grant covers just that one (the handoff's, or the one chosen by email).
  const q = new URLSearchParams(), workspace = host.workspaceId();
  if (workspace) q.set('workspaceId', workspace);
  for (const [key, value] of Object.entries(args)) {
    if (key === 'workspaceId' || value === undefined || value === null || value === '') continue;
    if (key === 'days') { if (DAYS.test(String(value))) q.set('since', new Date(Date.now() - Number(value) * 86_400_000).toISOString()); continue; }
    if (key === 'hours') { if (DAYS.test(String(value))) q.set('since', new Date(Date.now() - Math.min(72, Number(value)) * 3_600_000).toISOString()); continue; }
    q.set(map[key] ?? key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
const seg = (value: unknown) => encodeURIComponent(String(value));
const read = (path: (a: Record<string, unknown>, h: ToolHost) => string) => async (args: Record<string, unknown>, host: ToolHost) => toolResult(await host.read(path(args, host)));
const fixed = (running: string, done: string) => () => ({ running, done });
const providerName = (p: unknown) => typeof p === 'string' && p ? ({ gmail: 'Gmail', microsoft: 'Outlook', yahoo: 'Yahoo', apple: 'iCloud', proton: 'Proton', gmx: 'GMX' } as Record<string, string>)[p] ?? p : null;

export const TOOLS: ToolSpec[] = [
  { name: 'account_context', description: 'First call for an account question (unless <account> has it): the customer, workspaces and roles, sending setup and limits, domains, failures in the last 24 hours, open enforcement, recent changes, request IDs.',
    params: {}, label: fixed('Looking up your account…', 'Looked up your account'), execute: read((a, h) => `/v1/support/context${query(a, h)}`) },
  { name: 'list_workspaces', description: 'Workspaces with role, sending connection and resource counts.', params: {},
    label: fixed('Listing your workspaces…', 'Listed your workspaces'), execute: read((a, h) => `/v1/support/workspaces${query(a, h)}`) },
  { name: 'list_domains', description: 'Domains: stored DKIM, MAIL FROM, DMARC and receiving state, and the DNS records Nightmail expects.', params: {},
    label: fixed('Checking your domains…', 'Checked your domains'), execute: read((a, h) => `/v1/support/domains${query(a, h)}`) },
  { name: 'get_standing', description: 'Standing: score, daily limit, ladder step and reasons, pauses, overrides, strikes, 60 days of history, limitRequest eligibility, the last 24 hours by status.',
    params: {}, label: fixed('Checking your sending standing…', 'Checked your sending standing'), execute: read((a, h) => `/v1/support/standing${query(a, h)}`) },
  { name: 'get_billing', description: 'Balance, ledger (top-ups, usage, refunds, credits) and auto-recharge; owners and admins only.',
    params: {}, label: fixed('Checking your billing…', 'Checked your billing'), execute: read((a, h) => `/v1/support/billing${query(a, h)}`) },
  { name: 'get_audit', description: 'Activity trail (who changed keys, members, domains, webhooks, and when), newest first; owners and admins only.',
    params: { action: { type: 'string', description: 'Action prefix, e.g. "api_key."', optional: true, max: 60 }, limit: { type: 'number', description: '1–50 (default 20)', optional: true, min: 1, max: 50 } },
    label: fixed('Reading your activity log…', 'Read your activity log'), execute: read((a, h) => `/v1/support/audit${query(a, h)}`) },
  { name: 'list_emails', description: 'Sent or received mail, newest first: addresses, subject, status, error codes (no bodies).',
    params: { direction: { type: 'enum', values: ['sent', 'received'], description: 'Default sent.', optional: true }, status: { type: 'string', description: 'e.g. bounced, failed, suppressed, delivered', optional: true, max: 40 },
      days: sinceParam, limit: { type: 'number', description: '1–50 (default 25)', optional: true, min: 1, max: 50 }, cursor: { type: 'string', description: 'nextCursor of the previous page', optional: true, max: 200 } },
    label: fixed('Looking through your emails…', 'Looked through your emails'), execute: read((a, h) => `/v1/support/emails${query(a, h)}`) },
  { name: 'get_email', description: 'One email and its delivery events; the body only with content access.',
    params: { emailId: { type: 'string', description: 'The email ID', max: 120, pattern: ID } },
    label: fixed('Opening that email…', 'Opened that email'), execute: read((a, h) => `/v1/support/emails/${seg(a.emailId)}${query({}, h)}`) },
  { name: 'list_events', description: 'Raw delivery events (send, delivery, bounce, complaint, delay, reject, open, click), newest first.',
    params: { emailId: { type: 'string', description: 'Only this email', optional: true, max: 120, pattern: ID }, type: { type: 'string', description: 'e.g. bounce, complaint', optional: true, max: 40 }, days: sinceParam },
    label: fixed('Checking delivery events…', 'Checked delivery events'), execute: read((a, h) => `/v1/support/events${query(a, h)}`) },
  { name: 'list_webhook_deliveries', description: 'Webhook deliveries: attempts, last HTTP status, error (no payloads or URLs).',
    params: { status: { type: 'enum', values: ['pending', 'delivered', 'failed', 'paused'], description: 'Filter by status', optional: true }, days: sinceParam },
    label: fixed('Checking your webhook deliveries…', 'Checked your webhook deliveries'), execute: read((a, h) => `/v1/support/webhook-deliveries${query(a, h)}`) },
  { name: 'api_errors', description: 'First call for errors, 5xx or a broken integration: the customer’s own failed requests (apps, SDK, MCP, agents) over the last 3 days, grouped by route, status and error code, with counts, first and last seen, and sample request IDs for explain_request.',
    params: { status: { type: 'enum', values: ['error', '5xx', '4xx'], description: 'Default error (any 4xx or 5xx)', optional: true },
      hours: { type: 'number', description: 'Hours back, 1–72 (default 24)', optional: true, min: 1, max: 72 },
      route: { type: 'string', description: 'Route template, e.g. "/v1/emails/send"', optional: true, max: 200 }, code: { type: 'string', description: 'Error code, e.g. INTERNAL_ERROR', optional: true, max: 80 } },
    label: fixed('Reading your recent logs…', 'Read your recent logs'), execute: read((a, h) => `/v1/support/requests${query({ status: 'error', ...a }, h)}`) },
  { name: 'explain_request', description: 'One request ID (req_…): its log lines (route, status, error code, duration) and what it changed.',
    params: { requestId: { type: 'string', description: 'req_ followed by 32 hex characters', max: 40, pattern: '^req_[0-9a-f]{32}$' } },
    label: fixed('Looking into this request…', 'Looked into this request'), execute: read((a, h) => `/v1/support/requests/${seg(a.requestId)}${query({}, h)}`) },
  { name: 'delivery_metrics', description: 'Delivery, bounce, complaint, open, click and unsubscribe rates over time (up to 30 days), with numerators and denominators, optionally grouped. Includes findings[].',
    params: { days: { ...sinceParam, description: 'Days back, 1–30 (default 14)' } as Param, granularity: { type: 'enum', values: ['day', 'hour'], description: 'hour only for ≤ 3 days', optional: true },
      groupBy: { type: 'enum', values: ['none', 'campaign', 'from_domain', 'provider', 'stream'], description: 'Split by', optional: true }, stream: { type: 'enum', values: ['transactional', 'marketing', 'all'], description: 'Default all', optional: true },
      campaignId: { type: 'string', description: 'Only this campaign', optional: true, max: 120, pattern: ID }, fromDomain: { type: 'string', description: 'Only mail from this domain', optional: true, max: 253 } },
    label: a => a.groupBy === 'provider' ? { running: 'Comparing results by mailbox provider…', done: 'Compared results by mailbox provider' } : a.groupBy === 'campaign' ? { running: 'Comparing your campaigns…', done: 'Compared your campaigns' } : { running: 'Checking your delivery numbers…', done: 'Checked your delivery numbers' },
    execute: read((a, h) => `/v1/support/deliverability/metrics${query({ days: 14, ...a }, h)}`) },
  { name: 'bounce_reasons', description: 'Bounces, deferrals and complaints by provider, type, SMTP code and diagnostic, with first and last seen and top campaigns; the first-send bounce rate. Includes findings[].',
    params: { days: sinceParam, provider: { type: 'enum', values: ['gmail', 'microsoft', 'yahoo', 'apple', 'proton', 'gmx', 'other'], description: 'Only this provider', optional: true },
      type: { type: 'enum', values: ['bounce', 'deferral', 'complaint'], description: 'Default all', optional: true }, campaignId: { type: 'string', description: 'Only this campaign', optional: true, max: 120, pattern: ID }, fromDomain: { type: 'string', description: 'Only mail from this domain', optional: true, max: 253 } },
    label: a => { const p = providerName(a.provider); return p ? { running: `Checking your ${p} bounces…`, done: `Checked your ${p} bounces` } : { running: 'Checking your bounces…', done: 'Checked your bounces' }; },
    execute: read((a, h) => `/v1/support/deliverability/bounces${query(a, h)}`) },
  { name: 'domain_health', description: 'One domain read live: verification, SPF, DMARC (p, rua, alignment), BIMI, MAIL FROM, volume and age, marketing vs transactional mix. Includes findings[].',
    params: { domainId: { type: 'string', description: 'A domain ID (dom_…)', max: 120, pattern: ID } },
    label: fixed('Checking your domain’s DNS…', 'Checked your domain’s DNS'), execute: read((a, h) => `/v1/support/domains/${seg(a.domainId)}/health${query({}, h)}`) },
  { name: 'screen_rejections', description: 'Spam screen, up to 7 days: hourly screened and rejected counts, and the last 50 rejections with subject, code and score.',
    params: { days: { type: 'number', description: '1–7 (default 7)', optional: true, min: 1, max: 7 } },
    label: fixed('Checking content screen rejections…', 'Checked content screen rejections'), execute: read((a, h) => `/v1/support/screen${query(a, h)}`) },
  { name: 'list_campaigns', description: 'Recent campaigns: state, audience, tracking, From, subject, stats, pacing, pause reason.',
    params: { days: sinceParam, state: { type: 'string', description: 'e.g. sent, sending, paused, draft', optional: true, max: 40 } },
    label: fixed('Looking at your campaigns…', 'Looked at your campaigns'), execute: read((a, h) => `/v1/support/campaigns${query(a, h)}`) },
  { name: 'get_campaign', description: 'One campaign with stats and pacing; content only with content access.',
    params: { campaignId: { type: 'string', description: 'The campaign ID', max: 120, pattern: ID } },
    label: fixed('Opening that campaign…', 'Opened that campaign'), execute: read((a, h) => `/v1/support/campaigns/${seg(a.campaignId)}${query({}, h)}`) },
  { name: 'lint_email', description: 'Structural checks on one email (size, parts, unsubscribe headers, alignment, subject); with content access also links, images vs text, shorteners, tokens.',
    params: { emailId: { type: 'string', description: 'The email ID', max: 120, pattern: ID } },
    label: fixed('Checking that email’s structure…', 'Checked that email’s structure'), execute: read((a, h) => `/v1/support/emails/${seg(a.emailId)}/lint${query({}, h)}`) },
  { name: 'lint_campaign', description: 'lint_email’s checks for a campaign’s current content.',
    params: { campaignId: { type: 'string', description: 'The campaign ID', max: 120, pattern: ID } },
    label: fixed('Checking that campaign’s structure…', 'Checked that campaign’s structure'), execute: read((a, h) => `/v1/support/campaigns/${seg(a.campaignId)}/lint${query({}, h)}`) },
  { name: 'audience_health', description: 'List hygiene: consent mix, suppressions by reason, stale share, role and typo addresses, provider mix, and recent imports with their first-send bounce and complaint rates.',
    params: { listId: { type: 'string', description: 'Only this list', optional: true, max: 120, pattern: ID } },
    label: fixed('Checking your audience’s health…', 'Checked your audience’s health'), execute: read((a, h) => `/v1/support/audience/health${query(a, h)}`) },
  { name: 'choose_workspace', description: 'Email only: narrows access to the workspace the customer named (an ID from <customer>).',
    params: { workspaceId: { type: 'string', description: 'A workspace ID from <customer>', max: 100, pattern: ID } },
    label: fixed('Switching to that workspace…', 'Switched workspace'), execute: (a, h) => h.chooseWorkspace(String(a.workspaceId)) },
  { name: 'request_content_access', description: 'Ask to read email and campaign bodies in one workspace for this conversation, only when content is the likely cause.',
    params: { why: { type: 'string', description: 'One sentence the customer sees, e.g. "To check why the screen rejected your Nov 3 promo, I need to read its HTML."', max: 240 } },
    label: fixed('Asking for content access…', 'Asked for content access'), execute: (a, h) => h.requestContentAccess(String(h.workspaceId() ?? ''), String(a.why ?? '')) },
  { name: 'file_ticket', description: `Pass the conversation to the ${productName} team (§7). One per conversation; calling again adds to it.`,
    params: {
      type: { type: 'enum', values: TICKET_TYPES, description: 'The team’s queue (§7)' },
      title: { type: 'string', description: 'Specific subject line', max: 80 },
      severity: { type: 'enum', values: ['P1', 'P2', 'P3'], description: '§7' },
      topic: { type: 'enum', values: TICKET_TOPICS, description: 'The ask within the type', optional: true },
      summary: { type: 'string', description: 'Three sentences: the situation, the cause if known, what they want', max: 1200 },
      ask: { type: 'string', description: 'Their request in their own words', max: 600 },
      tried: { type: 'strings', description: 'One "tool: finding" per check', max: 12 },
      recommendation: { type: 'string', description: 'The exact action, with the evidence', max: 800 },
      evidence: { type: 'strings', description: 'Request, email, campaign, domain IDs', optional: true, max: 20 },
      reproSteps: { type: 'strings', description: 'bug: steps to reproduce', optional: true, max: 10 },
      affected: { type: 'string', description: 'bug: the route or page; deliverability: the provider, domain or campaign', optional: true, max: 200 },
      requestIds: { type: 'strings', description: 'bug: failing request IDs', optional: true, max: 10 },
      errorCodes: { type: 'strings', description: 'bug: e.g. "500 INTERNAL_ERROR"', optional: true, max: 10 },
      expected: { type: 'string', description: 'bug', optional: true, max: 400 },
      actual: { type: 'string', description: 'bug', optional: true, max: 400 },
      useCase: { type: 'string', description: 'feature_request: what they want to do and why', optional: true, max: 600 },
    },
    label: fixed(`Passing this to the ${productName} team…`, `Passed this to the ${productName} team`),
    execute: (a, h) => h.fileTicket(ticketInput(a)) },
];
export const TOOL_NAMES = TOOLS.map(t => t.name);

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
