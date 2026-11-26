// CLS gate: cumulative layout shift on every main dashboard page, light and dark, on a cold full load and on in-app
// navigation, over a throttled network with slow API responses that arrive out of order (web fonts load before any text,
// the same way every run; CLS_FONTS=late delays them instead); the main pages again on a
// phone (390 × 844, touch: the tab bar, cards and native selects). Fails when any page's CLS
// exceeds 0.001 (or a page errors). The longest task during each in-app navigation is reported, not gated: on CI's
// shared runner the composer and rules chunks measured 105–179 ms between runs of the same page, too close to a
// 200 ms budget to fail on without flakes.
//
// From app/: bun run cls (builds first), or node scripts/cls.mjs against an existing build.
//   CLS_ONLY=<regex>   only pages whose name matches
//   CLS_WORKERS=<n>    override the number of pages measured at once (default: 2 per CPU, at most 8)
//   CLS_PG_URL=<url>   Postgres admin URL (CI); otherwise Docker or a local initdb (see cls-fixture.mjs)
//   CLS_CHROME=<path>  Chrome executable; otherwise the installed Google Chrome
//   CLS_SHOTS=1        screenshot every page, not only failing ones
//   CLS_PHONE=0        skip the phone pass
//   CLS_FONTS=late     deliver web fonts 1.8 s late, to measure the fallback-to-web-font swap
//   CLS_HOME=tv        measure the television homepage instead (below), over app/dist-tv: build it first with
//                      VITE_HOME=tv ./node_modules/.bin/vite build --outDir dist-tv
// Writes .cls/report.json (every shift with its source elements), .cls/summary.md (also appended to
// $GITHUB_STEP_SUMMARY) and a screenshot per failing page with the shifted elements outlined (with CLS_HOME=tv, in .cls/tv).
//
// Live rules (`live`): on Driftwood's rules page, an agent's API key saves the open rule once the page has settled
// (`apply`: the change lands in the editor and a toast names who made it), or after a keystroke in the editor
// (`conflict`: the card offering their version or yours opens over the editor's corner). The pages' long poll on
// /v1/rules/version is always open by design, so it is left out of the network-idle wait.
//
// Support chat: the page loads, then Help (the sidebar's row; the top bar's button on a phone) opens the chat (the scripted demo conversation) and the agent's
// greeting streams in to its end; in-app, the chat stays open on Overview while the sidebar link goes to Logs (on a
// phone, where the chat is a sheet over the page, the tab bar's link closes it).
//
// The homepage's machine, running, takes every core software WebGL can have (12 on a laptop, in SwiftShader): beside
// other pages on CI's 4-core runner, their page.goto ran past 60 s (Nov 16). Signed out measures it running `alone`,
// after every other page, one at a time. Pages that only start from the homepage, or show it as Signed out does with
// another button, see it `still` (reduced motion: the same layout, one frame drawn).
//
// The television homepage (features/home/tv) is "/" in a build made with VITE_HOME=tv: the dev stage's (deploy.yml), not
// production's. CLS_HOME=tv measures its pages alone, on desktop and phone, over that build (app/dist-tv; ci.yml runs it
// in one shard after the rest): signed out, playing `alone` as the factory does; signed in and its button to Overview,
// `still`. Its first screen comes from home.html (home-tv.ts) and the app takes over by itself (tv/shell/boot.js: once
// the first pictures are in, or after 8 s), with no input: a load waits for that takeover, so it is measured too.
//
// Dialogs (`dialog`): once the page has settled, the control whose text starts with `dialog` opens its dialog (a bottom
// sheet on a phone), and the measurement covers the load and the open dialog together, once its entrance has ended.
//
// Every measurement also checks the masked addresses on its page (lib/private-address.ts): nothing of a seeded address
// beyond its first two characters is in the page's text, a title, a label or a link before it is revealed, and on a
// cold desktop load, pointing at the first few reveals nothing until ⇧ is held, which reveals them without anything
// moving; on a list with row keys, J's highlight reveals none of its row's addresses until ⇧ is held, and releasing ⇧
// masks them again; and turning privacy mode off with ⇧P reveals them all (then on again, which masks them as before). Privacy mode is off
// by default; every page here starts with it on.
//
// CLS sums every layout-shift entry without recent input: stricter than the browser's largest session window. In-app
// navigation clicks with an untrusted event, so no shift is excused as following user input. Measurement ends when
// no request is in flight, fonts are loaded and the page has rendered and gone idle twice in a row; there are no
// fixed sleeps, and polling pages settle between polls.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { liveSource, seed, start } from './cls-fixture.mjs';

const LIMIT = 0.001, JOB_TIMEOUT_MS = 90_000;
const television = process.env.CLS_HOME === 'tv';
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..'), repo = resolve(app, '..'), out = join(app, '.cls', television ? 'tv' : '');
const only = process.env.CLS_ONLY ? new RegExp(process.env.CLS_ONLY, 'i') : null;
// Each in-flight page owns a renderer. Leave room for the fixture API, other shards and their databases.
const workers = Number(process.env.CLS_WORKERS) || Math.min(8, availableParallelism() * 2);
const shard = Number(process.env.CLS_SHARD_INDEX ?? 0), shards = Number(process.env.CLS_SHARD_COUNT ?? 1);
if (!Number.isSafeInteger(shards) || shards < 1 || !Number.isSafeInteger(shard) || shard < 0 || shard >= shards)
  throw new Error('CLS_SHARD_INDEX must be a zero-based integer below CLS_SHARD_COUNT.');
const began = Date.now();
const elapsed = () => `${((Date.now() - began) / 1000).toFixed(1)}s`;

