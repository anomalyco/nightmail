// The "setups" pitch (branch pitch/setups, not for merge): a throwaway hosted Nightmail with four synthetic workspaces
// and a stand-in for the API the pitch needs but the product doesn't have yet (/v1/setups: newsletters as things you
// open, people on one newsletter with a role, and send requests). Everything else is the real API on synthetic data.
//   node scripts/setups-pitch.mjs serve          start it and keep it running (its address and sessions go to a file in the temp folder)
//   node scripts/setups-pitch.mjs shots [filter] screenshot every screen from the running fixture
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { domain, hosted, mail, standing, start } from './cls-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '../..');
const stateFile = join(tmpdir(), 'nightmail-setups-pitch.json');
const OUT = process.env.PITCH_OUT || '/Users/vogel/.config/opensend-mx/review/setups-pitch';
const day = 86_400_000, now = Date.now();
const iso = ms => new Date(ms).toISOString();

// ---------------------------------------------------------------- the stand-in data
const issueHtml = (title, paragraphs, name) => ['<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#f6f5f1">',
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f1"><tr><td align="center" style="padding:32px 16px">',
  '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#ffffff;border-radius:8px;font-family:Georgia,serif;color:#1c1c1a">',
  '<tr><td style="padding:28px 36px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#77756f">' + name + '</td></tr>',
  '<tr><td style="padding:10px 36px 0"><h1 style="margin:0;font-size:26px;line-height:34px;font-weight:normal">' + title + '</h1></td></tr>',
  ...paragraphs.map(p => '<tr><td style="padding:16px 36px 0;font-size:16px;line-height:26px">' + p + '</td></tr>'),
  '<tr><td style="padding:28px 36px 30px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#8a8882">You get this because you signed up. <u>Unsubscribe</u></td></tr>',
  '</table></td></tr></table></body></html>'].join('');

// Weekly reader counts ending at the total: steady growth with a few better weeks, from a fixed seed.
function growth(total, weeks, first, seed) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const steps = Array.from({ length: weeks - 1 }, (_, i) => (0.6 + rnd() * 0.9) * (i % 9 === 4 ? 2.6 : 1));
  const sum = steps.reduce((a, b) => a + b, 0); let value = first;
  return [first, ...steps.map(step => Math.round(value += step / sum * (total - first)))].map((readers, i) => ({ at: iso(now - (weeks - 1 - i) * 7 * day), readers }));
}
function issues(prefix, subjects, { every = 7, readers, opened = 0.52, clicked = 0.11, seed = 3 }) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return subjects.map((subject, i) => {
    const recipients = Math.round(readers * (1 - i * 0.021));
    return { id: prefix + '_' + (subjects.length - i), number: subjects.length - i, subject, state: 'sent', sentAt: iso(now - (i * every + 3) * day), recipients, opened: opened - 0.05 + rnd() * 0.1, clicked: clicked - 0.03 + rnd() * 0.06 };
  });
}
const form = slug => ({ page: 'https://nightmail.dev/f/' + slug, tag: '<script src="https://nightmail.dev/f/' + slug + '.js" async></script>' });

