import { Link, useLocation } from 'react-router'
import { OverviewRouteSkeleton } from '../features/overview/skeletons'
import { EmailDetailSkeleton, LogsRouteSkeleton, ReceivedEmailSkeleton } from '../features/logs/skeletons'
import { isReceivedId } from '../features/logs/rows'
import { CampaignRouteSkeleton } from '../features/campaigns/skeletons'
import { AudienceRouteSkeleton } from '../features/audience/skeletons'
import { SettingsRouteSkeleton } from '../features/settings/skeletons'
import { OperatorRouteSkeleton } from '../features/operator/skeletons'
import { DocsSkeleton } from '../features/docs/frame'
import { useSession, useWorkspaceAccess } from '../data/context'
import { Button, LoadingRegion, PageHeader } from './ui'

export function RouteSkeleton() {
  const { pathname } = useLocation()
  const operator = useSession()?.identity?.operator
  const [section, id, view] = pathname.split('/').filter(Boolean)
  if (!section) return <OverviewRouteSkeleton />
  if (section === 'logs') return !id ? <LogsRouteSkeleton /> : isReceivedId(id) ? <ReceivedEmailSkeleton /> : <EmailDetailSkeleton />
  if (section === 'campaigns') return id === 'templates' ? <CampaignRouteSkeleton kind={view ? 'template' : 'templates'} /> : <CampaignRouteSkeleton kind={!id ? 'list' : view === 'review' ? 'review' : 'editor'} isNew={id === 'new'} />
  if (section === 'audience') return id === 'lists' ? <AudienceRouteSkeleton kind={view ? 'list' : 'lists'} /> : id === 'segments' ? <AudienceRouteSkeleton kind={view ? 'segment' : 'segments'} isNew={view === 'new'} /> : <AudienceRouteSkeleton kind={view ? 'contact' : 'contacts'} />
  if (section === 'api-keys') return <SettingsRouteSkeleton kind="keys" />
  if (section === 'domains') return <SettingsRouteSkeleton kind={id ? 'domain' : 'domains'} />
  if (section === 'operator') return <OperatorRouteSkeleton operator={operator} />
  if (section === 'docs') return <DocsSkeleton />
  if (section === 'receiving' && !id) return <ReceivingRouteSkeleton />
  if (section === 'settings') return <SettingsRouteSkeleton kind={id === 'webhooks' && view ? 'webhook' : 'settings'} isNew={view === 'new'} />
  return null
}

// Receiving's header as the page draws it before its overview arrives, over the page's own loading block.
function ReceivingRouteSkeleton() {
  const { canAdminister } = useWorkspaceAccess()
  return <div className="stack inbound-stack">
    <PageHeader title="Receiving" actions={<>
      {canAdminister && <Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/trace">Trace</Link>}
      {canAdminister && <Button disabled>New address</Button>}
      <Link className="ui-button ui-button--primary ui-button--md" to="/receiving/inbox">Inbox</Link>
    </>} />
    <LoadingRegion label="Loading receiving"><div className="rcv-skeleton" aria-hidden="true"><span /><span /><span /><span /></div></LoadingRegion>
  </div>
}
