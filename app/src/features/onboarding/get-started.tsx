import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Send } from 'lucide-react'
import { Button, CopyButton, ErrorText, SecretCode, Tabs } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { useApiMutation, usePublicOrigin, useSession, useWorkspaceAccess } from '../../data/context'
import { invalidate, resourceOf } from '../../data/invalidation'
import { usePrefetchRoute } from '../../data/prefetch'
import type { ApiKeyInput, Domain } from '../../data/types'
import { analytics } from '../../lib/analytics'
import { AgentPromptPanel, MaskedText, agentPrompt, useAgentSetup } from '../docs/agent-setup'
import { TestSentLine, TestSentSizer, sendLanguages, sendSnippets, useTestSend } from '../docs/first-send'
import { useDomain } from '../settings/domain-records'
import { BUILTIN_CAPS, BUILTIN_UNSUPPORTED, builtinLimitsText } from '../../../../api/src/builtin-limits'
import { Kbd, useStepKeys } from './keys'
import '../docs/developer.css'

type Tab = 'agent' | 'hand'
const tabs: { value: Tab; label: string }[] = [{ value: 'agent', label: 'Set up with your agent' }, { value: 'hand', label: 'By hand' }]
/** How long a copy waits for the domain's name before the prompt goes without it (a workspace whose Hosted mail is still
 *  being written, the first fraction of a second after sign-up). */
const DOMAIN_WAIT_MS = 8000

// Overview opens after Get started: its code and first reads load while the screen is up. A test sent here changes them,
// so they are read again then (returned: call it after the send, and again once it is delivered).
function useWarmOverview() {
  const prefetch = usePrefetchRoute('active'), client = useQueryClient()
  useEffect(() => { const timer = setTimeout(() => void prefetch('/overview'), 500); return () => clearTimeout(timer) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return () => {
    void client.invalidateQueries({ queryKey: ['identity'], exact: true }).catch(() => {})
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'nightmail' && ['overview', 'overview-setup', 'logs', 'emails', 'sender-score', 'sending-limit'].includes(resourceOf(query.queryKey)) })
      .then(() => prefetch('/overview')).catch(() => {})
  }
}

/**
 * Get started: the whole screen at once, as if the account were already set up (a new workspace's sending is ready about
 * 5 s after sign-up, and nothing here needs to wait for it). The default is setting up with your coding agent: the prompt,
 * whose copy gives the agent its own key, and its live status; By hand is an API key and a send example that runs as it is.
 * Under both, an optional test email to yourself (pressed early, it goes out by itself once sending is ready), and Skip to
 * the dashboard. `domainId` is the domain the first sends go from: Hosted's built-in domain (null for the moment its
 * Hosted mail is still being written) or a domain of your own just verified. `onFinish` ends onboarding: the dashboard
 * opens, or the page a link goes to.
 */
