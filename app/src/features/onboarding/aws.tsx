import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, X } from 'lucide-react'
import { Alert, Button, Checkbox, Dialog, Field, Input, Select, Textarea } from '../../components/ui'
import { BootLoader } from '../../components/BootLoader'
import { useGuardedMutation } from '../../lib/single-flight'
import { useApiQuery } from '../../data/context'
import { connectionApi } from '../../data/connections'
import { domainPattern, normalizeDomain } from '../../lib/domain'
import { ApiError, errorText, type ByoCandidate, type ByoRegion, type ProviderConnection } from '../../data/types'
import { productName } from '../../../../api/src/brand'
import { cleanupStatus, DisconnectDetails } from '../settings/aws-disconnect'

// Connect AWS for a connected account (role template 6.0): the stack reports itself, the account is checked, then the
// owner picks what sends. Every state keeps the same title and one status row, so moving on never shifts the page.
const rise = (index: number) => ({ '--i': index }) as CSSProperties
// Shared with the earlier connect step (index.tsx), so the same moment reads the same.
export const createStack = 'Create stack in AWS'
export const waitingForStack = 'Waiting for the stack in AWS…'
export const domainHint = 'Enter a domain like acme.com.'
const code = (error: unknown) => error instanceof ApiError ? error.code : undefined
const account = (id: string) => id.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3')

type Props = { connection: ProviderConnection | null; onBack: () => void; onHosted: () => void; onChosen: (domain: string | null) => void }
export function ConnectAwsRegional({ connection, onBack, onHosted, onChosen }: Props) {
  const scan = connection?.scan
  // Disconnecting: the cleanup runs, and onboarding starts over once the connection is gone.
  if (connection?.state === 'disconnecting') return <Status title="Disconnecting your AWS account" state="provisioning" text={cleanupStatus(connection.cleanup)}>{connection.cleanup?.summary && <div className="onb-rise" style={rise(2)}><DisconnectDetails summary={connection.cleanup.summary} /></div>}</Status>
  if (!connection?.awsAccountId || connection.state === 'ready') return <WaitForStack connection={connection} onBack={onBack} onHosted={onHosted} />
  const settingUp = scan?.regions.some(region => region.sendingState === 'provisioning' || region.pending.length > 0)
  if (!scan || scan.state === 'scanning') return <Status title="Connect your AWS account" state="provisioning" text={`Account ${account(connection.awsAccountId)} connected. Checking ${scan?.cursor.checked ?? 0} of ${scan?.cursor.total ?? 0} regions…`} />
  if (settingUp) return <SettingUp regions={scan.regions} />
  return <ChooseDomains connection={connection} onChosen={onChosen} />
}

function Status({ title, state, text, children }: { title: string; state: 'awaiting_role' | 'provisioning' | 'ready' | 'failed'; text: string; children?: ReactNode }) {
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro onb-rise" style={rise(0)}><h1 className="onboarding-title">{title}</h1></div>
    <StatusRow state={state} text={text} />
    {children}
  </div>
}
function StatusRow({ state, text }: { state: 'awaiting_role' | 'provisioning' | 'ready' | 'failed'; text: string }) {
  return <div className="onboarding-connect-status onb-rise" style={rise(1)} data-state={state} role="status">
    <span className="onboarding-connect-mark" aria-hidden="true"><span className="onboarding-connect-dot" /><Check size={14} strokeWidth={3} /><X size={14} strokeWidth={3} /></span>
    <p><strong>{text}</strong></p>
  </div>
}

// Before the stack reports: the link, the live status, and why AWS last refused it.
function WaitForStack({ connection, onBack, onHosted }: Omit<Props, 'onChosen'>) {
  const link = connection?.quickCreateUrl
  const connected = connection?.state === 'ready'
  const error = connection?.stack?.error
  const state = connected ? 'ready' : error ? 'failed' : 'awaiting_role'
  const text = connected ? `Account ${account(connection!.awsAccountId!)} connected` : error ? 'The stack didn’t connect' : waitingForStack
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
    <StatusRow state={state} text={text} />
    {error && !connected ? <Alert tone="danger">{error}</Alert> : null}
  </div>
}

