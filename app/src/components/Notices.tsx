import { BillingBanner } from './BillingBanner'
import { PolicyBanner } from './PolicyBanner'
import { SetupBanner } from './SetupBanner'
import { StandingBanner } from './StandingBanner'

// An announced change to the legal pages, then the workspace's notices (sending not set up, account standing, an empty
// balance), on every dashboard page: the shell shows them over the page, and the campaign studio, which covers the shell
// from 900 px, over its email (campaigns.css). The policy notice is one short line first, so nothing the workspace's own
// do (a link that leaves on Billing, a banner that clears) moves it.
export function Notices() {
  return <><PolicyBanner /><SetupBanner /><StandingBanner /><BillingBanner /></>
}
