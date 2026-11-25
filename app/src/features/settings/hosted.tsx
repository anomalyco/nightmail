import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, ChevronRight, Lock } from 'lucide-react'
import { Button, ConfirmDialog, CopyButton, ErrorState, Input, Select, Skeleton, StatusBadge, MutationError } from '../../components/ui'
import { useApiDef, useApiMutation, useSession, useWorkspaceAccess } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import { connectionApi, connectionKindLabel, useConnectionCache } from '../../data/connections'
import { queries } from '../../data/queries'
import type { Agent, DisconnectSummary, ProviderConnection, WorkspaceMembership } from '../../data/types'
import { AwsDisconnectDialog } from './aws-disconnect'
import { roleLabel, useMembershipCache, workspaceApi } from '../../data/workspaces'
import { ago, label, number } from '../../lib/format'
import { useSenderScore } from '../score'
import { inEvaluation, limitSummary, useSendingLimit } from '../overview/setup'
import { openScoreAbout } from '../../lib/score-about'
import { useCompactShell } from '../../lib/media'
import { AdminOnly } from './admin-only'
import { TeamSkeleton } from './skeletons'
import { BillingSection } from './billing'
import { WebhooksSection } from './webhooks'
import { ActivitySection } from './activity'
import { ContactSupportDialog } from '../../components/ContactSupport'
import { Invitations, InviteDialog, Members } from './workspace-members'
import './hosted.css'
import { PrivateAddress } from '../../components/PrivateAddress'
import { connectionTitle } from './key-labels'
import { hostedHosts, productName } from '../../../../api/src/brand'
import { PostalAddressDialog, postalAddressLine } from '../../components/PostalAddress'

// Hosted settings: a grouped rail and one section at a time. Settings are rows, the label on the left and the
// control on the right, each 53px tall so values loading in never move anything. Old links still land: #workspace on
// General, and #usage (Plan & usage, now part of Billing) on Billing.
type SectionKey = 'general' | 'members' | 'sending' | 'webhooks' | 'activity' | 'billing' | 'account'
const moved: Record<string, SectionKey> = { workspace: 'general', usage: 'billing' }
// Members see every section in the rail: owner and admin ones carry a lock and open a short explanation instead of
// controls they can't use, so nothing is silently missing. Every section takes the whole panel, to the same right edge
// as the app's other tables.
const groups: { title: string; items: { key: SectionKey; label: string; admin?: boolean }[] }[] = [
  { title: 'Workspace', items: [{ key: 'general', label: 'General' }, { key: 'members', label: 'Members', admin: true }, { key: 'sending', label: 'Sending', admin: true }, { key: 'webhooks', label: 'Webhooks', admin: true }, { key: 'activity', label: 'Activity', admin: true }, { key: 'billing', label: 'Billing' }] },
  { title: 'You', items: [{ key: 'account', label: 'Account' }] },
]

