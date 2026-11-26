// (With extensions: the build's config imports this file, home-tv.ts.)
import { apiKeyEnv, productName, publicOrigin, sdkPackage } from '../../../../../api/src/brand.ts'
import * as factory from '../../pricing/readable.ts'
import { formatCount, listOf, nightmail } from '../../pricing/prices.ts'
import { ASSUME, MONTHS, OPENING, RIVALS, usd, VOLUMES } from './data.ts'

// What the public pages say for readers that aren't browsers (pricing/readable.ts) when the homepage is the television
// (VITE_HOME=tv: home-tv.ts, and price-pages.ts for the files it writes). Its Markdown twin leads with the price of
// sending, then has the steps its "Copy for your agent" points agents to and the comparison its tape plays; the product
// in every page's structured data is pitched on sending at that price. Everything else is the factory homepage's.
export { jsonLd } from '../../pricing/readable.ts'

const url = (path: string) => publicOrigin + path
const { table, trademarks } = factory

/** What the homepage's pitch says: sending, at the billing code's price, with its free allowance. */
const sendingPitch = () => `${nightmail.perThousand} per 1,000 emails sent, after the first ${formatCount(nightmail.freeSent)} free every month`

/** The homepage's steps for an agent asked to set up sending (its "Copy for your agent" points here): the device flow for
 *  its own key (api/src/agent-setup.ts, the same one the dashboard's agent prompt falls back to), the docs, a first send
 *  from the workspace's built-in domain (api/src/builtin-domain.ts) and the person's own domain after it. */
function agentSteps() {
  return [
    `## For agents: set up sending`,
    `If a person asked you to send email from their project with ${productName}:`,
    [
      `1. Get your own API key with a device code: POST ${url('/v1/agent/device')} with the JSON body {"client_name":"<your name>"}. Show the person its verification_uri_complete and user_code; they sign in there (a new account signs up the same way) and approve. Poll POST ${url('/v1/agent/device/token')} with {"device_code":"<device_code>"} every interval seconds until it returns the key (AUTHORIZATION_PENDING means keep waiting).`,
      `2. Save the key as ${apiKeyEnv} in the project's environment (a gitignored .env), never in code or a commit: it's shown once.`,
      `3. Read ${url('/llms.txt')} and ${url('/docs.md')} before writing code. Use the TypeScript SDK (npm i ${sdkPackage}) or the REST API with the key as a bearer token, from server code only.`,
      `4. Send from the workspace's domain (GET /v1/domains lists it). A new workspace starts with a built-in nightmail.email domain that for now sends only to its members' own sign-in addresses, so send the first email to the person's own address with POST /v1/emails/send. 202 means queued, not delivered.`,
      `5. To email anyone else, ask the person which domain to send from, add it with POST /v1/domains and give them its DNS records; it verifies by itself once they resolve.`,
    ].join('\n'),
  ].join('\n\n')
}

/** The homepage's comparison, as its television plays it (data.ts): a month of sending at each volume, on
 *  Nightmail and on each vendor, columns in the opening page's order. */
function homeComparison() {
  const order = MONTHS[OPENING].map(line => line.slug)
  const rows = VOLUMES.map(volume => [formatCount(volume), ...order.map(slug => usd(MONTHS[volume].find(line => line.slug === slug)!.dollars))])
  return [
    `## A month of sending, compared`,
    ASSUME,
    table(['Emails a month', ...MONTHS[OPENING].map(line => line.name)], rows, order.map((_, i) => i + 1).concat(0)),
    `Prices read on each vendor’s own pricing page: ${listOf([...new Set(RIVALS.map(rival => rival.checked))].map(day => `${listOf(RIVALS.filter(rival => rival.checked === day).map(rival => `[${rival.name}](${rival.pricing})`))} on ${day}`))}.`,
    trademarks,
  ].join('\n\n')
}

/** The homepage's twin, /index.md. */
export const homeMarkdown = () => factory.homeMarkdown(`${productName} is an email API on Amazon SES: ${sendingPitch()}. Below, what a month of sending costs on it and on ${listOf(RIVALS.map(rival => rival.name))}.`, [agentSteps(), homeComparison()])

/** Each public page's Markdown twin (the homepage's is this one), and llms-full.txt made of them. */
export const markdownFiles = () => factory.markdownFiles().map(({ file, source }) => ({ file, source: file === 'index.md' ? homeMarkdown() : source }))
export const llmsFull = () => factory.llmsFull(markdownFiles())

/** A page's JSON-LD, with the product described by what the homepage pitches. */
export function structuredData(page: Parameters<typeof factory.structuredData>[0]): object {
  const data = factory.structuredData(page) as { '@graph': { '@id'?: string; description?: string; offers?: { description?: string } }[] }
  const app = data['@graph'].find(node => node['@id'] === url('/#app'))
  if (!app?.offers) throw new Error('The structured data has no product to describe (pricing/readable.ts, app).')
  app.description = `An email API on Amazon SES: ${sendingPitch()}.`
  app.offers.description = `${sendingPitch()}. Contacts and teammates: no charge.`
  return data
}
