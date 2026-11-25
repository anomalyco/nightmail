import { Component, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { Navigate, Route, Routes, Link, createRoutesFromChildren, useLocation, useParams, type Params } from 'react-router'
import { AppShell } from './components/AppShell'
import { BootLoader } from './components/BootLoader'
import { Button, EmptyState } from './components/ui'
import { HomePage, loadHome, useOnboardingStage, useSession } from './data/context'
import { selectedWorkspace } from './data/live'
import { dashboardLikelyReady, rememberDashboardReady } from './data/onboarding'
import { routeChunks } from './data/prefetch'
import { chunk, ChunkFallback } from './lib/preloadable'
import { setRouteTable } from './lib/routes'
import { composer } from './features/campaigns/composer-chunk'
import { DocsStandalone, useDocsAudience } from './features/docs/frame'
import { preloadFirstPicture } from './features/home/first-picture'
const onboarding = chunk(() => import('./features/onboarding'))
const overview = chunk(() => import('./features/overview'))
const logs = chunk(() => import('./features/logs'))
const campaigns = chunk(() => import('./features/campaigns'))
const newsletters = chunk(() => import('./features/newsletters'))
const audience = chunk(() => import('./features/audience'))
const settings = chunk(() => import('./features/settings'))
const docs = chunk(() => import('./features/docs'))
const inbound = chunk(() => import('./features/inbound'))
const operator = chunk(() => import('./features/operator'))
const supportInbox = chunk(() => import('./features/support-inbox'))
const supportAction = chunk(() => import('./features/support/actions'))
const legal = chunk(() => import('./features/legal'))
const pricing = chunk(() => import('./features/pricing'))
const supportContinue = chunk(() => import('./features/support/continue'))
const connect = chunk(() => import('./features/connect'))
// Dev and VITE_DESIGN_SHEET=1 builds only (lib/design-sheet.ts). The test is written out here, not imported, so the
// bundler sees a constant and leaves the chunk out of any other build.
const DesignSheetPage = import.meta.env.DEV || import.meta.env.VITE_DESIGN_SHEET === '1' ? chunk(() => import('./features/design-sheet')).page(m => m.DesignSheetPage) : null
const loadOnboarding = onboarding.preload
const loadOverview = overview.preload
const loadLogs = logs.preload
const loadCampaigns = campaigns.preload
const loadNewsletters = newsletters.preload
const loadAudience = audience.preload
const loadSettings = settings.preload
const loadDocs = docs.preload
const loadInbound = inbound.preload
const loadOperator = operator.preload
const loadSupportInbox = supportInbox.preload
const loadLegal = legal.preload
Object.assign(routeChunks, { '/overview': loadOverview, '/logs': loadLogs, '/receiving': loadInbound, '/campaigns': loadCampaigns, '/newsletters': loadNewsletters, '/audience': loadAudience, '/domains': loadSettings, '/api-keys': loadSettings, '/settings': loadSettings, '/docs': loadDocs, '/operator': loadOperator, '/glass': loadOperator, '/support': loadSupportInbox, '/legal': loadLegal })
const LogsPage = logs.page(m => m.LogsPage)
const LogDetailPage = logs.page(m => m.LogDetailPage)
const CampaignsPage = campaigns.page(m => m.CampaignsPage)
const CampaignEditorPage = campaigns.page(m => m.CampaignEditorPage)
const CampaignReviewPage = campaigns.page(m => m.CampaignReviewPage)
const TemplatesPage = campaigns.page(m => m.TemplatesPage)
const TemplateEditorPage = campaigns.page(m => m.TemplateEditorPage)
const NewsletterPage = newsletters.page(m => m.NewsletterPage)
const NewNewsletterPage = newsletters.page(m => m.NewNewsletterPage)
const NewslettersPage = newsletters.page(m => m.NewslettersPage)
const ContactsPage = audience.page(m => m.ContactsPage)
const ContactDetailPage = audience.page(m => m.ContactDetailPage)
const ListsPage = audience.page(m => m.ListsPage)
const ListDetailPage = audience.page(m => m.ListDetailPage)
const SegmentsPage = audience.page(m => m.SegmentsPage)
const SegmentEditorPage = audience.page(m => m.SegmentEditorPage)
const ApiKeysPage = settings.page(m => m.ApiKeysPage)
const DomainsPage = settings.page(m => m.DomainsPage)
const DomainDetailPage = settings.page(m => m.DomainDetailPage)
const SettingsPage = settings.page(m => m.SettingsPage)
const McpApprovalPage = settings.page(m => m.McpApprovalPage)
const WebhookDetailPage = settings.page(m => m.WebhookDetailPage)
const DocsPage = docs.page(m => m.DocsPage)
const InboundPage = inbound.page(m => m.InboundPage)
const RulePage = chunk(()=>import('./features/inbound/rituals')).page(m=>m.RulePage)
const TracePage = inbound.page(m => m.TracePage)
const RitualsRedirect = inbound.page(m => m.RitualsRedirect)
const NewRulePage = inbound.page(m => m.NewRulePage)
const NewRecipeRoute = inbound.page(m => m.NewRecipeRoute)
const ReceivingPage = inbound.page(m => m.ReceivingPage)
const InboundAddressDetailPage = inbound.page(m => m.InboundAddressDetailPage)
const AgentInboxesPage = inbound.page(m => m.AgentInboxesPage)
const AgentInboxPage = inbound.page(m => m.AgentInboxPage)
const InboundWebhookDetailPage = inbound.page(m => m.InboundWebhookDetailPage)
const LegacyMailboxesRedirect = inbound.page(m => m.LegacyMailboxesRedirect)
const LegacyMailboxRedirect = inbound.page(m => m.LegacyMailboxRedirect)
const LegacyMailboxWebhooksRedirect = inbound.page(m => m.LegacyMailboxWebhooksRedirect)
const WebhooksListRedirect = inbound.page(m => m.WebhooksListRedirect)
const LegacyMailboxWebhookRedirect = inbound.page(m => m.LegacyMailboxWebhookRedirect)
const OverviewPage = overview.page(m => m.OverviewPage)
const OperatorPage = operator.page(m => m.OperatorPage)
const OperatorWorkspacePage = operator.page(m => m.OperatorWorkspacePage)
const OperatorNotesPage = operator.page(m => m.OperatorNotesPage)
const OperatorClusterPage = operator.page(m => m.OperatorClusterPage)
const GlassPage = operator.page(m => m.GlassPage)
const SupportInboxPage = supportInbox.page(m => m.SupportInboxPage)
const SupportConversationPage = supportInbox.page(m => m.SupportConversationPage)
const SupportActionDialog = supportAction.page(m => m.SupportActionDialog)
const OnboardingPage = onboarding.page(m => m.OnboardingPage)
const LegalPage = legal.page(m => m.LegalPage)
// One component for every price page, so moving between them keeps the page (features/pricing/index.tsx).
const PricePage = pricing.page(m => m.PricePage)
const SupportContinuePage = supportContinue.page(m => m.SupportContinuePage)
const ConnectPage = connect.page(m => m.ConnectPage)

// Preload the first screen's code alongside /v1/me. A workspace that may need onboarding waits instead.
const noop = () => {}
const initialPath = window.location.pathname
if (initialPath === '/legal' || initialPath.startsWith('/legal/')) loadLegal().catch(noop)
else if (initialPath === '/pricing' || initialPath.startsWith('/compare/')) pricing.preload().catch(noop)
else if (initialPath.startsWith('/support/continue/')) supportContinue.preload().catch(noop)
else if (initialPath === '/onboarding') loadOnboarding().catch(noop)
else if (initialPath === '/connect') connect.preload().catch(noop)
// The docs are public: signed out or in, their code loads alongside /v1/me.
else if (['/docs', '/developer'].some(path => initialPath.startsWith(path))) loadDocs().catch(noop)
// "/" is the homepage, signed in or out, on a hosted installation: a remembered workspace means one, and so does a first
// visit. A self-hosted installation remembered as ready has no homepage: "/" opens Overview there.
// Its first picture starts loading with its code.
else if (initialPath === '/') { if (selectedWorkspace() || !dashboardLikelyReady(null)) { preloadFirstPicture(); loadHome().catch(noop) } else loadOverview().catch(noop) }
// The Logs chunk is safe to warm before /v1/me even in a fresh browser; its reads still wait for the signed-in shell.
else if (/^\/logs\/?$/.test(initialPath)) loadLogs().catch(noop)
else if (!dashboardLikelyReady(selectedWorkspace())) { /* /v1/me decides between onboarding and the dashboard. */ }
else if (initialPath === '/overview') loadOverview().catch(noop)
else if (initialPath.startsWith('/logs')) loadLogs().catch(noop)
else if (['/campaigns', '/templates'].some(path => initialPath.startsWith(path))) {
  loadCampaigns().catch(noop)
  // The composer is the largest chunk; an editor route fetches it alongside the campaigns chunk, not after it.
  if (/^\/campaigns\/(?:new|templates\/[^/]+|[^/]+\/edit)\/?$/.test(initialPath)) composer.preload().catch(noop)
}
else if (initialPath.startsWith('/newsletters')) loadNewsletters().catch(noop)
else if (['/audience', '/contacts', '/lists', '/segments'].some(path => initialPath.startsWith(path))) loadAudience().catch(noop)
else if (['/api-keys', '/domains', '/settings'].some(path => initialPath.startsWith(path))) loadSettings().catch(noop)
else if (['/receiving', '/inbound', '/mailboxes'].some(path => initialPath.startsWith(path))) loadInbound().catch(noop)
else if (initialPath.startsWith('/operator') || initialPath === '/glass') loadOperator().catch(noop)
// A change support proposed (its emailed link) opens over Overview.
else if (initialPath.startsWith('/support/actions/')) { loadOverview().catch(noop); supportAction.preload().catch(noop) }
else if (initialPath === '/support' || initialPath.startsWith('/support/')) loadSupportInbox().catch(noop)

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* A production reporter can be injected here; never log message bodies. */ }
  render() { return this.state.failed ? <div className="fatal-error"><h1>Something went wrong</h1><p>Unsaved changes may be lost.</p><Button onClick={() => window.location.reload()}>Reload application</Button></div> : this.props.children }
}
// /v1/me alone decides whether the workspace still needs onboarding, before any dashboard chrome or data. The docs are
// public: in the dashboard for a signed-in, ready workspace (the shell stays mounted on the way in and out), on their
// own for everyone else.
function DashboardGate() {
  const stage = useOnboardingStage()
  const docs = useDocsAudience()
  if (docs === 'checking') return <BootLoader />
  if (docs === 'standalone') return <DocsStandalone />
  return stage ? <Navigate to="/onboarding" replace /> : <AppShell />
}
function OnboardingRoute() {
  const stage = useOnboardingStage()
  return stage ? <ChunkFallback.Provider value={<BootLoader />}><Suspense fallback={<BootLoader />}><OnboardingPage stage={stage} /></Suspense></ChunkFallback.Provider> : <Navigate to="/overview" replace />
}
// "/" is the public homepage for everyone on a hosted installation; signed out, ApiProvider shows it before any route.
// Signed in, it is this route, which loads none of the dashboard: its button opens Overview. A self-hosted installation
// has no homepage, so "/" opens Overview, as old links to it expect.
function RootPage() {
  const hosted = useSession()?.identity?.multiTenant === true
  const location = useLocation()
  if (!hosted) return <Navigate replace to={{ pathname: '/overview', search: location.search, hash: location.hash }} />
  return <ChunkFallback.Provider value={<BootLoader />}><HomePage start={{ signedIn: true }} /></ChunkFallback.Provider>
}
// Former sections that were folded into another page keep their links working, query and anchor included.
function Moved({ to }: { to: (params: Readonly<Params>) => string }) {
  const location = useLocation()
  const target = to(useParams())
  return <Navigate replace to={`${target}${location.search}${target.includes('#') ? '' : location.hash}`} />
}
const id = (params: Readonly<Params>) => encodeURIComponent(params.id ?? '')
function useRememberDashboardReady() {
  const identity = useSession()?.identity
  const stage = useOnboardingStage()
  useEffect(() => { if (identity) rememberDashboardReady(identity.multiTenant ? identity.workspaceId : null, !stage) }, [identity, stage])
}
export function App() {
  useRememberDashboardReady()
  return <AppErrorBoundary><Routes>{routes}</Routes></AppErrorBoundary>
}
// The route table, also given to analytics (a page view names its template) and to the signed-out pages (lib/routes.ts).
const routes = <><Route path="legal/:doc?" element={<ChunkFallback.Provider value={<BootLoader />}><Suspense fallback={<BootLoader />}><LegalPage /></Suspense></ChunkFallback.Provider>} /><Route path="pricing" element={<ChunkFallback.Provider value={<BootLoader />}><Suspense fallback={<BootLoader />}><PricePage /></Suspense></ChunkFallback.Provider>} /><Route path="compare/:vendor" element={<ChunkFallback.Provider value={<BootLoader />}><Suspense fallback={<BootLoader />}><PricePage /></Suspense></ChunkFallback.Provider>} /><Route path="onboarding" element={<OnboardingRoute />} /><Route path="connect" element={<ChunkFallback.Provider value={<BootLoader />}><Suspense fallback={<BootLoader />}><ConnectPage /></Suspense></ChunkFallback.Provider>} /><Route path="support/continue/:id/:message" element={<ChunkFallback.Provider value={<BootLoader />}><SupportContinuePage /></ChunkFallback.Provider>} /><Route index element={<RootPage />} />{DesignSheetPage && <Route path="_design-sheet" element={<ChunkFallback.Provider value={<BootLoader />}><DesignSheetPage /></ChunkFallback.Provider>} />}<Route element={<DashboardGate />}>
    <Route path="overview" element={<OverviewPage />} />
    <Route path="logs" element={<LogsPage />} /><Route path="logs/received/:id" element={<Moved to={params => `/logs/${encodeURIComponent(params.id ?? '')}`} />} /><Route path="logs/:id" element={<LogDetailPage />} />
    <Route path="receiving/endpoints" element={<Navigate replace to="/receiving?tab=destinations" />}/><Route path="receiving/rituals/*" element={<RitualsRedirect />} /><Route path="receiving/rules/new" element={<NewRulePage />} /><Route path="receiving/rules/new/script" element={<RulePage />} /><Route path="receiving/rules/new/:recipe" element={<NewRecipeRoute />} /><Route path="receiving/rules/:key" element={<RulePage />} /><Route path="receiving/rules/:key/code" element={<Moved to={params => `/receiving/rules/${encodeURIComponent(params.key ?? '')}`} />} /><Route path="receiving/rules" element={<Navigate replace to="/receiving?tab=rules" />} /><Route path="receiving/routing" element={<Navigate replace to="/receiving" />} /><Route path="receiving/trace" element={<TracePage />} /><Route path="receiving" element={<ReceivingPage />} /><Route path="receiving/inbox" element={<InboundPage />} /><Route path="receiving/addresses/:id" element={<InboundAddressDetailPage />} /><Route path="receiving/webhooks" element={<WebhooksListRedirect />} /><Route path="receiving/webhooks/:id" element={<InboundWebhookDetailPage />} />
    <Route path="receiving/addresses" element={<Moved to={() => '/receiving'} />} /><Route path="inbound" element={<Moved to={() => '/logs?view=received'} />} /><Route path="inbound/addresses" element={<Moved to={() => '/receiving'} />} /><Route path="inbound/addresses/:id" element={<Moved to={params => `/receiving/addresses/${id(params)}`} />} /><Route path="inbound/webhooks" element={<WebhooksListRedirect />} /><Route path="inbound/webhooks/:id" element={<Moved to={params => `/receiving/webhooks/${id(params)}`} />} />
    <Route path="receiving/inboxes" element={<AgentInboxesPage />} /><Route path="receiving/inboxes/:id" element={<AgentInboxPage />} />
    <Route path="mailboxes" element={<LegacyMailboxesRedirect />} /><Route path="mailboxes/webhooks" element={<LegacyMailboxWebhooksRedirect />} /><Route path="mailboxes/webhooks/:id" element={<LegacyMailboxWebhookRedirect />} /><Route path="mailboxes/:id" element={<LegacyMailboxRedirect />} />
    <Route path="campaigns" element={<CampaignsPage />} /><Route path="campaigns/new" element={<CampaignEditorPage />} /><Route path="campaigns/:id/edit" element={<CampaignEditorPage />} /><Route path="campaigns/:id/review" element={<CampaignReviewPage />} />
    <Route path="campaigns/templates" element={<TemplatesPage />} /><Route path="campaigns/templates/:id" element={<TemplateEditorPage />} />
    <Route path="newsletters" element={<NewslettersPage />} /><Route path="newsletters/new" element={<NewNewsletterPage />} /><Route path="newsletters/:id" element={<NewsletterPage />} />
    <Route path="audience" element={<ContactsPage />} /><Route path="audience/contacts/:id" element={<ContactDetailPage />} />
    <Route path="audience/lists" element={<ListsPage />} /><Route path="audience/lists/:id" element={<ListDetailPage />} />
    <Route path="audience/segments" element={<SegmentsPage />} /><Route path="audience/segments/new" element={<SegmentEditorPage />} /><Route path="audience/segments/:id" element={<SegmentEditorPage />} />
    <Route path="api-keys" element={<ApiKeysPage />} /><Route path="domains" element={<DomainsPage />} /><Route path="domains/:id" element={<DomainDetailPage />} />
    <Route path="settings" element={<SettingsPage />} /><Route path="settings/mcp/:id" element={<McpApprovalPage />} /><Route path="settings/webhooks/new" element={<WebhookDetailPage />} /><Route path="settings/webhooks/:id" element={<WebhookDetailPage />} />
    <Route path="templates" element={<Moved to={() => '/campaigns/templates'} />} /><Route path="templates/:id" element={<Moved to={params => `/campaigns/templates/${id(params)}`} />} />
    <Route path="contacts" element={<Moved to={() => '/audience'} />} /><Route path="contacts/:id" element={<Moved to={params => `/audience/contacts/${id(params)}`} />} />
    <Route path="lists" element={<Moved to={() => '/audience/lists'} />} /><Route path="lists/:id" element={<Moved to={params => `/audience/lists/${id(params)}`} />} />
    <Route path="segments" element={<Moved to={() => '/audience/segments'} />} /><Route path="segments/:id" element={<Moved to={params => `/audience/segments/${id(params)}`} />} />
    <Route path="settings/webhooks" element={<Moved to={() => '/settings#webhooks'} />} /><Route path="settings/workspace" element={<Moved to={() => '/settings#workspace'} />} /><Route path="settings/account" element={<Moved to={() => '/settings#account'} />} />
    <Route path="docs/*" element={<DocsPage />} /><Route path="developer" element={<Moved to={() => '/docs'} />} />
    <Route path="operator" element={<OperatorPage />} /><Route path="operator/notes" element={<OperatorNotesPage />} /><Route path="operator/workspaces/:id" element={<OperatorWorkspacePage />} /><Route path="operator/abuse/:id" element={<OperatorClusterPage />} /><Route path="glass" element={<GlassPage />} />
    <Route path="support" element={<SupportInboxPage />} /><Route path="support/:id" element={<SupportConversationPage />} />
    <Route path="support/actions/:id" element={<><OverviewPage /><ChunkFallback.Provider value={null}><SupportActionDialog /></ChunkFallback.Provider></>} />
    <Route path="*" element={<EmptyState headingAs="h1" title="Page not found" action={<Link to="/overview">Return to overview</Link>} />} />
  </Route></>
setRouteTable(createRoutesFromChildren(routes))