// [name, path, { user, from, click, row, switchTo, support, notes, panel, dialog, tab, still, alone, phoneOnly, notFound, waitlist }]. The in-app navigation starts on `from` and clicks the
// control whose text starts with `click`, the table row containing `row`, picks the workspace `switchTo` in the account
// switcher, or else a link to `path`; with none of those (pages reached from a dropdown menu) it pushes `path` through
// the router's history. It must land on `path`. `support` opens the support chat first, `dialog` a dialog (see above);
// `tab` clicks the tab whose text starts with it once the page has settled, and the measurement covers both;
// `phoneOnly` measures a page in the phone pass alone (a control only a phone shows); `notFound` is a page that must say "Page not found";
// `waitlist` is the address the refused sign-in's cookie names; `panel` is Overview's saved detail-column choice;
// `skipped` is a workspace whose onboarding domain step this browser skipped (data/onboarding.ts); `start` is
// [workspace, how this browser left Overview's get-started strip for it] (features/overview/first-run.tsx); `wide`
// measures the page on a 3440 × 1440 1x screen instead of the 1440 × 900 desktop.
// dana owns an established hosted workspace (and is a Nightmail operator), nia a brand-new one with a verified domain, ona one
// still onboarding, rae a restricted one that also owes $12.40 (the standing and billing banners on every page).
// A list of users is one browser signed in to each of them (one session cookie per account, the first the default).
const pages = ids => [
  ['Overview', '/overview', { from: '/logs' }],
  // A verified domain, nothing sent and records missing on others: the get-started strip (domain done) and the domain banner.
  ['Overview · setup', '/overview', { user: 'nia' }],
  // Overview's get-started strip (features/overview/first-run.tsx). Brand new: the built-in domain, nothing sent, no agent,
  // onboarding's domain step skipped; the strip decides once the setup and the score land, and quiet panels under it.
  ['Overview · first run', '/overview', { user: 'pia', skipped: 'ws_skipped', from: '/domains' }],
  // Its own domain verified and nothing else: one step done.
  ['Overview · first run · one step', '/overview', { user: 'ren', from: '/logs' }],
  // All three done (its own domain, a test email, an agent's key): no strip for a browser that never showed it. (One that
  // did shows it done for a beat, then it leaves by transform; that moves the rows the privacy checks reveal, so it isn't
  // measured here.)
  ['Overview · first run · all done', '/overview', { user: 'ash', from: '/logs' }],
  // Already showing for this browser: the route skeleton reserves the strip too.
  ['Overview · first run · remembered', '/overview', { user: 'pia', skipped: 'ws_skipped', start: ['ws_skipped', 'on'], from: '/logs' }],
  ['Overview · first run · dismissed', '/overview', { user: 'pia', skipped: 'ws_skipped', start: ['ws_skipped', 'dismissed'], from: '/logs' }],
  // Switching the time range keeps the old figures up while the new ones load, then tweens, morphs and crossfades them.
  ['Overview · range', '/overview', { from: '/overview', click: '30d' }],
  // A stream scopes the figures and Latest emails; a figure's tile opens Logs on that status, over the same range.
  ['Overview · stream', '/overview?stream=marketing', {}],
  // The detail column hidden (features/overview/panel.ts): the main column takes its width from the first paint.
  ['Overview · panel hidden', '/overview', { from: '/logs', panel: 'hidden' }],
  ['Logs · from an Overview tile', '/logs?view=sent&status=bounced&range=24h', { from: '/overview', click: 'Bounced' }],
  // "/" is the homepage signed in too: its button opens Overview (cold, then in the app).
  ['Homepage · signed in', '/', { still: true }],
  ['Overview · from the homepage', '/overview', { from: '/', click: 'Open dashboard', still: true }],
  ['Logs', '/logs', { from: '/overview' }],
  ['Logs · received', '/logs?view=received', { from: '/logs', click: 'Received' }],
  // A range lists and counts its own dates: the rows and the filters' counts are replaced in place.
  ['Logs · range', '/logs?range=24h', { from: '/logs', click: '24h' }],
  ['Sent email', `/logs/${ids.email}`, { from: '/logs?view=sent', row: 'Your receipt' }],
  // A junk-like message: its checks (things to fix, Technical details) and client issues; on a phone, the checks' sheet.
  ['Sent email · junk-like', `/logs/${ids.junkEmail}`, { from: '/logs?view=sent', row: 'FINAL NOTICE' }],
  ['Sent email · checks sheet', `/logs/${ids.junkEmail}`, { dialog: 'Checks', phoneOnly: true }],
  // Its only image a remote logo, held back: a tile at the logo's size, and the line with Load images over the preview.
  ['Sent email · images held back', `/logs/${ids.imageEmail}`, { from: '/logs?view=sent', row: 'Your order is on its way' }],
  // Why it failed, under the delivery (features/logs/reason.ts): a bounce's sentence with the receiving server's reply, a
  // delay's with its retry deadline; on a phone the sentence is under the status line and the reply in the Details sheet.
  ['Sent email · bounced', `/logs/${ids.bouncedEmail}`, { from: '/logs?view=sent', row: 'Reset your password' }],
  ['Sent email · delayed', `/logs/${ids.delayedEmail}`, { from: '/logs?view=sent', row: 'Your sign-in code' }],
  ['Sent email · bounced details', `/logs/${ids.bouncedEmail}`, { dialog: 'Details', phoneOnly: true }],
  ['Received email', `/logs/${ids.receivedEmail}`, { from: '/logs?view=received', row: 'Invoice for October' }],
  // A received message in a sent email's layout (features/logs/received-detail.tsx): on a phone its checks and facts open
  // in the Details sheet from the status line.
  ['Received email · details sheet', `/logs/${ids.receivedEmail}`, { dialog: 'Details', phoneOnly: true }],
  // A conversation (cls-fixture.mjs): the reply that joined it by its In-Reply-To and Jordan's answer, each with its Thread
  // section; the section's link from one to the other; and on a phone, the thread's sheet from the status line.
  ['Sent email · thread', `/logs/${ids.threadEmail}`, { from: '/logs?view=sent', row: 'Re: What happened' }],
  ['Received email · thread', `/logs/${ids.threadReceived}`, { from: '/logs?view=received', row: 'Re: What happened' }],
  ['Received email · from its thread', `/logs/${ids.threadReceived}`, { from: `/logs/${ids.threadEmail}` }],
  ['Sent email · thread sheet', `/logs/${ids.threadEmail}`, { dialog: '5 messages', phoneOnly: true }],
  ['Mail routing', '/receiving', { from: '/overview' }],
  // A workspace with no receiving domain yet: the three steps that start it.
  ['Mail routing · new workspace', '/receiving', { user: 'nia' }],
  ['Mail routing · destinations', '/receiving?tab=destinations', { from: '/receiving', click: 'Destinations' }],
  // An ultra-wide 1x screen (3440 × 1440, `wide`): the tab marker slides on whole pixels there too.
  ['Mail routing · ultra-wide', '/receiving?tab=rules', { from: '/receiving', click: 'Rules', wide: true }],
  // The flow panel: an address chosen in the list (a full-height sheet on a phone), and an address typed in the search
  // that has none of its own, whose panel says where its mail would go once its test answers.
  // guard: Edit on the panel opens the address's route editor (never the builder, which only creates) and writes nothing.
  ['Mail routing · flow panel', `/receiving?open=${ids.address}`, { from: '/receiving?tab=rules', guard: 'receiving-edit' }],
  ['Mail routing · typed address', '/receiving?q=orders%40northwind.example', {}],
  // An address's page opens on its mail; Where mail goes and Settings are its other tabs.
  ['Mail routing · address', `/receiving/addresses/${ids.address}`, { from: '/receiving' }],
  // An address deleted elsewhere (an agent, another tab): its page says so, with the way back.
  ['Mail routing · address · deleted', '/receiving/addresses/mbx_deleted_elsewhere', { from: '/receiving' }],
  ['Mail routing · address · where mail goes', `/receiving/addresses/${ids.address}?tab=flow`, { from: `/receiving/addresses/${ids.address}`, click: 'Where mail goes' }],
  // Its Settings tab shares its name with the sidebar's Settings, so the in-app pass opens it through the router.
  ['Mail routing · address · settings', `/receiving/addresses/${ids.address}?tab=settings`, { from: `/receiving/addresses/${ids.address}` }],
  // Rules: the list (Mail routing's tab), New rule's recipes, a recipe's form, and a rule's page, its code: a rule made
  // from a recipe, a script, and a new one.
  ['Mail routing · rules', '/receiving?tab=rules', { from: '/receiving', click: 'Rules' }],
  ['Mail routing · new rule', '/receiving/rules/new', { from: '/receiving?tab=rules', click: 'New rule' }],
  ['Mail routing · new rule · new workspace', '/receiving/rules/new', { user: 'nia' }],
  ['Mail routing · recipe form', '/receiving/rules/new/slack', { from: '/receiving/rules/new', click: 'Post to Slack' }],
  ['Mail routing · recipe rule', '/receiving/rules/label-by-meaning-support', { from: '/receiving?tab=rules', row: 'a refund request' }],
  ['Mail routing · rule editor', '/receiving/rules/triage', { from: '/receiving?tab=rules', row: 'triage' }],
  ['Mail routing · rule editor · new script', '/receiving/rules/new/script', { user: 'nia', from: '/receiving/rules/new', click: 'Write code' }],
  ['Mail routing · rules · live update', '/receiving/rules/triage', { user: 'kai', live: 'apply' }],
  ['Mail routing · rules · live conflict', '/receiving/rules/triage', { user: 'kai', live: 'conflict' }],
  ['Mail routing · agent inboxes', '/receiving/inboxes', { from: '/receiving' }],
  ['Mail routing · agent inbox', `/receiving/inboxes/${ids.inbox}`, { from: '/receiving/inboxes' }],
  ['Mail routing · webhook', `/receiving/webhooks/${ids.inboundWebhook}`, { from: '/receiving?tab=destinations' }],
  ['Campaigns', '/campaigns', { from: '/overview' }],
  ['Campaign editor', `/campaigns/${ids.campaign}/edit`, { from: '/campaigns' }],
  ['New campaign', '/campaigns/new', { from: '/campaigns', click: 'Create campaign' }],
  ['Campaign review', `/campaigns/${ids.campaign}/review`, { from: '/campaigns' }],
  // The Send stage open (#send): the send review (readiness) arrives with the audience count, last in the stage; ready,
  // and recommending daily batches (its dated plan and the choice between it and your own pace).
  ['Campaign review · send', `/campaigns/${ids.readyCampaign}/review#send`, { from: '/campaigns' }],
  ['Campaign review · ramp', `/campaigns/${ids.rampCampaign}/review#send`, { from: '/campaigns' }],
  // A sent issue's results (its emails still in the history), and one whose emails are past it: only the stored figures.
  ['Campaign results', `/campaigns/${ids.issueSent}/review`, { user: 'mara', from: `/newsletters/${ids.newsletter}` }],
  ['Templates', '/campaigns/templates', { from: '/campaigns' }],
  // Newsletters (cls-fixture.mjs newsletters): a newsletter's page with twelve sent issues, one with a single draft, one
  // made a moment ago; the form that makes one; the composer as "New issue" opens it; Campaigns beside two newsletters,
  // without their issues; and the list a workspace with more than three gets in place of their names.
  ['Newsletter', `/newsletters/${ids.newsletter}`, { user: 'mara', from: '/campaigns' }],
  ['Newsletter · one draft', `/newsletters/${ids.newsletterDraft}`, { user: 'lou', from: `/newsletters/${ids.newsletterSecond}` }],
  ['Newsletter · new', `/newsletters/${ids.newsletterNew}`, { user: 'sol', from: '/campaigns' }],
  ['New newsletter', '/newsletters/new', { user: 'mara', from: '/campaigns', click: 'New newsletter' }],
  ['New issue', `/campaigns/new?newsletter=${ids.newsletter}`, { user: 'mara', from: `/newsletters/${ids.newsletter}`, click: 'New issue' }],
  ['Campaigns · with newsletters', '/campaigns', { user: 'lou', from: `/newsletters/${ids.newsletterSecond}` }],
  ['Newsletters', '/newsletters', { user: 'ivy', from: '/campaigns' }],
  ['Template', `/campaigns/templates/${ids.template}`, { from: '/campaigns/templates', row: 'Receipt', leave: true }],
  ['Audience', '/audience', { from: '/overview' }],
  ['Audience · risky', '/audience?status=risky', { from: '/audience' }],
  ['Contact', `/audience/contacts/${ids.contact}`, { from: '/audience' }],
  ['Lists', '/audience/lists', { from: '/audience' }],
  ['List', `/audience/lists/${ids.list}`, { from: '/audience/lists' }],
  ['List · risky', `/audience/lists/${ids.list}?status=risky`, { from: `/audience/lists/${ids.list}` }],
  ['Segments', '/audience/segments', { from: '/audience' }],
  ['Segment', `/audience/segments/${ids.segment}`, { from: '/audience/segments', row: 'Pro plan' }],
  // Property rules: the name beside the field, a day with its zone, and a presence check without a value.
  ['Segment · property rules', `/audience/segments/${ids.propertySegment}`, { from: '/audience/segments', row: 'Waiting companies' }],
  ['Topics', '/audience/topics', { from: '/audience' }],
  ['Domains', '/domains', { from: '/overview' }],
  ['Domain', `/domains/${ids.domain}`, { from: '/domains' }],
  // A domain with a custom MAIL FROM: its MX and SPF records join the table, each with a menu to change it.
  ['Domain · custom MAIL FROM', `/domains/${ids.sendingDomain}`, { from: '/domains' }],
  // Added two hours ago, its records still missing at its DNS host: the setup banner over the records (Overview · setup shows it too).
  ['Domain · records missing', `/domains/${ids.stuckDomain}`, { user: 'nia', from: '/domains' }],
  // The built-in domain: first in the list with its badge, and its page with no records (api/src/builtin-domain.ts).
  ['Domains · built-in', '/domains', { user: 'pia', skipped: 'ws_skipped', from: '/overview' }],
  ['Domain · built-in', `/domains/${ids.builtinDomain}`, { user: 'pia', skipped: 'ws_skipped', from: '/domains' }],
  // Every record in public DNS, SES not verified yet: "Your records are correct" over the records.
  ['Domain · records correct', `/domains/${ids.correctDomain}`, { user: 'nia', from: '/domains' }],
  // Nobody serves DNS for it (a typo): "No DNS found" over the records, with Change name and Delete domain.
  ['Domain · no DNS', `/domains/${ids.noDnsDomain}`, { user: 'nia', from: '/domains' }],
  // A *.<domain> record answers its DKIM names: the banner says to add the CNAMEs exactly.
  ['Domain · wildcard', `/domains/${ids.wildcardDomain}`, { user: 'nia', from: '/domains' }],
  // Porkbun's parking default answers its DKIM names: the banner names Porkbun's record.
  ['Domain · parking', `/domains/${ids.parkedDomain}`, { user: 'nia', from: '/domains' }],
  ['Domain · change name dialog', `/domains/${ids.noDnsDomain}`, { user: 'nia', dialog: 'Change name' }],
  ['API keys', '/api-keys', { from: '/overview' }],
  ['Settings', '/settings', { from: '/overview' }],
  ['Settings · members', '/settings#members', { from: '/settings' }],
  ['Settings · webhooks', '/settings#webhooks', { from: '/settings' }],
  ['Settings · activity', '/settings#activity', { from: '/settings' }],
  ['Settings · account', '/settings#account', { from: '/settings' }],
  // Billing is the one page about money: the balance, this month's usage, the free allowance, the card, auto-recharge
  // and the history (owed: the daily limit's row too). A member reads the usage and allowance rows only.
  ['Settings · billing', '/settings#billing', { from: '/settings' }],
  ['Settings · billing · owed', '/settings#billing', { user: 'rae', from: '/overview' }],
  ['Settings · billing · free', '/settings#billing', { user: 'nia', from: '/overview' }],
  ['Settings · billing · member', '/settings#billing', { user: 'max', from: '/settings' }],
  // Old links: Plan & usage is part of Billing; hosted mail has no Sending section, so its link opens General.
  ['Settings · billing · old usage link', '/settings#usage', {}],
  ['Settings · old sending link', '/settings#sending', {}],
  ['Settings · webhook', `/settings/webhooks/${ids.webhook}`, { from: '/settings#webhooks', row: 'Delivery events' }],
  ['Settings · MCP connection', `/settings/mcp/${ids.mcp}`, { from: '/settings#account' }],
  ['Docs', '/docs', { from: '/overview' }],
  ['Operator', '/operator', { from: '/overview' }],
  ['Operator · workspace', `/operator/workspaces/${ids.restricted}`, { from: '/operator', row: 'Harbor Supply' }],
  ['Operator · UI notes', '/operator/notes', { from: '/operator', click: 'UI notes' }],
  ['Operator · waitlist', '/operator?view=waitlist', { from: '/operator', click: 'Waitlist' }],
  // Sign-ups: the limit and what fills it over every workspace; Set limit opens its fields once the numbers are in.
  ['Operator · sign-ups', '/operator?view=signups', { from: '/operator', click: 'Sign-ups' }],
  ['Operator · sign-up limit dialog', '/operator?view=signups', { dialog: 'Set limit' }],
  // Abuse: clusters of related accounts beside their facet rail, one cluster beside the list of the others, the alert
  // outbox, and an alert's Slack card in its dialog.
  ['Operator · abuse', '/operator?view=abuse', { from: '/operator', click: 'Abuse' }],
  ['Operator · abuse · cluster', `/operator/abuse/${ids.abuseCluster}`, { from: '/operator?view=abuse', row: 'Several accounts · Shared card' }],
  ['Operator · abuse · alerts', '/operator?view=abuse&show=alerts', { from: '/operator?view=abuse', click: 'Alerts' }],
  ['Operator · abuse · Slack card', '/operator?view=abuse&show=alerts', { dialog: 'High risk' }],
  ['Operator · lists', '/operator?view=lists', { from: '/operator', click: 'Lists' }],
  // Health: six facts and one table of what the minute tick last wrote, the open alerts first.
  ['Operator · health', '/operator?view=health', { from: '/operator', click: 'Health' }],
  // Glass: the board's tiles, funnel, region rows (two at least), metric rows and feed column have fixed sizes, and feed
  // rows move by transforms, so the figures (and their 5-second refresh) land in place. Anyone but an operator gets the
  // app's "Page not found".
  ['Glass', '/glass', { from: '/operator' }],
  ['Glass · not an operator', '/glass', { user: 'nia', notFound: true }],
  // The Deliverability board: tiles, the providers' table, groups and VDM's table of fixed rows, filtered in place.
  ['Glass · deliverability', '/glass?view=deliverability', { from: '/glass', click: 'Deliverability' }],
  // The support inbox (staff): Needs you and its counts, AI handling, Waiting on customer, a conversation's timeline beside
  // its customer panel, an email conversation (the email as it arrived), and on a phone the panel's sheet.
  ['Support', '/support', { from: '/overview' }],
  ['Support · AI handling', '/support?view=agent', { from: '/support', click: 'AI handling' }],
  ['Support · waiting on customer', '/support?view=waiting', { from: '/support', click: 'Waiting on customer' }],
  ['Support · conversation', `/support/${ids.supportConversation}`, { from: '/support', row: 'DKIM will not verify' }],
  ['Support · email conversation', `/support/${ids.supportEmail}`, { from: '/support?view=waiting', row: 'Why did my test email bounce?' }],
  ['Support · customer sheet', `/support/${ids.supportConversation}`, { dialog: 'Customer', phoneOnly: true }],
  // A change support proposed, from its emailed link: the dialog over Overview opens once Nightmail's record has loaded.
  ['Support · confirm a change', `/support/actions/${ids.supportAction}`, {}],
  // UI notes mode on (a staff overlay): its pins, tray and lazy code load over the page without moving anything.
  ['Overview · UI notes mode', '/overview', { from: '/logs', notes: true }],
  // An operator outside UI_NOTES_SUBJECTS with the mode forced on: no tab, toggle, pill or pins, and the API says 404.
  ['Operator · without UI notes', '/operator', { user: 'rae', from: '/overview', notes: true }],
  ['Overview · restricted', '/overview', { user: 'rae', from: '/logs' }],
  ['Campaigns · restricted', '/campaigns', { user: 'rae', from: '/overview' }],
  // The docs: inside the dashboard signed in (a guide from the contents, an operation, a deep-linked overview section),
  // in their own layout signed out.
  ['Docs · guide', '/docs/rules', { from: '/docs', click: 'Rules and AI decisions' }],
  ['Docs · MCP guide', '/docs/mcp', { from: '/overview' }],
  ['Docs · operation', '/docs/api/sendEmail', { from: '/docs/receiving' }],
  ['Docs · section', '/docs#sending-limits', { from: '/api-keys' }],
  ['Docs · keys guide', '/docs/keys', { from: '/api-keys' }],
  ['Docs · signed out', '/docs', { user: null }],
  ['Docs · signed out guide', '/docs/receiving', { user: null, from: '/docs', click: 'Receiving' }],
  ['Docs · signed out operation', '/docs/api/sendEmail', { user: null }],
  // No connection yet: Get started is up at once, whole, while onboarding starts Hosted mail.
  ['Onboarding', '/onboarding', { user: 'ona' }],
  // Get started on the built-in domain, ready (onboarding/get-started.tsx): the Agent tab, and By hand's key and send example.
  ['Onboarding · get started', '/onboarding', { user: 'uma' }],
  ['Onboarding · get started by hand', '/onboarding', { user: 'uma', tab: 'By hand' }],
  // The same while the built-in domain is still being set up: the same screen (a test email pressed now waits for it).
  ['Onboarding · get started provisioning', '/onboarding', { user: 'ula' }],
  // On a domain of the workspace's own, just verified (the step after its records): no built-in domain line.
  ['Onboarding · get started own domain', '/onboarding', { user: 'ren', step: ['ws_verified', 'agent:dom_rowanbakery_example'] }],
  // Connecting their own AWS account (cls-fixture.mjs connectedAccount): the stack link, a refused stack, the account
  // being checked, domains to choose, a region in the SES sandbox and its production access request, and a region being set up.
  ['Onboarding · AWS stack', '/onboarding', { user: 'bea' }],
  ['Onboarding · AWS refused', '/onboarding', { user: 'bo' }],
  ['Onboarding · AWS checking', '/onboarding', { user: 'fay' }],
  ['Onboarding · AWS choose', '/onboarding', { user: 'cy' }],
  ['Onboarding · AWS sandbox', '/onboarding', { user: 'di' }],
  ['Onboarding · AWS production access', '/onboarding', { user: 'di', dialog: 'Request production access' }],
  ['Onboarding · AWS setting up', '/onboarding', { user: 'ed' }],
  ['Onboarding · AWS disconnecting', '/onboarding', { user: 'hal' }],
  // Approving an agent's device code (features/connect, api/src/agent-setup.ts): from the link the agent shows, with its
  // code, and without one, where the code is typed.
  ['Connect · agent code', `/connect?code=${ids.deviceCode}`, {}],
  ['Connect · type a code', '/connect', {}],
  // Sending from a connected AWS account: its rows in Settings → Sending, and the banner for a health finding.
  ['Settings · sending · AWS', '/settings#sending', { user: 'gil' }],
  // Two accounts in one browser: a cold load as the default (dana), then switching to nia's workspace from the switcher.
  ['Two accounts · switch', '/overview', { user: ['dana', 'nia'], from: '/overview', switchTo: 'Lumen Labs' }],
  ['Signed out', '/', { user: null, alone: true }],
  // Signed out on a dashboard page (a link from an email) and on an address the dashboard doesn't have.
  ['Signed out · deep link', '/overview', { user: null }],
  ['Signed out · page not found', '/no-such-page', { user: null, notFound: true }],
  // A hosted sign-in nothing admitted lands here, with its address in a short-lived cookie (api/src/account-login.ts).
  ['Signed out · waitlist', '/?auth=waitlist&position=4', { user: null, waitlist: 'mara.quinn@example.net' }],
  // The same refusal for a GitHub or password sign-in that showed nothing of its address, with a place open for it: a
  // sign-in link to it in one click.
  ['Signed out · waitlist, place ready', '/?auth=waitlist&place=ready', { user: null, waitlist: 'kwame.mensah@example.net' }],
  // A place held for its address that the sign-in didn't show is the person's (GitHub without it verified): a sign-in
  // link to it in one click; and the refusal after a used or expired link.
  ['Signed out · waitlist, place held', '/?auth=waitlist&place=held', { user: null, waitlist: 'ines.duarte@example.net' }],
  ['Signed out · waitlist, link expired', '/?auth=waitlist&link=expired', { user: null, waitlist: 'tomas.berg@example.net' }],
  // The emailed sign-in link opens Overview signed out, saying a place is held.
  ['Signed out · sign-in link', '/overview?link=AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', { user: null }],
  // The public legal pages: signed out from the homepage and between documents, and signed in from the sidebar.
  ['Legal', '/legal', { user: null, from: '/legal/terms', click: 'Overview' }],
  ['Legal · terms', '/legal/terms', { user: null, from: '/', still: true }],
  ['Legal · terms, signed in', '/legal/terms', { from: '/settings' }],
  ['Legal · acceptable use', '/legal/acceptable-use', { user: null, from: '/legal/terms' }],
  ['Legal · privacy', '/legal/privacy', { user: null, from: '/legal' }],
  ['Legal · subprocessors', '/legal/subprocessors', { user: null, from: '/legal/privacy' }],
  // The price pages (features/pricing), public and linked from the homepage: signed out, cold and from one another
  // (their header's links), the calculator also at its large size and signed in.
  ['Pricing', '/pricing', { user: null, from: '/compare/mailchimp', click: 'Pricing' }],
  ['Pricing · large', '/pricing?sent=400000&received=0&contacts=100000&teammates=3', { user: null }],
  ['Pricing · signed in', '/pricing', {}],
  ['Compare · Mailchimp', '/compare/mailchimp', { user: null, from: '/pricing', click: 'vs Mailchimp' }],
  // The board's frame in the homepage's steel, while its concrete waits for a yes (features/pricing/board.tsx).
  ['Compare · Mailchimp · steel frame', '/compare/mailchimp?frame=steel', { user: null }],
  ['Compare · Resend', '/compare/resend', { user: null, from: '/compare/mailchimp', click: 'vs Resend' }],
  // The other comparisons, from the calculator's Compare line.
  ['Compare · AgentMail', '/compare/agentmail', { user: null, from: '/pricing', click: 'AgentMail' }],
  ['Compare · Bird', '/compare/bird', { user: null, from: '/pricing', click: 'Bird' }],
  ['Compare · Mailgun', '/compare/mailgun', { user: null, from: '/pricing', click: 'Mailgun' }],
  ['Compare · Mailjet', '/compare/mailjet', { user: null, from: '/pricing', click: 'Mailjet' }],
  ['Compare · Mandrill', '/compare/mandrill', { user: null, from: '/pricing', click: 'Mandrill' }],
  ['Compare · Postmark', '/compare/postmark', { user: null, from: '/pricing', click: 'Postmark' }],
  ['Compare · SendGrid', '/compare/sendgrid', { user: null, from: '/pricing', click: 'SendGrid' }],
  ['Compare · Nylas', '/compare/nylas', { user: null, from: '/pricing', click: 'Nylas' }],
  ['Compare · Robotomail', '/compare/robotomail', { user: null, from: '/pricing', click: 'Robotomail' }],
  ['Compare · Postfleet', '/compare/postfleet', { user: null, from: '/pricing', click: 'Postfleet' }],
  ['Compare · Lumbox', '/compare/lumbox', { user: null, from: '/pricing', click: 'Lumbox' }],
  ['Compare · Mails.ai', '/compare/mails-ai', { user: null, from: '/pricing', click: 'Mails.ai' }],
  ['Compare · Dead Simple Email', '/compare/dead-simple-email', { user: null, from: '/pricing', click: 'Dead Simple Email' }],
  ['Compare · Agent Identity', '/compare/agent-identity', { user: null, from: '/pricing', click: 'Agent Identity' }],
  ['Compare · Inkbox', '/compare/inkbox', { user: null, from: '/pricing', click: 'Inkbox' }],
  ['Compare · beehiiv', '/compare/beehiiv', { user: null, from: '/pricing', click: 'beehiiv' }],
  ['Compare · MailerLite', '/compare/mailerlite', { user: null, from: '/pricing', click: 'MailerLite' }],
  ['Compare · Buttondown', '/compare/buttondown', { user: null, from: '/pricing', click: 'Buttondown' }],
  ['Compare · EmailOctopus', '/compare/emailoctopus', { user: null, from: '/pricing', click: 'EmailOctopus' }],
  ['Compare · Ghost(Pro)', '/compare/ghost', { user: null, from: '/pricing', click: 'Ghost(Pro)' }],
  ['Compare · AWeber', '/compare/aweber', { user: null, from: '/pricing', click: 'AWeber' }],
  ['Compare · Loops', '/compare/loops', { user: null, from: '/pricing', click: 'Loops' }],
  ['Compare · Brevo', '/compare/brevo', { user: null, from: '/pricing', click: 'Brevo' }],
  ['Compare · MailerSend', '/compare/mailersend', { user: null, from: '/pricing', click: 'MailerSend' }],
  ['Compare · Mailtrap', '/compare/mailtrap', { user: null, from: '/pricing', click: 'Mailtrap' }],
  ['Compare · SMTP2GO', '/compare/smtp2go', { user: null, from: '/pricing', click: 'SMTP2GO' }],
  ['Compare · AhaSend', '/compare/ahasend', { user: null, from: '/pricing', click: 'AhaSend' }],
  ['Compare · CloudMailin', '/compare/cloudmailin', { user: null, from: '/pricing', click: 'CloudMailin' }],
  ['Compare · SocketLabs', '/compare/socketlabs', { user: null, from: '/pricing', click: 'SocketLabs' }],
  ['Compare · MailPace', '/compare/mailpace', { user: null, from: '/pricing', click: 'MailPace' }],
  ['Compare · UniOne', '/compare/unione', { user: null, from: '/pricing', click: 'UniOne' }],
  ['Compare · MailChannels', '/compare/mailchannels', { user: null, from: '/pricing', click: 'MailChannels' }],
  ['Support chat', '/logs', { from: '/overview', support: true }],
  ['Overview · sending limits dialog', '/overview', { user: 'rae', dialog: 'Daily limit' }],
  ['Overview · sender score dialog', '/overview', { dialog: 'Sender score' }],
  // Before the first grade: the card's sentence, the explainer's progress, and the evaluation as the daily limit.
  ['Overview · sender score dialog · not graded', '/overview', { user: 'nia', dialog: 'Sender score' }],
  ['Overview · daily limit dialog · evaluation', '/overview', { user: 'nia', dialog: 'Daily limit' }],
  // Connect your agent: the sidebar's row on a desktop, More's on a phone. The agents list loads (and polls) inside a
  // dialog of fixed height. More itself: the rest of the pages, Connect your agent, Help and Sign out, and the footer.
  ['Overview · connect agent dialog', '/overview', { dialog: 'Connect your agent' }],
  ['Overview · connect agent sheet', '/overview', { menu: ['More', 'Connect your agent', 'Connect your agent'], phoneOnly: true }],
  ['Overview · More sheet', '/overview', { dialog: 'More', phoneOnly: true }],
  // ⌘K, from the command bar's field: the command menu over Logs, its whole list (pages, then actions) at a fixed height.
  ['Logs · command menu', '/logs', { dialog: 'Search or jump' }],
  ['Domains · add domain dialog', '/domains', { dialog: 'Add domain' }],
  ['Domain · add custom MAIL FROM dialog', `/domains/${ids.domain}`, { dialog: 'Add custom MAIL FROM' }],
  ['Domain · change custom MAIL FROM dialog', `/domains/${ids.sendingDomain}`, { menu: ['Actions for MAIL FROM MX record', 'Change custom MAIL FROM', 'Change custom MAIL FROM'] }],
  ['Domain · remove custom MAIL FROM dialog', `/domains/${ids.sendingDomain}`, { menu: ['Actions for MAIL FROM MX record', 'Remove custom MAIL FROM', 'Remove custom MAIL FROM?'] }],
  ['API keys · create key dialog', '/api-keys', { dialog: 'Create key' }],
  // /api-keys?create=smtp opens Create key on an SMTP login: its domains load after it opens.
  ['API keys · SMTP login dialog', '/api-keys?create=smtp', {}],
  // Edit key: a row's menu, then Edit; the dialog opens once the key's domains have loaded.
  ['API keys · edit key dialog', '/api-keys', { menu: ['Actions for Production', 'Edit', 'Edit key'] }],
  ['Mail routing · new address dialog', '/receiving', { dialog: 'New address' }],
  // The address builder over the list for the chosen address (one it can draw): its flow, read back from its route and rules.
  ['Mail routing · address builder dialog', `/receiving?open=${ids.address}`, { dialog: 'Edit' }],
  // New rule's Split by words with no address yet asks which address, then opens the builder on it, split on that check.
  ['Mail routing · split chooser dialog', '/receiving/rules/new', { dialog: 'Split by words' }],
  // guard: two splits, New rule on a split address, Test's AI answer, a failed create. Alone: it adds addresses and rules.
  ['Mail routing · split edits', `/receiving/addresses/${ids.address}?tab=flow`, { alone: true, guard: 'receiving-splits' }],
  ['Mail routing · address builder from New rule', `/receiving?tab=rules&build=${ids.address}&split=ai`, {}],
  // Where its mail goes (the route editor) opens once its inboxes, webhooks and forwards have loaded.
  // Why a received message went where it did, from its conversation on the address's Mail tab.
  ['Mail routing · why it went here dialog', `/receiving/addresses/${ids.address}?thread=${ids.supportThread}`, { dialog: 'Why it went here' }],
  ['Mail routing · route editor dialog', `/receiving/addresses/${ids.address}?tab=flow&edit=1`, { dialog: 'Change' }],
  ['Mail routing · new agent inbox dialog', '/receiving/inboxes', { dialog: 'New agent inbox' }],
  ['Mail routing · ask your agent dialog', '/receiving/rules/new', { dialog: 'Ask your agent' }],
  ['Audience · import dialog', '/audience', { dialog: 'Import contacts' }],
  // A member imports without a list: the list picker is off and says who can add to one.
  ['Audience · import dialog · member', '/audience', { user: 'max', dialog: 'Import contacts' }],
  ['Settings · invite dialog', '/settings#members', { dialog: 'Invite teammate' }],
  // General's postal address: Edit opens its dialog (the same one a campaign's Send opens when the address is missing).
  ['Settings · postal address dialog', '/settings', { dialog: 'Edit' }],
  ['Settings · new webhook', '/settings/webhooks/new', {}],
  ['Settings · add credit dialog', '/settings#billing', { dialog: 'Add credit' }],
  // The balance opens its three parts.
  ['Settings · balance dialog', '/settings#billing', { dialog: '$' }],
  // A support email's sign-in link: the dialog answers Continue (the claim) in place, without moving.
  ['Support · continue email', `/support/continue/${ids.continueConversation}/${ids.continueMessage}`, { user: 'nia', dialog: 'Continue' }],
];