export function GetStarted({ domainId, onFinish }: { domainId: string | null; onFinish: () => void }) {
  const identity = useSession()?.identity
  const origin = usePublicOrigin()
  const builtin = identity?.connection?.builtinDomain
  const domain = useDomain(domainId ?? '', 0, Boolean(domainId))
  const { canAdminister } = useWorkspaceAccess()
  const setup = useAgentSetup(Boolean(identity) && canAdminister)
  const rewarm = useWarmOverview()
  const [tab, setTab] = useState<Tab>('agent')
  // Which side the shown panel comes in from: none on the first paint, then the side of the tab it belongs to.
  const [enter, setEnter] = useState<'left' | 'right' | null>(null)
  // Once something here is done (a prompt copied, a key made, a test sent), Skip reads as going on to the dashboard.
  const [acted, setActed] = useState(false)
  const shown = useRef(false)
  useEffect(() => { if (!shown.current) { shown.current = true; analytics().track('onboarding', 'start/shown') } }, [])
  useStepKeys({ enter: onFinish })

  // Hosted sends from its built-in domain, which /v1/me describes before the domain itself is read.
  const onBuiltin = !domainId || builtin?.id === domainId
  const name = onBuiltin ? builtin?.name ?? null : domain.data?.name ?? null
  // Members only (the built-in domain's scope until 25 Dec 2026, and what an installation falls back to) until /v1/me's own
  // scope is read: the prompt states the limits.
  const scope = builtin?.scope ?? 'members', perDay = builtin?.perDay ?? BUILTIN_CAPS[scope].perDay

  // The prompt names the domain: as read, else as /v1/me describes the built-in one. A copy carries a fresh setup token
  // (useAgentSetup) and, in the moment before the built-in domain exists, waits for its name.
  const promptDomain: Domain | undefined = domain.data ?? (onBuiltin && builtin?.id ? { id: builtin.id, name: builtin.name, builtIn: true, status: 'verified', regionId: '', records: [], mailFromStatus: 'not_configured', createdAt: '',
    limits: { scope, perDay, perMinute: builtin.perMinute ?? BUILTIN_CAPS[scope].perMinute, unsupported: [...BUILTIN_UNSUPPORTED], summary: builtinLimitsText(scope) } } as Domain : undefined)
  const latest = useRef(promptDomain), waiters = useRef<(() => void)[]>([])
  latest.current = promptDomain
  useEffect(() => { if (promptDomain) { waiters.current.forEach(done => done()); waiters.current = [] } }, [promptDomain])
  const promptFor = (setupToken: string | null | undefined) => agentPrompt({ origin: origin ?? window.location.origin, domain: latest.current, email: identity?.email ?? null, multiTenant: identity?.multiTenant === true, setupToken })
  const copyPrompt = async () => {
    setActed(true)
    if (!latest.current) await new Promise<void>(done => { waiters.current.push(done); setTimeout(done, DOMAIN_WAIT_MS) })
    return setup ? setup.copy(promptFor)() : promptFor(undefined)
  }
  const preview = promptFor(setup ? null : undefined)

  function pick(next: string) {
    if (next === tab) return
    setEnter(tabs.findIndex(item => item.value === next) > tabs.findIndex(item => item.value === tab) ? 'right' : 'left')
    setTab(next as Tab)
  }
  const panel = (value: Tab) => ({ role: 'tabpanel', 'aria-label': tabs.find(item => item.value === value)!.label, 'data-active': tab === value || undefined, 'data-enter': tab === value && enter ? enter : undefined, inert: tab !== value })

  // The test email goes once the domain truly sends: the built-in one as soon as its setup ends, a domain of your own now.
  const testDomain = onBuiltin ? builtin?.id ? { id: builtin.id, name: builtin.name } : null : domain.data ?? null
  const sends = domain.data?.status === 'verified'

  return <div className="onboarding onboarding--narrow onb-get-started">
    <div className="onboarding-intro">
      <h1 className="onboarding-title">Get started</h1>
    </div>
    <div className="onb-start">
      <Tabs label="How to start" value={tab} onValueChange={pick} items={tabs} />
      {/* Both panels share one cell: the taller sets its height, so switching moves nothing below them. */}
      <div className="onb-panels">
        <section className="onb-panel onb-panel--agent" {...panel('agent')}>
          <AgentPromptPanel value={copyPrompt} preview={preview} setup={setup} idle="Paste it into your coding agent." line="Paste it into your coding agent." />
        </section>
        <section className="onb-panel" {...panel('hand')}>
          <ByHand from={name} onCreated={() => setActed(true)} />
        </section>
      </div>
    </div>
    <TestEmail domain={testDomain} sends={sends} recheck={() => void domain.refetch()} onLeave={onFinish} onSent={() => { setActed(true); rewarm() }} onSettled={rewarm} />
    <div className="onboarding-actions">
      <Button onClick={onFinish} data-analytics={acted ? 'onboarding/finish' : 'onboarding/skip'}>
        <span className="onboarding-slot onb-finish-label"><span data-active={!acted || undefined} aria-hidden={acted || undefined}>Skip to dashboard</span><span data-active={acted || undefined} aria-hidden={!acted || undefined}>Go to dashboard</span></span><Kbd>↵</Kbd>
      </Button>
    </div>
  </div>
}

type TestPhase = { phase: 'idle' | 'waiting' | 'sending' } | { phase: 'sent'; id: string; ms: number; simulated?: boolean } | { phase: 'failed'; error: unknown }
/** How long a test email pressed before the domain sends waits for it here; past that it is sent anyway, and the API holds
 *  it until the domain is ready or says plainly why not. */
const TEST_WAIT_MS = 25_000

/**
 * The optional test email to your own address. Pressed before the domain sends, it is accepted at once (the button shows
 * it sending) and goes out by itself when the domain's setup ends, so its "Sent through the API in N ms" is the send alone.
 * A failure says why, with Try again. Every line it shows sits in one cell, so nothing below moves as it changes.
 */
