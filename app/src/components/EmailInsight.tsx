import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight, Check as CheckIcon, ChevronDown, ChevronRight, ExternalLink, Monitor, Moon, MoreHorizontal, Smartphone, Sun } from 'lucide-react'
import { useApiQuery } from '../data/context'
import type { ClientPreview, PreviewClient, PreviewIssue, SendabilityCategory, SendabilityFinding, SendabilityReport } from '../data/types'
import { usePhone } from '../lib/media'
import { useTheme } from '../lib/theme'
import { AddressText } from './AddressText'
import { EmailFrame, FRAME_WIDTH, frameDocument, frameKey, frameSize, shownWidth, useFrameSizes, type FrameDevice, type FrameScheme } from './EmailFrame'
import { HeldImages } from './EmailPreview'
import { Alert, Button, Disclosure, DropdownMenu, ErrorText, Sheet, Skeleton, SkeletonText, Tooltip } from './ui'
import './email-insight.css'

// "Will this email land and look right": Checks, the sendability check (POST /v1/emails/check) as at most three things
// to fix with everything technical behind one row, and the preview: the email as sent and as each client emulation shows
// it (POST /v1/emails/preview), side by side where the window has room. A sent email's page shows both; a campaign's
// review shows Checks.
export type InsightSource = { kind: 'email'; id: string; html: boolean } | { kind: 'campaign'; id: string; revision: number }
type Theme = 'light' | 'dark'
type Check = { data: SendabilityReport | undefined; error: Error | null; isPending: boolean; refetch: () => Promise<unknown> }

/** Below this the campaign editor and review warn before sending (grade C starts at 70). Never blocking. */
export const LOW_SENDABILITY = 70
const sourceKey = (source: InsightSource | null) => !source ? ['none'] : source.kind === 'email' ? ['email', source.id] : ['campaign', source.id, source.revision]
// A new revision of the same campaign keeps the last result up while it is checked again.
const sameSubject = (source: InsightSource | null) => (previous: readonly unknown[]) => Boolean(source) && previous[1] === source!.kind && previous[2] === source!.id

export function useSendability(source: InsightSource | null) {
  return useApiQuery(['email-check', ...sourceKey(source)], (api, signal) => api.emails.check(source!.kind === 'email' ? { emailId: source!.id } : { campaignId: source!.id }, signal), { enabled: Boolean(source), keepPrevious: sameSubject(source) })
}

const severityRank = { error: 0, warning: 1, info: 2 } as const
const severityLabel = { error: 'Error', warning: 'Warning', info: 'Note' } as const
const categoryLabel: Record<SendabilityCategory, string> = { authentication: 'Authentication', content: 'Content', headers: 'Headers', size: 'Size', rendering: 'Rendering', reputation: 'Reputation' }
const SCORE_NOTE = 'A high score means few problems found, not guaranteed inbox placement.'
// Errors, then warnings, then notes; within each, the categories that weigh most in this report's score first.
const ranked = (report: SendabilityReport, findings = report.findings) => {
  const weight = (category: SendabilityCategory) => report.categories.find(item => item.id === category)?.weight ?? 0
  return [...findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || weight(b.category) - weight(a.category))
}
// The fixes to make first: problems, each sentence once (two findings can call for the same fix).
const topFixes = (report: SendabilityReport, count = 3, findings = report.findings) => {
  const said = new Set<string>()
  return ranked(report, findings).filter(finding => finding.severity !== 'info' && !said.has(finding.fix) && said.add(finding.fix)).slice(0, count)
}

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

// ── Checks: at most three things to fix, in plain words, then everything technical behind one row ──