function defaultRegion(connection: ProviderConnection) {
  const regions = connection.scan?.regions.filter(region => region.scanState === 'ready_to_import') ?? []
  const withDomains = (connection.candidates ?? []).find(candidate => candidate.selectable && regions.some(region => region.region === candidate.region && region.facts.production))
  return withDomains?.region ?? regions.find(region => region.region === 'us-east-2')?.region ?? regions[0]?.region ?? 'us-east-2'
}
const unavailable: Record<ByoCandidate['status'], string | null> = {
  verified: null, signing_pending: null, not_verified: 'Not verified in SES', incomplete: 'Region not fully checked', already_bound: 'Already added', overlap: 'Claimed by another workspace',
}
function choiceError(error: unknown) {
  switch (code(error)) {
    case 'PRODUCTION_ACCESS_REQUIRED': return 'This region is in the SES sandbox. Request production access first.'
    case 'SCAN_STALE': return 'The account changed since it was checked. Check it again, then choose.'
    case 'CANDIDATE_NO_LONGER_VERIFIED': return 'That domain is no longer verified in SES.'
    // The API's refusal says how the domain's owner gets it released.
    case 'DOMAIN_CLAIMED': return errorText(error)
    case 'DOMAIN_REGION_CONFLICT': return 'That domain is already in use in another workspace or region.'
    default: return errorText(error)
  }
}

// Scanned: pick a region, see its production access, choose domains found there or add one.
function ChooseDomains({ connection, onChosen }: { connection: ProviderConnection; onChosen: (domain: string | null) => void }) {
  const client = useQueryClient()
  const scan = connection.scan!
  const regions = scan.regions.filter(region => region.scanState === 'ready_to_import')
  const [region, setRegion] = useState(() => defaultRegion(connection))
  const [picked, setPicked] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState('')
  const [asking, setAsking] = useState(false)
  const current = regions.find(item => item.region === region)
  const found = (connection.candidates ?? []).filter(candidate => candidate.region === region)
  const granted = current?.facts.production === true
  const choose = useGuardedMutation({
    mutationFn: async ({ ids, name }: { ids: string[]; name: string }) => {
      if (ids.length) await connectionApi.importDomains(scan.revision, ids)
      if (name) await connectionApi.addDomain(name, region)
      return name
    },
    onSuccess: name => { onChosen(name || null); void client.invalidateQueries({ queryKey: ['nightmail', 'connection'] }) },
  })
  const rescan = useGuardedMutation({ mutationFn: () => connectionApi.rescan(), onSuccess: () => void client.invalidateQueries({ queryKey: ['nightmail', 'connection'] }) })
  function submit(event: FormEvent) {
    event.preventDefault()
    const name = draft.trim() ? normalizeDomain(draft) : ''
    if (name && !domainPattern.test(name)) { setInvalid(domainHint); return }
    setInvalid('')
    if (name !== draft) setDraft(name)
    choose.mutate({ ids: picked.filter(id => found.some(candidate => candidate.id === id)), name })
  }
  const nothing = !picked.some(id => found.some(candidate => candidate.id === id)) && !draft.trim()
  return <div className="onboarding onboarding--narrow">
    <div className="onboarding-intro onb-rise" style={rise(0)}><h1 className="onboarding-title">Choose what sends</h1></div>
    <StatusRow state="ready" text={`Account ${account(connection.awsAccountId!)} connected`} />
    <form className="onboarding-aws-choice onb-rise" style={rise(2)} onSubmit={submit} noValidate>
      <Field label="Send from" htmlFor="onboarding-aws-region">
        <Select id="onboarding-aws-region" value={region} onValueChange={value => { setRegion(value); setPicked([]) }}
          options={regions.map(item => ({ value: item.region, label: `${item.regionLabel} (${item.region})` }))} />
      </Field>
      {current && <Access region={current} onAsk={() => setAsking(true)} />}
      {found.length > 0 && <fieldset className="onboarding-found">
        <legend>Verified in this region</legend>
        {found.map(candidate => <div key={candidate.id} className="onboarding-found-row">
          <Checkbox label={<code>{candidate.domain}</code>} checked={picked.includes(candidate.id)} disabled={!candidate.selectable || !granted || choose.isPending}
            onCheckedChange={on => setPicked(list => on ? [...list, candidate.id] : list.filter(id => id !== candidate.id))} />
          {unavailable[candidate.status] && <span className="onboarding-found-note">{unavailable[candidate.status]}</span>}
        </div>)}
      </fieldset>}
      <Field label={found.length ? 'Or add a domain' : 'Add a domain'} htmlFor="onboarding-aws-domain" error={invalid || undefined}>
        <Input id="onboarding-aws-domain" autoComplete="off" autoCapitalize="none" spellCheck={false} value={draft} onChange={event => { setInvalid(''); setDraft(event.target.value) }} placeholder="acme.com" disabled={!granted || choose.isPending} />
      </Field>
      {choose.error ? <Alert tone="danger">{choiceError(choose.error)}</Alert> : null}
      <div className="onboarding-connect-actions">
        <Button type="submit" variant="primary" loading={choose.isPending} disabled={!granted || nothing}>Continue<ArrowRight size={16} aria-hidden /></Button>
        <Button variant="ghost" loading={rescan.isPending} onClick={() => rescan.mutate()}>Check the account again</Button>
      </div>
    </form>
    <ProductionAccessDialog open={asking} onOpenChange={setAsking} region={current} domain={found[0]?.domain ?? (draft.trim() ? normalizeDomain(draft) : '')} />
  </div>
}

