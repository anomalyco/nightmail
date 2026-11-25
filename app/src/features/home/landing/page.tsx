import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { apiKeyEnv, productName, publicOrigin, sdkPackage } from '../../../../../api/src/brand'
import { EVALUATION, GOOD_STANDING } from '../../../../../api/src/standing-model'
import { SignInConsent } from '../../../components/LegalLinks'
import { CopyAction } from '../../../components/motion'
import { NightmailWordmark } from '../../../components/NightmailLogo'
import { WaitlistLine } from '../get-started'
import { formatCount, nightmail, PROVIDERS, TERMS } from './data'
import type { LandingVariant } from './variant'
import { Bars } from './bars'
import { PriceTable } from './table'
import { Curve } from './curve'

// The new homepage (Plan 2): one thin column whose one pitch is price. The wordmark, one sentence, the comparison (each
// option draws it its own way: variant.ts), the way in, four short sections and the small print. Text keeps to a 768 px
// column; a diagram may run wider. Nothing here needs a browser to draw it, so the build can paint it into the page's
// own file (landing-pages.ts) and the app takes over from that (index.tsx).

/** What "Copy for your agent" copies: the page's Markdown twin, whose steps an agent follows (pricing/readable.ts). */
export const AGENT_INSTRUCTION = `Set up ${productName} to send email from this project. Read ${publicOrigin}/index.md and follow its steps for agents.`

const SEND_EXAMPLE = `curl ${publicOrigin}/v1/emails/send \\
  -H "Authorization: Bearer $${apiKeyEnv}" \\
  -H "Content-Type: application/json" \\
  -d '{"from": "hello@yourapp.com", "to": "you@example.com",
       "subject": "Welcome", "text": "Thanks for signing up."}'`

const COMPARISON: Record<LandingVariant, () => ReactNode> = { a: () => <Bars />, b: () => <PriceTable />, c: () => <Curve /> }

/** cta: the way in (Get started, or Open dashboard for someone signed in); visitor: signed out, so the sign-in's small
 *  print shows; full: no place is open (signups-open.ts); onMachine: "See the machine" (the factory, loaded on a click). */
export type LandingProps = { variant: LandingVariant; cta: (className: string) => ReactNode; visitor: boolean; full: boolean; notice?: ReactNode; onMachine?: () => void }

export function LandingPage({ variant, cta, visitor, full, notice, onMachine }: LandingProps) {
  return <div className="landing" data-variant={variant}>
    <main className="lc-main">
      <header className="lc-head"><Link to="/" aria-label={productName} className="lc-mark-link"><NightmailWordmark className="lc-mark" title={productName} /></Link></header>
      <h1 className="lc-lead">{productName} is an email API for your app: {nightmail.perThousand}{'\u00a0'}per{'\u00a0'}1,000{'\u00a0'}emails, and {formatCount(nightmail.freeSent)}{'\u00a0'}free every month.</h1>

      {COMPARISON[variant]()}

      {notice && <div className="lc-notice">{notice}</div>}
      <div className="lc-actions">
        {cta('ui-button ui-button--primary lc-start')}
        <CopyAction value={AGENT_INSTRUCTION} label="Copy setup instructions for your agent" text="Copy for your agent" className="lc-copy" />
      </div>
      {visitor && <SignInConsent className="lc-consent" />}
      {visitor && <WaitlistLine className="lc-wait" full={full} />}

      <section className="lc-section" aria-labelledby="lc-send">
        <h2 id="lc-send">Send with one API call</h2>
        <p>Your app posts each email to one endpoint with an API key. Every delivery, bounce and complaint comes back to you as a signed webhook.</p>
        <pre className="lc-code" tabIndex={0} aria-label="Sending an email with cURL"><code>{SEND_EXAMPLE}</code></pre>
        <p className="lc-aside">Or use the TypeScript SDK: <code>npm i {sdkPackage}</code>. <Link to="/docs">API docs</Link></p>
      </section>
      <section className="lc-section" aria-labelledby="lc-domain">
        <h2 id="lc-domain">Start on our domain, then add yours</h2>
        <p>Every workspace comes with a nightmail.email domain that sends to your own team at once, with no DNS to set up. Add your own domain to email anyone; each record is checked for you.</p>
      </section>
      <section className="lc-section" aria-labelledby="lc-score">
        <h2 id="lc-score">Limits from your sender score</h2>
        <p>Your first {formatCount(EVALUATION.recipients)} recipients set a sender score from 0 to 100, and bounces, complaints and what you send keep it current. At {GOOD_STANDING} and up there’s no daily limit.</p>
      </section>
      <section className="lc-section" aria-labelledby="lc-pricing">
        <h2 id="lc-pricing">Pricing</h2>
        <p>{nightmail.perThousand} per 1,000 emails after {formatCount(nightmail.freeSent)} free every month, paid from prepaid credit: top-ups start at {nightmail.minTopUp} and last {nightmail.expiresAfterMonths} months. No plans, no seats and no charge per contact.</p>
        <p className="lc-aside">{TERMS} <Link to="/pricing">Price calculator</Link>. Compared in full: {PROVIDERS.map((c, i) => <span key={c.slug}>{i ? ', ' : ''}<Link to={c.path}>{c.offer.vendor}</Link></span>)}.</p>
      </section>
    </main>
    <footer className="lc-foot">
      <nav aria-label="More">
        <Link to="/docs">Docs</Link><Link to="/pricing">Pricing</Link><Link to="/legal/terms">Terms</Link><Link to="/legal/privacy">Privacy</Link>
        <button type="button" className="lc-machine" onClick={onMachine}>See the machine</button>
      </nav>
      <p>© 2026 <a href="https://anoma.ly">Anomaly</a></p>
    </footer>
  </div>
}