const tide = {
  id: 'nl_tide', kind: 'newsletter', name: 'Tide Notes', from: 'Mara Quinn <mara@tidenotes.example>', readers: 3412, joined: 148, growth: growth(3412, 26, 2380, 11), form: form('tide-notes'),
  issues: [
    { id: 'tide_draft', number: 13, subject: 'The winter swim list', state: 'draft', updatedAt: iso(now - 0.2 * day) },
    ...issues('tide', ['What the storm left behind', 'A harbour at five in the morning', 'Kelp, and what to do with it', 'The ferry timetable, annotated', 'Small boats, big tides', 'Notes from the lighthouse road', 'Salt on everything', 'The low-tide walk to the island', 'Where the seals go in August', 'A field guide to sea fog', 'Mending nets', 'Hello from the shore'], { readers: 3398 }),
  ],
  people: [{ id: 'user_mara', name: 'Mara Quinn', email: 'mara@tidenotes.example', role: 'owner' }], invitations: [], requests: [],
};
const brief = {
  id: 'nl_brief', kind: 'newsletter', name: 'The Orchard Brief', from: 'Orchard <brief@orchard.example>', readers: 18204, joined: 612, growth: growth(18204, 26, 13150, 5), form: form('orchard-brief'),
  issues: [
    { id: 'brief_32', number: 32, subject: 'What’s new in November', state: 'draft', updatedAt: iso(now - 0.05 * day), by: 'Maya Chen', sendAt: (() => { const at = new Date(now + 3 * day); at.setHours(9, 0, 0, 0); return at.toISOString(); })(),
      html: issueHtml('What’s new in November', ['Three things shipped this month, and one of them you asked for by name.', '<b>Shared baskets.</b> Split an order with a neighbour and pay only your half. It works with pickup and delivery.', '<b>Pick-your-day delivery.</b> Choose the day when you order instead of the day we choose for you.', '<b>The apple finder.</b> Tell us sweet or sharp, eating or baking, and we will name three varieties in season near you.', 'That’s it. See you in December.'], 'The Orchard Brief') },
    ...issues('brief', ['Cider season, and a new pickup point', 'Pears are early this year', 'Your orchard, your schedule', 'The September price list', 'Plums, damsons and what’s between', 'A better box for a hot week', 'Summer hours start Monday', 'Strawberries: the short version', 'Meet the growers', 'Blossom report'], { every: 14, readers: 18110, opened: 0.47, clicked: 0.09, seed: 9 }).map((issue, i) => ({ ...issue, id: 'brief_' + (31 - i), number: 31 - i })),
  ],
  people: [
    { id: 'user_ana', name: 'Ana Ortiz', email: 'ana@orchard.example', role: 'owner' }, { id: 'user_dev', name: 'Dev Shah', email: 'dev@orchard.example', role: 'admin' },
    { id: 'user_priya', name: 'Priya Nair', email: 'priya@orchard.example', role: 'member' }, { id: 'user_maya', name: 'Maya Chen', email: 'maya@orchard.example', role: 'writer' },
  ], invitations: [], requests: [],
};
// Two newsletters and campaigns that belong to neither: each newsletter is its own item, and Campaigns holds the rest.
const weekly = { id: 'nl_weekly', kind: 'newsletter', name: 'Fernhill Weekly', from: 'Fernhill Farm <weekly@fernhill.example>', readers: 5120, joined: 190, growth: growth(5120, 26, 3900, 21), form: form('fernhill-weekly'),
  issues: issues('weekly', ['The last of the apples', 'Frost on the kale', 'Hedges, and who lives in them', 'A wet October', 'Seed swap on Saturday', 'What we are planting'], { readers: 5080, seed: 4 }),
  people: [{ id: 'user_lou', name: 'Lou Holt', email: 'lou@fernhill.example', role: 'owner' }], invitations: [], requests: [] };
const trade = { id: 'nl_trade', kind: 'newsletter', name: 'Trade Notes', from: 'Fernhill Farm <trade@fernhill.example>', readers: 640, joined: 22, growth: growth(640, 26, 510, 31), form: form('fernhill-trade'),
  issues: issues('trade', ['Wholesale prices from January', 'Delivery days are changing', 'New: mixed crates'], { every: 30, readers: 636, opened: 0.68, clicked: 0.22, seed: 6 }),
  people: [{ id: 'user_lou', name: 'Lou Holt', email: 'lou@fernhill.example', role: 'owner' }], invitations: [], requests: [] };
// What each workspace has set up; the sidebar is built from this and from who is asking.
const workspaces = {
  ws_tide: { setups: [tide], has: { audience: true, domains: true } },
  ws_ledger: { setups: [{ id: 'app_ledger', kind: 'app', name: 'App email' }], has: { app: true, domains: true } },
  ws_orchard: { setups: [{ id: 'app_orchard', kind: 'app', name: 'App email' }, brief], has: { app: true, audience: true, domains: true } },
  ws_wren: { setups: [], has: {} },
  ws_fern: { setups: [weekly, trade], has: { campaigns: true, audience: true, domains: true } },
};
// People on one newsletter only (a real workspace "member" underneath): their role there.
const scoped = { user_maya: { setup: 'nl_brief', role: 'writer' }, user_priya: { setup: 'nl_brief', role: 'member' } };

