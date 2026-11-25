import { ApiError, type Config } from './core.js';
import { productName } from './brand.js';
import { SEND_LIMITS } from './send-limits.js';
import type { EmailSnapshot } from './db/sending.js';

/**
 * The shared test sender (NIGHTMAIL_TEST_SENDER, onboarding@nightmail.dev on the hosted service). A Hosted workspace
 * with no verified sending domain may send from it with POST /v1/emails/send or /batch, so a new user sees an email
 * arrive before adding a domain:
 * - only to the verified addresses of the workspace's members, at most SEND_LIMITS.testSender recipients a minute and in
 *   a rolling 24 hours;
 * - plain transactional mail under the fixed name below: no Reply-To, attachments, headers, templates, scheduling or
 *   marketing. The subject and body are the caller's, screened as every Hosted send is, with a fixed footer;
 * - recorded, billed and scored in the workspace like any send, so its Logs show it. It goes out through the platform
 *   workspace's claim on the test sender's domain (production: its adopted nightmail.dev) and that workspace's SES
 *   tenant, the only tenant the identity is associated with (send_admission routes it, migration 490; the dispatcher
 *   sends it with that workspace's connection, dispatcher.ts leaseDue). It needs regional sending.
 * Once the workspace has a verified domain the test sender is refused, naming that domain.
 */
export const TEST_SENDER_NAME = `${productName} Test`;
export const TEST_SENDER_FOOTER = `Sent with ${productName}'s test sender. Add your domain to send from your own address.`;
const LIMITS = SEND_LIMITS.testSender;
/** The API reference's words, on sendEmail and sendEmailBatch. */
export const TEST_SENDER_NOTE = `Test sender (Hosted): until this workspace has a verified domain, send from the address GET /v1/me returns as testSender.address. It sends only to the verified addresses of the workspace's members (422 TEST_SENDER_RECIPIENT), at most ${LIMITS.perMinute} recipients a minute and ${LIMITS.perDay} in 24 hours (429 TEST_SENDER_LIMIT), as plain transactional mail from "${TEST_SENDER_NAME}" with a fixed footer: no fromName, replyTo, attachments, headers, template, scheduledAt or marketing (422 TEST_SENDER_UNSUPPORTED). Once a domain verifies it answers 409 TEST_SENDER_DOMAIN_VERIFIED. It is screened, logged and billed like any send.`;

export const isTestSend = (config: Pick<Config, 'testSender'>, from: string) => !!config.testSender && from.toLowerCase() === config.testSender;

/** What the test sender doesn't send, refused before anything is looked up. A batch names the item (emails.3.replyTo). */
export function assertTestSendInput(m: { kind: string; fromName?: string; replyTo: string[]; attachments: string[]; headers?: unknown[]; template?: unknown }, scheduled: boolean, index?: number) {
  const field = m.kind === 'marketing' ? 'kind' : m.fromName !== undefined && m.fromName !== TEST_SENDER_NAME ? 'fromName' : m.replyTo.length ? 'replyTo'
    : m.attachments.length ? 'attachments' : m.headers?.length ? 'headers' : m.template ? 'template' : scheduled ? 'scheduledAt' : null;
  if (field) throw new ApiError(422, 'TEST_SENDER_UNSUPPORTED', `The test sender sends plain transactional email from "${TEST_SENDER_NAME}": no fromName, replyTo, attachments, headers, template, scheduledAt or marketing kind. Add a domain to use them.`,
    index === undefined ? field : `emails.${index}.${field}`);
}

const footerStyle = "font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#595959;margin:24px 0 0";
/** The fixed name, the mark admission and the dispatcher route by, and the footer in each part the message has. */
export function asTestSend(snapshot: EmailSnapshot) {
  snapshot.fromName = TEST_SENDER_NAME;
  snapshot.testSender = true;
  if (snapshot.text !== undefined) snapshot.text += `\n\n--\n${TEST_SENDER_FOOTER}`;
  if (snapshot.html !== undefined) {
    const footer = `<p style="${footerStyle}">${TEST_SENDER_FOOTER.replace("'", '&#39;')}</p>`, close = snapshot.html.search(/<\/body\s*>/i);
    snapshot.html = close >= 0 ? snapshot.html.slice(0, close) + footer + snapshot.html.slice(close) : snapshot.html + footer;
  }
}

/** send_admission's refusals of a test send, as the API's errors. */
export function testSenderRefusal(d: { code: string; window?: 'hour' | 'day' | 'minute'; host?: string; reason?: string | null; resetAt?: string }) {
  switch (d.code) {
    case 'TEST_SENDER_RECIPIENT': return new ApiError(422, d.code, 'The test sender only sends to your own address: the verified address of a member of this workspace. Add a domain to send to anyone.', 'to');
    case 'TEST_SENDER_DOMAIN_VERIFIED': return new ApiError(409, d.code, `This workspace has a verified domain, ${d.host}. Send from an address at it instead of the test sender.`, 'from');
    case 'TEST_SENDER_LIMIT': {
      const at = d.resetAt ? new Date(d.resetAt).toISOString() : undefined;
      return new ApiError(429, d.code, `The test sender sends at most ${LIMITS.perMinute} emails a minute and ${LIMITS.perDay} a day for each workspace; this ${d.window === 'minute' ? 'minute' : 'day'}'s are used.${at ? ` Try again after ${at}, or add a domain.` : ' Add a domain to send more.'}`, undefined, true, at);
    }
    default: return new ApiError(409, 'TEST_SENDER_UNAVAILABLE', d.reason === 'connection'
      ? `The test sender works with Hosted mail only. Add a domain to send.`
      : `The test sender is unavailable right now. Try again later, or add a domain to send.`, 'from', d.reason !== 'connection');
  }
}
