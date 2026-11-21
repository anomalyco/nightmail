import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Bot, ChevronRight, Code, LifeBuoy, Newspaper, Send } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'
import { Button, CopyButton, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, useToast, type Column } from '../../components/ui'
import { RouteSkeleton } from '../../components/RouteSkeleton'
import { date, number, percent } from '../../lib/format'
import { productName } from '../../../../api/src/brand'
import { issuePath, newsletterPath, roleName, useCreateSetup, useNewsletter, useNewsletterWrite, useSetups, type Issue, type Newsletter, type SendRequest, type SetupKind, type SetupRole } from './data'
import { isEmpty } from './nav'
import './setups.css'

const day = (value: string) => date(value, { month: 'short', day: 'numeric' })
const moment = (value: string) => `${date(value, { weekday: 'short', day: 'numeric', month: 'short' })}, ${date(value, { hour: 'numeric', minute: '2-digit' })}`
const readers = (count: number) => `${number(count)} ${count === 1 ? 'reader' : 'readers'}`
// $0.20 per thousand emails: the one cost a send has. People and readers cost nothing.
const cost = (emails: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(emails * 0.0002)
const names = (list: string[]) => list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`

// ---------------------------------------------------------------- the newsletter
// Reader growth as the readers who joined each week: flat bars, tallest week full height.
function Growth({ points, joined }: { points: Newsletter['growth']; joined: number }) {
  const weeks = points.slice(1).map((point, i) => ({ at: point.at, joined: Math.max(0, point.readers - points[i]!.readers) }))
  const most = Math.max(1, ...weeks.map(week => week.joined))
  return <figure className="newsletter-growth">
    <div className="newsletter-growth__bars" role="img" aria-label={`New readers each week since ${day(points[0]!.at)}`}>{weeks.map(week => <span key={week.at} title={`${number(week.joined)} joined the week of ${day(week.at)}`} style={{ height: `${Math.max(3, week.joined / most * 100)}%` }} />)}</div>
    <figcaption><span>{number(joined)} joined this month</span><span>{date(points[0]!.at, { month: 'short' })} – {date(points[points.length - 1]!.at, { month: 'short' })}</span></figcaption>
  </figure>
}
// The issue as readers get it, as tall as it is.
function Preview({ html }: { html: string }) {
  const [height, setHeight] = useState(560)
  return <iframe title="The issue as readers get it" sandbox="allow-same-origin" srcDoc={html} style={{ height }} onLoad={event => { const doc = event.currentTarget.contentDocument; if (doc) setHeight(doc.documentElement.scrollHeight) }} />
}

const when = (issue: Issue) => issue.state === 'sent' && issue.sentAt ? day(issue.sentAt) : issue.state === 'scheduled' && issue.scheduledAt ? `Sends ${day(issue.scheduledAt)}` : issue.state === 'requested' ? 'Asked to send' : 'Draft'
const rate = (value?: number) => value == null ? '' : percent(value, 0)
const issueColumns: Column<Issue>[] = [
  { key: 'subject', label: 'Issue', render: issue => <span className="newsletter-issue" title={issue.subject}>{issue.subject}</span>, card: 'title' },
  { key: 'when', label: 'Sent', width: 150, render: issue => <span className={issue.state === 'sent' ? undefined : 'muted'}>{when(issue)}</span>, card: 'line', cardRender: issue => issue.state === 'sent' ? `${when(issue)} · ${rate(issue.opened)} opened` : when(issue) },
  { key: 'recipients', label: 'Readers', width: 110, align: 'right', render: issue => issue.recipients == null ? '' : number(issue.recipients), card: 'hide' },
  { key: 'opened', label: 'Opened', width: 100, align: 'right', render: issue => rate(issue.opened), card: 'hide' },
  { key: 'clicked', label: 'Clicked', width: 100, align: 'right', render: issue => rate(issue.clicked), card: 'hide' },
]

export function NewsletterPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const query = useNewsletter(id)
  const [dialog, setDialog] = useState<'form' | 'invite' | null>(null)
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  if (!query.data) return <RouteSkeleton />
  const newsletter = query.data
  return <div className="stack newsletter">
    <PageHeader title={newsletter.name} actions={<>
      {newsletter.can.invite && <Button variant="ghost" onClick={() => setDialog('invite')}>Invite</Button>}
      <Button variant="primary" onClick={() => navigate('/campaigns/new')}>New issue</Button>
    </>} />
    {newsletter.can.send && newsletter.requests.map(request => <RequestRow key={request.id} newsletter={newsletter} request={request} />)}
    <section className="newsletter-readers">
      <div className="newsletter-readers__count">
        <p><strong>{number(newsletter.readers)}</strong> {newsletter.readers === 1 ? 'reader' : 'readers'}</p>
        {newsletter.readers > 0 && <Button onClick={() => setDialog('form')}>Subscribe form</Button>}
      </div>
      {/* Before the first reader, the form is the thing to look at; after, how the list is growing. */}
      {newsletter.growth.length > 1 ? <Growth points={newsletter.growth} joined={newsletter.joined} /> : <FormTag newsletter={newsletter} />}
    </section>
    <DataTable className="newsletter-issues" columns={issueColumns} rows={newsletter.issues} rowKey={issue => issue.id} rowHref={issue => issuePath(newsletter.id, issue.id)} minRows={3}
      empty={<EmptyState title="No issues yet" />} />
    <FormDialog newsletter={newsletter} open={dialog === 'form'} onClose={() => setDialog(null)} />
    {newsletter.can.invite && <InviteDialog newsletter={newsletter} open={dialog === 'invite'} onClose={() => setDialog(null)} />}
  </div>
}

// What someone who can send sees when a writer has asked: who, what, to whom, and one way in.
function RequestRow({ newsletter, request }: { newsletter: Newsletter; request: SendRequest }) {
  return <div className="newsletter-request">
    <span><strong>{request.by}</strong> asked to send “{request.issue.subject}”</span>
    <Link className="newsletter-request__go" to={issuePath(newsletter.id, request.issueId)}>Review<ChevronRight size={14} aria-hidden="true" /></Link>
  </div>
}

function FormTag({ newsletter }: { newsletter: Newsletter }) {
  return <div className="newsletter-form"><span className="setup-label">Subscribe form</span><div className="setup-code"><code>{newsletter.form.tag}</code><CopyButton value={newsletter.form.tag} label="Copy tag" /></div></div>
}
function FormDialog({ newsletter, open, onClose }: { newsletter: Newsletter; open: boolean; onClose: () => void }) {
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose() }} title="Subscribe form">
    <div className="stack setup-form">
      <div><span className="setup-label">On your site</span><div className="setup-code"><code>{newsletter.form.tag}</code><CopyButton value={newsletter.form.tag} label="Copy tag" /></div></div>
      <div><span className="setup-label">As a page</span><div className="setup-code"><code>{newsletter.form.page.replace('https://', '')}</code><CopyButton value={newsletter.form.page} label="Copy link" /></div></div>
    </div>
  </Dialog>
}

// Two roles on a newsletter, said as what the person can do. Owners and admins of the workspace are already on it.
const inviteRoles: { role: SetupRole; does: string }[] = [
  { role: 'writer', does: 'Writes and edits issues. Asks before sending.' },
  { role: 'member', does: 'Writes, edits and sends.' },
]
function InviteDialog({ newsletter, open, onClose }: { newsletter: Newsletter; open: boolean; onClose: () => void }) {
  const write = useNewsletterWrite(newsletter.id), toast = useToast(), field = useId()
  const [email, setEmail] = useState(''), [role, setRole] = useState<SetupRole>('writer'), [pending, setPending] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!email.trim()) return
    setPending(true)
    try { await write('/people', { email: email.trim(), role }); toast(`Invited ${email.trim()}`, 'success'); setEmail(''); onClose() } finally { setPending(false) }
  }
  const others = newsletter.people.length > 1 || newsletter.invitations.length > 0
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose() }} title={`Invite to ${newsletter.name}`}>
    <form className="stack setup-invite" onSubmit={submit}>
      <Field label="Email" htmlFor={field}><Input id={field} type="email" autoComplete="off" placeholder="name@example.com" value={email} onChange={event => setEmail(event.target.value)} required /></Field>
      <div className="setup-roles" role="radiogroup" aria-label="Role">{inviteRoles.map(option => <label key={option.role} className="setup-role" data-checked={role === option.role || undefined}>
        <input type="radio" name="setup-role" checked={role === option.role} onChange={() => setRole(option.role)} />
        <span><strong>{roleName[option.role]}</strong><span className="muted">{option.does}</span></span>
      </label>)}</div>
      <div className="setup-actions"><Button type="submit" variant="primary" loading={pending}>Invite</Button></div>
      {others && <ul className="setup-people">
        {newsletter.people.map(person => <li key={person.id}><span>{person.name}</span><span className="muted">{roleName[person.role]}</span></li>)}
        {newsletter.invitations.map(invitation => <li key={invitation.email}><span>{invitation.email}</span><span className="muted">{roleName[invitation.role]} · invited</span></li>)}
      </ul>}
    </form>
  </Dialog>
}

// ---------------------------------------------------------------- one issue: the review before a send
// The same page for everyone. A writer's button asks; someone who can send reads the same content, audience, time and
// cost, then sends. It is the approval an agent's send already takes, for a person.
export function IssuePage() {
  const { id = '', issue: issueId = '' } = useParams()
  const navigate = useNavigate(), toast = useToast()
  const query = useNewsletter(id), write = useNewsletterWrite(id)
  const [pending, setPending] = useState(false)
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  if (!query.data) return <RouteSkeleton />
  const newsletter = query.data, issue = newsletter.issues.find(item => item.id === issueId)
  if (!issue) return <EmptyState headingAs="h1" title="Issue not found" action={<Link to={newsletterPath(id)}>Back to {newsletter.name}</Link>} />
  const request = newsletter.requests.find(item => item.issueId === issue.id)
  const run = async (path: string, body: unknown, done: string) => { setPending(true); try { await write(path, body); toast(done, 'success') } finally { setPending(false) } }
  const sendAt = issue.scheduledAt ?? issue.sendAt
  const senders = newsletter.people.filter(person => person.role !== 'writer').map(person => person.name.split(' ')[0]!)
  const edit = <Button onClick={() => navigate('/campaigns/new')}>Edit</Button>
  const actions = issue.state === 'draft' ? newsletter.can.send
      ? <>{edit}<Button variant="primary" loading={pending} onClick={() => void run('/requests', { issueId: issue.id }, 'Sent')}>Send</Button></>
      : <>{edit}<Button variant="primary" loading={pending} onClick={() => void run('/requests', { issueId: issue.id }, 'Asked to send')}>Request send</Button></>
    : issue.state === 'requested' && request && newsletter.can.send
      ? <><Button disabled={pending} onClick={() => void run(`/requests/${request.id}/back`, {}, `Sent back to ${request.by}`)}>Send back</Button><Button variant="primary" loading={pending} onClick={() => void run(`/requests/${request.id}/send`, {}, sendAt ? `Sends ${moment(sendAt)}` : 'Sent')}>Send</Button></>
      : undefined
  const note = issue.state === 'requested' ? newsletter.can.send ? <><strong>{request?.by}</strong> asked to send this.</> : <>Asked. {names(senders)} can send it.</>
    : issue.state === 'scheduled' && issue.approvedBy ? <>{issue.approvedBy} approved it.</> : null
  const facts: [string, ReactNode][] = issue.state === 'sent'
    ? [['Sent', issue.sentAt ? moment(issue.sentAt) : ''], ['To', readers(issue.recipients ?? 0)], ['Opened', rate(issue.opened)], ['Clicked', rate(issue.clicked)]]
    : [['From', newsletter.from], ['To', readers(newsletter.readers)], ['When', sendAt ? moment(sendAt) : 'Now'], ['Cost', cost(newsletter.readers)]]
  return <div className="stack issue">
    <PageHeader backTo={newsletterPath(id)} title={issue.subject} actions={actions} />
    <div className="issue-layout">
      <div className="issue-preview">{issue.html ? <Preview html={issue.html} /> : <p className="muted">{issue.subject}</p>}</div>
      <div className="issue-side">
        {note && <p className="issue-note">{note}</p>}
        <dl className="issue-facts">{facts.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
      </div>
    </div>
  </div>
}

// ---------------------------------------------------------------- add
// Everything a workspace can turn on, one line each. The same list is a new workspace's first screen.
const kinds: { kind: SetupKind; title: string; icon: ReactNode; to: string }[] = [
  { kind: 'newsletter', title: 'A newsletter', icon: <Newspaper />, to: '/add/newsletter' },
  { kind: 'app', title: 'Email from my app', icon: <Code />, to: '/api-keys' },
  { kind: 'campaigns', title: 'One-off campaigns', icon: <Send />, to: '/campaigns' },
  { kind: 'support', title: 'A support inbox', icon: <LifeBuoy />, to: '/receiving' },
  { kind: 'agent', title: 'An inbox for an AI agent', icon: <Bot />, to: '/receiving/inboxes' },
]
export function AddPage() {
  const setups = useSetups()
  if (!setups.data) return <RouteSkeleton />
  const first = isEmpty(setups.data), has = setups.data.has
  // A second newsletter is fine; the rest exist once.
  const again = setups.data.setups.some(setup => setup.kind === 'newsletter')
  const offered = kinds.filter(item => item.kind === 'newsletter' || !(item.kind === 'app' ? has.app : item.kind === 'campaigns' ? has.campaigns : setups.data.setups.some(setup => setup.kind === item.kind)))
  return <div className="add-page" data-first={first || undefined}>
    <h1>{first ? `What will you use ${productName} for?` : 'Add'}</h1>
    <ul className="add-list">{offered.map(item => <li key={item.kind}><Link to={first && item.kind !== 'newsletter' ? '/add' : item.to} className="add-item">
      <span className="add-item__icon" aria-hidden="true">{item.icon}</span>
      <span className="add-item__text">{again && item.kind === 'newsletter' ? 'Another newsletter' : item.title}</span>
      <ChevronRight size={16} aria-hidden="true" />
    </Link></li>)}</ul>
  </div>
}

// "New newsletter": a name and a From address. That makes the list, the sender and the subscribe form.
export function NewNewsletterPage() {
  const navigate = useNavigate(), create = useCreateSetup(), nameId = useId(), fromId = useId()
  const [name, setName] = useState(''), [from, setFrom] = useState(''), [pending, setPending] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    try { const made = await create({ kind: 'newsletter', name: name.trim(), from: from.trim() }); navigate(newsletterPath(made.id), { replace: true }) } finally { setPending(false) }
  }
  return <form className="add-page add-page--form" onSubmit={submit}>
    <h1>New newsletter</h1>
    <Field label="Name" htmlFor={nameId}><Input id={nameId} value={name} onChange={event => setName(event.target.value)} autoFocus required /></Field>
    <Field label="From" htmlFor={fromId}><Input id={fromId} type="email" value={from} onChange={event => setFrom(event.target.value)} placeholder="you@yourdomain.com" required /></Field>
    <div className="setup-actions"><Button variant="ghost" onClick={() => navigate('/add')}>Back</Button><Button type="submit" variant="primary" loading={pending}>Create newsletter</Button></div>
  </form>
}