export function HostedSettings() {
  const { hash } = useLocation()
  const { canAdminister } = useWorkspaceAccess()
  const identity = useSession()?.identity
  // Sending is a connected AWS account's section (its role, its health, Disconnect), and the way to one where that is
  // offered. Hosted mail has nothing to set there, so its rail has no Sending and an old #sending link opens General.
  const ownAws = identity?.connection?.kind === 'byo' || identity?.byo === true
  const shown = groups.map(group => ({ ...group, items: group.items.filter(item => item.key !== 'sending' || ownAws) }))
  const items = shown.flatMap(group => group.items)
  // A malformed hash (/settings#%) falls back to General instead of throwing during render.
  const requested = (() => { try { return decodeURIComponent(hash.slice(1)) } catch { return '' } })()
  const section = items.find(item => item.key === (moved[requested] ?? requested))?.key ?? 'general'
  const locked = (item: typeof items[number]) => !canAdminister && Boolean(item.admin)
  const current = items.find(item => item.key === section)!
  // On a phone the rail is one scrolling row: the selected section's link scrolls into it (the page itself doesn't move).
  const rail = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const row = rail.current, link = row?.querySelector<HTMLElement>('a[aria-current="page"]')
    if (!row || !link || row.scrollWidth <= row.clientWidth) return
    const box = row.getBoundingClientRect(), at = link.getBoundingClientRect()
    if (at.left < box.left || at.right > box.right) row.scrollLeft += at.left - box.left - (box.width - at.width) / 2
  }, [section])
  return <div className="hosted-settings">
    <nav className="settings-rail" aria-label="Settings">
      <h1 className="settings-rail__title">Settings</h1>
      <div ref={rail} className="settings-rail__groups">{shown.map(group => <div key={group.title} className="settings-rail__group">
        {group.items.map(item => <Link key={item.key} to={`/settings#${item.key}`} replace aria-current={item.key === section ? 'page' : undefined} data-locked={locked(item) || undefined} title={locked(item) ? 'Owners and admins only' : undefined}>{item.label}{locked(item) && <Lock size={12} aria-label="Owners and admins only" />}</Link>)}
      </div>)}</div>
    </nav>
    {/* Keyed, so switching sections fades the new one in. */}
    <div key={section} className="hosted-settings__content">
      {locked(current) ? <AdminOnly title={current.label} />
        : <>
          {section === 'general' && <WorkspaceRows />}
          {section === 'members' && <Team />}
          {section === 'sending' && <SendingRows />}
          {section === 'webhooks' && <WebhooksSection />}
          {section === 'activity' && <ActivitySection />}
          {section === 'billing' && <BillingSection row={Row} />}
          {section === 'account' && <AccountRows />}
        </>}
    </div>
  </div>
}

// A row is its label and its value or control, with no caption: a row that needs one gets a clearer label or value, or
// opens its detail. `error` is inline validation, shown only while the value is wrong.
export function Row({ title, error, children }: { title: ReactNode; error?: ReactNode; children: ReactNode }) {
  return <div className="settings-row"><div className="settings-row__label"><span>{title}</span>{error && <span className="settings-row__error" role="alert">{error}</span>}</div><div className="settings-row__control">{children}</div></div>
}

function WorkspaceRows() {
  const session = useSession()
  const { canAdminister } = useWorkspaceAccess()
  // The name comes with the session's memberships (GET /v1/me): no request of its own, so it is there on the first frame.
  const id = session?.identity?.workspaceId
  const current = session?.identity?.workspaces?.find(workspace => workspace.id === id)
  return <div className="settings-rows">
    <Row title="Name">{current ? <NameForm key={current.id} initial={current.name} canEdit={canAdminister} /> : <span className="muted">—</span>}</Row>
    <PostalAddressRow canEdit={canAdminister} />
    <Row title="Workspace ID"><span className="cluster settings-inline"><code>{id}</code>{id && <CopyButton value={id} label="Copy workspace ID" />}</span></Row>
  </div>
}
// The address every campaign footer shows, on one line; owners and admins change it in a dialog (a campaign's Send asks
// for it too when it is missing). Edit keeps its place and label whatever loads, so nothing moves.
function PostalAddressRow({ canEdit }: { canEdit: boolean }) {
  const settings = useApiDef(queries.workspaceSettings())
  const [open, setOpen] = useState(false)
  const address = settings.data?.postalAddress ?? null
  const value = settings.isPending ? <Skeleton width={180} height={12} /> : settings.isError ? <span className="muted">Couldn’t load</span>
    : address ? <span className="settings-address__value" title={address}>{postalAddressLine(address)}</span> : <span className="muted">Not set</span>
  return <Row title="Postal address">
    <span className="cluster settings-inline settings-address">{value}
      {canEdit ? <Button disabled={settings.isPending} onClick={() => setOpen(true)} data-analytics="settings/postal-address/edit">Edit</Button> : <Lock size={12} aria-label="Owners and admins only" />}
    </span>
    {open && <PostalAddressDialog open onOpenChange={setOpen} initial={address} title="Postal address" submitLabel="Save" />}
  </Row>
}
function NameForm({ initial, canEdit }: { initial: string; canEdit: boolean }) {
  // Members read the name as text with the rail's lock: an input that ignores typing looks broken.
  if (!canEdit) return <span className="cluster settings-inline settings-readonly" title="Only owners and admins can rename the workspace"><span>{initial}</span><Lock size={12} aria-label="Owners and admins only" /></span>
  return <EditableName initial={initial} />
}
function EditableName({ initial }: { initial: string }) {
  const [name, setName] = useState(initial)
  const memberships = useMembershipCache()
  const save = useApiMutation(async (_api, value: string) => { const renamed = await workspaceApi.rename(value); memberships.renamed(renamed); return renamed }, 'Saved', false, invalidate.workspace)
  async function submit(event: FormEvent) { event.preventDefault(); try { await save.mutateAsync(name.trim()) } catch { /* inline */ } }
  const changed = name.trim() !== initial && name.trim() !== ''
  // Save keeps its place whether or not it is shown, so typing never moves the field.
  return <form className="settings-name" onSubmit={submit}>
    <Input aria-label="Workspace name" title={name} className="settings-name-input" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={save.isPending} />
    <Button type="submit" variant="primary" loading={save.isPending} data-hidden={!changed || undefined} tabIndex={changed ? undefined : -1} aria-hidden={!changed || undefined}>Save</Button>
    {save.error ? <div className="settings-name-error"><MutationError error={save.error} /></div> : null}
  </form>
}

