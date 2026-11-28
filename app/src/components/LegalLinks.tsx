import type { ReactNode } from 'react'
import { Link } from 'react-router'

// The public legal pages (features/legal), named here so links to them don't load the documents themselves.
export const legalLinks = [['terms', 'Terms'], ['acceptable-use', 'Acceptable use'], ['privacy', 'Privacy'], ['subprocessors', 'Subprocessors']] as const

/** Under a sign-in button: signing in accepts the Terms and the Privacy Policy, and product email with a way out (the
 *  Privacy Policy's product news and service status emails). (`after`: what runs on in the same line.) home-shell.ts paints the homepage's copy of it from the HTML. */
export function SignInConsent({ className, after }: { className?: string; after?: ReactNode }) {
  return <p className={['sign-in-consent', className].filter(Boolean).join(' ')}>By continuing you accept the <Link to="/legal/terms">Terms</Link>, <Link to="/legal/privacy">Privacy Policy</Link> and product email (unsubscribe any time).{after}</p>
}

/** The dashboard's sidebar and More sheet footer. */
export function LegalFooterLinks() {
  return <nav className="legal-footer-links" aria-label="Legal"><Link to="/legal/terms">Terms</Link><Link to="/legal/privacy">Privacy</Link><Link to="/legal">Legal</Link></nav>
}
