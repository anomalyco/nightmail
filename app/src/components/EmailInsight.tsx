import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { Check, ChevronRight, ExternalLink, Monitor, Moon, MoreHorizontal, Smartphone, Sun } from 'lucide-react'
import { useApiQuery } from '../data/context'
import type { ClientPreview, PreviewClient, PreviewIssue, SendabilityCategory, SendabilityFinding, SendabilityReport, SenderGrade } from '../data/types'
import { usePhone } from '../lib/media'
import { AddressText } from './AddressText'
import { EmailFrame, frameDocument, type FrameDevice } from './EmailFrame'
import { Alert, Button, Dialog, DropdownMenu, ErrorText, Skeleton, SkeletonText, Tooltip } from './ui'
import './email-insight.css'
import { productName } from '../../../api/src/brand'

// "Will this email land and look right": the sendability check (POST /v1/emails/check) as a score and the fixes to
// make first, with every finding one click away, and one preview that switches between the email as sent and each
// emulated client (POST /v1/emails/preview). Used by a sent email's detail page and by the campaign editor's draft.
export type InsightSource = { kind: 'email'; id: string; html: boolean } | { kind: 'campaign'; id: string; revision: number }
type Theme = 'light' | 'dark'
type Check = UseQueryResult<SendabilityReport, Error>

/** Below this the campaign editor and review warn before sending (grade C starts at 70). Never blocking. */
export const LOW_SENDABILITY = 70
const sourceKey = (source: InsightSource | null) => !source ? ['none'] : source.kind === 'email' ? ['email', source.id] : ['campaign', source.id, source.revision]
// A new revision of the same campaign keeps the last result up while it is checked again.
const sameSubject = (source: InsightSource | null) => (previous: readonly unknown[]) => Boolean(source) && previous[1] === source!.kind && previous[2] === source!.id

export function useSendability(source: InsightSource | null) {
  return useApiQuery(['email-check', ...sourceKey(source)], (api, signal) => api.emails.check(source!.kind === 'email' ? { emailId: source!.id } : { campaignId: source!.id }, signal), { enabled: Boolean(source), keepPrevious: sameSubject(source) })
}

const severityRank = { error: 0, warning: 1, info: 2 } as const
const severityTone = { error: 'danger', warning: 'warning', info: 'neutral' } as const
const severityLabel = { error: 'Error', warning: 'Warning', info: 'Note' } as const
const categoryLabel: Record<SendabilityCategory, string> = { authentication: 'Authentication', content: 'Content', headers: 'Headers', size: 'Size', rendering: 'Rendering', reputation: 'Reputation' }
const gradeFor = (score: number): SenderGrade => score >= 95 ? 'A+' : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'
const gradeKey = (grade: SenderGrade) => grade === 'A+' ? 'aplus' : grade.toLowerCase()
const SCORE_NOTE = 'A high score means few problems found, not guaranteed inbox placement.'
// Errors, then warnings, then notes; within each, the categories that weigh most in this report's score first.
const ranked = (report: SendabilityReport, findings = report.findings) => {
  const weight = (category: SendabilityCategory) => report.categories.find(item => item.id === category)?.weight ?? 0
  return [...findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || weight(b.category) - weight(a.category))
}
/** The fixes to make first. */
export const topFixes = (report: SendabilityReport, count = 3, findings = report.findings) => ranked(report, findings).filter(finding => finding.severity !== 'info').slice(0, count)

// The rendering rule sums up the compatibility lint that the preview shows client by client (each client's issue count
// and list), so where a preview is shown it isn't a finding too; the form and script rules already say what the
// preview's lint would repeat about those elements.
const PREVIEW_RULES = new Set(['client-support'])
const COVERED: Record<string, RegExp> = { form: /^html-(?:form|input|button|select|textarea|option|label|fieldset|legend)\b/, script: /^html-script$/ }