// One line about the region's production access, and the way to ask for it while it's in the sandbox.
function Access({ region, onAsk }: { region: ByoRegion; onAsk: () => void }) {
  const { production, review, max24HourSend } = region.facts
  if (production) return <p className="onboarding-access" data-state="granted"><Check size={14} aria-hidden />Production access{max24HourSend ? `: up to ${max24HourSend.toLocaleString('en-US')} emails a day` : ''}</p>
  if (review?.status === 'PENDING') return <p className="onboarding-access" data-state="pending">AWS is reviewing production access{review.caseId ? ` (case ${review.caseId})` : ''}. It usually takes a day.</p>
  if (review?.status === 'DENIED') return <p className="onboarding-access" data-state="denied">AWS declined production access{review.caseId ? ` (case ${review.caseId})` : ''}. Reply to the case in AWS Support.</p>
  if (production === undefined) return <p className="onboarding-access" data-state="denied">{productName} couldn’t read this region. Check the account again.</p>
  return <div className="onboarding-access" data-state="sandbox"><span>Sandbox: mail reaches only verified addresses.</span><Button size="sm" variant="secondary" onClick={onAsk}>Request production access</Button></div>
}

const useCaseText = (domain: string) => `We send transactional email from ${domain || 'our domain'} to our own customers: account notices, receipts and password resets. Every recipient signed up with us. ${productName} suppresses addresses that bounce or complain.`
function ProductionAccessDialog({ open, onOpenChange, region, domain }: { open: boolean; onOpenChange: (open: boolean) => void; region: ByoRegion | undefined; domain: string }) {
  const client = useQueryClient()
  const [website, setWebsite] = useState('')
  const [useCase, setUseCase] = useState('')
  const [mailType, setMailType] = useState<'TRANSACTIONAL' | 'MARKETING'>('TRANSACTIONAL')
  useEffect(() => { if (open) { setWebsite(domain ? `https://${domain}` : ''); setUseCase(useCaseText(domain)); setMailType('TRANSACTIONAL') } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const ask = useGuardedMutation({
    mutationFn: () => connectionApi.requestProductionAccess(region!.region, { websiteUrl: website.trim(), useCase: useCase.trim(), mailType }),
    onSuccess: () => { onOpenChange(false); void client.invalidateQueries({ queryKey: ['nightmail', 'connection'] }) },
  })
  const valid = /^https?:\/\/\S+\.\S+$/.test(website.trim()) && useCase.trim().length >= 40
  return <Dialog open={open} onOpenChange={value => { if (!ask.isPending) { ask.reset(); onOpenChange(value) } }} title={`Request production access in ${region?.regionLabel ?? 'this region'}`}
    footer={<><Button onClick={() => onOpenChange(false)} disabled={ask.isPending}>Cancel</Button><Button variant="primary" loading={ask.isPending} disabled={!valid} onClick={() => ask.mutate()}>Send to AWS</Button></>}>
    <div className="onboarding-access-form">
      <Field label="Website" htmlFor="aws-access-website"><Input id="aws-access-website" value={website} onChange={event => setWebsite(event.target.value)} placeholder="https://acme.com" disabled={ask.isPending} /></Field>
      <Field label="Mail type" htmlFor="aws-access-type"><Select id="aws-access-type" value={mailType} onValueChange={value => setMailType(value as 'TRANSACTIONAL' | 'MARKETING')} options={[{ value: 'TRANSACTIONAL', label: 'Transactional' }, { value: 'MARKETING', label: 'Marketing' }]} disabled={ask.isPending} /></Field>
      <Field label="How you send" htmlFor="aws-access-use-case"><Textarea id="aws-access-use-case" rows={5} value={useCase} onChange={event => setUseCase(event.target.value)} disabled={ask.isPending} /></Field>
      {ask.error ? <Alert tone="danger">{accessError(ask.error)}</Alert> : null}
    </div>
  </Dialog>
}
function accessError(error: unknown) {
  switch (code(error)) {
    case 'ACCOUNT_REQUESTS_OFF': return 'The stack was created with account requests off. Request production access in the SES console instead.'
    case 'PRODUCTION_ACCESS_PENDING': return 'AWS is already reviewing a request for this region.'
    case 'PRODUCTION_ACCESS_GRANTED': return 'This region already has production access.'
    default: return errorText(error)
  }
}

const regionErrors: Record<string, string> = {
  SNS_CONFIRMATION_PENDING: 'Waiting for AWS to confirm notifications…',
  AWS_ACCESS_DENIED: 'AWS refused a permission. Update the stack, then check the account again.',
  AWS_SETUP_TIMEOUT: 'AWS is slow to answer. Retrying…',
  AWS_THROTTLED: 'AWS asked to slow down. Retrying…',
}
const intentErrors: Record<string, string> = {
  CANDIDATE_NO_LONGER_VERIFIED: 'no longer verified in SES',
  DOMAIN_EXISTS_IN_ACCOUNT: `already in SES, set up outside ${productName}: import it instead`,
  PRODUCTION_ACCESS_REQUIRED: 'the region needs production access',
}
// Chosen: the region's sending resources are created and confirmed, then the domains bind.
function SettingUp({ regions }: { regions: ByoRegion[] }) {
  const busy = regions.filter(region => region.sendingState === 'provisioning' || region.pending.length > 0)
  const failed = regions.flatMap(region => region.failedIntents.map(intent => ({ ...intent, region: region.regionLabel })))
  const blocked = busy.find(region => region.sendingState === 'failed' || region.error === 'AWS_ACCESS_DENIED')
  return <Status title="Setting up sending" state={blocked ? 'failed' : 'provisioning'} text={busy.map(region => `${region.regionLabel}: ${region.error ? regionErrors[region.error] ?? region.error : 'creating sending resources…'}`).join(' · ') || 'Finishing…'}>
    {failed.length > 0 && <Alert tone="danger">{failed.map(intent => <span key={intent.region + intent.domain} className="onboarding-failed-intent"><code>{intent.domain}</code> in {intent.region}: {intentErrors[intent.error] ?? intent.error}</span>)}</Alert>}
  </Status>
}

// A domain added in the connect step exists once its region is set up: then the add-domain step opens its records.
export function PendingDomain({ name, onFound }: { name: string; onFound: (id: string | null) => void }) {
  const domains = useApiQuery(['domains', 'onboarding-aws', name], async (api, signal) => {
    let cursor: string | undefined
    for (let pages = 0; pages < 20; pages++) {
      const page = await api.domains.list({ pageSize: 10, cursor, refresh: false }, signal)
      const hit = page.items.find(domain => domain.name === name)
      if (hit || !page.nextCursor) return hit ?? null
      cursor = page.nextCursor
    }
    return null
  }, { interval: 2000 })
  const found = domains.data
  useEffect(() => { if (found) onFound(found.id) }, [found?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const timer = setTimeout(() => onFound(null), 120_000); return () => clearTimeout(timer) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return <BootLoader inline />
}
