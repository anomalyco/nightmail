import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query'
import { useGuardedMutation } from '../../lib/single-flight'
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, LogOut, Send, X } from 'lucide-react'
import { Alert, Button, ErrorState, ErrorText, Field, Input, useToast } from '../../components/ui'
import { LiveStatus } from '../../components/motion'
import { BootLoader } from '../../components/BootLoader'
import { ThemeToggle } from '../../components/ThemeToggle'
import { AccountSwitcher } from '../../components/AccountSwitcher'
import { AgentWaiting } from '../../components/AgentWaiting'
import { SupportHost, useSupportChat } from '../../components/SupportChat'
import { useApiMutation, useApiQuery, useRequestScope, useSession, useWorkspaceAccess } from '../../data/context'
import { connectionApi, retryableConnectionErrors, useConnectionCache } from '../../data/connections'
import { finishedStep, readDomainStep, readRegionalDomain, setDomainStep, setRegionalDomain, startStep, storedStage, useDomainStep, type OnboardingStage } from '../../data/onboarding'
import { useSaveFocus } from '../../data/focus'
import { clearLandingFocus, readLandingFocus } from '../../data/landing-focus'
import { GetStarted } from './get-started'
import { analytics } from '../../lib/analytics'
import { ConnectAwsRegional, PendingDomain, createStack, domainHint, waitingForStack } from './aws'
import { DnsWaitNote, DomainRecords, useDnsSetup, useDomain } from '../settings/domain-records'
import { queries } from '../../data/queries'
import { usePrefetchQueries } from '../../data/prefetch'
import { domainPattern, normalizeDomain } from '../../lib/domain'
import { ApiError, errorText, type ConnectionKind, type ConnectionState, type ProviderConnection } from '../../data/types'
import './onboarding.css'
import { NightmailWordmark } from '../../components/NightmailLogo'
import { productName } from '../../../../api/src/brand'
import { invalidate, resourceOf } from '../../data/invalidation'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// Bring-your-own verification is resumable; keep retrying while AWS confirms the feedback subscription.
async function retrying<T>(run: () => Promise<T>) {
  for (let attempt = 1; ; attempt++) {
    try { return await run() }
    catch (error) {
      if (attempt >= 20 || !(error instanceof ApiError && retryableConnectionErrors.has(error.code))) throw error
      await wait(3000)
    }
  }
}
const code = (error: unknown) => error instanceof ApiError ? error.code : undefined

// The connection cache keeps only a short summary on the identity; a fresh /v1/me brings back the rest (the daily
// limit, standing, domain counts) that Overview reads.
// A poll leaves a read in flight to finish: cancelling it each tick starved the session whenever /v1/me took longer than
// the tick (it never answered, so a new workspace stayed "starting").
function useRefreshIdentity() {
  const client = useQueryClient()
  return (poll = false) => { void client.invalidateQueries({ queryKey: ['identity'], exact: true }, { cancelRefetch: !poll }).catch(() => {}) }
}

// A ready connection opens the add-domain step, then lifts the gate.
function useConnectionMutation<T>(write: (input: T) => Promise<ProviderConnection | null>) {
  const client = useQueryClient()
  const sync = useConnectionCache()
  const refreshIdentity = useRefreshIdentity()
  const workspaceId = useSession()?.identity?.workspaceId
  return useGuardedMutation({
    gcTime: 0,
    mutationFn: write,
    onSuccess: connection => {
      // Hosted's steps already ran while it was provisioned: they keep the one this browser is on.
      if (connection?.state === 'ready' && workspaceId && !(connection.kind === 'shared' && readDomainStep(workspaceId) !== null)) setDomainStep(workspaceId, '')
      sync(connection)
      if (connection?.state !== 'ready') return
      refreshIdentity()
      // Regions, discovery and limits now come from the new connection.
      void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && resourceOf(query.queryKey) !== 'connection' }).catch(() => {})
    },
  })
}