function TestEmail({ domain, sends, recheck, onLeave, onSent, onSettled }: { domain: { id: string; name: string } | null; sends: boolean; recheck: () => void; onLeave: () => void; onSent: () => void; onSettled: () => void }) {
  const to = useSession()?.identity?.email ?? null
  const [state, setState] = useState<TestPhase>({ phase: 'idle' })
  const test = useTestSend(domain)
  const fire = () => {
    setState({ phase: 'sending' })
    test.mutate(undefined, { onSuccess: data => { setState({ phase: 'sent', id: data.id, ms: data.ms, simulated: data.simulated }); onSent() }, onError: error => setState({ phase: 'failed', error }) })
  }
  // Waiting: the domain is read again each second, and the email goes the moment it sends (or after TEST_WAIT_MS, to the
  // API's own hold).
  const waiting = state.phase === 'waiting'
  useEffect(() => {
    if (!waiting) return
    if (domain && sends) { fire(); return }
    const poll = setInterval(recheck, 1000), giveUp = domain ? setTimeout(fire, TEST_WAIT_MS) : undefined
    return () => { clearInterval(poll); clearTimeout(giveUp) }
  }, [waiting, sends, domain?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!to) return null
  const busy = waiting || state.phase === 'sending', sent = state.phase === 'sent'
  const press = () => { if (!busy && !sent) setState({ phase: 'waiting' }) }
  const line = state.phase === 'sent' || state.phase === 'failed' ? state.phase : busy ? 'busy' : 'idle'
  return <section className="onb-start-test" aria-label="Test email">
    <div className="first-send-test">
      <Button loading={busy} disabled={sent} onClick={press} data-analytics="onboarding/start/test"><Send size={14} aria-hidden />Send a test email</Button>
      <span className="muted onboarding-slot onb-test-line" role="status">
        <span data-active={line === 'busy' || undefined} aria-hidden={line !== 'busy' || undefined}>Sending…</span>
        <span data-active={line === 'sent' || undefined} aria-hidden={line !== 'sent' || undefined}>{state.phase === 'sent' && <TestSentLine id={state.id} to={to} simulated={state.simulated} onLeave={onLeave} onSettled={onSettled} />}</span>
        <span aria-hidden><TestSentSizer to={to} /></span>
        <span data-active={line === 'failed' || undefined} aria-hidden={line !== 'failed' || undefined}>{state.phase === 'failed' && <>
          <span className="onboarding-error"><ErrorText error={state.error} /></span> <button type="button" className="onb-retry" onClick={() => setState({ phase: 'waiting' })}>Try again</button>
        </>}</span>
      </span>
    </div>
    <p className="muted onb-start-time" data-shown={sent || undefined} aria-hidden={!sent || undefined}>Sent through the API in <strong className="onb-num">{`${Math.max(0, Math.round(state.phase === 'sent' ? state.ms : 0)).toLocaleString('en-US')} ms`}</strong></p>
  </section>
}

// By hand: a key that sends (shown once, here), then the first send with it from the domain, and the docs.
function ByHand({ from, onCreated }: { from: string | null; onCreated: () => void }) {
  const identity = useSession()?.identity, origin = usePublicOrigin()
  const create = useApiMutation((api, input: ApiKeyInput) => api.keys.create(input), undefined, false, invalidate.apiKeys)
  const [language, setLanguage] = useState('curl')
  const secret = create.data?.secret ?? null
  const ready = Boolean(origin && from)
  // Laid out with stand-ins until the domain is known, so the example keeps its height.
  const snippets = sendSnippets({ origin: origin ?? 'https://example.com', apiKey: secret, from: `hello@${from ?? 'example.com'}`, to: identity?.email ?? 'you@example.com' })
  return <>
    <div className="onb-key">
      <div className="onboarding-slot onb-key__slot">
        <span data-active={!secret || undefined} aria-hidden={secret ? true : undefined}>
          <Button variant="primary" loading={create.isPending} tabIndex={secret ? -1 : undefined} data-analytics="onboarding/start/key" onClick={() => create.mutate({ name: 'First API key', permissions: ['send'], domains: [] }, { onSuccess: onCreated })}>Create API key</Button>
        </span>
        <span className="ui-secret onb-key__secret" data-active={secret ? true : undefined} aria-hidden={secret ? undefined : true}>
          <SecretCode>{secret ?? ''}</SecretCode>{secret && <CopyButton value={secret} label="Copy API key" />}
        </span>
      </div>
      {(create.error || secret) && <p className="muted onb-panel__line">{create.error ? <span className="onboarding-error"><ErrorText error={create.error} /></span> : 'Shown once: copy it now.'}</p>}
    </div>
    <div className="onb-send">
      <div className="developer-client-bar">
        <Tabs label="Example language" value={language} onValueChange={setLanguage} items={sendLanguages} />
        <span data-pending={!ready || undefined} inert={!ready} className="onb-send__copy"><CopyAction key={language} value={snippets[language as 'curl' | 'sdk']} label={`Copy ${language === 'curl' ? 'cURL' : 'TypeScript'} example`} variant="ghost" size="sm" compact className="developer-copy-icon" /></span>
      </div>
      <div className="developer-client-panels developer-client-panels--fit" data-pending={!ready || undefined} data-sensitive={secret ? true : undefined}>{sendLanguages.map(item => <pre key={item.value} className="developer-code developer-client-panel" tabIndex={item.value === language ? 0 : -1} aria-label={`${item.label} example`} data-active={item.value === language || undefined} inert={item.value !== language}><code><MaskedText text={snippets[item.value as 'curl' | 'sdk']} /></code></pre>)}</div>
    </div>
    <a className="ui-button ui-button--ghost ui-button--md onb-docs" href="/docs#quickstart" target="_blank" rel="noopener" data-analytics="onboarding/start/docs">Read the docs<ArrowUpRight size={16} aria-hidden /></a>
  </>
}