// ---------------------------------------------------------------- the stand-in API
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
const who = new Map();
async function caller(req, apiOrigin, origin) {
  const key = [req.headers.cookie, req.headers['x-nightmail-workspace'], req.headers['x-nightmail-account']].join('|');
  if (!who.has(key)) {
    const headers = { cookie: req.headers.cookie ?? '', origin };
    for (const name of ['x-nightmail-workspace', 'x-nightmail-account']) if (req.headers[name]) headers[name] = req.headers[name];
    const me = await fetch(apiOrigin + '/v1/me', { headers }).then(r => r.ok ? r.json() : null, () => null);
    if (!me) return null;
    who.set(key, me);
  }
  return who.get(key);
}
const view = (setup, user) => {
  if (setup.kind !== 'newsletter') return setup;
  const role = scoped[user.userId]?.role ?? user.role;
  return { ...setup, role, can: { send: role !== 'writer', invite: role === 'owner' || role === 'admin' }, requests: setup.requests.map(r => ({ ...r, issue: setup.issues.find(i => i.id === r.issueId) })) };
};
async function handle(req, res, { pathname, apiOrigin, origin }) {
  if (pathname === '/__pitch/reset') { for (const s of [tide, brief]) { s.requests = []; s.invitations = []; } brief.issues[0].state = 'draft'; delete brief.issues[0].scheduledAt; workspaces.ws_wren = { setups: [], has: {} }; return json(res, 200, {}); }
  if (!pathname.startsWith('/v1/setups')) return false;
  const me = await caller(req, apiOrigin, origin);
  if (!me) return json(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in.' } });
  const user = { userId: me.email ? emails[me.email] : null, role: me.role, name: me.name };
  const ws = workspaces[me.workspaceId] ?? { setups: [], has: {} }, only = scoped[user.userId];
  const mine = ws.setups.filter(s => !only || s.id === only.setup);
  const parts = pathname.split('/').slice(3), body = req.method === 'POST' ? JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString() || '{}') : null;
  if (!parts.length && req.method === 'GET') return json(res, 200, { role: only?.role ?? user.role, only: only?.setup ?? null, has: only ? {} : ws.has,
    setups: mine.map(s => ({ id: s.id, kind: s.kind, name: s.name, waiting: s.kind === 'newsletter' && (only?.role ?? user.role) !== 'writer' ? s.requests.length : 0 })) });
  if (parts.length === 1 && !parts[0]) parts.pop();
  if (!parts.length && req.method === 'POST') {
    const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const made = { id: 'nl_' + slug, kind: 'newsletter', name: body.name, from: body.from, readers: 0, joined: 0, growth: [], form: form(slug), issues: [], people: [{ id: user.userId, name: user.name, email: me.email, role: 'owner' }], invitations: [], requests: [] };
    if (!workspaces[me.workspaceId]) workspaces[me.workspaceId] = { setups: [], has: {} };
    workspaces[me.workspaceId].setups.push(made); workspaces[me.workspaceId].has.domains = true;
    return json(res, 201, { id: made.id });
  }
  const setup = mine.find(s => s.id === parts[0]);
  if (!setup) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
  if (parts.length === 1) return json(res, 200, view(setup, user));
  if (parts[1] === 'people' && req.method === 'POST') { setup.invitations.push({ email: body.email, role: body.role }); return json(res, 201, view(setup, user)); }
  if (parts[1] === 'requests' && req.method === 'POST' && parts.length === 2) {
    const issue = setup.issues.find(i => i.id === body.issueId);
    issue.state = 'requested';
    setup.requests.push({ id: 'req_' + Date.now().toString(36), issueId: issue.id, by: user.name, at: iso(Date.now()) });
    return json(res, 201, view(setup, user));
  }
  if (parts[1] === 'requests' && req.method === 'POST') {
    const request = setup.requests.find(r => r.id === parts[2]), issue = setup.issues.find(i => i.id === request.issueId);
    setup.requests = setup.requests.filter(r => r !== request);
    if (parts[3] === 'send') { issue.state = 'scheduled'; issue.scheduledAt = issue.sendAt; issue.approvedBy = user.name; } else issue.state = 'draft';
    return json(res, 200, view(setup, user));
  }
  return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
}

