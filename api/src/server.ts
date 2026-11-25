import {gatewayLane} from './protocol-admission.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getPath } from 'hono/utils/url';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { flushCounters } from './health-counters.js';
import { nodeLogFacetLane, nodeRuntime } from './adapters/node.js';
import { sql } from 'drizzle-orm';
import { dispatchWakeKey } from './dispatcher.js';
import { clientIpHeader, clientNetworkHeader, legacyClientIpHeaders } from './brand.js';
import { isMissingComparePage, SITE_INDEX, withSiteIndex } from './site-index.js';
import { admissionDenied, admissionPeer, ApiError, digest, log, logError, guardPublicRequest, setLogContext, snsIngress } from './core.js';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';

// The dashboard's files on Node/Docker. Cloudflare serves them itself, with app/public/_headers and compression;
// here every response would otherwise be uncompressed and no-store, so each visit re-downloaded the whole app.
// Hashed /assets/* are immutable and compressed once per process; fonts follow _headers; the HTML shell revalidates.
const encoders = { br: (raw: Buffer) => promisify(brotliCompress)(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }), gzip: (raw: Buffer) => promisify(gzip)(raw, { level: 9 }) };
const encoded = new Map<string, Promise<Buffer>>();
async function dashboardFile(request: Request, path: string, response: Response) {
  if (!['GET', 'HEAD'].includes(request.method) || response.status !== 200) return response;
  // The public docs (the Docs page reads the 1.7 MB OpenAPI document) are the same for every reader: compress them too.
  // Exactly these paths: a longer one that only starts like them is a dashboard route, with its own answer below.
  if (/^\/(?:openapi\.json|llms\.txt|docs\.md|docs\/(?:operations|tags)\/[^/]+)$/.test(path)) return encode(request, path, response, new Headers(response.headers), response.headers.get('content-length') ?? '');
  if (/^\/(?:health|v1|api|mcp|\.well-known|unsubscribe|i|docs\/(?:operations|tags))(?:\/|$)/.test(path)) return response;
  const html = response.headers.get('content-type')?.startsWith('text/html');
  const asset = path.startsWith('/assets/') && !html, font = path.startsWith('/fonts/') && !html;
  if (!html && !asset && !font) return response;
  const headers = new Headers(response.headers);
  // A missing /assets/ file falls back to the HTML shell: never cache that answer.
  // (HTML is never transformed on the way, as on Cloudflare: src/worker.ts, untransformed.)
  headers.set('cache-control', asset ? 'public, max-age=31536000, immutable' : font ? 'public, max-age=86400, stale-while-revalidate=604800' : 'no-cache, no-transform');
  if (!asset || !/\.(?:js|css|svg|json|map)$/.test(path)) return new Response(response.body, { status: 200, headers });
  return encode(request, path, response, headers, '');
}
// Brotli (or gzip) once per file per process; `version` separates bodies that can change under one path.
async function encode(request: Request, path: string, response: Response, headers: Headers, version: string) {
  const accept = request.headers.get('accept-encoding') ?? '';
  const encoding = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
  if (!encoding || response.headers.has('content-encoding')) return new Response(response.body, { status: response.status, headers });
  headers.append('vary', 'accept-encoding');
  const key = `${encoding} ${path} ${version}`;
  let body = encoded.get(key);
  if (!body) {
    // Only a GET has the file's bytes. A HEAD before the first GET answers without a length rather than
    // compressing its empty body, which would then be remembered as the file for every later GET.
    if (request.method !== 'GET') { headers.delete('content-length'); return new Response(null, { status: 200, headers }); }
    body = response.arrayBuffer().then(raw => encoders[encoding](Buffer.from(raw)));
    body.catch(() => encoded.delete(key));
    if (encoded.size < 1000) encoded.set(key, body);
  } else void response.body?.cancel();
  const bytes = await body;
  headers.set('content-encoding', encoding); headers.set('content-length', String(bytes.length));
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { status: 200, headers });
}

