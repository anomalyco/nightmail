// Preview smoke (docs/ci.md): every API route, asked anonymously of the real Worker under `wrangler dev` (workerd)
// with the real wrangler config's assets and run_worker_first, must be answered by the Worker itself: an x-request-id
// header and a status below 500. Workers Assets answers a path outside run_worker_first with 405 (non-GET) or the
// dashboard's HTML (GET), neither with a request ID; a module that fails to load in workerd answers 503.
//   node --import tsx scripts/preview-smoke.ts <origin>
import { createOpenApiApp } from '../src/app.js';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:8799').origin;
const routes = (await createOpenApiApp()).routes.filter(r => r.path !== '*' && r.path !== '/*' && r.method !== 'ALL' && r.method !== 'OPTIONS');
const unique = [...new Map(routes.map(r => [`${r.method} ${r.path}`, r])).values()];
const sample = (path: string) => path.replace(/:([A-Za-z]+)(\{[^}]*\})?/g, (_, name: string) => /token/i.test(name) ? 'u_' + '0'.repeat(64) : `${name}_premerge`).replaceAll('*', 'premerge');
const failures: string[] = [];
let checked = 0, retried = 0;
// One request at a time. wrangler's dev proxy sometimes drops a request ("Network connection lost", a bare text/plain
// 500), on a different route each run; that one response is retried. Anything else is the answer.
// A 503 is allowed only with a documented not-ready code (public stats before their first hourly run).
const notReady = new Set(['PUBLIC_STATS_PENDING']);
for (const route of unique) {
  const path = sample(route.path), method = route.method;
  let response: Response | undefined, body = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    // No body: anonymous requests stop at authentication, and wrangler's dev proxy drops a request whose body the
    // Worker never read.
    const init: RequestInit = { method, redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { origin } };
    try { response = await fetch(origin + path, init); body = await response.text(); } catch (error) { response = undefined; body = (error as Error).message; }
    const dropped = !response || (response.status === 500 && !response.headers.get('x-request-id') && (response.headers.get('content-type') ?? '').startsWith('text/plain'));
    if (!dropped) break;
    retried++;
  }
  if (!response) { failures.push(`${method} ${route.path}: ${body}`); continue; }
  checked++;
  const id = response.headers.get('x-request-id'), type = response.headers.get('content-type') ?? '';
  let code: string | undefined;
  try { code = (JSON.parse(body) as { error?: { code?: string } }).error?.code; } catch {}
  if (!id && (response.status === 405 || type.startsWith('text/html'))) failures.push(`${method} ${route.path}: HTTP ${response.status} ${type} without x-request-id, so Workers Assets answered it. Add its prefix to run_worker_first in both wrangler configs.`);
  else if (!id) failures.push(`${method} ${route.path}: HTTP ${response.status} ${type || '(no content type)'} without x-request-id: the Worker did not answer (an uncaught error? see the wrangler log).`);
  else if (response.status >= 500 && !(response.status === 503 && code && notReady.has(code))) failures.push(`${method} ${route.path}: HTTP ${response.status} ${code ?? ''} (${id}) from the Worker on an anonymous request; see this request ID in the wrangler log.`);
}
// The homepage and the dashboard still come from assets.
for (const path of ['/', '/overview', '/logs', '/settings']) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(20_000) });
  const html = await response.text();
  if (response.status !== 200 || !html.includes('<div id="root"')) failures.push(`GET ${path}: expected the dashboard HTML from assets, got HTTP ${response.status}.`);
}
// Each price page is its own HTML file (app/price-pages.ts): assets answer its address with it (its own og:url and title,
// and noindex until it is published). A comparison that doesn't exist is the Worker's: the dashboard's HTML, as 404
// (src/site-index.ts, isMissingComparePage), so it isn't indexed.
for (const [path, own] of [['/pricing', true], ['/compare/mailchimp', true], ['/compare/resend', true], ['/compare/does-not-exist', false], ['/pricing/does-not-exist', false]] as const) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(20_000) });
  const html = await response.text();
  const page = new RegExp(`<meta property="og:url" content="[^"]*${path}" />`).test(html);
  if (response.status !== (own ? 200 : 404) || !html.includes('<div id="root"') || page !== own) failures.push(`GET ${path}: expected ${own ? 'its own page from assets' : 'the dashboard HTML as 404 from the Worker'}, got HTTP ${response.status}.`);
}
// Their Markdown twins, and llms.txt with the site's own pages under the API's (src/site-index.ts).
for (const [path, type, text] of [['/compare/resend.md', 'text/markdown', '# Nightmail vs Resend'], ['/llms-full.txt', 'text/plain', '## Nightmail vs Mailchimp'], ['/llms.txt', 'text/markdown', '/compare/resend.md']] as const) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(20_000) });
  const body = await response.text();
  if (response.status !== 200 || !response.headers.get('content-type')?.startsWith(type) || !body.includes(text)) failures.push(`GET ${path}: expected ${type} with “${text}”, got HTTP ${response.status} ${response.headers.get('content-type')}.`);
}
// Every address the sitemap lists (with the price pages' next version: ci.yml builds the dev stage's, VITE_PRICE_PAGES=verdict)
// is a page search engines may index: 200, its own og:url, and no noindex in an
// X-Robots-Tag or a robots meta (a signed-in screen's header must never reach a public page). Its Markdown twin, for each
// price page, is Markdown.
const sitemap = await (await fetch(origin + '/sitemap.xml', { signal: AbortSignal.timeout(20_000) })).text();
const listed = [...sitemap.matchAll(/<loc>https?:\/\/[^/<]+([^<]*)<\/loc>/g)].map(match => match[1] || '/');
for (const path of listed) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(20_000) });
  const html = await response.text(), robots = response.headers.get('x-robots-tag') ?? '';
  if (response.status !== 200 || /noindex/i.test(robots) || /<meta name="robots" content="[^"]*noindex/i.test(html)) failures.push(`GET ${path} (in sitemap.xml): expected an indexable 200, got HTTP ${response.status}${robots ? `, X-Robots-Tag: ${robots}` : ''}${/<meta name="robots"/.test(html) ? ', a robots meta' : ''}.`);
  if (path !== '/' && !new RegExp(`<meta property="og:url" content="[^"]*${path}" />`).test(html)) failures.push(`GET ${path} (in sitemap.xml): its HTML doesn't name it as its og:url.`);
  if (path.startsWith('/pricing/') || path.startsWith('/compare/')) {
    const twin = await fetch(origin + path + '.md', { signal: AbortSignal.timeout(20_000) });
    if (twin.status !== 200 || !twin.headers.get('content-type')?.startsWith('text/markdown')) failures.push(`GET ${path}.md: expected its Markdown twin, got HTTP ${twin.status} ${twin.headers.get('content-type')}.`);
  }
}
const missing = await fetch(origin + '/assets/does-not-exist.js');
if (missing.status !== 404) failures.push(`Missing chunk: expected 404, got ${missing.status}.`);
for (const failure of failures) console.log(`::error title=Preview smoke::${failure}`);
console.log(`Preview smoke: ${checked} of ${unique.length} routes answered by the Worker; ${retried} dropped by the dev proxy and retried; ${failures.length} problem(s).`);
if (failures.length || checked !== unique.length) process.exitCode = 1;
