import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigationType, type NavLinkProps } from 'react-router'
import { BookOpen, Bot, Ellipsis, Globe, Inbox, KeyRound, LayoutGrid, LifeBuoy, Lock, LogOut, MessageCircleQuestionMark, Newspaper, ScrollText, Search, Send, Settings, ShieldCheck, Users, type LucideIcon } from 'lucide-react'
import { useRegion, useSession, useWorkspaceAccess } from '../data/context'
import { preloadRouteChunk, sidebarPaths, usePrefetchQueries, usePrefetchRoute, useRouteIntent } from '../data/prefetch'
import { useRegionCatalog, useRegionDiscovery } from '../data/regions'
import { label, number, percent } from '../lib/format'
import { chunk, ChunkFallback } from '../lib/preloadable'
import { queries } from '../data/queries'
import { openScoreAbout, useScoreAbout } from '../lib/score-about'
import { openConnectAgent, useConnectAgentOpen } from '../lib/connect-agent'
import { Alert, Button, EmptyState, ErrorState, Icon, Select, Sheet, Skeleton, SkeletonText, useToast, type IconSize } from './ui'
import { CommandMenu, type Command } from './CommandMenu'
import { useRowKeys } from '../lib/row-keys'
import { modKey, useCompactShell } from '../lib/media'
import { RouteSkeleton } from './RouteSkeleton'
import { ThemeToggle } from './ThemeToggle'
import { AccountSwitcher } from './AccountSwitcher'
import { Notices } from './Notices'
import { AgentWaiting } from './AgentWaiting'
import { LegalFooterLinks } from './LegalLinks'
import { PrivacyToggle } from './PrivacyToggle'
import { NightmailWordmark } from './NightmailLogo'
import { togglePrivacy } from '../lib/privacy'
import { SupportHost, supportTriggerProps, useSupportChat, type SupportChat } from './SupportChat'
import { notesModifierLabel, useUiNotesMode, useUiNotesShortcut } from '../lib/ui-notes-mode'
import { productName } from '../../../api/src/brand'
import { newsletterLinks, useNewsletters, useShownNewsletter } from '../features/newsletters/shared'

// The sender score card (hosted): its code and data load with the shell, into a slot that already has its final size.
const score = chunk(() => import('../features/score'))
const SidebarScore = score.page(module => module.SidebarScore)
// The sender score explainer: one dialog for every place the score appears, loaded when first opened.
const ScoreAboutHost = score.page(module => module.ScoreAboutHost)
// Connect your agent: one dialog for the whole shell, its code loaded when the sidebar's row is pointed at or first opened.
const connectAgent = chunk(() => import('../features/docs/connect-agent'))
const ConnectAgentHost = connectAgent.page(module => module.ConnectAgentHost)
const preloadConnectAgent = () => { void connectAgent.preload().catch(() => {}) }
// UI notes mode (Nightmail staff with the operator role): its code loads only while the mode is on, as a fixed overlay.
const UiNotesLayer = chunk(() => import('../features/ui-notes')).page(module => module.UiNotesLayer)

