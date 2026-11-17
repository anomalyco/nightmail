import type { Env } from './env.js';
import type { SupportReadinessFacts } from './bane.js';
import { repositoryUrl } from '../../api/src/brand.js';

// The support deploy's gate (.github/workflows/deploy.yml, "Support readiness"): before a new version takes traffic, the
// candidate, at 0% and carrying the deployed secrets, proves they fit its configuration. The support key reads and sends
// on exactly SUPPORT_KEY_ADDRESSES (which include SUPPORT_ADDRESS, at SUPPORT_ADDRESS_ID), the intake key on exactly
// INTAKE_ADDRESSES, both authenticate, and every one of those addresses routes to its own inbox and its own webhook
// (SUPPORT_WEBHOOK_ID or INTAKE_WEBHOOK_ID, never the other). Read-only. Keys are named to Nightmail by their SHA-256,
// as Nightmail stores them; no secret leaves the Worker and none is in the answer. A stage without SUPPORT_KEY_ADDRESSES
// (dev, which has no support mail) has nothing to prove: it answers checked: false.

type Config = Pick<Env, 'SUPPORT_ADDRESS' | 'SUPPORT_ADDRESS_ID' | 'SUPPORT_KEY_ADDRESSES' | 'INTAKE_ADDRESSES' | 'SUPPORT_WEBHOOK_ID' | 'INTAKE_WEBHOOK_ID'>;
export type ReadinessInput = { supportKey: string | null; intakeKey: string | null; facts: SupportReadinessFacts; authenticated: { support: boolean; intake: boolean } };

