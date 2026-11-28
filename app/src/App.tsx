import { Component, Suspense, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react'
import { Navigate, Route, Routes, Link, createRoutesFromChildren, useLocation, useParams, type Params } from 'react-router'
import { AppShell } from './components/AppShell'
import { BootLoader } from './components/BootLoader'
import { Button, EmptyState } from './components/ui'
import { HomePage, loadHome, useOnboardingStage, useSession } from './data/context'
import { selectedWorkspace } from './data/live'
import { dashboardLikelyReady, rememberDashboardReady } from './data/onboarding'
import { chunk, ChunkFallback } from './lib/preloadable'
import { routeHandle, setRouteTable } from './lib/routes'
import { AudienceRouteSkeleton } from './features/audience/skeletons'
import { composer } from './features/campaigns/composer-chunk'
import { CampaignRouteSkeleton } from './features/campaigns/skeletons'
import { DocsSkeleton, DocsStandalone, useDocsAudience } from './features/docs/frame'
import { preloadFirstPicture } from './features/home/first-picture'
import { ReceivingPageSkeleton, ReceivingRouteSkeleton } from './features/inbound/skeletons'
import { isReceivedId } from './features/logs/rows'
import { EmailDetailSkeleton, LogsRouteSkeleton } from './features/logs/skeletons'
import { NewsletterRouteSkeleton } from './features/newsletters/skeletons'
import { OverviewRouteSkeleton } from './features/overview/skeletons'
import { SettingsRouteSkeleton, SmtpImapRouteSkeleton } from './features/settings/skeletons'
const onboarding = chunk(() => import('./features/onboarding'))
const overview = chunk(() => import('./features/overview'))
const logs = chunk(() => import('./features/logs'))
const campaigns = chunk(() => import('./features/campaigns'))
const newsletters = chunk(() => import('./features/newsletters'))
const audience = chunk(() => import('./features/audience'))
const settings = chunk(() => import('./features/settings'))
const docs = chunk(() => import('./features/docs'))
const inbound = chunk(() => import('./features/inbound'))
const rituals = chunk(() => import('./features/inbound/rituals'))
const operator = chunk(() => import('./features/operator'))
const supportInbox = chunk(() => import('./features/support-inbox'))
const supportAction = chunk(() => import('./features/support/actions'))
const legal = chunk(() => import('./features/legal'))
const pricing = chunk(() => import('./features/pricing'))
const supportContinue = chunk(() => import('./features/support/continue'))
const connect = chunk(() => import('./features/connect'))
// Staff pages' skeletons come with their own code, so no one else's first screen carries them.
const operatorSkeletons = chunk(() => import('./features/operator/skeletons'))
const supportSkeletons = chunk(() => import('./features/support-inbox/skeletons'))
// Dev and VITE_DESIGN_SHEET=1 builds only (lib/design-sheet.ts). The test is written out here, not imported, so the
// bundler sees a constant and leaves the chunk out of any other build.
const DesignSheetPage = import.meta.env.DEV || import.meta.env.VITE_DESIGN_SHEET === '1' ? chunk(() => import('./features/design-sheet')).page(m => m.DesignSheetPage) : null
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
const TopicsPage = audience.page(m => m.TopicsPage)
const SegmentEditorPage = audience.page(m => m.SegmentEditorPage)
const ApiKeysPage = settings.page(m => m.ApiKeysPage)
const SmtpImapPage = settings.page(m => m.SmtpImapPage)
const DomainsPage = settings.page(m => m.DomainsPage)
const DomainDetailPage = settings.page(m => m.DomainDetailPage)
const SettingsPage = settings.page(m => m.SettingsPage)
const McpApprovalPage = settings.page(m => m.McpApprovalPage)
const WebhookDetailPage = settings.page(m => m.WebhookDetailPage)
const DocsPage = docs.page(m => m.DocsPage)
const InboundPage = inbound.page(m => m.InboundPage)
const RulePage = rituals.page(m => m.RulePage)
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
const OperatorAgentsPage = operator.page(m => m.OperatorAgentsPage)
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

const OperatorSkeleton = operatorSkeletons.page(m => m.OperatorRouteSkeleton)
const GlassSkeleton = operatorSkeletons.page(m => m.GlassRouteSkeleton)
const SupportSkeleton = supportSkeletons.page(m => m.SupportRouteSkeleton)

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
  // The moment onboarding finishes, its screen stays up while the redirect lands (the router applies it in a render of its
  // own): the dashboard then replaces it directly, with no empty frame between them.
  const last = useRef(stage)
  if (stage) last.current = stage
  if (!last.current) return <Navigate to="/overview" replace />
  return <>{!stage && <Navigate to="/overview" replace />}<ChunkFallback.Provider value={<BootLoader />}><Suspense fallback={<BootLoader />}><OnboardingPage stage={last.current} /></Suspense></ChunkFallback.Provider></>
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
// Former sections that were folded into another page keep their links working: the old link's query joins the new
// address's, and its anchor applies unless the new address names its own.
function Moved({ to }: { to: (params: Readonly<Params>) => string }) {
  const location = useLocation()
  const [path = '', hash] = to(useParams()).split('#'), [pathname, query] = path.split('?')
  const search = [query, location.search.slice(1)].filter(Boolean).join('&')
  return <Navigate replace to={{ pathname, search: search && `?${search}`, hash: hash ? `#${hash}` : location.hash }} />
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
// A route's handle (lib/routes.ts RouteHandle) names the code its page needs and the shell's skeleton while that loads.
const load = (...chunks: { preload: () => Promise<unknown> }[]) => () => Promise.all(chunks.map(c => c.preload()))
const booting = (page: ReactNode) => <ChunkFallback.Provider value={<BootLoader />}><Suspense fallback={<BootLoader />}>{page}</Suspense></ChunkFallback.Provider>
const rules = '/receiving?tab=rules'
// The route table, also given to analytics (a page view names its template) and to the signed-out pages (lib/routes.ts).
const routes = <>
  <Route handle={{ preload: load(legal), early: true }} path="legal/:doc?" element={booting(<LegalPage />)} />
  <Route handle={{ preload: load(pricing), early: true }}>
    {['pricing', 'pricing/:vendor', 'alternatives/:vendor', 'email-for-ai-agents', 'cheapest-email-api', 'free-email-api', 'compare', 'compare/:vendor'].map(path => <Route key={path} path={path} element={booting(<PricePage />)} />)}
  </Route>
  <Route handle={{ preload: load(onboarding), early: true }} path="onboarding" element={<OnboardingRoute />} />
  <Route handle={{ preload: load(connect), early: true }} path="connect" element={booting(<ConnectPage />)} />
  <Route handle={{ preload: load(supportContinue), early: true }} path="support/continue/:id/:message" element={<ChunkFallback.Provider value={<BootLoader />}><SupportContinuePage /></ChunkFallback.Provider>} />
  <Route index element={<RootPage />} />
  {DesignSheetPage && <Route path="_design-sheet" element={<ChunkFallback.Provider value={<BootLoader />}><DesignSheetPage /></ChunkFallback.Provider>} />}
  <Route element={<DashboardGate />}>
    <Route handle={{ preload: load(overview), skeleton: <OverviewRouteSkeleton /> }} path="overview" element={<OverviewPage />} />
    <Route handle={{ preload: load(logs), skeleton: (params: Params) => <EmailDetailSkeleton kind={isReceivedId(params.id ?? '') ? 'received' : 'sent'} /> }}>
      {/* The list's code is safe to warm before /v1/me even in a fresh browser; its reads still wait for the signed-in shell. */}
      <Route handle={{ early: true, skeleton: <LogsRouteSkeleton /> }} path="logs" element={<LogsPage />} />
      <Route path="logs/received/:id" element={<Moved to={params => `/logs/${id(params)}`} />} /><Route path="logs/:id" element={<LogDetailPage />} />
    </Route>
    <Route handle={{ preload: load(inbound) }}>
      <Route handle={{ skeleton: <ReceivingRouteSkeleton /> }} path="receiving" element={<ReceivingPage />} />
      <Route path="receiving/endpoints" element={<Navigate replace to="/receiving?tab=destinations" />} /><Route path="receiving/rituals/*" element={<RitualsRedirect />} />
      <Route handle={{ skeleton: <ReceivingPageSkeleton title="New rule" backTo={rules} /> }} path="receiving/rules/new" element={<NewRulePage />} />
      <Route handle={{ skeleton: <ReceivingPageSkeleton title={200} backTo="/receiving/rules/new" /> }} path="receiving/rules/new/:recipe" element={<NewRecipeRoute />} />
      {/* The rule editor is its own chunk, fetched alongside Mail routing's on a cold load, not after it. */}
      <Route handle={{ preload: load(inbound, rituals), skeleton: <ReceivingPageSkeleton title="New rule" backTo={rules} /> }} path="receiving/rules/new/script" element={<RulePage />} />
      <Route handle={{ preload: load(inbound, rituals), skeleton: <ReceivingPageSkeleton title={200} backTo={rules} /> }} path="receiving/rules/:key" element={<RulePage />} />
      <Route path="receiving/rules/:key/code" element={<Moved to={params => `/receiving/rules/${encodeURIComponent(params.key ?? '')}`} />} /><Route path="receiving/rules" element={<Navigate replace to={rules} />} /><Route path="receiving/routing" element={<Navigate replace to="/receiving" />} />
      <Route path="receiving/trace" element={<TracePage />} /><Route path="receiving/inbox" element={<InboundPage />} />
      <Route handle={{ skeleton: <ReceivingPageSkeleton title={240} backTo="/receiving" /> }} path="receiving/addresses/:id" element={<InboundAddressDetailPage />} />
      <Route path="receiving/webhooks" element={<WebhooksListRedirect />} />
      <Route handle={{ skeleton: <ReceivingPageSkeleton title={220} backTo="/receiving?tab=destinations" /> }} path="receiving/webhooks/:id" element={<InboundWebhookDetailPage />} />
      <Route handle={{ skeleton: <ReceivingPageSkeleton title="Agent inboxes" backTo="/receiving?kind=inbox" /> }} path="receiving/inboxes" element={<AgentInboxesPage />} />
      <Route handle={{ skeleton: <ReceivingPageSkeleton title={260} backTo="/receiving/inboxes" /> }} path="receiving/inboxes/:id" element={<AgentInboxPage />} />
      <Route path="receiving/addresses" element={<Moved to={() => '/receiving'} />} /><Route path="inbound" element={<Moved to={() => '/logs?view=received'} />} /><Route path="inbound/addresses" element={<Moved to={() => '/receiving'} />} /><Route path="inbound/addresses/:id" element={<Moved to={params => `/receiving/addresses/${id(params)}`} />} /><Route path="inbound/webhooks" element={<WebhooksListRedirect />} /><Route path="inbound/webhooks/:id" element={<Moved to={params => `/receiving/webhooks/${id(params)}`} />} />
      <Route path="mailboxes" element={<LegacyMailboxesRedirect />} /><Route path="mailboxes/webhooks" element={<LegacyMailboxWebhooksRedirect />} /><Route path="mailboxes/webhooks/:id" element={<LegacyMailboxWebhookRedirect />} /><Route path="mailboxes/:id" element={<LegacyMailboxRedirect />} />
    </Route>
    <Route handle={{ preload: load(campaigns) }}>
      <Route handle={{ skeleton: <CampaignRouteSkeleton kind="list" /> }} path="campaigns" element={<CampaignsPage />} />
      {/* The composer is the largest chunk; an editor route fetches it alongside the campaigns chunk, not after it. */}
      <Route handle={{ preload: load(campaigns, composer), skeleton: <CampaignRouteSkeleton kind="editor" isNew /> }} path="campaigns/new" element={<CampaignEditorPage />} />
      <Route handle={{ preload: load(campaigns, composer), skeleton: <CampaignRouteSkeleton kind="editor" /> }} path="campaigns/:id/edit" element={<CampaignEditorPage />} />
      <Route handle={{ skeleton: <CampaignRouteSkeleton kind="review" /> }} path="campaigns/:id/review" element={<CampaignReviewPage />} />
      <Route handle={{ skeleton: <CampaignRouteSkeleton kind="templates" /> }} path="campaigns/templates" element={<TemplatesPage />} />
      <Route handle={{ preload: load(campaigns, composer), skeleton: <CampaignRouteSkeleton kind="template" /> }} path="campaigns/templates/:id" element={<TemplateEditorPage />} />
      <Route path="templates" element={<Moved to={() => '/campaigns/templates'} />} /><Route path="templates/:id" element={<Moved to={params => `/campaigns/templates/${id(params)}`} />} />
    </Route>
    <Route handle={{ preload: load(newsletters), skeleton: (params: Params) => <NewsletterRouteSkeleton id={params.id} /> }}>
      <Route path="newsletters" element={<NewslettersPage />} /><Route handle={{ skeleton: <NewsletterRouteSkeleton id="new" /> }} path="newsletters/new" element={<NewNewsletterPage />} /><Route path="newsletters/:id" element={<NewsletterPage />} />
    </Route>
    <Route handle={{ preload: load(audience) }}>
      <Route handle={{ skeleton: <AudienceRouteSkeleton kind="contacts" /> }} path="audience" element={<ContactsPage />} /><Route handle={{ skeleton: <AudienceRouteSkeleton kind="contact" /> }} path="audience/contacts/:id" element={<ContactDetailPage />} />
      <Route handle={{ skeleton: <AudienceRouteSkeleton kind="lists" /> }} path="audience/lists" element={<ListsPage />} /><Route handle={{ skeleton: <AudienceRouteSkeleton kind="list" /> }} path="audience/lists/:id" element={<ListDetailPage />} />
      <Route handle={{ skeleton: <AudienceRouteSkeleton kind="segments" /> }} path="audience/segments" element={<SegmentsPage />} />
      <Route handle={{ skeleton: <AudienceRouteSkeleton kind="segment" isNew /> }} path="audience/segments/new" element={<SegmentEditorPage />} /><Route handle={{ skeleton: <AudienceRouteSkeleton kind="segment" /> }} path="audience/segments/:id" element={<SegmentEditorPage />} />
      <Route handle={{ skeleton: <AudienceRouteSkeleton kind="topics" /> }} path="audience/topics" element={<TopicsPage />} />
      <Route path="contacts" element={<Moved to={() => '/audience'} />} /><Route path="contacts/:id" element={<Moved to={params => `/audience/contacts/${id(params)}`} />} />
      <Route path="lists" element={<Moved to={() => '/audience/lists'} />} /><Route path="lists/:id" element={<Moved to={params => `/audience/lists/${id(params)}`} />} />
      <Route path="segments" element={<Moved to={() => '/audience/segments'} />} /><Route path="segments/:id" element={<Moved to={params => `/audience/segments/${id(params)}`} />} />
    </Route>
    <Route handle={{ preload: load(settings) }}>
      <Route handle={{ skeleton: <SettingsRouteSkeleton kind="keys" /> }} path="api-keys" element={<ApiKeysPage />} /><Route handle={{ skeleton: <SmtpImapRouteSkeleton /> }} path="smtp-imap" element={<SmtpImapPage />} />
      <Route handle={{ skeleton: <SettingsRouteSkeleton kind="domains" /> }} path="domains" element={<DomainsPage />} /><Route handle={{ skeleton: <SettingsRouteSkeleton kind="domain" /> }} path="domains/:id" element={<DomainDetailPage />} />
      <Route handle={{ skeleton: <SettingsRouteSkeleton kind="settings" /> }}>
        <Route path="settings" element={<SettingsPage />} /><Route path="settings/mcp/:id" element={<McpApprovalPage />} />
        <Route handle={{ skeleton: <SettingsRouteSkeleton kind="webhook" isNew /> }} path="settings/webhooks/new" element={<WebhookDetailPage />} /><Route handle={{ skeleton: <SettingsRouteSkeleton kind="webhook" /> }} path="settings/webhooks/:id" element={<WebhookDetailPage />} />
        <Route path="settings/webhooks" element={<Moved to={() => '/settings#webhooks'} />} /><Route path="settings/workspace" element={<Moved to={() => '/settings#workspace'} />} /><Route path="settings/account" element={<Moved to={() => '/settings#account'} />} />
      </Route>
    </Route>
    {/* The docs are public: signed out or in, their code loads alongside /v1/me. */}
    <Route handle={{ preload: load(docs), early: true, skeleton: <DocsSkeleton /> }}>
      <Route path="docs/*" element={<DocsPage />} /><Route path="developer" element={<Moved to={() => '/docs'} />} />
    </Route>
    <Route handle={{ preload: load(operator, operatorSkeletons), skeleton: <OperatorSkeleton /> }}>
      <Route path="operator" element={<OperatorPage />} /><Route path="operator/notes" element={<OperatorNotesPage />} /><Route path="operator/agents" element={<OperatorAgentsPage />} /><Route path="operator/workspaces/:id" element={<OperatorWorkspacePage />} /><Route path="operator/abuse/:id" element={<OperatorClusterPage />} />
      <Route handle={{ skeleton: <GlassSkeleton /> }} path="glass" element={<GlassPage />} />
    </Route>
    <Route handle={{ preload: load(supportInbox, supportSkeletons), skeleton: <SupportSkeleton /> }}>
      <Route path="support" element={<SupportInboxPage />} /><Route path="support/:id" element={<SupportConversationPage />} />
    </Route>
    {/* A change support proposed (its emailed link) opens over Overview. */}
    <Route handle={{ preload: load(overview, supportAction), skeleton: <OverviewRouteSkeleton /> }} path="support/actions/:id" element={<><OverviewPage /><ChunkFallback.Provider value={null}><SupportActionDialog /></ChunkFallback.Provider></>} />
    <Route path="*" element={<EmptyState headingAs="h1" title="Page not found" action={<Link to="/overview">Return to overview</Link>} />} />
  </Route>
</>
setRouteTable(createRoutesFromChildren(routes))

// Preload the first screen's code alongside /v1/me. A workspace that may need onboarding waits for /v1/me, unless the
// route's code loads early.
const noop = () => {}
const initialPath = window.location.pathname
// "/" is the homepage, signed in or out, on a hosted installation: a remembered workspace means one, and so does a first
// visit. A self-hosted installation remembered as ready has no homepage: "/" opens Overview there.
// Its first picture starts loading with its code.
if (initialPath === '/') { if (selectedWorkspace() || !dashboardLikelyReady(null)) { preloadFirstPicture(); loadHome().catch(noop) } else overview.preload().catch(noop) }
else { const { handle } = routeHandle(initialPath); if (handle.early || dashboardLikelyReady(selectedWorkspace())) handle.preload?.().catch(noop) }