// Members can't manage sending infrastructure; the API enforces this too.
const adminOnly = new Set(['/api-keys', '/domains'])
type NavItem = readonly [path: string, title: string]
const navigation: readonly NavItem[] = [['/overview', 'Overview'], ['/logs', 'Logs'], ['/receiving', 'Mail routing'], ['/campaigns', 'Campaigns'], ['/audience', 'Audience'], ['/domains', 'Domains'], ['/api-keys', 'API keys'], ['/docs', 'Docs'], ['/settings', 'Settings']]
// Nightmail staff (a platform operator role in GET /v1/me) also get the support inbox and the operator console, last.
const staffLinks: readonly NavItem[] = [['/support', 'Support'], ['/operator', 'Operator']]
// A self-hosted installation has no operator area; the same address is its Health page (features/operator/health.tsx).
const selfHostedLinks: readonly NavItem[] = [['/operator', 'Health']]
// Operator pages with no sidebar entry, reached by their address: named in the breadcrumb and the window title for an
// operator only, so anyone else sees what an unknown address shows.
const operatorPages: readonly NavItem[] = [['/glass', 'Glass']]
// Below 900 px the sidebar becomes a top bar (workspace, theme) and a bottom tab bar: the four areas used most, one
// thumb-tap away and always in view, and More, a sheet with the rest. A drawer would hide every destination behind a
// button; the tab bar keeps the main ones visible and says where you are.
const tabs = ['/overview', '/logs', '/receiving', '/campaigns']
const icons: Record<string, LucideIcon> = { '/overview': LayoutGrid, '/logs': ScrollText, '/receiving': Inbox, '/campaigns': Send, '/audience': Users, '/domains': Globe, '/api-keys': KeyRound, '/docs': BookOpen, '/settings': Settings, '/support': LifeBuoy, '/operator': ShieldCheck, '/glass': LayoutGrid }
const glyphOf = (path: string) => icons[path] ?? (path.startsWith('/newsletters') ? Newspaper : null)
const iconOf = (path: string, size: IconSize = 'md') => { const glyph = glyphOf(path); return glyph ? <Icon icon={glyph} size={size} /> : null }
const current = (path: string, pathname: string) => pathname === path || pathname.startsWith(`${path}/`)
// The sidebar's four groups. A newsletter sits with Campaigns; staff and self-hosted pages close Workspace.
const groups = [['Mail', ['/overview', '/logs', '/receiving']], ['Marketing', ['/campaigns', '/audience']], ['Infra', ['/domains', '/api-keys']], ['Workspace', ['/docs', '/settings']]] as const
const groupOf = (path: string) => path.startsWith('/newsletters') ? 'Marketing' : groups.find(([, paths]) => (paths as readonly string[]).includes(path))?.[0] ?? 'Workspace'
// Keyboard-first: G then a letter opens a page from anywhere you aren't typing (G O Overview, G L Logs…; G R kept its
// letter when Receiving became Mail routing), ⌘K finds any page or action, and J and K move through a list's rows.
const goKeys: Record<string, string> = { '/overview': 'O', '/logs': 'L', '/receiving': 'R', '/campaigns': 'C', '/audience': 'A', '/domains': 'D', '/api-keys': 'K', '/settings': 'S' }
// What else ⌘K finds each page by: its old name, the things on it.
const pageWords: Record<string, string> = { '/overview': 'home dashboard', '/logs': 'emails sent received delivered bounced', '/receiving': 'receiving inbound addresses rules destinations inboxes', '/campaigns': 'marketing broadcast templates', '/audience': 'contacts lists segments subscribers', '/domains': 'dns dkim verify', '/api-keys': 'tokens smtp app passwords agents', '/docs': 'documentation guides reference', '/settings': 'billing members webhooks account', '/support': 'inbox conversations', '/operator': 'staff admin health', '/glass': 'live board deliverability health status' }
const commandId = (path: string) => path.startsWith('/newsletters') ? 'go-newsletter' : `go-${path.slice(1).replace(/[^a-z0-9]+/g, '-')}`
const typing = (target: EventTarget | null) => Boolean((target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
const commandKey = `${modKey}K`
// A link of the navigation. `on`: undefined lets the address decide, as everywhere; a boolean decides for it.
function Nav({ on, className, ...props }: Omit<NavLinkProps, 'className' | 'children' | 'style'> & { on?: boolean; className?: string; children: ReactNode }) {
  return on === undefined ? <NavLink className={className} {...props} /> : <Link className={[className, on && 'active'].filter(Boolean).join(' ') || undefined} aria-current={on ? 'page' : undefined} {...props} />
}
export function AppShell() {
  const { regionId, setRegionId } = useRegion()
  const session = useSession()
  const access = useWorkspaceAccess()
  const location = useLocation()
  const scoreAbout = useScoreAbout()
  // The support chat, hosted only: Help at the foot of the sidebar (in More on a phone or tablet, and ⌘K),
  // one conversation for the whole visit that stays open across pages. A self-hosted installation has no Help.
  const support = useSupportChat({ hosted: access.multiTenant, staff: Boolean(session?.identity?.operator) })
  const help = support.mode ? () => support.setOpen(true) : null
  const signOut = access.multiTenant && session?.identity ? () => void session.logout() : null
  const [scoreAboutMounted, setScoreAboutMounted] = useState(false)
  const connecting = useConnectAgentOpen()
  const [connectMounted, setConnectMounted] = useState(false)
  useEffect(() => { if (connecting) setConnectMounted(true) }, [connecting])
  const toast = useToast()
  // Only for the people the API allows (GET /v1/me uiNotes): nobody else gets the shortcut, its listeners or its code.
  const canNote = session?.identity?.uiNotes === true
  const notesOn = useUiNotesMode(canNote)
  useUiNotesShortcut(canNote, useCallback((on: boolean) => toast(on ? `UI notes on. ${notesModifierLabel}-click anything to leave a note.` : 'UI notes off.'), [toast]))
  useEffect(() => { if (scoreAbout.open) setScoreAboutMounted(true) }, [scoreAbout.open])
  // Hosted workspaces view every region at once, so no page waits on a selected region.
  const needsRegion = !access.multiTenant && ['/overview', '/logs', '/domains'].some(path => location.pathname.startsWith(path))
  // Hosted workspaces view every region at once and never read the SES region catalog.
  const regions = useRegionCatalog({ enabled: !access.multiTenant })
  const enabled = regions.data?.data.filter(region => region.enabled) ?? []
  const current = regions.data?.data.find(region => region.region === regionId && region.enabled)
  // Hosted workspaces reach the shell only once onboarding is done (see App). Their regions are
  // managed by the sending connection, so SES discovery and its sidebar status don't apply.
  const discovery = useRegionDiscovery(access.multiTenant ? undefined : current)
  const quota = discovery.data?.account?.quota
  const provisioning = current?.provisionStatus === 'pending' || current?.provisionStatus === 'running'
  const needsProvisioning = Boolean(current && !provisioning && (current.discoveryStatus === 'needs_provisioning' || (discovery.data && !discovery.data.provisioned)))
  const navigate = useNavigate()
  // The first-grade email's button (api/src/notices.ts) opens the sender score explainer: /overview#sender-score, once.
  useEffect(() => {
    if (location.hash !== '#sender-score') return
    openScoreAbout()
    navigate({ pathname: location.pathname, search: location.search }, { replace: true })
  }, [location.hash, location.pathname, location.search, navigate])
  const prefetchRoute = usePrefetchRoute()
  const intent = useRouteIntent()
  const prefetchQueries = usePrefetchQueries()
  // A newsletter is an item under its own name where Campaigns sits (features/newsletters/shared.ts has the rule).
  const newsletters = newsletterLinks(useNewsletters())
  const latest = useRef({ prefetchRoute, pathname: location.pathname, canAdminister: access.canAdminister, newsletters })
  latest.current = { prefetchRoute, pathname: location.pathname, canAdminister: access.canAdminister, newsletters }
  const regionReady = access.multiTenant || Boolean(current)
  // The page in front of the user: its first-screen requests start with its code, not after it, on a cold load too.
  useEffect(() => {
    const path = latest.current.pathname
    // Logs starts its actual filtered rows at the table ref's first fit. Warming a
    // remembered default page here can race that read with a different range or size.
    if (regionReady && path === '/logs') void preloadRouteChunk(path)
    else if (regionReady && ((sidebarPaths as readonly string[]).includes(path) || path.startsWith('/newsletters'))) void latest.current.prefetchRoute(path)
    if (access.multiTenant) { void score.preload().catch(() => {}); void prefetchQueries([queries.senderScore()]) }
  }, [regionReady])
  // Once the page in front of the user has settled, warm every other sidebar page's JS chunk one at a time (never
  // firing API requests for unvisited pages). Hovering a link warms its chunk and cheap single-page queries.
  const warming = useRef(false)
  const content = useRef<HTMLElement>(null)
  useEffect(() => {
    const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData
    if (warming.current || !regionReady || saveData) return
    warming.current = true
    let stopped = false
    let release: (() => void) | undefined
    // A hidden tab waits for the user to come back instead of fetching in the background.
    const visible = () => !document.hidden ? Promise.resolve() : new Promise<void>(resolve => {
      const done = () => { document.removeEventListener('visibilitychange', onChange); release = undefined; resolve() }
      const onChange = () => { if (!document.hidden) done() }
      release = done
      document.addEventListener('visibilitychange', onChange)
    })
    const idle = () => new Promise<void>(resolve => typeof requestIdleCallback === 'function' ? requestIdleCallback(() => resolve(), { timeout: 3000 }) : void setTimeout(resolve, 300))
    void (async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
      for (const path of [...sidebarPaths, ...latest.current.newsletters.map(([path]) => path)]) {
        await visible()
        await idle()
        const { pathname, canAdminister } = latest.current
        if (stopped) return
        if (pathname.startsWith(path) || (!canAdminister && adminOnly.has(path))) continue
        await preloadRouteChunk(path)
      }
    })()
    return () => { stopped = true; release?.(); warming.current = false }
  }, [regionReady])
  // Scroll: a new page starts at the top (filter and tab changes on the same page keep their place); Back and Forward
  // restore where that entry was left, waiting a moment for its (usually cached) content to be tall enough again.
  // The page card scrolls on a desktop; on a phone or tablet the document does, so the browser's bars collapse.
  const compact = useCompactShell()
  const navigationType = useNavigationType()
  const scrolls = useRef(new Map<string, number>())
  const lastPath = useRef(location.pathname)
  const scroller = () => compact ? document.scrollingElement as HTMLElement | null : content.current
  useEffect(() => {
    const el = scroller(), key = location.key, target: HTMLElement | Window | null = compact ? window : el
    if (!el || !target) return
    const save = () => { scrolls.current.set(key, el.scrollTop) }
    target.addEventListener('scroll', save, { passive: true })
    return () => target.removeEventListener('scroll', save)
  }, [location.key, compact])
  useLayoutEffect(() => {
    const el = scroller(), samePage = lastPath.current === location.pathname
    lastPath.current = location.pathname
    if (navigationType === 'POP') {
      const top = scrolls.current.get(location.key) ?? 0
      if (!el) return
      let frame = 0, tries = 0
      const apply = () => { el.scrollTop = top; if (Math.abs(el.scrollTop - top) > 1 && tries++ < 60) frame = requestAnimationFrame(apply) }
      const stop = () => cancelAnimationFrame(frame)
      apply()
      window.addEventListener('wheel', stop, { once: true, passive: true }); window.addEventListener('touchstart', stop, { once: true, passive: true })
      return () => { stop(); window.removeEventListener('wheel', stop); window.removeEventListener('touchstart', stop) }
    }
    if (samePage) return
    window.scrollTo(0, 0)
    content.current?.scrollTo(0, 0)
  }, [location.key])
  useEffect(() => {
    const preferred = regions.data?.defaultRegion
    if (!access.multiTenant && regions.data && !current && enabled.length) setRegionId(enabled.find(region => region.region === preferred)?.region ?? enabled[0].region)
  }, [access.multiTenant, regions.data, current, enabled, setRegionId])
  // Docs pages name themselves (features/docs).
  const unlisted = session?.identity?.operator ? operatorPages : []
  useEffect(() => { if (location.pathname === '/docs' || location.pathname.startsWith('/docs/')) return; document.title = `${[...unlisted, ...newsletters, ...navigation, ...(access.multiTenant ? staffLinks : selfHostedLinks)].find(([path]) => location.pathname.startsWith(path))?.[1] ?? productName.toLowerCase()} · ${productName.toLowerCase()}` }, [location.pathname, newsletters.map(([, title]) => title).join('\n'), unlisted.length]) // eslint-disable-line react-hooks/exhaustive-deps
  // "/" jumps to the page's search box, as in most list-heavy tools, unless you are already typing somewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"]')) return
      // A hidden search box (the docs' table of contents on a narrow screen) can't take focus: leave the key alone.
      const search = [...content.current?.querySelectorAll<HTMLInputElement>('input[type="search"]:not(:disabled)') ?? []].find(input => input.getClientRects().length > 0)
      if (!search) return
      event.preventDefault(); search.focus(); search.select()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  // ⇧P turns privacy mode (lib/privacy.ts) on or off, unless you are typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'P' || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.defaultPrevented) return
      if ((event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return
      event.preventDefault(); togglePrivacy()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  // ⌘K (Ctrl+K) opens or closes the command menu, except inside the email editor, where it is the editor's own.
  const [commandOpen, setCommandOpen] = useState(false)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.defaultPrevented) return
      if ((event.target as HTMLElement | null)?.closest?.('[contenteditable=""], [contenteditable="true"]')) return
      event.preventDefault(); setCommandOpen(open => !open)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  useRowKeys()
  // G then a letter, within a second, opens that page (goKeys), unless you are typing or a dialog or menu has focus.
  const go = useRef(navigate)
  go.current = navigate
  useEffect(() => {
    let armed = 0
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || event.repeat || typing(event.target)) return
      if ((event.target as HTMLElement | null)?.closest?.('[role="dialog"], [role="menu"], [role="listbox"]')) return
      const key = event.key.toUpperCase()
      if (armed && Date.now() - armed < 1000) {
        armed = 0
        const path = Object.keys(goKeys).find(item => goKeys[item] === key)
        if (path) { event.preventDefault(); go.current(path) }
        return
      }
      armed = key === 'G' && !event.shiftKey ? Date.now() : 0
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  function changeRegion(id: string) {
    setRegionId(id)
    const parts = location.pathname.split('/').filter(Boolean)
    if (['logs', 'domains'].includes(parts[0])) {
      if (parts.length > 1) navigate(`/${parts[0]}`)
      else {
        const search = new URLSearchParams(location.search)
        search.delete('page')
        navigate({ pathname: location.pathname, search: search.toString() }, { replace: true })
      }
    }
  }
  // Members see every page: owner and admin ones carry a lock and open a short note on who can use them.
  const links: readonly NavItem[] = [...navigation.flatMap(item => item[0] === '/campaigns' ? [...newsletters, item] : [item]), ...session?.identity?.operator || session?.identity?.staffSignIn ? staffLinks : session?.identity && !access.multiTenant ? selfHostedLinks : []]
  // An issue open in the composer or its review belongs to its newsletter: that item is marked, not Campaigns.
  const shown = useShownNewsletter(), issueOf = shown && location.pathname.startsWith('/campaigns/') ? newsletters.find(([path]) => path === `/newsletters/${encodeURIComponent(shown)}`)?.[0] ?? (newsletters[0]?.[0] === '/newsletters' ? '/newsletters' : null) : null
  // Your agents lives at /operator/agents (the address an agent's link carries) but belongs to Support, which opens it.
  const shownUnder = location.pathname === '/operator/agents' ? '/support' : issueOf
  const on = (path: string) => shownUnder ? path === shownUnder : undefined
  const locked = (path: string) => !access.canAdminister && adminOnly.has(path)
  const scoreHost = (scoreAbout.open || scoreAboutMounted) && <Suspense fallback={null}><ScoreAboutHost /></Suspense>
  const connectHost = (connecting || connectMounted) && <Suspense fallback={null}><ConnectAgentHost /></Suspense>
  const context = <>
    {access.multiTenant && <AccountSwitcher />}
    {access.canAdminister && !access.multiTenant && <Select id="sidebar-view-region" aria-label="Viewing region" value={current?.region ?? ''} onValueChange={changeRegion} options={enabled.map(region => ({ value: region.region, label: region.region }))} disabled={regions.isPending || !enabled.length} placeholder={regions.isPending ? 'Loading regions…' : 'No enabled regions'} />}
    {access.canAdminister && !access.multiTenant && regions.isError && <Button variant="ghost" onClick={() => regions.refetch()}>Retry regions</Button>}
  </>
  // The links and privacy mode first, so the last item (the sender score card, or SES's quota) ends on the main panel's bottom edge.
  const footer = <>
    <LegalFooterLinks />
    <PrivacyToggle />
    {access.canAdminister && !access.multiTenant && needsProvisioning && <Link className="sidebar-setup" to={`/settings?region=${encodeURIComponent(regionId)}`}><span>Region needs provisioning</span><span className="sidebar-setup-action">Set up {regionId} →</span></Link>}
    <div className="sidebar-quota">{!access.canAdminister || access.multiTenant ? null : quota?.sentLast24Hours != null && quota.max24HourSend != null ? <>
      <div className="quota-label"><span>SES · 24h</span><span>{percent(quota.sentLast24Hours / Math.max(1, quota.max24HourSend), 0)}</span></div>
      {quota.max24HourSend > 0 && <meter className="quota-meter" min={0} max={quota.max24HourSend} value={quota.sentLast24Hours} aria-label="SES daily quota used" />}
      <span>{number(quota.sentLast24Hours)} / {number(quota.max24HourSend)} sent</span>
    </> : discovery.isFetching ? <><div className="quota-label"><span>Checking SES…</span><Skeleton width={28} /></div><Skeleton height={3} /><SkeletonText lineHeight={18} /></> : needsProvisioning ? null : <><span>SES · {discovery.isError ? 'Check failed' : label(current?.discoveryStatus ?? 'not_discovered')}</span><Link to="/settings">Set up SES</Link></>}</div>
    {access.multiTenant && <div className="sidebar-score-slot"><SidebarScore /></div>}
  </>
  // ⌘K lists every page of the navigation in the sidebar's order (plus Glass for operators), each with its G shortcut.
  const commandLinks: readonly NavItem[] = [...links, ...unlisted]
  const commands = useMemo<Command[]>(() => commandLinks.map(([path, title]) => ({ id: commandId(path), path, title, section: 'Pages', icon: glyphOf(path), words: pageWords[path], locked: locked(path),
    shortcut: goKeys[path] ? { keys: ['G', goKeys[path]], label: `G then ${goKeys[path]}` } : undefined, run: () => navigate(path) })), [commandLinks.map(([path, title]) => `${path}:${title}`).join('\n'), access.canAdminister, navigate]) // eslint-disable-line react-hooks/exhaustive-deps
  const grouped = groups.map(([name]) => ({ name, links: links.filter(([path]) => groupOf(path) === name) })).filter(group => group.links.length)
  const section = [...links, ...unlisted].find(([path]) => on(path) ?? (location.pathname === path || location.pathname.startsWith(`${path}/`)))?.[1] ?? 'Overview'
  const workspaceName = access.multiTenant ? session?.identity?.workspaces?.find(item => item.id === session?.identity?.workspaceId)?.name ?? 'Workspace' : regionId || productName
  const overlays = <><AgentWaiting />{connectHost}{support.mode && <SupportHost chat={support} />}{notesOn && <UiNotesLayer />}<CommandMenu open={commandOpen} onOpenChange={setCommandOpen} pages={commands} help={help} signOut={signOut} /></>
  const main = <main ref={content} id="main-content" className="page-surface" tabIndex={-1}>{session?.notice && <div className="page-notice"><Alert tone="danger" title="Invitation not accepted" onDismiss={session.dismissNotice}>{session.notice}</Alert></div>}
    <Notices />
    <ChunkFallback.Provider value={<RouteSkeleton />}><Suspense fallback={<RouteSkeleton />}>
      {needsRegion && regions.isError && !regions.data ? <ErrorState error={regions.error} onRetry={() => regions.refetch()} />
        : needsRegion && (regions.isPending ? !regionId : !current && enabled.length > 0) ? <RouteSkeleton />
        : needsRegion && regions.data && !enabled.length ? <EmptyState title="No enabled regions" action={!access.multiTenant && <Link to="/settings">Set up SES</Link>} />
        : <PageErrorBoundary resetKey={location.key}><Outlet /></PageErrorBoundary>}
    </Suspense></ChunkFallback.Provider>
  </main>
  if (compact) return <div className="app-shell app-shell--compact">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="mobile-bar">
      <NavLink className="wordmark" to="/overview" aria-label={`${productName.toLowerCase()} overview`}><NightmailWordmark /></NavLink>
      <div className="mobile-bar__context">{context}</div>
      <ThemeToggle />
    </header>
    {scoreHost}
    {main}
    <TabBar links={links} intent={intent} footer={footer} locked={locked} on={on} actions={{ help, preloadHelp: support.preload, signOut }} />
    {overlays}
  </div>
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <div className="sidebar-head"><NavLink className="wordmark" to="/overview" aria-label={`${productName.toLowerCase()} overview`}><NightmailWordmark /></NavLink></div>
      <div className="sidebar-context">{context}</div>
      {/* Members see every page: owner and admin ones carry a lock and explain who can use them. */}
      <nav className="main-navigation" aria-label="Main navigation">{grouped.map(group => <div key={group.name} className="nav-group" role="group" aria-labelledby={`nav-group-${group.name}`}>
        <span id={`nav-group-${group.name}`} className="nav-group__label">{group.name}</span>
        {group.links.map(([path, title]) => <Nav key={path} to={path} on={on(path)} {...locked(path) ? lockedProps : intent(path)}>
          {iconOf(path, 'sm')}<span className="main-navigation__title">{title}</span>
          {locked(path) ? <Icon icon={Lock} size="xs" label="Owners and admins only" /> : goKeys[path] && <span className="ui-shortcut" aria-hidden="true">G {goKeys[path]}</span>}
        </Nav>)}
      </div>)}</nav>
      <div className="sidebar-footer"><SidebarActions support={support} />{footer}</div>
    </aside>
    <header className="topbar">
      <nav className="topbar__crumbs" aria-label="Breadcrumb"><span className="topbar__workspace" data-private title={workspaceName}>{workspaceName}</span><span className="topbar__sep" aria-hidden="true">/</span><span className="topbar__section" aria-current="page">{section}</span></nav>
      <button type="button" className="command-trigger" aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K" onClick={() => setCommandOpen(true)}><Icon icon={Search} size="sm" /><span>Search or jump…</span><kbd className="ui-kbd">{commandKey}</kbd></button>
      <div className="topbar__end">
        <span className="topbar__hint" aria-hidden="true"><kbd className="ui-kbd">/</kbd>Search</span>
        <ThemeToggle />
      </div>
    </header>
    {scoreHost}
    {main}
    {overlays}
  </div>
}

// Connect your agent and Help, pinned at the foot of the sidebar above the legal links: rows like the navigation's.
// Help toggles the support chat, docked in the page's bottom-right corner.
function SidebarActions({ support }: { support: SupportChat }) {
  return <div className="sidebar-actions">
    <button type="button" className="sidebar-action" aria-haspopup="dialog" onPointerEnter={preloadConnectAgent} onFocus={preloadConnectAgent} onClick={openConnectAgent}><Icon icon={Bot} size="sm" /><span className="sidebar-action__title">Connect your agent</span></button>
    {support.mode && <button type="button" {...supportTriggerProps(support)} className="sidebar-action support-trigger"><Icon icon={MessageCircleQuestionMark} size="sm" /><span className="sidebar-action__title">Help</span></button>}
  </div>
}

// A page that fails to render takes only the page down: the sidebar or tab bar stays, and going anywhere else or Try
// again renders it afresh. App's boundary remains the last resort for the shell itself.
class PageErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidUpdate(previous: { resetKey: string }) { if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false }) }
  render() {
    if (!this.state.failed) return this.props.children
    return <EmptyState headingAs="h1" title="This page couldn’t load" action={<div className="cluster"><Button onClick={() => this.setState({ failed: false })}>Try again</Button><Link to="/overview">Return to overview</Link></div>} />
  }
}