// ---------------------------------------------------------------- the real, synthetic part
const emails = {};
const factor = (key, label, weight, value, score) => ({ key, label, weight, value, score, points: Math.round(weight * score) / 100, source: 'measured', basis: 'Pitch fixture.' });
const good = { score: 96.2, limit: null, step: 'ok', since: iso(now - 40 * day), factors: [factor('complaints', 'Complaints', 30, 0.0001, 97), factor('bounces', 'Bounces', 15, 0.004, 96), factor('hygiene', 'List quality', 15, 0.01, 98), factor('auth', 'Authentication', 10, 1, 100), factor('engagement', 'Engagement', 10, 0.004, 94)] };
// Credit, so no workspace shows the empty-balance banner.
const credit = (db, ws) => db.query("SELECT billing_post($1,'topup',$2,5000000000::bigint,0::bigint,'{}'::jsonb,'stripe')", [ws, 'attempt:pitch_' + ws]);
// A newsletter's readers as real contacts on a real list, so Readers (the Audience page) shows them.
async function readersOf(db, ws, listName, count) {
  const list = 'list_pitch_' + ws;
  await db.query('INSERT INTO audience_lists(id,workspace_id,name) VALUES($1,$2,$3)', [list, ws, listName]);
  await db.query(`INSERT INTO audience_contacts(id,workspace_id,email,name,marketing_consent,created_at,updated_at)
    SELECT 'contact_pitch_'||$1||'_'||g, $1, lower(f.n)||'.'||lower(l.n)||g||'@example.net', f.n||' '||l.n, 'subscribed', now()-((($2-g)::float/$2)*182||' days')::interval, now()
    FROM generate_series(1,$2) g
    JOIN LATERAL (SELECT (ARRAY['Ada','Grace','Linus','Margaret','Ken','Barbara','Edsger','Radia','Alan','Frances','Dennis','Adele','Tim','Hedy','Guido','Sophie','Niklaus'])[1+g%17] AS n) f ON true
    JOIN LATERAL (SELECT (ARRAY['Okafor','Lind','Moreau','Park','Rivera','Quinn','Brandt','Sato','Mensah','Alvarez','Field','Moana','Bell','Ortiz','Shah','Chen','Nair','Wren','Holt'])[1+(g*7)%19] AS n) l ON true`, [ws, count]);
  await db.query("INSERT INTO audience_list_members(workspace_id,list_id,contact_id,created_at) SELECT workspace_id,$2,id,created_at FROM audience_contacts WHERE workspace_id=$1", [ws, list]);
}
async function seed(fx) {
  const { db } = fx;
  const signIn = (key, email, name, workspace) => { emails[email] = 'user_' + key; return fx.signIn(key, email, name, workspace); };
  // 1. An indie newsletter: one person, one newsletter.
  await signIn('mara', 'mara@tidenotes.example', 'Mara Quinn', { id: 'ws_tide', name: 'Mara Quinn' });
  await domain(db, 'ws_tide', await hosted(db, 'ws_tide'), 'tidenotes.example', { mailFrom: true });
  await standing(db, 'ws_tide', good);
  await readersOf(db, 'ws_tide', 'Tide Notes', 3412);
  // 2. A developer's app: keys, a verified domain, sign-in emails flowing, no campaigns.
  const jon = await signIn('jon', 'jon@ledgerly.example', 'Jon Bell', { id: 'ws_ledger', name: 'Ledgerly' });
  await domain(db, 'ws_ledger', await hosted(db, 'ws_ledger'), 'mail.ledgerly.example', { mailFrom: true });
  await jon.api('POST', '/v1/api-keys', { name: 'Production', permissions: ['send'], domains: ['mail.ledgerly.example'] }, 201);
  await jon.api('POST', '/v1/api-keys', { name: 'Staging', permissions: ['send'], domains: [] }, 201);
  await mail(db, 'ws_ledger', 30, { from: 'login@mail.ledgerly.example', subject: 'Your sign-in code', share: 1 });
  await standing(db, 'ws_ledger', good);
  // 3. A company doing both, with a team. Maya and Priya are plain members underneath; the stand-in scopes them.
  const ana = await signIn('ana', 'ana@orchard.example', 'Ana Ortiz', { id: 'ws_orchard', name: 'Orchard' });
  await signIn('dev', 'dev@orchard.example', 'Dev Shah', { id: 'ws_orchard', name: 'Orchard', role: 'admin' });
  await signIn('maya', 'maya@orchard.example', 'Maya Chen', { id: 'ws_orchard', name: 'Orchard', role: 'member' });
  await signIn('priya', 'priya@orchard.example', 'Priya Nair', { id: 'ws_orchard', name: 'Orchard', role: 'member' });
  const conn = await hosted(db, 'ws_orchard');
  await domain(db, 'ws_orchard', conn, 'orchard.example', { mailFrom: true });
  await domain(db, 'ws_orchard', conn, 'mail.orchard.example', { mailFrom: true });
  await ana.api('POST', '/v1/api-keys', { name: 'Production', permissions: ['send'], domains: ['mail.orchard.example'] }, 201);
  await mail(db, 'ws_orchard', 30, { from: 'orders@mail.orchard.example', subject: 'Your order is confirmed', share: 1 });
  await readersOf(db, 'ws_orchard', 'The Orchard Brief', 18204);
  await standing(db, 'ws_orchard', good);
  // 4. Brand new: a sending connection and nothing else.
  await signIn('sol', 'sol@wren.example', 'Sol Wren', { id: 'ws_wren', name: 'Wren & Co' });
  await hosted(db, 'ws_wren');
  // 5. Two newsletters, and two campaigns that are neither's issue.
  const lou = await signIn('lou', 'lou@fernhill.example', 'Lou Holt', { id: 'ws_fern', name: 'Fernhill Farm' });
  await domain(db, 'ws_fern', await hosted(db, 'ws_fern'), 'fernhill.example', { mailFrom: true });
  await standing(db, 'ws_fern', good);
  await lou.api('POST', '/v1/campaigns', { name: 'Farm shop: Christmas hours', subject: 'Open every day until the 24th', from: 'shop@fernhill.example', html: '<p>We are open every day until the 24th.</p>' });
  await lou.api('POST', '/v1/campaigns', { name: 'Open day invitation', subject: 'Come and see the farm', from: 'shop@fernhill.example', html: '<p>Saturday 12 December, 10 to 4.</p>' });
  for (const ws of ['ws_tide', 'ws_ledger', 'ws_orchard', 'ws_wren', 'ws_fern']) await credit(db, ws);
}