const list = (value: string | undefined) => (value ?? '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
export const sha256 = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');

/** What is missing for this configuration, given what Nightmail reports. Empty: ready. */
export function evaluate(config: Config, input: ReadinessInput): string[] {
  const missing: string[] = [], support = list(config.SUPPORT_KEY_ADDRESSES), intake = list(config.INTAKE_ADDRESSES), main = config.SUPPORT_ADDRESS.toLowerCase();
  const ids = new Map(input.facts.addresses.map(a => [a.address.toLowerCase(), a.id]));
  if (!support.includes(main)) missing.push(`config: SUPPORT_KEY_ADDRESSES does not list SUPPORT_ADDRESS ${main}`);
  for (const address of [...support, ...intake]) if (!ids.has(address)) missing.push(`address: ${address} does not exist in the platform workspace`);
  if (ids.has(main) && ids.get(main) !== config.SUPPORT_ADDRESS_ID) missing.push(`config: SUPPORT_ADDRESS_ID is not the ID of ${main} (${ids.get(main)})`);
  const key = (name: string, hash: string | null, wanted: string[], authenticated: boolean) => {
    if (!hash) return void missing.push(`${name}: not set`);
    const found = input.facts.keys.find(k => k.hash === hash);
    if (!found) return void missing.push(`${name}: not a key of the platform workspace`);
    if (!found.active) missing.push(`${name}: revoked or expired`);
    if (!authenticated) missing.push(`${name}: refused by the API`);
    for (const permission of ['read', 'send']) if (!found.mail.includes(permission)) missing.push(`${name}: lacks ${permission}`);
    if (!found.addresses) return void missing.push(`${name}: covers every address, not only its own`);
    const has = new Set(found.addresses.map(a => a.address.toLowerCase()));
    for (const address of wanted) if (!has.has(address)) missing.push(`${name}: does not cover ${address}`);
    for (const address of has) if (!wanted.includes(address)) missing.push(`${name}: also covers ${address}`);
  };
  key('BANE_SUPPORT_INBOX_KEY', input.supportKey, support, input.authenticated.support);
  key('BANE_INTAKE_INBOX_KEY', input.intakeKey, intake, input.authenticated.intake);
  const route = (address: string, webhook: string | undefined, other: string | undefined) => {
    const found = input.facts.routes.find(r => r.match.toLowerCase() === address), own = ids.get(address);
    if (!found) return void missing.push(`route: ${address} has none`);
    if (!found.enabled) missing.push(`route: ${address} is disabled`);
    if (own && !found.to.includes(own)) missing.push(`route: ${address} does not keep its own inbox ${own}`);
    if (!webhook || !found.to.includes(webhook)) missing.push(`route: ${address} does not go to ${webhook || 'its webhook (not configured)'}`);
    if (other && found.to.includes(other)) missing.push(`route: ${address} also goes to ${other}`);
  };
  for (const address of support) route(address, config.SUPPORT_WEBHOOK_ID, config.INTAKE_WEBHOOK_ID);
  for (const address of intake) route(address, config.INTAKE_WEBHOOK_ID, config.SUPPORT_WEBHOOK_ID);
  return missing;
}

/** Whether a key authenticates now, with a read its address scope always allows. */
async function authenticates(env: Env, key: string) {
  const response = await env.BANE_API.fetch(`${env.BANE_ORIGIN}/v1/inbound/addresses?limit=1`, { headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': 'bane-support' } });
  await response.body?.cancel();
  return response.ok;
}

export async function readiness(env: Env): Promise<{ checked: boolean; ok: boolean; missing: string[] }> {
  const support = list(env.SUPPORT_KEY_ADDRESSES), intake = list(env.INTAKE_ADDRESSES);
  if (!support.length) return { checked: false, ok: true, missing: [] };
  const supportKey = env.BANE_SUPPORT_INBOX_KEY ? await sha256(env.BANE_SUPPORT_INBOX_KEY) : null, intakeKey = env.BANE_INTAKE_INBOX_KEY ? await sha256(env.BANE_INTAKE_INBOX_KEY) : null;
  const reply = await env.BANE.readiness([supportKey, intakeKey].filter((h): h is string => h !== null), [...support, ...intake]);
  if (reply.status !== 200) return { checked: true, ok: false, missing: [`platform: readiness answered ${reply.status} ${(reply.body as { error?: { code?: string } })?.error?.code ?? ''}`.trim()] };
  const [supportOk, intakeOk] = await Promise.all([env.BANE_SUPPORT_INBOX_KEY ? authenticates(env, env.BANE_SUPPORT_INBOX_KEY) : false, env.BANE_INTAKE_INBOX_KEY ? authenticates(env, env.BANE_INTAKE_INBOX_KEY) : false]);
  const missing = evaluate(env, { supportKey, intakeKey, facts: reply.body, authenticated: { support: supportOk, intake: intakeOk } });
  return { checked: true, ok: missing.length === 0, missing };
}

// The caller: the deploy job's GitHub Actions OIDC token (RS256, GitHub's published keys), from this repository's deploy
// workflow, for this stage's environment, addressed to this Worker's origin. Anyone else gets a plain 404.
const ISSUER = 'https://token.actions.githubusercontent.com', REPOSITORY = new URL(repositoryUrl).pathname.slice(1);
let githubKeys: { at: number; keys: (JsonWebKey & { kid?: string })[] } | null = null;
async function githubKey(kid: string) {
  for (const refresh of [false, true]) {
    if (refresh || !githubKeys || Date.now() - githubKeys.at > 3_600_000) {
      const response = await fetch(`${ISSUER}/.well-known/jwks`);
      if (!response.ok) return null;
      githubKeys = { at: Date.now(), keys: ((await response.json()) as { keys: (JsonWebKey & { kid?: string })[] }).keys };
    }
    const key = githubKeys.keys.find(k => k.kid === kid);
    if (key) return key;
  }
  return null;
}
const bytes = (part: string) => Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const decode = (part: string) => JSON.parse(new TextDecoder().decode(bytes(part))) as Record<string, unknown>;

export async function deployCaller(env: Pick<Env, 'PUBLIC_URL' | 'STAGE'>, authorization: string | null, now = Date.now() / 1000) {
  const token = authorization?.match(/^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/)?.[1];
  if (!token) return false;
  const [head, body, signature] = token.split('.') as [string, string, string];
  try {
    const header = decode(head), claims = decode(body);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
    const jwk = await githubKey(header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(signature), new TextEncoder().encode(`${head}.${body}`))) return false;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return claims.iss === ISSUER && audience.includes(env.PUBLIC_URL) && claims.repository === REPOSITORY && claims.environment === env.STAGE
      && String(claims.job_workflow_ref).startsWith(`${REPOSITORY}/.github/workflows/deploy.yml@`)
      && typeof claims.exp === 'number' && claims.exp > now && (typeof claims.nbf !== 'number' || claims.nbf <= now + 60);
  } catch { return false; }
}
