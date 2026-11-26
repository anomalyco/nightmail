import { addresses, productName } from './brand.js';
import { wildcardMessage } from './dns-messages.js';
import { SCORE_CARD, scoreCardPath, scoreTones } from './score-card.js';

// Every email Nightmail sends a customer about their account, in one template. A notice is three short plain
// paragraphs (what happened, what it means for their mail right now, what to do next), one link and one line saying
// why it was sent. customerNotice() is pure and returns the subject with a text part and an HTML part that carry the
// same words; the HTML part sets a line length, the link as a button and its own colours, light and dark, and nothing
// else (no images). A notice never says how a check works: no score figures, rates, thresholds or provider names. The
// domain setup reminder alone also lists the DNS records to publish and links the customer's own DNS provider's page.
// The first grade's email (evaluation_finished) alone shows a figure: it opens with the sender score as the dashboard's
// card shows it when the email is made (score, grade, the daily limit then, and that moment), says what the score is in
// one sentence, and its button opens the live score.
//
// Words a customer chose (a workspace's name, a campaign's) are shown through shownName, an address through
// plainAddress and a domain through hostName, and nowhere but where a template puts them. The invitation goes to an
// address outside the workspace, so every word of it is this file's: it names the inviter by address and the
// workspace not at all (the page its link opens shows that, through shownName).
//
// The jobs that send them: standing.notify (standing.ts), billing.notify (billing/notify.ts) and account.notify
// (account-notices.ts). scripts/render-notices.ts renders every one in a mail client, for review.

export type Notice = { subject: string; text: string; html: string };
/** `records`: DNS records to publish, after the lines, each ready to copy; `link`: one more place to go, under them (a DNS provider's page). */
/** `card`: the sender score as a card above the lines (the first grade's email). */
/**
 * A paragraph of a notice: plain words, a quiet line (who and where), a line set in semibold (the one decision), or
 * someone else's words quoted (untrusted: escaped, every link shown with its real host and kept from turning into one),
 * or such words as a plain paragraph, not set apart (an agent's summary): protected the same way.
 */
export type Line = string | { text: string; tone: 'muted' | 'strong' } | { quote: string } | { untrusted: string };
/** `secondary`: a second, quieter way on: a plain link under the action's button (borderless, like everything else). */
export type Parts = { subject: string; lines: Line[]; card?: ScoreCard; records?: SetupRecord[]; link?: { label: string; url: string }; action: { label: string; url: string }; secondary?: { label: string; url: string }; why: string };
/** The sender score as the dashboard's card shows it (app/src/features/score), at the moment the email is made. */
export type ScoreCard = { score: number; grade: string; /** The daily limit then; null is none. */ daily: number | null; at: Date };
/** A DNS record as the setup reminder lists it: the name as the DNS provider asks for it (relative to the zone when known). */
export type SetupRecord = { type: string; name: string; value: string };

const escapeHtml = (v: string) => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
/** Where a link someone wrote really goes: its host as a browser reads it (after any user@ part, IDNs as punycode). */
const realHost = (link: string) => { try { return new URL(/^www\./i.test(link) ? `https://${link}` : link).hostname || null; } catch { return null; } };
/** Untrusted words with every link followed by the host it really goes to. */
const withHosts = (words: string) => words.replace(LINK, link => { const host = realHost(link); return host ? `${link} (links to ${host})` : link; });
/** Quoted words as text: each line marked, and every link followed by its real host. */
const quotedText = (words: string) => withHosts(words).split('\n').map(line => `> ${line}`).join('\n');
/**
 * Quoted words as HTML: escaped, each link followed by its real host, and a zero-width space after every dot between
 * letters and after a scheme's colon, so no mail client turns a host or link in them into something to tap.
 */