// ---------------------------------------------------------------- serve
async function serve() {
  const fx = await start(repo, { log: line => console.log(line), handle });
  const stop = async () => { rmSync(stateFile, { force: true }); await fx.stop(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try { await seed(fx); } catch (error) { console.error(error); await stop(); }
  writeFileSync(stateFile, JSON.stringify({ origin: fx.origin, sessions: Object.fromEntries(Object.entries(fx.sessions).map(([k, v]) => [k, v.cookie])) }));
  console.log('ready ' + fx.origin);
  setInterval(() => {}, 1 << 30);
}

// ---------------------------------------------------------------- shots
const devices = { 'desktop-dark': { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' }, 'desktop-light': { viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' } };
// A screen: file name, who is signed in, the path, and steps run once the page has settled. `only` limits it to one device.
// The first group reads state nothing changes and runs in parallel; the flows change the stand-in's state and run in order.
const click = (name, role = 'button') => page => page.getByRole(role, { name, exact: true }).first().click();
const fill = (label, value) => page => page.getByLabel(label, { exact: true }).fill(value);
const tidePage = '/newsletters/nl_tide', orchard = '/newsletters/nl_brief';
const still = [
  ['1-indie-home', 'mara', tidePage],
  ['1-indie-form', 'mara', tidePage, click('Subscribe form')],
  ['1-indie-invite', 'mara', tidePage, click('Invite'), fill('Email', 'jo@tidenotes.example')],
  ['1-indie-add', 'mara', '/add'],
  ['1-indie-readers', 'mara', '/audience'],
  ['1-indie-more', 'mara', tidePage, click('More'), { only: 'phone' }],
  ['2-dev-home', 'jon', '/overview'],
  ['2-dev-add', 'jon', '/add'],
  ['3-owner-home', 'ana', '/overview'],
  ['3-owner-newsletter', 'ana', orchard],
  ['3-owner-invite', 'ana', orchard, click('Invite'), fill('Email', 'sam@orchard.example')],
  ['3-owner-add', 'ana', '/add'],
  ['3-owner-more', 'ana', '/overview', click('More'), { only: 'phone' }],
  ['3-writer-home', 'maya', orchard],
  ['3-writer-issue', 'maya', orchard + '/issues/brief_32'],
  ['4-new-first', 'sol', '/overview'],
  ['5-two-newsletters', 'lou', '/newsletters/nl_weekly'],
  ['5-two-campaigns', 'lou', '/campaigns'],
  ['4-new-name', 'sol', '/add/newsletter', fill('Name', 'Wren Weekly'), fill('From', 'hello@wren.example')],
];
const flow = [
  ['3-writer-requested', 'maya', orchard + '/issues/brief_32', click('Request send')],
  ['3-writer-after', 'maya', orchard],
  ['3-sender-home', 'priya', orchard],
  ['3-sender-review', 'priya', orchard + '/issues/brief_32'],
  ['3-owner-waiting', 'ana', '/overview'],
  ['3-sender-sent', 'priya', orchard + '/issues/brief_32', click('Send')],
  ['4-new-created', 'sol', '/add/newsletter', fill('Name', 'Wren Weekly'), fill('From', 'hello@wren.example'), click('Create newsletter')],
];
async function shots(filter) {
  const { origin, sessions } = JSON.parse(readFileSync(stateFile, 'utf8'));
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const wanted = list => list.filter(([name]) => !filter || filter.split(',').some(part => name.includes(part)));
  async function shot(device, [name, user, path, ...rest]) {
    const steps = rest.filter(step => typeof step === 'function'), options = rest.find(step => typeof step === 'object') ?? {};
    if (options.only && options.only !== device) return;
    const context = await browser.newContext({ ...devices[device], reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'nightmail.session_token', value: encodeURIComponent(sessions[user]), url: origin, httpOnly: true }]);
    const page = await context.newPage();
    try {
      await page.goto(origin + path, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      for (const step of steps) { await step(page); await page.waitForLoadState('networkidle'); await page.waitForTimeout(300); }
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(OUT, name + '-' + device + '.png') });
      console.log(name + '-' + device);
    } catch (error) { console.error('FAILED ' + name + '-' + device + ': ' + error.message.split('\n')[0]); }
    await context.close();
  }
  for (const device of Object.keys(devices).filter(d => !process.env.PITCH_DEVICE || d === process.env.PITCH_DEVICE)) {
    await fetch(origin + '/__pitch/reset');
    const jobs = wanted(still); let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => { for (let job; (job = jobs[next++]);) await shot(device, job); }));
    // A flow needs the steps before it, so a filter that names one of its screens runs the whole flow.
    if (wanted(flow).length) for (const job of flow) await shot(device, job);
  }
  await fetch(origin + '/__pitch/reset');
  await browser.close();
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'serve') await serve(); else if (mode === 'shots') await shots(arg); else { console.error('usage: setups-pitch.mjs serve | shots [filter]'); process.exit(1); }
