import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Archive, ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronDown, ChevronRight, Copy, Download, FileText, Globe, Inbox, Info, KeyRound, LayoutGrid, LifeBuoy, Lock, MoreHorizontal, Pencil, Plus, RefreshCw, ScrollText, Search, Send, Settings, ShieldCheck, Trash2, Users, X, type LucideIcon } from 'lucide-react'
import { Button, Checkbox, DataTable, DetailHeader, DropdownMenu, EmptyState, FactsRow, Field, Icon, IconButton, Identifier, Input, ListPage, ListToolbar, PageHeader, Pagination, SearchField, SectionHeader, Select, StatusBadge, StatusDot, Switch, Tabs, Tooltip, ICON_SIZES, ICON_STROKES, type ButtonProps, type Column, type IconSize, type MenuItem } from '../../components/ui'
import { NightmailWordmark } from '../../components/NightmailLogo'
import { ThemeToggle } from '../../components/ThemeToggle'
import { useTheme } from '../../lib/theme'
import './design-sheet.css'

// The design sheet: the foundation's tokens and shared components on one page, rendered by the components themselves
// (dev and VITE_DESIGN_SHEET=1 builds only, lib/design-sheet.ts). Colours and type metrics are read back from the live
// styles, so they always match the active theme. The examples are synthetic.

const swatchGroups: { title: string; tokens: string[] }[] = [
  { title: 'Surfaces', tokens: ['--color-deep', '--color-surface', '--color-control', '--color-overlay-surface', '--color-layer-1', '--color-layer-2', '--color-layer-3'] },
  { title: 'Text and borders', tokens: ['--color-text', '--color-muted', '--color-faint', '--color-border-muted', '--color-border', '--color-border-strong'] },
  { title: 'Accent and status', tokens: ['--color-accent', '--color-accent-hover', '--color-accent-text', '--color-accent-data', '--color-success-marker', '--color-warning-marker', '--color-danger-marker', '--color-info-marker'] },
]

const hex = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0').toUpperCase()
const fraction = (value: string | undefined) => value === undefined ? 1 : value.endsWith('%') ? parseFloat(value) / 100 : parseFloat(value)
// A computed colour's channels (0–255) and alpha, from the forms browsers serialize: rgb()/rgba() and color(srgb …).
function channels(css: string): [number, number, number, number] | null {
  const rgb = css.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/)
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3], fraction(rgb[4])]
  const srgb = css.match(/^color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)\s*(?:\/\s*([\d.]+%?))?\s*\)$/)
  if (srgb) return [+srgb[1] * 255, +srgb[2] * 255, +srgb[3] * 255, fraction(srgb[4])]
  return null
}
// A token as the active theme resolves it: its opaque colour, and its alpha where it has one. Forms the parser doesn't
// know (oklch() without relative colour support) are drawn on a 1×1 canvas and read back.
function readColors(tokens: string[], probe: HTMLElement) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const relative = CSS.supports('color', 'rgb(from red r g b)')
  const resolve = (css: string) => { probe.style.color = css; return getComputedStyle(probe).color }
  const sample = (css: string): [number, number, number, number] => {
    if (!context) return [0, 0, 0, 1]
    context.clearRect(0, 0, 1, 1); context.fillStyle = '#000'; context.fillStyle = css; context.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
    return [r, g, b, a / 255]
  }
  const result: Record<string, string> = {}
  for (const token of tokens) {
    const raw = resolve(`var(${token})`)
    const alpha = (channels(raw) ?? [0, 0, 0, fraction(raw.match(/\/\s*([\d.]+%?)\s*\)$/)?.[1])])[3]
    const opaque = relative ? resolve(`rgb(from var(${token}) r g b)`) : raw
    const [r, g, b] = channels(opaque) ?? sample(opaque)
    result[token] = `#${hex(r)}${hex(g)}${hex(b)}${alpha < .995 ? ` · ${Math.round(alpha * 1000) / 10}%` : ''}`
  }
  probe.style.color = ''
  return result
}

