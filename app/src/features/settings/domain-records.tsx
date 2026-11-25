import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Alert, Button, CopyButton, DataTable, DropdownMenu, StatusBadge, useCopy, type MenuItem, type Tone } from '../../components/ui'
import { CopyAction, LiveStatus, type LiveState } from '../../components/motion'
import { useApi, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { useRefreshListsOnChange } from '../../data/invalidation'
import { request } from '../../data/live'
import type { DnsRecord, DnsRecordPurpose, Domain, PublicDns, ReceivingIssue } from '../../data/types'
import { settingsColumns } from './skeletons'
import { receivingIssueTitle } from './receiving-issue-title'
import './settings.css'
import './domain-records.css'
import { expectAccount } from '../../data/accounts'
import { productName } from '../../../../api/src/brand'
import { checkKey, type DnsChecks } from './domain-setup-alert'

// Hosted reads are DB-only, so poll briskly while visible; self-hosted reads call SES and stay slow.
export function useDomain(id: string, recheckUntil = 0) {
  const api = useApi()
  const { multiTenant } = useWorkspaceAccess()
  const query = useQuery({
    queryKey: ['nightmail', ...queries.domain(id).key],
    queryFn: ({ signal }) => queries.domain(id).read(api, signal),
    refetchInterval: query => query.state.status === 'error' ? false : query.state.data?.status === 'pending' || query.state.data?.mailFromStatus === 'pending' || (multiTenant && Date.now() < recheckUntil) ? multiTenant ? 3000 : 60_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: multiTenant ? 'always' : false,
  })
  // The cached Domains list must not keep showing the status the poll has just moved past.
  useRefreshListsOnChange('domains', query.data && `${query.data.status}/${query.data.mailFromStatus}`)
  return query
}

export type DnsSetup = { provider: { id: string; name: string } | null; applyUrl: string | null; groups: string[] }
// Off until a DNS provider lists one of the Domain Connect templates in brand.ts (none does yet), so the records never
// wait on discovery that can only fail. DnsWaitNote says why there is no one-click button. Flip once Cloudflare lists nightmail.dev.
const oneClickDns = false
// Domain Connect: the provider's one-click consent URL, when the domain's DNS host supports it.
// Fetched once per page. Callers hold the records back while it is pending (the API bounds discovery
// to about three seconds), and the answer is fixed at reveal, so the button never appears above
// records that are already on screen.
export function useDnsSetup(domain: Domain | undefined) {
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const needed = !!domain && domain.records.some(record => record.purpose !== 'dmarc' && record.status !== 'verified')
  const enabled = oneClickDns && multiTenant && canAdminister && needed
  const query = useQuery({
    queryKey: ['nightmail', 'domain', domain?.id, 'dns-setup'],
    queryFn: ({ signal }) => request<DnsSetup>(`/v1/domains/${encodeURIComponent(domain!.id)}/dns-setup`, { signal }),
    // gcTime 0: each page asks afresh, since pending groups change between onboarding and the domain page.
    enabled, retry: false, staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false,
  })
  const id = domain?.id
  const [timedOut, setTimedOut] = useState<string>()
  useEffect(() => { if (!enabled || !id) return; const timer = setTimeout(() => setTimedOut(id), 4000); return () => clearTimeout(timer) }, [enabled, id])
  const pending = !!domain && enabled && query.isPending && timedOut !== id
  // Decided once per domain, so moving between domains never reuses another domain's link.
  const decided = useRef<{ id: string; setup: DnsSetup | null }>(undefined)
  if (domain && !pending && decided.current?.id !== domain.id) decided.current = { id: domain.id, setup: query.data?.applyUrl && query.data.provider ? query.data : null }
  const current = decided.current
  return { pending: !domain || pending, setup: current && current.id === id ? current.setup : null }
}

// Navigates this tab: providers refuse to be framed, and they return to /domains/<id> when done.
function DnsConnect({ setup, open }: { setup: DnsSetup; open: boolean }) {
  return <div className="dns-connect" data-hidden={!open || undefined} inert={!open}>
    <a className="ui-button ui-button--primary ui-button--md" href={setup.applyUrl!} rel="noopener" onClick={expectAccount}>Configure DNS with {setup.provider!.name}<ArrowRight size={16} aria-hidden /></a>
  </div>
}

// Records saved before purposes split into sending and receiving may still say dkim or ownership.
const purposeOf = (record: DnsRecord): DnsRecordPurpose => {
  const purpose = record.purpose as string | undefined
  return purpose === 'dkim' || purpose === 'ownership' ? 'sending' : record.purpose ?? (record.type === 'CNAME' ? 'sending' : 'mail_from')
}
export const recordsFor = (domain: Domain, purpose: DnsRecordPurpose) => domain.records.filter(record => purposeOf(record) === purpose)
export function domainState(domain: Domain) {
  return domain.status === 'verified' ? { status: 'Verified', tone: 'success' as const } : domain.status === 'issue' ? { status: 'Failed', tone: 'danger' as const } : { status: 'Pending', tone: 'warning' as const }
}
const allVerified = (records: DnsRecord[]) => records.length > 0 && records.every(record => record.status === 'verified')
// Shown relative to the zone, as most DNS providers ask for it; copying gives the full name.
export const relativeHost = (name: string, domain: string) => name === domain ? '@' : name.endsWith(`.${domain}`) ? name.slice(0, -domain.length - 1) : name
const fqdn = (name: string) => name.endsWith('.') ? name : `${name}.`
export function zoneLines(records: DnsRecord[]) {
  return records.map(record => {
    const value = record.type === 'TXT' ? `"${record.value.replace(/"/g, '\\"')}"`
      : record.type === 'MX' ? record.value.replace(/(\S+)$/, target => fqdn(target))
      : fqdn(record.value)
    return `${fqdn(record.name)}\t3600\tIN\t${record.type}\t${value}`
  }).join('\n')
}

// One row of a domain's records table: the record, what it is for, its status (with any detail on hover) and the row's own actions.
export type RecordRow = { record: DnsRecord; purpose: string; status: { label: string; tone: Tone; detail?: string }; actions?: MenuItem[] }
const purposeLabel = (record: DnsRecord) => {
  const purpose = purposeOf(record)
  return purpose === 'sending' ? record.type === 'CNAME' ? 'DKIM' : 'Ownership' : purpose === 'mail_from' ? record.type === 'MX' ? 'MAIL FROM' : 'SPF' : purpose === 'dmarc' ? 'DMARC' : 'Receiving'
}
export const recordRow = (record: DnsRecord, status?: RecordRow['status']): RecordRow => ({ record, purpose: purposeLabel(record), status: status ?? (record.status === 'verified' ? { label: 'Verified', tone: 'success', detail: record.note } : { label: 'Pending', tone: 'warning', detail: record.note }) })

// Check now (verifyDomain) looks each pending sending and MAIL FROM record up in public DNS. Its answers are kept by
// record, since the page's polls read the domain without them (reads carry only the background check's, once it runs).
export { checkKey, type DnsChecks }
export const dnsChecks = (domain: Domain): DnsChecks => new Map(domain.records.flatMap(record => record.publicDns !== undefined ? [[checkKey(record), record.publicDns] as const] : []))
const required = (record: DnsRecord) => record.status !== 'verified' && (purposeOf(record) === 'sending' || purposeOf(record) === 'mail_from')
function checkedStatus(record: DnsRecord, check: PublicDns | null | undefined): RecordRow['status'] | undefined {
  if (!required(record) || check === undefined) return undefined
  if (check === null) return { label: 'Pending', tone: 'warning', detail: 'Public DNS didn’t answer. Check again in a minute.' }
  if (check.state === 'found') return { label: 'Found', tone: 'info', detail: 'Public DNS has this record. Verification usually follows within a few minutes.' }
  if (check.state === 'missing') return { label: 'Missing', tone: 'danger', detail: `Public DNS has no ${record.type} record at ${record.name}.` }
  return { label: 'Wrong value', tone: 'danger', detail: `Expected ${record.value}. Public DNS has ${check.values.join(', ')}.` }
}

const ordinals = ['first', 'second', 'third', 'fourth', 'fifth']
const recordNoun = (record: DnsRecord) => ({ DKIM: 'DKIM CNAME', Ownership: 'ownership TXT', 'MAIL FROM': 'MAIL FROM MX', SPF: 'SPF TXT' } as Record<string, string>)[purposeLabel(record)] ?? `${purposeLabel(record)} ${record.type}`
// A DKIM name starts with a 32-character token: its first characters are enough to find it in a DNS provider's list.
const shortHost = (name: string, domain: string) => { const host = relativeHost(name, domain); return host.length > 28 ? `${host.slice(0, 12)}…` : host }
const list = (items: string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** One plain line that leads with what to fix after Check now: null before a check or once nothing is pending. */
export function checkSummary(domain: Domain, checks: DnsChecks): { text: string; tone: Tone } | null {
  const pending = domain.records.filter(required)
  const checked = pending.filter(record => checks.has(checkKey(record)))
  if (!checked.length) return null
  const nouns = new Map(domain.records.map(record => [record, recordNoun(record)]))
  const name = (record: DnsRecord) => {
    const same = domain.records.filter(other => nouns.get(other) === nouns.get(record))
    return `the ${same.length > 1 ? `${ordinals[same.indexOf(record)] ?? same.indexOf(record) + 1} ` : ''}${nouns.get(record)}`
  }
  const missing = checked.filter(record => checks.get(checkKey(record))?.state === 'missing')
  const wrong = checked.filter(record => checks.get(checkKey(record))?.state === 'wrong_value')
  const unknown = checked.filter(record => checks.get(checkKey(record)) === null)
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  if (missing.length + wrong.length === 1) {
    const record = missing[0] ?? wrong[0]!, host = shortHost(record.name, domain.name)
    return { tone: 'danger', text: missing.length
      ? `1 record missing: ${name(record)} (${host}).`
      : `${sentence(name(record))} (${host}) has another value: ${checks.get(checkKey(record))!.values[0]}.` }
  }
  if (missing.length || wrong.length) return { tone: 'danger', text: [
    missing.length && `${plural(missing.length, 'record')} missing: ${list(missing.map(name))}.`,
    wrong.length && `${plural(wrong.length, 'record')} with another value: ${list(wrong.map(name))}.`,
  ].filter(Boolean).join(' ') }
  if (unknown.length) return { tone: 'warning', text: `Public DNS didn’t answer for ${plural(unknown.length, 'record')}. Check again in a minute.` }
  return { tone: 'info', text: checked.length === pending.length ? 'Public DNS has every record. Verification usually follows within a few minutes.' : 'Public DNS has these records. Verification usually follows within a few minutes.' }
}

// Every record in one table: what it is for, its type, name and value (each with Copy), its status when not done, and the row's
// actions (a menu, only on rows that have any). On a phone each record is a card: what it is for and its type as the
// title (numbered when several share a purpose, such as the three DKIM records, so no two cards share one), the status
// beside it, the name and value under it, and Copy with the row's actions in its action sheet. A copy button inside a
// card's line would clip the wrapped value under it.
export function DnsRecordTable({ domain, rows }: { domain: string; rows: RecordRow[] }) {
  const { copy } = useCopy()
  const titles = new Map<RecordRow, string>(), shared = new Map<string, number>()
  for (const row of rows) shared.set(row.purpose, (shared.get(row.purpose) ?? 0) + 1)
  for (const row of rows) titles.set(row, shared.get(row.purpose)! > 1 ? `${row.purpose} ${[...titles.keys()].filter(other => other.purpose === row.purpose).length + 1}` : row.purpose)
  const [purpose, type, name, value, status, actions] = settingsColumns.dns
  const copyItems = ({ record }: RecordRow): MenuItem[] => [
    { label: 'Copy full name', icon: <Copy size={16} />, onSelect: () => void copy(record.name, 'Copied name') },
    { label: 'Copy value', icon: <Copy size={16} />, disabled: !record.value, onSelect: () => void copy(record.value, 'Copied value') },
  ]
  // A row says its status only while it isn't done; once every row is, the Status column goes (the header says Verified).
  const done = rows.every(row => row.status.tone === 'success')
  const menu = (row: RecordRow, items: MenuItem[]) => <DropdownMenu label={`Actions for ${row.purpose} ${row.record.type} record`} title={`${row.record.type} ${relativeHost(row.record.name, domain)}`} items={items} />
  return <DataTable className="domain-records" rows={rows} rowKey={row => row.record.id} columns={[
    { ...purpose, render: row => row.purpose, cardRender: row => <>{titles.get(row)} <span className="domain-record-type">{row.record.type}</span></> },
    { ...type, render: row => row.record.type },
    { ...name, render: ({ record }) => <div className="settings-copy-cell"><code title={record.name}>{breakable(relativeHost(record.name, domain))}</code><CopyButton value={record.name} label={`Copy full ${record.type} name`} /></div>, cardRender: ({ record }) => <code>{breakable(relativeHost(record.name, domain))}</code> },
    { ...value, render: ({ record }) => record.value ? <div className="settings-copy-cell"><code title={record.value}>{breakable(record.value)}</code><CopyButton value={record.value} label={`Copy ${record.type} value`} /></div> : '—', cardRender: ({ record }) => record.value ? <code>{breakable(record.value)}</code> : '—' },
    ...done ? [] : [{ ...status, render: (row: RecordRow) => row.status.tone === 'success' ? null : <span className="domain-record-status" title={row.status.detail}><StatusBadge status={row.status.label} tone={row.status.tone} /></span> }],
    { ...actions, render: row => row.actions?.length ? menu(row, row.actions) : null, cardRender: row => menu(row, [...copyItems(row), ...row.actions ?? []]) },
  ]} />
}

// DMARC passes when either alignment does, so the row says how each aligns on hover, and only a failure says more.
// The API recommends a record only when no policy exists; otherwise the row shows the policy it found (published,
// inherited from the parent domain or invalid), never as an instruction to publish a new TXT record.
function dmarcRow(domain: Domain): RecordRow | null {
  const policy = domain.dmarc, recommendation = recordsFor(domain, 'dmarc')[0]
  if (!policy && !recommendation) return null // Nothing to show until the first background check.
  const mode = (value: 's' | 'r') => value === 's' ? 'strict' : 'relaxed'
  const alignment = (aligned: boolean) => aligned ? 'aligned' : 'not aligned'
  const record: DnsRecord = recommendation ?? { id: 'dmarc-policy', type: 'TXT', name: `_dmarc.${policy?.source ?? domain.name}`, value: policy?.record ?? '', status: 'not_checked', purpose: 'dmarc' }
  const label = recommendation ? 'Recommended' : !policy ? 'Not checked' : policy.status === 'invalid' ? 'Invalid' : policy.source && policy.source !== domain.name ? 'Inherited' : policy.record ? 'Published' : 'Missing'
  const detail = [policy && `DKIM ${alignment(policy.alignment.dkim)} (${mode(policy.adkim)}), SPF ${alignment(policy.alignment.spf)} (${mode(policy.aspf)})`, recommendation?.note].filter(Boolean).join('. ')
  return { record, purpose: 'DMARC', status: { label, tone: label === 'Published' ? 'success' : label === 'Invalid' ? 'danger' : label === 'Missing' ? 'warning' : 'neutral', detail: detail || undefined } }
}

const liveState = (verified: boolean): LiveState => verified ? 'verified' : 'pending'

// Long hostnames wrap at their dots rather than mid-label.
const breakable = (text: string) => text.split('.').flatMap((part, index) => index === 0 ? [part] : [<wbr key={index} />, `.${part}`])

function CopyText({ label, display, value, copyLabel }: { label: string; display: string; value: string; copyLabel: string }) {
  return <div className="dns-cell">
    <span className="dns-label">{label}</span>
    <span className="dns-text"><code title={value}>{breakable(display)}</code><CopyAction value={value} label={copyLabel} variant="ghost" size="sm" compact className="dns-copy" /></span>
  </div>
}

// Guided layout (onboarding): a heading with one quiet status per group, then plain hairline rows.
function RecordRows({ title, optional = false, warning, notes = [], alert, verified, domain, records }: { title: string; optional?: boolean; warning?: string | null; notes?: string[]; alert?: ReactNode; verified: boolean; domain: string; records: DnsRecord[] }) {
  return <div className="dns-group" data-state={liveState(verified)}>
    <div className="dns-group-head">
      <h3>{title}{optional && <span className="muted"> · optional</span>}</h3>
      <LiveStatus state={liveState(verified)} plain />
    </div>
    {warning && <p className="dns-group-copy muted">{warning}</p>}
    {notes.map(note => <p key={note} className="dns-group-copy muted">{note}</p>)}
    {alert}
    <div className="dns-columns" aria-hidden="true"><span>Type</span><span>Name</span><span>Value</span><span /></div>
    <ul className="dns-rows">{records.map((record, index) => <li key={record.id} className="dns-row" style={{ '--i': index } as CSSProperties}>
      <div className="dns-cell dns-type"><span className="dns-label">Type</span><code>{record.type}</code></div>
      <CopyText label="Name" display={relativeHost(record.name, domain)} value={record.name} copyLabel={`Copy full ${record.type} name`} />
      <CopyText label="Value" display={record.value} value={record.value} copyLabel={`Copy ${record.type} value`} />
      <div className="dns-cell dns-status"><span className="dns-label">Status</span><LiveStatus state={liveState(record.status === 'verified')} plain /></div>
    </li>)}</ul>
  </div>
}

const guides = [
  ['Cloudflare', 'https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/'],
  ['GoDaddy', 'https://www.godaddy.com/help/manage-dns-records-680'],
  ['Namecheap', 'https://www.namecheap.com/support/knowledgebase/article.aspx/434/2237/how-do-i-set-up-host-records-for-a-domain/'],
  ['Route 53', 'https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html'],
  ['Squarespace', 'https://support.squarespace.com/hc/en-us/articles/360002101888-Adding-custom-DNS-records-to-your-Squarespace-managed-domain'],
  ['Vercel', 'https://vercel.com/docs/domains/managing-dns-records'],
] as const
const hoursLeft = (at: string) => Math.max(0, Math.ceil((Date.parse(at) - Date.now()) / 3_600_000))

// While records are pending: when an unproven domain is released, and where to add records. The records' own status
// says that Nightmail is still checking.
export function DnsWaitNote({ domain }: { domain: Domain }) {
  if (domain.status === 'verified' || (domain.sending ?? 'pending') === 'verified') return null
  return <div className="dns-wait">
    {domain.releasesAt && <p>Add these records at your DNS provider within {hoursLeft(domain.releasesAt)} h.</p>}
    <p className="dns-guides">Guides: {guides.map(([name, url], index) => <span key={name}>{index > 0 && <span className="dns-guides-dot" aria-hidden="true"> · </span>}<a href={url} target="_blank" rel="noreferrer">{name}</a></span>)}</p>
  </div>
}

/**
 * Where the domain receives is the receiving MX record's name, which the API chose (onboarding and the domain page show
 * the same records). Nightmail receives on a free subdomain such as reply.<domain> unless the domain's own MX already
 * points to Nightmail, so publishing the record never moves mail that goes elsewhere today, unless someone chose the
 * root: only then is there a warning, before the record is published.
 */
function receivingWarning(domain: string, receiving: DnsRecord[]) {
  const host = receiving.find(record => record.type === 'MX')?.name ?? receiving[0]?.name
  return host === domain && !receiving.every(record => record.status === 'verified')
    ? `This MX record sends all mail for ${domain} to ${productName}, including mailboxes hosted elsewhere today.`
    : null
}

// The domain page's receiving records (hosted): Off until the domain receives (publishing the record turns it on), and its own host's row offers
// choosing the root or a subdomain instead. Custom MAIL FROM: changed or removed from its records' rows, or added from the row under the table.
export type ReceivingView = { off: boolean; actions?: MenuItem[] }
export type MailFromView = { onEdit: () => void; onRemove: () => void }

// What the API's DNS checks found for the receiving host: blocking issues in red, the rest as warnings.
export function ReceivingIssueAlert({ issue }: { issue: ReceivingIssue }) {
  // A code added to the API before the dashboard knows it still shows, with a plain title.
  return <div className="dns-issue"><Alert tone={issue.blocking ? 'danger' : 'warning'} title={receivingIssueTitle(issue.code, issue.host)}>{issue.message}</Alert></div>
}

const NO_RECORDS = 'DNS records are not available yet.'
// Onboarding: sending and receiving records in guided groups. The domain page: every record in one table, custom MAIL FROM last.
export function DomainRecords({ domain, actions, guided = false, setup = null, receivingView, mailFrom, checks }: { domain: Domain; actions?: ReactNode; guided?: boolean; setup?: DnsSetup | null; receivingView?: ReceivingView; mailFrom?: MailFromView; checks?: DnsChecks }) {
  const sending = recordsFor(domain, 'sending'), receiving = recordsFor(domain, 'receiving'), issue = domain.receivingIssue ?? null
  const alert = issue && <ReceivingIssueAlert issue={issue} />
  const warning = receivingWarning(domain.name, receiving)
  const { copy } = useCopy()
  // Stays in place (invisible) once every record verifies, so nothing below moves.
  const connect = setup && <DnsConnect setup={setup} open={domain.records.some(record => record.purpose !== 'dmarc' && record.status !== 'verified')} />
  if (guided) {
    const notes = [...new Set(receiving.flatMap(record => record.note && record.note !== issue?.message ? [record.note] : []))]
    const sendingVerified = (domain.sending ?? (domain.status === 'verified' ? 'verified' : 'pending')) === 'verified'
    const receivingVerified = (domain.receiving ?? (allVerified(receiving) ? 'verified' : 'pending')) === 'verified'
    // Onboarding copies only what sending needs; receiving is optional and copied on its own.
    const copySending = () => copy(`${zoneLines(sending)}\n`, `Copied ${sending.length} sending records`)
    return <section className="dns-guided" aria-label="DNS records">
      {connect}
      <div className="dns-guided-bar"><h2>DNS records</h2>{sending.length > 0 && <Button onClick={() => void copySending()}><Copy size={14} aria-hidden />Copy sending records</Button>}</div>
      {domain.dnsStatus === 'unavailable' && <p className="muted">{domain.dnsUnavailableReason || NO_RECORDS}</p>}
      {sending.length > 0 && <RecordRows title="Sending" verified={sendingVerified} domain={domain.name} records={sending} />}
      {receiving.length > 0 && <RecordRows title="Receiving" optional warning={warning} notes={notes} alert={alert} verified={receivingVerified} domain={domain.name} records={receiving} />}
    </section>
  }
  // Self-hosted receiving has its own section (MailboxReceiving), with its records once it is on.
  const receivingRows = !receivingView ? [] : receiving.map((record, index): RecordRow => {
    const row = recordRow(record, issue && record.name === issue.host ? { label: 'Attention', tone: 'warning', detail: issue.message } : record.status !== 'verified' && receivingView.off ? { label: 'Off', tone: 'neutral', detail: record.note } : undefined)
    return index === 0 && receivingView.actions?.length ? { ...row, actions: receivingView.actions } : row
  })
  const mailFromRecords = recordsFor(domain, 'mail_from'), dmarc = dmarcRow(domain)
  const change: MenuItem[] = mailFrom ? [{ label: 'Change custom MAIL FROM', icon: <Pencil size={16} />, onSelect: mailFrom.onEdit }, { label: 'Remove custom MAIL FROM', icon: <Trash2 size={16} />, destructive: true, onSelect: mailFrom.onRemove }] : []
  const checked = (record: DnsRecord) => recordRow(record, checkedStatus(record, checks?.get(checkKey(record))))
  const rows = [...sending.map(checked), ...dmarc ? [dmarc] : [], ...receivingRows, ...mailFromRecords.map(record => ({ ...checked(record), actions: change }))]
  // While sending records are pending, one line leads the records: what Check now does, then what it found to fix. Its
  // space is there from the first frame (clamped, the full text on hover), so the answer never moves the table.
  const summary = checks && domain.records.some(required) ? checkSummary(domain, checks) ?? { text: 'Check now looks up each record in public DNS.', tone: 'neutral' as const } : null
  // Copy all: every record the table lists, but not a DMARC policy that is already published.
  const all = rows.flatMap(row => row.record.id === 'dmarc-policy' ? [] : [row.record])
  const copyAll = () => copy(`${zoneLines(all)}\n`, `Copied ${all.length} records`)
  const policy = domain.dmarc
  return <section className="section stack domain-records-section">
    {(summary || actions || all.length > 0) && <div className="domain-records-actions">
      {summary && <p className="domain-check-summary" data-tone={summary.tone} title={summary.text} role="status">{summary.text}</p>}
      {actions}{all.length > 0 && <Button onClick={() => void copyAll()}><Copy size={14} aria-hidden />Copy all</Button>}
    </div>}
    {connect}
    {domain.dnsStatus === 'unavailable' && <p className="muted">{domain.dnsUnavailableReason || NO_RECORDS}</p>}
    {receivingView && alert}
    {receivingView && warning && <Alert tone="warning">{warning}</Alert>}
    {policy && !policy.alignment.dkim && !policy.alignment.spf && <Alert tone="warning">DMARC fails: publish the DKIM records, then check again.</Alert>}
    {rows.length > 0 && <div className="domain-records-list">
      <DnsRecordTable domain={domain.name} rows={rows} />
      {mailFrom && !domain.mailFromDomain && mailFromRecords.length === 0 && <div className="domain-records-add"><Button variant="ghost" onClick={mailFrom.onEdit}><Plus size={14} aria-hidden />Add custom MAIL FROM</Button></div>}
    </div>}
  </section>
}
