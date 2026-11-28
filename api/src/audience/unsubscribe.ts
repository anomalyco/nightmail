import { z, createRoute } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { errors, notFound, wrapModuleLoad } from '../core/errors.js';
import { randomSecret, digest, chargeBudget } from '../core/http.js';
import type { App, Ctx } from '../core/types.js';
import { unsubscribeTokens } from '../db/operations.js';
import { unsubscribePageLink } from '../outbound-content.js';
import { servesWorkspace } from '../link-domains.js';

/** A new unsubscribe link on `origin`, the mail's link host (src/link-domains.ts), and the token record that makes it work.
 *  `topicId`: the topic of the mail (src/topics.ts), which the link then unsubscribes from alone. */
export async function createUnsubscribeLink(origin: string, workspaceId: string, email: string, topicId: string | null = null) {
  const token = randomSecret('u_');
  return { url: `${origin.replace(/\/$/, '')}/unsubscribe/${token}`, record: { tokenHash: await digest(token), workspaceId, email: email.trim().toLowerCase(), topicId } };
}

export function registerUnsubscribe(app: App) {
  const TOKEN = /^u_[a-f0-9]{64}$/;
  // A person who opens a link that is cut short, mistyped or no longer known gets a page that says so; an API client
  // (no text/html in Accept) and a mailbox's one-click POST still get the JSON error.
  const browser = (c: Ctx) => ['GET', 'HEAD'].includes(c.req.method) && /\btext\/html\b/i.test(c.req.header('accept') ?? '');
  const invalidLink = (c: Ctx) => {
    c.header('Cache-Control', 'no-store, max-age=0'); c.header('Referrer-Policy', 'no-referrer'); c.header('X-Robots-Tag', 'noindex, nofollow'); c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    c.set('failure', { code: 'NOT_FOUND' });
    return c.html(unsubscribePage('This unsubscribe link isn’t valid', '<p>It may be incomplete or out of date. To stop these emails, use the unsubscribe link in a more recent email from the sender, or ask the sender to remove you.</p>'), 404);
  };
  // Hono serves HEAD through the read-only GET handler and drops the body.
  app.use('/unsubscribe/:token', async (c, next) => {
    if (browser(c) && !TOKEN.test(c.req.param('token') ?? '')) return invalidLink(c);
    await next();
  });
  const tokenParams = z.object({ token: z.string().regex(TOKEN) }).openapi('UnsubscribeToken');
  const invalidPage = { 404: { ...errors[404], description: 'The link is malformed or unknown: an HTML page saying so to a browser (Accept: text/html), the JSON error otherwise.', content: { ...errors[404]!.content, 'text/html': { schema: z.string() } } } };
  const pageRedirect = { 303: { description: 'The confirmation form of a campaign with its own unsubscribe page: the opt-out is recorded, then the browser continues to that page with unsubscribe_token. A one-click POST is never redirected (RFC 8058 section 3.1).', headers: { Location: { schema: { type: 'string' as const } } } } };
  for (const method of ['get', 'post'] as const) app.openapi(createRoute({ method, path: '/unsubscribe/{token}', operationId: method === 'get' ? 'unsubscribeByLink' : 'unsubscribeOneClick', tags: ['Consent'], security: [], request: { params: tokenParams }, responses: { 200: { description: method === 'get' ? 'Confirmation page, or the preference page where the workspace has topics (the topics this address gets, to clear, the ones it left, and everything); GET never changes consent (link scanners prefetch footer links).' : 'Marketing consent is now unsubscribed (RFC 8058 one-click or the confirmation form); for a link from mail with a topic, the contact is unsubscribed from that topic only. The preference page\u2019s forms only remove: preferences=save records opt-outs from the topics it showed that were left unchecked (asking for a topic to be turned on is ignored and records nothing), and preferences=all unsubscribes from everything.', content: { 'text/html': { schema: z.string().openapi('UnsubscribeConfirmationHtml') } } }, ...(method === 'post' ? pageRedirect : {}), ...errors, ...(method === 'get' ? invalidPage : {}) } }), async c => {
    const raw = c.req.valid('param').token;
    const [token] = await c.env.db.select().from(unsubscribeTokens).where(eq(unsubscribeTokens.tokenHash, await digest(raw)));
    // The confirmation form may continue to the campaign's own page: browsers apply form-action to that redirect too.
    c.header('Cache-Control', 'no-store, max-age=0'); c.header('Referrer-Policy', 'no-referrer'); c.header('X-Robots-Tag', 'noindex, nofollow'); c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'${token?.pageUrl ? ` ${new URL(token.pageUrl).origin}` : ''}; frame-ancestors 'none'; base-uri 'none'`);
    if (!token || !await servesWorkspace(c.env, c.req.url, token.workspaceId)) return browser(c) ? invalidLink(c) : notFound('Unsubscribe link');
    // Link scanners and mail security gateways fetch every link in a message, so a footer GET only asks for
    // confirmation. Mailbox one-click (RFC 8058, List-Unsubscribe-Post) and the confirmation form are POSTs.
    // A page's host may contain & and quotes (a URL host allows them): written as text, never markup.
    const destination = token.pageUrl ? ` After unsubscribing, you’ll continue to ${escapeText(new URL(token.pageUrl).host)}.` : '';
    const audience = await wrapModuleLoad(() => import('./consent.js'));
    // What this link may show (src/topics.ts): the workspace's topics and this address's choices, never its address or
    // anyone else's. A workspace without topics, on a link without one, keeps the plain confirmation.
    const prefs = await audience.linkPreferences(c.env.db, token.workspaceId, token.email, token.topicId);
    const linked = prefs.linked, named = linked ? escapeText(linked.name) : '';
    if (method === 'get') {
      if (!linked && !prefs.topics.length) return c.html(unsubscribePage('Unsubscribe from marketing emails?', `<p>You will no longer receive marketing emails from this workspace.${destination}</p><form method="post"><input type="hidden" name="confirm" value="footer">${button('Unsubscribe')}</form>`), 200);
      return c.html(unsubscribePage('Email preferences', preferencesBody(prefs, destination)), 200);
    }
    const form = await c.req.parseBody({ all: true }).catch(() => ({} as Record<string, unknown>));
    // One link saves preferences at most PREFERENCE_SAVES_PER_MINUTE times a minute (a person saves a few): this bounds the
    // work a flood of Saves on one link makes. An opt-out (the mailbox's one-click, the confirmation, everything) is never
    // refused: each is one idempotent write, and refusing one would keep someone on a list because another copy of their
    // link was busy.
    if (form.preferences === 'save' && !await chargeBudget(c.env, token.workspaceId, `unsubscribe:${token.tokenHash.slice(0, 32)}`, PREFERENCE_SAVES_PER_MINUTE)) {
      c.header('Retry-After', '60');
      return c.html(unsubscribePage('Too many requests', '<p>This link was used many times in the last minute. Try again in a minute.</p>'), 429);
    }
    const list = (value: unknown) => (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter((item): item is string => typeof item === 'string');
    const again = prefs.topics.length ? '<p><a href="">Back to your email preferences</a></p>' : '';
    // The preference page's own forms: Save, and everything from a link about one topic. One-click and the confirmation
    // below never carry these fields.
    if (form.preferences === 'save') {
      const changed = await audience.recordPreferences(c.env, token.workspaceId, token.email, list(form.shown), new Set(list(form.topic)));
      if (!changed) return c.html(unsubscribePage('Nothing changed', `<p>You’re unsubscribed from all marketing emails from this sender.</p>${again}`), 200);
      // The page only removes: a topic asked to be turned on is ignored (recordPreferences), so only what was left can show here.
      const names = changed.map(choice => escapeText(choice.name)).join(', ');
      return c.html(unsubscribePage(names ? 'Preferences saved' : 'Nothing changed', `${names ? `<p>You’ll no longer receive: ${names}.</p>` : '<p>Nothing changed.</p>'}${again}`), 200);
    }
    if (form.preferences === 'all') {
      await audience.recordUnsubscribe(c.env, token.workspaceId, token.email, 'preferences');
      return c.html(unsubscribePage('You’re unsubscribed', '<p>You will no longer receive marketing emails from this sender.</p>'), 200);
    }
    const source = form.confirm === 'footer' ? 'footer-confirm' as const : 'rfc8058-post' as const;
    // A link from mail with a topic opts out of that topic alone; any other, of all marketing. The audience helpers commit
    // consent, audit, and the subscription event outbox atomically.
    if (token.topicId) await audience.recordTopicUnsubscribe(c.env, token.workspaceId, token.email, token.topicId, source);
    else await audience.recordUnsubscribe(c.env, token.workspaceId, token.email, source);
    // Only a person confirming in a browser continues to the campaign's own page; RFC 8058 forbids redirecting one-click.
    if (form.confirm === 'footer' && token.pageUrl) return c.redirect(unsubscribePageLink(token.pageUrl, raw), 303);
    if (token.topicId) return c.html(unsubscribePage('You’re unsubscribed', `<p>You will no longer receive ${linked ? `${named} emails` : 'these emails'} from this sender. Their other emails are unchanged.</p>${again}`), 200);
    return c.html(unsubscribePage('You’re unsubscribed', '<p>You will no longer receive marketing emails from this workspace.</p>'), 200);
  });
}

const PREFERENCE_SAVES_PER_MINUTE = 10;
const escapeText = (text: string) => text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
const button = (label: string, secondary = false) => `<button type="submit"${secondary ? ' class="secondary"' : ''}>${label}</button>`;
/**
 * The hosted preference page (no script, no account): the link's own topic first, as one button, then every topic of the
 * workspace as a checkbox with Save, then everything. Each is its own POST form; a GET changes nothing. A person
 * unsubscribed from everything sees that and no choices: only fresh consent, recorded by the sender, lifts it.
 */
function preferencesBody(prefs: { consent: string | null; topics: { id: string; name: string; description: string; subscribed: boolean; chosen: boolean }[]; linked: { id: string; name: string; subscribed: boolean } | null }, destination: string) {
  if (prefs.consent === 'unsubscribed') return '<p>You’re unsubscribed from all marketing emails from this sender, so you don’t get any of these. To get them again, ask the sender.</p>';
  // The page only removes. A topic the person still gets is a checkbox they can clear; one they left shows as off, with no
  // control (no name, so nothing is posted for it, script or not); an opt-in topic they never joined isn't offered at all.
  // Only a subscriber has choices: anyone else gets no marketing at all.
  const listed = prefs.consent === 'subscribed' ? prefs.topics.filter(topic => topic.subscribed || topic.chosen) : [], current = listed.some(topic => topic.subscribed);
  // The link's topic first: its button while they get it; once left, a line, unless its own row below already says so.
  const linked = prefs.linked && (prefs.linked.subscribed
    ? `<form method="post"><input type="hidden" name="confirm" value="footer"><p>Stop receiving ${escapeText(prefs.linked.name)} emails from this sender. Their other emails don’t change.${destination}</p>${button(`Unsubscribe from ${escapeText(prefs.linked.name)}`)}</form>`
    : listed.some(topic => topic.id === prefs.linked!.id) ? '' : `<p>You’ve unsubscribed from ${escapeText(prefs.linked.name)} emails. To get them again, ask the sender.</p>`);
  const text = (topic: { name: string; description: string }, note?: string) => `<span><span class="name">${escapeText(topic.name)}</span>${topic.description ? `<span class="muted">${escapeText(topic.description)}</span>` : ''}${note ? `<span class="muted">${note}</span>` : ''}</span>`;
  // With nothing left to clear there is nothing to save: the topics show without a form.
  const choices = listed.length ? `${current ? '<form method="post"><input type="hidden" name="preferences" value="save">' : '<div class="topics">'}
    <fieldset><legend>Your topics</legend>${current ? '<p class="muted hint">Clear any you no longer want, then save.</p>' : ''}${listed.map(topic => topic.subscribed
      ? `<input type="hidden" name="shown" value="${escapeText(topic.id)}"><label class="topic"><input type="checkbox" name="topic" value="${escapeText(topic.id)}" checked>${text(topic)}</label>`
      : `<div class="topic off"><input type="checkbox" disabled aria-label="${escapeText(topic.name)}: unsubscribed">${text(topic, 'You’ve unsubscribed from this. To get it again, ask the sender.')}</div>`).join('')}
    </fieldset>${current ? `${button('Save')}</form>` : '</div>'}` : '';
  // A link about one topic leaves everything with the page's own field; any other link's confirmation is today's.
  const all = prefs.linked
    ? `<form method="post"><input type="hidden" name="preferences" value="all"><p class="muted">Or stop all marketing emails from this sender.</p>${button('Unsubscribe from all', true)}</form>`
    : `<form method="post"><input type="hidden" name="confirm" value="footer"><p class="muted">Or stop all marketing emails from this sender.${destination}</p>${button('Unsubscribe from all', !!choices)}</form>`;
  return `${linked ?? ''}${choices}${all}`;
}
// Light and dark, as the reader's system is: black ink and buttons on white, or the reverse. The forms sit apart by space.
const PAGE_STYLE = `body,body *{letter-spacing:-0.01em}
body{margin:48px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#111;background:#fff}
h1{font-size:24px;line-height:1.25;margin:0 0 16px}p{margin:0 0 16px}a{color:inherit}.muted{color:#595959}
main>*+form,main>*+.topics{margin-top:32px}fieldset{border:0;padding:0;margin:0 0 16px}legend{padding:0;font-weight:600}.hint{margin:4px 0 0}
.topic{display:flex;gap:12px;align-items:flex-start;min-height:44px;padding:10px 0;cursor:pointer}.topic.off{cursor:default}.topic .name{display:block;font-weight:500}.topic .muted{display:block}
input[type=checkbox]{width:20px;height:20px;margin:2px 0 0;flex:none;accent-color:#111}
button{font:inherit;font-weight:600;padding:10px 18px;min-height:44px;border:0;border-radius:8px;cursor:pointer;background:#111;color:#fff}button.secondary{background:#ececec;color:#111}
@media (max-width:480px){body{margin:32px 24px}}
@media (prefers-color-scheme:dark){body{color:#ededed;background:#111}.muted{color:#a3a3a3}input[type=checkbox]{accent-color:#ededed}button{background:#ededed;color:#111}button.secondary{background:#2b2b2b;color:#ededed}}`;
function unsubscribePage(title: string, body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><style>${PAGE_STYLE}</style><body><main><h1>${title}</h1>${body}</main></body></html>`;
}