// The television homepage's pages (CLS_HOME=tv, above), each also in the phone pass.
const televisionPages = [
  ['Signed out · television', '/', { user: null, alone: true }],
  ['Homepage · signed in · television', '/', { still: true }],
  ['Overview · from the television', '/overview', { from: '/', click: 'Open dashboard', still: true }],
];
// The phone pass: the pages someone opens on a phone (every list as cards, the details they open, Settings), light only.
const phonePages = new Set(['Segment · property rules', 'Newsletter', 'Newsletter · one draft', 'Newsletter · new', 'New newsletter', 'New issue', 'Campaigns · with newsletters', 'Overview', 'Overview · setup', 'Overview · first run', 'Overview · first run · one step', 'Overview · first run · all done', 'Overview · first run · remembered', 'Overview · first run · dismissed', 'Overview · range', 'Overview · stream', 'Overview · panel hidden', 'Logs · from an Overview tile', 'Homepage · signed in', 'Overview · from the homepage', 'Logs', 'Logs · range', 'Sent email', 'Sent email · junk-like', 'Sent email · images held back', 'Sent email · bounced', 'Sent email · delayed', 'Sent email · bounced details', 'Sent email · checks sheet', 'Received email', 'Received email · details sheet', 'Sent email · thread', 'Received email · thread', 'Received email · from its thread', 'Sent email · thread sheet', 'Mail routing', 'Mail routing · rules', 'Mail routing · new rule', 'Mail routing · recipe form', 'Mail routing · recipe rule', 'Mail routing · rule editor', 'Mail routing · rule editor · new script', 'Mail routing · flow panel', 'Mail routing · typed address', 'Mail routing · why it went here dialog', 'Mail routing · address', 'Mail routing · address · deleted', 'Mail routing · address · where mail goes', 'Mail routing · address · settings', 'Mail routing · agent inboxes', 'Mail routing · destinations', 'Campaigns', 'Campaign review', 'Campaign review · send', 'Campaign review · ramp', 'Templates', 'Audience', 'Lists', 'Topics', 'Domains', 'Domain', 'Domain · custom MAIL FROM', 'Domain · records missing', 'Domain · records correct', 'Domains · built-in', 'Domain · built-in', 'Onboarding · get started', 'Onboarding · get started by hand', 'Onboarding · get started provisioning', 'Onboarding · get started own domain', 'API keys', 'Settings', 'Settings · members', 'Settings · activity', 'Settings · billing', 'Settings · billing · owed', 'Settings · billing · free', 'Settings · billing · member', 'Settings · billing · old usage link', 'Settings · balance dialog', 'Settings · webhook', 'Settings · MCP connection', 'Onboarding', 'Onboarding · AWS stack', 'Onboarding · AWS refused', 'Onboarding · AWS choose', 'Onboarding · AWS sandbox', 'Onboarding · AWS production access', 'Onboarding · AWS setting up', 'Mail routing · inbox', 'Mail routing · endpoints', 'Onboarding · AWS disconnecting', 'Connect · agent code', 'Connect · type a code', 'Settings · sending · AWS', 'Two accounts · switch', 'Operator', 'Operator · workspace', 'Operator · UI notes', 'Operator · waitlist', 'Operator · health', 'Operator · sign-ups', 'Operator · sign-up limit dialog', 'Operator · abuse', 'Operator · abuse · cluster', 'Operator · abuse · alerts', 'Operator · abuse · Slack card', 'Glass', 'Glass · not an operator', 'Glass · deliverability', 'Support', 'Support · AI handling', 'Support · waiting on customer', 'Support · conversation', 'Support · email conversation', 'Support · customer sheet', 'Support · confirm a change', 'Overview · UI notes mode', 'Operator · without UI notes', 'Overview · restricted', 'Campaigns · restricted', 'Signed out', 'Signed out · deep link', 'Signed out · page not found', 'Signed out · waitlist', 'Signed out · waitlist, place ready', 'Signed out · waitlist, place held', 'Signed out · waitlist, link expired', 'Signed out · sign-in link', 'Legal', 'Legal · terms', 'Legal · privacy', 'Pricing', 'Pricing · large', 'Compare · Mailchimp', 'Compare · Mailchimp · steel frame', 'Compare · Resend', 'Compare · AgentMail', 'Compare · Bird', 'Compare · Mailgun', 'Compare · Mailjet', 'Compare · Mandrill', 'Compare · Postmark', 'Compare · SendGrid', 'Compare · Nylas', 'Compare · Robotomail', 'Compare · Postfleet', 'Compare · Lumbox', 'Compare · Mails.ai', 'Compare · Dead Simple Email', 'Compare · Agent Identity', 'Compare · Inkbox', 'Compare · beehiiv', 'Compare · MailerLite', 'Compare · Buttondown', 'Compare · EmailOctopus', 'Compare · Ghost(Pro)', 'Compare · AWeber', 'Compare · Loops', 'Compare · Brevo', 'Docs', 'Docs · MCP guide', 'Docs · section', 'Docs · signed out', 'Signed out', 'Support chat', 'Overview · sending limits dialog', 'Overview · sender score dialog', 'Overview · sender score dialog · not graded', 'Overview · daily limit dialog · evaluation', 'Overview · connect agent sheet', 'Overview · More sheet', 'API keys · create key dialog', 'API keys · SMTP login dialog', 'API keys · edit key dialog', 'Mail routing · new address dialog', 'Settings · invite dialog', 'Settings · postal address dialog', 'Settings · add credit dialog', 'Domain · add custom MAIL FROM dialog', 'Domain · change custom MAIL FROM dialog', 'Support · continue email', 'Compare · MailerSend', 'Compare · Mailtrap', 'Compare · SMTP2GO', 'Compare · AhaSend', 'Compare · CloudMailin', 'Compare · SocketLabs', 'Compare · MailPace', 'Compare · UniOne', 'Compare · MailChannels']);
const devices = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  wide: { viewport: { width: 3440, height: 1440 }, deviceScaleFactor: 1 },
};

