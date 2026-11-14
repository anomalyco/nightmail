import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { Check, ChevronRight, Columns2, ExternalLink, Monitor, Moon, MoreHorizontal, Smartphone, Sun } from 'lucide-react'
import { useApiQuery } from '../data/context'
import type { ClientPreview, PreviewClient, PreviewIssue, SendabilityCategory, SendabilityFinding, SendabilityReport, SenderGrade } from '../data/types'
import { usePhone } from '../lib/media'
import { AddressText } from './AddressText'
import { EmailFrame, FRAME_WIDTH, frameDocument, frameKey, frameSize, shownWidth, useFrameSizes, type FrameDevice } from './EmailFrame'
import { Alert, Button, DropdownMenu, ErrorText, Skeleton, SkeletonText, Tooltip } from './ui'
import './email-insight.css'
import { productName } from '../../../api/src/brand'

// "Will this email land and look right": the sendability check (POST /v1/emails/check) as a score, the fixes to make
// first and every finding, and the preview: the email as sent and as each client emulation shows it (POST
// /v1/emails/preview), side by side where the window has room. Used by a sent email's detail page and the campaign editor.
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
  { value: 'outlook', label: 'Outlook', clients: { desktop: 'outlook-web', mobile: 'outlook-web' }, captions: { desktop: 'Outlook.com and new Outlook', mobile: 'Outlook, phone width' } },
  { value: 'yahoo', label: 'Yahoo', clients: { desktop: 'yahoo-web', mobile: 'yahoo-web' }, captions: { desktop: 'Yahoo and AOL Mail on the web', mobile: 'Yahoo and AOL, phone width' } },
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

// ── Sendability: the score, the fixes to make first, and every finding where there is room for it ──

/** The warning near Send when a draft scores low: the score and the three fixes to make first. Sending stays possible. */
export function SendabilityWarning({ report, action }: { report: SendabilityReport; action?: ReactNode }) {
  const fixes = topFixes(report)
  return <Alert tone="warning" title={`Sendability ${report.score} of 100 (${report.grade})`}>
    <p>{fixes.length ? 'Fix these first. You can still send.' : 'You can still send.'}</p>
    {fixes.length > 0 && <ol className="ei-warning-fixes">{fixes.map(finding => <li key={finding.ruleId}><AddressText text={finding.fix} /></li>)}</ol>}
    {action}
  </Alert>
}

const scoreLabel = (report: SendabilityReport) => `Score ${report.score} of 100, grade ${report.grade}`
function Score({ report }: { report: SendabilityReport }) {
  return <Tooltip content={SCORE_NOTE}><span className="ss__score" data-grade={gradeKey(report.grade)} tabIndex={0} role="img" aria-label={scoreLabel(report)}>
    <span>{report.score}</span><span className="ss__dot" aria-hidden="true">·</span><span className="ss__grade">{report.grade}</span>
  </span></Tooltip>
}

/**
 * The score, then the fixes to make first, each opening its finding in place, and All findings, which opens the rest in
 * place. `expanded` (a details column with the height for it): the categories and every finding from the start.
 * `previewed`: a preview beside it shows the client compatibility lint, so that finding stays out of the list.
 */