// Everything to fix: the list shows the first three, and a phone's chip and the toolbar's toggle count them all. The
// preview shows the client compatibility lint, so that finding stays out.
const fixesOf = (report: SendabilityReport) => topFixes(report, Infinity, report.findings.filter(finding => !PREVIEW_RULES.has(finding.ruleId)))
const toFix = (count: number) => count ? `${count} to fix` : 'Nothing to fix'
/** How many things there are to fix, and the same in a few words, as a phone's chip and a campaign's review say it:
 *  "3 to fix" or "Nothing to fix". */
export const checksCount = (report: SendabilityReport) => fixesOf(report).length
export const checksSummary = (report: SendabilityReport) => toFix(checksCount(report))
// Where a fix is made, where the dashboard has the place: the From domain's page, the workspace's settings, and for a
// draft its editor (`message`). A fix in a sent message or in how it is sent has none.
const fixLink = (finding: SendabilityFinding, report: SendabilityReport, message?: string) => finding.fixIn === 'domain' ? (report.domainId ? `/domains/${encodeURIComponent(report.domainId)}` : '/domains')
  : finding.fixIn === 'workspace' ? '/settings#general' : finding.fixIn === 'message' ? message ?? null : null

function Score({ report }: { report: SendabilityReport }) {
  return <Tooltip content={SCORE_NOTE}><span className="ss__score" tabIndex={0} role="img" aria-label={`Score ${report.score} of 100, grade ${report.grade}`}>
    <span>{report.score}</span><span className="ss__dot" aria-hidden="true">·</span><span className="ss__grade">{report.grade}</span>
  </span></Tooltip>
}

/**
 * Up to three things to fix, each a link where the dashboard has the place to fix it, or Nothing to fix; then one
 * Technical details row with the score, its categories and every finding. `titled`: false where a sheet's title or a
 * step names it. `message`: where a draft's own content is edited (a campaign's editor); a sent email has no such place.
 */
export function Checks({ check, titled = true, message }: { check: Check; titled?: boolean; message?: string }) {
  const id = useId()
  const head = titled ? <h2 id={id} className="ss__title">Checks</h2> : null
  if (check.isPending) return <section className="ss" aria-labelledby={titled ? id : undefined} aria-busy="true">{head}
    <div className="ss__fixes">{['86%', '70%'].map(width => <SkeletonText key={width} width={width} lineHeight={28} />)}</div></section>
  if (!check.data) return <section className="ss" aria-labelledby={titled ? id : undefined}>{head}
    <p className="ss__error"><ErrorText error={check.error} fallback="Couldn’t check this email." /></p><Button size="sm" onClick={() => void check.refetch()}>Try again</Button></section>
  const report = check.data, fixes = fixesOf(report).slice(0, 3)
  return <section className="ss" aria-labelledby={titled ? id : undefined}>
    {head}
    {fixes.length ? <ul className="ss__fixes" aria-label="To fix">{fixes.map(finding => { const to = fixLink(finding, report, message); return <li key={finding.ruleId}>
      {to ? <Link className="ss__fix" to={to}><span><AddressText text={finding.fix} /></span><ArrowUpRight size={12} aria-hidden="true" /></Link> : <span className="ss__fix"><AddressText text={finding.fix} /></span>}
    </li> })}</ul> : <p className="ss__clear">Nothing to fix</p>}
    <Disclosure title="Technical details" className="ss__technical">
      <p className="ss__scored"><span>Score</span><Score report={report} /></p>
      <Categories report={report} />
      <Findings findings={ranked(report, report.findings.filter(finding => !PREVIEW_RULES.has(finding.ruleId)))} />
    </Disclosure>
  </section>
}

/** Where the window has no room for a details column: Checks in the preview's toolbar with how many to fix, opening them beside it. */
export function ChecksToggle({ check, open, onToggle, controls }: { check: Check; open: boolean; onToggle: () => void; controls: string }) {
  const count = check.data ? fixesOf(check.data).length : 0
  return <button type="button" className="ev-details" aria-expanded={open} aria-controls={controls} onClick={onToggle} aria-label={check.data ? `Checks: ${toFix(count)}` : 'Checks'}>
    Checks<span className="ev-details__count" aria-hidden="true">{check.data ? count ? toFix(count) : <CheckIcon size={14} /> : check.isPending ? <Skeleton width={40} height={12} /> : null}</span>
  </button>
}