// Every API path gets a stable delay of 300–1300 ms in 200 ms steps: slow, and out of request order, the same way
// every run. Every response of a page, assets included, starts 150 ms after its request at the soonest and shares the
// page's 1.6 Mbps (the fixture's proxy applies both, as Chrome's DevTools throttling did).
const apiDelay = path => { let h = 0; for (const c of path) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 300 + (h % 6) * 200; };
const throttle = { latency: 150, bytesPerSecond: 1.6 * 1024 * 1024 / 8 };
// Web fonts are served at once from app/dist, not through the throttled network, so they have loaded before the
// (throttled) script that renders any text runs. Before, whether a font arrived before or after the page's text varied
// with the runner's load, and a page whose text changed size when the font swapped in failed only sometimes (Settings ·
// webhook on a phone, 2 of 3 dev runs on Nov 12). CLS_FONTS=late measures that swap instead: every font arrives 1.8 s
// late, after the slowest API response, so text first paints in its local fallback (tokens.css).
const lateFonts = process.env.CLS_FONTS === 'late', FONT_DELAY_MS = 1800;

// Runs in the page before its own scripts.
const probe = () => {
  const state = window.__cls = { total: 0, entries: [], nodes: [], long: [], fetches: 0 };
  const rect = r => [r.x, r.y, r.width, r.height].map(Math.round);
  const describe = node => {
    if (!node) return '(removed)';
    if (node.nodeType !== 1) return `#text in ${describe(node.parentElement)}`;
    const parts = [];
    for (let n = node; n && n.nodeType === 1 && n !== document.body && parts.length < 5; n = n.parentElement) {
      const classes = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
      parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + classes.map(c => '.' + c).join(''));
      if (n.id) break;
    }
    return parts.join(' > ');
  };
  const record = list => {
    for (const e of list) {
      if (e.hadRecentInput) continue;
      state.total += e.value;
      state.entries.push({ value: e.value, at: Math.round(e.startTime), sources: (e.sources || []).map(s => {
        if (s.node) state.nodes.push(s.node);
        return { node: describe(s.node), text: (s.node?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80), from: rect(s.previousRect), to: rect(s.currentRect) };
      }) });
    }
  };
  state.observer = new PerformanceObserver(list => record(list.getEntries()));
  state.observer.observe({ type: 'layout-shift', buffered: true });
  state.read = () => { record(state.observer.takeRecords()); return { total: state.total, entries: state.entries, long: state.long }; };
  state.reset = () => { record(state.observer.takeRecords()); Object.assign(state, { total: 0, entries: [], nodes: [], long: [] }); };
  new PerformanceObserver(list => { for (const e of list.getEntries()) state.long.push({ at: Math.round(e.startTime), duration: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true });
  // Fetches the page has started and not yet answered, and response bodies it is still reading, counted in the page:
  // a request started in the last frame can't slip past the network events, and a body the app never reads (which
  // Chrome never reports finished) doesn't hold the measurement open.
  const track = pending => { state.fetches++; pending.finally(() => state.fetches--).catch(() => {}); return pending; };
  const original = window.fetch, held = url => String(url).includes('/v1/rules/version');
  window.fetch = function (...args) { const pending = original.apply(this, args); return held(args[0] instanceof Request ? args[0].url : args[0]) ? pending : track(pending); };
  for (const method of ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']) {
    const read = Response.prototype[method];
    if (read) Response.prototype[method] = function (...args) { return held(this.url) ? read.apply(this, args) : track(read.apply(this, args)); };
  }
};
// Resolves once fonts are loaded, two frames have rendered and the main thread has gone idle.
const quiet = () => document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestIdleCallback(() => done(window.__cls.fetches), { timeout: 1000 })))));