function SendingRows() {
  const connection = useApiDef(queries.connection())
  const identity = useSession()?.identity
  const summary = identity?.connection, offerByo = identity?.byo === true
  const limit = useSendingLimit()
  const evaluating = inEvaluation(useSenderScore().data)
  const current = connection.data, kind = current?.kind ?? summary?.kind, region = current?.region ?? summary?.region
  return <>
    <div className="settings-rows">
      <Row title="Connection">{kind ? <span className="cluster settings-inline"><span>{connectionKindLabel[kind]}</span><StatusBadge status={label(current?.state ?? summary?.state ?? 'pending')} /></span> : <Skeleton width={160} height={20} />}</Row>
      {region && <Row title={kind === 'byo' ? 'AWS region' : 'Region'}><code>{region}</code></Row>}
      {kind === 'byo' && <Row title="AWS account">{current ? <code>{current.awsAccountId ?? '—'}</code> : <Skeleton width={93} height={20} />}</Row>}
      {kind === 'byo' && current?.templateVersion !== 'v4' && <ConnectedAccountRows connection={current ?? null} />}
      <ScoreRow />
      {limit && limit.cap !== null && <Row title="Daily limit"><Link to="/settings#billing" replace className="settings-score" title={limitSummary(limit, evaluating)}><span>{number(limit.used)} / {number(limit.cap)}</span><span className="muted">Billing</span><ArrowUpRight size={14} aria-hidden="true" /></Link></Row>}
    </div>
    {/* Hosted mail is the only connection to switch to without an operator's go-ahead, and onboarding would start it again. */}
    {(kind === 'byo' || offerByo) && <DisconnectRow kind={kind} connection={current} />}
  </>
}
// A connected AWS account: its stack's template and the update to the newest one, each sending region's production
// access, and the last health check's first finding.
// Three rows whatever loads, so the rows below never move.
function ConnectedAccountRows({ connection }: { connection: ProviderConnection | null }) {
  const update = useApiMutation(() => connectionApi.updateStack(), undefined, true, invalidate.connection)
  const stack = connection?.stack
  const templateRow = <Row title="Role template" error={update.error ? <MutationError error={update.error} /> : undefined}><span className="cluster settings-inline settings-version"><code>{connection ? stack?.version ?? '—' : <Skeleton width={32} height={20} />}</code>
      {update.data ? <a href={update.data.consoleUrl} target="_blank" rel="noopener noreferrer">Review update in AWS<ArrowUpRight size={14} aria-hidden="true" /></a>
        : <Button size="sm" disabled={!stack?.updateAvailable} aria-hidden={!stack?.updateAvailable || undefined} loading={update.isPending} onClick={() => update.mutate(undefined)}>Prepare update</Button>}</span></Row>
  if (!connection) return <>{templateRow}{['Production access', 'Health'].map(title => <Row key={title} title={title}><Skeleton width={140} height={20} /></Row>)}</>
  const { health } = connection
  const ready = connection.scan?.regions.filter(region => region.sendingState === 'ready') ?? []
  const sandboxed = ready.filter(region => !region.facts.production)
  return <>
    {templateRow}
    <Row title="Production access">{!ready.length ? '—' : sandboxed.length ? `SES sandbox in ${sandboxed.map(region => region.regionLabel).join(', ')}` : ready.map(region => region.regionLabel).join(', ')}</Row>
    {/* The banner above shows the first finding; this row adds any others. */}
    <Row title="Health">{!health ? 'Not checked yet' : health.issues.length ? <span className="settings-attention">{health.issues.length === 1 ? 'Needs attention' : health.issues.slice(1).map(issue => issue.message).join(' ')}</span> : `Checked ${ago(health.checkedAt)}`}</Row>
  </>
}
// The sidebar shows the score beside every page, so on a desktop this row opens its breakdown instead of repeating
// the figure. A compact shell has no sidebar: there the row shows the score itself.
function ScoreRow() {
  const { data: report } = useSenderScore()
  const compact = useCompactShell()
  return <Row title="Sender score">
    {!report ? <span className="settings-score settings-score--late"><Skeleton width={96} height={20} /></span> : <button type="button" onClick={() => openScoreAbout()} className="settings-score settings-score--late">{report.state !== 'graded' ? <><span>Not graded yet</span><span className="muted">{number(report.emails.firstEmails)}/{number(report.needed)} real emails</span></> : compact ? <><b>{Math.round(report.score!)}</b><span className="settings-score__grade">{report.grade}</span></> : <span>Breakdown</span>}<ChevronRight size={14} aria-hidden="true" /></button>}
  </Row>
}
// A connected AWS account's disconnect runs a cleanup in the account: its summary opens once confirmed.
function DisconnectRow({ kind, connection }: { kind: 'shared' | 'byo' | undefined; connection: ProviderConnection | null | undefined }) {
  const regional = connection?.templateVersion === 'v5'
  const disconnect = useApiMutation(() => connectionApi.remove(), regional ? undefined : 'Disconnected', true, invalidate.connection)
  const [confirming, setConfirming] = useState(false)
  const [summary, setSummary] = useState<DisconnectSummary | null>(null)
  const sync = useConnectionCache()
  const client = useQueryClient()
  if (!kind) return null
  const keeps = 'Domains, DNS records, API keys and received mail stay. It isn’t possible while emails or campaigns are still sending.'
  const description = regional ? `Sending stops, and ${productName} removes the configuration sets and topics it created in your AWS account. Your SES identities stay, and you get their list. ${keeps}`
    : kind === 'byo' ? `Sending stops until you connect again. ${keeps} AWS resources stay in your account; delete the ${productName} stack in AWS to revoke access.` : `Sending stops until you connect again. ${keeps}`
  function close() { setSummary(null); sync(client.getQueryData<ProviderConnection | null>(['nightmail', 'connection']) ?? null) }
  return <div className="settings-rows settings-danger">
    <Row title="Disconnect sending"><Button variant="danger" onClick={() => setConfirming(true)}>Disconnect</Button></Row>
    <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="Disconnect sending?" description={description} confirmLabel="Disconnect" danger pending={disconnect.isPending}
      onConfirm={async () => { const result = await disconnect.mutateAsync(undefined); if ('summary' in result) setSummary(result.summary); else sync(null) }} />
    {summary && <AwsDisconnectDialog open summary={summary} onClose={close} />}
  </div>
}
// The account service's connected apps page, on the installations that sign in with Anomaly account.
const accountApps = !hostedHosts.includes(window.location.hostname) ? null : window.location.hostname.startsWith('dev.') ? 'https://account.dev.anoma.ly/apps' : 'https://account.anoma.ly/apps'
function AccountRows() {
  const session = useSession()
  const access = useWorkspaceAccess()
  // Your own connected agents (another member's that made tokens here are on API keys, not here).
  const agents = useApiDef(queries.agents(true))
  const apps = agents.data?.filter(agent => agent.own)
  const revoke = useApiMutation((api, id: string) => api.credentials.revokeAgent(id), 'Agent revoked', false, invalidate.agents)
  const [support, setSupport] = useState(false)
  if (!session?.identity) return null
  return <div className="settings-rows">
    <Row title="Name">{session.identity.name || '—'}</Row>
    <Row title="Email">{session.identity.email ? <PrivateAddress value={session.identity.email} /> : '—'}</Row>
    <Row title="Role">{access.role ? roleLabel[access.role] : '—'}</Row>
    <Row title="Support"><Button onClick={() => setSupport(true)}>Contact support</Button></Row>
    <Row title="Session"><Button onClick={() => session.logout()}>Sign out</Button></Row>
    {/* An agent signs in to the account service, which lists and disconnects it everywhere. Nightmail lists each connected
        agent below: its default workspace, and Revoke, which ends its access here and everything it set up. */}
    {accountApps && <Row title="Connected apps"><a href={accountApps}>Manage at Anomaly account</a></Row>}
    {apps?.map(app=>app.status==='expired'||app.status==='revoked'?<Row key={app.id} title={connectionTitle(app)}>{app.status==='expired'?'Expired · reconnect the client':'Revoked · reconnect the client'}</Row>
      :<McpApproval key={`${app.id}:${app.workspaceId}`} app={app} workspaces={session.identity?.workspaces??[]} onRevoke={()=>revoke.mutate(app.id)} />)}
    {agents.error && <ErrorState error={agents.error} onRetry={() => void agents.refetch()} />}
    <MutationError error={revoke.error}/>
    {support && <ContactSupportDialog onClose={() => setSupport(false)} />}
  </div>
}
// One connected agent per client and account. Its tools act in the workspace each call names, checked against your role
// there on every call; this picks the default for calls that name none (automatic: your only workspace, else the one you
// used last). Receiving tools need an owner or admin there and full access. Save keeps its place whether or not it is
// shown, so choosing never moves the row. Its access and client are on its page, which the name links to.
export function McpApproval({ app, workspaces, onRevoke, linked = true }: { app: Agent; workspaces: WorkspaceMembership[]; onRevoke: () => void; linked?: boolean }) {
  const [workspaceId, setWorkspaceId] = useState(app.workspaceId ?? '')
  const bind = useApiMutation((api, workspace: string) => api.credentials.bindMcpConnection(app.id, { workspaceId: workspace }), 'Saved', false, invalidate.agents)
  const [revoking, setRevoking] = useState(false)
  const changed = workspaceId !== '' && workspaceId !== app.workspaceId
  const name = connectionTitle(app)
  return <Row title={linked ? <Link to={`/settings/mcp/${encodeURIComponent(app.id)}`}>{name}</Link> : name}>
    <span className="settings-mcp">
      <Select aria-label={`Default workspace for ${name}`} className="settings-mcp__workspace" value={workspaceId} placeholder="Last used" disabled={bind.isPending}
        options={workspaces.map(workspace => ({ value: workspace.id, label: workspace.name }))} onValueChange={setWorkspaceId} />
      <Button variant="primary" loading={bind.isPending} data-hidden={!changed || undefined} tabIndex={changed ? undefined : -1} aria-hidden={!changed || undefined} onClick={() => { bind.mutate(workspaceId) }}>Save</Button>
      <Button variant="danger" aria-label={`Revoke ${name}`} onClick={() => setRevoking(true)}>Revoke</Button>
      {bind.error ? <div className="settings-name-error"><MutationError error={bind.error} /></div> : null}
    </span>
    <ConfirmDialog open={revoking} onOpenChange={setRevoking} title={`Revoke ${name}?`} description="Its access ends at once. Reconnect the client to use it again." confirmLabel="Revoke" danger onConfirm={onRevoke} />
  </Row>
}
// Members and invitations appear together once both are known, so the second table never pushes down. Gated on the
// first answer (isFetched), not isPending: the tables below retry a failed read when they mount, and a retry with no
// data is pending again, so gating on isPending unmounted them and remounted them in a loop of requests.
function Team() {
  const access = useWorkspaceAccess()
  const [inviting, setInviting] = useState(false)
  const members = useApiDef(queries.workspaceMembers())
  const invitations = useApiDef(queries.workspaceInvitations())
  const owner = access.role === 'owner'
  if (!members.isFetched || !invitations.isFetched) return <TeamSkeleton />
  return <><Members owner={owner} onInvite={() => setInviting(true)} /><Invitations owner={owner} /><InviteDialog open={inviting} owner={owner} onOpenChange={setInviting} /></>
}