// Full-page shell for /onboarding: no dashboard navigation or dashboard data. Help is in the workspace menu, and opens the
// support chat docked in the corner (a sheet on a phone), as in the dashboard.
export function OnboardingPage({ stage }: { stage: NonNullable<OnboardingStage> }) {
  const session = useSession()
  const access = useWorkspaceAccess()
  const support = useSupportChat({ hosted: access.multiTenant, staff: Boolean(session?.identity?.operator) })
  useEffect(() => { document.title = `Get started · ${productName.toLowerCase()}` }, [])
  return <div className="onboarding-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="onboarding-header">
      <span className="wordmark"><NightmailWordmark title={productName.toLowerCase()} /></span>
      <div className="onboarding-header-actions">
        <div className="onboarding-workspace"><AccountSwitcher help={support.mode ? () => support.setOpen(true) : null} /></div>
        <ThemeToggle />
        <Button variant="ghost" className="onboarding-signout" title="Sign out" onClick={() => void session?.logout()}><LogOut size={16} aria-hidden /><span className="onboarding-signout-label">Sign out</span></Button>
      </div>
    </header>
    <main id="main-content" className="page-surface onboarding-surface" tabIndex={-1}>
      {session?.notice && <div className="page-notice onboarding-notice"><Alert tone="danger" title="Invitation not accepted" onDismiss={session.dismissNotice}>{session.notice}</Alert></div>}
      <OnboardingSteps stage={stage} />
    </main>
    <AgentWaiting />
    {support.mode && <SupportHost chat={support} />}
  </div>
}

// Each step stands on its own heading: no step indicator. A step with somewhere to go back to has a Back link at its top.
type View = 'loading' | 'choose' | 'connect' | 'domain' | 'imported' | 'records' | 'start' | 'error'
const rise = (index: number) => ({ '--i': index }) as CSSProperties
// Older APIs return no count; a list is accepted too.
function importedCount(connection: ProviderConnection | null | undefined) {
  const value = (connection as { importedDomains?: unknown } | null | undefined)?.importedDomains
  return typeof value === 'number' ? value : Array.isArray(value) ? value.length : 0
}
// Connected stays on screen this long before Add domain takes over.
const CONNECTED_HOLD_MS = 1400