// Requests in flight. A fetch() leaves this set when its response headers arrive: the page counts its body reads.
function network(page) {
  const inflight = new Set(), waiters = [];
  let started = 0;
  const finish = request => { inflight.delete(request); if (!inflight.size) for (const done of waiters.splice(0)) done(); };
  page.on('request', request => { if (request.url().includes(LONG_POLL)) return; inflight.add(request); started++; });
  page.on('response', response => { if (response.request().resourceType() === 'fetch') finish(response.request()); });
  page.on('requestfinished', finish);
  page.on('requestfailed', finish);
  return {
    idle: () => inflight.size ? new Promise(done => waiters.push(done)) : Promise.resolve(),
    get started() { return started; }, get size() { return inflight.size; },
    pending: () => [...inflight].map(r => r.url()),
  };
}
async function settle(page, net) {
  for (let calm = 0; calm < 2;) {
    await net.idle();
    const mark = net.started;
    const fetches = await page.evaluate(quiet);
    calm = !net.size && net.started === mark && !fetches ? calm + 1 : 0;
  }
}
const sharp = n => Math.round(n * 10000) / 10000;
// A step that should ask first: whichever comes first, the question (asked) or the page going on without it (left). Both
// can take seconds on a loaded runner, where a fixed 3 or 5 s wait read a slow question as none (Nov 23).
const askedOrLeft = (question, left) => Promise.race([
  question.waitFor({ timeout: 30_000 }).then(() => 'asked', () => 'neither'),
  left.then(() => 'left', () => 'neither'),
]);
// The live view's long poll (features/inbound/live.ts) stays open while its page does; it never counts as loading.
const LONG_POLL = '/v1/rules/version';
let liveSaves = 0;

// Masked addresses, in the page. A seeded mailbox address (cls-fixture.mjs) may be spelled out only where it is typed or
// chosen (a field, a picker, a dialog) or in a code example; everywhere else the page holds its first two characters.
const maskedLeaks = () => {
  const SEEDED = /[A-Za-z0-9._%+*-]+@(?:[a-z0-9-]+\.)*(?:northwind\.example|lumenlabs\.example|fieldnotes\.example|driftwood\.example|example\.net|example\.com)\b/gi;
  const mailbox = value => value.slice(0, value.lastIndexOf('@')).replace(/\*/g, '') !== '';
  const exempt = el => !!el.closest('input, textarea, select, option, datalist, [contenteditable=""], [contenteditable="true"], pre, code, [role=dialog], [role=alertdialog], [data-own-address]');
  const found = [], note = (what, value) => { if (found.length < 5) found.push(`${what} spells out ${value.slice(0, 2)}…`); };
  for (const el of document.querySelectorAll('.private-address:not([data-revealed])')) {
    const text = el.querySelector('.private-address__value')?.textContent ?? el.textContent;
    if ([...text].length > 2 || !el.querySelector('.private-address__rest')) note('a masked address', text);
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) for (const value of node.nodeValue.match(SEEDED) ?? []) if (mailbox(value) && !exempt(node.parentElement) && !node.parentElement.closest('[data-revealed]')) note(`text in <${node.parentElement.tagName.toLowerCase()} class="${node.parentElement.className}">`, value);
  for (const el of document.body.querySelectorAll('[title], [aria-label], [aria-description], [alt], a[href]')) for (const name of ['title', 'aria-label', 'aria-description', 'alt', 'href']) {
    let value = el.getAttribute(name) ?? ''; try { value = decodeURIComponent(value); } catch {}
    for (const match of value.match(SEEDED) ?? []) if (mailbox(match) && !exempt(el)) note(`${name} on <${el.tagName.toLowerCase()} class="${el.className}">`, match);
  }
  return found;
};
// Where to point at the first few masked addresses in view that the pointer can reach, and what must stay where it is.
const maskedTargets = () => [...document.querySelectorAll('.private-address:not([data-revealed])')].map((el, index) => {
  const r = el.getBoundingClientRect(), x = r.left + 3, y = r.top + r.height / 2;
  return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(x, y)) ? { index, x, y } : null;
}).filter(Boolean).slice(0, 3);
const maskedState = index => {
  const el = document.querySelectorAll('.private-address')[index], rect = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(n => Math.round(n * 100) / 100).join(' '); };
  return { revealed: el.hasAttribute('data-revealed'), text: el.querySelector('.private-address__value').textContent, own: rect(el), around: rect(el.closest('tr, li, dd, h1, p, section') ?? el.parentElement) };
};
// The row J highlighted (lib/row-keys.ts): how many of its addresses are still masked, and where it is.
const highlightedRow = () => {
  const row = document.activeElement?.closest('[data-row-keys] [data-row-key]'), all = row ? [...row.querySelectorAll('.private-address')] : [];
  if (!all.length) return null;
  const r = row.getBoundingClientRect();
  return { masked: all.filter(el => !el.hasAttribute('data-revealed')).length, total: all.length, at: [r.x, r.y, r.width, r.height].map(n => Math.round(n * 100) / 100).join(' ') };
};
async function masking(page, hover, shell) {
  const problems = await page.evaluate(maskedLeaks);
  if (!hover) return problems;
  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  // ⇧ is ignored while typing in a field, so leave whatever field has focus first.
  await page.evaluate(() => document.activeElement?.blur());
  for (const { index, x, y } of await page.evaluate(maskedTargets)) {
    const before = await page.evaluate(maskedState, index);
    await page.mouse.move(x, y); await frame();
    const pointed = await page.evaluate(maskedState, index);
    await page.keyboard.down('Shift'); await frame();
    const shown = await page.evaluate(maskedState, index);
    await page.keyboard.up('Shift'); await frame();
    const released = await page.evaluate(maskedState, index);
    await page.mouse.move(1, 1); await frame();
    if (pointed.revealed || pointed.text !== before.text) problems.push(`pointing at ${before.text}… without ⇧ revealed it`);
    if (!shown.revealed || [...shown.text].length <= 2) problems.push(`⇧ over ${before.text}… did not reveal it`);
    else if (shown.own !== before.own || shown.around !== before.around) problems.push(`revealing ${before.text}… moved it: ${before.own} → ${shown.own}`);
    if (released.revealed || released.text !== before.text || released.own !== before.own) problems.push(`${before.text}… stayed revealed or moved after ⇧ was released`);
  }
  // J highlights a row without revealing its addresses, as pointing doesn't; ⇧ held while it is highlighted reveals that
  // row's without moving anything, and releasing ⇧ masks them again. J stops at the first row (of the first six) that holds one.
  if (await page.evaluate(() => !!document.querySelector('[data-row-keys] [data-row-key][data-clickable] .private-address'))) {
    await page.evaluate(() => document.activeElement?.blur());
    let row = null;
    for (let i = 0; i < 6 && !row; i++) { await page.keyboard.press('j'); await frame(); await frame(); row = await page.evaluate(highlightedRow); }
    if (row) {
      await page.keyboard.down('Shift'); await frame(); await frame();
      const shown = await page.evaluate(highlightedRow);
      await page.keyboard.up('Shift'); await frame(); await frame();
      const released = await page.evaluate(highlightedRow);
      if (row.masked !== row.total) problems.push(`J's highlight revealed ${row.total - row.masked} of its row's addresses`);
      if (!shown || shown.masked) problems.push('⇧ on the highlighted row did not reveal its addresses');
      else if (shown.at !== row.at) problems.push(`revealing the highlighted row moved it: ${row.at} → ${shown.at}`);
      if (!released || released.masked !== released.total) problems.push('the highlighted row stayed revealed after ⇧ was released');
    }
    await page.evaluate(() => document.activeElement?.blur());
  }
  // Privacy mode off (⇧P, lib/privacy.ts) reveals every address at once without moving anything; on again masks them.
  // ⇧P is the dashboard shell's shortcut (components/AppShell.tsx): a page without the shell (the signed-out waitlist,
  // onboarding) reveals one address at a time only.
  const count = await page.evaluate(() => document.querySelectorAll('.private-address').length);
  if (!count || !shell || !await page.evaluate(() => !!document.querySelector('.privacy-toggle'))) return problems;
  const states = async () => { const all = []; for (let i = 0; i < Math.min(count, 5); i++) all.push(await page.evaluate(maskedState, i)); return all; };
  // ⇧P is ignored while typing (the support chat's box, a rule's editor), so leave whatever field has focus first.
  await page.evaluate(() => document.activeElement?.blur());
  const before = await states();
  await page.keyboard.press('Shift+P'); await frame();
  const off = await states(), root = await page.evaluate(() => ({ privacy: document.documentElement.dataset.privacy, pressed: document.querySelector('.privacy-toggle')?.getAttribute('aria-pressed') }));
  if (root.privacy !== undefined || root.pressed !== 'false') problems.push(`⇧P did not turn privacy mode off: ${JSON.stringify(root)}`);
  off.forEach((state, i) => {
    if (!state.revealed || [...state.text].length <= 2) problems.push(`privacy mode off left ${before[i].text}… masked`);
    else if (state.own !== before[i].own || state.around !== before[i].around) problems.push(`privacy mode off moved ${before[i].text}…: ${before[i].own} → ${state.own}`);
  });
  await page.keyboard.press('Shift+P'); await frame();
  const on = await states();
  on.forEach((state, i) => { if (state.revealed !== before[i].revealed || state.text !== before[i].text || state.own !== before[i].own) problems.push(`privacy mode on again did not mask ${before[i].text}… as before`); });
  problems.push(...await page.evaluate(maskedLeaks));
  return problems;
}

