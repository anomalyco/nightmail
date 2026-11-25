// Renders every email Nightmail sends a customer about their account (src/notices.ts), for review: each one built as
// its job builds it and shown through the product's own mail-client emulation (src/email-preview). Nothing is sent and
// no database is read.
//   node --import tsx scripts/render-notices.ts <out-dir>
// Writes <out-dir>/notices.json: each email's subject, text and HTML, and one emulated document per picture.
// app/scripts/notice-shots.mjs turns those into PNGs and contact sheets.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noticeEmail, type NoticeContext } from '../src/billing/notify.js';
import { microCents } from '../src/billing/money.js';
import type { NoticeKind as BillingKind } from '../src/billing/types.js';
import { publicOrigin } from '../src/brand.js';
import { emulate, type Client } from '../src/email-preview/index.js';
import { customerNotice, type Notice, type NoticeInput } from '../src/notices.js';

const out = process.argv[2];
if (!out) throw new Error('Usage: node --import tsx scripts/render-notices.ts <out-dir>');
const workspace = 'Driftwood', origin = publicOrigin, from = 'system@nightmail.dev', members = 'owners and admins';
const date = (iso: string) => new Date(iso + 'T12:00:00Z');
const escapeHtml = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// A message's text part, as a client that shows only text does: its lines kept, in the client's own font.
const textAsHtml = (text: string) => '<!doctype html><html><head></head><body><div style="white-space:pre-wrap">' + escapeHtml(text) + '</div></body></html>';

type Email = Notice & { name: string; title: string; to: string };
type Shot = { file: string; email: string; client: Client; device: 'desktop' | 'mobile'; theme: 'light' | 'dark'; part: 'html' | 'text'; document: string };
const emails: Email[] = [], shots: Shot[] = [];
const shot = (file: string, email: Email, client: Client, device: Shot['device'], theme: Shot['theme'], part: Shot['part'] = 'html') =>
  shots.push({ file, email: email.name, client, device, theme, part, document: emulate(part === 'html' ? email.html : textAsHtml(email.text), { client, device, theme }).html });
// Each email in Apple Mail, on a desktop and a phone, light and dark.
const add = (name: string, title: string, to: string, notice: Notice) => {
  const email: Email = { name, title, to, ...notice };
  emails.push(email);
  for (const [device, client] of [['desktop', 'apple-mail-macos'], ['mobile', 'apple-mail-ios']] as const) for (const theme of ['light', 'dark'] as const)
    shot(name + '-' + (device === 'mobile' ? 'phone' : 'desktop') + (theme === 'dark' ? '-dark' : '') + '.png', email, client, device, theme);
  return email;
};
const account = (name: string, title: string, input: NoticeInput, to = members) => add(name, title, to, customerNotice(origin, input));
// A billing email, from the notice kind and the account's position, as billing.notify builds it.
const usd = (dollars: number) => microCents(BigInt(Math.round(dollars * 100)) * 1_000_000n);
const billing = (name: string, title: string, kind: BillingKind, context: Partial<NoticeContext>) =>
  add(name, title, members, noticeEmail(kind, { workspace, origin, totalUc: usd(0), freeLeft: 0, unpaidSince: null, receiveHold: true, data: {}, ...context }));

const paused = account('paused', 'Sending is paused (any cause, Amazon included)', { kind: 'paused', workspace });
account('restricted', 'Marketing is put on hold', { kind: 'restricted', workspace });
account('warned', 'A warning', { kind: 'warned', workspace });
account('resumed', 'A pause ends', { kind: 'resumed', workspace });
account('resumed-marketing-held', 'A pause ends, marketing still on hold (an owner’s own resume)', { kind: 'resumed', workspace, marketingHeld: true });
account('campaign-paused', 'A campaign pauses itself', { kind: 'campaign_paused', workspace, campaign: { id: 'cmp_8f3k2n', name: 'Autumn catalogue' } });
account('domain-unverified', 'A domain stops verifying', { kind: 'domain_unverified', workspace, domain: { id: 'dom_41xq7c', name: 'driftwood.example' } });
account('domain-setup', 'A new domain’s records are still missing an hour on', { kind: 'domain_setup', workspace, domain: { id: 'dom_41xq7c', name: 'driftwood.example' }, total: 4, wrong: false,
  missing: [{ type: 'TXT', name: '_nightmail', value: '6f1c2d9e-4b7a-4e0f-9a3c-2d8b5e7f1a04' }, { type: 'CNAME', name: 'q3v7kd2mxa4t6n8p1r5s9u0w2y4b6c8e._domainkey', value: 'q3v7kd2mxa4t6n8p1r5s9u0w2y4b6c8e.dkim.amazonses.com' }],
  host: { name: 'Cloudflare', url: 'https://dash.cloudflare.com/?to=/:account/driftwood.example/dns/records' }, releasesAt: date('2026-11-27') });
account('no-domain', 'A new workspace has no domain an hour on', { kind: 'no_domain', workspace });
account('limit-reached', 'The daily limit is reached', { kind: 'limit_reached', workspace });
account('evaluation-passed', 'The new-sender evaluation ends well', { kind: 'evaluation_finished', workspace, limited: false });
account('evaluation-limited', 'The new-sender evaluation ends with a limit', { kind: 'evaluation_finished', workspace, limited: true });
billing('balance-low', 'Balance is low', 'low_balance', { totalUc: usd(4.2) });
billing('out-of-credit', 'Balance is empty', 'sends_paused', { unpaidSince: date('2026-11-29') });
billing('recharge-failed', 'Auto-recharge is declined', 'recharge_failed', { totalUc: usd(3.1), data: { last4: '4242', code: 'card_declined' } });
billing('receive-hold-soon', 'Two days before received mail is held', 'receive_hold_soon', { totalUc: usd(-1.84), unpaidSince: date('2026-11-29') });
billing('receive-held', 'Received mail is held', 'receive_held', { totalUc: usd(-1.84), unpaidSince: date('2026-11-29') });
billing('credit-expiring', '30 days before credit expires', 'credit_expiring', { totalUc: usd(40), data: { remainingUc: String(usd(12)), expiresAt: '2026-12-22T00:00:00Z' } });
account('invitation', 'A teammate is invited', { kind: 'invitation', inviter: { email: 'mara@driftwood.example' }, role: 'admin', expiresAt: date('2026-11-29'),
  acceptUrl: origin + '/overview?invitation=inv_6t2m9d' }, 'the invited address');
account('waitlist', 'A waitlisted address is let in (no trigger yet)', { kind: 'waitlist_admitted' }, 'the waitlisted address');
account('signin-link', 'A sign-in link to an address that was let in', { kind: 'signin_link', url: origin + '/overview?link=lnk_fixture.mac', minutes: 30 }, 'the address that was let in');

// The paused email's text part, and its HTML part in other clients.
shot('client-text-part.png', paused, 'gmail-web', 'desktop', 'light', 'text');
for (const [client, device, theme] of [['gmail-web', 'desktop', 'light'], ['outlook-web', 'desktop', 'light'], ['outlook-web', 'desktop', 'dark'], ['yahoo-web', 'desktop', 'light'],
  ['gmail-ios', 'mobile', 'dark'], ['gmail-android', 'mobile', 'dark'], ['samsung-email', 'mobile', 'dark']] as const)
  shot('client-' + client + (theme === 'dark' ? '-dark' : '') + '.png', paused, client, device, theme);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'notices.json'), JSON.stringify({ from, emails, shots }, null, 1));
console.log(emails.length + ' emails, ' + shots.length + ' pictures to take: ' + join(out, 'notices.json'));
