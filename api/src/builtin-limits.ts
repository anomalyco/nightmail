import { productName } from './brand.js';

/**
 * What a built-in domain (builtin-domain.ts) may send, in words and numbers, without runtime imports so the dashboard
 * and the docs say the same as the API: refusals, GET /v1/domains/{id} limits, the agent prompt and the Docs guide.
 */
/** Recipient caps by NIGHTMAIL_BUILTIN_SEND_SCOPE (SEND_LIMITS.builtin). */
export const BUILTIN_CAPS = { anyone: { perDay: 100, perMinute: 10 }, members: { perDay: 10, perMinute: 3 } } as const;
export type BuiltinScope = keyof typeof BUILTIN_CAPS;
/** The request fields a send from a built-in domain can't use, in the order a refusal lists them. */
export const BUILTIN_UNSUPPORTED = ['from', 'replyTo', 'headers', 'attachments', 'template', 'scheduledAt', 'kind', 'campaign'] as const;
export type BuiltinUnsupported = typeof BUILTIN_UNSUPPORTED[number];
/** Each field's words in a refusal: "it uses custom headers and attachments". */
export const BUILTIN_UNSUPPORTED_WORDS: Record<BuiltinUnsupported, string> = { from: 'a subdomain of it as From', replyTo: 'a Reply-To elsewhere', headers: 'custom headers',
  attachments: 'attachments', template: 'a stored template', scheduledAt: 'scheduling', kind: 'kind: marketing', campaign: 'a campaign' };
const count = (n: number) => n.toLocaleString('en-US');
/** The limits in one sentence. */
export function builtinLimitsText(scope: BuiltinScope = 'anyone') {
  const caps = BUILTIN_CAPS[scope];
  if (scope === 'members') return `For now, built-in domains send only to your workspace members’ own sign-in addresses, up to ${count(caps.perDay)} a day (${count(caps.perMinute)} a minute), and only plain transactional mail: no Reply-To elsewhere, custom headers, attachments, stored templates, scheduling, marketing or campaigns. Add your own domain to email anyone and to use them.`;
  return `Built-in domains send plain transactional mail: no Reply-To elsewhere, custom headers, attachments, stored templates, scheduling, marketing or campaigns, up to ${count(caps.perDay)} recipients a day (${count(caps.perMinute)} a minute). Add your own domain to use them.`;
}
/** Where a domain of your own starts: a refusal's next step. */
export const ADD_OWN_DOMAIN = 'add your own domain: POST /v1/domains with {"name":"yourdomain.com"} (or Domains → Add domain in the dashboard), publish the DNS records it returns, then send from an address at it once it verifies';
/** The Docs guide (dashboard /docs/built-in-domain) and the API's /docs.md and /llms.txt. */
export const builtinDomainGuide = {
  id: 'built-in-domain',
  title: 'Send from the built-in domain',
  summary: 'What the domain every Hosted workspace starts with can send, to whom, and what it refuses.',
  text: `Every Hosted workspace starts with a domain of its own, such as acme-k7.nightmail.email: Domains lists it as Built-in, and connection.builtinDomain in GET /v1/me and limits in GET /v1/domains/{id} describe it. It needs no DNS and sends at once. ${builtinLimitsText('members')} (limits.scope says who yours sends to.) `
    + 'A send to anyone else is refused with 422 BUILTIN_DOMAIN_RECIPIENT, naming those recipients in error.details[0].notMembers, with sendsTo ("workspaceMembers") and nextStep (createDomain, POST /v1/domains); it is not retryable. A send that uses any of the rest is refused once, with 422 BUILTIN_DOMAIN_UNSUPPORTED naming every field it used in error.details[0].unsupported (for example ["replyTo","headers","attachments"]); past a cap it is 429 BUILTIN_DOMAIN_LIMIT with resetAt. '
    + `It receives at every address: mail to an address without an inbox or route of its own goes to its default inbox, hello@ the domain, and replies from there (POST /v1/inbound/threads/{threadId}/reply) follow the same rules and caps: while it sends to members only, a reply to anyone outside the workspace gets the same 422 BUILTIN_DOMAIN_RECIPIENT, and answering them needs a domain of your own. Where connection.builtinDomain.repliesToSenders is true, a reply may go once to the sender of the message it answers, alone, when that sender passed authentication and the message isn't automated, within a daily count for the workspace; never to another built-in domain or to one of ${productName}’s own addresses except support, so an agent can answer what ${productName} support sent it; otherwise error.details[0].reply says which condition it didn't meet. Once a domain of the workspace’s own verifies, the built-in domain stops sending and keeps receiving: a send from it then gets 409 OWN_DOMAIN_VERIFIED with the same address at your own domain in error.details[0].suggestedFrom (every verified domain in verifiedDomains), so switch From to your own domain as soon as it verifies. ${productName} may turn one off for abuse.`,
};

/**
 * The built-in domains' parent receives at its own name only these role addresses (RFC 2142 abuse@ and postmaster@, and
 * the DMARC and SMTP TLS reports its DNS asks for), and only for the platform workspace (NIGHTMAIL_PLATFORM_DOMAIN_WORKSPACE),
 * through a receiving host for the parent under that workspace's own built-in domain (scripts/builtin-domain.ts apex).
 * Its routes say which inbox each goes to. Mail to any other address at the parent is dropped when it arrives
 * (mailbox-receipts.ts). Null parent: off (built-in domains off, or no platform workspace).
 */
export const BUILTIN_APEX_LOCALS = ['abuse', 'postmaster', 'dmarc', 'tls-reports'] as const;
export const builtinApex = (config: { multiTenant: boolean; builtinDomain?: string; platformDomainWorkspace?: string }) => ({
  parent: config.multiTenant && config.builtinDomain && config.platformDomainWorkspace ? config.builtinDomain : null,
  workspace: config.multiTenant && config.builtinDomain ? config.platformDomainWorkspace ?? null : null,
  locals: [...BUILTIN_APEX_LOCALS] as string[],
});
