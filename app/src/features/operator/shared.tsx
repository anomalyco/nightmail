import { useRef } from 'react'
import { Alert, Button, ErrorText, StatusBadge, type SkeletonColumn, type Tone } from '../../components/ui'
import { isoTime } from '../../data/operator'
import type { StandingStep } from '../../data/types'
import { shortDateTime } from '../../lib/format'

// What every operator view shares: its columns by key, a time in UTC, a standing step's badge, a list's Load more, and
// the audit reason its actions ask for.
export const def = (defs: SkeletonColumn[], key: string) => defs.find(column => column.key === key)!
export const when = (value: string | null | undefined) => value ? `${shortDateTime(isoTime(value))} UTC` : '—'
export const At = ({ value }: { value: string | null | undefined }) => <span className="nowrap">{when(value)}</span>
const stepTone: Record<StandingStep, Tone> = { ok: 'success', notice: 'neutral', warn: 'warning', restrict: 'warning', pause: 'danger' }
const stepLabel: Record<StandingStep, string> = { ok: 'Good', notice: 'Notice', warn: 'Warn', restrict: 'Restrict', pause: 'Pause' }
export const StepBadge = ({ step }: { step: StandingStep }) => <StatusBadge status={stepLabel[step]} tone={stepTone[step]} />

/** A paged list's Load more, and why the last page failed (the first page's failure takes the list's place). */
export function InfiniteMore({ query }: { query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown; isError: boolean; data: unknown; error: unknown } }) {
  return <>
    {query.hasNextPage && <Button className="op-more" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more</Button>}
    {query.isError && query.data !== undefined && <Alert tone="danger"><ErrorText error={query.error} /></Alert>}
  </>
}

/** The action a dialog shows: the open one, or while it closes the one it last showed, so its words don't empty mid-fade. */
export function useShown<T>(action: T | null) {
  const last = useRef(action)
  if (action) last.current = action
  return action ?? last.current
}
/** The audit log's reason for an action (or an abuse note): 10 to 1,000 characters once trimmed. */
export const reasonCheck = (reason: string) => reason.trim().length < 10 ? 'At least 10 characters.' : reason.trim().length > 1000 ? 'At most 1,000 characters.' : ''