/** A phone's checks: one chip under the subject with how many to fix, opening them in a sheet. */
export function ChecksChip({ check, onOpen }: { check: Check; onOpen: (opener: HTMLElement) => void }) {
  if (check.isPending) return <Skeleton className="ss-chip-skeleton" width="var(--chip-width)" height={28} />
  return <button type="button" className="ss-chip" aria-haspopup="dialog" onClick={event => onOpen(event.currentTarget)}>
    {check.data ? <><span className="sr-only">Checks: </span>{toFix(fixesOf(check.data).length)}</> : 'Checks'}
  </button>
}

function Categories({ report }: { report: SendabilityReport }) {
  return <ul className="ei-categories" aria-label="Scores by category">{report.categories.map(category => <li key={category.id}>
    <span className="ei-categories__label">{categoryLabel[category.id]}</span>
    <span className="ei-categories__value">{category.weight ? category.score : <Tooltip content="Not scored: no evidence yet."><span tabIndex={0} aria-label="Not scored">—</span></Tooltip>}</span>
    <span className="ei-bar" aria-hidden="true"><span style={{ transform: `scaleX(${category.weight ? category.score / 100 : 0})` }} /></span>
  </li>)}</ul>
}

// Problems (errors, then warnings) first; notes are measurements and context that cost few or no points.
function Findings({ findings: sorted }: { findings: SendabilityFinding[] }) {
  const problems = sorted.filter(finding => finding.severity !== 'info'), notes = sorted.filter(finding => finding.severity === 'info')
  return <>
    {problems.length ? <ul className="ei-findings" aria-label="Problems">{problems.map(finding => <Finding key={finding.ruleId} finding={finding} />)}</ul>
      : <p className="ss__clear">No problems found.</p>}
    {notes.length > 0 && <div className="ei-notes"><h3 className="ei-group">Notes</h3><ul className="ei-findings" aria-label="Notes">{notes.map(finding => <Finding key={finding.ruleId} finding={finding} />)}</ul></div>}
  </>
}