const quotedHtml = (words: string) => escapeHtml(withHosts(words))
  .replace(/([A-Za-z0-9])\.(?=[A-Za-z0-9])/g, '$1.\u200b').replace(/:\/\//g, ':\u200b//');
const lineText = (line: Line) => typeof line === 'string' ? line : 'quote' in line ? quotedText(line.quote) : 'untrusted' in line ? withHosts(line.untrusted) : line.text;
const NAME_LENGTH = 40, PHONE_DIGITS = 7;
// A word that would read as somewhere to go: an address, a URL, or labels joined by a dot (a host).
const pointsSomewhere = (word: string) => word.includes('@') || word.includes('://') || /[\p{L}\p{N}][.\u3002][\p{L}\p{N}]/u.test(word);
// The writing systems a word may be in, one at a time. Latin is its letters only (no click letters, modifier letters or
// later additions that draw as punctuation); Chinese, Japanese and Korean write one word in several scripts. A word in
// two of these, or in none (a script whose letters draw as dots, slashes or Latin capitals), is not shown.
const SCRIPTS = [/^[A-Za-z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u01bf\u01c4-\u024f\u1e00-\u1eff]+$/, /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30fc]+$/u,
  ...['Cyrillic', 'Greek', 'Arabic', 'Hebrew', 'Armenian', 'Georgian', 'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Khmer', 'Myanmar', 'Ethiopic']
    .map(script => new RegExp(`^\\p{Script=${script}}+$`, 'u'))];
