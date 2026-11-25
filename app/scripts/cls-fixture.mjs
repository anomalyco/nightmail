// A throwaway hosted Nightmail for the CLS gate: a fresh Postgres database, the Node API serving the production dashboard
// build (app/dist) and synthetic workspaces. Nothing touches a real deployment, SES or real mail.
// Postgres comes from CLS_PG_URL (an admin connection, as the CI service provides), else a container of the CI image
// when Docker is running, else a temporary initdb cluster. The database and role are created here and removed on stop().
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { Agent, createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const PG_IMAGE = 'postgres:17.11-alpine';
const hasDocker = () => { try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }); return true; } catch { return false; } };
// Postgres binaries for a local run without CLS_PG_URL or Docker: PATH first, then pg_config's bindir.
function pgBin(name) {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return name; } catch {}
  try { return join(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(), name); } catch {}
  throw new Error(`CLS gate: set CLS_PG_URL to a Postgres admin URL, or install Postgres so ${name} is on PATH.`);
}

// One page's network, as the gate models it: no response starts sooner than `latency` ms after its request arrived, and
// the response bodies of one page share `bytesPerSecond`, as Chrome's DevTools throttling modeled them. The browser
// marks each request with its page (`x-cls-page`); a request without one (the gate's own seeding) is not shaped.
// Chrome's own throttling (Network.emulateNetworkConditionsByRule) stalled now and then on CI's 4-core runner: a
// page's script and stylesheet responses sat in it for the whole 60 s page.goto, headers received or not even that,
// long after this proxy had sent them (Nov 17: 12 of 36 CI shard runs; none of 24 with this link instead).
function pageLink({ latency, bytesPerSecond }) {
  const streams = [];
  let timer = null, last = 0, budget = 0, turn = 0;
  const schedule = () => {
    if (timer || !streams.length) return;
    const now = performance.now();
    const due = streams.some(s => s.head === null && s.ops.length) ? 10 : Math.min(...streams.map(s => s.head ?? Infinity)) - now;
    if (due === Infinity) return;
    timer = setTimeout(pump, Math.max(1, Math.ceil(due)));
  };
  const pump = () => {
    timer = null;
    const now = performance.now();
    // Bytes accrue only while some body is waiting; a timer that fires late catches up (up to one second's worth).
    budget = streams.some(s => s.head === null && s.ops.length) ? Math.min(budget + (now - last) * bytesPerSecond / 1000, bytesPerSecond) : 0;
    last = now;
    for (const s of streams) if (s.head !== null && s.head <= now) { s.head = null; s.writeHead(...s.headArgs); }
    // Round-robin in packets, as Chrome does, so concurrent bodies share the page's bandwidth.
    for (let moved = true; moved;) {
      moved = false;
      const order = streams.slice(turn % streams.length).concat(streams.slice(0, turn % streams.length)); turn++;
      for (const s of order) {
        if (s.head !== null) continue;
        while (s.ops.length && s.ops[0] === END) { s.ops.shift(); s.end(); }
        if (!s.ops.length) { if (s.ended) streams.splice(streams.indexOf(s), 1); continue; }
        if (budget < 1) continue;
        const chunk = s.ops[0], n = Math.min(chunk.length, 1500, Math.floor(budget));
        s.write(chunk.subarray(0, n)); budget -= n; moved = true;
        if (n === chunk.length) s.ops.shift(); else s.ops[0] = chunk.subarray(n);
        if (s.ops[0] === END) { s.ops.shift(); s.end(); }
      }
    }
    for (let i = streams.length - 1; i >= 0; i--) if (streams[i].ended && !streams[i].ops.length && streams[i].head === null) streams.splice(i, 1);
    schedule();
  };
  const END = Symbol('end');
  // Holds the response's head until `latency` after `arrived`, then paces its body; nothing is buffered beyond memory.
  return (res, arrived) => {
    const s = { head: arrived + latency, headArgs: null, ops: [], ended: false, writeHead: res.writeHead.bind(res), write: res.write.bind(res), end: res.end.bind(res) };
    let headQueued = false;
    if (!streams.length) { last = performance.now(); budget = 0; }
    res.writeHead = (...args) => { if (!headQueued) { headQueued = true; s.headArgs = args; streams.push(s); schedule(); } return res; };
    res.write = (chunk, encoding, done) => {
      if (!headQueued) res.writeHead(res.statusCode);
      if (chunk?.length) s.ops.push(typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (typeof encoding === 'function') encoding(); else if (typeof done === 'function') done();
      schedule();
      return true;
    };
    res.end = (chunk, encoding, done) => {
      if (typeof chunk === 'function') { done = chunk; chunk = undefined; }
      if (chunk !== undefined && chunk !== null) res.write(chunk, encoding);
      else if (!headQueued) res.writeHead(res.statusCode);
      if (!s.ended) { s.ended = true; s.ops.push(END); }
      if (typeof encoding === 'function') encoding(); else if (typeof done === 'function') done();
      schedule();
      return res;
    };
    res.once('close', () => { const i = streams.indexOf(s); if (i !== -1) streams.splice(i, 1); s.ops.length = 0; });
  };
}

export async function start(repo, { log = () => {}, servers = 1, delay = null, fontDelay = 0, throttle = null } = {}) {
  const api = join(repo, 'api');
  const require = createRequire(join(api, 'package.json'));
  const pg = require('pg');
  const home = mkdtempSync(join(tmpdir(), 'bane-cls-'));
  const cleanups = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    for (const fn of cleanups.reverse()) { try { await fn(); } catch {} }
    rmSync(home, { recursive: true, force: true });
  };
  try {
    let adminUrl = process.env.CLS_PG_URL;
    const fast = ['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'];
    if (!adminUrl && hasDocker()) {
      // The same image as the CI service.
      const port = await freePort(), password = randomBytes(12).toString('hex');
      const id = execFileSync('docker', ['run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data:rw', '-e', `POSTGRES_PASSWORD=${password}`, '-p', `127.0.0.1:${port}:5432`, PG_IMAGE, ...fast], { encoding: 'utf8' }).trim();
      cleanups.push(() => execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' }));
      adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
      // The image's init server listens on a socket only: the first TCP connection is the real server.
      for (let tries = 0; ; tries++) {
        const probe = new pg.Client({ connectionString: adminUrl });
        try { await probe.connect(); await probe.end(); break; } catch (error) { if (tries > 300) throw error; await new Promise(r => setTimeout(r, 100)); }
      }
      log(`postgres: ${PG_IMAGE} on ${port}`);
    } else if (!adminUrl) {
      const data = join(home, 'pg'), port = await freePort();
      execFileSync(pgBin('initdb'), ['-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8', '-D', data], { stdio: 'ignore' });
      execFileSync(pgBin('pg_ctl'), ['-D', data, '-o', `-h 127.0.0.1 -p ${port} -k ${home} ${fast.join(' ')}`, '-l', join(home, 'postgres.log'), '-w', 'start'], { stdio: 'ignore' });
      cleanups.push(() => execFileSync(pgBin('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }));
      adminUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
      log(`postgres: temporary cluster on ${port}`);
    }
    // A non-superuser owner, as the acceptance fixture runs the API.
    const name = 'cls_' + randomBytes(5).toString('hex'), password = randomBytes(18).toString('hex');
    const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
    await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER PASSWORD '${password}'`);
    await admin.query(`CREATE DATABASE ${name} OWNER ${name}`);
    await admin.query(`ALTER ROLE ${name} SET jit = off`);
    cleanups.push(async () => { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.query(`DROP ROLE IF EXISTS ${name}`); await admin.end(); });
    const url = new URL(adminUrl); url.username = name; url.password = password; url.pathname = '/' + name;

    const secret = randomBytes(36).toString('hex');
    const envFor = (port, publicOrigin = `http://127.0.0.1:${port}`) => ({
      PATH: process.env.PATH, HOME: home, DATABASE_URL: url.href, PUBLIC_URL: publicOrigin, API_BASE_URL: publicOrigin, HOST: '127.0.0.1', PORT: String(port),
      MULTI_TENANT: 'true', ACCOUNT_REQUIRED_ACR: 'urn:anomaly:acr:google', API_RATE_LIMIT_PER_MINUTE: '100000',
      // Built-in domains (api/src/builtin-domain.ts): the workspaces seeded with one below show it in onboarding, Domains and Overview.
      NIGHTMAIL_BUILTIN_DOMAIN: 'nightmail.email',
      // Dana (an operator) may use staff UI notes; nobody else in the fixture can.
      UI_NOTES_SUBJECTS: 'https://account.anoma.ly user_dana', BANE_HOSTED_SCREEN: 'false', NIGHTMAIL_HYGIENE_LISTS: 'off', NIGHTMAIL_HYGIENE_DNS: 'off', ENABLE_LIVE_SES: 'false', AWS_EC2_METADATA_DISABLED: 'true',
      ACCOUNT_CLIENT_ID: 'fixture', ACCOUNT_CLIENT_PRIVATE_KEY: 'unused-in-session-fixture', BANE_ROOT_SECRET: secret,
      WEBHOOK_ALLOWED_HOSTS: 'northwind.example', S3_ACCESS_KEY_ID: 'fixture', S3_SECRET_ACCESS_KEY: 'fixture', S3_BUCKET: 'fixture', S3_ENDPOINT: 'http://127.0.0.1:9',
      SIMULATED_SES_LATENCY_MS: '0', SIMULATED_SES_DELIVERY_DELAY_MS: '0',
      // A mail gateway, as both stages have: the dashboard then shows IMAP and SMTP settings and offers SMTP logins.
      MAILGW_API_TOKEN: randomBytes(24).toString('hex'), MAILGW_PUBLIC_DOMAIN: 'northwind.example',
      // Bring your own AWS (regional): the hosted connections' account is the platform's, as in production.
      BANE_PLATFORM_AWS_ACCOUNT: '111122223333', BANE_BYO_V2: 'true', BYO_V5_TEMPLATE_URL: 'https://nightmail-byo-templates-111122223333.s3.us-east-2.amazonaws.com/byo/6.0.yaml', BYO_EVENTS_ORIGIN: 'https://events.nightmail.dev',
      // The link domain, as production has it (own link hosts off): no link record on any domain's page.
      NIGHTMAIL_LINK_HOST: 'links.edge.northwind.example',
    });
    execFileSync('node', ['--import', 'tsx', 'src/migrate.ts'], { cwd: api, env: envFor(0), stdio: ['ignore', 'ignore', 'inherit'] });
    log('postgres: migrated');

    // The Node API serves api/public: point it at the build without copying it into the tree.
    const pub = join(api, 'public');
    if (!existsSync(join(repo, 'app/dist/index.html'))) throw new Error('CLS gate: build the dashboard first (bun run build in app/).');
    if (existsSync(pub) || (() => { try { return lstatSync(pub).isSymbolicLink(); } catch { return false; } })()) {
      if (!lstatSync(pub).isSymbolicLink()) throw new Error(`CLS gate: ${pub} exists; remove it so the gate can serve app/dist.`);
      rmSync(pub);
    }
    symlinkSync(join(repo, 'app/dist'), pub, 'dir');
    cleanups.push(() => rmSync(pub, { force: true }));

    // Shaper servers in front of the API: they apply the gate's per-route API delay, serve web fonts from memory
    // (or after fontDelay for CLS_FONTS=late) and cache immutable /assets/* responses across runs, so the browser needs
    // no CDP Fetch interception (context.route) and one or two API processes stay well inside the 6000/min peer budget.
    const fontDir = join(repo, 'app/dist/fonts');
    const fonts = new Map(readdirSync(fontDir).filter(f => f.endsWith('.woff2')).map(f => [f, readFileSync(join(fontDir, f))]));
    const assetCache = new Map(), links = new Map();
    const bulk = new Agent({ keepAlive: true, maxSockets: 128 });
    // Twenty browser jobs share Dana's workspace. Admit ordinary API calls per origin within the real read pool's
    // two active + four waiting slots; do not retry or ignore a 429. Assets and the live rule poll have their own lane.
    const reads = new Agent({ keepAlive: true, maxSockets: 6 });
    cleanups.push(() => { reads.destroy(); bulk.destroy(); });
    let serverLog = '';
    const serve = async () => {
      const apiPort = await freePort(), proxyPort = await freePort();
      const apiOrigin = `http://127.0.0.1:${apiPort}`, origin = `http://127.0.0.1:${proxyPort}`;
      const server = spawn('node', ['--import', 'tsx', 'src/server.ts'], { cwd: api, env: envFor(apiPort, origin), stdio: ['ignore', 'ignore', 'pipe'] });
      server.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-20_000); });
      const exited = new Promise(resolve => server.once('exit', code => resolve(code)));
      cleanups.push(async () => { server.kill(); await exited; });
      // Ready once the lazily imported auth router rejects an anonymous /v1/me.
      for (let ready = false; !ready;) {
        if (server.exitCode !== null) throw new Error(`CLS gate: the API exited (${server.exitCode}).\n${serverLog}`);
        ready = await fetch(apiOrigin + '/v1/me').then(r => r.status === 401, () => false);
        if (!ready) await Promise.race([exited, new Promise(r => setTimeout(r, 100))]);
      }
      const proxy = createHttpServer(async (req, res) => {
        const rawUrl = req.url || '/', q = rawUrl.indexOf('?'), pathname = q === -1 ? rawUrl : rawUrl.slice(0, q);
        const agent = pathname.startsWith('/v1/') && pathname !== '/v1/rules/version' ? reads : bulk;
        const page = req.headers['x-cls-page'];
        delete req.headers['x-cls-page'];
        // Fonts skip the page's network unless they are meant to arrive late (CLS_FONTS=late).
        if (page && throttle && (fontDelay > 0 || !pathname.startsWith('/fonts/'))) {
          (links.get(page) ?? links.set(page, pageLink(throttle)).get(page))(res, performance.now());
        }
        const sleep = ms => new Promise(done => { const t = setTimeout(done, ms); res.once('close', () => { clearTimeout(t); done(); }); });
        if (pathname.startsWith('/fonts/')) {
          if (fontDelay > 0) { await sleep(fontDelay); if (res.destroyed || res.writableEnded) return; }
          else {
            const buf = fonts.get(basename(pathname));
            if (buf) {
              res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable', 'content-length': String(buf.length) });
              res.end(req.method === 'HEAD' ? undefined : buf);
              return;
            }
          }
        }
        if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/assets/')) {
          const accept = String(req.headers['accept-encoding'] ?? '');
          const enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : 'raw';
          const key = `${enc}:${pathname}`;
          let entry = assetCache.get(key);
          if (!entry) {
            entry = new Promise(resolve => {
              const up = httpRequest({ hostname: '127.0.0.1', port: apiPort, method: 'GET', path: rawUrl, headers: enc === 'raw' ? {} : { 'accept-encoding': enc }, agent }, upRes => {
                const chunks = [];
                upRes.on('data', chunk => chunks.push(chunk));
                upRes.on('end', () => {
                  const body = Buffer.concat(chunks);
                  const ok = upRes.statusCode === 200 && String(upRes.headers['cache-control'] ?? '').includes('immutable');
                  if (!ok) { assetCache.delete(key); resolve(null); return; }
                  const headers = { ...upRes.headers, 'content-length': String(body.length) };
                  delete headers.connection; delete headers['keep-alive']; delete headers['transfer-encoding'];
                  resolve({ status: 200, headers, body });
                });
                upRes.on('error', () => { assetCache.delete(key); resolve(null); });
              });
              up.on('error', () => { assetCache.delete(key); resolve(null); });
              up.end();
            });
            assetCache.set(key, entry);
          }
          const cached = await entry;
          if (res.destroyed || res.writableEnded) return;
          if (cached) { res.writeHead(cached.status, cached.headers); res.end(req.method === 'HEAD' ? undefined : cached.body); return; }
        }
        if (pathname.startsWith('/v1/') && delay) { await sleep(delay(rawUrl)); if (res.destroyed || res.writableEnded) return; }
        // Onboarding starts Hosted mail by itself, which simulated SES refuses (SES_NOT_CONFIGURED): stand in for the
        // shared pool with the connection the seed gives every hosted workspace, and answer as the API would.
        let body = null;
        if (req.method === 'POST' && pathname === '/v1/connection') {
          body = Buffer.concat(await Array.fromAsync(req));
          let kind = null; try { kind = JSON.parse(body.toString()).kind; } catch { /* forwarded as is */ }
          if (kind === 'shared') {
            const headers = { cookie: req.headers.cookie ?? '', origin: req.headers.origin ?? origin, ...req.headers['x-nightmail-workspace'] ? { 'x-nightmail-workspace': req.headers['x-nightmail-workspace'] } : {} };
            const me = await fetch(apiOrigin + '/v1/me', { headers }).then(r => r.ok ? r.json() : null, () => null);
            if (me?.multiTenant) {
              const conn = await hosted(db, me.workspaceId);
              // Starting Hosted mail sets up the workspace's built-in domain too (startHostedMail): the first email sends from it.
              // Pages measured at once (light, dark, phone) start it together: whichever comes second finds it made.
              if (!(await db.query('SELECT 1 FROM builtin_domains WHERE workspace_id=$1', [me.workspaceId])).rowCount) await builtin(db, me.workspaceId, conn, me.workspaceId.replace(/[^a-z0-9]/g, '').slice(0, 16) + '-e5').catch(() => {});
              const read = await fetch(apiOrigin + '/v1/connection', { headers }), json = await read.json();
              res.writeHead(read.ok ? 201 : read.status, { 'content-type': 'application/json' });
              res.end(JSON.stringify(read.ok ? json.connection : json));
              return;
            }
          }
        }
        // A kept-alive socket the API closed for idling (Node's 5 s keepAliveTimeout) just as it was reused resets
        // before any response: a GET or HEAD has no body to lose, so it goes again once on a fresh socket. Without this
        // the page saw an empty response (ERR_EMPTY_RESPONSE), now and then, on whichever load drew that socket.
        const forward = fresh => {
          const up = httpRequest({ hostname: '127.0.0.1', port: apiPort, method: req.method, path: rawUrl, headers: req.headers, agent: fresh ? false : agent }, upRes => {
            answered = true;
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            if (req.method === 'HEAD') { upRes.resume(); res.end(); return; }
            upRes.pipe(res);
          });
          up.on('error', error => {
            if (!fresh && bodyless && up.reusedSocket && error.code === 'ECONNRESET' && !answered && !res.destroyed) { forward(true); return; }
            if (!res.headersSent) res.writeHead(502); res.destroy();
          });
          res.on('close', () => { if (!res.writableEnded) up.destroy(); });
          if (bodyless) up.end();
          return up;
        };
        const bodyless = req.method === 'GET' || req.method === 'HEAD';
        let answered = false;
        const up = forward(false);
        req.on('error', () => up.destroy());
        if (body) up.end(body); else if (!bodyless) req.pipe(up);
      });
      await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxyPort, '127.0.0.1', resolve); });
      cleanups.push(async () => { proxy.closeAllConnections(); await new Promise(r => proxy.close(r)); });
      return { origin, apiOrigin };
    };
    const started = await Promise.all(Array.from({ length: Math.max(1, servers) }, serve));
    const origins = started.map(s => s.origin), origin = origins[0], apiOrigin = started[0].apiOrigin;
    log(`api: ${origins.join(' ')}`);

    const db = new pg.Client({ connectionString: url.href }); await db.connect();
    cleanups.push(() => db.end());
    const sessions = {};
    // One signed-in member per workspace, inserted as the acceptance suite seeds sessions.
    async function signIn(key, email, fullName, workspace) {
      const token = randomBytes(32).toString('base64url'), userId = 'user_' + key;
      await db.query('INSERT INTO nightmail_users(id,name,email,email_verified) VALUES($1,$2,$3,true)',[userId,fullName,email]);
      await db.query("INSERT INTO nightmail_oidc_identities VALUES('https://account.anoma.ly',$1,$1)",[userId]);
      await db.query('INSERT INTO workspaces (id,name,slug) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING', [workspace.id, workspace.name]);
      await db.query('INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES ($1,$2,$3,$4)', ['wm_' + key, workspace.id, userId, workspace.role ?? 'owner']);
      await db.query("INSERT INTO nightmail_sessions(token_hash,user_id,issuer,subject,expires_at) VALUES($1,$2,'https://account.anoma.ly',$2,now()+interval '2 hours')",[createHash('sha256').update(token).digest('hex'),userId]);
      const cookie = token;
      const call = async (method, path, body, status) => {
        const r = await fetch(apiOrigin + path, { method, headers: { origin, cookie: `nightmail.session_token=${encodeURIComponent(cookie)}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const text = await r.text();
        if (status ? r.status !== status : !r.ok) throw new Error(`CLS seed: ${method} ${path} → ${r.status} ${text.slice(0, 400)}`);
        return text ? JSON.parse(text) : null;
      };
      return (sessions[key] = { cookie, api: call });
    }
    return { origin, origins, apiOrigin, db, signIn, sessions, stop, serverLog: () => serverLog };
  } catch (error) { await stop(); throw error; }
}

// ---------------------------------------------------------------- synthetic data
// Northwind: an established hosted sender with sending history, receiving set up and audience content.
// Lumen Labs: a verified domain and nothing else (Overview's setup state). Field Notes: no connection (onboarding).
// Harbor Supply: restricted, so its pages carry the standing banner.
// Connections, domain claims, mail and inbox rows go in as SQL because there is no SES or mail store here.
const REGION = 'us-east-2';
const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
let counter = 0;
const rid = prefix => `${prefix}_${(++counter).toString(36).padStart(6, '0')}${randomBytes(4).toString('hex')}`;

async function hosted(db, workspaceId) {
  const conn = 'conn_' + workspaceId;
  await db.query("INSERT INTO provider_pool_regions(region,aws_account_id,sending_state,feedback_topic_arn) VALUES($1,'111122223333','ready',$2) ON CONFLICT DO NOTHING", [REGION, `arn:aws:sns:${REGION}:111122223333:bane-feedback`]);
  await db.query("INSERT INTO ses_installation_settings(workspace_id,installation_id,default_region,enabled_regions) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING", [workspaceId, 'install_' + workspaceId, REGION, JSON.stringify([REGION])]);
  await db.query("INSERT INTO provider_connections(id,workspace_id,kind,region,state,aws_account_id,tenant_state) VALUES($1,$2,'shared',$3,'ready','111122223333','ready') ON CONFLICT DO NOTHING", [conn, workspaceId, REGION]);
  await db.query("INSERT INTO provider_connection_regions(connection_id,region,sending_state,tenant_state) VALUES($1,$2,'ready','ready') ON CONFLICT (connection_id,region) DO UPDATE SET sending_state='ready',tenant_state='ready'", [conn, REGION]);
  return conn;
}

// A domain claim as the hosted DNS checks leave it; `receiving` turns on an active receiving host.
async function domain(db, workspaceId, conn, name, { receiving = false, mailFrom = false, dmarc = 'quarantine' } = {}) {
  const id = 'dom_' + name.replace(/\W/g, '_');
  const tokens = [0, 1, 2].map(i => `${name.replace(/\W/g, '').slice(0, 10)}${i}k7q2m9dkim`);
  const identity = { ses: { DkimAttributes: { Status: 'SUCCESS', SigningEnabled: true, SigningAttributesOrigin: 'AWS_SES', SigningHostedZone: 'dkim.amazonses.com', Tokens: tokens }, ...(mailFrom ? { MailFromAttributes: { MailFromDomain: 'bounce.' + name, MailFromDomainStatus: 'SUCCESS' } } : {}) }, proven: true, mx: null, note: null,
    dmarc: { status: dmarc, record: `v=DMARC1; p=${dmarc}`, source: name, adkim: 'r', aspf: 'r', checkedAt: Date.now(), recommend: false, alignedMailFrom: null } };
  await db.query("INSERT INTO domain_claims(workspace_id,name,connection_id,sending_state,receiving_state,receiving_host,identity,ever_proven) VALUES($1,$2,$3,'verified',$4,$5,$6::jsonb,true)",
    [workspaceId, name, conn, receiving ? 'active' : 'off', receiving ? name : null, JSON.stringify(identity)]);
  await db.query('INSERT INTO operation_domains(id,workspace_id,name,region) VALUES($1,$2,$3,$4)', [id, workspaceId, name, REGION]);
  if (!receiving) return { id };
  await db.query('UPDATE domain_claims SET receiving_proved_at=now(),receiving_identity_at=now() WHERE workspace_id=$1 AND name=$2', [workspaceId, name]);
  const mdom = 'mdom_' + name.replace(/\W/g, '_');
  const mx = { state: 'active', message: `MX for ${name} points to Amazon SES.`, providers: ['amazonses.com'], checkedAt: ago(12) };
  await db.query("INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,receiving_host,status,catch_all,enabled_at,mx,checked_at) VALUES($1,$2,$3,$4,$5,$4,'active','store',now()-interval '20 days',$6::jsonb,now()-interval '12 minutes')",
    [mdom, workspaceId, id, name, REGION, JSON.stringify(mx)]);
  return { id, mdom, host: name };
}

// A workspace's built-in domain as its Hosted connection leaves it (create_builtin_claim, migration 495): sending, receiving
// on its own name with no DNS of its own, and its default inbox's catch-all. `pending`: not associated with its tenant yet.
async function builtin(db, workspaceId, conn, label, { pending = false } = {}) {
  const name = `${label}.nightmail.email`, id = 'dom_builtin_' + workspaceId, mdom = 'mdom_builtin_' + workspaceId;
  await db.query('INSERT INTO builtin_domains(workspace_id,label,name) VALUES($1,$2,$3)', [workspaceId, label, name]);
  const identity = { builtin: true, proven: true, mx: null, note: null, ses: pending ? { VerificationStatus: 'PENDING' } : { VerificationStatus: 'SUCCESS', VerifiedForSendingStatus: true, DkimAttributes: { Status: 'SUCCESS', SigningEnabled: true, SigningAttributesOrigin: 'AWS_SES' } } };
  await db.query("INSERT INTO domain_claims(workspace_id,name,connection_id,sending_state,receiving_state,receiving_host,identity,receiving_proved_at,receiving_identity_at) VALUES($1,$2,$3,$5,'active',$2,$4::jsonb,now(),now())",
    [workspaceId, name, conn, JSON.stringify(identity), pending ? 'pending' : 'verified']);
  await db.query('INSERT INTO operation_domains(id,workspace_id,name,region) VALUES($1,$2,$3,$4)', [id, workspaceId, name, REGION]);
  await db.query("INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,receiving_host,status,catch_all,enabled_at) VALUES($1,$2,$3,$4,$5,$4,'active','store',now()-interval '1 day')", [mdom, workspaceId, id, name, REGION]);
  return { id, name };
}

// A domain added two hours ago whose records never went live, as the background DNS check (api/src/domain-setup.ts) left
// it: the TXT and one DKIM CNAME missing at Cloudflare. Its page and Overview show the setup banner.
// `correct`: its ownership is proven and every DKIM CNAME is in public DNS, but SES hasn't looked again yet.
// `noDns`: nobody serves DNS for it (a typo): every record missing and the check's noDns, so its page says to check the name.
// `wildcard`: a *.<domain> address record answers its DKIM names, so all three CNAMEs are missing and the banner names the wildcard.
// `parking`: Porkbun's parking default (* CNAME pixie.porkbun.com) answers them instead.
async function stuck(db, workspaceId, conn, name, { correct = false, noDns = false, wildcard = false, parking = false } = {}) {
  const id = 'dom_' + name.replace(/\W/g, '_'), tokens = [0, 1, 2].map(i => `${name.replace(/\W/g, '').slice(0, 10)}${i}p4w8v6dkim`);
  const identity = { ses: { VerificationStatus: 'PENDING', VerifiedForSendingStatus: false, DkimAttributes: { Status: 'PENDING', SigningEnabled: true, SigningAttributesOrigin: 'AWS_SES', SigningHostedZone: 'dkim.amazonses.com', Tokens: tokens } }, proven: correct, mx: null, note: null };
  const { rows: [{ token }] } = await db.query("INSERT INTO domain_claims(workspace_id,name,connection_id,sending_state,receiving_state,identity,ever_proven,created_at) VALUES($1,$2,$3,'pending','off',$4::jsonb,$5,now()-interval '2 hours') RETURNING token",
    [workspaceId, name, conn, JSON.stringify(identity), correct]);
  await db.query('INSERT INTO operation_domains(id,workspace_id,name,region) VALUES($1,$2,$3,$4)', [id, workspaceId, name, REGION]);
  const checkedAt = ago(6), seen = state => ({ state, values: [], checkedAt, ...(wildcard || parking) && state === 'missing' ? { wildcard: `*.${name}`, ...parking ? { parking: { owner: 'Porkbun', target: 'pixie.porkbun.com' } } : {} } : {} });
  const records = [...tokens.map((t, i) => ({ type: 'CNAME', name: `${t}._domainkey.${name}`, value: `${t}.dkim.amazonses.com`, publicDns: seen(noDns || wildcard || parking || (i === 2 && !correct) ? 'missing' : 'found') })),
    ...correct ? [] : [{ type: 'TXT', name: `_nightmail.${name}`, value: token, publicDns: seen('missing') }]];
  const host = noDns ? null : parking ? { name: 'Porkbun', zone: name, url: null } : { name: 'Cloudflare', zone: name, url: `https://dash.cloudflare.com/?to=/:account/${name}/dns/records` };
  await db.query('UPDATE domain_claims SET setup_check=$3::jsonb WHERE workspace_id=$1 AND name=$2', [workspaceId, name, JSON.stringify({ checkedAt, host, ...noDns ? { noDns: true } : {}, records })]);
  return { id };
}

const RECEIPT_TEXT = 'Northwind\n\nThanks for your order.\n\nOrder 4821 is confirmed and ships within two business days.\n\nWalnut desk organizer  $48.00\nShipping  $6.00\nTotal  $54.00\n\nView your order: https://northwind.example/orders/4821\n\nNorthwind, 120 Harbor Street, Portland, OR 97209';
const RECEIPT_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Your receipt</title></head><body style="margin:0;background:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#ffffff;border-radius:8px;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<tr><td style="padding:28px 32px 8px;font-size:15px;font-weight:bold;letter-spacing:.02em">Northwind</td></tr>
<tr><td style="padding:8px 32px 0"><h1 style="margin:0;font-size:22px;line-height:30px">Thanks for your order.</h1><p style="margin:8px 0 0;font-size:15px;line-height:22px;color:#52525b">Order 4821 is confirmed and ships within two business days.</p></td></tr>
<tr><td style="padding:24px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;line-height:22px">
<tr><td style="padding:10px 0;border-top:1px solid #e4e4e7">Walnut desk organizer</td><td align="right" style="padding:10px 0;border-top:1px solid #e4e4e7">$48.00</td></tr>
<tr><td style="padding:10px 0;border-top:1px solid #e4e4e7">Shipping</td><td align="right" style="padding:10px 0;border-top:1px solid #e4e4e7">$6.00</td></tr>
<tr><td style="padding:10px 0;border-top:1px solid #e4e4e7;font-weight:bold">Total</td><td align="right" style="padding:10px 0;border-top:1px solid #e4e4e7;font-weight:bold">$54.00</td></tr></table></td></tr>
<tr><td style="padding:24px 32px"><a href="https://northwind.example/orders/4821" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#18181b;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none">View your order</a></td></tr>
<tr><td style="padding:0 32px 28px;font-size:12px;line-height:18px;color:#71717a">Northwind, 120 Harbor Street, Portland, OR 97209</td></tr>
</table></td></tr></table></body></html>`;
const JUNK_SUBJECT = 'FINAL NOTICE: YOU ARE A WINNER!!!';
const JUNK_HTML = `<html><head><style>.wrap{display:flex;gap:12px}.hero{background:#fde047}</style></head><body>
<div class="wrap"><div class="hero"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN4KOsBAAMpAUf+vsNwAAAAAElFTkSuQmCC" width="600" height="420"></div></div>
<p style="font-size:1px;color:#ffffff">you are a winner you are a winner you are a winner you are a winner</p>
<p><a href="https://bit.ly/3claim">CLAIM YOUR PRIZE NOW</a> or <a href="http://203.0.113.7/claim">https://northwind.example/claim</a></p>
<form action="https://203.0.113.7/claim"><input type="text" name="card"><button>Claim</button></form>
</body></html>`;

// Hourly sending volume with a weekday rhythm from a fixed seed; bounces ~0.9%, complaints ~0.03%. Returns the newest.
async function mail(db, workspaceId, days) {
  const now = Date.now(), rows = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let h = days * 24; h >= 1; h--) {
    const at = new Date(now - h * 3600_000 - Math.floor(rnd() * 3000_000));
    const hour = at.getUTCHours(), dow = at.getUTCDay();
    const base = (dow === 0 || dow === 6 ? 9 : 22) * (0.35 + Math.sin(Math.PI * Math.max(0, Math.min(1, (hour - 6) / 16))));
    const n = Math.max(0, Math.round(base * (0.7 + rnd() * 0.6)));
    for (let i = 0; i < n; i++) {
      const r = rnd(), kind = rnd() < 0.78 ? 'transactional' : 'marketing';
      rows.push([rid('email'), new Date(at.getTime() - i * 13_000).toISOString(), r < 0.009 ? 'bounced' : r < 0.0093 ? 'complained' : 'delivered', kind]);
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const params = [], values = [];
    rows.slice(i, i + 500).forEach(([id, at, status, kind], j) => {
      params.push(id, at, status, JSON.stringify({ kind, region: REGION, subject: 'Your receipt', html: '<p>Thanks for your order.</p>', text: 'Thanks for your order.', attachments: [] }), status === 'delivered' ? 3 : status === 'bounced' ? 5 : 11);
      const b = j * 5;
      values.push(`($${b + 1},'${workspaceId}','${REGION}','fixture','receipts@mail.northwind.example','["customer@example.net"]','[]','[]','Your receipt',$${b + 4}::jsonb,false,$${b + 3},'provider-'||$${b + 1},$${b + 5},$${b + 2}::timestamptz)`);
    });
    await db.query(`INSERT INTO sending_emails (id, workspace_id, region, actor_key_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, snapshot, simulated, status, provider_id, event_outcomes, created_at) VALUES ${values.join(',')}`, params);
  }
  return rows.reduce((newest, row) => row[1] > newest[1] ? row : newest)[0];
}

// One received message per thread, with the summary rows address stats and thread lists read.
async function threads(db, workspaceId, box, list) {
  for (const { id = rid('msg'), subject, snippet, unread, minutes, from = ['Customer', 'customer@example.net'], files = 0 } of list) {
    const thread = rid('thr'), at = ago(minutes);
    await db.query('INSERT INTO mail_threads(id,workspace_id,subject,message_count,last_message_at) VALUES($1,$2,$3,1,$4)', [thread, workspaceId, subject, at]);
    await db.query(`INSERT INTO mail_messages(id,workspace_id,direction,thread_id,region,subject,from_address,from_name,"to",envelope_to,received_at,text,snippet,attachment_count,verdicts) VALUES($1,$2,'inbound',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$11,$12,'{"virus":"PASS","spam":"PASS"}')`,
      [id, workspaceId, thread, REGION, subject, from[1], from[0], JSON.stringify([{ name: null, address: box.address }]), JSON.stringify([box.address]), at, snippet, files]);
    // inbox_seq as delivery assigns it: agent inboxes list by it.
    await db.query("INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at,inbox_seq) VALUES($1,$2,$3,$4,'inbound',$5,$6,nextval(pg_get_serial_sequence('mailbox_events','seq')))", [box.id, id, workspaceId, thread, !unread, at]);
    await db.query('INSERT INTO mailbox_threads(mailbox_id,thread_id,workspace_id,subject,snippet,participants,message_count,unread_count,last_message_at,last_inbound_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,1,$7,$8,$8)',
      [box.id, thread, workspaceId, subject, snippet, JSON.stringify([{ name: from[0], address: from[1] }]), unread ? 1 : 0, at]);
  }
}
// One support conversation (Logs' thread counts, the detail pages' Thread section): Jordan writes in, support replies
// from its address (a mailbox reply, stored in the thread), Jordan answers, support answers that with an ordinary send
// whose In-Reply-To names it (no stored copy: it joined the thread, as sendEmail records it for a sender that can read
// the message, snapshot.threadId), and Jordan writes back with a file.
async function conversation(db, workspaceId, box) {
  const thread = rid('thr'), customer = { name: 'Jordan Lee', address: 'jordan.lee@example.net' }, support = { name: 'Northwind Support', address: box.address };
  const subject = 'What happened to my accounts?';
  const steps = [
    { out: false, minutes: 52, text: 'Hi, I logged in this morning and both of my accounts are gone from the dashboard. I didn’t delete anything. What happened to my accounts?\n\nJordan' },
    { out: 'mailbox', minutes: 44, text: 'Hi Jordan, sorry for the scare. Your accounts are safe: last night’s migration moved them under your new organization. Switch to Lee Studio in the top-left menu and you’ll find both.\n\nNorthwind Support' },
    { out: false, minutes: 31, text: 'Thanks, I can see one of them now, but the second one (with the 2023 invoices) still isn’t there.' },
    { out: 'header', minutes: 19, text: 'Found it: the second account was still linked to your old email address. I’ve moved it to Lee Studio, so it shows up after a refresh, with all of your 2023 invoices.\n\nNorthwind Support' },
    { out: false, minutes: 7, files: 1, text: 'It’s back, thank you! One invoice shows the wrong total though, screenshot attached.' },
  ];
  const stored = steps.filter(step => step.out !== 'header');
  await db.query('INSERT INTO mail_threads(id,workspace_id,subject,message_count,last_message_at) VALUES($1,$2,$3,$4,$5)', [thread, workspaceId, subject, stored.length, ago(7)]);
  const ids = { email: null, received: null, thread };
  let previous = null, references = [];
  for (const [i, step] of steps.entries()) {
    const at = ago(step.minutes), id = rid('msg'), subj = i ? `Re: ${subject}` : subject;
    const messageId = step.out ? `provider-accounts-${i + 1}@email.amazonses.com` : `accounts-${i + 1}.jordan@mail.example.org`;
    const from = step.out ? support : customer, to = step.out ? customer : support, snippet = step.text.replace(/\s+/g, ' ').slice(0, 140);
    let emailId = null;
    if (step.out) {
      emailId = rid('email');
      const paragraphs = step.text.split('\n\n').map(p => `<p style="margin:0 0 14px">${p}</p>`).join('');
      const quoted = steps[i - 1].text.split('\n\n').map(p => `<p style="margin:0 0 10px">${p}</p>`).join('');
      const html = `<!doctype html><html><body style="margin:0;background:#ffffff"><div style="max-width:600px;padding:28px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#18181b">${paragraphs}<div style="margin-top:22px;padding-left:14px;border-left:2px solid #d4d4d8;color:#71717a;font-size:14px;line-height:20px"><p style="margin:0 0 10px">Jordan Lee wrote:</p>${quoted}</div></div></body></html>`;
      const headers = [{ Name: 'In-Reply-To', Value: `<${previous}>` }, { Name: 'References', Value: references.map(r => `<${r}>`).join(' ') }];
      await db.query(`INSERT INTO sending_emails (id, workspace_id, region, actor_key_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, snapshot, simulated, status, provider_id, event_outcomes, created_at)
        VALUES ($1,$2,$3,'fixture',$4,$5::jsonb,'[]','[]',$6,$7::jsonb,false,'delivered',$8,3,$9)`,
        [emailId, workspaceId, REGION, support.address, JSON.stringify([customer.address]), subj, JSON.stringify({ kind: 'transactional', testCampaignId: null, region: REGION, subject: subj, fromName: support.name, html, text: step.text, attachments: [], headers, ...step.out === 'mailbox' ? { mailbox: true } : { threadId: thread } }), messageId.split('@')[0], at]);
      for (const [type, ms] of [['dispatch_attempt', 0], ['accepted', 400], ['delivery', 2300], ...step.out === 'header' ? [['open', 240_000]] : []])
        await db.query(`INSERT INTO sending_email_events(id,workspace_id,email_id,type,provider_id,external_id,data,simulated,created_at) SELECT $1,workspace_id,id,$2,provider_id,$1,jsonb_build_object('emailId',id,'providerId',provider_id),false,created_at + $3 * interval '1 millisecond' FROM sending_emails WHERE id=$4`, [rid('event'), type, ms, emailId]);
      if (step.out === 'header') ids.email = emailId;
    }
    if (step.out !== 'header') {
      await db.query(`INSERT INTO mail_messages(id,workspace_id,direction,thread_id,region,subject,from_address,from_name,"to",envelope_to,received_at,text,snippet,attachment_count,verdicts,status,sending_email_id,sender_mailbox_id,message_id,in_reply_to,"references")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,'{"virus":"PASS","spam":"PASS"}',$15,$16,$17,$18,$19,$20::jsonb)`,
        [id, workspaceId, step.out ? 'outbound' : 'inbound', thread, REGION, subj, from.address, from.name, JSON.stringify([to]), JSON.stringify([to.address]), at, step.text, snippet, step.files ?? 0,
          step.out ? 'delivered' : 'received', emailId, step.out ? box.id : null, messageId, previous, JSON.stringify(references)]);
      await db.query('INSERT INTO mail_message_ids(workspace_id,message_id,mail_message_id,thread_id) VALUES($1,$2,$3,$4)', [workspaceId, messageId, id, thread]);
      await db.query(`INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at,inbox_seq) VALUES($1,$2,$3,$4,$5,$6,$7,nextval(pg_get_serial_sequence('mailbox_events','seq')))`,
        [box.id, id, workspaceId, thread, step.out ? 'outbound' : 'inbound', i < steps.length - 1, at]);
      if (i === steps.length - 1) ids.received = id;
    }
    references = [...references, messageId]; previous = messageId;
  }
  await db.query('INSERT INTO mailbox_threads(mailbox_id,thread_id,workspace_id,subject,snippet,participants,message_count,unread_count,last_message_at,last_inbound_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,1,$8,$8)',
    [box.id, thread, workspaceId, subject, steps.at(-1).text.slice(0, 140), JSON.stringify([customer, support]), stored.length, ago(7)]);
  return ids;
}
const people = ['Ana Ruiz', 'Ben Cho', 'Cleo Park', 'Dev Shah', 'Eli Moss', 'Fay Lin', 'Gus Ito', 'Hana Ode'];
const subjects = [['Refund for order 4821', 'Hi, the blender arrived broken. I would like a refund.'], ['Can’t sign in', 'I reset my password twice and still get an error.'], ['Invoice INV-2209', 'Attached is the invoice for October.'],
  ['Partnership idea', 'We run a 40k-member community and would love to talk.'], ['Question about the API', 'Is there a limit on attachments per message?'], ['Re: Shipping delay', 'Thanks, that works for us.']];
const mix = (n, offset = 0) => Array.from({ length: n }, (_, i) => {
  const [subject, snippet] = subjects[(i + offset) % subjects.length], p = people[(i * 3 + offset) % people.length];
  return { subject, snippet, unread: i < Math.ceil(n / 3), minutes: 20 + i * 97 + offset * 13, from: [p, p.toLowerCase().replace(' ', '.') + '@example.net'] };
});

// Agent inboxes need the mail store on hosted, so they go in as the rows createInbox writes.
async function agentInbox(db, workspaceId, { mdom, host }, name, hoursLeft, messages) {
  const id = rid('mbx'), address = `${name.toLowerCase().replace(/\W+/g, '-')}@${host}`;
  await db.query(`INSERT INTO mailboxes(id,workspace_id,domain_id,address,display_name,kind,retention_mode,expires_at,delete_after,quota_messages,quota_bytes,created_at)
    VALUES($1,$2,$3,$4,$5,'inbox','ephemeral',now()+make_interval(hours=>$6),now()+make_interval(hours=>$6+24),200,26214400,now()-interval '2 hours')`, [id, workspaceId, mdom, address, name, hoursLeft]);
  await db.query("INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES($1,$2,$3,'primary')", [workspaceId, address, id]);
  await db.query('INSERT INTO inbox_state(inbox_id,workspace_id,messages) VALUES($1,$2,$3)', [id, workspaceId, messages.length]);
  await threads(db, workspaceId, { id, address }, messages);
  return id;
}

// Sender standing as the ten-minute standing job stores it (the gate runs no job worker), 14 published days of score
// and the standing events the operator timeline reads.
const factor = (key, label, weight, value, score) => ({ key, label, weight, value, score, points: score === null ? null : Math.round(weight * score) / 100, source: score === null ? 'neutral' : 'measured', basis: 'CLS fixture.' });
async function standing(db, workspaceId, { score, limit, step, reasons = [], since, factors, events = [] }) {
  await db.query(`INSERT INTO sender_standing(workspace_id,phase,first_recipients,calibrated_at,score,day_score,score_day,target,quality,factors,band_limit,daily_limit,step,reasons,since,computed_at,version,sequence)
    VALUES($1,'graded',100,now()-interval '20 days',$2,$2,(now() AT TIME ZONE 'UTC')::date,$2::numeric+1.5,$2::numeric+4,$3::jsonb,$4,$4,$5,$6::jsonb,$7,now(),$8::int,$8::int)
    ON CONFLICT (workspace_id) DO UPDATE SET phase=excluded.phase,first_recipients=100,calibrated_at=excluded.calibrated_at,score=excluded.score,target=excluded.target,quality=excluded.quality,factors=excluded.factors,
      band_limit=excluded.band_limit,daily_limit=excluded.daily_limit,step=excluded.step,reasons=excluded.reasons,since=excluded.since,computed_at=now(),version=excluded.version,sequence=excluded.sequence`,
    [workspaceId, score, JSON.stringify(factors), limit, step, JSON.stringify(reasons), since, events.length + 1]);
  await db.query(`INSERT INTO sender_score_daily(workspace_id,day,emails,accepted,delivered,bounced,complained,score,quality,target,daily_limit,step)
    SELECT $1,(now() AT TIME ZONE 'UTC')::date-g,300,296,292,3,0,round(($2::numeric-g*0.6),2),$2::numeric+4,$2::numeric+1.5,$3,'ok' FROM generate_series(1,14) g ON CONFLICT DO NOTHING`, [workspaceId, score, limit]);
  for (const [i, event] of events.entries()) await db.query(`INSERT INTO standing_events(id,workspace_id,sequence,at,kind,from_step,to_step,reasons,actor,details) VALUES($1,$2,$3,$4,'step',$5,$6,$7::jsonb,'{"kind":"system"}'::jsonb,'{}'::jsonb)`,
    [rid('stev'), workspaceId, i + 1, event.at, event.from, event.to, JSON.stringify(event.reasons ?? [])]);
}

// Billing, enforced: Northwind is funded (top-ups, a welcome credit, hourly usage, a saved card and auto-recharge on);
// Harbor owes $12.40 after its free allowance, so sending is paused and received mail is in its 7-day grace.
// A workspace's month as the settler leaves it: charged sends and received settled, and the cost posted for them.
const month = (db, wid, sent, received, costUc) => db.query(`INSERT INTO billing_months(workspace_id,month,sent,received,other_uc,posted_uc)
  VALUES ($1,(date_trunc('month',now() AT TIME ZONE 'UTC'))::date,$2,$3,$4::numeric-billing_month_cost((date_trunc('month',now() AT TIME ZONE 'UTC'))::date,$2,$3,0),$4::bigint)`, [wid, sent, received, String(costUc)]);
async function billing(db) {
  const post = (wid, kind, source, paid, promo = 0n, detail = {}, who = 'system') => db.query('SELECT billing_post($1,$2,$3,$4::bigint,$5::bigint,$6::jsonb,$7)', [wid, kind, source, String(paid), String(promo), JSON.stringify(detail), who]);
  const usage = (wid, i, send, receive, omen = 0) => {
    const from = new Date(Math.floor(Date.now() / 3600_000) * 3600_000 - (i + 2) * 3600_000), cost = BigInt(send + receive) * 20_000n + BigInt(omen) * 10_000n;
    return post(wid, 'usage', `usage:cls:${wid}:${i}`, -cost, 0n, { meters: { send: { quantity: send }, receive: { quantity: receive }, ...(omen ? { omen: { quantity: omen } } : {}) }, costUc: String(cost), charged: true, from: from.toISOString(), to: new Date(from.getTime() + 3600_000).toISOString() });
  };
  await db.query("UPDATE billing_config SET mode='enforce',enforced_at=now()");
  await post('ws_northwind', 'topup', 'attempt:bpa_cls_first', 5_000_000_000n, 0n, {}, 'stripe');
  await post('ws_northwind', 'grant', 'grant:cls-welcome', 0n, 1_000_000_000n, { reason: 'Welcome credit' }, 'operator:user_dana');
  for (const [i, [send, receive, omen]] of [[412, 38, 12], [1260, 75, 30], [96, 12, 0], [884, 41, 9], [57, 3, 0], [2210, 120, 44]].entries()) await usage('ws_northwind', i, send, receive, omen);
  await post('ws_northwind', 'topup', 'attempt:bpa_cls_recharge', 2_500_000_000n, 0n, { recharge: true }, 'stripe');
  await db.query(`UPDATE billing_accounts SET stripe_customer='cus_cls_northwind',stripe_payment_method='pm_cls_northwind',card_brand='visa',card_last4='4242',card_exp_month=4,card_exp_year=2028,card_fingerprint='fp_cls',
    recharge_enabled=true WHERE workspace_id='ws_northwind'`);
  // This month as settled (billing_months, migration 334): 1,640 free sends and 500 free received used, $1.04 so far.
  await month(db, 'ws_northwind', 1640, 500, 104_000_000n);
  // The hours' meters for the usage chart, settled. Sends the fixture created in those hours count there too.
  await db.query(`INSERT INTO billing_usage_hourly AS u (workspace_id,hour,meter,quantity,settled_quantity) SELECT 'ws_northwind',date_trunc('hour',now())-make_interval(hours=>g),m.meter,m.q,m.q
    FROM generate_series(2,7) g CROSS JOIN (VALUES ('send',820),('receive',48),('omen',16)) m(meter,q)
    ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity, settled_quantity=u.settled_quantity+excluded.settled_quantity`);
  await db.query("INSERT INTO mail_storage_aged(workspace_id,aged_bytes,aged_through) VALUES ('ws_northwind',214000000,(now() AT TIME ZONE 'UTC')::date-91)");
  await post('ws_harbor', 'topup', 'attempt:bpa_cls_harbor', 2_000_000_000n, 0n, {}, 'stripe');
  await usage('ws_harbor', 0, 158_000, 4000);
  await db.query(`UPDATE billing_accounts SET unpaid_since=now()-interval '2 days',empty_since=now()-interval '2 days' WHERE workspace_id='ws_harbor'`);
  await month(db, 'ws_harbor', 5000, 5000, 3_240_000_000n);
}

// The support inbox (/support): Sam's ticketed chat that Dana answered (agent paused) and a sender who proved nothing
// with blocked work need staff; Lee's emailed question and Lee's chat the agent is answering on its own; and a closed,
// resolved chat. The agent keeps two notes about Sam. The support platform pulled the outbox a minute ago, so staff can
// reply. IDs follow the support platform's shapes (conv_, msg_, tkt_, snt_).
const supportId = (prefix, word, length) => `${prefix}_${word.padEnd(length, 'a')}`;
async function supportInbox(db, webhookId) {
  const conv = word => supportId('conv', word, 26), msg = word => supportId('msg', word, 16);
  const chat = conv('samdkimchat'), email = conv('leebouncemail'), stranger = conv('strangermail'), closed = conv('samclosedchat'), keys = conv('leekeyschat');
  await db.query(`INSERT INTO support_conversations(id,channel,thread_id,user_id,pending_address,verification,evidence,mode,workspace_id,status,subject,ticket_id,ticket_type,ticket_severity,
      ticket_resolved_at,ticket_resolved_by,agent_state,paused_by,paused_at,last_message_at,messages,turns,cost_usd,blocked_work,created_at,closed_at) VALUES
    ($1,'chat',NULL,'user_sam',NULL,'handoff','{"handoff":"sho_00000000000000000000000000000001"}','member','ws_northwind','ticketed','DKIM will not verify for mail.northwind.example',$5,'bug','P2',
      NULL,NULL,'paused','user_dana',now()-interval '12 minutes',now()-interval '4 minutes',4,3,0.1840,0,now()-interval '40 minutes',NULL),
    ($2,'email','thr_cls_lee','user_lee','lee@northwind.example','dmarc','{"message":"msg_00000000000000000000000000000002","dmarc":"PASS","dkimAligned":true}','member',NULL,'open','Why did my test email bounce?',NULL,NULL,NULL,
      NULL,NULL,'active',NULL,NULL,now()-interval '25 minutes',2,1,0.0610,0,now()-interval '30 minutes',NULL),
    ($3,'email','thr_cls_stranger',NULL,'someone@example.org','none','{"message":"msg_00000000000000000000000000000003","dmarc":"FAIL","dkimAligned":false}','unverified',NULL,'open','Account access',NULL,NULL,NULL,
      NULL,NULL,'active',NULL,NULL,now()-interval '2 hours',1,0,0,1,now()-interval '2 hours',NULL),
    ($4,'chat',NULL,'user_sam',NULL,'handoff','{"handoff":"sho_00000000000000000000000000000004"}','member','ws_northwind','closed','Raise the daily limit',$6,'account','P3',
      now()-interval '2 days','user_dana','active',NULL,NULL,now()-interval '3 days',2,2,0.0920,0,now()-interval '3 days',now()-interval '2 days'),
    ($7,'chat',NULL,'user_lee',NULL,'handoff','{"handoff":"sho_00000000000000000000000000000007"}','member','ws_northwind','open',NULL,NULL,NULL,NULL,
      NULL,NULL,'active',NULL,NULL,now()-interval '6 minutes',2,1,0.0410,0,now()-interval '8 minutes',NULL)`,
    [chat, email, stranger, closed, supportId('tkt', 'samdkim', 16), supportId('tkt', 'samlimit', 16), keys]);
  await db.query(`UPDATE support_conversations SET ticket_at = created_at + interval '2 minutes' WHERE ticket_id IS NOT NULL AND id = ANY($1)`, [[chat, closed]]);
  const line = (id, conversation, seq, author, text, minutes, extra = {}) => db.query(`INSERT INTO support_messages(id,conversation_id,seq,author,kind,text,tools,staff_user_id,delivery,delivered_at,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,CASE WHEN $9 = 'sent' AND $4 = 'staff' THEN now()-make_interval(mins=>$10) END,now()-make_interval(mins=>$10))`,
    [id, conversation, seq, author, extra.kind ?? null, text, JSON.stringify(extra.tools ?? []), extra.staff ?? null, extra.delivery ?? null, minutes]);
  await line(msg('samone'), chat, 1, 'customer', 'DKIM for mail.northwind.example has said pending since yesterday.', 40);
  await line(msg('samtwo'), chat, 2, 'agent', 'Two of the three DKIM records are published. The third, **s3._domainkey**, is missing from your DNS. Add it as a CNAME and verification finishes within the hour.', 39,
    { kind: 'reply', tools: [{ label: 'Read your domains', ok: true }, { label: 'Checked DNS for mail.northwind.example', ok: true }], delivery: 'sent' });
  await line(msg('samthree'), chat, 3, 'staff', 'I added a note to your ticket. Our DNS check also ran against an old resolver; I re-ran it and it should turn green shortly.', 12, { kind: 'reply', staff: 'user_dana', delivery: 'sent' });
  await line(msg('samfour'), chat, 4, 'customer', 'Still pending here. Is there anything else I should change?', 4);
  await line(msg('leeone'), email, 1, 'customer', 'My test email to a Gmail address bounced with 550 5.7.26. What does that mean?', 30);
  await line(msg('leetwo'), email, 2, 'agent', 'Gmail refused it because the From domain had no DMARC record at the time. Your domain has one now, so the next send should be accepted.', 25,
    { kind: 'reply', tools: [{ label: 'Read the bounce', ok: true }], delivery: 'sent' });
  await line(msg('strangerone'), stranger, 1, 'customer', 'I can’t sign in to my account. Please reset it for this address.', 120);
  await line(msg('closedone'), closed, 1, 'customer', 'Can we send 20,000 a day starting next week?', 4320);
  await line(msg('closedtwo'), closed, 2, 'agent', 'I filed this as a limit request; the team replies within two business days.', 4319, { kind: 'reply', delivery: 'sent' });
  await line(msg('keysone'), keys, 1, 'customer', 'How do I rotate the Production API key without downtime?', 8);
  await line(msg('keystwo'), keys, 2, 'agent', 'Create a second key with the same access, deploy it, then revoke the old one from **API keys**.', 6,
    { kind: 'reply', tools: [{ label: 'Read your API keys', ok: true }], delivery: 'sent' });
  const note = (word, conversation, text, minutes) => db.query(`INSERT INTO support_notes(id,user_id,workspace_id,conversation_id,author,text,created_at) VALUES ($1,'user_sam','ws_northwind',$2,'agent',$3,now()-make_interval(mins=>$4))`,
    ['snt_' + Buffer.from(word).toString('hex').padEnd(32, '0'), conversation, text, minutes]);
  await note('samdns', chat, 'DNS for northwind.example is managed by their agency; changes take a day.', 38);
  await note('samlimit', closed, 'Asked for 20,000 a day for a product launch.', 4318);
  await db.query("INSERT INTO support_outbox_polls(id,polled_at) VALUES (1,now()-interval '1 minute') ON CONFLICT (id) DO UPDATE SET polled_at=excluded.polled_at");
  // A change support proposed to Dana in her own (now closed) chat: a test event to her delivery webhook, which she
  // confirms in the dialog its emailed link opens (/support/actions/<id>). Nightmail's sentence, as the API writes it.
  const danaChat = conv('danawebhookchat'), action = 'sac_' + createHash('sha256').update('cls-support-action').digest('hex').slice(0, 32);
  await db.query(`INSERT INTO support_conversations(id,channel,user_id,verification,evidence,mode,workspace_id,status,subject,agent_state,last_message_at,messages,turns,cost_usd,created_at,closed_at)
    VALUES ($1,'chat','user_dana','handoff','{"handoff":"sho_00000000000000000000000000000009"}','member','ws_northwind','closed','Webhook deliveries failing','active',now()-interval '50 minutes',2,1,0.0390,
      now()-interval '1 hour',now()-interval '20 minutes')`, [danaChat]);
  const parts = { template: 'Send a test email.delivered event to your sending webhook {webhook} at {site}, in the workspace {workspace}. No email is sent.', labels: { webhook: 'Delivery events', site: 'northwind.example', workspace: 'Northwind' } };
  await db.query(`INSERT INTO support_actions(id,conversation_id,user_id,workspace_id,kind,target,summary,parts,created_at,expires_at)
    VALUES ($1,$2,'user_dana','ws_northwind','test_webhook',$3,$4,$5,now()-interval '45 minutes',now()+interval '23 hours 15 minutes')`,
    [action, danaChat, JSON.stringify({ webhookId }), parts.template.replace(/\{([a-z]+)\}/g, (_, name) => JSON.stringify(parts.labels[name])), JSON.stringify(parts)]);
  return { conversation: chat, action };
}

/** Driftwood's triage rule, version `n`: each agent save in a live job changes one line in place, so the line count
 *  (and the editor's height) stays the same. A longer script grows the editor, which is the content changing. */
export const liveSource = n => `export default function route(email, ctx) {\n  if (email.headers.has("list-unsubscribe")) return junk("newsletter")\n  label(${JSON.stringify(n ? `refund-${n}` : 'support')})\n  endpoints.support({ text: \`\${email.from.address}: \${email.subject}\` })\n}\n`;

// A workspace connecting its own AWS account (regional, role template 6.0), at one moment of setup: the stack link
// (stack), the stack refused for the wrong account (refused), the account being checked (checking), domains to choose
// with Ohio granted and Virginia in the sandbox (choose), Ohio in the sandbox (sandbox), Ohio being set up (setup), or
// sending from Ohio with a health finding (ready: Settings → Sending and the banner), or disconnecting, its cleanup
// part done (disconnecting).
const BYO_REGIONS = ['us-east-2','us-east-1','us-west-1','us-west-2','af-south-1','ap-south-1','ap-south-2','ap-southeast-1','ap-southeast-2','ap-southeast-3','ap-southeast-4','ap-southeast-5','ap-southeast-6','ap-southeast-7','ap-northeast-1','ap-northeast-2','ap-northeast-3','ca-central-1','ca-west-1','eu-central-1','eu-central-2','eu-west-1','eu-west-2','eu-west-3','eu-south-1','eu-south-2','eu-north-1','il-central-1','mx-central-1','me-south-1','me-central-1','sa-east-1'];
async function connectedAccount(fx, db, key, name, phase) {
  const id = 'ws_aws_' + key, slug = name.toLowerCase();
  await fx.signIn(key, `${key}@${slug}.example`, `${name} Owner`, { id, name });
  await db.query('UPDATE workspaces SET byo_v2_enabled=true WHERE id=$1', [id]);
  const conn = 'conn_' + createHash('sha256').update(id).digest('hex').slice(0, 32), stack = 'Nightmail-' + conn.slice(-20), account = '44445555' + String(['refused', 'checking', 'choose', 'sandbox', 'setup', 'ready', 'disconnecting'].indexOf(phase) + 1).padStart(4, '0');
  const prefix = 'nightmail-' + createHash('sha256').update(conn).digest('hex').slice(0, 20), bound = !['stack', 'refused'].includes(phase);
  await db.query(`INSERT INTO provider_connections(id,workspace_id,kind,region,state,tenant_state,external_id,platform_principal_arn,template_version,resource_prefix,requested_account,inventory_revision,stack_name,aws_account_id,role_arn,stack_id,stack_template_version,stack_error)
    VALUES($1,$2,'byo','us-east-2',$3,'ready',gen_random_uuid(),'arn:aws:iam::111122223333:role/nightmail-byo-broker','v5',$4,$5,1,$6,$7,$8,$9,$10,$11)`,
    [conn, id, bound ? (phase === 'checking' ? 'scanning' : phase === 'ready' || phase === 'disconnecting' ? phase : 'ready_to_import') : 'awaiting_role', prefix, phase === 'refused' ? account : bound ? account : null, stack, bound ? account : null, bound ? `arn:aws:iam::${account}:role/${stack}` : null,
      bound ? `arn:aws:cloudformation:us-east-2:${account}:stack/${stack}/0e9b1f40-1111-4000-8000-000000000000` : null, bound ? '6.0' : null,
      phase === 'refused' ? `You chose AWS account ${account} in Nightmail, but this stack is in 777788889999. Sign in to ${account}, or start again from Connect AWS.` : null]);
  if (!bound) return;
  const facts = region => ({ production: region === 'us-east-2' ? phase !== 'sandbox' : region !== 'us-east-1', review: null, enforcement: 'HEALTHY', sendingEnabled: true, max24HourSend: region === 'us-east-2' ? 50000 : 200, maxSendRate: 14, sentLast24Hours: 0, configurationSets: {}, receiving: { supported: true, set: null, rules: [] } });
  for (const [i, region] of BYO_REGIONS.entries()) {
    const scanning = phase === 'checking' && i >= 12, setup = phase === 'setup' && region === 'us-east-2', ready = phase === 'ready' && region === 'us-east-2', fenced = phase === 'disconnecting' && region === 'us-east-2';
    await db.query(`INSERT INTO provider_connection_regions(connection_id,region,managed_tenant,tenant_state,scan_revision,scan_state,scan_facts,sending_state) VALUES($1,$2,false,'ready',1,$3,$4,$5)`,
      [conn, region, scanning ? 'scanning' : 'ready_to_import', JSON.stringify(scanning ? {} : facts(region)), setup ? 'provisioning' : ready ? 'ready' : fenced ? 'disabled' : 'unprovisioned']);
  }
  const verified = { VerificationStatus: 'SUCCESS', VerifiedForSendingStatus: true, DkimAttributes: { SigningEnabled: true, Status: 'SUCCESS', SigningAttributesOrigin: 'AWS_SES' } };
  for (const [region, domain, identity] of [['us-east-2', `mail.${slug}.example`, verified], ['us-east-2', `${slug}.example`, verified], ['us-east-2', `old.${slug}.example`, { ...verified, VerificationStatus: 'FAILED', VerifiedForSendingStatus: false }], ['us-east-1', `news.${slug}.example`, verified]])
    await db.query('INSERT INTO byo_candidates VALUES($1,$2,$3,1,$4)', [conn, region, domain, JSON.stringify(identity)]);
  if (phase === 'ready') {
    await db.query("INSERT INTO ses_installation_settings(workspace_id,installation_id,default_region,enabled_regions) VALUES($1,$2,'us-east-2','[\"us-east-2\"]'::jsonb)", [id, conn]);
    await db.query('UPDATE provider_connections SET health=$2 WHERE id=$1', [conn, JSON.stringify({ checkedAt: ago(20), issues: [{ code: 'SENDING_PAUSED', region: 'us-east-2', message: 'AWS paused sending for this account in Ohio. Check the SES console.' }] })]);
    await domain(db, id, conn, `mail.${slug}.example`);
  }
  if (phase === 'disconnecting') {
    const kept = `mail.${slug}.example`, tokens = ['k3x7c2', 'p9w4m1', 'r5t8z6'].map(t => t.repeat(5) + 'ab');
    await db.query(`UPDATE provider_connection_regions SET ownership_journal=$2::jsonb WHERE connection_id=$1 AND region='us-east-2'`, [conn, JSON.stringify([{ kind: 'set', resource: `arn:aws:ses:us-east-2:${account}:configuration-set/${prefix}-transactional`, state: 'created' }])]);
    await db.query('UPDATE provider_connections SET disconnect_summary=$2 WHERE id=$1', [conn, JSON.stringify({ leftBehind: [], stack: { name: stack, consoleUrl: `https://us-east-2.console.aws.amazon.com/cloudformation/home?region=us-east-2#/stacks/stackinfo?stackId=${encodeURIComponent(`arn:aws:cloudformation:us-east-2:${account}:stack/${stack}/0e9b1f40-1111-4000-8000-000000000000`)}` },
      retained: [{ domain: kept, region: 'us-east-2', regionLabel: 'Ohio', createdByNightmail: true, records: [...tokens.map(t => ({ type: 'CNAME', name: `${t}._domainkey.${kept}`, value: `${t}.dkim.amazonses.com` })), { type: 'MX', name: `bounce.${kept}`, value: 'feedback-smtp.us-east-2.amazonses.com', priority: 10 }, { type: 'TXT', name: `bounce.${kept}`, value: 'v=spf1 include:amazonses.com ~all' }] },
        { domain: `${slug}.example`, region: 'us-east-2', regionLabel: 'Ohio', createdByNightmail: false, records: [] }] })]);
  }
  if (phase === 'setup') await db.query("INSERT INTO byo_domain_intents(connection_id,region,name,importing,id) VALUES($1,'us-east-2',$2,true,$3)", [conn, `mail.${slug}.example`, 'dom_' + conn.slice(5)]);
}

// Newsletters (features/newsletters): a list with a sender, made through the API. Its readers go in as SQL like the rest
// of the audience here, joined over the last two years. A sent issue is a campaign made through the API, then marked
// done with the count its background job stores (the fixture runs no job worker and sends nothing); those of Tide
// Notes are frozen, as a count is once its emails have left the 30-day history, so listing them queues nothing.
async function newsletterReaders(db, workspaceId, listId, count, host = 'example.net') {
  await db.query(`INSERT INTO audience_contacts(id,workspace_id,email,name,marketing_consent,created_at,updated_at)
    SELECT 'contact_nl_'||$2||'_'||g, $1, lower(f.n)||'.'||lower(l.n)||g||'@'||$4, f.n||' '||l.n, 'subscribed', now()-make_interval(days=>CASE WHEN g%61=0 THEN 37+g%3 WHEN g%83=0 THEN 121+g%2 ELSE ((g*7919)%1000)*720/1000 END), now()
    FROM generate_series(1,$3) g
    JOIN LATERAL (SELECT (ARRAY['Ada','Grace','Linus','Margaret','Ken','Barbara','Edsger','Radia','Alan','Frances','Dennis','Adele','Tim','Hedy','Guido','Sophie','Niklaus'])[1+g%17] AS n) f ON true
    JOIN LATERAL (SELECT (ARRAY['Okafor','Lind','Moreau','Park','Rivera','Quinn','Brandt','Sato','Mensah','Alvarez','Field','Moana','Bell','Ortiz','Shah','Chen','Nair','Wren','Holt'])[1+(g*7)%19] AS n) l ON true`, [workspaceId, listId, count, host]);
  await db.query(`INSERT INTO audience_list_members(workspace_id,list_id,contact_id,created_at) SELECT workspace_id,$2,id,created_at FROM audience_contacts WHERE workspace_id=$1 AND id LIKE 'contact_nl_'||$2||'_%'`, [workspaceId, listId]);
}
const issueHtml = (title, paragraphs) => `<h1>${title}</h1>${paragraphs.map(p => `<p>${p}</p>`).join('')}`;
// `sent`: days ago it went out to `readers`, with the shares that opened and clicked; without it the issue is a draft.
async function issue(db, who, newsletter, subject, sent) {
  const campaign = await who.api('POST', '/v1/campaigns', { name: subject, subject, from: newsletter.from, fromName: newsletter.fromName, audience: { listId: newsletter.id },
    html: issueHtml(subject, ['A short note from the shore this week.', 'More next time.']) }, 201);
  if (!sent) return campaign.id;
  const review = rid('review'), at = ago(sent.days * 1440 + 5), bounced = Math.round(sent.readers * 0.004), delivered = sent.readers - bounced;
  const group = (status, count, extra) => ({ status, simulated: false, count, accepted: count, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, failed: 0, deliveryDelayed: 0, ...extra });
  const stats = { reviewId: review, computedAt: ago(Math.max(0, sent.days - 2) * 1440), revision: 'fixture', emails: sent.readers, frozen: sent.days > 30 || undefined,
    groups: [group('delivered', delivered, { delivered, opened: Math.round(delivered * sent.opened), clicked: Math.round(delivered * sent.clicked) }), group('bounced', bounced, { bounced })] };
  await db.query(`INSERT INTO sending_campaign_reviews(id,workspace_id,campaign_id,revision,draft,content_hash,rendered,created_at)
    SELECT $1,workspace_id,id,revision,draft,'fixture',jsonb_build_object('html',draft->>'html'),$3::timestamptz FROM sending_campaigns WHERE id=$2`, [review, campaign.id, at]);
  await db.query(`UPDATE sending_campaigns SET state='done',review_id=$2,total=$3,prepared=$3,expanded=$3,stats=$4::jsonb,created_at=$5::timestamptz-interval '2 days',updated_at=$5 WHERE id=$1`,
    [campaign.id, review, sent.readers, JSON.stringify(stats), at]);
  // `emails`: its emails are still in the history, so its results open them in Logs (the review's per-status links).
  if (sent.emails) await db.query(`INSERT INTO sending_emails (id, workspace_id, region, actor_key_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, snapshot, simulated, status, provider_id, event_outcomes, created_at, campaign_id, review_id, review_ordinal)
    SELECT 'email_'||$2||'_'||g, workspace_id, '${REGION}', 'fixture', $3, jsonb_build_array('reader'||g||'@example.net'), '[]', '[]', $4, jsonb_build_object('kind','marketing','region','${REGION}','subject',$4::text,'attachments','[]'::jsonb), false,
      CASE WHEN g <= $6 THEN 'bounced' ELSE 'delivered' END, 'provider-'||$2||'-'||g, 0, $7::timestamptz + g * interval '1 second', id, $2, g
    FROM sending_campaigns, generate_series(1,$5) g WHERE id=$1`, [campaign.id, review, newsletter.from, subject, sent.readers, bounced, at]);
  return campaign.id;
}
// One newsletter with a year's readers and twelve issues (mara); two newsletters, one with a single draft, beside two
// campaigns that are neither's issue (lou); one made a moment ago (sol); four, which the sidebar lists as one item (ivy).
async function newsletters(fx) {
  const { db } = fx;
  const workspace = async (key, email, fullName, ws, host) => {
    const who = await fx.signIn(key, email, fullName, ws);
    await domain(db, ws.id, await hosted(db, ws.id), host, { mailFrom: true });
    // Credit, so its pages carry no empty-balance banner once billing is enforced.
    await db.query("SELECT billing_post($1,'topup',$2,5000000000::bigint,0::bigint,'{}'::jsonb,'stripe')", [ws.id, 'attempt:cls_' + ws.id]);
    return who;
  };
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const mara = await workspace('mara', 'mara@tidenotes.example', 'Mara Quinn', { id: 'ws_tide', name: 'Mara Quinn' }, 'tidenotes.example');
  const tide = await mara.api('POST', '/v1/newsletters', { name: 'Tide Notes', from: 'mara@tidenotes.example', fromName: 'Tide Notes' }, 201);
  await newsletterReaders(db, 'ws_tide', tide.id, 3412);
  const subjects = ['Hello from the shore', 'Mending nets', 'A field guide to sea fog', 'Where the seals go in August', 'The low-tide walk to the island', 'Salt on everything', 'Notes from the lighthouse road', 'Small boats, big tides', 'The ferry timetable, annotated', 'Kelp, and what to do with it', 'A harbour at five in the morning', 'What the storm left behind'];
  let issueSent
  for (const [i, subject] of subjects.entries()) issueSent = await issue(db, mara, tide, subject, { days: (subjects.length - 1 - i) * 7 + 3, readers: Math.round(3398 * (1 - (subjects.length - 1 - i) * 0.021)), opened: 0.46 + rnd() * 0.1, clicked: 0.08 + rnd() * 0.06, emails: i === subjects.length - 1 });

  const lou = await workspace('lou', 'lou@fernhill.example', 'Lou Holt', { id: 'ws_fern', name: 'Fernhill Farm' }, 'fernhill.example');
  const weekly = await lou.api('POST', '/v1/newsletters', { name: 'Fernhill Weekly', from: 'weekly@fernhill.example', fromName: 'Fernhill Farm' }, 201);
  await newsletterReaders(db, 'ws_fern', weekly.id, 5120);
  for (const [i, subject] of ['What we are planting', 'Seed swap on Saturday', 'A wet October', 'Hedges, and who lives in them', 'Frost on the kale', 'The last of the apples'].entries()) await issue(db, lou, weekly, subject, { days: (5 - i) * 7 + 3, readers: Math.round(5080 * (1 - (5 - i) * 0.02)), opened: 0.47 + rnd() * 0.08, clicked: 0.09 + rnd() * 0.05 });
  // Max is a member, not an admin: his sidebar and Campaigns are as they were before newsletters.
  await fx.signIn('max', 'max@fernhill.example', 'Max Holt', { id: 'ws_fern', name: 'Fernhill Farm', role: 'member' });
  const trade = await lou.api('POST', '/v1/newsletters', { name: 'Trade Notes', from: 'trade@fernhill.example', fromName: 'Fernhill Farm' }, 201);
  await newsletterReaders(db, 'ws_fern', trade.id, 640, 'example.org');
  await issue(db, lou, trade, 'Wholesale prices from January');
  for (const [name, subject] of [['Farm shop: Christmas hours', 'Open every day until the 24th'], ['Open day invitation', 'Come and see the farm']]) await lou.api('POST', '/v1/campaigns', { name, subject, from: 'shop@fernhill.example', html: issueHtml(subject, ['See you there.']) }, 201);

  const sol = await workspace('sol', 'sol@wren.example', 'Sol Wren', { id: 'ws_wren', name: 'Wren & Co' }, 'wren.example');
  const wren = await sol.api('POST', '/v1/newsletters', { name: 'Wren Weekly', from: 'hello@wren.example', fromName: 'Wren Weekly' }, 201);

  const ivy = await workspace('ivy', 'ivy@quillpress.example', 'Ivy Marsh', { id: 'ws_quill', name: 'Quill Press' }, 'quillpress.example');
  for (const name of ['Fiction', 'Poetry', 'Essays', 'For booksellers']) await ivy.api('POST', '/v1/newsletters', { name, from: `${name.toLowerCase().replace(/\W+/g, '-')}@quillpress.example`, fromName: 'Quill Press' }, 201);
  return { issueSent, newsletter: tide.id, newsletterDraft: trade.id, newsletterNew: wren.id, newsletterSecond: weekly.id };
}

export async function seed(fx) {
  const { db } = fx;
  const dana = await fx.signIn('dana', 'dana@northwind.example', 'Dana Rivera', { id: 'ws_northwind', name: 'Northwind' });
  const conn = await hosted(db, 'ws_northwind');
  const nw = await domain(db, 'ws_northwind', conn, 'northwind.example', { receiving: true });
  const sendingDomain = await domain(db, 'ws_northwind', conn, 'mail.northwind.example', { mailFrom: true, dmarc: 'none' });
  await db.query("INSERT INTO nightmail_users (id,name,email,email_verified) VALUES ('user_sam','Sam Okafor','sam@northwind.example',true),('user_lee','Lee Park','lee@northwind.example',true)");
  await db.query("INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES ('wm_sam','ws_northwind','user_sam','admin'),('wm_lee','ws_northwind','user_lee','member')");
  await dana.api('POST', '/v1/api-keys', { name: 'Production', permissions: ['send'], domains: ['mail.northwind.example'] }, 201);
  await dana.api('POST', '/v1/api-keys', { name: 'Billing worker', permissions: ['send'], domains: [] }, 201);
  const hook = await dana.api('POST', '/v1/webhooks', { description: 'Delivery events', url: 'https://hooks.northwind.example/bane', eventTypes: ['email.delivered', 'email.bounced', 'email.complained'] }, 201);
  await dana.api('POST', '/v1/workspaces/current/invitations', { email: 'ops@northwind.example', role: 'member' }, 201);
  // Settings → Activity: the calls above write their own audit rows; a teammate joining and a support grant's read go
  // in as SQL (once the audit table exists on this branch).
  if ((await db.query("SELECT to_regclass('audit_events') IS NOT NULL AS ok")).rows[0].ok) await db.query(`INSERT INTO audit_events
    (workspace_id,user_id,actor_type,actor_id,actor_label,via,action,target_type,target_id,summary,reason,request_id,ip_network,user_agent,internal,at,retain_until) VALUES
    ('ws_northwind','user_sam','member','user_sam',NULL,'dashboard','member.join','member','user_sam','{"after":{"role":"admin"}}',NULL,'req_fixture_join','198.51.100.0/24','Safari 18 on macOS',false,now()-interval '6 days',now()+interval '1 year'),
    ('ws_northwind','user_sam','support','sgr_fixture','Nightmail support','support','support.view','workspace','ws_northwind','{"ticket":"T-1042","member":"user_sam"}',NULL,'req_fixture_support',NULL,NULL,false,now()-interval '2 days',now()+interval '1 year')`);
  const email = await mail(db, 'ws_northwind', 30);
  // The newest receipt as a well-made transactional email, and a junk-like one sent a minute ago (EmailInsight's two cases).
  // Neither links a remote image: the sent-mail preview loads those, and the gate allows no external request.
  await db.query('UPDATE sending_emails SET snapshot = snapshot || $2::jsonb WHERE id = $1', [email, JSON.stringify({ kind: 'transactional', fromName: 'Northwind', html: RECEIPT_HTML, text: RECEIPT_TEXT })]);
  // Its delivery line: handed to SES, accepted and delivered, as the dispatcher and SES feedback record them.
  for (const [type, ms] of [['dispatch_attempt', 0], ['accepted', 400], ['delivery', 2100]]) await db.query(`INSERT INTO sending_email_events(id,workspace_id,email_id,type,provider_id,external_id,data,simulated,created_at)
    SELECT $1,workspace_id,id,$2,provider_id,$1,jsonb_build_object('emailId',id,'providerId',provider_id),false,created_at + $3 * interval '1 millisecond' FROM sending_emails WHERE id=$4`, [rid('event'), type, ms, email]);
  const junkEmail = rid('email');
  await db.query(`INSERT INTO sending_emails (id, workspace_id, region, actor_key_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, snapshot, simulated, status, provider_id, event_outcomes, created_at)
    VALUES ($1,'ws_northwind','${REGION}','fixture','deals@mail.northwind.example','["customer@example.net"]','[]','[]',$2,$3::jsonb,false,'delivered','provider-'||$1,3,now()-interval '1 minute')`,
    [junkEmail, JUNK_SUBJECT, JSON.stringify({ kind: 'marketing', region: REGION, subject: JUNK_SUBJECT, html: JUNK_HTML, attachments: [] })]);
  // A bounced and a delayed email, each with what its page says under the delivery (features/logs/reason.ts): the
  // receiving server's reply as SES feedback stores it, and for the delay SES's type and its retry deadline.
  const failed = {};
  for (const [name, subject, status, outcomes, minutes, type, data] of [
    ['bounced', 'Reset your password', 'bounced', 5, 3, 'bounce', { bounceType: 'Permanent', bounceSubType: 'NoEmail', diagnosticCode: 'smtp; 550 5.1.1 <customer@example.net>: Recipient address rejected: User unknown in virtual mailbox table' }],
    ['delayed', 'Your sign-in code', 'delayed', 129, 4, 'delivery_delay', { delayType: 'MailboxFull', expirationTime: new Date(Date.now() + 2 * 86_400_000).toISOString(), diagnosticCode: 'smtp; 452 4.2.2 The email account that you tried to reach is over quota' }]]) {
    const id = failed[name] = rid('email');
    await db.query(`INSERT INTO sending_emails (id, workspace_id, region, actor_key_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, snapshot, simulated, status, provider_id, event_outcomes, created_at)
      VALUES ($1,'ws_northwind','${REGION}','fixture','receipts@mail.northwind.example','["customer@example.net"]','[]','[]',$2,$3::jsonb,false,$4,'provider-'||$1,$5,now()-$6*interval '1 minute')`,
      [id, subject, JSON.stringify({ kind: 'transactional', region: REGION, subject, fromName: 'Northwind', html: RECEIPT_HTML, text: RECEIPT_TEXT, attachments: [] }), status, outcomes, minutes]);
    for (const [step, ms, extra] of [['dispatch_attempt', 0, {}], ['accepted', 400, {}], [type, 2100, data]]) await db.query(`INSERT INTO sending_email_events(id,workspace_id,email_id,type,provider_id,external_id,data,simulated,created_at)
      SELECT $1,workspace_id,id,$2,provider_id,$1,jsonb_build_object('emailId',id,'providerId',provider_id)||$5::jsonb,false,created_at + $3 * interval '1 millisecond' FROM sending_emails WHERE id=$4`, [rid('event'), step, ms, id, JSON.stringify(extra)]);
  }
  // A single email scheduled for tomorrow: Logs gives it a Scheduled badge and its row's menu (cancel, reschedule).
  await db.query(`INSERT INTO sending_emails (id, workspace_id, region, actor_key_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, snapshot, simulated, status, scheduled_at, created_at)
    VALUES ($1,'ws_northwind','${REGION}','fixture','receipts@mail.northwind.example','["customer@example.net"]','[]','[]','Your order ships tomorrow',$2::jsonb,false,'scheduled',now()+interval '1 day',now()-interval '2 minutes')`,
    [rid('email'), JSON.stringify({ kind: 'transactional', region: REGION, subject: 'Your order ships tomorrow', text: 'It leaves our warehouse tomorrow morning.', attachments: [] })]);
  // Receiving: addresses with aliases, routes, endpoints, rules, webhooks, agent inboxes and threads.
  const make = input => dana.api('POST', '/v1/inbound/addresses', input, 201);
  const A = {
    support: await make({ address: 'support@northwind.example', key: 'support', displayName: 'Support', aliases: ['help@northwind.example', 'hello@northwind.example'], rules: ['reply+*@northwind.example'] }),
    billing: await make({ address: 'billing@northwind.example', key: 'billing', displayName: 'Billing', aliases: ['invoices@northwind.example'] }),
    sales: await make({ address: 'sales@northwind.example', key: 'sales', displayName: 'Sales' }),
    security: await make({ address: 'security@northwind.example', key: 'security', displayName: 'Security' }),
    dana: await make({ address: 'dana@northwind.example', displayName: 'Dana Rivera' }),
  };
  // An API key limited to several addresses: API keys' Access column lists each of them, masked.
  await dana.api('POST', '/v1/api-keys', { name: 'Triage agent', access: { type: 'addresses', addressIds: [A.support.id, A.billing.id, A.sales.id], mail: ['read', 'send'] } }, 201);
  const crm = await dana.api('POST', '/v1/inbound/webhooks', { description: 'CRM intake', url: 'https://hooks.northwind.example/crm', eventTypes: [], addressIds: null, format: 'nightmail' }, 201);
  await dana.api('POST', '/v1/inbound/webhooks', { description: 'Helpdesk', url: 'https://helpdesk.northwind.example/inbound', eventTypes: ['message.received'], addressIds: [A.support.id], format: 'nightmail' }, 201);
  const crmId = crm.webhook?.id ?? crm.id;
  await dana.api('POST', '/v1/routing/routes', { match: 'refunds@northwind.example', to: [A.billing.id, crmId] }, 201);
  await dana.api('POST', '/v1/routing/routes', { match: 'noreply@northwind.example', to: 'drop' }, 201);
  await dana.api('POST', '/v1/endpoints', { type: 'slack', name: 'support', url: 'https://hooks.slack.com/services/T0SYNTH/B0SYNTH/northwindfixture0a1' }, 201);
  await dana.api('POST', '/v1/endpoints', { type: 'webhook', name: 'crm', url: 'https://hooks.northwind.example/crm-ritual' }, 201);
  await dana.api('POST', '/v1/endpoints', { type: 'forward', name: 'founders', address: 'founders@mail.northwind.example', preverify: true }, 201);
  // Ready-made rules (recipes) beside the two scripts, written by the API's own buildRecipe and saved in this one
  // config write (one audit row, so Settings → Activity measures what it did before): the Rules tab shows them as
  // sentences, one turned off, and an edit opens the rule's page, its code (cls.mjs `Receiving · recipe rule`).
  const apiDir = fileURLToPath(new URL('../../api/', import.meta.url));
  const { tsImport } = await import(pathToFileURL(createRequire(join(apiDir, 'package.json')).resolve('tsx/esm/api')).href);
  const { buildRecipe } = await tsImport(join(apiDir, 'src/ritual-schema.ts'), import.meta.url);
  const endpointTypes = { support: 'slack', crm: 'webhook', founders: 'forward' };
  const recipe = (key, id, params, extra = {}) => {
    const built = buildRecipe(id, params, name => endpointTypes[name]);
    if (!built.ok) throw new Error(`fixture recipe ${id}: ${built.message}`);
    return { key, source: built.source, recipe: { id, params: built.params }, ...extra };
  };
  await dana.api('PUT', '/v1/rules', {
    rules: [
      { key: 'triage', source: 'export default function route(email, ctx) {\n  if (email.headers.has("list-unsubscribe")) return junk("newsletter")\n  label("support")\n  endpoints.support({ text: `${email.from.address}: ${email.subject}` })\n}\n' },
      { key: 'invoices', source: 'export default function route(email, ctx) {\n  if (email.attachments.length > 0) {\n    label("invoice")\n    endpoints.crm({ subject: email.subject, from: email.from.address })\n  }\n}\n' },
      recipe('allow-senders-support', 'allow-senders', { senders: ['ceo@example.net', '@partner.example'] }),
      recipe('label-by-meaning-support', 'label-by-meaning', { meaning: 'a refund request', label: 'refund' }),
      recipe('forward-sales', 'forward', { to: 'founders' }),
      recipe('junk-newsletters-sales', 'junk-newsletters', {}, { enabled: false }),
    ],
    // Recipes run with "Run the next one too" on, before the address's own script (createRuleFromRecipe's order).
    attachments: [
      { rule: 'allow-senders-support', target: A.support.id, continue: true }, { rule: 'label-by-meaning-support', target: A.support.id, continue: true }, { rule: 'triage', target: A.support.id, continue: false },
      { rule: 'label-by-meaning-support', target: A.billing.id, continue: true }, { rule: 'invoices', target: A.billing.id, continue: false },
      { rule: 'junk-newsletters-sales', target: A.sales.id, continue: true }, { rule: 'forward-sales', target: A.sales.id, continue: true },
    ],
    senderLists: { vip: ['ceo@example.net'] }, evaluateDomains: ['northwind.example'], evaluateRoutes: [],
  }, 200);
  await threads(db, 'ws_northwind', A.support, [{ id: 'msg_northwind_invoice', subject: 'Invoice for October', snippet: 'Please find the October invoice attached.', unread: true, minutes: 9, from: ['Margaret Ode', 'margaret@example.com'], files: 1 }, ...mix(6, 0)]);
  await threads(db, 'ws_northwind', A.billing, mix(4, 2));
  await threads(db, 'ws_northwind', A.sales, mix(3, 3));
  await threads(db, 'ws_northwind', A.dana, mix(2, 4));
  const thread = await conversation(db, 'ws_northwind', A.support);
  // Ingest records which rules acted on each email (verdicts.ritualsActed); these threads are inserted directly, so
  // say it here: the Rules tab's Last matched.
  const acted = async (box, keys) => db.query(`UPDATE mail_messages SET verdicts=verdicts||jsonb_build_object('ritualsActed',$3::jsonb) WHERE workspace_id=$1 AND id IN (SELECT message_id FROM mailbox_messages WHERE mailbox_id=$2)`, ['ws_northwind', box.id, JSON.stringify(keys)]);
  await acted(A.support, ['triage', 'label-by-meaning-support']);
  await acted(A.billing, ['invoices']);
  await acted(A.sales, ['forward-sales']);
  const inbox = await agentInbox(db, 'ws_northwind', nw, 'Sign-up e2e', 20, mix(3, 1));
  await agentInbox(db, 'ws_northwind', nw, 'Password reset e2e', 3, []);

  // Audience and campaigns.
  const list = await dana.api('POST', '/v1/lists', { name: 'Customers' });
  const contacts = [];
  for (const [i, who] of ['ada', 'grace', 'linus', 'margaret', 'ken'].entries()) contacts.push(await dana.api('POST', '/v1/contacts', { email: `${who}@example.net`, name: who[0].toUpperCase() + who.slice(1),
    properties: { plan: who.length > 4 ? 'pro' : 'free', status: i < 3 ? 'waiting' : 'signed_up', joined_at: `2026-11-1${i}T09:30:00.000Z`, mailbox: i % 2 ? 'free' : 'company', attempts: i + 1 } }));
  // A role address list hygiene flags (Audience · risky): campaigns skip it until someone sends to it anyway.
  const risky = await dana.api('POST', '/v1/contacts', { email: 'noreply@example.net' });
  await dana.api('POST', `/v1/lists/${list.id}/members`, { contactIds: [...contacts, risky].map(c => c.id) });
  const segment = await dana.api('POST', '/v1/segments', { name: 'Pro plan', rule: { field: 'plan', operator: 'eq', value: 'pro' } });
  // Property rules (Segment · property rules): a string, a day and a presence check.
  const propertySegment = await dana.api('POST', '/v1/segments', { name: 'Waiting companies', rule: { operator: 'and', rules: [
    { field: 'property', key: 'status', type: 'string', operator: 'eq', value: 'waiting' }, { field: 'property', key: 'joined_at', type: 'date', operator: 'before', value: '2026-11-20' },
    { field: 'property', key: 'mailbox', type: 'string', operator: 'eq', value: 'company' }, { field: 'property', key: 'attempts', type: 'number', operator: 'gt', value: 0 }, { field: 'property', key: 'let_in_at', type: 'date', operator: 'notSet' }] } });
  const template = await dana.api('POST', '/v1/templates', { name: 'Receipt' });
  const campaign = await dana.api('POST', '/v1/campaigns', { name: 'November product update', subject: 'What shipped in November', from: 'news@mail.northwind.example', html: '<p>Hello</p>' });
  // Review's Send stage (Campaign review · send, · ramp): a campaign to 40 subscribers, which the send review finds ready,
  // and one to 12,000 from a domain added today, which it recommends sending in two daily batches.
  const subscribers = async (name, prefix, n) => {
    const made = await dana.api('POST', '/v1/lists', { name });
    await db.query(`WITH c AS (INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent) SELECT 'con_cls_'||$2||'_'||n,'ws_northwind',$2||'-'||n||'@example.org','subscribed' FROM generate_series(1,$3::int) n RETURNING id)
      INSERT INTO audience_list_members(workspace_id,list_id,contact_id) SELECT 'ws_northwind',$1,id FROM c`, [made.id, prefix, n]);
    return made;
  };
  const readyCampaign = await dana.api('POST', '/v1/campaigns', { name: 'Customer note', subject: 'A note for customers', from: 'news@mail.northwind.example', html: '<p>Hello</p>', audience: { listId: (await subscribers('Early customers', 'early', 40)).id } });
  const waitlist = await subscribers('Waitlist import', 'waitlist', 12000);
  const rampCampaign = await dana.api('POST', '/v1/campaigns', { name: 'Waitlist launch', subject: 'We are live', from: 'news@mail.northwind.example', html: '<p>Hello</p>', audience: { listId: waitlist.id } });
  const contact = contacts[0];

  // Northwind's standing: graded B with a notice (two complaints in 10,000 accepted). Dana is also a Nightmail operator, so the operator
  // console has a signed-in user.
  const { noticeReasons } = await tsImport(join(apiDir, 'src/standing-model.ts'), import.meta.url);
  await standing(db, 'ws_northwind', { score: 86.4, limit: null, step: 'notice', since: ago(90), factors: [factor('complaints', 'Complaints', 30, 0.0003, 93.1), factor('content', 'Spam screen', 20, null, null), factor('bounces', 'Bounces', 15, 0.009, 91.1), factor('hygiene', 'List quality', 15, 0.012, 97.5), factor('auth', 'Authentication', 10, 0.85, 85), factor('engagement', 'Engagement', 10, 0.0031, 93.9)],
    reasons: noticeReasons({ accepted: 10_000, complaints: 2, bounces: 0 }, 'notice') });
  await db.query("INSERT INTO platform_operators(user_id,role,reason) VALUES('user_dana','operator','CLS fixture')");
  // The waitlist (Operator · waitlist): refused sign-ins to email when Nightmail opens, one without a name.
  await db.query(`INSERT INTO nightmail_waitlist(email,name,attempts,first_at,last_at) VALUES
    ('mara.quinn@example.net','Mara Quinn',3,now()-interval '6 days',now()-interval '2 hours'),('theo@example.net','Theo Brandt',1,now()-interval '1 day',now()-interval '1 day'),
    ('ines.alvarez@example.net','Inés Álvarez',2,now()-interval '9 days',now()-interval '3 days'),('build-bot@example.net',NULL,1,now()-interval '4 days',now()-interval '4 days'),
    ('kwame.mensah@example.net','Kwame Mensah',5,now()-interval '12 days',now()-interval '5 days'),('yuki.sato@example.net','Yuki Sato',1,now()-interval '7 days',now()-interval '7 days')`);
  // Dana's UI notes (features/ui-notes): one on Overview's title and one whose element is gone (a pin and the tray's
  // moved entry in notes mode), and others for the notes list. No screenshots: there is no object store here.
  const note = (id, body, kind, status, path, selector, minutes) => db.query(`INSERT INTO ui_notes(id,author_id,updated_by,body,kind,severity,status,url,path,route,context,element,created_at,resolved_at)
    VALUES($1,'user_dana','user_dana',$2,$3,NULL,$4,$5,$6,$6,$7::jsonb,$8::jsonb,$9::timestamptz,CASE WHEN $4 IN ('fixed','wontfix') THEN now() END)`, [id, body, kind, status, `${fx.origin}${path}`, path,
    JSON.stringify({ viewport: { width: 1440, height: 900 }, dpr: 2, theme: 'light', device: 'desktop', pointer: 'fine', build: 'cls' }),
    JSON.stringify({ selector, alternatives: [], testId: null, component: 'PageHeader', components: ['PageHeader'], tag: 'h1', role: 'heading', label: null, text: null, box: { x: 0, y: 0, width: 120, height: 24, scrollX: 0, scrollY: 0 }, styles: {} }), ago(minutes)]);
  await note('uin_' + '1'.repeat(32), 'Title sits 2px below the period tabs.', 'alignment', 'open', '/overview', '#main-content > header.ui-page-header > div.cluster:nth-of-type(1) > h1', 50);
  await note('uin_' + '2'.repeat(32), 'Empty state copy is too long.', 'copy', 'open', '/overview', '#main-content .cls-element-that-moved', 40);
  await note('uin_' + '3'.repeat(32), 'Filters wrap at 1280 px.', 'spacing', 'in_progress', '/logs', '#main-content > header.ui-page-header > div.cluster:nth-of-type(1) > h1', 30);
  await note('uin_' + '4'.repeat(32), 'Members table jumps on load.', 'bug', 'fixed', '/settings', '#main-content h2', 20);

  // Harbor Supply: restricted (marketing held) after complaints, with a quarantined campaign: the banner on every
  // page, Overview's standing card and the operator's workspace page.
  const rae = await fx.signIn('rae', 'rae@harborsupply.example', 'Rae Lind', { id: 'ws_harbor', name: 'Harbor Supply' });
  // Rae is an operator too, but not in UI_NOTES_SUBJECTS: no UI notes anywhere for her (cls.mjs checks).
  await db.query("INSERT INTO platform_operators(user_id,role,reason) VALUES('user_rae','operator','CLS fixture: an operator without UI notes')");
  // Both signed in with Google Workspace: staff tools need that session (api/src/operator.ts).
  await db.query("UPDATE nightmail_sessions SET staff=true WHERE user_id IN ('user_dana','user_rae')");
  const harborConn = await hosted(db, 'ws_harbor');
  await domain(db, 'ws_harbor', harborConn, 'harborsupply.example', { mailFrom: true });
  await rae.api('POST', '/v1/api-keys', { name: 'Production', permissions: ['send'], domains: [] }, 201);
  await mail(db, 'ws_harbor', 3);
  const springCatalog = await rae.api('POST', '/v1/campaigns', { name: 'Spring catalog', subject: 'New for spring', from: 'news@harborsupply.example', html: '<p>Hello</p>' });
  await db.query('UPDATE sending_campaigns SET quarantines=1 WHERE id=$1', [springCatalog.id]);
  const complaints = { code: 'COMPLAINTS_RESTRICT', metric: 'complaints', value: 0.0021, count: 4, threshold: 0.001, minimum: 3, window: '24h', step: 'restrict', message: '4 of 1,912 accepted emails were marked as spam in 24 hours (0.21%; the restrict line is 0.1% and 3).' };
  await standing(db, 'ws_harbor', { score: 72.4, limit: 500, step: 'restrict', since: ago(2 * 24 * 60), reasons: [complaints], factors: [factor('complaints', 'Complaints', 30, 0.0021, 31.2), factor('content', 'Spam screen', 20, null, null), factor('bounces', 'Bounces', 15, 0.011, 86.7), factor('hygiene', 'List quality', 15, 0.034, 79.1), factor('auth', 'Authentication', 10, 0.7, 70), factor('engagement', 'Engagement', 10, 0.006, 77.8)],
    events: [{ at: ago(3 * 24 * 60), from: 'ok', to: 'warn', reasons: [{ ...complaints, code: 'COMPLAINTS_WARN', step: 'warn', count: 2, message: '2 of 1,830 accepted emails were marked as spam in 24 hours (0.11%; the warn line is 0.05% and 2).' }] }, { at: ago(2 * 24 * 60), from: 'warn', to: 'restrict', reasons: [complaints] }] });

  await billing(db);
  const newsletterIds = await newsletters(fx);
  const { conversation: supportConversation, action: supportAction } = await supportInbox(db, hook.webhook?.id ?? hook.id);

  // Lumen Labs: verified domain, no key, no mail. Field Notes: no sending connection yet.
  const nia = await fx.signIn('nia', 'nia@lumenlabs.example', 'Nia Moreau', { id: 'ws_fresh', name: 'Lumen Labs' });
  // Nia emailed support from an address whose DMARC failed; the reply's link shows which email it is (its subject and
  // when it arrived) and confirms it signed in (Support · continue email). Her session's sign-in proved her address a
  // mailbox, as a Google one does, and recorded that proof, so the page shows the email and the claim answers it.
  const continueConversation = supportId('conv', 'niacontinue', 26), continueMessage = `msg_${'c'.repeat(32)}`;
  await db.query("UPDATE nightmail_sessions SET verified_email = 'nia@lumenlabs.example' WHERE user_id = 'user_nia'");
  await db.query("UPDATE nightmail_users SET mailbox_proved = email, mailbox_proved_at = now() WHERE id = 'user_nia'");
  await db.query("INSERT INTO mail_threads(id, workspace_id) VALUES ('thr_niacontinue', 'ws_fresh')");
  await db.query("INSERT INTO mail_messages(id, workspace_id, direction, thread_id, subject, from_address, received_at) VALUES ($1, 'ws_fresh', 'inbound', 'thr_niacontinue', 'Why did my first campaign bounce at Outlook?', 'nia@lumenlabs.example', now() - interval '2 hours')", [continueMessage]);
  await db.query("INSERT INTO support_conversations(id, channel, pending_address, verification, mode) VALUES ($1, 'email', 'nia@lumenlabs.example', 'none', 'pending_signin')", [continueConversation]);
  await db.query("INSERT INTO support_email_signins(conversation_id, message_id, address) VALUES ($1, $2, 'nia@lumenlabs.example')", [continueConversation, continueMessage]);
  const freshConn = await hosted(db, 'ws_fresh');
  await domain(db, 'ws_fresh', freshConn, 'lumenlabs.example');
  const stuckDomain = await stuck(db, 'ws_fresh', freshConn, 'lumenmail.example');
  const correctDomain = await stuck(db, 'ws_fresh', freshConn, 'lumenpost.example', { correct: true });
  // Lists after lumenmail.example, so Overview's setup banner stays that one's.
  const noDnsDomain = await stuck(db, 'ws_fresh', freshConn, 'lumenaml.example', { noDns: true });
  const wildcardDomain = await stuck(db, 'ws_fresh', freshConn, 'lumenwild.example', { wildcard: true });
  const parkedDomain = await stuck(db, 'ws_fresh', freshConn, 'lumenpark.example', { parking: true });
  await fx.signIn('ona', 'ona@fieldnotes.example', 'Ona Field', { id: 'ws_new', name: 'Field Notes' });
  // Sending is ready but no domain was added: onboarding's domain step was skipped (cls.mjs `skipped`), so Overview asks for one.
  await fx.signIn('pia', 'pia@pinestudio.example', 'Pia Lund', { id: 'ws_skipped', name: 'Pine Studio' });
  // Its built-in domain sends meanwhile: Overview's card asks for a domain of its own, and Domains lists the built-in one.
  const builtinDomain = await builtin(db, 'ws_skipped', await hosted(db, 'ws_skipped'), 'pine-studio-k7');
  // A verified domain of its own and nothing sent yet: Overview's first card offers the first send, from that domain, not the built-in one.
  await fx.signIn('ren', 'ren@rowanbakery.example', 'Ren Okafor', { id: 'ws_verified', name: 'Rowan Bakery' });
  const verifiedConn = await hosted(db, 'ws_verified');
  await builtin(db, 'ws_verified', verifiedConn, 'rowan-bakery-m2');
  await domain(db, 'ws_verified', verifiedConn, 'rowanbakery.example');
  // Umber: Hosted mail ready, the built-in domain ready, no domain of its own and onboarding not finished: its first email.
  await fx.signIn('uma', 'uma@umber.example', 'Uma Reyes', { id: 'ws_builtin', name: 'Umber' });
  await builtin(db, 'ws_builtin', await hosted(db, 'ws_builtin'), 'umber-q4');
  // Ulmus: the same, its built-in domain still being set up (the request that made the workspace ran out of time).
  await fx.signIn('ula', 'ula@ulmus.example', 'Ula Berg', { id: 'ws_builtin_pending', name: 'Ulmus' });
  await builtin(db, 'ws_builtin_pending', await hosted(db, 'ws_builtin_pending'), 'ulmus-r8', { pending: true });
  // What each workspace said it is here for (onboarding's focus question): the step and Overview card each focus leads to.
  // Alder: agent inboxes, its agent@ inbox made and two emails in it. Aspen: the same focus, nothing received yet (Overview's card).
  const focused = async (user, email, name, workspace, label, focus) => {
    await fx.signIn(user, email, name, { id: workspace, name: label })
    const made = await builtin(db, workspace, await hosted(db, workspace), label.toLowerCase() + '-' + user.slice(0, 1) + '3')
    await db.query('UPDATE workspaces SET focus = $2 WHERE id = $1', [workspace, focus])
    return made
  }
  const alder = await focused('ada', 'ada@alder.example', 'Ada Moss', 'ws_focus_agents', 'Alder', ['agents', 'developer'])
  await agentInbox(db, 'ws_focus_agents', { mdom: 'mdom_builtin_ws_focus_agents', host: alder.name }, 'Agent', 24 * 30, mix(2))
  await focused('abe', 'abe@aspen.example', 'Abe Lowe', 'ws_focus_agents_new', 'Aspen', ['agents'])
  await focused('mae', 'mae@maple.example', 'Mae Ford', 'ws_focus_marketing', 'Maple', ['marketing', 'newsletter'])
  await focused('noa', 'noa@linden.example', 'Noa Hart', 'ws_focus_newsletter', 'Linden', ['newsletter'])
  await focused('pam', 'pam@poplar.example', 'Pam Reid', 'ws_focus_personal', 'Poplar', ['personal'])
  // Connecting their own AWS account, one workspace per moment of the connect step (onboarding/aws.tsx).
  await connectedAccount(fx, db, 'bea', 'Juniper', 'stack');
  await connectedAccount(fx, db, 'bo', 'Kestrel', 'refused');
  await connectedAccount(fx, db, 'fay', 'Larkspur', 'checking');
  await connectedAccount(fx, db, 'cy', 'Marlow', 'choose');
  await connectedAccount(fx, db, 'di', 'Nettle', 'sandbox');
  await connectedAccount(fx, db, 'ed', 'Osier', 'setup');
  await connectedAccount(fx, db, 'gil', 'Pinewood', 'ready');
  await connectedAccount(fx, db, 'hal', 'Quarry', 'disconnecting');
  void nia;
  // Lumen Labs is a design partner: free (not billed) for 60 days, so its Billing page shows the free plan.
  await db.query("SELECT billing_set_workspace_free('ws_fresh', true, 'Design partner', now()+interval '60 days', 'operator:user_dana')");
  // An MCP client dana connected as a labelled profile, waiting for its workspace (its page is /settings/mcp/<id>).
  const mcp = 'mcp_at_cls_fixture';
  await db.query("INSERT INTO nightmail_resource_grants(id,issuer,subject,user_id,client_id,workspace_id,permissions,expires_at,issued_at,profile) VALUES($1,'https://account.anoma.ly','user_dana','user_dana','opencode',NULL,'{read,send}',now()+interval '1 day',0,'work')", [mcp]);
  // An agent waiting at /connect with its device code (api/src/agent-setup.ts): Connect · agent code approves or denies it.
  await db.query("INSERT INTO agent_setups(id,kind,secret_hash,user_code,client_name,expires_at) VALUES ($1,'device',repeat('0',64),'BCDFGHJK','OpenCode',now()+interval '1 day')", ['ags_' + 'c'.repeat(32)]);
  // API keys' agent tokens: that agent with two short-lived tokens it made in Northwind, and Sam's agent with one (an
  // owner sees another member's agent once it has made tokens here).
  await db.query("INSERT INTO nightmail_resource_grants(id,issuer,subject,user_id,client_id,workspace_id,permissions,expires_at,issued_at) VALUES('mcp_at_cls_sam','https://account.anoma.ly','user_sam','user_sam','claude-code',NULL,'{read}',now()+interval '1 day',0)");
  await db.query(`INSERT INTO agent_tokens(id,workspace_id,grant_id,permissions,domains,purpose,expires_at,created_at) VALUES
    ('agt_cls_import','ws_northwind',$1,'["read","send"]','[]','Import October contacts',now()+interval '50 minutes',now()-interval '10 minutes'),
    ('agt_cls_digest','ws_northwind',$1,'["send"]','["mail.northwind.example"]','Send the weekly digest',now()+interval '5 hours',now()-interval '1 hour'),
    ('agt_cls_sam','ws_northwind','mcp_at_cls_sam','["read"]','[]','Check bounce rates',now()+interval '2 hours',now()-interval '30 minutes')`, [mcp]);
  // Driftwood: the rules page while an agent edits beside it (cls.mjs `live` jobs). Kai's OpenCode approval can change
  // rules here (the page says it is connected), and the agent's own API key saves the rule while a job watches.
  const kai = await fx.signIn('kai', 'kai@driftwood.example', 'Kai Moana', { id: 'ws_live', name: 'Driftwood' });
  await domain(db, 'ws_live', await hosted(db, 'ws_live'), 'driftwood.example', { receiving: true });
  // Operator · Abuse: two clusters of related accounts as abuse monitoring stores them (IDs, kinds and counts, never a
  // value), with this month's free use, and the alert outbox with its Slack cards. Synthetic: the fixture runs no job.
  const abuseCluster = 'acl_' + '1'.repeat(24), abuseWatch = 'acl_' + '2'.repeat(24), refused = 'att_' + 'a'.repeat(32);
  const entity = (type, id) => ({ type, id }), owner = (user, workspace) => ({ a: `user:${user}`, b: `workspace:${workspace}`, owner: true, kinds: {} });
  const cluster = (id, score, band, accounts, members, edges, reasons, days) => db.query(`INSERT INTO abuse_clusters(id,score,band,peak,accounts,workspaces,reasons,members,edges,first_at,changed_at)
    VALUES($1,$2,$3,$2,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,now()-$9*interval '1 day',now()-$9*interval '1 hour')`, [id, score, band, accounts, members.filter(m => m.type === 'workspace').length, JSON.stringify(reasons), JSON.stringify(members), JSON.stringify(edges), days])
    .then(() => db.query('INSERT INTO abuse_cluster_members(entity_type,entity_id,cluster_id) SELECT type,id,$2 FROM jsonb_to_recordset($1::jsonb) AS m(type text,id text)', [JSON.stringify(members), id]));
  await cluster(abuseCluster, 85, 'high', 3, [entity('user', 'user_nia'), entity('workspace', 'ws_fresh'), entity('user', 'user_ona'), entity('workspace', 'ws_new'), entity('attempt', refused)],
    [owner('user_nia', 'ws_fresh'), owner('user_ona', 'ws_new'), { a: 'user:user_nia', b: 'user:user_ona', kinds: { email_alias: 1, net: 1 }, sameBrowser: true }, { a: `attempt:${refused}`, b: 'user:user_ona', kinds: { email_alias: 1, net: 1 }, sameBrowser: true },
      { a: 'workspace:ws_fresh', b: 'workspace:ws_new', kinds: { card: 1, content: 3, link: 1 } }],
    [{ code: 'MULTI_ACCOUNT', points: 30, count: 3 }, { code: 'SHARED_CARD', points: 20, count: 1 }, { code: 'SIMILAR_CONTENT', points: 20, count: 1 }, { code: 'THROWAWAY_SIGNUP', points: 10, count: 2 }, { code: 'SHARED_LINKS', points: 5, count: 1 }], 3);
  await cluster(abuseWatch, 40, 'watch', 2, [entity('user', 'user_kai'), entity('workspace', 'ws_live'), entity('user', 'user_rae'), entity('workspace', 'ws_harbor')],
    [owner('user_kai', 'ws_live'), owner('user_rae', 'ws_harbor'), { a: 'user:user_kai', b: 'user:user_rae', kinds: { provider: 1 } }], [{ code: 'MULTI_ACCOUNT', points: 25, count: 2 }, { code: 'SENDER_STANDING', points: 15, count: 1 }], 9);
  await db.query(`INSERT INTO billing_usage_hourly(workspace_id,hour,meter,quantity) VALUES ('ws_new',date_trunc('hour',now(),'UTC'),'send',4200),('ws_new',date_trunc('hour',now(),'UTC'),'receive',310),('ws_live',date_trunc('hour',now(),'UTC'),'send',1800)
    ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=excluded.quantity`);
  // The cards as src/abuse-alerts.ts builds them: a level, counts, reason codes, workspace IDs and Operator links.
  const card = (band, score, change, reasons) => { const title = `Related accounts: ${band} risk`, field = (name, value) => ({ type: 'mrkdwn', text: `*${name}*\n${value}` }), button = (action_id, text, path, style) => ({ type: 'button', action_id, ...(style ? { style } : {}), text: { type: 'plain_text', text, emoji: false }, url: `${fx.origin}${path}` });
    return { text: `${title} (score ${score}, 3 accounts, 2 workspaces)`, unfurl_links: false, unfurl_media: false, blocks: [
      { type: 'header', text: { type: 'plain_text', text: title, emoji: false } },
      { type: 'section', fields: [field('Risk', `${band[0].toUpperCase()}${band.slice(1)} · ${score}`), field('Change', change), field('Accounts', '3'), field('Workspaces', '2')] },
      { type: 'section', text: { type: 'mrkdwn', text: `*Reasons*\n${reasons.map(([code, points]) => `\`${code}\` ${points}`).join('\n')}` } },
      { type: 'section', text: { type: 'mrkdwn', text: '*Workspaces*\n`ws_fresh`\n`ws_new`' } },
      { type: 'actions', elements: [button('open_cluster', 'Open in Operator', `/operator/abuse/${abuseCluster}`, 'primary'), button('open_workspace_1', 'Workspace 1', '/operator/workspaces/ws_fresh'), button('open_workspace_2', 'Workspace 2', '/operator/workspaces/ws_new')] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Monitoring only: nothing was blocked or paused. Details need a staff sign-in.' }] }] }; };
  await db.query(`INSERT INTO abuse_alerts(id,cluster_id,band,score,kind,workspaces,payload,created_at) VALUES ($1,$3,'review',60,'new',2,$4::jsonb,now()-interval '3 days'),($2,$3,'high',85,'raised',2,$5::jsonb,now()-interval '3 hours')`,
    ['aal_' + '1'.repeat(24), 'aal_' + '2'.repeat(24), abuseCluster, JSON.stringify(card('review', 60, 'New', [['MULTI_ACCOUNT', 30], ['SHARED_CARD', 20], ['THROWAWAY_SIGNUP', 10]])),
      JSON.stringify(card('high', 85, 'Risk raised', [['MULTI_ACCOUNT', 30], ['SHARED_CARD', 20], ['SIMILAR_CONTENT', 20], ['THROWAWAY_SIGNUP', 10], ['SHARED_LINKS', 5]]))]);
  // Operator · Health: what a minute tick wrote (api/src/health.ts) on a bad afternoon, and the alerts it holds: a
  // queue and a job type behind, a pile of failed jobs, a campaign that will take twelve hours, a 45-second request.
  // Synthetic like the abuse rows: the fixture runs no job runner, so nothing overwrites it.
  await db.query(`UPDATE health_state SET rollup=$1::jsonb,generated_at=now(),tick_at=now()`, ["{\"queues\":[{\"name\":\"feedback\",\"depth\":158000,\"oldestSeconds\":1200,\"behind\":true},{\"name\":\"feedback-dlq\",\"depth\":0,\"oldestSeconds\":0,\"behind\":false},{\"name\":\"legacy-feedback-dlq\",\"depth\":0,\"oldestSeconds\":0,\"behind\":false},{\"name\":\"webhooks\",\"depth\":12,\"oldestSeconds\":3,\"behind\":false},{\"name\":\"work\",\"depth\":4,\"oldestSeconds\":1,\"behind\":false}],\"jobs\":[{\"type\":\"mailbox.ingest\",\"pending\":1883,\"oldestSeconds\":780,\"failed\":0,\"error\":null,\"behind\":true},{\"type\":\"mailbox.recoverStaging\",\"pending\":0,\"oldestSeconds\":0,\"failed\":1639,\"error\":\"MAILBOX_STAGING_ENVELOPE_UNKNOWN\",\"behind\":true},{\"type\":\"campaign.run\",\"pending\":1,\"oldestSeconds\":4,\"failed\":0,\"error\":null,\"behind\":false}],\"campaigns\":[{\"id\":\"cmp_cls_health_long\",\"workspaceId\":\"ws_northwind\",\"state\":\"sending\",\"total\":1800000,\"released\":412800,\"rate\":32,\"acceptedRate\":31.6,\"entitled\":160,\"account\":160,\"planned\":40,\"etaSeconds\":43350,\"waiting\":null,\"settled\":388000,\"bounceRate\":0.012,\"behind\":true},{\"id\":\"cmp_cls_health_wait\",\"workspaceId\":\"ws_harbor\",\"state\":\"sending\",\"total\":52000,\"released\":20000,\"rate\":null,\"acceptedRate\":null,\"entitled\":40,\"account\":160,\"planned\":40,\"etaSeconds\":null,\"waiting\":\"hosted_daily_quota\",\"settled\":19400,\"bounceRate\":0.021,\"behind\":false}],\"feedbackLagSeconds\":1200,\"routes\":[{\"route\":\"POST /v1/campaigns/:id/send\",\"count\":3,\"errors\":0,\"p50Ms\":250,\"p95Ms\":45000,\"slowestMs\":45000,\"behind\":true},{\"route\":\"GET /v1/campaigns/:id/stats\",\"count\":45210,\"errors\":0,\"p50Ms\":10,\"p95Ms\":25,\"slowestMs\":310,\"behind\":true},{\"route\":\"POST /v1/emails/send\",\"count\":9120,\"errors\":4,\"p50Ms\":50,\"p95Ms\":250,\"slowestMs\":1900,\"behind\":false},{\"route\":\"GET /v1/emails\",\"count\":640,\"errors\":0,\"p50Ms\":25,\"p95Ms\":100,\"slowestMs\":420,\"behind\":false}],\"errors\":[{\"kind\":\"error\",\"code\":\"MAILBOX_STAGING_ENVELOPE_UNKNOWN\",\"count\":9},{\"kind\":\"code\",\"code\":\"DATABASE_UNAVAILABLE\",\"count\":4},{\"kind\":\"sqlstate\",\"code\":\"57014\",\"count\":4}],\"requests\":{\"count\":55310,\"errors\":4},\"database\":{\"connections\":61,\"maxConnections\":100,\"longTransactions\":1,\"oldestTransactionSeconds\":95,\"slowQueries\":0,\"lockWaits\":2,\"sizeBytes\":105656195481.6,\"diskBytes\":161061273600},\"memory\":{\"streaks\":{},\"campaigns\":{},\"failed\":[]}}"]);
  for (const [key, kind, severity, value, unit, words, age] of [["queue-behind:feedback","queue-behind","critical",1200,"seconds","`feedback`: oldest 20 min, 158,000 waiting.","34 minutes"],["jobs-behind:mailbox.ingest","jobs-behind","critical",780,"seconds","`mailbox.ingest`: 1,883 due, oldest 13 min.","12 minutes"],["jobs-failed:mailbox.recoverStaging","jobs-failed","warning",1639,"jobs","`mailbox.recoverStaging`: 1,639, mostly `MAILBOX_STAGING_ENVELOPE_UNKNOWN`.","3 hours"],["campaign-long:cmp_cls_health_long","campaign-long","warning",43350,"seconds","`cmp_cls_health_long`: 12 h left at 32/s, 20% of the account’s 160/s (entitled to 160/s; the planner reads 40/s). 1,387,200 of 1,800,000 left.","3 hours"],["slow-requests:POST:/v1/campaigns/:id/send","slow-requests","warning",45000,"milliseconds","`POST /v1/campaigns/:id/send`: slowest 45 s, p95 45 s over 3 in 15 min.","9 minutes"]])
    await db.query(`INSERT INTO health_alerts(key,kind,severity,value,unit,words,since,sent_at) VALUES ($1,$2,$3,$4,$5,$6,now()-$7::interval,now()-$7::interval)`, [key, kind, severity, value, unit, words, age]);
  // Sign-ups (Operator · sign-ups): nine accounts signed up on their own and a raise let the two longest-waiting
  // addresses in, which fills the limit of 11; four more wait.
  await db.query(`INSERT INTO nightmail_signups(user_id,via,at) SELECT 'user_'||k,'open',now()-interval '1 day' FROM unnest($1::text[]) k`, [['nia', 'ona', 'kai', 'mara', 'lou', 'sol', 'bea', 'cy', 'gil']]);
  await db.query("UPDATE nightmail_waitlist SET let_in_at=now()-interval '1 day' WHERE email IN ('kwame.mensah@example.net','ines.alvarez@example.net')");
  // Each was emailed that it can sign in (account-notices.ts waitlistAdmitted): the Waitlist tab's Let in column says so.
  await db.query(`INSERT INTO account_notices(id,workspace_id,kind,dedupe_key,data,status,sent_at) SELECT 'ant_cls_'||md5(e),'ws_northwind','waitlist_admitted','waitlist:'||e,jsonb_build_object('email',e),'sent',now()-interval '1 day'
    FROM unnest(ARRAY['kwame.mensah@example.net','ines.alvarez@example.net']) e`);
  await db.query('UPDATE nightmail_signup_limit SET places=11');
  const desk = await kai.api('POST', '/v1/inbound/addresses', { address: 'support@driftwood.example', key: 'support', displayName: 'Support' }, 201);
  await kai.api('POST', '/v1/endpoints', { type: 'slack', name: 'support', url: 'https://hooks.slack.com/services/T0SYNTH/B0SYNTH/driftwoodfixture0a1' }, 201);
  await kai.api('PUT', '/v1/rules', { rules: [{ key: 'triage', source: liveSource(0) }], attachments: [{ rule: 'triage', target: desk.id, continue: false }] }, 200);
  const agent = await kai.api('POST', '/v1/api-keys', { name: 'Refund agent', permissions: ['read', 'send', 'manage'], domains: [] }, 201);
  await db.query("INSERT INTO nightmail_resource_grants(id,issuer,subject,user_id,client_id,workspace_id,permissions,expires_at,issued_at,profile,receiving) VALUES('mcp_at_cls_live','https://account.anoma.ly','user_kai','user_kai','opencode','ws_live','{read,send,manage}',now()+interval '1 day',0,'work',true)");
  fx.liveKey = agent.secret;
  return {
    ...newsletterIds, mcp, deviceCode: 'BCDF-GHJK', abuseCluster, restricted: 'ws_harbor', email, junkEmail, bouncedEmail: failed.bounced, delayedEmail: failed.delayed, receivedEmail: 'msg_northwind_invoice', threadEmail: thread.email, threadReceived: thread.received, supportThread: thread.thread, domain: nw.id, sendingDomain: sendingDomain.id, stuckDomain: stuckDomain.id, correctDomain: correctDomain.id, noDnsDomain: noDnsDomain.id, wildcardDomain: wildcardDomain.id, parkedDomain: parkedDomain.id, builtinDomain: builtinDomain.id, address: A.support.id, inbox, inboundWebhook: crmId,
    webhook: hook.webhook?.id ?? hook.id, list: list.id, contact: contact.id, campaign: campaign.id, readyCampaign: readyCampaign.id, rampCampaign: rampCampaign.id, template: template.id ?? template.template?.id, segment: segment.id, propertySegment: propertySegment.id, supportConversation, supportAction, continueConversation, continueMessage,
  };
}
