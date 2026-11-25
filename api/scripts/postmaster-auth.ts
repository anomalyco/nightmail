// Makes NIGHTMAIL_POSTMASTER_CREDENTIALS: an OAuth grant (postmaster.traffic.readonly) for Glass's Gmail Postmaster Tools reads
// (src/glass-deliverability.ts). Needs a Google Cloud project with the Gmail Postmaster Tools API enabled and a
// "Desktop app" OAuth client in it. Sign in as the Google account that verified the domains in Postmaster Tools.
//   POSTMASTER_CLIENT_ID=… POSTMASTER_CLIENT_SECRET=… node --import tsx scripts/postmaster-auth.ts <out.json> [domain…]
// It prints a consent link, waits for Google to send the browser back to 127.0.0.1, writes {clientId, clientSecret,
// refreshToken} to <out.json> (mode 0600, never printed) and reads each domain given after it once (Postmaster Tools v2), so
// a grant that can't read a domain shows now. Set the file's contents
// as the Worker secret: wrangler secret put NIGHTMAIL_POSTMASTER_CREDENTIALS < out.json
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [out, ...domains] = process.argv.slice(2), clientId = process.env.POSTMASTER_CLIENT_ID, clientSecret = process.env.POSTMASTER_CLIENT_SECRET;
if (!out || !clientId || !clientSecret) throw new Error('Usage: POSTMASTER_CLIENT_ID=… POSTMASTER_CLIENT_SECRET=… node --import tsx scripts/postmaster-auth.ts <out.json> [domain…]');
const base64url = (bytes: Buffer) => bytes.toString('base64url'), state = base64url(randomBytes(16)), verifier = base64url(randomBytes(48));
const challenge = base64url(createHash('sha256').update(verifier).digest());
const server = createServer();
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
for (const [k, v] of Object.entries({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'https://www.googleapis.com/auth/postmaster.traffic.readonly',
  access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' })) consent.searchParams.set(k, v);
console.log(`Open this link and allow read access to Postmaster Tools:\n${consent.href}`);

const code = await new Promise<string>((resolve, reject) => server.on('request', (req, res) => {
  const url = new URL(req.url ?? '/', redirect);
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
  res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' }).end(ok ? 'Done. You can close this tab.' : 'Refused: try the link again.');
  if (ok) resolve(url.searchParams.get('code')!); else reject(new Error(url.searchParams.get('error') ?? 'The answer did not match this request.'));
}));
server.close();
// The code is good for minutes and asking again needs another click: a failed connection is tried again, three times.
const exchange = () => fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect,
  grant_type: 'authorization_code', code_verifier: verifier }) });
const res = await exchange().catch(() => exchange()).catch(() => new Promise(resolve => setTimeout(resolve, 2000)).then(exchange));
const token = await res.json() as { access_token?: string; refresh_token?: string; error?: string };
if (!res.ok || !token.refresh_token) throw new Error(`Google gave no refresh token (${token.error ?? res.status}).`);
writeFileSync(out, JSON.stringify({ clientId, clientSecret, refreshToken: token.refresh_token }), { mode: 0o600 });
console.log(`Wrote ${out}.`);
// One week of Gmail's spam rate for each domain asked about (the same query src/glass-deliverability.ts makes).
const day = (d: Date) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
for (const domain of domains) {
  const res = await fetch(`https://gmailpostmastertools.googleapis.com/v2/domains/${encodeURIComponent(domain)}/domainStats:query`, { method: 'POST',
    headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ metricDefinitions: [{ name: 'spam', baseMetric: { standardMetric: 'SPAM_RATE' } }], aggregationGranularity: 'DAILY', pageSize: 200,
      timeQuery: { dateRanges: { dateRanges: [{ start: day(new Date(Date.now() - 7 * 86_400_000)), end: day(new Date()) }] } } }) });
  const body = await res.json().catch(() => ({})) as { domainStats?: unknown[]; error?: { status?: string } };
  console.log(`${domain}: ${res.ok ? `${body.domainStats?.length ?? 0} days with data` : `refused (${body.error?.status ?? res.status})`}`);
}
