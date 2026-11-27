import { useState } from 'react'
import { Link } from 'react-router'
import { Scale, X } from 'lucide-react'
import { POLICY_CHANGES, policyDay } from '../../../api/src/policy-changes'
import { useSession } from '../data/context'
import { Icon, IconButton } from './ui'

// An announced change to the legal pages (api/src/policy-changes.ts), on every dashboard page of the hosted service from
// the day it was announced until it takes effect: one sentence and a link to what changes. It comes before the
// workspace's own notices, so nothing they do moves it, and its text is fixed, so it is in place on the shell's first
// paint with them. Dismiss hides it for good in this browser: local storage holds the change's name (a later change shows
// again). It goes on its own on the day the change takes effect, without a deploy.
const DISMISSED = 'nightmail.policy-notice'
const { announced, from } = POLICY_CHANGES.abuseHolds

export function PolicyBanner() {
  const multiTenant = useSession()?.identity?.multiTenant
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(DISMISSED) === 'abuseHolds' } catch { return false } })
  const now = Date.now()
  if (!multiTenant || dismissed || now < Date.parse(announced) || now >= Date.parse(from)) return null
  function dismiss() {
    try { localStorage.setItem(DISMISSED, 'abuseHolds') } catch { /* Hidden for this page load. */ }
    setDismissed(true)
  }
  return <div className="standing-banner policy-banner ui-tone--neutral" role="status" data-policy="abuseHolds">
    <Scale className="standing-banner__icon" size={16} aria-hidden="true" />
    <div className="standing-banner__text">
      <p className="standing-banner__what">From {policyDay(from)}, a workspace’s sending may be paused automatically until a person reviews it. <Link to="/legal/privacy#changes">See what changes</Link></p>
    </div>
    <IconButton className="policy-banner__dismiss" size="sm" label="Dismiss" onClick={dismiss}><Icon icon={X} size="md" /></IconButton>
  </div>
}