function Swatches() {
  const { theme } = useTheme()
  const probe = useRef<HTMLSpanElement>(null)
  const [colors, setColors] = useState<Record<string, string>>({})
  // After the theme provider's own layout effect has switched data-theme, and the frame has its new styles.
  useEffect(() => {
    const frame = requestAnimationFrame(() => { if (probe.current) setColors(readColors(swatchGroups.flatMap(group => group.tokens), probe.current)) })
    return () => cancelAnimationFrame(frame)
  }, [theme])
  return <div className="ds-swatches">
    <span ref={probe} className="ds-probe" aria-hidden="true" />
    {swatchGroups.map(group => <div key={group.title} className="ds-swatch-group">
      <h3 className="ds-subhead">{group.title}</h3>
      <ul className="ds-swatch-list">{group.tokens.map(token => <li key={token} className="ds-swatch">
        <span className="ds-swatch__chip" style={{ '--swatch': `var(${token})` } as CSSProperties} />
        <code className="ds-swatch__token">{token.replace('--color-', '')}</code>
        <code className="ds-swatch__hex">{colors[token] ?? '\u00a0'}</code>
      </li>)}</ul>
    </div>)}
  </div>
}

// A type specimen and its live metrics: size/line height · weight · family · tracking, as computed.
function Specimen({ name, children, measure }: { name: string; children: ReactNode; measure?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState('')
  useLayoutEffect(() => {
    const target = ref.current?.querySelector<HTMLElement>(measure ?? '[data-specimen]')
    if (!target) return
    const style = getComputedStyle(target), size = parseFloat(style.fontSize), tracking = parseFloat(style.letterSpacing)
    const family = style.fontFamily.split(',')[0].replaceAll(/["']/g, '').trim()
    setMetrics(`${Math.round(size)}/${Math.round(parseFloat(style.lineHeight))} · ${style.fontWeight} · ${family}${Number.isFinite(tracking) && tracking !== 0 ? ` · ${(tracking / size).toFixed(3).replace(/0+$/, '')}em` : ''}`)
  }, [measure])
  return <div ref={ref} className="ds-specimen">
    <div className="ds-specimen__meta"><span>{name}</span><code>{metrics || '\u00a0'}</code></div>
    <div className="ds-specimen__sample">{children}</div>
  </div>
}

const coreIcons: [string, LucideIcon][] = [['LayoutGrid', LayoutGrid], ['ScrollText', ScrollText], ['Inbox', Inbox], ['Send', Send], ['Users', Users], ['Globe', Globe], ['KeyRound', KeyRound], ['BookOpen', BookOpen], ['Settings', Settings], ['LifeBuoy', LifeBuoy], ['ShieldCheck', ShieldCheck], ['Search', Search], ['Download', Download], ['Plus', Plus], ['Copy', Copy], ['Check', Check], ['X', X], ['MoreHorizontal', MoreHorizontal], ['ChevronDown', ChevronDown], ['ChevronRight', ChevronRight], ['ArrowLeft', ArrowLeft], ['ArrowUpRight', ArrowUpRight], ['Info', Info], ['Lock', Lock], ['Trash2', Trash2], ['Archive', Archive]]

const navigationSample: [string, LucideIcon, boolean][] = [['Overview', LayoutGrid, false], ['Logs', ScrollText, true], ['Receiving', Inbox, false]]

const buttonRows: { name: string; props: ButtonProps; children: ReactNode; icon?: boolean }[] = [
  { name: 'Primary', props: { variant: 'primary' }, children: <><Icon icon={Plus} />Add domain</> },
  { name: 'Secondary', props: { variant: 'secondary' }, children: 'Export CSV' },
  { name: 'Ghost', props: { variant: 'ghost' }, children: 'View logs' },
  { name: 'Danger', props: { variant: 'danger' }, children: 'Remove domain' },
  { name: 'Small', props: { variant: 'secondary', size: 'sm' }, children: <><Icon icon={RefreshCw} size="sm" />Refresh</> },
  { name: 'Icon button', props: { variant: 'secondary' }, children: <Icon icon={Download} />, icon: true },
]
const buttonStates = [{ name: 'Default', className: '' }, { name: 'Hover', className: 'ds-hover' }, { name: 'Keyboard focus', className: 'ds-focus' }, { name: 'Disabled', className: '', disabled: true }]

type Domain = { id: string; name: string; status: string; region: string; added: string }
const domains: Domain[] = [
  { id: 'dom_1', name: 'northwind.example', status: 'verified', region: 'us-east-1', added: '2026-11-02' },
  { id: 'dom_2', name: 'mail.northwind.example', status: 'pending', region: 'us-east-1', added: '2026-11-19' },
  { id: 'dom_3', name: 'billing.northwind.example', status: 'failed', region: 'eu-west-1', added: '2026-11-23' },
]
const rowActions = (domain: Domain): MenuItem[] => [
  { label: 'Verify DNS', icon: <Icon icon={ShieldCheck} />, onSelect: () => {} },
  { label: 'Copy records', icon: <Icon icon={Copy} />, onSelect: () => {} },
  { label: `Remove ${domain.name}`, icon: <Icon icon={Trash2} />, destructive: true, onSelect: () => {} },
]
const domainColumns: Column<Domain>[] = [
  { key: 'name', label: 'Domain', width: '38%', render: row => <span className="ds-cell-strong">{row.name}</span>, card: 'title' },
  { key: 'status', label: 'Status', width: '20%', render: row => <StatusBadge status={row.status} />, card: 'aside' },
  { key: 'region', label: 'Region', width: '18%', render: row => <span className="ui-mono ds-cell-mono">{row.region}</span>, card: 'line' },
  { key: 'added', label: 'Added', render: row => <time className="ui-mono ds-cell-mono" dateTime={row.added}>{row.added}</time>, card: 'inline' },
  { key: 'actions', label: '', width: 56, align: 'right', render: row => <DropdownMenu label={`Actions for ${row.name}`} items={rowActions(row)} />, card: 'end' },
]

function ListDemo() {
  const [tab, setTab] = useState('all')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  return <div className="ds-list">
    <div className="ds-list__desktop">
      <p className="ds-caption">Desktop</p>
      <ListPage
        header={<PageHeader title="Domains" actions={<><Tooltip content="Domain guide"><IconButton variant="secondary" label="Domain guide"><Icon icon={BookOpen} /></IconButton></Tooltip><Button variant="primary"><Icon icon={Plus} />Add domain</Button></>} />}
        tabs={<Tabs label="Domain status" value={tab} onValueChange={setTab} items={[{ value: 'all', label: 'All' }, { value: 'verified', label: 'Verified', count: 4 }, { value: 'pending', label: 'Pending', count: 1 }]} />}
        toolbar={<ListToolbar
          search={<SearchField aria-label="Search domains" placeholder="Search domains" value={query} onChange={event => setQuery(event.target.value)} />}
          filters={<Select aria-label="Filter by status" value={status} onValueChange={setStatus} options={[{ value: 'all', label: 'All statuses' }, { value: 'verified', label: 'Verified' }, { value: 'pending', label: 'Pending' }, { value: 'failed', label: 'Failed' }]} />}
          end={<Tooltip content="Export CSV"><IconButton variant="secondary" label="Export CSV"><Icon icon={Download} /></IconButton></Tooltip>} />}
        pagination={<Pagination page={page} pageSize={3} total={5} onPageChange={setPage} />}>
        <DataTable card={false} columns={domainColumns} rows={domains} rowKey={row => row.id} onRowClick={() => {}} rowLabel={row => row.name} />
      </ListPage>
    </div>
    <div className="ds-list__phone">
      <p className="ds-caption">Phone</p>
      {/* A phone's DataTable, drawn with its own classes: title and status, then region · added, the row menu at the end. */}
      <div className="ui-cards ds-phone-cards" style={{ '--table-row-height': '69px' } as CSSProperties}>
        <ul className="ui-cards__list">{domains.map(domain => <li key={domain.id} className="ui-card" data-clickable>
          <div className="ui-card__main">
            <div className="ui-card__head"><span className="ui-card__title"><button type="button" className="ui-row-link ui-card__link">{domain.name}</button></span><span className="ui-card__aside"><StatusBadge status={domain.status} /></span></div>
            <div className="ui-card__line"><span className="ui-card__segment ui-mono">{domain.region}</span><span className="ui-card__segment ui-mono">{domain.added}</span></div>
          </div>
          <div className="ui-card__end"><DropdownMenu label={`Actions for ${domain.name}`} items={rowActions(domain)} /></div>
        </li>)}</ul>
      </div>
    </div>
  </div>
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} className="ds-section" aria-labelledby={`${id}-title`}>
    <SectionHeader title={<span id={`${id}-title`}>{title}</span>} />
    {children}
  </section>
}

export function DesignSheetPage() {
  const { theme } = useTheme()
  const [name, setName] = useState('Northwind')
  const [region, setRegion] = useState('us-east-1')
  const [search, setSearch] = useState('')
  const [tracking, setTracking] = useState(true)
  const [optIn, setOptIn] = useState(false)
  useEffect(() => { const previous = document.title; document.title = 'Design sheet · Nightmail'; return () => { document.title = previous } }, [])
  return <div className="ds-page">
    <main className="ds-sheet">
      <header className="ds-header">
        <div className="ds-header__brand"><NightmailWordmark title="Nightmail" /><h1>Design system · Phase 1 foundation</h1><p className="ds-caption">Inter (UI) + OpenTUI Mono (data / IDs / code)</p></div>
        <div className="ds-header__theme"><span className="ds-theme-name">{theme === 'dark' ? 'Dark' : 'Light'}</span><ThemeToggle /></div>
      </header>

      <Section id="colour" title="Colour">
        <Swatches />
      </Section>

      <Section id="type" title="Typography">
        <div className="ds-type">
          <Specimen name="Page title" measure="h1"><div className="ui-page-header ds-flush"><h1>Domains and sending</h1></div></Specimen>
          <Specimen name="Card / group heading"><p data-specimen className="ds-type-heading">Delivery, last 7 days</p></Specimen>
          <Specimen name="Section heading" measure="h2"><SectionHeader title="Recent campaigns" /></Specimen>
          <Specimen name="Body / table cell"><p data-specimen>Receipts from northwind.example, signed with DKIM</p></Specimen>
          <Specimen name="Label / caption / table header"><p data-specimen className="ds-type-label">Last used · Region · Status</p></Specimen>
          <Specimen name="Mono data / ID / timestamp"><p data-specimen className="ds-type-mono"><span>em_01jf8k4m9p2q7r5t3v6w8x9y0z</span><span>nm1._domainkey.northwind.example</span><span>2026-11-24 14:32 UTC</span><span>99.4%</span></p></Specimen>
        </div>
      </Section>

      <Section id="icons" title="Icons">
        <div className="ds-icon-scale">{(Object.keys(ICON_SIZES) as IconSize[]).map(size => <div key={size} className="ds-icon-scale__step"><span className="ds-icon-scale__glyph"><Icon icon={ShieldCheck} size={size} /></span><code>{size} · {ICON_SIZES[size]}px / {ICON_STROKES[size]}</code></div>)}</div>
        <ul className="ds-icon-grid">{coreIcons.map(([name, glyph]) => <li key={name}><Icon icon={glyph} /><code>{name}</code></li>)}</ul>
        <div className="ds-pairing">
          <div className="ds-pairing__group">
            <h3 className="ds-subhead">Icon + label</h3>
            <nav className="main-navigation ds-nav" aria-label="Sample navigation">{navigationSample.map(([label, glyph, active]) => <a key={label} href="#icons" className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined} onClick={event => event.preventDefault()}><Icon icon={glyph} />{label}</a>)}</nav>
            <div className="ds-menu-row"><div className="ui-menu-item" data-highlighted=""><span className="ui-menu-icon"><Icon icon={Copy} /></span>Duplicate</div></div>
            <div className="cluster"><Button><Icon icon={Download} />Export CSV</Button><Button variant="primary"><Icon icon={Send} />Send test</Button></div>
          </div>
          <div className="ds-pairing__group">
            <h3 className="ds-subhead">Icon only</h3>
            <div className="cluster">
              <Tooltip content="Copy ID"><IconButton variant="secondary" label="Copy ID"><Icon icon={Copy} /></IconButton></Tooltip>
              <Tooltip content="More actions"><IconButton label="More actions"><Icon icon={MoreHorizontal} /></IconButton></Tooltip>
              <Tooltip content="Settings"><IconButton label="Settings"><Icon icon={Settings} /></IconButton></Tooltip>
              <Tooltip content="Close"><IconButton label="Close"><Icon icon={X} /></IconButton></Tooltip>
            </div>
          </div>
          <div className="ds-pairing__group">
            <h3 className="ds-subhead">Inline marks</h3>
            <p className="ds-inline-marks"><a href="#icons" className="ds-link" onClick={event => event.preventDefault()}>Learn more<Icon icon={ArrowUpRight} size="xs" /></a>
              <span className="ds-hint">Last used<Tooltip content="Last request with this key"><span className="ds-hint__mark" tabIndex={0}><Icon icon={Info} size="xs" tone="muted" label="About last used" /></span></Tooltip></span>
              <span className="ds-hint"><Icon icon={Lock} size="xs" tone="muted" />Owners only</span></p>
          </div>
        </div>
      </Section>

      <Section id="buttons" title="Buttons">
        <div className="ds-states" role="table" aria-label="Button states">
          <div className="ds-states__row ds-states__row--head" role="row"><span role="columnheader" />{buttonStates.map(state => <span key={state.name} role="columnheader">{state.name}</span>)}</div>
          {buttonRows.map(row => <div key={row.name} className="ds-states__row" role="row"><span role="rowheader">{row.name}</span>{buttonStates.map(state => <span key={state.name} role="cell" data-state={state.name}>
            {row.icon ? <IconButton {...row.props} label="Download" className={state.className} disabled={state.disabled}>{row.children}</IconButton> : <Button {...row.props} className={state.className} disabled={state.disabled}>{row.children}</Button>}
          </span>)}</div>)}
        </div>
      </Section>

      <Section id="forms" title="Form controls">
        <div className="ds-forms">
          <Field label="Workspace name" hint="Shown to your team"><Input placeholder="Northwind" /></Field>
          <Field label="Sender name"><Input value={name} onChange={event => setName(event.target.value)} /></Field>
          <Field label="Reply-to address" error="Enter a full address"><Input defaultValue="hello@" /></Field>
          <Field label="Sending domain"><Input value="northwind.example" disabled readOnly /></Field>
          <Field label="Search"><SearchField aria-label="Search contacts" placeholder="Search email or name" value={search} onChange={event => setSearch(event.target.value)} /></Field>
          <Field label="Region"><Select value={region} onValueChange={setRegion} options={[{ value: 'us-east-1', label: 'US East (N. Virginia)' }, { value: 'eu-west-1', label: 'EU (Ireland)' }]} /></Field>
          <div className="ds-forms__checks"><Checkbox label="Send a weekly digest" checked={optIn} onCheckedChange={setOptIn} /><Checkbox label="Track opens" checked onCheckedChange={() => {}} /></div>
          <div className="ds-forms__checks"><Switch label="Click tracking" checked={false} onCheckedChange={() => {}} /><Switch label="Open tracking" checked={tracking} onCheckedChange={setTracking} /></div>
        </div>
      </Section>

      <Section id="status" title="Status and menus">
        <div className="ds-split">
          <div className="ds-status">
            <div className="cluster ds-status__badges">{['delivered', 'verified', 'pending', 'bounced', 'failed', 'draft'].map(status => <StatusBadge key={status} status={status} />)}</div>
            <ul className="ds-status__dots">
              <li><StatusDot tone="success" note="DKIM, SPF and DMARC pass">northwind.example</StatusDot></li>
              <li><StatusDot tone="warning" note="waiting for DNS">mail.northwind.example</StatusDot></li>
              <li><StatusDot tone="danger" note="CNAME not found">billing.northwind.example</StatusDot></li>
              <li><StatusDot tone="neutral" muted note="never used">Receiving</StatusDot></li>
            </ul>
          </div>
          <div className="ds-menu-stage">
            <div className="ui-popover ui-menu ds-menu" role="menu" aria-label="Campaign actions">
              <div className="ui-menu-item" role="menuitem" tabIndex={-1}><span className="ui-menu-icon"><Icon icon={Pencil} /></span>Rename</div>
              <div className="ui-menu-item" role="menuitem" tabIndex={-1} data-highlighted=""><span className="ui-menu-icon"><Icon icon={Copy} /></span>Duplicate</div>
              <div className="ui-menu-item" role="menuitem" tabIndex={-1}><span className="ui-menu-icon"><Icon icon={FileText} /></span>Save as template</div>
              <div className="ui-menu-separator" role="separator" />
              <div className="ui-menu-item ui-menu-item--danger" role="menuitem" tabIndex={-1}><span className="ui-menu-icon"><Icon icon={Archive} /></span>Archive</div>
            </div>
          </div>
        </div>
      </Section>

      <Section id="list" title="List pattern">
        <ListDemo />
      </Section>

      <Section id="detail" title="Detail pattern">
        <DetailHeader backTo="/logs" typeLabel="Sent email" title="Your October receipt from Northwind"
          actions={<><Button>Send again</Button><Tooltip content="Open in Logs"><IconButton variant="secondary" label="Open in Logs"><Icon icon={ArrowUpRight} /></IconButton></Tooltip></>} />
        <FactsRow label="Email details" items={[
          { label: 'From', value: 'Northwind Billing <receipts@northwind.example>' },
          { label: 'To', value: 'hello@northwind.example' },
          { label: 'Stream', value: 'Transactional' },
          { label: 'Sent', value: <time dateTime="2026-11-24T14:32:00Z">2026-11-24 14:32 UTC</time>, mono: true },
          { label: 'ID', value: <Identifier value="em_01jf8k4m9p2q7r5t3v6w8x9y0z" copyLabel="Copy email ID" /> },
        ]} />
      </Section>

      <Section id="empty" title="Empty state">
        <EmptyState icon={Inbox} title="No domains yet" description="Add a sending domain to verify DKIM and start sending mail." action={<Button variant="primary"><Icon icon={Plus} />Add domain</Button>} />
      </Section>

    </main>
  </div>
}