const evidenceLabel = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, first => first.toUpperCase()).replace(/ ([A-Z])/g, (_, letter: string) => ` ${letter.toLowerCase()}`)
function Finding({ finding }: { finding: SendabilityFinding }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const evidence = Object.entries(finding.evidence ?? {})
  return <li className="ei-finding">
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

// Over each column: what it shows, and for a client its issue count, classic Outlook's included (opening the list over
// the frame). Remote images don't load in an emulation; their boxes show as placeholders (EmailFrame.tsx), not a note.
function Caption({ label, width, issues, classic = [], open = false, onOpenChange, panel }: { label: string; width?: number; issues?: PreviewIssue[]; classic?: PreviewIssue[]; open?: boolean; onOpenChange?: (open: boolean) => void; panel?: string }) {
  const all = issues ? [...issues, ...classic] : []
  return <div className="ev-caption" style={width ? { width } : undefined}>
    <span className="ev-caption__label">{label}</span>
    {issues && <span className="ev-caption__end">
      {all.length ? <button type="button" className="ev-caption__issues" aria-expanded={open} aria-controls={panel} onClick={() => onOpenChange?.(!open)}>
        <span className={`ei-dot ui-tone--${issueTone(all)}`} aria-hidden="true" />{plural(all.length, 'issue')}<ChevronRight size={14} aria-hidden="true" />
      </button> : <span className="ev-caption__clear"><CheckIcon size={14} aria-hidden="true" />No issues</span>}
    </span>}
  </div>
}
// Classic Outlook for Windows renders with Word, so it is checked, not previewed: its issues follow under its name.
function IssueLists({ issues, classic }: { issues: PreviewIssue[]; classic: PreviewIssue[] }) {
  return <>
    {issues.length > 0 && <IssueList issues={issues} />}
    {classic.length > 0 && <><h3 className="ei-group">Classic Outlook for Windows</h3><IssueList issues={classic} /></>}
  </>
}
function IssuePanel({ id, issues, classic, open }: { id: string; issues: PreviewIssue[]; classic: PreviewIssue[]; open: boolean }) {
  return <div id={id} className="ev-issues" data-open={open || undefined} inert={!open}><div><IssueLists issues={issues} classic={classic} /></div></div>
}
// A phone's issue count beside the view, opening the client's issues in a sheet.
function IssuesButton({ caption, issues, classic }: { caption: string; issues: PreviewIssue[]; classic: PreviewIssue[] }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const all = [...issues, ...classic]
  return <>
    <button ref={trigger} type="button" className="ev-issues-button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      {all.length ? <><span className={`ei-dot ui-tone--${issueTone(all)}`} aria-hidden="true" />{plural(all.length, 'issue')}</> : <><CheckIcon size={14} aria-hidden="true" />No issues</>}
    </button>
    <Sheet open={open} onOpenChange={setOpen} title={caption} className="ev-issues-sheet" returnFocus={trigger}>
      {all.length ? <IssueLists issues={issues} classic={classic} /> : <p className="ei-clear"><CheckIcon size={16} aria-hidden="true" />No issues</p>}
    </Sheet>
  </>
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
// A phone's light or dark for an emulated client: one icon that switches (a touch screen shows no tooltip saying why it
// would be off, so it shows only where it applies).
function ThemeButton({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return <Tooltip content="Preview in dark mode"><button type="button" className="ev-theme" aria-pressed={theme === 'dark'} aria-label="Preview in dark mode" onClick={() => onChange(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}</button></Tooltip>
}
// A phone's view switcher: the view's name, opening a sheet with every view and each client's issue count.
function ViewPicker({ value, current, options, onChange, loading }: { value: string; current: string; options: ViewOption[]; onChange: (value: string) => void; loading: boolean }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return <>
    <button ref={trigger} type="button" className="ev-picker" aria-haspopup="dialog" aria-expanded={open} aria-label={`View: ${current}`} onClick={() => setOpen(true)}>{current}<ChevronDown size={14} aria-hidden="true" /></button>
    <Sheet open={open} onOpenChange={setOpen} title="View" className="ui-action-sheet ev-picker-sheet" returnFocus={trigger}>
      <div className="ui-action-sheet__items" role="listbox" aria-label="View">
        {options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} className="ui-action-sheet__item" onClick={() => { setOpen(false); onChange(option.value) }}>
          <span className="ui-action-sheet__label">{option.label}</span>
          {option.count ? <span className="ev-view__count" data-tone={option.tone}>{plural(option.count, 'issue')}</span> : null}
          {option.value === value && <CheckIcon size={14} aria-hidden="true" />}
        </button>)}
        {loading && <div className="ui-action-sheet__item ev-picker-sheet__loading" aria-hidden="true"><Skeleton width={160} height={12} /></div>}
      </div>
      <button type="button" className="ui-action-sheet__item ui-action-sheet__cancel" onClick={() => setOpen(false)}>Cancel</button>
    </Sheet>
  </>
}

/** The email as sent or received: its sandboxed document (null while it is prepared), the same on a dark canvas when the
 *  email opts in to dark mode (`dark`; undefined when it doesn't), and its parts; a received one's `headers` too. */
export type OriginalEmail = { doc: string | null; dark?: string | null; html: string; text: string; headers?: string; error?: string }
type PreviewSource = { emailId: string } | { html: string }
type Slot = { key: string; view: string; device: FrameDevice }
type Column = Slot & { doc: string; scheme: FrameScheme }

const GAP = 16
// The phone width joins the desktop one only where both fit at FIT of their size or more (800 + 390 px at FIT).
const FIT = .9
const BOTH_ROOM = Math.round((FRAME_WIDTH.desktop + GAP + FRAME_WIDTH.mobile) * FIT)

// Each view on its own: Original is the email as sent, a client is how that client shows it. Where they fit, its desktop
// and phone widths side by side; otherwise the chosen one. Widths are the span measured at desktop width (the device's
// until measured) and the phone's width.
function arrange(view: string, device: FrameDevice, room: number, wide: boolean, widthOf: (device: FrameDevice) => number): Slot[] {
  const both: Slot[] = [{ key: 'desktop', view, device: 'desktop' }, { key: 'mobile', view, device: 'mobile' }]
  return wide && (widthOf('desktop') + GAP + widthOf('mobile')) * FIT <= room ? both : [{ key: device, view, device }]
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
const useClientDocs = (previews: ClientPreview[] | undefined) => useMemo(() => new Map((previews ?? []).flatMap(item => item.html ? [[item.client, frameDocument(item.html)] as const] : [])), [previews])

/**
 * The preview with one switcher. With `original` (a sent or received email): Original, the email as sent with its
 * images, then each client where there is a `previewSource` and a `check` (a sent email); the HTML source, plain text
 * and a received email's headers sit behind More. Without it (a draft): the clients. Each client is an offline
 * emulation with its issue count. `fill`: the preview fills its parent's height and scrolls inside; otherwise it is as
 * tall as the email. `wide`: where there is room, the phone width beside the desktop one. `compact` (a phone or tablet): one row of controls, the view picked from a sheet, no captions;
 * a phone always shows phone width.
 */
// `heldImages`: the email as sent has remote images held back (useEmailDocument's `held`): its view says so, with Load
// images, in the row over the frames, where nothing moves when the line comes or goes (on a phone, over the frame).
export function EmailViews({ source, previewSource, check, original, fill = false, wide = false, compact = false, toolbarEnd, heldImages }: { source: InsightSource; previewSource: PreviewSource | null; check?: Check; original?: OriginalEmail; fill?: boolean; wide?: boolean; compact?: boolean; toolbarEnd?: ReactNode; heldImages?: { why: string; onLoad: () => void } | null }) {
  const phone = usePhone()
  const id = useId()
  const [room, canvas] = useRoom()
  const hasHtml = original ? original.html.trim().length > 0 : Boolean(previewSource)
  const [chosen, setChosen] = useState<string | null>(null)
  // A sent email opens on Original; a draft, which has no Original, on the first client.
  const view = chosen ?? (original ? 'original' : CLIENTS[0].value)
  // In a dark dashboard, an email that opts in to dark mode opens dark, as a dark mail client shows it. Any other email
  // shows as it is, light (the frame around it is the matte, never a recoloured email).
  const dashboard = useTheme().theme
  const [theme, setTheme] = useState<Theme>(() => dashboard === 'dark' && original?.dark !== undefined ? 'dark' : 'light')
  const [chosenDevice, setDevice] = useState<FrameDevice>(() => phone ? 'mobile' : 'desktop')
  const device = compact && phone ? 'mobile' : chosenDevice
  const [openIssues, setOpenIssues] = useState<Record<string, boolean>>({})
  const both = wide && room >= BOTH_ROOM
  // A wide preview may show both widths below BOTH_ROOM too, when the view's desktop span is narrow (arrange), so it
  // fetches both: a column waiting on a width nobody fetched never shows.
  const needs = { desktop: wide || device === 'desktop', mobile: wide || device === 'mobile' }
  const queries = { desktop: useClientPreviews(source, previewSource, theme, 'desktop', needs.desktop), mobile: useClientPreviews(source, previewSource, theme, 'mobile', needs.mobile) }
  const docs = { desktop: useClientDocs(queries.desktop.data), mobile: useClientDocs(queries.mobile.data) }
  const readers = { desktop: issueReader(check?.data, queries.desktop.data), mobile: issueReader(check?.data, queries.mobile.data) }
  const client = CLIENTS.find(item => item.value === view)
  const sourceView = view === 'html' || view === 'text' || view === 'headers'
  const frameView = view === 'original' ? Boolean(original) && hasHtml : Boolean(client && previewSource)
  // Light or dark: a client's emulation for the chosen theme; the email as sent dark only where it opts in to dark mode,
  // as Apple Mail shows it (otherwise it shows light in any theme), and plain text in the chosen theme.
  const originalDark = original?.dark !== undefined
  const themed = Boolean(client) || (view === 'original' && Boolean(original) && (!hasHtml || originalDark))
  const shownTheme: Theme = themed ? theme : 'light'
  // A frame's color-scheme: dark only for the email as sent on its dark canvas. An emulation has resolved the client's
  // dark mode already, and its frame stays light.
  const schemeOf = (of: string): FrameScheme => of === 'original' && originalDark ? shownTheme : 'light'
  // A column's document: null while it is on its way, undefined when there is none (no preview for that client).
  const docOf = (of: string, on: FrameDevice): string | null | undefined => {
    if (of === 'original') return (schemeOf(of) === 'dark' ? original?.dark : original?.doc) ?? null
    const item = CLIENTS.find(entry => entry.value === of)
    return !item ? undefined : !queries[on].data ? null : docs[on].get(item.clients[on])
  }

  // Whether the phone width fits beside the desktop one depends on the span the view takes at desktop width, so that is
  // measured first.
  const deciding = frameView ? [view] : []
  const decided = useFrameSizes(deciding.map(of => ({ doc: docOf(of, 'desktop') ?? null, width: FRAME_WIDTH.desktop, scheme: schemeOf(of) })))
  const widthOf = (on: FrameDevice) => on === 'desktop' && decided[0] ? shownWidth(decided[0]) : FRAME_WIDTH[on]
  const slots = frameView ? arrange(view, device, room, wide, widthOf) : []
  const wanted = slots.map(slot => ({ ...slot, doc: docOf(slot.view, slot.device), scheme: schemeOf(slot.view) }))
  const measured = useFrameSizes(wanted.map(column => ({ doc: column.doc ?? null, width: FRAME_WIDTH[column.device], scheme: column.scheme })))
  const failedQuery = slots.map(slot => slot.view === 'original' ? null : queries[slot.device]).find(query => query?.isError && !query.data)
  const missing = !failedQuery && wanted.some(column => column.doc === undefined)
  const ready = room > 0 && wanted.length > 0 && deciding.every((of, index) => !docOf(of, 'desktop') || decided[index]) && wanted.every((column, index) => column.doc && measured[index])
  // The columns on screen change only once every new one has its size, all at once: until then the last ones stay, dimmed.
  const signature = ready ? wanted.map(column => `${column.key}:${frameKey(column.doc!, FRAME_WIDTH[column.device], column.scheme)}`).join(' ') : null
  const [shown, setShown] = useState<{ signature: string; columns: Column[] } | null>(null)
  if (signature && signature !== shown?.signature) setShown({ signature, columns: wanted as Column[] })

  // Client options join the switcher once their counts are known, so no option moves after it appears. Where both
  // widths show, a client's count covers both.
  const clientsReady = Boolean(previewSource && check) && !check?.isPending && (!needs.desktop || !queries.desktop.isPending) && (!needs.mobile || !queries.mobile.isPending)
  const counted: FrameDevice[] = both ? ['desktop', 'mobile'] : [device]
  // At desktop width Outlook's count takes in classic Outlook's, as its caption does.
  const issuesOf = (item: Client) => {
    const all = new Map<string, PreviewIssue>()
    for (const on of counted) for (const issue of readers[on](item.clients[on])) if (!all.has(issue.feature) || issue.severity === 'error') all.set(issue.feature, issue)
    const classic = item.value === 'outlook' && counted.includes('desktop') ? readers.desktop(CLASSIC_OUTLOOK) : []
    return [...all.values(), ...classic]
  }
  const options: ViewOption[] = [
    ...original ? [{ value: 'original', label: 'Original' }] : [],
    ...clientsReady ? CLIENTS.map(item => { const issues = issuesOf(item); return { value: item.value, label: item.label, count: issues.length || undefined, tone: issueTone(issues), hint: counted.map(on => item.captions[on]).join(' and ') } }) : [],
  ]

  const columns = shown?.columns ?? []
  const sizes = columns.map(column => frameSize(column.doc, FRAME_WIDTH[column.device], column.scheme))
  // A column's width before scaling: its span; at phone width an email wider than the phone shrinks to fit, as phone
  // apps show it. Every column then scales alike to fit the room.
  const naturals = columns.map((column, index) => { const size = sizes[index]; return !size ? 0 : column.device === 'mobile' ? Math.min(shownWidth(size), FRAME_WIDTH.mobile) : shownWidth(size) })
  const total = naturals.reduce((sum, width) => sum + width, 0)
  const scale = total && room ? Math.min(1, Math.max(.1, (room - GAP * (columns.length - 1)) / total)) : 1
  const widths = naturals.map(width => Math.round(width * scale))
  const pending = Boolean(shown) && (shown!.signature !== signature || slots.some(slot => slot.view !== 'original' && queries[slot.device].isPlaceholderData))
  const describe = (column: Slot) => {
    const item = CLIENTS.find(entry => entry.value === column.view)
    if (!item) return { label: '', title: column.device === 'mobile' ? 'Email as sent, phone width' : 'Email as sent' }
    const issues = readers[column.device](item.clients[column.device]), classic = item.value === 'outlook' && column.device === 'desktop' ? readers.desktop(CLASSIC_OUTLOOK) : []
    return { label: item.captions[column.device], title: `${item.captions[column.device]}, ${theme} mode`, item, issues, classic, key: `${item.value}@${column.device}` }
  }
  const showDevice = !(slots.some(slot => slot.device === 'desktop') && slots.some(slot => slot.device === 'mobile'))
  const showFrames = frameView && !failedQuery && !missing
  const held = Boolean(heldImages) && view === 'original' && showFrames
  const listing = hasHtml && !clientsReady && Boolean(previewSource)
  const offTheme = themed ? undefined : view === 'original' && hasHtml ? 'This email doesn’t opt in to dark mode. Pick a client to see it dark.' : 'Dark mode depends on the client', offWidth = sourceView || !hasHtml ? 'Width applies to previews' : undefined
  const sourceName = view === 'html' ? 'HTML source' : view === 'headers' ? 'Headers' : 'Plain text'
  const more = original && <DropdownMenu label="More views" align="end" items={[{ label: 'HTML source', onSelect: () => setChosen('html'), disabled: !hasHtml }, { label: 'Plain text', onSelect: () => setChosen('text') }, ...original.headers !== undefined ? [{ label: 'Headers', onSelect: () => setChosen('headers') }] : []]}
    trigger={<button type="button" className="ev-more" data-active={(sourceView && !compact) || undefined} aria-label={sourceView ? `More views: ${sourceName}` : 'More views'} title="More views">{sourceView && !compact ? (view === 'html' ? 'HTML' : view === 'headers' ? 'Headers' : 'Text') : <MoreHorizontal size={16} aria-hidden="true" />}</button>} />
  if (!original && !previewSource) return <p className="muted ev-note">Nothing to preview</p>
  return <div className="ev" data-fill={fill || undefined} data-compact={compact || undefined}>
    {compact ? <div className="ev-toolbar">
      <ViewPicker value={view} current={sourceView ? sourceName : options.find(option => option.value === view)?.label ?? client?.label ?? 'Original'} options={options} onChange={setChosen} loading={listing} />
      {client && clientsReady && frameView && <IssuesButton caption={client.captions[device]} issues={readers[device](client.clients[device])} classic={client.value === 'outlook' && device === 'desktop' ? readers.desktop(CLASSIC_OUTLOOK) : []} />}
      <div className="ev-toolbar__end">
        {!phone && <Toggle label="Width" value={device} options={DEVICES} onChange={setDevice} off={offWidth} />}
        {themed && <ThemeButton theme={theme} onChange={setTheme} />}
        {more}
        {toolbarEnd}
      </div>
    </div> : <div className="ev-toolbar">
      <ViewSwitcher value={view} options={options} onChange={setChosen} loading={listing} />
      <div className="ev-toolbar__end">
        {showDevice && <Toggle label="Width" value={device} options={DEVICES} onChange={setDevice} off={offWidth} />}
        <Toggle label="Color scheme" value={shownTheme} options={THEMES} onChange={setTheme} off={offTheme} />
        {more}
        {toolbarEnd}
      </div>
    </div>}
    <div className="ev-stage">
      {!compact && <div className="ev-captions">
        {sourceView ? <Caption label={sourceName} />
          : view === 'original' && original && !hasHtml ? null
          : held && columns.length > 0 && columns.every(column => column.view === 'original') ? <HeldImages why={heldImages!.why} onLoad={heldImages!.onLoad} style={{ width: widths.reduce((sum, width) => sum + width, 0) + GAP * (columns.length - 1) }} />
          : showFrames && columns.map((column, index) => { const about = describe(column); return <Caption key={column.key} label={about.label} width={widths[index]} issues={about.issues} classic={about.classic}
            open={Boolean(about.key && openIssues[about.key])} onOpenChange={open => setOpenIssues(state => ({ ...state, [about.key!]: open }))} panel={`${id}-${column.key}`} /> })}
      </div>}
      {compact && held && <HeldImages why={heldImages!.why} onLoad={heldImages!.onLoad} />}
      <div ref={canvas} className={fill ? 'ev-canvas ui-scroll-fade' : 'ev-canvas'}>
        {sourceView && original ? <pre className="email-source">{view === 'html' ? original.html || 'No HTML part.' : view === 'headers' ? original.headers || 'No headers stored.' : original.text || 'No plain-text part.'}</pre>
          : view === 'original' && original && !hasHtml ? <pre className="email-text" data-scheme={shownTheme}>{original.text || 'This email has no body.'}</pre>
          : failedQuery ? <Alert tone="neutral" title="Couldn’t emulate the email clients"><ErrorText error={failedQuery.error} /><div className="ei-retry"><Button size="sm" onClick={() => void failedQuery.refetch()}>Try again</Button></div></Alert>
          : missing ? <div className="email-frame--empty muted">No preview for this client.</div>
          : shown ? <>
            {original?.error && columns.some(column => column.view === 'original') && <p className="ev-note ui-field__error" role="alert">{original.error}</p>}
            <div className="ev-columns" data-pending={pending || undefined}>{columns.map((column, index) => {
              const size = sizes[index], about = describe(column)
              return size ? <div key={column.key} className="ev-column" style={{ width: widths[index] }}>
                {!compact && about.item && about.issues!.length + about.classic!.length > 0 && <IssuePanel id={`${id}-${column.key}`} issues={about.issues!} classic={about.classic!} open={Boolean(openIssues[about.key!])} />}
                <EmailFrame doc={column.doc} scheme={column.scheme} size={size} scale={scale * naturals[index] / shownWidth(size)} title={about.title} pending={pending} />
              </div> : null
            })}</div>
          </> : <div className="ev-placeholder" aria-hidden="true" />}
      </div>
    </div>
  </div>
}