type Client = { value: string; label: string; clients: Record<FrameDevice, PreviewClient>; captions: Record<FrameDevice, string> }
const CLIENTS: Client[] = [
  { value: 'gmail', label: 'Gmail', clients: { desktop: 'gmail-web', mobile: 'gmail-ios' }, captions: { desktop: 'Gmail on the web', mobile: 'Gmail app on iPhone' } },
  { value: 'apple', label: 'Apple Mail', clients: { desktop: 'apple-mail-macos', mobile: 'apple-mail-ios' }, captions: { desktop: 'Apple Mail on Mac', mobile: 'Apple Mail on iPhone' } },
  { value: 'outlook', label: 'Outlook', clients: { desktop: 'outlook-web', mobile: 'outlook-web' }, captions: { desktop: 'Outlook.com and new Outlook', mobile: 'Outlook.com and new Outlook, phone width' } },
  { value: 'yahoo', label: 'Yahoo', clients: { desktop: 'yahoo-web', mobile: 'yahoo-web' }, captions: { desktop: 'Yahoo and AOL Mail on the web', mobile: 'Yahoo and AOL Mail, phone width' } },
  { value: 'samsung', label: 'Samsung', clients: { desktop: 'samsung-email', mobile: 'samsung-email' }, captions: { desktop: 'Samsung Email, desktop width', mobile: 'Samsung Email on Android' } },
]
// Classic Outlook for Windows renders with Word: checked, not previewed. Its issues go under Outlook.
const CLASSIC_OUTLOOK: PreviewClient = 'outlook-classic-windows'
const clientsFor = (device: FrameDevice) => [...new Set([...CLIENTS.map(client => client.clients[device]), CLASSIC_OUTLOOK])]
// What each client doesn't (fully) support, less what the form and script findings already say.
function issueReader(report: SendabilityReport | undefined, previews: ClientPreview[] | undefined) {
  const covered = report ? report.findings.flatMap(finding => COVERED[finding.ruleId] ? [COVERED[finding.ruleId]] : []) : []
  return (client: PreviewClient) => (previews?.find(preview => preview.client === client)?.issues ?? []).filter(issue => !covered.some(rule => rule.test(issue.feature)))
}
const issueTone = (issues: PreviewIssue[]) => issues.some(issue => issue.severity === 'error') ? 'danger' as const : 'warning' as const
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

// ── Sendability: the score and the fixes to make first; the categories and every finding one click away ──

/** The warning near Send when a draft scores low: the score and the three fixes to make first. Sending stays possible. */
export function SendabilityWarning({ report, action }: { report: SendabilityReport; action?: ReactNode }) {
  const fixes = topFixes(report)
  return <Alert tone="warning" title={`Sendability ${report.score} of 100 (${report.grade})`}>
    <p>{fixes.length ? 'Fix these first. You can still send.' : 'You can still send.'}</p>
    {fixes.length > 0 && <ol className="ei-warning-fixes">{fixes.map(finding => <li key={finding.ruleId}><AddressText text={finding.fix} /></li>)}</ol>}
    {action}
  </Alert>
}

function Score({ report }: { report: SendabilityReport }) {
  return <Tooltip content={SCORE_NOTE}><span className="ss__score" data-grade={gradeKey(report.grade)} tabIndex={0} role="img" aria-label={`Score ${report.score} of 100, grade ${report.grade}`}>
    <span>{report.score}</span><span className="ss__dot" aria-hidden="true">·</span><span className="ss__grade">{report.grade}</span>
  </span></Tooltip>
}