// The tab bar and its More sheet. More opens as a history entry of its own, so Back (or a swipe back) closes it
// instead of leaving the page; a page picked in it replaces that entry, so Back from there returns to the page below.
const issued = new Set<string>()
const lockedProps = { title: 'Owners and admins only', 'data-locked': true }
// Under the pages, the sidebar's Connect your agent and Help, and Sign out (hosted): each closes More, then acts.
type MoreActions = { help: (() => void) | null; preloadHelp: () => void; signOut: (() => void) | null }
function TabBar({ links, intent, footer, locked, on, actions }: { links: readonly NavItem[]; intent: ReturnType<typeof useRouteIntent>; footer: ReactNode; locked: (path: string) => boolean; on: (path: string) => boolean | undefined; actions: MoreActions }) {
  const location = useLocation(), navigate = useNavigate(), moreButton = useRef<HTMLButtonElement>(null)
  // Only an entry opened in this visit counts: a reload on it shows the page, not a stale sheet.
  const token = (location.state as { more?: string } | null)?.more
  const open = Boolean(token && issued.has(token))
  const more = links.filter(([path]) => !tabs.includes(path))
  const inMore = more.some(([path]) => on(path) ?? current(path, location.pathname))
  const show = () => { const next = `${Date.now()}:${Math.random()}`; issued.add(next); navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { state: { more: next } }) }
  const close = () => { if (open) navigate(-1) }
  return <>
    <nav className="tab-bar" aria-label="Main navigation">
      {links.filter(([path]) => tabs.includes(path)).map(([path, title]) => <Nav key={path} className="tab-bar__item" to={path} on={on(path)} {...intent(path)}><span className="tab-bar__icon" aria-hidden="true">{iconOf(path, 'lg')}</span><span className="tab-bar__label">{title}</span></Nav>)}
      <button ref={moreButton} type="button" className="tab-bar__item" aria-label="More" aria-haspopup="dialog" aria-expanded={open} aria-current={inMore ? 'page' : undefined} data-active={inMore || open || undefined} onClick={show}><span className="tab-bar__icon" aria-hidden="true"><Icon icon={Ellipsis} size="lg" /></span><span className="tab-bar__label">More</span></button>
    </nav>
    <Sheet open={open} onOpenChange={next => { if (!next) close() }} title="More" hideTitle className="more-sheet" returnFocus={moreButton}>
      <nav className="more-sheet__links" aria-label="More pages">{more.map(([path, title]) => <Nav key={path} className="more-sheet__link" to={path} replace on={on(path)} {...locked(path) ? lockedProps : intent(path)}><span className="more-sheet__icon" aria-hidden="true">{iconOf(path, 'lg')}</span><span className="more-sheet__title">{title}</span>{locked(path) && <Icon className="more-sheet__lock" icon={Lock} size="sm" label="Owners and admins only" />}</Nav>)}
</nav>
      <div className="more-sheet__links more-sheet__actions">
        <button type="button" className="more-sheet__link" onPointerDown={preloadConnectAgent} onClick={() => { close(); openConnectAgent() }}><span className="more-sheet__icon" aria-hidden="true"><Icon icon={Bot} size="lg" /></span>Connect your agent</button>
        {actions.help && <button type="button" className="more-sheet__link" onPointerDown={actions.preloadHelp} onClick={() => { close(); actions.help!() }}><span className="more-sheet__icon" aria-hidden="true"><Icon icon={MessageCircleQuestionMark} size="lg" /></span>Help</button>}
        {actions.signOut && <button type="button" className="more-sheet__link" onClick={() => { close(); actions.signOut!() }}><span className="more-sheet__icon" aria-hidden="true"><Icon icon={LogOut} size="lg" /></span>Sign out</button>}
      </div>
      <div className="more-sheet__footer">{footer}</div>
    </Sheet>
  </>
}
