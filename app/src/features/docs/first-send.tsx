import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useGuardedMutation } from '../../lib/single-flight'
import { Send } from 'lucide-react'
import { Alert, Button, ErrorText, SectionHeader, Tabs } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { useApiDef, useApiQuery, usePublicOrigin, useSession } from '../../data/context'
import { request } from '../../data/live'
import { queries } from '../../data/queries'
import { pendingEmailStatuses, type Domain } from '../../data/types'
import { label } from '../../lib/format'
import './developer.css'
import { PrivateAddress } from '../../components/PrivateAddress'
import { MaskedText } from './agent-setup'
import { apiKeyEnv, productName, sdkPackage } from '../../../../api/src/brand'

const simulator = ['success', 'bounce', 'complaint'].map(local => `${local}@simulator.amazonses.com`)

// The first send, filled in with this workspace's values. `apiKey` is the just-created secret, or null for
// the environment variable. Region is left out on purpose: the sender domain decides it.
export function sendSnippets({ origin, apiKey, from, to }: { origin: string; apiKey: string | null; from: string; to: string }) {
  const body = { from, to, subject: `Hello from ${productName}`, text: 'It works.' }
  const header = apiKey ? `"Authorization: Bearer ${apiKey}"` : `"Authorization: Bearer $${apiKeyEnv}"`
  return {
    // A new Idempotency-Key per run: reusing one returns the first email's ID and sends nothing new.
    curl: `curl --request POST \\\n  --url '${origin}/v1/emails/send' \\\n  --header ${header} \\\n  --header 'Content-Type: application/json' \\\n  --header "Idempotency-Key: $(uuidgen)" \\\n  --data '${JSON.stringify(body)}'`,
    sdk: `import { createClient } from '${sdkPackage}/client'\nimport { sendEmail } from '${sdkPackage}'\n\nconst client = createClient({ baseUrl: '${origin}', auth: scheme => scheme.scheme === 'bearer' ? process.env.${apiKeyEnv} : undefined })\n// One Idempotency-Key per email: a retry with the same key never sends it twice.\nconst { data } = await sendEmail({ client, headers: { 'Idempotency-Key': crypto.randomUUID() }, throwOnError: true,\n  body: { from: '${from}', to: '${to}', subject: 'Hello from ${productName}', text: 'It works.' } })\nconsole.log(data.id) // 202: queued, not delivered yet`,
  }
}

export const sendLanguages = [{ value: 'curl', label: 'cURL' }, { value: 'sdk', label: 'TypeScript' }]

// Sends a first email from hello@<domain> to the signed-in user's own address. The server picks the
// recipient and content (POST /v1/domains/{id}/test-send); the dashboard only names the domain.
/** The test send itself, for TestSend and Overview's first-send card. `domain` may still be loading. `ms` is the send's
 *  round trip through the API, measured in this browser. */
export function useTestSend(domain: Pick<Domain, 'id'> | null | undefined, onSent?: (id: string, ms: number) => void) {
  return useGuardedMutation({ target: domain?.id ?? '', mutationFn: async () => {
    const started = performance.now()
    const sent = await request<{ id: string; status: string; simulated?: boolean }>(`/v1/domains/${encodeURIComponent(domain!.id)}/test-send`, { method: 'POST', idempotencyKey: crypto.randomUUID() })
    return { ...sent, ms: performance.now() - started }
  }, onSuccess: data => onSent?.(data.id, data.ms) })
}
/** A just-sent email's status, read alone every 1.5 s while it is on its way and less than two minutes old (a deferral
 *  past that is Logs' to show). `onSettled` runs once it has a final status (delivered, bounced…). */
export function useSettlingEmail(id: string | undefined, onSettled?: () => void) {
  const email = useApiDef(queries.email(id ?? ''), { enabled: Boolean(id),
    interval: data => data && pendingEmailStatuses.includes(data.status) && Date.now() - Date.parse(data.sentAt) < 120_000 ? 1500 : false })
  const status = email.data?.status
  const settled = status !== undefined && !pendingEmailStatuses.includes(status)
  useEffect(() => { if (settled) onSettled?.() }, [settled]) // eslint-disable-line react-hooks/exhaustive-deps
  return status
}

/** What a test send says once sent: queued, then delivered or how else it went, as soon as it does, and the link to Logs.
 *  Delivered from a real send, it says to check spam too (a new domain's first mail can land there). Each way it can
 *  read is laid out in one cell, so a status arriving moves nothing, the link included. */