const oneScript = (word: string) => { const letters = word.replace(/[\p{M}\p{Pd}0-9_'’&]+/gu, ''); return !letters || SCRIPTS.some(script => script.test(letters)); };
/**
 * A name a customer chose (a workspace's, a campaign's) as the product shows it in its own voice: a few plain words on
 * one line. Compatibility forms are folded (full-width letters and dots become the ordinary ones) and invisible
 * characters go. Words that read as an address, a URL or a host are left out whole. Of the rest only letters, digits,
 * spaces, dashes, underscores, apostrophes and "&" stay, each word in one writing system (SCRIPTS). A name with enough
 * digits for a phone number loses every word that has one. At most NAME_LENGTH characters; '' when nothing is left.
 */
export function shownName(value: string): string {
  const words = value.normalize('NFKC').replace(/\p{Cf}+/gu, '').replace(/[\p{C}\p{Z}]+/gu, ' ').split(' ')
    .filter(word => !pointsSomewhere(word))
    .flatMap(word => word.replace(/[^\p{L}\p{M}\p{N}\p{Pd}_'’&]+/gu, ' ').split(' '))
    .filter(word => (word === '&' || /[\p{L}\p{N}]/u.test(word)) && oneScript(word));
  const phone = (words.join('').match(/\p{N}/gu)?.length ?? 0) >= PHONE_DIGITS;
  const letters = [...words.filter(word => !phone || !/\p{N}/u.test(word)).join(' ')];
  return letters.length > NAME_LENGTH ? letters.slice(0, NAME_LENGTH).join('').trimEnd() + '…' : letters.join('');
}
/** An email address an account email may print: plain ASCII, lowercased, or null. */
export const plainAddress = (value: string) => value.length <= 254 && /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value) ? value.toLowerCase() : null;
/** A domain's name an account email may print: a host's letters, digits, hyphens and dots, or null. */
const hostName = (value: string) => value.length <= 253 && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value) ? value.toLowerCase() : null;
// A record's name and value as Nightmail made them: a host with underscores, and a token, a host or SPF text.
const recordName = (value: string) => value.length <= 253 && /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(value);
const recordValue = (value: string) => value.length <= 255 && /^[A-Za-z0-9 ._:=~-]+$/.test(value);
const day = (value: Date) => value.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
// A deadline to the minute: a day alone reads as "all of that day", and in most time zones the moment falls on another date.
const moment = (value: Date) => `${day(value)} at ${value.toISOString().slice(11, 16)} UTC`;
const count = (value: number) => value.toLocaleString('en-US');
const owes = (workspace: string, owed: string, since: Date | null) => since ? `${workspace} has owed ${owed} since ${day(since)}.` : `${workspace} owes ${owed}.`;

// The dashboard's canvas, ink, muted text and primary button (app/src/styles/tokens.css), light and dark. Every text
// colour comes with the background it was chosen for: the light pair inline (and as bgcolor on the body and the outer
// table), the dark pair together in one media query. A client that applies the dark query on a light pane of its own
// (Outlook on the web asks the browser, not its own theme; webmail drops the color-scheme meta) once showed #ededed
// on white, because the page left its background to the client.
const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif", MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
// Inter, where a mail client loads web fonts (Apple Mail on a Mac and an iPhone; Gmail and Outlook ignore them and keep
// the system fonts after it): the dashboard's own basic-Latin cut (app/public/fonts/inter-basic.woff2, every weight in
// one 50 KB file, served CORS-open by app/asset-headers.ts and src/server.ts) from this installation's own origin. One URL
// for every email, so loading it says nothing about who opened which; with remote content blocked the system fonts
// stand in, at the same layout. The range is the file's (app/price-pages.ts BASIC): other letters come from the fallbacks.
// Inside @media screen, which Outlook on Windows skips (a face it sees makes it drop the fallbacks for Times New Roman),
// in a <style> of its own: Outlook on the web drops a style sheet with a rule nested in @media, and with it the dark colours.
const fontFace = (origin: string) => /^https?:\/\/[^\s'"()]+$/.test(origin)
  ? `<style>@media screen{@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:swap;src:url('${origin}/fonts/inter-basic.woff2') format('woff2');unicode-range:U+0020-007E,U+00A0,U+00A9,U+00AB,U+00AE,U+00B7,U+00BB,U+00D7,U+2010-2027,U+2030,U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2212,U+2713,U+FEFF,U+FFFD}}</style>` : '';
const PAPER = '#ffffff', INK = '#171717', MUTED = '#5d5d5d';
// The button is the dashboard's primary (app/src/styles/ui.css .ui-button--primary): the text colour as a solid fill,
// #111111 with white words on light and #F2F2F2 with #111111 on dark, semibold. Its one-pixel edge, a step off the fill,
// is what keeps it visible in Gmail on Android, whose forced dark leaves a near-black fill on a near-black page.
const DARK = '.nm-page{background-color:#181818!important;color:#ededed!important}.nm-text{color:#ededed!important}.nm-quote{color:#ededed!important;border-left-color:#4a4a4a!important}.nm-why{color:#a3a3a3!important}.nm-action-cell{background-color:#f2f2f2!important;border-color:#f2f2f2!important}.nm-action{background-color:#f2f2f2!important;color:#111111!important}';

// The first grade's card: the sender score as a picture of the dashboard's card (src/score-card.ts), light where the
// client keeps light colours and dark in a client that asks for dark (Apple Mail, Outlook on the web), on a cell in the
// tile's colour whose alt text says the same facts when pictures are off (the text part says them too). Under it one quiet
// line says when they were read, which the picture can't carry (its address names only score, grade and state).
const stateLine = (c: ScoreCard) => c.daily === null ? 'No daily limit' : `Daily limit of ${count(c.daily)} for now`;
const limitNow = (c: ScoreCard) => c.daily === null ? 'No daily limit' : `A daily limit of ${count(c.daily)} recipients for now`;
/** The card's words as the text part says them. */
const cardText = (c: ScoreCard) => `Sender score: ${c.score} (grade ${c.grade}), ${limitNow(c).replace(/^./, x => x.toLowerCase())}\nAs of ${moment(c.at)}`;
function cardHtml(c: ScoreCard, origin: string) {
  const light = scoreTones(c.score, 'light'), alt = escapeHtml(`Sender score ${c.score}, grade ${c.grade}. ${stateLine(c)}.`);
  const lightPath = scoreCardPath(c.score, c.daily, 'light'), darkPath = scoreCardPath(c.score, c.daily, 'dark'), { width, height } = SCORE_CARD;
  const img = (path: string, cls: string, hidden: boolean) => `<img class="${cls}" src="${escapeHtml(origin + path)}" width="${width}" height="${height}" alt="${alt}" style="${hidden ? 'display:none;mso-hide:all;' : 'display:block;'}width:100%;max-width:${width}px;height:auto;border:0;outline:none;text-decoration:none;border-radius:16px;font-family:${FONT};font-size:16px;line-height:24px;font-weight:600;color:${light.ink}">`;
  // No picture for a limit no band sets (an operator's own): the cell says the facts in live text instead.
  const inside = lightPath && darkPath ? img(lightPath, 'nm-card-light', false) + img(darkPath, 'nm-card-dark', true)
    : `<p class="nm-card-ink" style="margin:0;padding:22px;font-size:16px;line-height:24px;font-weight:600;color:${light.ink}">${alt}</p>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${width}px"><tr><td class="nm-card" bgcolor="${light.tile}" style="border-radius:16px;background-color:${light.tile};color:${light.ink}">${inside}</td></tr></table>`
        + `<p class="nm-why" style="margin:10px 0 20px;font-size:13px;line-height:20px;color:${MUTED}">${escapeHtml(`As of ${moment(c.at)}`).replaceAll(' ', '&nbsp;')}</p>`;
}
const cardDark = (c: ScoreCard) => { const t = scoreTones(c.score, 'dark'); return `.nm-card{background-color:${t.tile}!important;color:${t.ink}!important}.nm-card-ink{color:${t.ink}!important}.nm-card-light{display:none!important}.nm-card-dark{display:block!important;color:${t.ink}!important}`; };
const page = `class="nm-page" bgcolor="${PAPER}"`, ink = (style = '') => `class="nm-text" style="margin:0 0 16px;color:${INK}${style}"`;

/**
 * One notice as an email: the same words as text and as HTML. `origin` (the dashboard's) serves its font and card.
 * Type: 16/26 for the words in a 520 px column (about 68 characters a line), 13/20 for the quiet lines; the button
 * 15/20 semibold; the footer set apart by space, not a rule.
 */
export function renderNotice(p: Parts, origin: string): Notice {
  const records = p.records ?? [];
  const text = [...p.card ? [cardText(p.card)] : [], p.lines.map(lineText).join('\n\n'), ...records.map(r => `${r.type} record\nName: ${r.name}\nValue: ${r.value}`), ...p.link ? [`${p.link.label}: ${p.link.url}`] : [], `${p.action.label}: ${p.action.url}`, ...p.secondary ? [`${p.secondary.label}: ${p.secondary.url}`] : [], p.why].join('\n\n') + '\n';
  const field = (label: string, value: string) => `<tr><td class="nm-why" style="width:40px;padding:2px 12px 2px 0;vertical-align:top;font-size:13px;line-height:20px;color:${MUTED};white-space:nowrap">${label}</td><td class="nm-text" style="padding:2px 0;font-family:${MONO};font-size:14px;line-height:20px;color:${INK};word-break:break-all">${escapeHtml(value)}</td></tr>`;
  const paragraphs = p.lines.map(line => typeof line === 'string' ? `<p ${ink()}>${escapeHtml(line)}</p>`
    : 'quote' in line ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr><td class="nm-quote" style="border-left:3px solid #d4d4d4;padding:2px 0 2px 14px;font-size:15px;line-height:24px;color:${INK};white-space:pre-wrap;word-break:break-word">${quotedHtml(line.quote)}</td></tr></table>`
    : 'untrusted' in line ? `<p ${ink()}>${quotedHtml(line.untrusted)}</p>`
    : line.tone === 'muted' ? `<p class="nm-why" style="margin:0 0 16px;font-size:13px;line-height:20px;color:${MUTED}">${escapeHtml(line.text)}</p>`
    : `<p ${ink(';font-weight:600')}>${escapeHtml(line.text)}</p>`).join('')
    + records.map(r => `<p ${ink(';margin-bottom:4px;font-weight:600')}>${escapeHtml(r.type)} record</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px">${field('Name', r.name)}${field('Value', r.value)}</table>`).join('')
    + (p.link ? `<p ${ink()}><a class="nm-text" href="${escapeHtml(p.link.url)}" style="color:${INK};text-decoration:underline;text-underline-offset:3px">${escapeHtml(p.link.label)}</a></p>` : '');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(p.subject)}</title>${fontFace(origin)}<style>:root{color-scheme:light dark;supported-color-schemes:light dark}@media (prefers-color-scheme:dark){${DARK}${p.card ? cardDark(p.card) : ''}}</style></head>`
    + `<body ${page} style="margin:0;padding:0;background-color:${PAPER};color:${INK};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ${page} style="background-color:${PAPER}"><tr><td ${page} style="padding:28px 20px 40px;background-color:${PAPER};color:${INK}">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px"><tr><td class="nm-text" style="font-family:${FONT};font-size:16px;line-height:26px;color:${INK}">`
    + `${p.card ? cardHtml(p.card, origin) : ''}${paragraphs}`
    // A table cell carries the fill, so Outlook on Windows (which pads no link) still draws the button.
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0"><tr><td class="nm-action-cell" bgcolor="#111111" style="border:1px solid #3a3a3a;border-radius:8px;background-color:#111111"><a class="nm-action" href="${escapeHtml(p.action.url)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background-color:#111111;color:#ffffff;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;text-decoration:none">${escapeHtml(p.action.label)}</a></td></tr></table>`
    + (p.secondary ? `<p class="nm-text" style="margin:16px 0 0;font-size:15px;line-height:20px;color:${INK}"><a class="nm-text" href="${escapeHtml(p.secondary.url)}" style="color:${INK};text-decoration:underline;text-underline-offset:3px">${escapeHtml(p.secondary.label)}</a></p>` : '')
    + `<p class="nm-why" style="margin:32px 0 0;font-size:13px;line-height:20px;color:${MUTED}">${escapeHtml(p.why)}</p>`
    + '</td></tr></table></td></tr></table></body></html>';
  return { subject: p.subject, text, html };
}

type Workspace = { workspace: string };
export type NoticeInput =
  | Workspace & { kind: 'paused' | 'restricted' | 'warned' | 'limit_reached' }
  /** limit: false for a workspace no daily limit applies to (exempt), which is told nothing about one. */
  | Workspace & { kind: 'resumed'; limit?: boolean; /** Marketing stays on hold after this resume. */ marketingHeld?: boolean }
  | Workspace & { kind: 'campaign_paused'; campaign: { id: string; name: string } }
  | Workspace & { kind: 'domain_unverified'; domain: { id: string; name: string } }
  | Workspace & { kind: 'domain_released'; domain: { name: string } }
  /** missing: of the domain's `total` sending records, the ones public DNS lacks or has with another value. host: where its DNS is hosted, when known. */
  /** noDns: nobody serves DNS for the domain, so the email asks to check its name instead of listing records. */
  | Workspace & { kind: 'domain_setup'; domain: { id: string; name: string }; noDns?: boolean; /** A wildcard (*.domain), and the parking host it points to, answering its missing CNAMEs. */ wildcard?: string; parking?: { owner: string; target: string }; missing: SetupRecord[]; total: number; wrong: boolean; host: { name: string; url: string | null } | null; releasesAt: Date | null }
  /** builtin: the workspace's built-in domain while it sends (builtin-domain.ts), with who it sends to and its daily cap. */
  | Workspace & { kind: 'no_domain'; builtin?: { name: string; scope: 'anyone' | 'members'; perDay: number } | null }
  /** score: the card, as the dashboard showed the score when the email was made; its daily limit, when there is one, picks the version. */
  | Workspace & { kind: 'evaluation_finished'; limited: boolean; score?: ScoreCard | null }
  | Workspace & { kind: 'low_balance'; balance: string; emails: number }
  | Workspace & { kind: 'out_of_credit'; receivingUntil: Date | null }
  | Workspace & { kind: 'recharge_failed'; last4: string | null; decline: string; taxLocation?: boolean; balance: string }
  | Workspace & { kind: 'receive_hold_soon'; owed: string; since: Date | null; holdAt: Date | null }
  | Workspace & { kind: 'receive_held'; owed: string; since: Date | null }
  | Workspace & { kind: 'credit_expiring'; amount: string; expiresAt: Date | null }
  | { kind: 'invitation'; inviter: { email: string }; role: 'owner' | 'admin' | 'member'; expiresAt: Date; acceptUrl: string }
  | { kind: 'waitlist_admitted' }
  | { kind: 'signin_link'; url: string; minutes: number };
export type NoticeKind = NoticeInput['kind'];

/**
 * The notice for one moment in a customer's account. `origin` is the dashboard's (PUBLIC_URL). Pausing has one email
 * whatever paused the workspace: the ladder, a review or the provider.
 */
export function customerNotice(origin: string, n: NoticeInput): Notice {
  const base = origin.replace(/\/$/, ''), notice = (p: Parts) => renderNotice(p, base), w = 'workspace' in n ? shownName(n.workspace) || 'your workspace' : '';
  const members = `${productName} sent this to the owners and admins of ${w}. To reach us, write to ${addresses.support}.`;
  const dashboard = { label: 'Open the dashboard', url: `${base}/overview` }, billing = (label: string) => ({ label, url: `${base}/settings#billing` });
  switch (n.kind) {
    case 'paused': return notice({ subject: `Sending is paused for ${w}`, action: dashboard, why: members, lines: [
      `${productName} has paused all sending from ${w} because of a problem with its recent mail.`,
      'Nothing is going out. Queued mail is held for 72 hours, then canceled. Receiving, inboxes and the dashboard keep working.',
      'The dashboard shows what went wrong and what happens next.'] });
    case 'restricted': return notice({ subject: `Marketing mail is on hold for ${w}`, action: dashboard, why: members, lines: [
      `${productName} has put marketing mail from ${w} on hold because of a problem with its recent mail.`,
      'Campaigns are paused and new marketing mail is refused. Receipts, password resets and other transactional mail still send.',
      'The dashboard shows what to fix and when marketing can resume.'] });
    case 'warned': return notice({ subject: `A warning about mail from ${w}`, action: dashboard, why: members, lines: [
      `There is a problem with recent mail from ${w}.`,
      'Nothing is held and your mail still sends. If it continues, marketing mail will be put on hold.',
      'The dashboard shows which mail caused it. The warning clears on its own once things improve.'] });
    case 'resumed': return notice({ subject: `Sending has resumed for ${w}`, action: dashboard, why: members, lines: [
      `Sending from ${w} is on again.`,
      `Mail that was still held is being sent, and ${n.marketingHeld ? 'new transactional mail goes out again. Marketing mail stays on hold a little longer.' : 'new mail goes out again.'}${n.limit === false ? '' : ' For now the daily limit may be lower than before.'}`,
      ...(n.limit === false ? n.marketingHeld ? ['The dashboard shows when marketing can resume.'] : [] : [n.marketingHeld ? 'The dashboard shows the limit and when marketing can resume.' : 'The dashboard shows the limit.'])] });
    case 'limit_reached': return notice({ subject: `${w} has reached its daily sending limit`, action: dashboard, why: members, lines: [
      `${w} has reached its daily sending limit.`,
      'Mail over the limit is refused for now. Room frees up over the next 24 hours, and mail already accepted is still delivered.',
      'The dashboard shows the limit and what raises it.'] });
    // The first grade: the one email that says what the sender score is, what moves it and what it changes.
    // The first grade: the card, one sentence on what the score is and what it changes, the button to the live score.
    case 'evaluation_finished': {
      const limited = n.score ? n.score.daily !== null : n.limited;
      return notice({ subject: `${w} now has a sender score`, card: n.score ?? undefined, action: { label: 'See the live score', url: `${base}/overview#sender-score` },
        why: `Sent once to the owners and admins of ${w}.`, lines: [limited
          ? 'It works like a credit score for your sending. It starts low, so a daily limit applies until it rises.'
          : 'It works like a credit score for your sending: keep it good and there’s no daily limit.'] });
    }
    case 'campaign_paused': {
      const name = shownName(n.campaign.name), campaign = name ? `the campaign "${name}"` : 'a campaign';
      return notice({ subject: name ? `The campaign "${name}" is paused` : 'A campaign is paused', action: { label: 'Open the campaign', url: `${base}/campaigns/${encodeURIComponent(n.campaign.id)}/review` }, why: members, lines: [
        `${productName} paused ${campaign} before it finished, because of a problem with its recipients or its content.`,
        'People it already reached keep their email. Nobody else is sent to until you resume it. Your other mail is not affected.',
        'The campaign’s page shows what to check before you resume or cancel it.'] });
    }
    case 'domain_unverified': {
      const host = hostName(n.domain.name), name = host ?? 'the domain';
      return notice({ subject: `${host ?? 'A domain'} is no longer verified`, action: { label: 'Open the domain', url: `${base}/domains/${encodeURIComponent(n.domain.id)}` }, why: members, lines: [
        `${productName} can no longer find the DNS records that verify ${name}.`,
        `Mail from addresses at ${name} is refused until the records are back. Your other domains are not affected.`,
        'The domain’s page lists the records to publish.'] });
    }
    case 'domain_released': {
      const host = hostName(n.domain.name), name = host ?? 'the domain';
      return notice({ subject: `${host ?? 'A domain'} was released from ${w}`, action: { label: 'Open domains', url: `${base}/domains` }, why: members, lines: [
        `${productName} removed ${name} from ${w}: the DNS records that verified it have been gone for over 30 days.`,
        `Mail from addresses at ${name} can’t be sent from ${w}, and another workspace can now add the domain. Your other domains are not affected.`,
        `If ${name} is still yours, add it again and publish the records it lists.`] });
    }
    case 'domain_setup': {
      const host = hostName(n.domain.name), name = host ?? 'the domain', provider = n.host?.name ?? null;
      if (n.noDns) return notice({ subject: host ? `No DNS found for ${host}` : 'No DNS found for your domain', action: { label: 'Open the domain', url: `${base}/domains/${encodeURIComponent(n.domain.id)}` },
        why: `${productName} sends this once for each domain, to the owners and admins of ${w}. To reach us, write to ${addresses.support}.`, lines: [
          `${host ? `${host} was` : 'A domain was'} added over an hour ago, but no DNS server answers for it, so its records can’t be published and it can’t verify.`,
          `Check the spelling, or that the domain is registered. If the name is wrong, add the right one and delete this one.${n.releasesAt ? ` If it still has no records on ${moment(n.releasesAt)}, it is released.` : ''}`] });
      const records = n.missing.filter(r => /^(?:TXT|CNAME|MX)$/.test(r.type) && recordName(r.name) && recordValue(r.value));
      const all = records.length === n.total, which = n.total === 1 ? 'its record' : all ? `all ${n.total} of its records` : `${records.length} of its ${n.total} records`;
      const gap = n.wrong ? `${which} ${records.length === 1 ? 'is' : 'are'} missing from public DNS or ${records.length === 1 ? 'has' : 'have'} another value there`
        : `public DNS doesn’t have ${n.total === 1 ? 'its record' : all ? `any of its ${n.total} records` : which} yet`;
      return notice({ subject: host ? `Finish setting up ${host}` : 'Finish setting up your domain', action: { label: 'Open the domain', url: `${base}/domains/${encodeURIComponent(n.domain.id)}` },
        why: `${productName} sends this once for each domain, to the owners and admins of ${w}. To reach us, write to ${addresses.support}.`, records,
        link: provider && n.host?.url ? { label: `Open ${provider} DNS`, url: n.host.url } : undefined, lines: [
          `${host ? `${host} was` : 'A domain was'} added over an hour ago, but ${gap}.`,
          ...(n.wildcard && /^\*\.[a-z0-9.-]+$/.test(n.wildcard) ? [wildcardMessage({ wildcard: n.wildcard, ...(n.parking && /^[A-Za-z ]{1,30}$/.test(n.parking.owner) && /^[a-z0-9.:-]{1,253}$/.test(n.parking.target) ? { parking: n.parking } : {}) }, provider)] : []),
          `Mail from addresses at ${name} can’t be sent until they are published.${n.releasesAt ? ` If the ownership record is still missing on ${moment(n.releasesAt)}, the domain is released.` : ''}`,
          provider ? `Its DNS is hosted at ${provider}. Add ${records.length === 1 ? 'this record' : 'these records'} there:` : `Add ${records.length === 1 ? 'this record' : 'these records'} where its DNS is hosted:`] });
    }
    case 'no_domain': {
      // With a built-in domain the workspace already sends, within its caps: the email asks for a domain of its own.
      const b = n.builtin, ws = w === 'your workspace' ? 'Your workspace' : w;
      return notice({ subject: b ? 'Add your own domain' : 'Add your domain to start sending', action: { label: b ? 'Add your own domain' : 'Add your domain', url: `${base}/domains` },
        why: `${productName} sends this once, to the owners and admins of ${w}. To reach us, write to ${addresses.support}.`, lines: [
          b ? `${ws} was created over an hour ago, but it has no domain of its own yet.` : `${ws} was created over an hour ago, but it has no domain yet.`,
          b ? `Until it has one, it sends from ${b.name}, ${b.scope === 'members' ? `only to its members’ own addresses, up to ${count(b.perDay)} a day` : `to anyone, up to ${count(b.perDay)} recipients a day`}. Your own domain lifts that limit.`
            : `${productName} sends from your own domain, so nothing can be sent until you add one.`,
          'It takes about 5 minutes: add the domain, then copy the records it lists to where its DNS is hosted.'] });
    }
    case 'low_balance': return notice({ subject: `The balance of ${w} is low`, action: billing('Add credit'), why: members, lines: [
      `The prepaid balance of ${w} is ${n.balance}, enough for about ${count(n.emails)} more emails.`,
      'Sending and receiving continue. When the balance reaches $0, sending pauses.',
      'You can add credit, or turn on auto-recharge, in Billing.'] });
    case 'out_of_credit': return notice({ subject: `${w} is out of credit`, action: billing('Add credit'), why: members, lines: [
      `The prepaid balance of ${w} has run out, and this month’s free emails are used.`,
      `Sending is paused until credit is added. Campaigns wait and continue on their own. Received mail still arrives${n.receivingUntil ? ` until ${day(n.receivingUntil)}` : ''}, and nothing is deleted.`,
      'Add credit in Billing and sending resumes within a minute.'] });
    case 'recharge_failed': return notice({ subject: `Auto-recharge failed for ${w}`, action: billing('Update the card'), why: members, lines: [
      `${productName} could not charge the card${n.last4 ? ` ending ${n.last4}` : ''}: ${n.decline}.`,
      `Auto-recharge is off until the card is updated. The balance is ${n.balance}, and sending continues until it reaches $0.`,
      n.taxLocation ? 'Save the card with a complete billing address in Billing, then turn auto-recharge back on. If the address is already correct, contact support to check the address on your account.' : 'Update the card in Billing, then turn auto-recharge back on.'] });
    case 'receive_hold_soon': return notice({ subject: `Received mail for ${w} will be held ${n.holdAt ? `from ${day(n.holdAt)}` : 'soon'}`, action: billing('Add credit'), why: members, lines: [
      owes(w, n.owed, n.since),
      `Sending is paused. ${n.holdAt ? `From ${day(n.holdAt)}` : 'Soon'}, new received mail is stored but not delivered to inboxes, webhooks or IMAP. Nothing is deleted.`,
      'Add credit in Billing before then and nothing is held.'] });
    case 'receive_held': return notice({ subject: `Received mail for ${w} is being held`, action: billing('Add credit'), why: members, lines: [
      owes(w, n.owed, n.since),
      'New received mail is stored but not delivered to inboxes, webhooks or IMAP. Earlier mail stays readable, and nothing is deleted.',
      'Add credit in Billing and held mail is delivered in the order it arrived.'] });
    case 'credit_expiring': return notice({ subject: `${n.amount} of credit for ${w} expires ${n.expiresAt ? `on ${day(n.expiresAt)}` : 'soon'}`, action: billing('Open Billing'), why: members, lines: [
      `${n.amount} of a top-up to ${w} is still unused, and prepaid credit expires 12 months after purchase.`,
      `Nothing changes for your mail. Usage spends the oldest credit first. Whatever is left of this credit ${n.expiresAt ? `on ${day(n.expiresAt)}` : 'then'} leaves the balance and is not refunded.`,
      'There is nothing you need to do. Billing shows the balance.'] });
    case 'invitation': {
      // To someone outside the workspace, so nothing in it is the workspace's to choose: the subject is fixed, the
      // inviter is their address, and the workspace's name is not here at all. The page the link opens shows it.
      const inviter = plainAddress(n.inviter.email);
      return notice({ subject: `You are invited to a ${productName} workspace`, action: { label: 'Accept the invitation', url: n.acceptUrl },
        why: `${productName} sent this because ${inviter ?? 'someone'} entered your address. If you were not expecting it, ignore it: nothing happens unless you accept.`, lines: [
          `${inviter ?? 'Someone'} invited you to join a workspace on ${productName} as ${n.role === 'member' ? 'a member' : `an ${n.role}`}.`,
          `The invitation is for this address only and expires on ${day(n.expiresAt)}.`,
          'To accept, sign in with this address.'] });
    }
    case 'waitlist_admitted': return notice({ subject: `You can sign in to ${productName} now`, action: { label: 'Sign in', url: `${base}/overview` },
      why: `${productName} sent this once, because this address joined the waitlist.`, lines: [
        `You asked to join ${productName} with this address. It is open to you now.`,
        'Sign in with the account you joined with. If that sign-in can’t confirm this address, you can have a sign-in link sent here. Your account is created then.'] });
    // Asked for on the page a refused sign-in lands on, by someone who may not be the person this address belongs to:
    // it says what the link does and that ignoring it is safe.
    case 'signin_link': return notice({ subject: `Your ${productName} sign-in link`, action: { label: 'Sign in', url: n.url },
      why: `${productName} sent this because a sign-in link was asked for with this address. If it wasn’t you, ignore it: nothing happens unless the link is used.`, lines: [
        `There’s a place in ${productName} for this address. Open this link, then sign in with any account: that account takes the place.`,
        `The link works once, for ${n.minutes} minutes.`] });
  }
}
