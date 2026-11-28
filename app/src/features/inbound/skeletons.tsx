import { Button, LoadingRegion, PageHeader, SkeletonText } from '../../components/ui'
import { useWorkspaceAccess } from '../../data/context'

// Mail routing's header as the page draws it before its overview arrives, over the page's own loading block.
export function ReceivingRouteSkeleton() {
  const { canAdminister } = useWorkspaceAccess()
  return <div className="stack inbound-stack receiving-page">
    <PageHeader title="Mail routing" actions={canAdminister && <Button variant="primary" disabled>New address</Button>} />
    <LoadingRegion label="Loading receiving"><div className="rcv-skeleton" aria-hidden="true"><span /><span /><span /><span /></div></LoadingRegion>
  </div>
}

/** A page under Mail routing as it draws before its data: its header and back link. A numeric title is the width of a
 *  name still loading. */
export function ReceivingPageSkeleton({ title, backTo }: { title: string | number; backTo: string }) {
  return <div className="stack inbound-stack">
    <PageHeader title={typeof title === 'number' ? <SkeletonText width={title} lineHeight={28} /> : title} backTo={backTo} />
  </div>
}
