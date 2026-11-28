import { Button, LoadingRegion, PageHeader, Skeleton, SkeletonText } from '../../components/ui'
import { useWorkspaceAccess } from '../../data/context'

// Mail routing's loading block, shared between the route skeleton (before the inbound chunk and its CSS arrive) and the
// page while its first overview read is in flight.
export function ReceivingBodySkeleton() {
  return <LoadingRegion label="Loading receiving">
    <div className="stack">
      <Skeleton height={28} />
      <Skeleton width="60%" height={28} />
      <Skeleton width="40%" height={20} />
      <Skeleton height={440} />
    </div>
  </LoadingRegion>
}

// Mail routing's header as the page draws it before its overview arrives, over the page's own loading block.
export function ReceivingRouteSkeleton() {
  const { canAdminister } = useWorkspaceAccess()
  return <div className="stack inbound-stack">
    <PageHeader title="Mail routing" actions={canAdminister && <Button variant="primary" disabled>New address</Button>} />
    <ReceivingBodySkeleton />
  </div>
}

/** A page under Mail routing as it draws before its data: its header and back link. A numeric title is the width of a
 *  name still loading. */
export function ReceivingPageSkeleton({ title, backTo }: { title: string | number; backTo: string }) {
  return <div className="stack inbound-stack">
    <PageHeader title={typeof title === 'number' ? <SkeletonText width={title} lineHeight={28} /> : title} backTo={backTo} />
  </div>
}
