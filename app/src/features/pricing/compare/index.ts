import { comparisonOf, type Comparison, type Entry } from '../prices.ts'
import { agentmail } from './agentmail.ts'
import { bird } from './bird.ts'
import { mailchimp } from './mailchimp.ts'
import { mailgun } from './mailgun.ts'
import { mailjet } from './mailjet.ts'
import { mandrill } from './mandrill.ts'
import { postmark } from './postmark.ts'
import { resend, resendMarketing, resendOverage, resendReceived } from './resend.ts'
import { sendgrid } from './sendgrid.ts'

// Every comparison page (/compare/<slug>), one entry each (prices.ts, Entry). A new comparison is a new file here with
// its entry, added to ENTRIES; the build makes its page, its Markdown twin, its llms.txt line, its sitemap entry and its
// structured data from that entry (app/price-pages.ts), and refuses one without its sources.
export const ENTRIES: Entry[] = [agentmail, bird, mailchimp, mailgun, mailjet, mandrill, postmark, resend, sendgrid]

export const COMPARISONS: Comparison[] = ENTRIES.map(comparisonOf)
/** The comparisons by slug, as the pages and the pre-merge check look them up. */
export const comparisons: Record<string, Comparison> = Object.fromEntries(COMPARISONS.map(c => [c.slug, c]))
/** The vendors the calculator (/pricing) prices, a row each, in this order. */
export const OFFERS = [mailchimp.offer, resend.offer, resendMarketing] as const
export { resendOverage, resendReceived }