export function SendabilityDetails({ check, expanded = false, previewed = true, warnBelow, checking = false }: { check: Check; expanded?: boolean; previewed?: boolean; warnBelow?: number; checking?: boolean }) {
  const id = useId()
  const [all, setAll] = useState(false)
  const [focus, setFocus] = useState<string | null>(null)
  const head = (score?: ReactNode) => <div className="ss__head"><h2 id={id} className="ss__title">Sendability</h2>{score}</div>
  if (check.isPending) return <section className="ss" aria-labelledby={id} aria-busy="true">{head(<SkeletonText width={52} />)}
    <div className="ss__fixes">{['86%', '70%', '78%'].map(width => <SkeletonText key={width} width={width} lineHeight={28} />)}</div></section>
  if (!check.data) return <section className="ss" aria-labelledby={id}>{head()}
    <p className="ss__error"><ErrorText error={check.error} fallback="Couldn’t check this email." /></p><Button size="sm" onClick={() => void check.refetch()}>Try again</Button></section>
  const report = check.data
  const findings = previewed ? report.findings.filter(finding => !PREVIEW_RULES.has(finding.ruleId)) : report.findings
  const fixes = topFixes(report, 3, findings)
  const full = expanded || all
  const open = (ruleId: string | null) => { setFocus(ruleId); setAll(true) }
  return <section className="ss" aria-labelledby={id} aria-busy={checking || undefined} data-full={full || undefined}>
    {head(<><span className="ss__status muted" role="status">{checking ? 'Checking…' : ''}</span><Score report={report} /></>)}
    {warnBelow !== undefined && report.score < warnBelow && fixes.length > 0 && <p className="ss__warn">Fix these before sending. You can still send.</p>}
    {full ? <>
      <Categories report={report} />
      <Findings findings={ranked(report, findings)} focus={focus} />
      {!expanded && <Button variant="ghost" size="sm" className="ss__all" aria-expanded="true" onClick={() => { setAll(false); setFocus(null) }}>Fewer findings</Button>}
    </> : <>
      {fixes.length ? <ul className="ss__fixes" aria-label="Fixes to make first">{fixes.map(finding => <li key={finding.ruleId}>
        <button type="button" className="ss__fix" onClick={() => open(finding.ruleId)}><span className={`ei-dot ui-tone--${severityTone[finding.severity]}`} aria-hidden="true" /><span className="ss__fix-text"><span className="sr-only">{severityLabel[finding.severity]}: </span><AddressText text={finding.fix} /></span></button>
      </li>)}</ul> : <p className="ei-clear"><Check size={16} aria-hidden="true" />No problems found.</p>}
      <Button variant="ghost" size="sm" className="ss__all" aria-expanded="false" onClick={() => open(null)}>All findings<span className="ss__count">{findings.length}</span><ChevronRight size={14} aria-hidden="true" /></Button>
    </>}
  </section>
}

