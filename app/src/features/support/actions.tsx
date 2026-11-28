import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Dialog, ErrorText, StatusDot } from '../../components/ui'
import { useRequestScope } from '../../data/context'
import { supportActionsApi, type SupportAction } from '../../data/support'
import { ApiError } from '../../data/types'
import { relativeTime } from '../../lib/format'
import { actionResult, actionTitle, actionVerb, unavailable } from './store'
import { productName } from '../../../../api/src/brand'
import './support.css'

/** Nightmail's sentence for a proposed change, from its own records, with each name a person typed (a workspace, a
 *  campaign, the end of a webhook URL) put in as text and set apart. Never Markdown or HTML. */
export function ActionSummary({ action }: { action: SupportAction }) {
  const template = action.parts?.template ?? action.summary ?? ''
  const labels = action.parts?.labels ?? {}
  return <>{template.split(/(\{[a-z]+\})/g).map((piece, i) => {
    const name = /^\{([a-z]+)\}$/.exec(piece)?.[1]
    return name && Object.hasOwn(labels, name) ? <span key={i} className="support-action__name">“{labels[name]}”</span> : piece
  })}</>
}

// /support/actions/<id>: the link in an emailed answer, for a change support proposed. Only the person it was proposed to
// sees it (anyone else gets "not available"), and deciding runs with their own session: Nightmail makes the change exactly as
// its own route does, once, and the dialog says what came of it from Nightmail's answer. Decline ends it; Not now only
// closes the dialog, and the link works until the proposal expires. The dialog opens once the proposal has loaded, so it
// never grows under the reader; its status line is the expiry while it waits and the outcome after. A link cut short, or
// any other refusal of the request, reads as not available, never as the API's own words.
const ACTION_ID = /^sac_[0-9a-f]{32}$/
export function SupportActionDialog() {
  const scope = useRequestScope()
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const key = ['support-action', id]
  const valid = ACTION_ID.test(id)
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => supportActionsApi(scope).get(id, signal), staleTime: 0, enabled: valid,
    retry: (count, error) => !(error instanceof ApiError && error.status !== undefined && error.status < 500) && count < 2,
    // A test posting, or a queued test or retry, is read again until its delivery answers (two minutes after the decision).
    refetchInterval: current => { if (current.state.status === 'error') return false; const data = current.state.data; return data && actionResult(data)?.waiting && Date.now() - Date.parse(data.resolvedAt ?? new Date().toISOString()) < 120_000 ? 2500 : false } })
  const [deciding, setDeciding] = useState<'confirm' | 'decline' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const action = query.data
  const open = action?.status === 'proposed'
  async function decide(decision: 'confirm' | 'decline') {
    if (deciding) return
    setDeciding(decision); setError(null)
    try { client.setQueryData(key, await supportActionsApi(scope)[decision](id)) }
    catch (cause) { setError(cause); void query.refetch() }
    finally { setDeciding(null) }
  }
  const close = () => { if (!deciding) navigate('/overview', { replace: true }) }
  const missing = !valid || query.isError
  if (!action && !missing) return null
  return <Dialog open onOpenChange={next => { if (!next) close() }} title={action ? actionTitle(action.kind) : valid && !unavailable(query.error) ? 'Couldn’t load this change' : 'Change not available'} className="support-action-dialog"
    footer={open ? <>
      <Button disabled={Boolean(deciding)} loading={deciding === 'decline'} onClick={() => void decide('decline')}>Decline</Button>
      <Button variant="ghost" disabled={Boolean(deciding)} onClick={close}>Not now</Button>
      <Button variant="primary" disabled={Boolean(deciding)} loading={deciding === 'confirm'} onClick={() => void decide('confirm')}>{actionVerb(action.kind)}</Button>
    </> : !action && valid && !unavailable(query.error) ? <><Button onClick={close}>Close</Button><Button variant="primary" loading={query.isFetching} onClick={() => void query.refetch()}>Try again</Button></>
      : <Button onClick={close}>Close</Button>}>
    {!action ? <p className="muted">{!valid || unavailable(query.error)
        ? `${productName} support proposed this to another account, or it no longer exists. Open the link signed in to the account you use with support.`
        : <ErrorText error={query.error} />}</p>
      : <>
        <p className="support-action-dialog__summary"><ActionSummary action={action} /></p>
        <p className="support-action-dialog__status">{open
          ? <span className="muted">Proposed by {productName} support · open until it expires {relativeTime(action.expiresAt)}</span>
          : <StatusDot tone={actionResult(action)!.tone}>{actionResult(action)!.text}</StatusDot>}</p>
        {error ? <Alert tone="danger"><ErrorText error={error} /></Alert> : null}
      </>}
  </Dialog>
}