async function measure(browser, job, fx) {
  const origin = fx.origins[job.index % fx.origins.length];
  const context = await browser.newContext({ ...devices[job.device], colorScheme: job.scheme, ...job.still && { reducedMotion: 'reduce' } });
  const result = { page: job.name, path: job.path, scheme: job.scheme, device: job.device, mode: job.mode, cls: null, entries: [], longTask: null, error: null };
  let page, net;
  const problems = [];
  let expected500 = null;
  const work = (async () => {
    if (job.waitlist) await context.addCookies([{ name: 'nightmail.waitlist', value: encodeURIComponent(job.waitlist), url: origin }]);
    if (job.user) await context.addCookies([job.user].flat().map((user, slot) => ({ name: slot ? `nightmail.session_token.${slot}` : 'nightmail.session_token', value: encodeURIComponent(fx.sessions[user].cookie), url: origin, httpOnly: true })));
    // A signed-in browser has been to the dashboard, which remembers it: the marketing pages ask for its session (data/live.ts, sessionLikely).
    if (job.user) await context.addInitScript(() => { try { localStorage.setItem('nightmail.session', 'in'); } catch {} });
    await context.addInitScript(probe);
    // Privacy mode on (lib/privacy.ts; off by default), so the masking checks and the review screenshots see addresses masked.
    // (Init scripts run in every frame too, and an email preview's sandboxed frame has no storage.)
    await context.addInitScript(() => { try { localStorage.setItem('nightmail.privacy.v2', 'on'); } catch {} });
    // Data Saver turns off the shell's idle warm-up of every other sidebar section: in-app clicks then load the next
    // page's code and data cold, and cold loads (apart from Overview, which exercises the warm-up in each pass) measure
    // their own page rather than re-fetching all eight sections 170 times.
    if (job.mode === 'in-app' || job.name !== 'Overview') await context.addInitScript(() => {
      if (navigator.connection) Object.defineProperty(navigator.connection, 'saveData', { get: () => true });
      else Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true });
    });
    // The support chat's scripted demo (components/SupportChat.tsx), so the open chat is measured without a support Worker.
    if (job.support) await context.addInitScript(() => sessionStorage.setItem('nightmail.support', 'demo'));
    // UI notes mode, as an operator turns it on (lib/ui-notes-mode.ts).
    if (job.notes) await context.addInitScript(() => localStorage.setItem('nightmail.ui-notes', 'on'));
    // Onboarding's domain step skipped in this browser (data/onboarding.ts), so a workspace with no domain opens the dashboard.
    if (job.skipped) await context.addInitScript(workspace => { try { localStorage.setItem(`nightmail.onboarding.domain.${workspace}`, 'done'); } catch {} }, job.skipped);
    // `step`: [workspace, the onboarding step this browser is on] (data/onboarding.ts).
    if (job.step) await context.addInitScript(([workspace, value]) => { try { localStorage.setItem(`nightmail.onboarding.domain.${workspace}`, value); } catch {} }, job.step);
    // How this browser left Overview's get-started strip for a workspace (features/overview/first-run.tsx).
    if (job.start) await context.addInitScript(([workspace, value]) => { try { localStorage.setItem(`nightmail.overview.start.${workspace}`, value); } catch {} }, job.start);
    // Overview's detail column hidden, as its toggle leaves it (features/overview/panel.ts).
    if (job.panel) await context.addInitScript(panel => { try { localStorage.setItem('nightmail.overview-panel', panel); } catch {} }, job.panel);
    page = await context.newPage();
    net = network(page);
    page.on('request', request => {
      const url = request.url();
      if (/^https?:\/\//i.test(url) && !url.startsWith(origin)) problems.push(`external request ${url}`);
      if (!job.user && url === origin + '/v1/me' && /^\/(?:$|docs(?:\/|$)|pricing\/?$|compare\/)/.test(new URL(page.url()).pathname))
        problems.push('Public page asked for /v1/me without a sign-in hint');
    });
    // A guard that makes a write fail on purpose expects its one 500 (expected500), and says so itself if it doesn't come.
    page.on('response', response => { if (response.url().startsWith(origin + '/v1/') && (response.status() >= 500 || response.status() === 429) && !(expected500 && response.status() === 500 && expected500(response))) problems.push(`${response.status()} ${response.request().method()} ${response.url().slice(origin.length)}`); });
    page.on('pageerror', error => problems.push(`page error: ${error.message}`));
    // The fixture's proxy shapes the traffic (cls-fixture.mjs): apiDelay on /v1/*, fonts from memory at once, and this
    // page's latency and bandwidth, for the requests carrying its x-cls-page. Not in Chrome: CDP Fetch interception
    // (context.route) paused targets on Linux CI, and DevTools throttling (Network.emulateNetworkConditionsByRule)
    // held a page's scripts for the whole page.goto after the proxy had sent them, in 12 of 36 shard runs on Nov 17.
    await context.setExtraHTTPHeaders({ 'x-cls-page': String(job.index) });
    if (lateFonts) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    }
    await page.goto(origin + (job.mode === 'in-app' ? job.from : job.path), { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(error => {
      throw new Error(`${error.message.split('\n')[0]} In flight: ${net.pending().map(url => url.replace(origin, '')).join(', ') || 'nothing'}`);
    });
    // With late fonts, the fallbacks only keep text still if this machine has one of their local fonts (tokens.css).
    const missing = !lateFonts ? [] : await page.evaluate(() => Promise.all([...document.fonts].filter(f => f.family.includes('Fallback')).map(f => f.load().then(() => null, () => `${f.family} ${f.weight} ${f.unicodeRange}`))));
    for (const face of missing.filter(Boolean)) problems.push(`no local font for ${face}: install fonts-liberation and fonts-dejavu-core, or measure on a machine with Arial and Menlo`);
    await settle(page, net);
    if (television && await page.evaluate(() => !!document.getElementById('home-shell'))) {
      await page.waitForFunction(() => !document.getElementById('home-shell'), null, { timeout: 30_000 }).catch(() => problems.push('the app never took over from the homepage\'s first screen'));
      await settle(page, net);
    }
    // A price page paints from its HTML first and its app takes over at the reader's first key or touch (app/price-pages.ts,
    // features/pricing/index.tsx): wake it, as a reader would, so the painted page and the takeover are both measured and
    // an in-app click lands in the app.
    if (await page.evaluate(() => !!document.getElementById('price-shell'))) {
      await page.keyboard.press('Shift');
      await page.waitForFunction(() => !document.getElementById('price-shell'), null, { timeout: 30_000 }).catch(() => problems.push('the app never took over from the painted page'));
      await settle(page, net);
    }
    if (job.support) {
      // Open the chat and let the greeting finish: the panel is idle and no caret is left in it.
      const opened = await page.evaluate(() => { const button = document.getElementById('support-trigger'); button?.click(); return Boolean(button); });
      if (!opened) problems.push('no Help button');
      else await page.waitForFunction(() => document.querySelector('#support-panel[data-open]:not([data-busy])') && !document.querySelector('#support-panel .support-caret'), null, { timeout: 30_000, polling: 100 });
      await settle(page, net);
    }
    if (job.dialog) {
      const opened = await page.evaluate(label => { const el = [...document.querySelectorAll('button')].find(el => el.getClientRects().length && el.textContent.trim().startsWith(label)); el?.click(); return Boolean(el); }, job.dialog);
      if (!opened) problems.push(`no control “${job.dialog}”`);
      else {
        const dialog = await page.waitForSelector('[role=dialog][data-state=open]', { timeout: 10_000 }).catch(() => { problems.push(`“${job.dialog}” opened no dialog`); return null; });
        // The page can go idle before the dialog's 200 ms entrance ends, whose transform then still moves what the
        // masked address check hovers by a fraction of a pixel (the route editor, Nov 20).
        await dialog?.evaluate(el => Promise.race([Promise.all(el.getAnimations({ subtree: true }).filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))), new Promise(done => setTimeout(done, 5000))]));
      }
      await settle(page, net);
    }
    if (job.tab) {
      const clicked = await page.evaluate(label => { const el = [...document.querySelectorAll('[role=tab]')].find(el => el.getClientRects().length && el.textContent.trim().startsWith(label)); el?.click(); return Boolean(el); }, job.tab);
      if (!clicked) problems.push(`no tab “${job.tab}”`);
      // The panel's entrance can outlast the idle wait; the masked address check then sees it still sliding.
      else await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))), new Promise(done => setTimeout(done, 5000))]));
      await settle(page, net);
    }
    if (job.menu) {
      // A row's menu, then one of its items: a dropdown opens on pointer down, a phone's action sheet on click. The
      // dialog the item opens is found by its title.
      const [trigger, item, title] = job.menu;
      const opened = await page.evaluate(label => { const el = [...document.querySelectorAll('button')].find(el => el.getClientRects().length && el.getAttribute('aria-label') === label); el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' })); el?.click(); return Boolean(el); }, trigger);
      const choice = opened && await page.waitForFunction(text => [...document.querySelectorAll('[role=menuitem], .ui-action-sheet__item, .more-sheet__link')].find(el => el.getClientRects().length && el.textContent.trim() === text), item, { timeout: 10_000 }).catch(() => null);
      if (!choice) problems.push(opened ? `no “${item}” in “${trigger}”` : `no control “${trigger}”`);
      else {
        await choice.evaluate(el => el.click());
        await page.waitForFunction(text => [...document.querySelectorAll('[role=dialog][data-state=open]')].some(el => el.textContent.includes(text)), title, { timeout: 10_000 }).catch(() => problems.push(`“${item}” opened no “${title}” dialog`));
      }
      await settle(page, net);
    }
    if (job.mode === 'in-app') {
      await page.evaluate(() => { window.__cls.reset(); window.__inApp = performance.now(); });
      if (job.switchTo) {
        // Open the switcher (a dropdown opens on pointer down, the phone's sheet on click) and pick the other account's workspace.
        await page.evaluate(() => { const trigger = document.querySelector('#sidebar-workspace'); trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' })); trigger?.click(); });
        const item = await page.waitForFunction(text => [...document.querySelectorAll('[role=menuitem], .account-sheet button')].find(el => el.textContent.includes(text)), job.switchTo, { timeout: 10_000 }).catch(() => null);
        result.via = item ? 'switch' : `no workspace “${job.switchTo}” in the switcher`;
        if (item) await item.evaluate(el => el.click());
      } else result.via = await page.evaluate(({ path, click, row }) => {
        const shown = el => el.getClientRects().length > 0, text = el => el.textContent.replace(/\s+/g, ' ').trim();
        // A table row, or on a phone its card (whose link covers it).
        if (row) { const tr = [...document.querySelectorAll('tbody tr, .ui-card')].find(tr => shown(tr) && text(tr).includes(row)); (tr?.querySelector('.ui-card__link') ?? tr)?.click(); return tr ? 'row' : `no row with “${row}”`; }
        if (click) { const el = [...document.querySelectorAll('a, button, [role=tab]')].find(el => shown(el) && text(el).startsWith(click)); el?.click(); return el ? 'control' : `no control “${click}”`; }
        const target = new URL(path, location.href);
        const link = [...document.querySelectorAll('a[href]')].find(a => a.href === target.href && shown(a));
        if (link) { link.click(); return 'link'; }
        history.pushState(null, '', target.href);
        dispatchEvent(new PopStateEvent('popstate'));
        return 'history';
      }, { path: job.path, click: job.click, row: job.row });
      if (result.via.startsWith('no ')) problems.push(result.via);
      await settle(page, net);
      const state = await page.evaluate(() => ({ at: window.__inApp, url: location.pathname + location.search + location.hash }));
      if (state.at === undefined) problems.push('the navigation reloaded the page');
      if (state.url !== job.path) problems.push(`landed on ${state.url}`);
      const read = await page.evaluate(() => window.__cls.read());
      result.longTask = Math.max(0, ...read.long.filter(t => t.at >= state.at).map(t => t.duration));
      Object.assign(result, { cls: sharp(read.total), entries: read.entries });
    } else {
      const read = await page.evaluate(() => window.__cls.read());
      Object.assign(result, { cls: sharp(read.total), entries: read.entries });
    }
    if (job.live) {
      // The agent saves; the page must show it (`apply`) or offer the choice (`conflict`) without anything moving.
      if (job.live === 'conflict') {
        await page.click('.ritual-editor .cm-line >> nth=2');
        await page.keyboard.press('End'); await page.keyboard.type(' // mine');
        await page.waitForSelector('.rule-page .ui-page-header .ui-button--primary:not([disabled])', { timeout: 10_000 });
      }
      const saved = await fetch(fx.apiOrigin + '/v1/rules/scripts/triage', { method: 'PUT', headers: { authorization: `Bearer ${fx.liveKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'triage', source: liveSource(++liveSaves) }) });
      if (!saved.ok) problems.push(`the agent's save failed: ${saved.status}`);
      else await page.waitForSelector(job.live === 'conflict' ? '.ritual-incoming' : '.rule-page[data-landed]', { timeout: 30_000 }).catch(() => problems.push(`no ${job.live === 'conflict' ? 'conflict card' : 'live update'} after the agent's save`));
      await settle(page, net);
      if (job.mode === 'load') { const read = await page.evaluate(() => window.__cls.read()); Object.assign(result, { cls: sharp(read.total), entries: read.entries }); }
    }
    if (job.leave) {
      // Templates → Edit, after the measurement: Reply to keeps two typed addresses apart, and Back with an edit autosave
      // hasn't sent asks first, then Save and leave saves it (templates.tsx's leave guard).
      const replyTo = ['billing@example.invalid', 'ops@example.invalid'], subject = `Leave check ${Date.now()}`;
      // Once the editor has loaded: before, Save and leave has nothing to save with and stays.
      await page.locator('.composer-canvas:not(:has(.composer-starting))').waitFor({ timeout: 30_000 }).catch(() => problems.push('the template editor never finished loading'));
      await page.fill('#template-reply', '');
      await page.locator('#template-reply').pressSequentially(replyTo.join(', '));
      const typed = await page.inputValue('#template-reply');
      if (typed !== replyTo.join(', ')) problems.push(`Reply to turned "${replyTo.join(', ')}" into "${typed}"`);
      // The subject, then Back in the next frame. Autosave sends 800 ms after Reply to becomes valid, so separate
      // Playwright steps on a loaded runner let it save everything first, and Back rightly left without asking.
      await page.evaluate(value => new Promise(done => {
        const input = document.querySelector('#template-subject');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        requestAnimationFrame(() => { document.querySelector('.ui-page-header a[href="/campaigns/templates"]').click(); done(); });
      }), subject);
      const outcome = await askedOrLeft(page.getByRole('dialog', { name: 'Leave without saving?' }), page.waitForURL(url => url.pathname === '/campaigns/templates', { timeout: 30_000 }));
      if (outcome !== 'asked') problems.push(outcome === 'left' ? 'Back with an unsaved template edit left without asking' : 'Back with an unsaved template edit neither asked nor left');
      else {
        await page.getByRole('button', { name: 'Save and leave' }).click();
        await page.waitForURL(url => url.pathname === '/campaigns/templates', { timeout: 20_000 }).catch(async () => problems.push(`Save and leave stayed on the template${await page.locator('[role=alert], [role=status]').allInnerTexts().then(texts => texts.filter(Boolean).length ? `: ${texts.filter(Boolean).join(' / ').slice(0, 160)}` : '', () => '')}`));
        const saved = await page.evaluate(id => fetch(`/v1/templates/${id}`).then(response => response.json()), job.path.split('/').pop());
        if (saved?.draft?.subject !== subject) problems.push(`Save and leave didn't keep the new subject (saved: "${saved?.draft?.subject}")`);
        if (JSON.stringify(saved?.draft?.replyTo) !== JSON.stringify(replyTo)) problems.push(`Reply to saved as ${JSON.stringify(saved?.draft?.replyTo)}`);
      }
    }
    if (job.user === 'rae') {
      const leak = await page.evaluate(async () => [document.querySelector('.uin-pill, .uin-pin, .uin-layer') && 'the notes layer', [...document.querySelectorAll('[role=tab], [role=menuitem]')].some(el => el.textContent.startsWith('UI notes')) && 'a UI notes control',
        await fetch('/v1/operator/ui-notes').then(r => r.status !== 404 && `GET /v1/operator/ui-notes answered ${r.status}`)].filter(Boolean));
      for (const what of leak) problems.push(`${what} for an operator outside UI_NOTES_SUBJECTS`);
    }
    const broken = await page.evaluate(() => document.querySelector('.fatal-error') ? 'the error boundary rendered' : [...document.querySelectorAll('h1,h2')].some(h => h.textContent === 'Page not found') ? 'Page not found' : null);
    if (job.notFound ? broken !== 'Page not found' : broken) problems.push(broken ?? 'expected "Page not found"');
    problems.push(...await masking(page, job.mode === 'load' && job.device === 'desktop', job.user !== null));
    // Overview's latest emails reserve as many 32px rows as reach the page's bottom edge (features/overview/latest.ts):
    // the list must end less than a row above it (Help's taller bottom padding only applies in one column) and never
    // past it.
    if (job.device === 'desktop' && job.path === '/overview') {
      const gap = await page.evaluate(() => {
        const list = document.querySelector('.ov-latest'), surface = document.querySelector('.page-surface');
        if (!list || !surface) return null;
        const bottom = surface.getBoundingClientRect().bottom - parseFloat(getComputedStyle(surface).paddingTop);
        return Math.round(bottom - list.getBoundingClientRect().bottom - surface.scrollTop);
      });
      if (gap !== null && (gap < 0 || gap >= 32)) problems.push(`Latest emails end ${gap}px above the page's bottom edge (expected 0–31): latest.ts's fixed heights are out of date`);
    }
    if (result.cls > LIMIT || process.env.CLS_SHOTS) {
      await page.evaluate(() => { for (const n of window.__cls.nodes) if (n.isConnected && n.style) n.style.outline = '2px solid #f0f'; });
      result.screenshot = `${job.slug}.png`;
      await page.screenshot({ path: join(out, result.screenshot) });
    }
    if (job.guard === 'receiving-edit') {
      // Saving through the address builder never changes an address's routes or rules it wasn't told to: New address
      // turns away one that exists and a *, an unchanged Save writes nothing, and closing with a change asks first.
      const writes = [];
      const onRequest = request => { if (request.method() !== 'GET' && request.url().startsWith(origin + '/v1/')) writes.push(`${request.method()} ${request.url().slice(origin.length)}`); };
      page.on('request', onRequest);
      const snapshot = () => page.evaluate(async () => JSON.stringify([await (await fetch('/v1/routing/routes')).json(), (await (await fetch('/v1/rules')).json()).config]));
      const before = await snapshot();
      // New address turns away an address that exists and a *, writing nothing: it only creates.
      const existing = await page.evaluate(async id => (await (await fetch('/v1/inbound/addresses/' + id)).json()).address, new URL(page.url()).searchParams.get('open'));
      for (const typed of [existing, '*@' + existing.split('@')[1]]) {
        await page.getByRole('button', { name: 'New address', exact: true }).click();
        const dialog = page.locator('[role=dialog][data-state=open]');
        await dialog.locator('#builder-address-input').fill(typed);
        await dialog.getByRole('button', { name: 'Next' }).click();
        await page.waitForTimeout(300);
        if (!await dialog.locator('#builder-address-input').count()) problems.push(`New address went past its first step for ${typed.startsWith('*') ? 'a catch-all' : 'an address that exists'}`);
        if (typed.startsWith('*') && !await dialog.getByRole('button', { name: 'Edit the catch-all' }).count()) problems.push('New address with * offers no way to the catch-all');
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        // What was typed is a change: closing asks first.
        const outcome = await askedOrLeft(page.getByRole('button', { name: 'Discard', exact: true }), page.locator('.builder').waitFor({ state: 'detached', timeout: 30_000 }));
        if (outcome !== 'asked') problems.push(outcome === 'left' ? 'Cancel with an address typed closed New address without asking' : 'Cancel with an address typed neither asked nor closed');
        else await page.getByRole('button', { name: 'Discard', exact: true }).click();
        await page.locator('.builder').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => problems.push('Discard left New address open'));
      }
      const edit = async () => { const clicked = await page.evaluate(() => { const button = [...document.querySelectorAll('.flow-panel button')].find(el => el.textContent.trim() === 'Edit'); button?.click(); return Boolean(button); }); if (clicked) await page.waitForSelector('.builder #builder-flow', { timeout: 10_000 }).catch(() => problems.push('Edit on the flow panel opened no builder for an address it can draw')); return clicked; };
      if (!await edit()) problems.push('no Edit on the flow panel');
      else {
        // Save with nothing changed: the result, and no write.
        await page.locator('.builder').getByRole('button', { name: 'Save' }).click();
        await page.locator('.builder').getByRole('button', { name: 'Done' }).click({ timeout: 10_000 }).catch(() => problems.push('an unchanged Save showed no result'));
        await page.waitForTimeout(300);
        // A change, then Cancel: asked, and discarded.
        if (await edit()) {
          await page.locator('.builder').getByRole('button', { name: 'Split with a rule' }).click();
          await page.locator('.builder').getByRole('button', { name: 'Cancel' }).click();
          const outcome = await askedOrLeft(page.getByRole('button', { name: 'Discard', exact: true }), page.locator('.builder').waitFor({ state: 'detached', timeout: 30_000 }));
          if (outcome !== 'asked') problems.push(outcome === 'left' ? 'Cancel after a change closed the builder without asking' : 'Cancel after a change neither asked nor closed the builder');
          else {
            await page.getByRole('button', { name: 'Discard', exact: true }).click();
            await page.locator('.builder').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => problems.push('Discard left the builder open'));
          }
        }
      }
      page.off('request', onRequest);
      if (writes.length) problems.push(`Edit wrote to the API: ${writes.join(', ')}`);
      if (await snapshot() !== before) problems.push('Edit changed the address\'s routes or rules');
    }
    if (job.guard === 'receiving-splits') {
      // Runs alone, after every shared page: it adds addresses and rules. An address with two splits opens its steps
      // (never a loop back to the same message), and each rule opens the builder on that rule; New rule's Split on an
      // address that splits already asks before replacing; Test's AI answer takes its side; a new address whose one
      // write fails leaves no endpoint behind, and Save again creates it.
      const api = (path, method = 'GET', body) => page.evaluate(async ([path, method, body]) => { const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, method, body]);
      const builder = page.locator('.builder[role=dialog]');
      const split = (value, then, otherwise) => ({ recipe: 'split', params: { test: 'subject', value, then, otherwise } });
      const two = (await api('/v1/inbound/addresses', 'POST', { address: 'guard-two@northwind.example', key: 'guard-two', flow: { deliver: [], split: split('invoice', 'crm', 'inbox:guard-two') } })).body;
      const second = (await api(`/v1/inbound/addresses/${two.id}/flow`, 'PATCH', { split: split('refund', 'store', 'inbox:guard-two') })).body;
      const config = (await api('/v1/rules')).body;
      const mine = config.config.attachments.filter(a => a.target === two.id), rest = config.config.attachments.filter(a => a.target !== two.id);
      await api('/v1/rules/attachments', 'PUT', { attachments: [...rest, ...mine.reverse()] });
      await page.goto(origin + `/receiving/addresses/${two.id}?tab=flow`);
      await page.locator('.flow-panel').getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20_000 });
      await page.waitForURL(/edit=1/, { timeout: 10_000 }).catch(() => problems.push('Edit on an address with two splits didn\'t open its steps'));
      if (await page.$('.builder')) problems.push('Edit on an address with two splits opened the builder');
      await page.getByText('It splits its mail with more than one rule.', { exact: false }).waitFor({ timeout: 20_000 }).catch(() => problems.push('the steps of an address with two splits don\'t say why'));
      await page.locator('.addr-rule', { hasText: 'refund' }).first().click({ timeout: 20_000 });
      const value = await builder.locator('#builder-value').inputValue({ timeout: 20_000 }).catch(() => null);
      if (value !== 'refund') problems.push(`its refund rule opened ${value === null ? 'no builder field' : `the builder on "${value}"`}`);
      if (await builder.getByRole('button', { name: 'One destination' }).count()) problems.push('the builder on one rule offers to reroute the address');
      await builder.getByRole('button', { name: 'Cancel' }).click().catch(() => {});
      // New rule → Split by words on an address with one split: asked, and Cancel writes nothing.
      const one = (await api('/v1/inbound/addresses', 'POST', { address: 'guard-one@northwind.example', key: 'guard-one', flow: { deliver: [], split: { recipe: 'split-by-meaning', params: { meaning: 'a refund request', then: 'crm', otherwise: 'inbox:guard-one' } } } })).body;
      const writes = [];
      const onRequest = request => { if (request.method() !== 'GET' && request.url().startsWith(origin + '/v1/') && !request.url().includes('/v1/rules/test')) writes.push(`${request.method()} ${request.url().slice(origin.length)}`); };
      page.on('request', onRequest);
      await page.goto(origin + `/receiving/rules/new?address=${one.id}`);
      await page.getByRole('link', { name: 'Split by words' }).click({ timeout: 20_000 });
      await page.getByText('Replace the existing split?').waitFor({ timeout: 20_000 }).catch(() => problems.push('New rule\'s Split on an address that splits already didn\'t ask to replace it'));
      if (await builder.locator('#builder-value').count()) problems.push('New rule\'s Split opened the existing split to change without asking');
      await builder.getByRole('button', { name: 'Cancel' }).click().catch(() => {});
      await page.waitForTimeout(300);
      page.off('request', onRequest);
      if (writes.length) problems.push(`Cancel on Replace the existing split? wrote: ${writes.join(', ')}`);
      // The AI says Yes takes If yes (crm), No the other side (its inbox).
      for (const [answer, want] of [['Yes', 'crm'], ['No', 'inbox']]) {
        await page.goto(origin + `/receiving/addresses/${one.id}?tab=flow`);
        await page.locator('.flow-sample summary').click({ timeout: 20_000 });
        await page.locator('.flow-sample button[role=combobox]').click();
        await page.getByRole('option', { name: answer, exact: true }).click();
        await page.locator('.flow-panel').getByRole('button', { name: 'Test', exact: true }).click();
        await page.waitForSelector('.flow-panel .flow[data-tested]', { timeout: 20_000 }).catch(() => {});
        const ticked = await page.locator('.flow-panel .flow-stage').last().locator('.flow-item[data-hit=yes]').allInnerTexts();
        if (ticked.length !== 1 || !ticked[0].toLowerCase().includes(want)) problems.push(`Test with The AI says ${answer} delivered to ${JSON.stringify(ticked)}, not ${want}`);
      }
      // A new address with two new webhooks whose one write fails (its rule write refused) leaves neither behind.
      await page.goto(origin + '/receiving');
      await page.getByRole('button', { name: 'New address', exact: true }).click({ timeout: 20_000 });
      await builder.locator('#builder-address-input').fill('guard-fails@northwind.example');
      await builder.getByRole('button', { name: 'Next' }).click();
      await builder.getByRole('button', { name: 'Split with a rule' }).click({ timeout: 20_000 });
      await builder.locator('#builder-value').fill('refund');
      for (const [side, url] of [['then', 'https://hooks.northwind.example/guard-one'], ['otherwise', 'https://hooks.northwind.example/guard-two']]) {
        await builder.locator(`#builder-${side}`).click();
        await page.getByRole('option', { name: 'New webhook' }).click();
        await builder.locator(`#builder-${side}-target`).fill(url);
      }
      await fx.db.query("CREATE FUNCTION cls_rule_refused() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rule write refused'; END $$");
      await fx.db.query('CREATE TRIGGER cls_rule_refused BEFORE INSERT OR UPDATE ON mail_ritual_configs FOR EACH ROW EXECUTE FUNCTION cls_rule_refused()');
      expected500 = r => r.url().endsWith('/v1/inbound/addresses') && r.request().method() === 'POST';
      try {
        const failed = page.waitForResponse(r => r.url().endsWith('/v1/inbound/addresses') && r.request().method() === 'POST', { timeout: 20_000 });
        await builder.getByRole('button', { name: 'Save' }).click();
        if ((await failed).status() !== 500) problems.push('the refused create didn\'t fail');
      } finally { expected500 = null; await fx.db.query('DROP TRIGGER cls_rule_refused ON mail_ritual_configs'); await fx.db.query('DROP FUNCTION cls_rule_refused()'); }
      for (const name of ['guard-fails-webhook', 'guard-fails-webhook-2']) if ((await api('/v1/endpoints/' + name)).status !== 404) problems.push(`a failed create left ${name} behind`);
      const retried = page.waitForResponse(r => r.url().endsWith('/v1/inbound/addresses') && r.request().method() === 'POST', { timeout: 20_000 });
      await builder.getByRole('button', { name: 'Save' }).click();
      if ((await retried).status() !== 201) problems.push(`Save again after a failed create returned ${(await retried).status()}`);
      // The wildcard and catch-all route editor saves with the version it read: a change made meanwhile to its route is
      // said and kept; one elsewhere in the workspace doesn't stop it.
      const crm = (await api('/v1/inbound/overview?limit=50')).body.endpoints.find(e => e.name === 'crm' && e.source === 'endpoint');
      const wild = (await api('/v1/routing/routes', 'POST', { match: 'guard-*@northwind.example', to: [crm.id] })).body;
      const routeEditor = page.locator('[role=dialog]', { hasText: 'Where should this mail go?' });
      const openEditor = async () => {
        await page.goto(origin + '/receiving?kind=pattern&q=guard-');
        await page.locator('.flow-panel').getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 20_000 });
        await routeEditor.locator('#routing-action').waitFor({ timeout: 20_000 });
      };
      const store = async () => { await routeEditor.locator('#routing-action').click(); await page.getByRole('option', { name: 'Stored 30 days, no inbox' }).click(); await routeEditor.getByRole('button', { name: 'Save' }).click(); };
      await openEditor();
      await api(`/v1/routing/routes/${wild.id}`, 'PATCH', { to: 'drop' });
      await store();
      await routeEditor.getByText('This changed since you opened it.', { exact: false }).waitFor({ timeout: 20_000 }).catch(() => problems.push('the route editor saved over a change made meanwhile, or didn\'t say so'));
      if ((await api(`/v1/routing/routes/${wild.id}`)).body.to !== 'drop') problems.push('the route editor overwrote a change made meanwhile');
      await openEditor();
      await api('/v1/routing/routes', 'POST', { match: 'guard-other@northwind.example', to: [crm.id] });
      await store();
      await routeEditor.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => problems.push('a change elsewhere in the workspace stopped the route editor\'s Save'));
      if (JSON.stringify((await api(`/v1/routing/routes/${wild.id}`)).body.to) !== '[]') problems.push('the route editor\'s Save after a change elsewhere didn\'t land');
      // An address's alias refuses a *, as New address does, pointing to the catch-all.
      await page.goto(origin + `/receiving/addresses/${two.id}?tab=settings`);
      await page.locator('.alias-input__field').waitFor({ state: 'attached', timeout: 20_000 });
      await page.evaluate(() => document.querySelector('.alias-input__field')?.closest('details')?.setAttribute('open', ''));
      await page.locator('.alias-input__field').fill('*', { timeout: 20_000 });
      await page.keyboard.press('Enter');
      if (!await page.getByRole('link', { name: 'Edit the catch-all' }).count()) problems.push('a * alias isn\'t pointed to the catch-all');
    }
  })();
  work.catch(() => {}); // After a timeout the context closes under it.
  let timer;
  try {
    await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out; in flight: ${net?.pending().join(', ') || 'nothing'}`)), JOB_TIMEOUT_MS); })]);
  } catch (error) {
    problems.push(error.message.split('\n')[0]);
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {});
  }
  if (problems.length) result.error = [...new Set(problems)].join('; ');
  return result;
}

const format = r => !r ? '' : r.error ? `❌ ${r.cls ?? 'error'}` : `${r.cls > LIMIT ? '❌ ' : ''}${r.cls === 0 ? '0' : r.cls.toFixed(4)}`;
function summarize(results, seconds) {
  const failed = results.filter(r => r.error || r.cls > LIMIT);
  const rows = new Map();
  for (const r of results) {
    const row = rows.get(r.page) ?? rows.set(r.page, { path: r.path, long: null }).get(r.page);
    row[`${r.device === 'phone' ? 'phone' : r.scheme} ${r.mode}`] = r;
    if (r.longTask !== null) row.long = Math.max(row.long ?? 0, r.longTask);
  }
  const lines = [
    `### Layout shift: ${failed.length ? `❌ ${failed.length} of ${results.length} measurements failed` : `✅ ${results.length} measurements, every page at CLS ≤ ${LIMIT}`}`,
    '',
    `Cold load and in-app navigation, throttled network, API responses delayed 300–1300 ms out of order, web fonts ${lateFonts ? `after ${FONT_DELAY_MS} ms` : 'before any text'}; desktop 1440 × 900, phone 390 × 844 with touch. Limit: CLS ${LIMIT}. Longest task during in-app navigation is reported, not gated. ${seconds}s.`,
    '',
    '| Page | Path | Light load | Light in-app | Dark load | Dark in-app | Phone load | Phone in-app | Longest task |',
    '| --- | --- | --: | --: | --: | --: | --: | --: | --: |',
    ...[...rows].map(([page, row]) => `| ${page} | \`${row.path}\` | ${format(row['light load'])} | ${format(row['light in-app'])} | ${format(row['dark load'])} | ${format(row['dark in-app'])} | ${format(row['phone load'])} | ${format(row['phone in-app'])} | ${row.long === null ? '' : `${row.long} ms`} |`),
  ];
  if (failed.length) {
    lines.push('', '#### Failures', '');
    for (const r of failed) {
      lines.push(`- **${r.page}** (${r.device === 'phone' ? 'phone' : r.scheme}, ${r.mode}) \`${r.path}\`: ${r.error ?? `CLS ${r.cls}`}`);
      for (const e of r.entries.slice(0, 5)) for (const s of e.sources.slice(0, 3)) lines.push(`  - ${e.value.toFixed(4)} at ${e.at} ms: \`${s.node}\` ${JSON.stringify(s.from)} → ${JSON.stringify(s.to)}${s.text ? ` “${s.text.slice(0, 50)}”` : ''}`);
    }
  }
  return { markdown: lines.join('\n') + '\n', failed };
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// No request leaves the machine: every host but the fixture's fails to resolve.
// All measured traffic is loopback. On Linux, creating an unrelated Docker interface makes Chromium
// cancel even these requests with ERR_NETWORK_CHANGED. A canceled route stylesheet triggers the
// app's stale-build reload, destroying the measured document. Keep host route notifications out of
// this browser only; its HTTP sockets, cache, rendering, and the fixture's throttling are unchanged.
let chrome = process.env.CLS_CHROME, launcherDir;
if (process.platform === 'linux') {
  launcherDir = mkdtempSync(join(tmpdir(), 'nightmail-cls-chrome-'));
  const launcher = join(launcherDir, 'chrome');
  writeFileSync(launcher, `#!/usr/bin/python3
import ctypes as c, errno, os, socket, sys
lib = c.CDLL("libseccomp.so.2")
class Arg(c.Structure):
    _fields_ = [("arg", c.c_uint), ("op", c.c_uint), ("a", c.c_uint64), ("b", c.c_uint64)]
lib.seccomp_init.argtypes = [c.c_uint32]
lib.seccomp_init.restype = c.c_void_p
lib.seccomp_rule_add_array.argtypes = [c.c_void_p, c.c_uint32, c.c_int, c.c_uint, c.POINTER(Arg)]
lib.seccomp_load.argtypes = lib.seccomp_release.argtypes = [c.c_void_p]
policy = lib.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
# Refuse only socket(AF_NETLINK, *, NETLINK_ROUTE); SCMP_CMP_EQ is 4.
args = (Arg * 2)(Arg(0, 4, socket.AF_NETLINK, 0), Arg(2, 4, socket.NETLINK_ROUTE, 0))
if not policy or lib.seccomp_rule_add_array(policy, 0x00050000 | errno.EAFNOSUPPORT, lib.seccomp_syscall_resolve_name(b"socket"), 2, args) or lib.seccomp_load(policy):
    sys.exit("CLS: could not isolate Chromium from host route changes")
lib.seccomp_release(policy)
chrome = os.environ.get("CLS_CHROME") or "/opt/google/chrome/chrome"
os.execv(chrome, [chrome, *sys.argv[1:]])
`, { mode: 0o700 });
  chrome = launcher;
}
const browserPromise = chromium.launch({ ...chrome ? { executablePath: chrome } : { channel: 'chrome' }, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] })
  .finally(() => { if (launcherDir) rmSync(launcherDir, { recursive: true, force: true }); });