// One component owns every step, so the domain form keeps its input from the choice through a ready connection.
function OnboardingSteps({ stage }: { stage: NonNullable<OnboardingStage> }) {
  const client = useQueryClient()
  const toast = useToast()
  const identity = useSession()?.identity
  const workspaceId = identity?.workspaceId ?? ''
  const sending = stage.step === 'sending'
  // Hosted mail is the only way to send unless an operator offers this workspace its own AWS account.
  const offerByo = identity?.byo === true
  const choosingDomain = stage.step === 'domain' && !stage.domainId
  const sync = useConnectionCache()
  const refreshIdentity = useRefreshIdentity()
  // The chosen option shows its next step at once, while the connection request finishes.
  const [picked, setPicked] = useState<ConnectionKind | null>(null)
  // A connection being deleted (Back, or Hosted instead) is ignored until the delete lands.
  const [dropped, setDropped] = useState<string | null>(null)
  // BYO: connecting, then a short Connected moment, then Add domain.
  const [awsPhase, setAwsPhase] = useState<'idle' | 'connecting' | 'connected' | 'done'>('idle')
  // Imported domains can be skipped to add another one.
  const [addAnother, setAddAnother] = useState(false)
  const [draft, setDraft] = useState('')
  const [queued, setQueued] = useState(false)
  // A domain added while a connected AWS account sets up its region opens its records once it exists.
  const [regionalDomain, setPendingDomain] = useState(() => workspaceId ? readRegionalDomain(workspaceId) : null)
  const chooseRegional = (name: string | null) => { setRegionalDomain(workspaceId, name); setPendingDomain(name) }
  const scope = useRequestScope()
  // Polls every 3 s while a BYO setup waits on AWS (only while the page is visible) and on focus.
  const connection = useQuery({
    queryKey: ['nightmail', 'connection'],
    queryFn: ({ signal }) => connectionApi(scope).get(signal),
    // Hosted's domain step needs nothing from it (the session has the built-in domain); a connected AWS account's does.
    enabled: sending || (choosingDomain && identity?.connection?.kind === 'byo'),
    // /v1/me already says there is no connection yet, so the choice shows without another request.
    initialData: sending && identity?.connection === null ? null : undefined,
    refetchInterval: query => query.state.status === 'error' ? false : sending && picked !== 'shared' && query.state.data?.kind === 'byo' && query.state.data.state !== 'ready' ? 3000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: query => sending && query.state.data?.kind === 'byo' ? 'always' : false,
  })
  const shared = useConnectionMutation(() => connectionApi(scope).create({ kind: 'shared' }))
  const byo = useConnectionMutation(() => connectionApi(scope).create({ kind: 'byo' }))
  const current = connection.data && connection.data.id !== dropped ? connection.data : null
  // Ready from a poll (auto-verify), another tab or an admin: continue to Add domain.
  useEffect(() => {
    if (!sending || current?.state !== 'ready' || (picked === 'shared' && current.kind === 'byo')) return
    if (!(current.kind === 'shared' && readDomainStep(workspaceId) !== null)) setDomainStep(workspaceId, '')
    sync(current)
    refreshIdentity()
  }, [current?.state, current?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  function choose(kind: ConnectionKind) {
    shared.reset(); byo.reset()
    setPicked(kind)
    if (kind === 'shared') shared.mutate(undefined, { onError: () => setPicked(null) })
    else byo.mutate(undefined, { onError: () => setPicked(null) })
  }
  // Deletes the pending BYO connection without waiting for it, so leaving is instant.
  function leaveAws(next: ConnectionKind | null) {
    const pending = current
    setDropped(pending?.id ?? null)
    setAwsPhase('idle')
    shared.reset(); byo.reset()
    setPicked(next)
    if (pending?.state === 'provisioning' || pending?.state === 'failed') toast(`If you made the ${productName} stack, delete it in AWS.`, 'info')
    void client.cancelQueries({ queryKey: ['nightmail', 'connection'] })
    void (async () => {
      try { if (pending) await connectionApi(scope).remove() }
      catch (error) { if (!(error instanceof ApiError && error.status === 404)) { toast(errorText(error), 'error'); setDropped(null); setPicked(pending ? 'byo' : null); return } }
      sync(null)
      if (next === 'shared') shared.mutate(undefined, { onError: () => setPicked(null) })
    })()
  }
  // A workspace made seconds ago whose sign-up is still writing its Hosted mail (GET /v1/me's hostedSetup): the session is
  // read again until it is there, rather than starting Hosted mail here as well.
  const starting = identity?.hostedSetup === 'starting'
  useEffect(() => {
    if (!starting) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refreshIdentity(true) }, 250)
    return () => clearInterval(timer)
  }, [starting]) // eslint-disable-line react-hooks/exhaustive-deps
  // Without a choice to make, a workspace with no connection starts Hosted mail at once, as choosing it would.
  const autoHosted = sending && !offerByo && !picked && !starting && connection.data === null
  useEffect(() => { if (autoHosted && !shared.error) choose('shared') }, [autoHosted, shared.error]) // eslint-disable-line react-hooks/exhaustive-deps
  const flow: ConnectionKind | null = sending ? picked ?? current?.kind ?? (offerByo ? null : 'shared') : identity?.connection?.kind ?? null
  const ready = stage.step !== 'sending'
  if (sending && flow === 'byo' && awsPhase === 'idle') setAwsPhase('connecting')
  if (sending && flow !== 'byo' && awsPhase === 'connecting') setAwsPhase('idle')
  if (awsPhase === 'connecting' && (ready || current?.state === 'ready')) setAwsPhase('connected')
  useEffect(() => {
    if (awsPhase !== 'connected') return
    const timer = setTimeout(() => setAwsPhase('done'), CONNECTED_HOLD_MS)
    return () => clearTimeout(timer)
  }, [awsPhase])
  const connectionState: ConnectionState | 'creating' = awsPhase === 'connected' ? 'ready' : current?.kind === 'byo' ? current.state : 'creating'
  const imported = importedCount(connection.data)
  // Hosted: the built-in domain comes with the connection, so DNS can wait. A connection just made carries no summary of it
  // until the session is read again (useConnectionCache), so the step waits for that read rather than showing the form first.
  const builtin = identity?.connection?.builtinDomain
  const readingIdentity = useIsFetching({ queryKey: ['identity'], exact: true }) > 0
  // Hosted with nothing to choose opens Get started from the first frame, as if its account were set up: its connection and
  // built-in domain finish meanwhile (a test email pressed early waits for them). The steps follow what this browser stored,
  // as they will once the gate lets them (data/onboarding.ts).
  const hosted = flow === 'shared'
  const stored = useDomainStep(workspaceId)
  const step = sending && hosted ? stored === null ? { step: 'domain' as const, domainId: '' } : storedStage(stored) : stage
  const builtinReady = Boolean(builtin?.id) && builtin?.sending === 'ready'
  // No built-in domain to send from (an installation without them, or one that stopped sending): Add domain instead.
  const noBuiltin = !sending && !starting && !readingIdentity && (builtin == null || builtin.sending === 'off' || builtin.sending === 'closed')
  // A built-in domain still being set up reports pending: the session is read again until it sends.
  useEffect(() => {
    if (!hosted || sending || builtin?.sending !== 'pending') return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refreshIdentity(true) }, 1500)
    return () => clearInterval(timer)
  }, [hosted, sending, builtin?.sending]) // eslint-disable-line react-hooks/exhaustive-deps
  // Get started's agent prompt reads the built-in domain: read it now, so the prompt is ready at once.
  const prefetch = usePrefetchQueries()
  useEffect(() => { if (builtinReady && builtin?.id) void prefetch([queries.domain(builtin.id)]) }, [builtinReady, builtin?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Overview opens next: bring the identity's daily limit and counts up to date first.
  const finish = () => { analytics().track('onboarding', 'finished'); setDomainStep(workspaceId, finishedStep); refreshIdentity() }
  // A focus a landing link brought (data/landing-focus.ts) is saved for a workspace without one as onboarding opens: Overview
  // tailors its first card to it. A focus the workspace already has wins.
  const saveFocus = useSaveFocus()
  const landed = useRef(false)
  useLayoutEffect(() => {
    if (landed.current) return
    landed.current = true
    const landing = identity?.focus == null ? readLandingFocus() : null
    clearLandingFocus()
    if (landing) saveFocus([landing.focus], landing)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // After a domain of your own verifies: Get started on it.
  const next = (domainId: string) => setDomainStep(workspaceId, startStep(domainId))
  // Reached from imported domains, the form goes back there.
  const domainForm = () => <AddDomain draft={draft} onDraftChange={setDraft} queued={queued} onQueuedChange={setQueued}
    ready={stage.step === 'domain'} onBack={addAnother ? () => setAddAnother(false) : undefined}
    onAdded={id => setDomainStep(workspaceId, id)} onFinish={finish} />
  let view: View, content: ReactNode
  if (step === null) { view = 'loading'; content = <BootLoader inline /> } // Finished while still provisioning: the dashboard opens once it's ready.
  else if (step.step === 'start') { view = 'start'; content = <GetStarted domainId={step.domainId || builtin?.id || null} onFinish={finish} /> }
  else if (step.step === 'domain' && step.domainId) { const domainId = step.domainId; view = 'records'; content = <DomainSetup domainId={domainId} onContinue={() => next(domainId)} onMissing={() => setDomainStep(workspaceId, '')} /> }
  else if (awsPhase === 'connecting' || awsPhase === 'connected') {
    view = 'connect'
    content = current?.templateVersion === 'v5'
      ? <ConnectAwsRegional connection={current} onBack={() => leaveAws(offerByo ? null : 'shared')} onHosted={() => leaveAws('shared')} onChosen={chooseRegional} />
      : <ConnectAwsStep state={connectionState} connection={current} onBack={() => leaveAws(offerByo ? null : 'shared')} onHosted={() => leaveAws('shared')} />
  }
  else if (autoHosted && shared.error) { view = 'error'; content = <HostedError error={shared.error} onRetry={() => shared.reset()} /> }
  else if (sending && !picked && connection.error) { view = 'error'; content = <ErrorState error={connection.error} onRetry={() => void connection.refetch()} /> }
  else if (hosted && !noBuiltin) { view = 'start'; content = <GetStarted domainId={builtin?.id ?? null} onFinish={finish} /> }
  else if (starting && !picked && (sending || (choosingDomain && !builtin?.id))) { view = 'loading'; content = <BootLoader inline /> }
  else if ((sending && !picked && connection.isPending) || (choosingDomain && flow === 'byo' && connection.isPending)) { view = 'loading'; content = <BootLoader inline /> }
  else if (sending && !flow) { view = 'choose'; content = <ChooseSending onChoose={choose} error={shared.error ?? byo.error} /> }
  else if (choosingDomain && flow === 'byo' && regionalDomain) {
    view = 'loading'
    content = <PendingDomain name={regionalDomain} onFound={id => { chooseRegional(null); setDomainStep(workspaceId, id ?? '') }} />
  }
  else if (choosingDomain && flow === 'byo' && imported > 0 && !addAnother) {
    view = 'imported'
    content = <ImportedDomains count={imported} onContinue={next} onAddAnother={() => setAddAnother(true)} fallback={domainForm()} />
  }
  else { view = 'domain'; content = domainForm() }
  // A step fades in; the first paint and the loader stay still.
  const [frame, setFrame] = useState<{ view: View; previous: View | null }>({ view, previous: null })
  if (frame.view !== view) setFrame({ view, previous: frame.view })
  const previous = frame.view === view ? frame.previous : frame.view
  // Get started is there at once, whatever came before it.
  const motion = previous === null || view === 'loading' || view === 'start' ? undefined : 'fade'
  useEffect(() => { if (previous !== null) document.getElementById('main-content')?.scrollTo({ top: 0 }) }, [view]) // eslint-disable-line react-hooks/exhaustive-deps
  // Get started is Hosted's first step: stored, so the gate keeps it open after a test email (data/onboarding.ts).
  useEffect(() => { if (view === 'start' && stored === null) setDomainStep(workspaceId, '') }, [view, stored]) // eslint-disable-line react-hooks/exhaustive-deps
  return <div key={view} className="onboarding-step" data-motion={motion}>{content}</div>
}

/** A step's way back: a quiet text link above its heading. */
function Back({ onBack }: { onBack: () => void }) {
  return <button type="button" className="onboarding-back" onClick={onBack}><ArrowLeft size={14} aria-hidden />Back</button>
}

function connectionError(error: unknown) {
  if (code(error) === 'AWS_NOT_CONFIGURED') return 'Hosted mail isn’t available on this installation.'
  if (code(error) === 'BYO_NOT_CONFIGURED') return 'Sending through your own AWS account isn’t available on this installation.'
  if (code(error) === 'CONNECTION_EXISTS') return 'Another setup is already started. Reload to continue it.'
  return errorText(error)
}

// Each option is its name and the one fact that decides between them; the setup itself shows on the next step.
function ChooseSending({ onChoose, error }: { onChoose: (kind: ConnectionKind) => void; error: unknown }) {
  // Fixed copy, so the choice never re-wraps when a request lands; the exact steps are in Settings → Billing, under Daily limit.
  return <div className="onboarding onboarding--choice">
    <div className="onboarding-intro onboarding-intro--center onb-rise" style={rise(0)}>
      <h1 className="onboarding-title">Where should your email send from?</h1>
    </div>
    <div className="onboarding-options">
      <button type="button" className="onboarding-option onb-rise" style={rise(1)} data-analytics="onboarding/sending/hosted" onClick={() => onChoose('shared')}>
        <span className="onboarding-option-icon" aria-hidden="true"><Send size={18} /></span>
        <span className="onboarding-option-title">Hosted mail</span>
        <span className="onboarding-option-value"><strong>Unlimited in good standing</strong><span className="onboarding-option-go">Continue<ArrowRight size={16} aria-hidden /></span></span>
      </button>
      <button type="button" className="onboarding-option onb-rise" style={rise(2)} data-analytics="onboarding/sending/byo" onClick={() => onChoose('byo')}>
        <span className="onboarding-option-icon onboarding-option-icon--aws" aria-hidden="true"><AwsLogo /></span>
        <span className="onboarding-option-title">Your AWS account</span>
        <span className="onboarding-option-value"><strong>You pay AWS directly</strong><span className="onboarding-option-go">Continue<ArrowRight size={16} aria-hidden /></span></span>
      </button>
    </div>
    {error ? <ChooseError error={error} /> : null}
  </div>
}

// Starting Hosted mail by itself failed: the reason, and the same request again.
function HostedError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return <div className="onboarding onboarding--narrow">
    <Alert tone="danger" title="Couldn’t set up sending">{connectionError(error)}{error instanceof ApiError && <span className="ui-error-reference">{error.reference}</span>}<div className="ui-error-state__retry"><Button onClick={onRetry}>Try again</Button></div></Alert>
  </div>
}

// Below the cards, so on a phone it is scrolled into view when a choice fails.
function ChooseError({ error }: { error: unknown }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest' }) }, [error])
  return <div ref={ref}><Alert tone="danger">{connectionError(error)}{error instanceof ApiError && <span className="ui-error-reference">{error.reference}</span>}</Alert></div>
}

// The AWS mark: the wordmark follows the text colour, the smile stays AWS orange in both themes.
function AwsLogo() {
  return <svg viewBox="0 0 24 24" width="26" height="26">
    <path fill="currentColor" d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 0 0-.735-.136 6.02 6.02 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 5.55a1.398 1.398 0 0 1-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 0 1 .32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 0 1 .311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 0 1-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 0 1-.303.08h-.687c-.151 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32l-1.238-5.148-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 0 1-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.319.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 0 0 .415-.758.777.777 0 0 0-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 0 1-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .359.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 0 1 .24.2.43.43 0 0 1 .071.263v.375c0 .168-.064.256-.184.256a.83.83 0 0 1-.303-.096 3.652 3.652 0 0 0-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.159.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926-.144.272-.336.511-.583.703-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167z" />
    <path fill="#FF9900" d="M21.698 16.207c-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351 3.384 1.963 7.559 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.439-.2.814.287.383.607zM22.792 14.961c-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151.32-.79 1.03-2.57.695-2.994z" />
  </svg>
}

function verifyError(error: unknown, region: string) {
  switch (code(error)) {
    case 'AWS_ACCESS_DENIED': return `${productName} can’t use the role yet. Wait for the stack to show CREATE_COMPLETE in ${region}, then try again.`
    case 'EXTERNAL_ID_REQUIRED': return 'The role is missing this setup’s external ID. Delete the stack in AWS, then open the link again.'
    case 'AWS_ACCOUNT_IN_USE': return 'This AWS account is already connected to another workspace.'
    case 'AWS_ACCOUNT_MISMATCH': return 'This setup is tied to a different AWS account. Start over to use this one.'
    default: return errorText(error)
  }
}

// One line per state: the live status names what is happening; the buttons above and below are what to do about it.
const connectStates: { key: ConnectionState | 'creating'; title: string }[] = [
  { key: 'creating', title: 'Preparing your AWS link…' },
  { key: 'awaiting_role', title: waitingForStack },
  { key: 'provisioning', title: 'Creating sending resources…' },
  { key: 'ready', title: 'Connected' },
  { key: 'failed', title: 'Setup didn’t finish' },
]

// BYO step 2: one task. Open AWS, watch the live status, leave any time.
function ConnectAwsStep({ state, connection, onBack, onHosted }: { state: ConnectionState | 'creating'; connection: ProviderConnection | null; onBack: () => void; onHosted: () => void }) {
  const [trouble, setTrouble] = useState(false)
  const link = connection?.quickCreateUrl
  const connected = state === 'ready'
  const active = connectStates.find(item => item.key === state) ?? connectStates[0]
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <button type="button" className="onboarding-back" onClick={onBack} disabled={connected}><ArrowLeft size={14} aria-hidden />Back</button>
      <h1 className="onboarding-title">Connect your AWS account</h1>
    </div>
    <div className="onboarding-connect-actions onb-rise" style={rise(1)} inert={connected}>
      {link ? <a className="ui-button ui-button--primary ui-button--md" href={link} target="_blank" rel="noopener noreferrer">{createStack}<ArrowUpRight size={16} aria-hidden /></a>
        : <Button variant="primary" loading>{createStack}<ArrowUpRight size={16} aria-hidden /></Button>}
      <Button variant="ghost" onClick={onHosted}>Use Hosted mail instead</Button>
    </div>
    {/* Every status is laid out in one cell, so moving from Waiting to Connected never changes the height. */}
    <div className="onboarding-connect-status onb-rise" style={rise(2)} data-state={state}>
      <span className="onboarding-connect-mark" aria-hidden="true"><span className="onboarding-connect-dot" /><Check size={14} strokeWidth={3} /><X size={14} strokeWidth={3} /></span>
      <div className="onboarding-slot">
        {connectStates.map(item => <p key={item.key} data-active={item.key === state || undefined} aria-hidden={item.key !== state || undefined}><strong>{item.key === 'ready' && connection?.awsAccountId ? `Account ${connection.awsAccountId} connected` : item.title}</strong></p>)}
      </div>
      <span className="sr-only" role="status">{active.title}</span>
    </div>
    <div className="onboarding-trouble onb-rise" style={rise(3)} inert={connected}>
      <button type="button" className="onboarding-disclosure" aria-expanded={trouble} aria-controls="onboarding-aws-trouble" onClick={() => setTrouble(open => !open)}><ChevronRight size={14} aria-hidden />Stuck? Enter account ID</button>
      {trouble && !connected && <div id="onboarding-aws-trouble" className="onboarding-trouble-body"><VerifyAccount connection={connection} /></div>}
    </div>
  </div>
}

// Fallback until auto-verify is everywhere: verify the role by its AWS account ID.
function VerifyAccount({ connection }: { connection: ProviderConnection | null }) {
  const scope = useRequestScope()
  const [account, setAccount] = useState('')
  const [accountError, setAccountError] = useState('')
  const verify = useConnectionMutation((id: string) => retrying(() => connectionApi(scope).verify(id)))
  async function submit(event: FormEvent) {
    event.preventDefault()
    const id = account.replace(/[\s-]/g, '')
    if (!/^\d{12}$/.test(id)) { setAccountError('Enter the 12-digit AWS account ID.'); return }
    setAccountError('')
    try { await verify.mutateAsync(id) } catch { /* Shown inline. */ }
  }
  return <form className="onboarding-inline-form" data-analytics="onboarding/byo/verify" onSubmit={submit} noValidate>
    <div className="onboarding-field">
      <Field label="AWS account ID" htmlFor="onboarding-aws-account" error={accountError || (verify.error ? verifyError(verify.error, connection?.region ?? 'your region') : undefined)}>
        <Input id="onboarding-aws-account" inputMode="numeric" autoComplete="off" autoFocus value={account} onChange={event => setAccount(event.target.value)} placeholder="123456789012" maxLength={14} disabled={verify.isPending} />
      </Field>
    </div>
    <Button type="submit" loading={verify.isPending} disabled={!connection} data-analytics="onboarding/byo/verify">Verify</Button>
  </form>
}

// BYO with verified domains already in SES: they're done; continue, or add another.
function ImportedDomains({ count, onContinue, onAddAnother, fallback }: { count: number; onContinue: (id: string) => void; onAddAnother: () => void; fallback: ReactNode }) {
  const domains = useApiQuery(['domains', 'onboarding-imported'], (api, signal) => api.domains.list({ page: 1, pageSize: 10, refresh: false }, signal))
  if (domains.isPending) return <BootLoader inline />
  const verified = (domains.data?.items ?? []).filter(domain => domain.status === 'verified')
  if (domains.error || verified.length === 0) return fallback
  const shown = Math.max(count, verified.length)
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <h1 className="onboarding-title">{shown === 1 ? 'Your domain is ready' : `Your ${shown} domains are ready`}</h1>
    </div>
    <ul className="onboarding-imported onb-rise" style={rise(1)}>
      {verified.map(domain => <li key={domain.id}><code>{domain.name}</code><LiveStatus state="verified" plain /></li>)}
    </ul>
    <div className="onboarding-connect-actions onb-rise" style={rise(2)}>
      <Button variant="primary" data-analytics="onboarding/domains/continue" onClick={() => onContinue(verified[0].id)}>Continue<ArrowRight size={16} aria-hidden /></Button>
      <Button variant="ghost" data-analytics="onboarding/domains/add-another" onClick={onAddAnother}>Add another domain</Button>
    </div>
  </div>
}

type AddDomainProps = { draft: string; onDraftChange: (value: string) => void; queued: boolean; onQueuedChange: (queued: boolean) => void; ready: boolean; onAdded: (id: string) => void; onFinish: () => void; onBack?: () => void }
// Before the connection is ready, a valid domain waits and is added as soon as it is.
function AddDomain({ draft, onDraftChange, queued, onQueuedChange, ready, onAdded, onFinish, onBack }: AddDomainProps) {
  const client = useQueryClient()
  const create = useApiMutation((api, name: string) => api.domains.create({ regionId: '', name }), undefined, true, invalidate.domains)
  const [invalid, setInvalid] = useState('')
  // A pasted URL or address still works: https://www.acme.com/pricing becomes acme.com.
  const value = normalizeDomain(draft)
  async function add() {
    if (!domainPattern.test(value)) { setInvalid(domainHint); return }
    setInvalid('')
    if (value !== draft) onDraftChange(value)
    if (!ready) { onQueuedChange(true); return }
    try {
      const domain = await create.mutateAsync(value)
      client.setQueryData(['nightmail', 'domain', domain.id], domain)
      onAdded(domain.id)
    } catch { /* Shown inline. */ }
  }
  useEffect(() => { if (ready && queued) { onQueuedChange(false); void add() } }, [ready, queued]) // eslint-disable-line react-hooks/exhaustive-deps
  // A domain queued while sending is set up keeps the button busy until it is added.
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      {onBack && <Back onBack={onBack} />}
      <h1 className="onboarding-title">Add your domain</h1>
    </div>
    <form className="onboarding-inline-form onb-rise" style={rise(2)} data-analytics="onboarding/domain/add" onSubmit={event => { event.preventDefault(); void add() }} noValidate>
      <div className="onboarding-field">
        <Field label="Domain" htmlFor="onboarding-domain" error={invalid || (create.error ? <ErrorText error={create.error} /> : undefined)}>
          <Input id="onboarding-domain" autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} value={draft} onChange={event => { setInvalid(''); onDraftChange(event.target.value); onQueuedChange(false) }} placeholder="acme.com" disabled={create.isPending} />
        </Field>
      </div>
      <Button type="submit" variant="primary" loading={create.isPending || queued} data-analytics="onboarding/domain/add">Add domain<ArrowRight size={16} aria-hidden /></Button>
    </form>
    <div className="onb-rise onboarding-reserve" style={rise(3)} data-hidden={!ready || undefined} inert={!ready}><button type="button" className="onboarding-skip" disabled={create.isPending} data-analytics="onboarding/domain/skip" onClick={onFinish}>Skip for now</button></div>
  </div>
}

function DomainSetup({ domainId, onContinue, onMissing }: { domainId: string; onContinue: () => void; onMissing: () => void }) {
  const domain = useDomain(domainId)
  const verified = domain.data?.status === 'verified'
  const missing = domain.error instanceof ApiError && domain.error.status === 404
  useEffect(() => { if (missing) onMissing() }, [missing]) // eslint-disable-line react-hooks/exhaustive-deps
  // Verified: show it, then carry on to the agent setup.
  useEffect(() => { if (!verified) return; const timer = setTimeout(onContinue, 2500); return () => clearTimeout(timer) }, [verified]) // eslint-disable-line react-hooks/exhaustive-deps
  // Resolved before the records show, so the one-click button never lands above visible records.
  const dns = useDnsSetup(domain.data)
  if (domain.isPending || missing || (!domain.error && dns.pending)) return <BootLoader inline />
  if (domain.error) return <ErrorState error={domain.error} onRetry={() => void domain.refetch()} />
  const current = domain.data
  const issue = !verified && current.status === 'issue'
  // The title's status says where verification is; a verified domain runs Continue's timer down and moves on by itself.
  return <div className="onboarding onboarding--wide">
    <div className="onboarding-intro onb-rise" style={rise(0)}>
      <h1 className="onboarding-title onboarding-domain-title"><span>{current.name}</span><LiveStatus state={verified ? 'verified' : issue ? 'failed' : 'pending'} /></h1>
      {issue && <Alert tone="danger">Verification stopped. Fix the records below, then press Check now on the domain’s page.</Alert>}
      <span className="sr-only" role="status">{verified ? `${current.name} is verified. Continuing to the last step.` : ''}</span>
    </div>
    <div className="onb-rise" style={rise(1)}><DomainRecords domain={current} guided setup={dns.setup} /></div>
    <div className="onb-rise" style={rise(2)}><DnsWaitNote domain={current} /></div>
    <div className="onboarding-actions">
      <Button variant="primary" className="onboarding-continue" data-timer={verified || undefined} data-analytics="onboarding/verify/continue" onClick={onContinue}>Continue<ArrowRight size={16} aria-hidden /></Button>
    </div>
  </div>
}