/** `previewed`: a preview beside it shows the client compatibility lint, so that finding stays out of the list. */
export function SendabilitySummary({ check, previewed = true, warnBelow, checking = false }: { check: Check; previewed?: boolean; warnBelow?: number; checking?: boolean }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState<string | null>(null)
  if (check.isPending) return <section className="ss" aria-labelledby={id} aria-busy="true"><div className="ss__head"><h2 id={id} className="ss__title">Sendability</h2><SkeletonText width={52} /></div>
    <div className="ss__fixes">{['86%', '70%', '78%'].map(width => <SkeletonText key={width} width={width} lineHeight={28} />)}</div></section>
  if (!check.data) return <section className="ss" aria-labelledby={id}><div className="ss__head"><h2 id={id} className="ss__title">Sendability</h2></div>
    <p className="ss__error"><ErrorText error={check.error} fallback="Couldn’t check this email." /></p><Button size="sm" onClick={() => void check.refetch()}>Try again</Button></section>
  const report = check.data
  const findings = previewed ? report.findings.filter(finding => !PREVIEW_RULES.has(finding.ruleId)) : report.findings
  const fixes = topFixes(report, 3, findings)
  const show = (ruleId: string | null) => { setFocus(ruleId); setOpen(true) }
  return <section className="ss" aria-labelledby={id} aria-busy={checking || undefined}>
    <div className="ss__head"><h2 id={id} className="ss__title">Sendability</h2><span className="ss__status muted" role="status">{checking ? 'Checking…' : ''}</span><Score report={report} /></div>
    {warnBelow !== undefined && report.score < warnBelow && fixes.length > 0 && <p className="ss__warn">Fix these before sending. You can still send.</p>}
    {fixes.length ? <ul className="ss__fixes" aria-label="Fixes to make first">{fixes.map(finding => <li key={finding.ruleId}>
      <button type="button" className="ss__fix" onClick={() => show(finding.ruleId)}><span className={`ei-dot ui-tone--${severityTone[finding.severity]}`} aria-hidden="true" /><span className="ss__fix-text"><span className="sr-only">{severityLabel[finding.severity]}: </span><AddressText text={finding.fix} /></span></button>
    </li>)}</ul> : <p className="ei-clear"><Check size={16} aria-hidden="true" />No problems found.</p>}
    <Button variant="ghost" size="sm" className="ss__all" onClick={() => show(null)}>All findings<span className="ss__count">{findings.length}</span><ChevronRight size={14} aria-hidden="true" /></Button>
    <Dialog open={open} onOpenChange={setOpen} className="ss-dialog" title={<span className="ss-dialog__title">Sendability<Score report={report} /></span>}>
      <Categories report={report} />
      <Findings findings={ranked(report, findings)} focus={focus} />
    </Dialog>
  </section>
}

function Categories({ report }: { report: SendabilityReport }) {
  return <ul className="ei-categories" aria-label="Scores by category">{report.categories.map(category => <li key={category.id} data-grade={category.weight ? gradeKey(gradeFor(category.score)) : undefined}>
    <span className="ei-categories__label">{categoryLabel[category.id]}</span>
    <span className="ei-categories__value">{category.weight ? category.score : <Tooltip content="Not scored: no evidence yet, so it doesn’t count."><span tabIndex={0} aria-label="Not scored">—</span></Tooltip>}</span>
    <span className="ei-bar" aria-hidden="true"><span style={{ transform: `scaleX(${category.weight ? category.score / 100 : 0})` }} /></span>
  </li>)}</ul>
}

// Problems (errors, then warnings) first; notes are measurements and context that cost few or no points.
function Findings({ findings: sorted, focus }: { findings: SendabilityFinding[]; focus: string | null }) {
  const problems = sorted.filter(finding => finding.severity !== 'info'), notes = sorted.filter(finding => finding.severity === 'info')
  return <>
    {problems.length ? <ul className="ei-findings" aria-label="Problems">{problems.map(finding => <Finding key={finding.ruleId} finding={finding} focused={finding.ruleId === focus} />)}</ul>
      : <p className="ei-clear"><Check size={16} aria-hidden="true" />No problems found.</p>}
    {notes.length > 0 && <div className="ei-notes"><h3 className="ei-group">Notes</h3><ul className="ei-findings" aria-label="Notes">{notes.map(finding => <Finding key={finding.ruleId} finding={finding} focused={finding.ruleId === focus} />)}</ul></div>}
  </>
}

