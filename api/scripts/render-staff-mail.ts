// Renders the emails support sends staff (src/support-staff-mail.ts), for review: each built from synthetic cases as the
// planner builds them, shown through the product's mail-client emulation (src/email-preview). Nothing is sent and no
// database is read.
//   node --import tsx scripts/render-staff-mail.ts <out-dir>
// Writes <out-dir>/notices.json like scripts/render-notices.ts, so app/scripts/notice-shots.mjs turns it into PNGs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publicOrigin } from '../src/brand.js';
import { emulate, type Client } from '../src/email-preview/index.js';
import type { Notice } from '../src/notices.js';
import { conversationEmail, feedbackEmail, needOf, subjectOf, unroutedEmail, whoOf, type StaffRow } from '../src/support-staff-mail.js';

const out = process.argv[2];
if (!out) throw new Error('Usage: node --import tsx scripts/render-staff-mail.ts <out-dir>');
const origin = publicOrigin, from = 'support@nightmail.dev', to = 'the team (TICKET_TO)', now = Date.parse('2026-11-25T14:20:00Z');
const minutesAgo = (n: number) => new Date(now - n * 60_000).toISOString();

type Email = Notice & { name: string; title: string; to: string };
type Shot = { file: string; email: string; client: Client; device: 'desktop' | 'mobile'; theme: 'light' | 'dark'; part: 'html' | 'text'; document: string };
const emails: Email[] = [], shots: Shot[] = [];
// Remote content blocked: the only thing these emails load is the dashboard's own font, so without it the fallbacks show.
const blocked = (html: string) => html.replace(/<style>@media screen\{@font-face[^<]*<\/style>/, '');
const add = (name: string, title: string, notice: Notice) => {
  const email: Email = { name, title, to, ...notice };
  emails.push(email);
  const shot = (suffix: string, client: Client, device: Shot['device'], theme: Shot['theme'], html = email.html) =>
    shots.push({ file: `${name}-${suffix}.png`, email: name, client, device, theme, part: 'html', document: emulate(html, { client, device, theme }).html });
  shot('iphone-dark', 'apple-mail-ios', 'mobile', 'dark');
  shot('gmail-light', 'gmail-web', 'desktop', 'light');
  shot('images-blocked', 'apple-mail-ios', 'mobile', 'light', blocked(email.html));
};

const row = (r: Partial<StaffRow>): StaffRow => ({
  id: 'conv_7qk2m4xw9tbp3n6hr5vjc8sdfa', channel: 'chat', filed_by: null, mode: 'member', verification: 'handoff', status: 'ticketed', subject: null, pending_address: null,
  user_id: 'usr_ada', user_name: 'Ada Lovelace', user_email: 'ada@acme.example', workspace_id: 'ws_acme', workspace_name: 'Acme Prod',
  ticket_id: 'tkt_m3q7xk2vd9ph4tnr', ticket_type: 'staff', ticket_severity: 'P2', ticket_resolved_at: null, agent_state: 'active', paused_by: null, paused_by_name: null, paused_at: null,
  messages: 3, turns: 1, cost_usd: 0.04, blocked_work: 0, created_at: minutesAgo(40), last_message_at: minutesAgo(38), closed_at: null, activity_at: minutesAgo(38),
  last_author: 'agent', last_text: null, last_held: true, queued: 0, opening: null, done_at: null, done_by: null, done_by_name: null, unread: true, needs_you: true, urgency: 2, since: minutesAgo(40),
  why_ticket: true, why_blocked: false, why_failed: false, why_paused: false, why_no_reply: true,
  brief: null, evidence: null, staff_thread: null, staff_seq: 0, staff_reasons: [], role: 'owner', max_seq: 3, held_reason: null, held_seq: null,
  first_words: { text: 'Why did my bounce rate jump on the last campaign? It was 0.4% last month and now it says 6%.\nI only sent to the same list as always, plus the people who signed up at the Oct 25 event.\nIs something wrong with my domain?\nThanks, Ada', at: minutesAgo(40) }, fresh_words: null, operation: null, request_id: null, filed_at: null, failed_by: null, triage_summary: null, ...r,
});
const reasons = (r: StaffRow) => (['ticket', 'blocked', 'failed', 'paused', 'no_reply'] as const).filter(x => r[`why_${x}`]);
const conversation = (name: string, title: string, r: StaffRow, first = true, approval: { label: string; url: string } | null = null) => {
  const rs = reasons(r), subject = subjectOf(needOf(r, rs), r, whoOf(r).short);
  add(name, title, conversationEmail(origin, r, rs, first, now, approval, subject));
};

const held = row({ held_reason: 'gate', held_seq: 2, brief: { title: 'Bounce rate jumped on the Autumn campaign', summary: 'Ada asked why her last campaign bounced so much. Gmail hard-bounced 61 of 1,000 sends, all from one import on Oct 25.', ask: 'Why did my bounce rate jump?',
  recommendation: 'Send it. The addresses it names are her own recipients.', tried: [{ tool: 'bounce_reasons', finding: '61 hard bounces at Gmail' }, { tool: 'list_events', finding: 'all from the Oct 25 import' }] } });
conversation('held-answer', 'An answer the output check held (a signed-in chat), with its approve link', held, true,
  { label: 'Send the held answer', url: `${origin}/support/conv_7qk2m4xw9tbp3n6hr5vjc8sdfa?approval=apr_m2n3b4v5c6x7z2l3k4j5h6g7f2&token=U2VuZCB0aGUgaGVsZCBhbnN3ZXIgdG9rZW4` });
conversation('held-answer-update', 'The same, 40 minutes later: they wrote again', { ...held, staff_thread: 'conv:x', staff_seq: 3, staff_reasons: ['ticket', 'no_reply'], fresh_words: [{ text: 'Hello? Is anyone looking at this?', at: minutesAgo(2) }] }, false);
conversation('no-reply', 'No reply sent, to a sender with no account (email)', row({ channel: 'email', mode: 'non_member', verification: 'dmarc', user_id: null, user_name: null, user_email: null, workspace_id: null, workspace_name: null,
  pending_address: 'kim@elsewhere.example', why_ticket: false, last_author: 'customer', last_held: false, since: minutesAgo(65), first_words: { text: 'Hi, can I move my sending domain to another workspace without verifying it again?', at: minutesAgo(65) } }));
conversation('blocked', 'Stuck work, with an approve link', row({ why_ticket: false, why_no_reply: false, why_blocked: true, blocked_work: 2, last_author: 'customer', last_held: false, first_words: { text: 'Is my domain verified yet?', at: minutesAgo(12) } }), true,
  { label: 'Retry the stuck work', url: `${origin}/support/conv_7qk2m4xw9tbp3n6hr5vjc8sdfa?approval=apr_r4t6y2u3i4o5p6a7s2d3f4g5hk&token=Q2xvc2VyIGxvb2sgYXQgdGhlIHRva2VuIGhlcmU` });
const report = (id: string, text: string, minutes: number, operation: string | null, request: string | null) => row({ id, channel: 'agent_feedback', mode: 'unverified', verification: 'none', user_id: null, user_name: null, user_email: null,
  ticket_type: 'agent_feedback', ticket_id: `tkt_${id.slice(5, 21)}`, why_no_reply: false, evidence: { filedBy: 'the API key "deploy bot"' }, operation, request_id: request, filed_at: minutesAgo(minutes), first_words: { text, at: minutesAgo(minutes) } });
const one = { ...report('conv_f1x7m2q9k4v8t3n6p5r2h7d9wb', 'Deleting an inbox kept its address: creating one with the same address again answers 409 ADDRESS_TAKEN.', 9, 'createInbox', 'req_' + '3f'.repeat(16)),
  triage_summary: 'A deleted inbox’s address is held for a while, so creating it again is refused; the docs explain the hold, but the error’s name does not.' };
add('feedback-report', 'One agent feedback report', feedbackEmail(origin, [one], true, subjectOf('feedback', one, whoOf(one).short)));
const two = report('conv_g2y8n3r4l5w9u4p7q6s3j8e2xc', 'The receiving host check stays pending after its MX record resolves.', 7, 'getInboundDomain', null);
add('feedback-group', 'Two reports from one workspace, close together', feedbackEmail(origin, [one, two], true, `2 agent feedback reports from ${whoOf(one).short}`));
add('unrouted', 'An email that never became a conversation', unroutedEmail(origin, { thread_id: 'thr_x', id: 'msg_' + '8c'.repeat(16), subject: 'Question about pricing', from_address: 'lee@elsewhere.example', dmarc: 'PASS',
  text: 'Hello, do you charge for received mail as well as sent mail?', html: null, received_at: minutesAgo(50), address: 'support@nightmail.dev' }, 'tkt_w4k8q2m6x3v7t9n5', 'Unanswered email to support: Question about pricing'));

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'notices.json'), JSON.stringify({ from, emails, shots }, null, 1));
for (const email of emails) writeFileSync(join(out, `${email.name}.txt`), `Subject: ${email.subject}\n\n${email.text}`);
console.log(`${emails.length} emails, ${shots.length} pictures to take: ${join(out, 'notices.json')}`);