browserPromise.catch(() => {});
const fx = await start(repo, { dist: television ? 'app/dist-tv' : 'app/dist', servers: Math.min(2, Math.ceil(workers / 8)), delay: apiDelay, fontDelay: lateFonts ? FONT_DELAY_MS : 0, throttle, log: message => console.log(`${elapsed()} ${message}`) }).catch(async error => {
  await browserPromise.then(b => b.close(), () => {});
  throw error;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => Promise.allSettled([fx.stop(), browserPromise.then(b => b.close())]).finally(() => process.exit(130)));
let results = [];
try {
  const [ids, browser] = await Promise.all([seed(fx), browserPromise]);
  console.log(`${elapsed()} seeded`);
  const jobs = [];
  const passes = [['desktop', 'light'], ['desktop', 'dark'], ...process.env.CLS_PHONE === '0' ? [] : [['phone', 'light']]];
  for (const [pass, scheme] of passes) for (const [name, path, { user = 'dana', from, click, row, switchTo, support, live, leave, notes, dialog, tab, menu, still, alone, phoneOnly, notFound, waitlist, guard, panel, skipped, step, start, wide }] of television ? televisionPages : pages(ids)) {
    if (only && !only.test(name) || pass === 'phone' && !television && !phonePages.has(name) || phoneOnly && pass !== 'phone') continue;
    // `wide` pages take the desktop passes at 3440 × 1440.
    const device = wide && pass === 'desktop' ? 'wide' : pass;
    const slug = `${name}-${device === 'phone' ? 'phone' : scheme}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const load = { name, path, user, scheme, device, support, live, leave: leave && device === 'desktop' && scheme === 'light', notes, panel, skipped, step, start, dialog, tab, menu, still, alone, notFound, waitlist, guard: guard && device === 'desktop' && scheme === 'light' ? guard : undefined, mode: 'load', slug: slug + '-load' };
    jobs.push(load);
    if (from) jobs.push({ name, path, user, from, click, row, switchTo, support, notes, panel, skipped, step, start, still, alone, scheme, device, mode: 'in-app', slug: slug + '-in-app' });
  }
  // Multi-step jobs (Support chat, live rules, Overview's full warm-up) start first so none trails alone at the end.
  const weight = job => (job.support ? 4 : 0) + (job.live ? 2 : 0) + (job.name === 'Overview' && job.mode === 'load' ? 3 : 0);
  jobs.forEach((job, index) => { job.index = index; });
  const queue = [...jobs].sort((a, b) => weight(b) - weight(a));
  // Deal each lane round-robin within each origin. A stride of four over alternating origins aimed up to
  // 20 simultaneous pages at one fixture API and hit READ_CONCURRENCY_LIMIT. Keep global IDs for the
  // origin and throttle bucket; the two buckets are fixed even on local runs with a single API.
  const lane = alone => {
    const next = [0, Math.floor(shards / 2)];
    return queue.filter(job => Boolean(job.alone) === alone && next[job.index % 2]++ % shards === shard);
  };
  const shared = lane(false), alone = lane(true);
  console.log(`${elapsed()} shard ${shard + 1}/${shards}: measuring ${shared.length + alone.length} of ${queue.length} page loads, ${workers} at a time`);
  const run = async job => {
    const r = await measure(browser, job, fx);
    results[job.index] = r;
    const flag = r.error || r.cls > LIMIT ? '✗' : '✓';
    console.log(`${elapsed().padStart(6)} ${flag} ${(r.device === 'phone' ? 'phone' : r.scheme).padEnd(5)} ${r.mode.padEnd(6)} ${r.page.padEnd(26)} ${String(r.cls).padEnd(7)}${r.longTask !== null ? ` ${r.longTask} ms` : ''}${r.error ? `  ${r.error}` : ''}`);
  };
  // The live rule jobs each have an agent save the same rule, and every one of their pages hears every save: one at a
  // time, so a page sees only its own save (two at once stacked a second toast that moved the first, Nov 23).
  let live = Promise.resolve();
  const turn = job => { if (!job.live) return run(job); const mine = live.then(() => run(job)); live = mine.catch(() => {}); return mine; };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, shared.length) }, async () => { while (next < shared.length) await turn(shared[next++]); }));
  for (const job of alone) await run(job);
} finally {
  await browserPromise.then(b => b.close(), () => {});
  writeFileSync(join(out, 'api.log'), fx.serverLog());
  await fx.stop();
}
results = results.filter(Boolean);
const { markdown, failed } = summarize(results, ((Date.now() - began) / 1000).toFixed(0));
writeFileSync(join(out, 'report.json'), JSON.stringify(results, null, 2));
writeFileSync(join(out, 'summary.md'), markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log('\n' + markdown);
process.exit(failed.length || !results.length ? 1 : 0);