const evidenceLabel = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, first => first.toUpperCase()).replace(/ ([A-Z])/g, (_, letter: string) => ` ${letter.toLowerCase()}`)
function Finding({ finding, focused }: { finding: SendabilityFinding; focused: boolean }) {
  const [open, setOpen] = useState(focused)
  const id = useId()
  const item = useRef<HTMLLIElement>(null)
  useEffect(() => { if (focused) item.current?.scrollIntoView({ block: 'nearest' }) }, [focused])
  const evidence = Object.entries(finding.evidence ?? {})
  return <li ref={item} className="ei-finding" data-severity={finding.severity}>
    <span className={`ei-dot ui-tone--${severityTone[finding.severity]}`} aria-hidden="true" />
    <div className="ei-finding__body">
      <button type="button" className="ei-finding__title" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><span className="sr-only">{severityLabel[finding.severity]}: </span><span><AddressText text={finding.title} /></span><ChevronRight size={14} aria-hidden="true" /></button>
      <p className="ei-finding__fix"><AddressText text={finding.fix} /></p>
      <div id={id} className="ei-finding__detail" data-open={open || undefined} inert={!open}><div>
        <p><AddressText text={finding.detail} /></p>
        {evidence.length > 0 && <dl className="ei-evidence">{evidence.map(([key, value]) => <div key={key}><dt>{evidenceLabel(key)}</dt><dd>{typeof value === 'number' ? value.toLocaleString() : <AddressText text={value} />}</dd></div>)}</dl>}
        <p className="ei-finding__rule">{severityLabel[finding.severity]} · {categoryLabel[finding.category]} · <code>{finding.ruleId}</code></p>
      </div></div>
    </div>
  </li>
}

// ── One preview: the email as sent, each emulated client, and its source ──

const htmlNames: Record<string, string> = { semantics: 'semantic elements', lists: 'lists', 'h1-h6': 'headings', 'image-maps': 'image maps', comments: 'comments', doctype: 'doctype', 'meta-color-scheme': 'color-scheme meta tag' }
function featureName(feature: string): ReactNode {
  const [kind, ...parts] = feature.split('-'), rest = parts.join('-')
  if (kind === 'css') return <>CSS <code>{rest.replace(/^at-media-?/, '@media ').trim()}</code></>
  if (kind === 'html') return htmlNames[rest] ? `HTML ${htmlNames[rest]}` : <>HTML <code>{`<${rest.replace(/^(input|button)-(.+)$/, '$1 type=$2')}>`}</code></>
  const words = feature.replaceAll('-', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
function IssueList({ issues }: { issues: PreviewIssue[] }) {
  const sorted = [...issues].sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1))
  return <ul className="ei-issues" aria-label="Compatibility issues">{sorted.map(issue => <li key={issue.feature}>
    <span className={`ei-dot ui-tone--${issue.severity === 'error' ? 'danger' : 'warning'}`} aria-hidden="true" />
    <span className="ei-issues__name">{featureName(issue.feature)}</span>
    <span className="muted">{issue.severity === 'error' ? 'Not supported' : 'Partly supported'}</span>
    <a className="ei-issues__link" href={`https://www.caniemail.com/features/${encodeURIComponent(issue.feature)}/`} target="_blank" rel="noreferrer">Can I email<ExternalLink size={12} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
  </li>)}</ul>
}