export function TestSentLine({ id, simulated, onLeave, onSettled }: { id: string; to: string; simulated?: boolean; onLeave?: () => void; onSettled?: () => void }) {
  const status = useSettlingEmail(id, onSettled)
  const as = simulated ? ' (simulated)' : ''
  const logs = <Link className="first-send-logs" to={`/logs/${encodeURIComponent(id)}`} onClick={onLeave}>View in Logs</Link>
  const shown = !status || pendingEmailStatuses.includes(status) ? 'queued' : status === 'delivered' ? 'delivered' : 'other'
  return <span className="first-send-line">
    <span data-shown={shown === 'queued' || undefined} aria-hidden={shown !== 'queued' || undefined}>Queued{as}. {logs}</span>
    <span data-shown={shown === 'delivered' || undefined} aria-hidden={shown !== 'delivered' || undefined}>Delivered{as}.{simulated ? '' : ' Check spam too.'} {logs}</span>
    <span data-shown={shown === 'other' || undefined} aria-hidden={shown !== 'other' || undefined}>{status ? label(status) : ''}{as}. {logs}</span>
  </span>
}
/** The longest TestSentLine (delivered, with the spam hint), never shown: a slot that holds it keeps the line's height
 *  from the start, so the delivered line moves nothing under it. */
export function TestSentSizer(_: { to: string }) {
  return <>Delivered. Check spam too. <span className="first-send-logs">View in Logs</span></>
}

// `onLeave` runs before View in Logs opens the email: onboarding finishes there, so the dashboard opens instead of sending
// the browser back to the step it came from. `ready`: whether it can send, where the caller knows better than the domain's
// status (a new built-in domain still being set up sends: its send waits for the setup). `onSettled`: the test has its outcome.
export function TestSend({ domain, onSent, onSettled, primary = false, onLeave, ready }: { domain: Domain; onSent?: (id: string) => void; onSettled?: () => void; primary?: boolean; onLeave?: () => void; ready?: boolean }) {
  const identity = useSession()?.identity
  const to = identity?.email
  const from = `hello@${domain.name}`
  const verified = ready ?? domain.status === 'verified'
  const test = useTestSend(domain, onSent)
  if (!to) return null
  return <>
    <div className="first-send-test">
      <Button variant={primary ? 'primary' : undefined} loading={test.isPending} disabled={!verified || test.isSuccess} onClick={() => test.mutate()}><Send size={14} aria-hidden />Send your first email</Button>
      <span className="muted" role="status">{test.isSuccess ? <TestSentLine id={test.data.id} to={to} simulated={test.data.simulated} onLeave={onLeave} onSettled={onSettled} /> : verified ? <>From <PrivateAddress value={from} /> to <PrivateAddress value={to} /></>
        : domain.builtIn ? `Available in a moment, once ${domain.name} is ready.` : `Available once ${domain.name} is verified.`}</span>
    </div>
    {test.error ? <Alert tone="danger"><ErrorText error={test.error} /></Alert> : null}
  </>
}

/** Copyable curl and SDK examples plus a test send from the dashboard. Sending needs a verified domain. `compact`
 *  (onboarding, the key-created dialog) leaves out the simulator tip, which is a reference for testing, not a step. */
export function FirstSend({ domain, apiKey = null, title = 'Send your first email', testButton = true, compact = false }: { domain: Domain | null; apiKey?: string | null; title?: string; testButton?: boolean; compact?: boolean }) {
  const origin = usePublicOrigin()
  const identity = useSession()?.identity
  const [language, setLanguage] = useState('curl')
  const to = identity?.email ?? 'you@example.com'
  const from = `hello@${domain?.name ?? 'acme.com'}`
  // Until the installation's address is known (it always is once signed in), the examples stay empty.
  const snippets = origin ? sendSnippets({ origin, apiKey, from, to }) : { curl: '', sdk: '' }
  return <section className="section stack developer-section" aria-label={title}>
    <SectionHeader title={title} />
    <div className="developer-client-bar">
      <Tabs label="Example language" value={language} onValueChange={setLanguage} items={sendLanguages} />
      <CopyAction key={language} value={snippets[language as 'curl' | 'sdk']} label={`Copy ${language === 'curl' ? 'cURL' : 'TypeScript'} example`} variant="ghost" size="sm" compact className="developer-copy-icon" />
    </div>
    <div className="developer-client-panels developer-client-panels--fit" data-sensitive={apiKey ? true : undefined}>{sendLanguages.map(item => <pre key={item.value} className="developer-code developer-client-panel" tabIndex={0} aria-label={`${item.label} example`} data-active={item.value === language || undefined} inert={item.value !== language}><code><MaskedText text={snippets[item.value as 'curl' | 'sdk']} /></code></pre>)}</div>
    {!compact && <p className="muted developer-copy">To test each outcome without a real inbox, send to {simulator.map((address, index) => <span key={address}>{index > 0 && (index === simulator.length - 1 ? ' or ' : ', ')}<code>{address}</code></span>)}. They use your daily limit like any send, but never count towards your sender score.</p>}
    {testButton && domain && <TestSend domain={domain} />}
  </section>
}

// Shown with a newly created API key (a dashboard dialog, so compact): the same examples with that key and the
// workspace's first verified domain.
export function KeySendExample({ apiKey }: { apiKey: string }) {
  const domains = useApiQuery(['domains', 'key-example'], (api, signal) => api.domains.list({ page: 1, pageSize: 10, refresh: false }, signal))
  const items = domains.data?.items ?? []
  return <FirstSend domain={items.find(domain => domain.status === 'verified') ?? items[0] ?? null} apiKey={apiKey} title="Send with this key" testButton={false} compact />
}
