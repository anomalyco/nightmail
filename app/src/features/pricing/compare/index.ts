import { comparisonOf, type Comparison, type Entry } from '../prices.ts'
import { agentIdentity } from './agent-identity.ts'
import { agentmail } from './agentmail.ts'
import { ahasend } from './ahasend.ts'
import { aweber } from './aweber.ts'
import { beehiiv } from './beehiiv.ts'
import { bird } from './bird.ts'
import { brevo } from './brevo.ts'
import { buttondown } from './buttondown.ts'
import { cloudMailin } from './cloudmailin.ts'
import { deadSimpleEmail } from './dead-simple-email.ts'
import { emailOctopus } from './emailoctopus.ts'
import { ghost } from './ghost.ts'
import { inkbox } from './inkbox.ts'
import { loops } from './loops.ts'
import { lumbox } from './lumbox.ts'
import { mailChannels } from './mailchannels.ts'
import { mailchimp } from './mailchimp.ts'
import { mailerLite } from './mailerlite.ts'
import { mailerSend } from './mailersend.ts'
import { mailgun } from './mailgun.ts'
import { mailjet } from './mailjet.ts'
import { mailPace } from './mailpace.ts'
import { mailsAi } from './mails-ai.ts'
import { mailtrap } from './mailtrap.ts'
import { mandrill } from './mandrill.ts'
import { nylas } from './nylas.ts'
import { postfleet } from './postfleet.ts'
import { postmark } from './postmark.ts'
import { resend, resendMarketing, resendOverage, resendReceived } from './resend.ts'
import { robotomail } from './robotomail.ts'
import { sendgrid } from './sendgrid.ts'
import { smtp2go } from './smtp2go.ts'
import { socketLabs } from './socketlabs.ts'
import { uniOne } from './unione.ts'

// Every comparison page (/compare/<slug>), one entry each (prices.ts, Entry). A new comparison is a new file here with
// its entry, added to ENTRIES; the build makes its page, its Markdown twin, its llms.txt line, its sitemap entry and its
// structured data from that entry (app/price-pages.ts), and refuses one without its sources.
export const ENTRIES: Entry[] = [
  // Agent inboxes
  agentmail, nylas, robotomail, postfleet, lumbox, mailsAi, deadSimpleEmail, agentIdentity, inkbox,
  // Developer
  resend, sendgrid, postmark, mailgun, mailjet, mandrill, bird,
  mailerSend, mailtrap, smtp2go, ahasend,
  cloudMailin, socketLabs, mailPace, uniOne, mailChannels,
  // Newsletter
  mailchimp, beehiiv, mailerLite, buttondown, emailOctopus, ghost, aweber, loops, brevo,
]

export const COMPARISONS: Comparison[] = ENTRIES.map(comparisonOf)
/** The comparisons by slug, as the pages and the pre-merge check look them up. */
export const comparisons: Record<string, Comparison> = Object.fromEntries(COMPARISONS.map(c => [c.slug, c]))
/** The vendors the calculator (/pricing) prices, a row each, in this order. */
export const OFFERS = [mailchimp.offer, resend.offer, resendMarketing] as const
export { resendOverage, resendReceived }
