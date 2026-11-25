import { BillingBanner } from './BillingBanner'
import { SetupBanner } from './SetupBanner'
import { StandingBanner } from './StandingBanner'

// The workspace's notices (sending not set up, account standing, an empty balance), on every dashboard page: the shell
// shows them over the page, and the campaign studio, which covers the shell from 900 px, over its email (campaigns.css).
export function Notices() {
  return <><SetupBanner /><StandingBanner /><BillingBanner /></>
}