setLogContext({ service: 'api', deploy: process.env.DEPLOY_SHA });
try {
  const { runtime, close: closeApi } = nodeRuntime(process.env);
  const facets=nodeLogFacetLane(runtime,process.env.DATABASE_URL);
  runtime.startLogFacetFold=facets.nudge;
  runtime.startLogFacetAggregate=facets.aggregate;
  const close=async()=>{await facets.close();await closeApi();};
  runtime.dispatch = async (region, account, _count, _kind, priority) => {
    if (priority) await runtime.db.execute(sql`SELECT pg_notify('bane_priority', ${dispatchWakeKey(region, account)})`);
  };
  // The request counters (src/health-counters.ts), written every 20 seconds for the runner's health tick.
  setInterval(() => void flushCounters(runtime.db), 20_000).unref();
  const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
  const assets = serveStatic({ root: publicRoot });
  const dashboard = serveStatic({ path: `${publicRoot}index.html` });
  // A page the build wrote as its own file (pricing.html for /pricing: app/price-pages.ts), as Workers Assets answers it.
  const pages = serveStatic({ root: publicRoot, rewriteRequestPath: path => `${path.replace(/\/+$/, '')}.html` });
  // "/" on a multi-tenant installation is the homepage: home.html, as the Worker answers it (src/worker.ts).
  const homepage = runtime.config.multiTenant && existsSync(`${publicRoot}home.html`) ? serveStatic({ path: `${publicRoot}home.html` }) : null;
  // The website's own pages for /llms.txt, as the Worker adds them (src/site-index.ts).
  const siteIndex = existsSync(`${publicRoot}${SITE_INDEX.slice(1)}`) ? readFileSync(`${publicRoot}${SITE_INDEX.slice(1)}`, 'utf8') : '';
  const app = createApp({ fallback: async (c, next) => {
    // API failures must remain JSON, never an apparently successful SPA response.
    if (!['GET', 'HEAD'].includes(c.req.method) || /^\/(?:health|v1|api|mcp|\.well-known|unsubscribe|i|docs\/(?:operations|tags))(?:\/|$)/.test(c.req.path) || ['/openapi.json', '/docs.md', '/llms.txt'].includes(c.req.path)) return next();
    if (homepage && c.req.path === '/') { const response = await homepage(c, next); if (response) return response; }
    return assets(c, async () => {
      const response = await pages(c, async () => {
        const shell = await dashboard(c, next);
        // A comparison with no page of its own is not found, as on the Worker (src/worker.ts).
        if (shell) c.res = isMissingComparePage(c.req.path) ? new Response(shell.body, { status: 404, headers: shell.headers }) : shell;
      });
      if (response) c.res = response;
    });
  } });
  // Coarse per-process admission guard; trusted proxy/WAF controls remain necessary for distributed abuse.
  const peers = new Map<string, number>(), protocol = new Map<string,number>(); let minute = Math.floor(Date.now() / 60000);
  const server = serve({ fetch: async (request, connection) => {
    const current = Math.floor(Date.now() / 60000);
    if (current !== minute) { peers.clear(); protocol.clear(); minute = current; }
    const address = admissionPeer(connection.incoming.socket.remoteAddress ?? 'unknown');
    const lane = gatewayLane(request.method,getPath(request),request.headers,runtime.config.mailGatewayToken);
    const buckets = lane ? protocol : peers;
    if (!(snsIngress(getPath(request)) && request.method==='POST')) {
      const key = lane ?? address;
      const bucket = buckets.size < 1024 || buckets.has(key) ? key : 'overflow';
      const count = (buckets.get(bucket) ?? 0) + 1; buckets.set(bucket, count);
      if (count > 6000) return admissionDenied();
    }
    const headers = new Headers(request.headers);
    for (const name of legacyClientIpHeaders) headers.delete(name);
    headers.set(clientIpHeader, address);
    headers.delete(clientNetworkHeader);
    const path = getPath(request);
    let answer = await guardPublicRequest(path, headers, await digest(address), async () => app.fetch(new Request(request, { headers }), path === '/internal/v1/analytics' ? { ...runtime, analyticsPeer: { ip: connection.incoming.socket.remoteAddress ?? '' } } : runtime));
    if (path === '/llms.txt' && request.method === 'GET' && answer.ok && siteIndex) { const head = new Headers(answer.headers); head.delete('content-length'); answer = new Response(withSiteIndex(await answer.text(), siteIndex), { status: answer.status, headers: head }); }
    const response = await dashboardFile(request, path, answer);
    // A size rejection can leave upload bytes unread. Do not offer that HTTP/1 socket for reuse.
    if (response.status === 413 && !connection.incoming.readableEnded && 'shouldKeepAlive' in connection.outgoing) connection.outgoing.shouldKeepAlive = false;
    return response;
  }, port: Number(process.env.PORT ?? 8787), hostname: process.env.HOST ?? '0.0.0.0' }, info => {
    log('info', { code: 'API_READY', port: info.port, liveSesEnabled: runtime.config.liveEnabled });
  });
  server.on('error', error => {
    logError(error, { code: 'LISTEN_FAILED' }); // Unable to bind the API port: check PORT and HOST.
    void close().then(() => { process.exitCode = 1; });
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (stopping) return; stopping = true;
    server.close(() => { void close().then(() => process.exit(0)); });
  });
} catch (error) {
  logError(error, { code: error instanceof ApiError ? error.code : 'STARTUP_FAILED' }); // Check the deployment configuration.
  process.exitCode = 1;
}