// Under an emulated client: its issue count, opening to the list (classic Outlook for Windows' own under Outlook), and
// that it is an emulation without remote images.
function IssueStrip({ issues, classic, caption, open, onOpenChange }: { issues: PreviewIssue[]; classic: PreviewIssue[]; caption: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const id = useId()
  const any = issues.length + classic.length > 0
  return <div className="ev-strip">
    <div className="ev-strip__row">
      <span className="ev-strip__summary">
        {any ? <button type="button" className="ev-strip__toggle" aria-expanded={open} aria-controls={id} onClick={() => onOpenChange(!open)}>
          <span className={`ei-dot ui-tone--${issueTone(issues.length ? issues : classic)}`} aria-hidden="true" />{issues.length ? plural(issues.length, 'issue') : 'No issues'}<ChevronRight size={14} aria-hidden="true" />
        </button> : <span className="ev-strip__clear"><Check size={14} aria-hidden="true" />No issues</span>}
        {classic.length > 0 && <Tooltip content={`Classic Outlook renders with Word, so ${productName} checks its support instead of previewing it.`}><span className="ev-strip__more" tabIndex={0}>{classic.length} in classic Outlook for Windows</span></Tooltip>}
      </span>
      <Tooltip content={`${caption}, emulated offline. Not a screenshot, and remote images don’t load.`}><span className="ev-strip__note" tabIndex={0}>Emulated · images off</span></Tooltip>
    </div>
    {any && <div id={id} className="ev-strip__detail" data-open={open || undefined} inert={!open}><div>
      {issues.length > 0 && <IssueList issues={issues} />}
      {classic.length > 0 && <><h3 className="ei-group">Classic Outlook for Windows</h3><IssueList issues={classic} /></>}
    </div></div>}
  </div>
}

type ViewOption = { value: string; label: string; count?: number; tone?: 'warning' | 'danger'; hint?: string }
// The view switcher: one row of options with a pill that slides to the chosen one (200 ms; it lands without moving on
// first paint). A phone scrolls the row sideways. Arrow keys move the choice, as in a radio group.
function ViewSwitcher({ value, options, onChange, loading }: { value: string; options: ViewOption[]; onChange: (value: string) => void; loading: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const pill = useRef<HTMLSpanElement>(null), placed = useRef(false)
  const index = options.findIndex(option => option.value === value)
  useLayoutEffect(() => {
    const marker = pill.current, button = refs.current[index]
    if (!marker) return
    if (!button) { marker.style.opacity = '0'; placed.current = false; return }
    marker.toggleAttribute('data-animate', placed.current)
    marker.style.opacity = '1'
    marker.style.width = `${button.offsetWidth}px`
    marker.style.transform = `translateX(${button.offsetLeft}px)`
    placed.current = true
  })
  const key = (event: KeyboardEvent, at: number) => {
    const next = ['ArrowRight', 'ArrowDown'].includes(event.key) ? (at + 1) % options.length : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (at + options.length - 1) % options.length : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : null
    if (next === null) return
    event.preventDefault(); onChange(options[next].value); refs.current[next]?.focus()
  }
  return <div className="ev-views ui-scroll-fade" role="radiogroup" aria-label="View">
    <span ref={pill} className="ev-views__pill" aria-hidden="true" />
    {options.map((option, at) => {
      const button = <button key={option.value} ref={node => { refs.current[at] = node }} type="button" role="radio" aria-checked={option.value === value} tabIndex={option.value === value || (index < 0 && at === 0) ? 0 : -1}
        aria-label={option.count ? `${option.label}, ${plural(option.count, 'issue')}` : undefined} className="ev-view" onClick={() => onChange(option.value)} onKeyDown={event => key(event, at)}>
        {option.label}{option.count ? <span className="ev-view__count" data-tone={option.tone} aria-hidden="true">{option.count}</span> : null}
      </button>
      return option.hint ? <Tooltip key={option.value} content={option.hint}>{button}</Tooltip> : button
    })}
    {loading && <span className="ev-views__loading" aria-hidden="true"><Skeleton width={296} height={12} /></span>}
  </div>
}

type ToggleOption<T extends string> = { value: T; label: string; icon: ReactNode }
// A pair of icon choices (light or dark, desktop or phone). Off when it doesn't apply to the view, saying why.
function Toggle<T extends string>({ label, value, options, onChange, off }: { label: string; value: T; options: ToggleOption<T>[]; onChange: (value: T) => void; off?: string }) {
  return <div className="ev-toggle" role="radiogroup" aria-label={label} aria-disabled={off ? true : undefined}>{options.map(option =>
    <Tooltip key={option.value} content={off ?? option.label}><button type="button" role="radio" aria-checked={option.value === value} aria-label={option.label} aria-disabled={off ? true : undefined}
      tabIndex={option.value === value ? 0 : -1} onClick={() => { if (!off) onChange(option.value) }}
      onKeyDown={event => { if (off || !['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); const next = options.find(item => item.value !== value)!; onChange(next.value); (event.currentTarget.parentElement?.querySelector(`[aria-label="${next.label}"]`) as HTMLElement | null)?.focus() }}>{option.icon}</button></Tooltip>)}</div>
}
const THEMES: ToggleOption<Theme>[] = [{ value: 'light', label: 'Light', icon: <Sun size={14} aria-hidden="true" /> }, { value: 'dark', label: 'Dark', icon: <Moon size={14} aria-hidden="true" /> }]
const DEVICES: ToggleOption<FrameDevice>[] = [{ value: 'desktop', label: 'Desktop', icon: <Monitor size={14} aria-hidden="true" /> }, { value: 'mobile', label: 'Phone', icon: <Smartphone size={14} aria-hidden="true" /> }]

/** The email as sent: its sandboxed document and the copy it is measured from (useEmailDocument), and its parts. */
export type OriginalEmail = { doc: string | null; layout: string; html: string; text: string; error?: string }
type PreviewSource = { emailId: string } | { html: string }

/**
 * One preview with one switcher. With `original` (a sent email): Original, the email as sent with its images, then
 * each client; the HTML source and plain text sit behind More. Without it (a draft): the clients. Each client is an
 * offline emulation with its issue count; its issues open under the preview. `loading`: the draft's HTML is on its way.
 */
export function EmailViews({ source, previewSource, check, original, loading = false }: { source: InsightSource; previewSource: PreviewSource | null; check: Check; original?: OriginalEmail; loading?: boolean }) {
  const phone = usePhone()
  const [view, setView] = useState(original ? 'original' : CLIENTS[0].value)
  const [theme, setTheme] = useState<Theme>('light')
  const [device, setDevice] = useState<FrameDevice>(() => phone ? 'mobile' : 'desktop')
  const [issuesOpen, setIssuesOpen] = useState(false)
  const previews = useApiQuery(['email-previews', ...sourceKey(source), theme, device], (api, signal) => api.emails.preview({ source: previewSource!, clients: clientsFor(device), theme, device }, signal), { enabled: Boolean(previewSource), keepPrevious: sameSubject(source) })
  // Clients join the switcher once their counts are known, so no option moves after it appears.
  const ready = Boolean(previewSource) && !previews.isPending && !check.isPending
  const issuesOf = issueReader(check.data, previews.data)
  const client = CLIENTS.find(item => item.value === view)
  const hasHtml = original ? original.html.trim().length > 0 : Boolean(previewSource)
  const options: ViewOption[] = [
    ...original ? [{ value: 'original', label: 'Original', hint: hasHtml ? 'As sent, with its images' : 'As sent: plain text only' }] : [],
    ...ready ? CLIENTS.map(item => { const issues = issuesOf(item.clients[device]); return { value: item.value, label: item.label, count: issues.length || undefined, tone: issueTone(issues), hint: item.captions[device] } }) : [],
  ]
  const sourceView = view === 'html' || view === 'text'
  const preview = client ? previews.data?.find(item => item.client === client.clients[device]) : undefined
  const clientDoc = useMemo(() => preview?.html ? frameDocument(preview.html) : null, [preview?.html])
  // One frame for the original and every client, so a switch crossfades from one to the next.
  const frame = view === 'original' && original && hasHtml ? { doc: original.doc, layout: original.layout, title: 'Email as sent', pending: false }
    : client && preview ? { doc: clientDoc, layout: preview.html, title: `${client.captions[device]}, ${theme} mode`, pending: previews.isPlaceholderData || previews.isFetching } : null
  if (!original && !previewSource && !loading) return <p className="muted ev-note">Add content to see it in each email client.</p>
  return <div className="ev">
    <div className="ev-toolbar">
      <ViewSwitcher value={view} options={options} onChange={setView} loading={hasHtml && !ready && (loading || Boolean(previewSource))} />
      <div className="ev-toolbar__end">
        {original && <DropdownMenu label="More views" align="end" items={[{ label: 'HTML source', onSelect: () => setView('html'), disabled: !hasHtml }, { label: 'Plain text', onSelect: () => setView('text') }]}
          trigger={<button type="button" className="ev-more" data-active={sourceView || undefined} aria-label={sourceView ? `More views: ${view === 'html' ? 'HTML source' : 'Plain text'}` : 'More views'} title="More views">{sourceView ? (view === 'html' ? 'HTML' : 'Text') : <MoreHorizontal size={16} aria-hidden="true" />}</button>} />}
        <Toggle label="Color scheme" value={theme} options={THEMES} onChange={setTheme} off={!client ? 'Dark mode depends on the client' : undefined} />
        <Toggle label="Width" value={device} options={DEVICES} onChange={setDevice} off={sourceView || !hasHtml ? 'Width applies to previews' : undefined} />
      </div>
    </div>
    {frame ? <EmailFrame doc={frame.doc} layout={frame.layout} device={device} title={frame.title} pending={frame.pending} />
      : view === 'original' && original ? <pre className="email-text">{original.text || 'This email has no body.'}</pre>
      : view === 'html' && original ? <pre className="email-source">{original.html || 'No HTML part.'}</pre>
      : view === 'text' && original ? <pre className="email-source">{original.text || 'No plain-text part.'}</pre>
      : client && previews.isError && !previews.data ? <Alert tone="neutral" title="Couldn’t emulate the email clients"><ErrorText error={previews.error} /><div className="ei-retry"><Button size="sm" onClick={() => void previews.refetch()}>Try again</Button></div></Alert>
      : client && previewSource && !previews.isPending ? <div className="email-frame email-frame--empty muted">No preview for this client.</div>
      : <div className="email-frame email-frame--loading" aria-hidden="true" />}
    {view === 'original' && original?.error && <p className="ev-note ui-field__error" role="alert">{original.error}</p>}
    {client && preview && <IssueStrip issues={issuesOf(client.clients[device])} classic={client.value === 'outlook' ? issuesOf(CLASSIC_OUTLOOK) : []} caption={client.captions[device]} open={issuesOpen} onOpenChange={setIssuesOpen} />}
  </div>
}

// ── The campaign editor's panel: the draft's score and fixes, then its clients ──
export function EmailInsight({ source, pending = false, placeholder, warnBelow }: { source: InsightSource | null; pending?: boolean; placeholder?: ReactNode; warnBelow?: number }) {
  const check = useSendability(source)
  const campaign = source?.kind === 'campaign' ? source : null
  const campaignHtml = useApiQuery(['campaign-preview', campaign?.id ?? '', campaign?.revision ?? 0], (api, signal) => api.campaigns.preview(campaign!.id, signal), { enabled: Boolean(campaign), keepPrevious: sameSubject(source) })
  if (!source) return <div className="ei ei--placeholder"><h2 className="ss__title">Sendability</h2><p className="muted">{placeholder}</p></div>
  // The score comes first and the preview after it, so the panel appears once the score is in: nothing above the
  // preview changes height after that.
  if (check.isPending) return <InsightSkeleton />
  const html = campaign ? campaignHtml.data?.html ?? '' : ''
  const previewSource = source.kind === 'email' ? source.html ? { emailId: source.id } : null : html.trim() ? { html } : null
  return <div className="ei">
    <SendabilitySummary check={check} warnBelow={warnBelow} checking={pending || check.isFetching || campaignHtml.isFetching} />
    {campaignHtml.isError && !campaignHtml.data ? <Alert tone="neutral" title="Couldn’t render this draft"><ErrorText error={campaignHtml.error} /><div className="ei-retry"><Button size="sm" onClick={() => void campaignHtml.refetch()}>Try again</Button></div></Alert>
      : <EmailViews source={source} previewSource={previewSource} check={check} loading={campaign ? campaignHtml.isPending : false} />}
  </div>
}

export function InsightSkeleton() {
  return <div className="ei ei--loading" aria-busy="true"><span role="status" className="sr-only">Checking this email</span>
    <section className="ss" aria-hidden="true"><div className="ss__head"><h2 className="ss__title">Sendability</h2><SkeletonText width={52} /></div>
      <div className="ss__fixes">{['86%', '70%', '78%'].map(width => <SkeletonText key={width} width={width} lineHeight={28} />)}</div></section>
    <div className="ev" aria-hidden="true"><div className="ev-toolbar"><Skeleton width={320} height={28} /></div><div className="email-frame email-frame--loading" /></div>
  </div>
}