/** Where the window has no room for a details column: the score in the preview's toolbar, opening the details beside it. */
export function SendabilityToggle({ check, open, onToggle, controls }: { check: Check; open: boolean; onToggle: () => void; controls: string }) {
  const report = check.data
  return <button type="button" className="ev-details" aria-expanded={open} aria-controls={controls} onClick={onToggle} aria-label={report ? `Sendability: ${scoreLabel(report)}` : 'Sendability'}>
    Sendability<span className="ev-details__score" data-grade={report ? gradeKey(report.grade) : undefined} aria-hidden="true">
      {report ? <><span>{report.score}</span><span className="ss__dot">·</span><span className="ss__grade">{report.grade}</span></> : check.isPending ? <Skeleton width={40} height={12} /> : '–'}
    </span>
  </button>
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

// ── The preview: the email as sent and in each client, one column or several side by side ──

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

// Over each column: what it shows, and for an emulated client its issue count (opening the list over the frame) and
// that it is an emulation without remote images.
function Caption({ label, width, emulated, issues = [], classic = [], open = false, onOpenChange, panel }: { label: string; width?: number; emulated?: string; issues?: PreviewIssue[]; classic?: PreviewIssue[]; open?: boolean; onOpenChange?: (open: boolean) => void; panel?: string }) {
  const any = issues.length + classic.length > 0
  return <div className="ev-caption" style={width ? { width } : undefined}>
    <span className="ev-caption__label">{label}</span>
    {emulated && <span className="ev-caption__end">
      {any ? <button type="button" className="ev-caption__issues" aria-expanded={open} aria-controls={panel} onClick={() => onOpenChange?.(!open)}>
        <span className={`ei-dot ui-tone--${issueTone(issues.length ? issues : classic)}`} aria-hidden="true" />{issues.length ? plural(issues.length, 'issue') : 'No issues'}
        {classic.length > 0 && <span className="ev-caption__classic"> · {classic.length} in classic Outlook</span>}<ChevronRight size={14} aria-hidden="true" />
      </button> : <span className="ev-caption__clear"><Check size={14} aria-hidden="true" />No issues</span>}
      <Tooltip content={`${emulated}, emulated offline. Not a screenshot, and remote images don’t load.`}><span className="ev-caption__note" tabIndex={0}>Emulated<span className="ev-caption__more"> · images off</span></span></Tooltip>
    </span>}
  </div>
}
function IssuePanel({ id, issues, classic, open }: { id: string; issues: PreviewIssue[]; classic: PreviewIssue[]; open: boolean }) {
  return <div id={id} className="ev-issues" data-open={open || undefined} inert={!open}><div>
    {issues.length > 0 && <IssueList issues={issues} />}
    {classic.length > 0 && <><h3 className="ei-group">Classic Outlook for Windows</h3><p className="ev-note muted">{`It renders with Word, so ${productName} checks its support instead of previewing it.`}</p><IssueList issues={classic} /></>}
  </div></div>
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

/** The email as sent: its sandboxed document (null while it is prepared) and its parts. */
export type OriginalEmail = { doc: string | null; html: string; text: string; error?: string }
type PreviewSource = { emailId: string } | { html: string }
type Slot = { key: string; view: string; device: FrameDevice }
type Column = Slot & { doc: string }

const GAP = 16
// Columns sit side by side only at FIT of their size or more. Comparing (each client beside Original) is offered from
// COMPARE_ROOM, and the phone width joins the desktop one from BOTH_ROOM (800 + 390 px at FIT).
const FIT = .9
const BOTH_ROOM = Math.round((FRAME_WIDTH.desktop + GAP + FRAME_WIDTH.mobile) * FIT)
const COMPARE_ROOM = 1080
// Compare is remembered across emails and visits.
const COMPARE_KEY = 'nightmail.preview.compare'
const savedCompare = () => { try { return localStorage.getItem(COMPARE_KEY) !== 'off' } catch { return true } }
const saveCompare = (on: boolean) => { try { localStorage.setItem(COMPARE_KEY, on ? 'on' : 'off') } catch { /* Kept for this page only. */ } }

// The richest arrangement that fits: comparing, Original then the client at desktop and phone width, else both at the
// chosen width; otherwise the view at desktop and phone width, else at the chosen one. Widths are the spans measured at
// desktop width (the device's until measured) and the phone's width.
function arrange(view: string, device: FrameDevice, room: number, wide: boolean, comparing: boolean, widthOf: (view: string, device: FrameDevice) => number): Slot[] {
  const slot = (role: 'ref' | 'main', on: FrameDevice): Slot => ({ key: `${role}@${on}`, view: role === 'ref' ? 'original' : view, device: on })
  const fits = (slots: Slot[]) => slots.reduce((sum, item) => sum + widthOf(item.view, item.device), GAP * (slots.length - 1)) * FIT <= room
  if (comparing) { const three = [slot('ref', 'desktop'), slot('main', 'desktop'), slot('main', 'mobile')]; return fits(three) ? three : [slot('ref', device), slot('main', device)] }
  const both = [slot('main', 'desktop'), slot('main', 'mobile')]
  return wide && fits(both) ? both : [slot('main', device)]
}

// The columns' room (the canvas's content width), read before the first paint, so the first layout is the one that stays.
function useRoom() {
  const [room, setRoom] = useState(0)
  const ref = useCallback((element: HTMLDivElement) => {
    const read = () => { const style = getComputedStyle(element); setRoom(Math.max(0, Math.floor(element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)))) }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [room, ref] as const
}
// Every client's emulation at one width and theme, in one request.
function useClientPreviews(source: InsightSource, previewSource: PreviewSource | null, theme: Theme, device: FrameDevice, needed: boolean) {
  return useApiQuery(['email-previews', ...sourceKey(source), theme, device], (api, signal) => api.emails.preview({ source: previewSource!, clients: clientsFor(device), theme, device }, signal), { enabled: Boolean(previewSource) && needed, keepPrevious: sameSubject(source) })
}
const sentLabel = (device: FrameDevice) => device === 'mobile' ? 'As sent, phone width' : 'As sent'
const useClientDocs = (previews: ClientPreview[] | undefined) => useMemo(() => new Map((previews ?? []).flatMap(item => item.html ? [[item.client, frameDocument(item.html)] as const] : [])), [previews])

/**
 * The preview with one switcher. With `original` (a sent email): Original, the email as sent with its images, then each
 * client; the HTML source and plain text sit behind More. Without it (a draft): the clients. Each client is an offline
 * emulation with its issue count. `fill`: the preview fills its parent's height and scrolls inside; otherwise it is as
 * tall as the email. `wide`: where there is room, the phone width beside the desktop one, and each client beside
 * Original (Compare). `onSettled`: the first columns have their size. `loading`: the draft's HTML is on its way.
 */
export function EmailViews({ source, previewSource, check, original, loading = false, fill = false, wide = false, toolbarEnd, onSettled }: { source: InsightSource; previewSource: PreviewSource | null; check: Check; original?: OriginalEmail; loading?: boolean; fill?: boolean; wide?: boolean; toolbarEnd?: ReactNode; onSettled?: () => void }) {
  const phone = usePhone()
  const id = useId()
  const [room, canvas] = useRoom()
  const hasHtml = original ? original.html.trim().length > 0 : Boolean(previewSource)
  const [compare, setCompare] = useState(savedCompare)
  const canCompare = wide && Boolean(original) && hasHtml && Boolean(previewSource) && room >= COMPARE_ROOM
  const [chosen, setChosen] = useState<string | null>(null)
  // Comparing, the first view is the first client beside Original; otherwise Original (a draft's: the first client).
  const view = chosen ?? ((canCompare && compare) || !original ? CLIENTS[0].value : 'original')
  const [theme, setTheme] = useState<Theme>('light')
  const [device, setDevice] = useState<FrameDevice>(() => phone ? 'mobile' : 'desktop')
  const [openIssues, setOpenIssues] = useState<Record<string, boolean>>({})
  const both = wide && room >= BOTH_ROOM
  const needs = { desktop: both || device === 'desktop', mobile: both || device === 'mobile' }
  const queries = { desktop: useClientPreviews(source, previewSource, theme, 'desktop', needs.desktop), mobile: useClientPreviews(source, previewSource, theme, 'mobile', needs.mobile) }
  const docs = { desktop: useClientDocs(queries.desktop.data), mobile: useClientDocs(queries.mobile.data) }
  const readers = { desktop: issueReader(check.data, queries.desktop.data), mobile: issueReader(check.data, queries.mobile.data) }
  const client = CLIENTS.find(item => item.value === view)
  const comparing = canCompare && compare && Boolean(client)
  const sourceView = view === 'html' || view === 'text'
  const frameView = view === 'original' ? Boolean(original) && hasHtml : Boolean(client && previewSource)
  // A column's document: null while it is on its way, undefined when there is none (no preview for that client).
  const docOf = (of: string, on: FrameDevice): string | null | undefined => {
    if (of === 'original') return original?.doc ?? null
    const item = CLIENTS.find(entry => entry.value === of)
    return !item ? undefined : !queries[on].data ? null : docs[on].get(item.clients[on])
  }

  // How many columns fit depends on the span each view takes at desktop width, so those are measured first.
  const deciding = frameView ? [...new Set(comparing ? ['original', view] : [view])] : []
  const decided = useFrameSizes(deciding.map(of => ({ doc: docOf(of, 'desktop') ?? null, width: FRAME_WIDTH.desktop })))
  const widthOf = (of: string, on: FrameDevice) => { const size = on === 'desktop' ? decided[deciding.indexOf(of)] : undefined; return size ? shownWidth(size) : FRAME_WIDTH[on] }
  const slots = frameView ? arrange(view, device, room, wide, comparing, widthOf) : []
  const wanted = slots.map(slot => ({ ...slot, doc: docOf(slot.view, slot.device) }))
  const measured = useFrameSizes(wanted.map(column => ({ doc: column.doc ?? null, width: FRAME_WIDTH[column.device] })))
  const failedQuery = slots.map(slot => slot.view === 'original' ? null : queries[slot.device]).find(query => query?.isError && !query.data)
  const missing = !failedQuery && wanted.some(column => column.doc === undefined)
  const ready = room > 0 && wanted.length > 0 && deciding.every((of, index) => !docOf(of, 'desktop') || decided[index]) && wanted.every((column, index) => column.doc && measured[index])
  // The columns on screen change only once every new one has its size, all at once: until then the last ones stay, dimmed.
  const signature = ready ? wanted.map(column => `${column.key}:${frameKey(column.doc!, FRAME_WIDTH[column.device])}`).join(' ') : null
  const [shown, setShown] = useState<{ signature: string; columns: Column[] } | null>(null)
  if (signature && signature !== shown?.signature) setShown({ signature, columns: wanted as Column[] })
  const settled = !frameView || Boolean(shown) || Boolean(failedQuery) || missing
  useEffect(() => { if (settled) onSettled?.() }, [settled]) // eslint-disable-line react-hooks/exhaustive-deps

  // Client options join the switcher once their counts are known, so no option moves after it appears. Where both
  // widths show, a client's count covers both.
  const clientsReady = Boolean(previewSource) && !check.isPending && (!needs.desktop || !queries.desktop.isPending) && (!needs.mobile || !queries.mobile.isPending)
  const counted: FrameDevice[] = both ? ['desktop', 'mobile'] : [device]
  const issuesOf = (item: Client) => { const all = new Map<string, PreviewIssue>(); for (const on of counted) for (const issue of readers[on](item.clients[on])) if (!all.has(issue.feature) || issue.severity === 'error') all.set(issue.feature, issue); return [...all.values()] }
  const options: ViewOption[] = [
    ...original ? [{ value: 'original', label: 'Original', hint: hasHtml ? 'As sent, with its images' : 'As sent: plain text only' }] : [],
    ...clientsReady ? CLIENTS.map(item => { const issues = issuesOf(item); return { value: item.value, label: item.label, count: issues.length || undefined, tone: issueTone(issues), hint: counted.map(on => item.captions[on]).join(' and ') } }) : [],
  ]

  const columns = shown?.columns ?? []
  const sizes = columns.map(column => frameSize(column.doc, FRAME_WIDTH[column.device]))
  // A column's width before scaling: its span; at phone width an email wider than the phone shrinks to fit, as phone
  // apps show it. Every column then scales alike to fit the room.
  const naturals = columns.map((column, index) => { const size = sizes[index]; return !size ? 0 : column.device === 'mobile' ? Math.min(shownWidth(size), FRAME_WIDTH.mobile) : shownWidth(size) })
  const total = naturals.reduce((sum, width) => sum + width, 0)
  const scale = total && room ? Math.min(1, Math.max(.1, (room - GAP * (columns.length - 1)) / total)) : 1
  const widths = naturals.map(width => Math.round(width * scale))
  const pending = Boolean(shown) && (shown!.signature !== signature || slots.some(slot => slot.view !== 'original' && queries[slot.device].isPlaceholderData))
  const describe = (column: Slot) => {
    const item = CLIENTS.find(entry => entry.value === column.view)
    if (!item) return { label: sentLabel(column.device), title: column.device === 'mobile' ? 'Email as sent, phone width' : 'Email as sent' }
    const issues = readers[column.device](item.clients[column.device]), classic = item.value === 'outlook' && column.device === 'desktop' ? readers.desktop(CLASSIC_OUTLOOK) : []
    return { label: item.captions[column.device], title: `${item.captions[column.device]}, ${theme} mode`, item, issues, classic, key: `${item.value}@${column.device}` }
  }
  const showDevice = !(slots.some(slot => slot.device === 'desktop') && slots.some(slot => slot.device === 'mobile'))
  const showFrames = frameView && !failedQuery && !missing
  if (!original && !previewSource && !loading) return <p className="muted ev-note">Add content to see it in each email client.</p>
  return <div className="ev" data-fill={fill || undefined}>
    <div className="ev-toolbar">
      <ViewSwitcher value={view} options={options} onChange={setChosen} loading={hasHtml && !clientsReady && (loading || Boolean(previewSource))} />
      <div className="ev-toolbar__end">
        {showDevice && <Toggle label="Width" value={device} options={DEVICES} onChange={setDevice} off={sourceView || !hasHtml ? 'Width applies to previews' : undefined} />}
        <Toggle label="Color scheme" value={theme} options={THEMES} onChange={setTheme} off={!client ? 'Dark mode depends on the client' : undefined} />
        {canCompare && <div className="ev-toggle"><Tooltip content="Show each client beside Original"><button type="button" aria-pressed={compare} aria-label="Compare with Original" onClick={() => { setChosen(view); setCompare(!compare); saveCompare(!compare) }}><Columns2 size={14} aria-hidden="true" /></button></Tooltip></div>}
        {original && <DropdownMenu label="More views" align="end" items={[{ label: 'HTML source', onSelect: () => setChosen('html'), disabled: !hasHtml }, { label: 'Plain text', onSelect: () => setChosen('text') }]}
          trigger={<button type="button" className="ev-more" data-active={sourceView || undefined} aria-label={sourceView ? `More views: ${view === 'html' ? 'HTML source' : 'Plain text'}` : 'More views'} title="More views">{sourceView ? (view === 'html' ? 'HTML' : 'Text') : <MoreHorizontal size={16} aria-hidden="true" />}</button>} />}
        {toolbarEnd}
      </div>
    </div>
    <div className="ev-stage">
      <div className="ev-captions">
        {sourceView ? <Caption label={view === 'html' ? 'HTML source' : 'Plain text'} />
          : view === 'original' && original && !hasHtml ? <Caption label={sentLabel('desktop')} />
          : showFrames && columns.map((column, index) => { const about = describe(column); return <Caption key={column.key} label={about.label} width={widths[index]} emulated={about.item?.captions[column.device]} issues={about.issues} classic={about.classic}
            open={Boolean(about.key && openIssues[about.key])} onOpenChange={open => setOpenIssues(state => ({ ...state, [about.key!]: open }))} panel={`${id}-${column.key}`} /> })}
      </div>
      <div ref={canvas} className={fill ? 'ev-canvas ui-scroll-fade' : 'ev-canvas'}>
        {sourceView && original ? <pre className="email-source">{view === 'html' ? original.html || 'No HTML part.' : original.text || 'No plain-text part.'}</pre>
          : view === 'original' && original && !hasHtml ? <pre className="email-text">{original.text || 'This email has no body.'}</pre>
          : failedQuery ? <Alert tone="neutral" title="Couldn’t emulate the email clients"><ErrorText error={failedQuery.error} /><div className="ei-retry"><Button size="sm" onClick={() => void failedQuery.refetch()}>Try again</Button></div></Alert>
          : missing ? <div className="email-frame--empty muted">No preview for this client.</div>
          : shown ? <>
            {original?.error && columns.some(column => column.view === 'original') && <p className="ev-note ui-field__error" role="alert">{original.error}</p>}
            <div className="ev-columns" data-pending={pending || undefined}>{columns.map((column, index) => {
              const size = sizes[index], about = describe(column)
              return size ? <div key={column.key} className="ev-column" style={{ width: widths[index] }}>
                {about.item && about.issues!.length + about.classic!.length > 0 && <IssuePanel id={`${id}-${column.key}`} issues={about.issues!} classic={about.classic!} open={Boolean(openIssues[about.key!])} />}
                <EmailFrame doc={column.doc} size={size} scale={scale * naturals[index] / shownWidth(size)} title={about.title} pending={pending} />
              </div> : null
            })}</div>
          </> : <div className="ev-placeholder" aria-hidden="true" />}
      </div>
    </div>
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
    <SendabilityDetails check={check} warnBelow={warnBelow} checking={pending || check.isFetching || campaignHtml.isFetching} />
    {campaignHtml.isError && !campaignHtml.data ? <Alert tone="neutral" title="Couldn’t render this draft"><ErrorText error={campaignHtml.error} /><div className="ei-retry"><Button size="sm" onClick={() => void campaignHtml.refetch()}>Try again</Button></div></Alert>
      : <EmailViews source={source} previewSource={previewSource} check={check} loading={campaign ? campaignHtml.isPending : false} />}
  </div>
}

export function InsightSkeleton() {
  return <div className="ei ei--loading" aria-busy="true"><span role="status" className="sr-only">Checking this email</span>
    <section className="ss" aria-hidden="true"><div className="ss__head"><h2 className="ss__title">Sendability</h2><SkeletonText width={52} /></div>
      <div className="ss__fixes">{['86%', '70%', '78%'].map(width => <SkeletonText key={width} width={width} lineHeight={28} />)}</div></section>
    <div className="ev" aria-hidden="true"><div className="ev-toolbar"><Skeleton width={320} height={28} /></div><div className="ev-stage"><div className="ev-captions" /><div className="ev-canvas"><div className="ev-placeholder" /></div></div></div>
  </div>
}
