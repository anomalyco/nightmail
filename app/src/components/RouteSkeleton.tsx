import { useLocation } from 'react-router'
import { OverviewRouteSkeleton } from '../features/overview/skeletons'
import { EmailDetailSkeleton, LogsRouteSkeleton, ReceivedEmailSkeleton } from '../features/logs/skeletons'
import { isReceivedId } from '../features/logs/rows'
import { CampaignRouteSkeleton } from '../features/campaigns/skeletons'
import { NewsletterRouteSkeleton } from '../features/newsletters/skeletons'
import { AudienceRouteSkeleton } from '../features/audience/skeletons'
import { SettingsRouteSkeleton } from '../features/settings/skeletons'
import { GlassSkeleton, OperatorRouteSkeleton } from '../features/operator/skeletons'
import { SupportRouteSkeleton } from '../features/support-inbox/skeletons'
import { usePhone } from '../lib/media'
import { DocsSkeleton } from '../features/docs/frame'
import { useSession, useWorkspaceAccess } from '../data/context'
import { Button, LoadingRegion, PageHeader } from './ui'

export function RouteSkeleton() {
  const { pathname } = useLocation()
  const operator = useSession()?.identity?.operator
  const phone = usePhone()
  const [section, id, view] = pathname.split('/').filter(Boolean)
  if (!section || section === 'overview') return <OverviewRouteSkeleton />
  if (section === 'logs') return !id ? <LogsRouteSkeleton /> : isReceivedId(id) ? <ReceivedEmailSkeleton /> : <EmailDetailSkeleton />
  if (section === 'campaigns') return id === 'templates' ? <CampaignRouteSkeleton kind={view ? 'template' : 'templates'} /> : <CampaignRouteSkeleton kind={!id ? 'list' : view === 'review' ? 'review' : 'editor'} isNew={id === 'new'} />
  if (section === 'newsletters') return <NewsletterRouteSkeleton id={id} />
  if (section === 'audience') return id === 'lists' ? <AudienceRouteSkeleton kind={view ? 'list' : 'lists'} /> : id === 'segments' ? <AudienceRouteSkeleton kind={view ? 'segment' : 'segments'} isNew={view === 'new'} /> : <AudienceRouteSkeleton kind={view ? 'contact' : 'contacts'} />
  if (section === 'api-keys') return <SettingsRouteSkeleton kind="keys" />
  if (section === 'domains') return <SettingsRouteSkeleton kind={id ? 'domain' : 'domains'} />
  if (section === 'operator') return <OperatorRouteSkeleton operator={operator} />
  if (section === 'glass') return operator ? <GlassSkeleton /> : null
  if (section === 'support') return <SupportRouteSkeleton operator={operator} panel={!phone} />
  if (section === 'docs') return <DocsSkeleton />
  if (section === 'receiving' && !id) return <ReceivingRouteSkeleton />
  if (section === 'settings') return <SettingsRouteSkeleton kind={id === 'webhooks' && view ? 'webhook' : 'settings'} isNew={view === 'new'} />
  return null
}

// Receiving's header as the page draws it before its overview arrives, over the page's own loading block.
function ReceivingRouteSkeleton() {
  const { canAdminister } = useWorkspaceAccess()
  return <div className="stack inbound-stack">
    <PageHeader title="Receiving" actions={canAdminister && <Button variant="primary" disabled>New address</Button>} />
    <LoadingRegion label="Loading receiving"><div className="rcv-skeleton" aria-hidden="true"><span /><span /><span /><span /></div></LoadingRegion>
  </div>
}
