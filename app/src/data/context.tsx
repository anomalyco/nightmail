import { createContext, Suspense, useContext, useRef, useState, useMemo, useEffect, type FormEvent, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from 'react-router'
import { ApiError, type Identity, type Api, type WorkspaceInvitationPreview, errorText, tooBroadCode } from './types'
import { roleLabel, workspaceApi } from './workspaces'
import { aborted, asksOnlyIfLikely, clearInterruptedWrites, createLiveApi, currentScope, isCurrentScope, rememberedWorkspace, rememberSession, request, selectAccount, selectedAccount, selectedWorkspace, selectWorkspace, sessionLikely, takeInterruptedWrite, type RequestScope } from './live'
import { accountApi, accountsKey, announce, expectAccount, onAccountEvent, POPUP_PATH, takeExpectedAccount, type AccountList } from './accounts'
import { forgetInboxDrafts } from './support-inbox'
import { regionCatalogKey } from './regions'
import { dashboardLikelyReady, identityOnboardingStage, rememberDashboardReady, useDomainStep, onboardingStage } from './onboarding'
import { clearLandingFocus, noteLandingLocation, rememberLandingFocus } from './landing-focus'
import { Alert, Button, Field, Input, PageHeader, ToastScope, useToast } from '../components/ui'
import { BootLoader } from '../components/BootLoader'
import { PrivateAddress } from '../components/PrivateAddress'
import { chunk } from '../lib/preloadable'
import { canonicalOrigin } from '../lib/public-origin'
import { queries, type QueryDef } from './queries'
import { invalidateResources, resourceOf, staleAfterWrite, type InvalidationTarget } from './invalidation'
import { useGuardedMutation } from '../lib/single-flight'
import { SignInConsent } from '../components/LegalLinks'
import { productName } from '../../../api/src/brand'
import { ANALYTICS_SESSION_PARAM } from '../../../api/src/analytics-events'
import type { WorkspaceFocus } from '../../../api/src/workspace-focus'
import { analytics } from '../lib/analytics'
import { Analytics } from '../components/Analytics'
import { NightmailWordmark } from '../components/NightmailLogo'
import { isKnownPath } from '../lib/routes'
import { DESIGN_SHEET_PATH, designSheetEnabled } from '../lib/design-sheet'

// The tab's account and workspace. logout signs out of this tab's account only; another connected account takes its place.
type Session = { identity: Identity | null; logout: () => Promise<void>; switchWorkspace: (id: string, path?: string) => Promise<void>
  switchAccount: (id: string, path?: string, workspace?: string) => Promise<void>; addAccount: (path?: string) => void; signOutAccount: (id?: string) => Promise<void>; signOutAll: () => Promise<void>
  /** Staff tools need this account's Google sign-in (Identity.staffSignIn): signs in again with Google, back to this page. */
  signInForStaff: () => void
  /** Sign in, back to this page: for the public pages that need one. From the price pages, as from the homepage, it opens
   *  Overview; focus (a comparison's) rides along as ?focus=, which onboarding reads. select: the account service shows its
   *  chooser first (a support email's sign-in link, which may be for another account than this browser's). */
  signIn: (focus?: WorkspaceFocus, select?: boolean) => void
  /** A press starting on a sign-in button (pointer down): the sign-in request starts then, as the homepage's button does. */
  signInIntent: (event: { button: number }, focus?: WorkspaceFocus) => void
  /** A sign-in is under way (its button shows it). */
  signingIn: boolean
  notice: string | null; dismissNotice: () => void }
const homeChunk = chunk(() => import('../features/home'))
export const loadHome = homeChunk.preload
export const HomePage = homeChunk.page(m => m.HomePage)
const ApiContext = createContext<Api | null>(null)
const RequestScopeContext = createContext<RequestScope | null>(null)
const SessionContext = createContext<Session | null>(null)
export const useSession = () => useContext(SessionContext)
/** The data contexts as a signed-out visitor's page has them, for a page drawn at build time (features/docs/prerender.tsx):
 *  no session, and an API no query may call (each query a visitor's page draws from is disabled, or seeded beforehand). */
export function VisitorData({ children }: { children: ReactNode }) {
  const none = new Proxy({}, { get: (_target, name) => { throw new Error(`A page drawn at build time asked the API (${String(name)}).`) } }) as Api
  return <ApiContext.Provider value={none}><SessionContext.Provider value={null}>{children}</SessionContext.Provider></ApiContext.Provider>
}
/** The account/workspace scope of the mounted provider generation; passing it to request() fails closed after a switch. */
export const useRequestScope = () => useContext(RequestScopeContext) ?? currentScope()
/** Logs row prefetch and rendering share this key, but never a cache entry across visibility bands. */
export function useLogsVisibility() {
  const identity = useSession()?.identity
  const scope = useRequestScope()
  return identity ? JSON.stringify([scope.account, scope.workspace, scope.epoch, identity.id, identity.workspaceId,
    identity.multiTenant ? identity.role : 'self-hosted']) : null
}
// Self-hosted installations have no workspace roles; every signed-in operator administers.
export function useWorkspaceAccess() {
  const identity = useContext(SessionContext)?.identity
  const multiTenant = identity?.multiTenant === true
  const role = multiTenant ? identity?.role ?? null : null
  return { multiTenant, role, canAdminister: !multiTenant || role === 'owner' || role === 'admin' }
}
// What the current workspace still needs before the dashboard opens; null when it can open.
export function useOnboardingStage() {
  const identity = useContext(SessionContext)?.identity
  return onboardingStage(identity, useDomainStep(identity?.workspaceId))
}
// What a finished sign-in (?auth=) means. account_limit only follows Add account.
const authMessages: Record<string, string> = {
  google_required: `${productName} requires Google sign-in. Try again and choose Google at Anomaly account.`,
  method_required: 'Sign in again using the authentication method required by this installation.',
  interaction_required: 'Your identity provider needs you to complete sign-in. Try again and follow its prompts.',
  account_limit: 'This browser has the most accounts it can hold. Sign out of one to add another.',
  waitlist: `${productName} is full for now. You’re on the waitlist, and we’ll email you as soon as a place opens.`,
  error: 'Sign-in didn’t finish. Check that you used your invited or approved account.',
}
// The section of the current page, without a record from the previous account or workspace in it.
export function sectionPath(pathname = window.location.pathname) {
  const [section, child] = pathname.split('/').filter(Boolean)
  return (section === 'audience' && ['lists', 'segments'].includes(child)) || (section === 'campaigns' && child === 'templates') ? `/${section}/${child}` : section ? `/${section}` : '/'
}
const reviewRoute = /^\/campaigns\/([^/]+)\/review\/?$/
// Review's boot observers can unmount or restart while the same identity is in flight. Cancel their wait,
// not the transport: request still aborts on a scope switch, and no completed result is retained here.
let reviewIdentity: { scope: RequestScope; result: Promise<Identity> } | undefined
function readReviewIdentity(signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(aborted())
  if (!reviewIdentity || !isCurrentScope(reviewIdentity.scope)) {
    const scope = currentScope()
    const result = request<Identity>('/v1/me', { scope })
    const flight = reviewIdentity = { scope, result }
    const clear = () => { if (reviewIdentity === flight) reviewIdentity = undefined }
    void result.then(clear, clear)
  }
  const { scope, result } = reviewIdentity
  if (!signal) return result
  return new Promise<Identity>((resolve, reject) => {
    const stop = () => reject(aborted())
    signal.addEventListener('abort', stop, { once: true })
    const finish = () => signal.removeEventListener('abort', stop)
    void result.then(identity => { finish(); if (signal.aborted || !isCurrentScope(scope)) stop(); else resolve(identity) }, error => { finish(); reject(error) })
  })
}
// /v1/me as the tab's account. A remembered workspace the account no longer belongs to falls back to the server's
// choice; an account this browser signed out of (in another tab, or its session expired or was revoked) falls back to
// the browser's default account.
async function loadIdentity(signal?: AbortSignal, override?: { account?: string | null; workspace?: string | null }) {
  let account = override ? (override.account ?? null) : selectedAccount()
  let workspace = override ? (override.workspace !== undefined ? override.workspace : (account ? rememberedWorkspace(account) : null)) : selectedWorkspace()
  const opts = () => override ? { signal, account, workspace } : { signal }
  const read = () => !override && reviewRoute.test(window.location.pathname) ? readReviewIdentity(signal) : request<Identity>('/v1/me', opts())
  // An explicit refetch (e.g. after logout) also respects the public-page hint; refetch bypasses useQuery's enabled flag.
  if (!override && asksOnlyIfLikely(window.location.pathname) && !sessionLikely()) throw new ApiError('Sign in to continue.', 'AUTH_REQUIRED', {}, undefined, 401)
  let result: Identity
  try { result = await read() }
  catch (error) {
    if (!override && error instanceof ApiError && error.status === 401 && error.code === 'AUTH_REQUIRED') rememberSession(false)
    if (error instanceof ApiError && error.code === 'ACCOUNT_SIGNED_OUT' && account) { account = null; workspace = null; if (!override) selectAccount(null) }
    else if (error instanceof ApiError && error.code === 'WORKSPACE_ACCESS_DENIED' && workspace) { workspace = null; if (!override) selectWorkspace(null) }
    else throw error
    try { result = await read() }
    catch (retry) {
      if (!(retry instanceof ApiError && retry.code === 'WORKSPACE_ACCESS_DENIED' && workspace)) throw retry
      workspace = null
      if (!override) selectWorkspace(null)
      result = await read()
    }
  }
  if (!override) {
    selectAccount(result.id)
    selectWorkspace(result.multiTenant ? result.workspaceId : null)
    rememberSession(true)
  }
  return result
}
/** The account in this tab changes or signs out: features holding its state end it (the Help panel's conversation). */
const accountChanged = (signedOut: boolean) => window.dispatchEvent(new CustomEvent('nightmail:account-changed', { detail: { signedOut } }))

function invitationError(error: unknown) {
  if (error instanceof ApiError && error.status === 404) return 'This invitation is invalid, expired or for another email address. Ask for a new one.'
  return `Couldn’t open the invitation. ${errorText(error, 'Try the link again.')}`
}
const expiry = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
// Shown before anything changes: the question, its facts and the two answers. The question is the product's own words;
// the workspace's name comes as plain words (the API's shownName) and the inviter is their address, which also tells
// apart two workspaces that share a name. The slug is not shown: it is made from the name the workspace began with. An account whose only way in is this invitation has no workspace yet (M9): cancelling signs it out
// instead, and its button says so.
function InvitationReview({ invitation, email, firstWorkspace, joining, error, onJoin, onCancel }: { invitation: WorkspaceInvitationPreview; email: string | null; firstWorkspace: boolean; joining: boolean; error: unknown; onJoin: () => void; onCancel: () => void }) {
  return <main className="page-surface"><PageHeader title={productName} /><div className="stack" style={{maxWidth: 520}}>
    <h2>Join this workspace?</h2>
    <dl className="invitation-facts">
      {invitation.workspaceName ? <><dt>Workspace</dt><dd><bdi>{invitation.workspaceName}</bdi></dd></> : null}
      <dt>Invited by</dt><dd><code><PrivateAddress value={invitation.inviterEmail} /></code></dd>
      {email ? <><dt>Invited as</dt><dd><bdi><PrivateAddress value={email} /></bdi></dd></> : null}
      <dt>Role</dt><dd>{roleLabel[invitation.role]}</dd>
      <dt>Expires</dt><dd>{expiry.format(new Date(invitation.expiresAt))}</dd>
    </dl>
    {error ? <Alert tone="danger">{invitationError(error)}</Alert> : null}
    <div className="cluster"><Button variant="primary" loading={joining} onClick={onJoin}>Join workspace</Button><Button disabled={joining} onClick={onCancel}>{firstWorkspace ? 'Cancel and sign out' : 'Cancel'}</Button></div>
  </div></main>
}
/** Signed out at /connect: the agent's code, when the link had one that can be one, and what happens next. */
function connectLead(code: string | null) {
  const typed = (code ?? '').toUpperCase().replace(/[\s-]/g, '')
  const shown = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(typed) ? ` with the code ${typed.slice(0, 4)}-${typed.slice(4)}` : ''
  return `A coding agent is waiting${shown} for you to approve it. Sign in, or sign up, and you’ll see what it asks for before it gets anything.`
}
// Signed out, or the session couldn't be checked, on a page that needs one: the wordmark (to the homepage) over one
// centred column, as the account page it leads to is laid out.
function SignedOutPage({ title, children }: { title: string; children: ReactNode }) {
  return <main className="signed-out">
    <Link className="wordmark" to="/" aria-label={`${productName.toLowerCase()} home`}><NightmailWordmark /></Link>
    <div className="signed-out__body"><h1>{title}</h1>{children}</div>
  </main>
}
// A hosted sign-in nothing admitted (not staff, no invitation): the API put its verified address on the waitlist and
// left the address in a short-lived cookie for this screen (api/src/account-login.ts). Without it, the screen says "you".
// The address is the person's own and shown in full (lib/private-address.ts lists this exception).
function waitlistAddress() {
  const cookie = document.cookie.split(';').map(part => part.trim()).find(part => /^(?:__Host-)?nightmail\.waitlist=/.test(part))
  try { return cookie ? decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)) || null : null } catch { return null }
}
// What the refusal says (api/src/account-login.ts). ?place=held (a place is held for the address) or ?place=ready (one is
// open), but the sign-in didn't show the address is the person's (GitHub without it as its verified primary email, a
// password, a Google account on another provider's address): one click emails it a sign-in link. Otherwise the address
// waits, every place taken, and ?position=N says where in the order a raise lets the waitlist in (1 is next); someone
// told they're in who signed in with another address asks for a link to that one. ?link=expired: the sign-in link it
// followed was used or ran out.
function WaitlistPage({ busy, error, onSwitch }: { busy: boolean; error: unknown; onSwitch: () => void }) {
  const [email] = useState(waitlistAddress), [search] = useState(() => new URLSearchParams(window.location.search))
  const place = search.get('place'), ready = (place === 'held' || place === 'ready') && email !== null, expired = search.get('link') === 'expired'
  const position = /^[1-9]\d{0,6}$/.test(search.get('position') ?? '') ? Number(search.get('position')) : null
  const who = email ? <bdi data-own-address="">{email}</bdi> : null
  return <SignedOutPage title={ready ? `There’s a place for you in ${productName}` : `${productName} is full for now`}>
    {expired ? <Alert tone="info">That sign-in link was already used or has expired. Ask for a new one below.</Alert> : null}
    {ready ? <p>This sign-in didn’t confirm {who} is yours. GitHub counts only a verified primary email. Get a sign-in link sent to it to take your place.</p>
      : <><p><strong>{position ? `You’re number ${position.toLocaleString('en-US')} on the waitlist.` : 'You’re on the waitlist.'}</strong> We’ll email {who ? <>you at {who}</> : 'you'} as soon as a place opens.</p>
        <p className="muted">Got an email saying you’re in? Sign in with that address, or get a sign-in link sent to it.</p></>}
    <SignInLinkForm to={ready ? email : null} />
    {error ? <Alert tone="danger">{errorText(error)}</Alert> : null}
    <Button variant={ready ? 'secondary' : 'primary'} loading={busy} onClick={onSwitch} data-analytics="sign-in/waitlist-switch">Use a different account</Button>
    <nav className="signed-out__links" aria-label={productName}><Link to="/">Homepage</Link><Link to="/docs">Docs</Link></nav>
  </SignedOutPage>
}
// A sign-in link to an address with a place (api/src/signups.ts sendSigninLink): the refused sign-in's own address when a
// place is held for it or open, in one click, else the address typed. The answer never says whether there is a place.
// Its words replace the hint in one slot sized for the longest, so asking shifts nothing.
const linkLines = { idle: 'The link works once, for 30 minutes.', sent: 'If there’s a place for that address, a link is on its way.', failed: 'Couldn’t ask for a link. Try again in a few minutes.' }
function SignInLinkForm({ to }: { to: string | null }) {
  const [typed, setTyped] = useState(''), [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  async function send(event: FormEvent) {
    event.preventDefault()
    setState('sending')
    try { await accountApi.signInLink(to ?? typed.trim()); setState('sent') } catch { setState('failed') }
  }
  const shown = state === 'sending' ? 'idle' : state
  return <form className="signed-out__link-form" onSubmit={event => void send(event)}>
    {to ? null : <Field label="Address you joined the waitlist with" htmlFor="waitlist-link-address"><Input id="waitlist-link-address" type="email" autoComplete="email" required value={typed} onChange={event => { setTyped(event.target.value); setState('idle') }} /></Field>}
    <Button type="submit" variant={to ? 'primary' : 'secondary'} loading={state === 'sending'} data-analytics="sign-in/waitlist-link">Email me a sign-in link</Button>
    <p className="signed-out__status muted" role="status">{(Object.keys(linkLines) as (keyof typeof linkLines)[]).map(key => <span key={key} data-shown={key === shown || undefined}>{linkLines[key]}</span>)}</p>
  </form>
}
/** Pages anyone can open, signed in or not. Continuing an emailed support request (features/support/continue.tsx) is one:
 *  a person signed in without a workspace has no /v1/me but can confirm it, and someone signed out signs in from it. */
export const isPublicPath = (path: string) => (path !== '/' && asksOnlyIfLikely(path)) || path.startsWith('/support/continue/') || (designSheetEnabled && path === DESIGN_SHEET_PATH)
export function ApiProvider({ children }: { children: ReactNode }) {
  // The docs, the legal pages and the price pages are public: they render signed out, and /v1/me only adds the workspace's context.
  const { pathname, search } = useLocation(), publicRoute = isPublicPath(pathname)
  // A landing link's ?focus= (landing-focus.ts), noted before anything below reads it: an address the app moves to.
  noteLandingLocation(pathname, search)
  const navigate = useNavigate()
  // A sign-in (or a return from a provider) this tab started names the account the page opens as; the tab then stays
  // with it. The server names only an account this browser has a session for; a link alone never moves the tab.
  useState(() => {
    const url = new URL(window.location.href), account = url.searchParams.get('account')
    if (account === null) return
    if (takeExpectedAccount() && /^[A-Za-z0-9._:-]{1,200}$/.test(account)) { selectAccount(account); rememberSession(true) }
    url.searchParams.delete('account')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  })
  // Bumped on workspace switches so clients, cursors and every mounted screen start fresh.
  const [generation, setGeneration] = useState(0)
  const switchSeq = useRef(0)
  const cache = useQueryClient()
  const toast = useToast()
  const [authError, setAuthError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [invitation, setInvitation] = useState(() => publicRoute ? null : new URLSearchParams(window.location.search).get('invitation'))
  function clearInvitation() {
    const url = new URL(window.location.href)
    url.searchParams.delete('invitation')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    setInvitation(null)
  }
  const checkIdentity = !asksOnlyIfLikely(pathname) || sessionLikely()
  const identity = useQuery({
    queryKey: ['identity'],
    enabled: checkIdentity,
    networkMode: 'always', refetchOnReconnect: true,
    retry: (failures, error) => failures < 1 && error instanceof ApiError && error.code !== 'AUTH_NOT_CONFIGURED' && (error.code === 'NETWORK_UNAVAILABLE' || (error.status ?? 0) >= 500),
    queryFn: async ({signal}) => {
      const started = performance.now()
      const result = await loadIdentity(signal)
      console.info(`[${productName} timing] Dashboard session ready`, { durationMs: Number((performance.now() - started).toFixed(1)) })
      return result
    },
  })
  const scope = useMemo(() => currentScope(), [generation, identity.data?.id, identity.data?.workspaceId])
  const client = useMemo(() => createLiveApi(scope.account !== null || scope.workspace !== null ? scope : undefined), [scope])
  // An invitation link only opens a review. Joining, and switching to the workspace, wait for the
  // recipient's own click: a link alone must never move someone into another workspace.
  const review = useQuery({
    queryKey: ['invitation', invitation], enabled: Boolean(invitation), retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async ({ signal }) => {
      try { return await workspaceApi.reviewInvitation(invitation!, signal) }
      catch (error) {
        // Signed out: keep the link so sign-in returns here to review it.
        if (error instanceof ApiError && error.status === 401) return null
        throw error
      }
    },
  })
  const join = useGuardedMutation({
    requestScope: null,
    mutationFn: async (pending: WorkspaceInvitationPreview) => {
      const { workspaceId } = await workspaceApi.acceptInvitation(pending.id)
      // Joined from the homepage (an invitation link from before it moved to /overview): open the dashboard.
      await switchWorkspace(workspaceId, window.location.pathname === '/' ? '/overview' : undefined)
      clearInvitation()
      toast(pending.workspaceName ? `Joined ${pending.workspaceName}` : 'Joined the workspace', 'success')
    },
  })
  useEffect(() => {
    if (!invitation) return
    if (review.error) { setNotice(invitationError(review.error)); clearInvitation() }
    // Already a member (an account whose only way in was this invitation joins at sign-in): nothing to confirm or switch.
    else if (review.data?.status === 'accepted') clearInvitation()
    else if (review.data === null && identity.data) { setNotice('Couldn’t open the invitation. Follow the link again.'); clearInvitation() }
  }, [invitation, review.error, review.data, identity.data])
  async function switchWorkspace(id: string, path?: string) {
    const previous = selectedWorkspace()
    // A first-time invitee has no identity yet, so a remembered ID equal to the joined workspace still loads it.
    if (id === previous && cache.getQueryData(['identity'])) return
    const seq = ++switchSeq.current
    const account = selectedAccount()
    // Probe the target workspace without changing the active selection yet: mounted screens from the previous
    // workspace must never send a request to, or read from, the target workspace while /v1/me is in flight.
    const next = await request<Identity>('/v1/me', { workspace: id })
    if (seq !== switchSeq.current || selectedAccount() !== account) throw aborted()
    // Commit synchronously: abort every in-flight request from the previous workspace, clear cache and remount.
    const nextWorkspace = next.multiTenant ? next.workspaceId : null
    selectWorkspace(nextWorkspace)
    void cache.cancelQueries()
    cache.clear()
    cache.setQueryData(['identity'], next)
    if (path) navigate(path)
    setGeneration(value => value + 1)
    if (takeInterruptedWrite(next.id, nextWorkspace)) toast('A save here was cut off when you switched — check if it landed.', 'info')
  }
  // Act as another connected account in this tab, at once: no round trip to the account service, one /v1/me to Nightmail.
  // Nothing from the previous account stays cached or mounted (the generation remounts every screen and dialog), and
  // responses to its requests still in flight are dropped (live.ts). null: the browser's default account.
  async function enter(account: string | null, options: { path?: string; workspace?: string } = {}) {
    const previous = { account: selectedAccount(), workspace: selectedWorkspace() }
    const seq = ++switchSeq.current
    let next: Identity
    try { next = await loadIdentity(undefined, { account, workspace: options.workspace }) }
    catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error
      if (seq !== switchSeq.current) throw aborted()
      // No account is left in this browser: the signed-out page.
      accountChanged(true); selectAccount(null); selectWorkspace(null); void cache.cancelQueries(); cache.clear(); setGeneration(value => value + 1); await identity.refetch(); return
    }
    if (seq !== switchSeq.current) throw aborted()
    if (next.id !== previous.account) accountChanged(false)
    const nextWorkspace = next.multiTenant ? next.workspaceId : null
    selectAccount(next.id)
    selectWorkspace(nextWorkspace)
    void cache.cancelQueries()
    const accounts = cache.getQueryData<AccountList>(accountsKey)
    cache.clear()
    if (accounts) cache.setQueryData<AccountList>(accountsKey, { ...accounts, active: next.id })
    cache.setQueryData(['identity'], next)
    if (options.path) navigate(options.path)
    setGeneration(value => value + 1)
    if (takeInterruptedWrite(next.id, nextWorkspace)) toast('A save here was cut off when you switched — check if it landed.', 'info')
  }
  async function switchAccount(id: string, path?: string, workspace?: string) {
    if (id === selectedAccount() && cache.getQueryData(['identity'])) { if (workspace) await switchWorkspace(workspace, path); return }
    await enter(id, { path, workspace })
    // New tabs and links opened outside the dashboard follow the latest choice.
    void accountApi.makeDefault(id).catch(() => {})
  }
  async function signOutAccount(id = selectedAccount() ?? undefined) {
    const result = await accountApi.signOut(id ? { account: id } : {})
    clearInterruptedWrites(id ?? selectedAccount())
    forgetInboxDrafts()
    if (id) announce({ type: 'signed-out', accounts: [id] })
    if (id && id !== selectedAccount()) { void cache.invalidateQueries({ queryKey: accountsKey }); return }
    window.dispatchEvent(new Event('nightmail:active-session-ended'))
    rememberDashboardReady(selectedWorkspace(), false)
    accountChanged(true)
    if (result.active) { await enter(result.active, { path: '/overview' }); toast('Signed out of that account', 'success'); return }
    selectAccount(null); selectWorkspace(null); cache.clear(); await identity.refetch()
  }
  async function signOutAll() {
    await accountApi.signOut({ all: true })
    window.dispatchEvent(new Event('nightmail:active-session-ended'))
    clearInterruptedWrites()
    forgetInboxDrafts()
    announce({ type: 'signed-out', accounts: 'all' })
    rememberDashboardReady(selectedWorkspace(), false)
    accountChanged(true)
    selectAccount(null); selectWorkspace(null); cache.clear(); await identity.refetch()
  }
  // Add account: the account service's chooser in a popup. The popup starts the sign-in itself and is opened with
  // noopener, so it holds no reference to this page; it reports back over the BroadcastChannel only. The account picked
  // there opens in this tab; Nightmail never learns which other accounts are signed in at the account service.
  const adding = useRef<{ tab: string; path?: string; fallback: number } | null>(null)
  function addAccount(path?: string) {
    if (adding.current) window.clearTimeout(adding.current.fallback)
    const tab = crypto.randomUUID(), start = new URL(POPUP_PATH, window.location.origin)
    start.searchParams.set('start', '1'); start.searchParams.set('tab', tab)
    window.open(start.href, '_blank', 'popup,noopener,noreferrer,width=480,height=720')
    // noopener leaves no handle to tell a blocked popup apart: one that hasn't announced itself within a few seconds
    // didn't open, so the add continues in this tab as a redirect.
    const fallback = window.setTimeout(() => { if (adding.current?.tab === tab) { adding.current = null; void redirectAdd() } }, 4000)
    adding.current = { tab, path, fallback }
  }
  async function redirectAdd() {
    const callback = new URL(window.location.pathname, window.location.origin)
    callback.search = window.location.search; callback.searchParams.delete('auth'); callback.searchParams.delete('place'); callback.searchParams.delete('position')
    try { const url = await accountApi.signIn(callback.href, true); expectAccount(); window.location.assign(url) }
    catch (error) { toast(error instanceof ApiError && error.code === 'ACCOUNT_LIMIT' ? authMessages.account_limit : errorText(error, 'Couldn’t add an account.'), 'error') }
  }
  useEffect(() => onAccountEvent(event => {
    if (event.type === 'add-started') { if (event.tab && event.tab === adding.current?.tab) window.clearTimeout(adding.current.fallback); return }
    if (event.type === 'signed-in') {
      void cache.invalidateQueries({ queryKey: accountsKey })
      const pending = adding.current
      if (!event.tab || event.tab !== pending?.tab) return
      window.clearTimeout(pending.fallback)
      adding.current = null
      if (event.auth || !event.account) { toast(authMessages[event.auth ?? 'error'] ?? authMessages.error, event.auth === 'waitlist' ? 'info' : 'error'); return }
      void switchAccount(event.account, pending.path ?? sectionPath()).then(() => toast('Account added', 'success'), () => toast('Couldn’t open the account.', 'error'))
      return
    }
    // Another tab signed this tab's account out: leave it now rather than at its next request.
    const mine = selectedAccount()
    if (event.accounts === 'all' || (mine && event.accounts.includes(mine))) {
      window.dispatchEvent(new Event('nightmail:active-session-ended'))
      void enter(null, { path: sectionPath() }).catch(() => {})
    }
    else void cache.invalidateQueries({ queryKey: accountsKey })
  }))
  // A request answered that this tab's account is signed out in this browser (expired or revoked): move to another.
  // Several requests can learn it at once: leave once.
  const leaving = useRef(false)
  useEffect(() => {
    const gone = () => {
      if (leaving.current) return
      leaving.current = true
      void enter(null, { path: sectionPath() }).then(() => toast('That account was signed out', 'info'), () => {}).finally(() => { leaving.current = false })
    }
    window.addEventListener('nightmail:account-signed-out', gone)
    return () => window.removeEventListener('nightmail:account-signed-out', gone)
  })
  // Load the region catalog alongside /v1/me rather than after it; the shell reuses this cache entry.
  // An invitation link selects its workspace first, so wait until it is accepted. Workspaces that may
  // still need onboarding wait for /v1/me, so onboarding never starts dashboard requests.
  useEffect(() => {
    // A remembered workspace means a hosted installation, which never reads it.
    if (publicRoute || invitation || selectedWorkspace() || window.location.pathname === '/onboarding' || !dashboardLikelyReady(selectedWorkspace())) return
    void cache.prefetchQuery({ queryKey: regionCatalogKey(client), queryFn: ({ signal }) => client.regions.list(signal), staleTime: 30_000 })
  }, [cache, client, publicRoute, invitation])
  // A landing link's focus with no onboarding left to save it: dropped.
  useEffect(() => { if (identity.data && !identity.isError && !identityOnboardingStage(identity.data)) clearLandingFocus() }, [identity.data, identity.isError, search])
  useEffect(() => {
    if (!identity.data || identityOnboardingStage(identity.data)) return
    const path = window.location.pathname, review = reviewRoute.exec(path)
    const match = review ?? /^\/campaigns\/([^/]+)\/edit$/.exec(path)
    if (!match) return
    let id: string
    try { id = decodeURIComponent(match[1]) } catch { return }
    const detail = queries.campaign(id)
    void cache.prefetchQuery({ queryKey: ['nightmail', ...detail.key], queryFn: ({ signal }) => detail.read(client, signal), staleTime: 30_000 })
    if (review) {
      const settings = queries.workspaceSettings()
      void cache.prefetchQuery({ queryKey: ['nightmail', ...settings.key], queryFn: ({ signal }) => settings.read(client, signal), staleTime: 30_000 })
    }
  }, [cache, client, identity.data])
  // Before a session is known, a 401 from the boot prefetch is answered by /v1/me itself.
  useEffect(() => { const denied = () => { if (!isPublicPath(window.location.pathname) && cache.getQueryData(['identity']) === undefined) return; cache.clear(); void identity.refetch() }; window.addEventListener('nightmail:unauthorized', denied); return () => window.removeEventListener('nightmail:unauthorized', denied) }, [cache])
  async function logout() { setAuthError(null); try { await signOutAccount() } catch (error) { setAuthError(error) } }
  // Every sign-in request replaces the browser's single OAuth state cookie, so it starts on pointer down
  // (the click that follows is milliseconds away) rather than on hover or focus. The pending request is
  // used by that click only; a pointer down that never becomes a click is dropped after a few seconds.
  const signIn = useRef<{ at: number; url: Promise<string> } | null>(null)
  // select: the account service shows its account chooser first (the waitlist screen's "Use a different account").
  // method: it asks for that sign-in (staff tools need Google).
  function accountUrl(select = false, method?: 'google', focus?: WorkspaceFocus) {
    // Assign path components rather than resolving an untrusted redirect parameter. Signing in from the homepage or a
    // price page (their Get started), or from an address the dashboard doesn't have, opens Overview.
    const callback = new URL(window.location.origin), path = window.location.pathname
    callback.pathname = path === '/' || /^\/(?:pricing|compare)(?:\/|$)|^\/alternatives\/|^\/(?:email-for-ai-agents|cheapest-email-api|free-email-api)$/.test(path) || !isKnownPath(path) ? '/overview' : path
    callback.search = window.location.search
    callback.hash = window.location.hash
    callback.searchParams.delete('auth'); callback.searchParams.delete('place'); callback.searchParams.delete('position')
    if (focus) callback.searchParams.set('focus', focus)
    // Analytics: this signed-out page's session rides in the return URL to the sign-in callback, which links it to the
    // account and removes it before the browser opens the page (docs/analytics.md).
    const session = analytics().signInSession()
    if (session) callback.searchParams.set(ANALYTICS_SESSION_PARAM, session)
    return request<{url: string}>('/api/auth/sign-in/account', {method: 'POST', body: {callbackURL: callback.href, ...select ? {prompt: 'select_account'} : {}, ...method ? {method} : {}}}).then(result => {
      const url = new URL(result.url)
      if (url.protocol !== 'https:') throw new Error('Invalid sign-in redirect.')
      return url.href
    })
  }
  function prepareLogin(event: { button: number }, focus?: WorkspaceFocus) {
    if (busy || event.button !== 0) return
    const url = accountUrl(false, undefined, focus)
    signIn.current = {at: Date.now(), url}
    url.catch(() => { if (signIn.current?.url === url) signIn.current = null })
  }
  const login = () => startLogin(false)
  async function startLogin(select: boolean, method?: 'google', focus?: WorkspaceFocus) {
    setBusy(true); setAuthError(null)
    if (focus) rememberLandingFocus(focus, window.location.pathname)
    const pending = signIn.current
    signIn.current = null
    try { const url = await (!select && !method && pending && Date.now() - pending.at < 5000 ? pending.url : accountUrl(select, method, focus)); expectAccount(); analytics().flush(); window.location.assign(url) }
    catch (error) { setAuthError(error); setBusy(false) }
  }
  const signedOut = !checkIdentity || (identity.error instanceof ApiError && identity.error.status === 401 && identity.error.code === 'AUTH_REQUIRED')
  const unconfigured = identity.error instanceof ApiError && identity.error.code === 'AUTH_NOT_CONFIGURED'
  // Multi-tenant installations greet everyone at "/" with the public homepage (signed in, it is App's index route);
  // /health says which this is.
  // Start alongside /v1/me when no ready dashboard session is remembered so signed-out visitors avoid a second round trip.
  const authResult = new URLSearchParams(window.location.search).get('auth')
  const signInLink = !publicRoute && /^[\w-]+\.[\w-]+$/.test(new URLSearchParams(window.location.search).get('link') ?? '')
  const checkHome = window.location.pathname === '/' && authResult !== 'waitlist' && (signedOut || (!invitation && !dashboardLikelyReady(selectedWorkspace())))
  const home = useQuery({ queryKey: ['public-home'], enabled: checkHome, staleTime: Infinity, retry: false, queryFn: async ({signal}) => {
    const multiTenant = (await request<{multiTenant?: boolean} | null>('/health', {signal}))?.multiTenant === true
    if (multiTenant) await loadHome()
    return multiTenant
  } })
  const authNotice = authError ? <Alert tone="danger">{String(authError)}</Alert>
    : authResult && authMessages[authResult] ? <Alert tone={authResult === 'interaction_required' || authResult === 'waitlist' ? 'info' : 'danger'}>{authMessages[authResult]}</Alert>
    : notice ? <Alert tone="danger">{notice}</Alert>
    : invitation ? <Alert tone="info" title="You have a workspace invitation">Sign in with an emailed link to the invited address, or its Google account. You join only after you confirm.</Alert>
    // A sign-in link (api/src/signups.ts): the sign-in from this page takes the place for the address it went to.
    : signInLink && <Alert tone="info" title="There’s a place for you">Sign in with any account to take it. The link works once.</Alert>
  // M9: an account whose only way in is the invitation signs in with no workspace, so /v1/me is 401 while
  // the invitation itself is readable. It gets the same review; nothing joins until the recipient clicks Join.
  const invitee = signedOut && invitation !== null && review.data?.status === 'pending'
  const reviewing = !publicRoute && invitation !== null && ((identity.data && !identity.isError) || invitee || (signedOut && review.isFetching))
  const allowToast = useMemo(() => () => isCurrentScope(scope), [scope])
  return <ApiContext.Provider key={generation} value={client}><RequestScopeContext.Provider value={scope}><ToastScope allow={allowToast}><SessionContext.Provider value={{identity: identity.data ?? null, logout, switchWorkspace, switchAccount, addAccount, signOutAccount, signOutAll, signInForStaff: () => void startLogin(false, 'google'), signIn: (focus, select) => void startLogin(select === true, undefined, focus), signInIntent: prepareLogin, signingIn: busy, notice, dismissNotice: () => setNotice(null)}}>
    <Analytics identity={identity.data && !identity.isError ? identity.data : null} signedOut={signedOut} />
    {reviewing ? review.data?.status === 'pending' ? <InvitationReview invitation={review.data} email={identity.data?.email ?? null} firstWorkspace={invitee} joining={join.isPending} error={join.error} onJoin={() => join.mutate(review.data!)} onCancel={invitee ? () => { clearInvitation(); void logout() } : clearInvitation} /> : <BootLoader />
    : publicRoute || (identity.data && !identity.isError) ? <>{authError && <Alert tone="danger">{String(authError)}</Alert>}{children}</> : checkIdentity && identity.isPending ? <BootLoader /> : authResult === 'waitlist' && window.location.pathname === '/' ? <WaitlistPage busy={busy} error={authError} onSwitch={() => void startLogin(true)} />
    : home.isLoading ? <BootLoader /> : signedOut && home.data ? <Suspense fallback={null}><HomePage start={{ signedIn: false, onSignIn: login, onSignInIntent: prepareLogin, busy }} notice={authNotice} /></Suspense>
    // A dashboard page (a deep link from an email, or a bookmark) asks to sign in and opens once signed in; any other
    // address says there is no page there.
    // /connect, from the link an agent showed: say what is waiting, so a person who has never signed in knows why.
    : signedOut ? isKnownPath(pathname) ? <SignedOutPage title={pathname === '/connect' ? 'Sign in to approve your agent' : `Sign in to ${productName}`}>
        {authNotice}
        {pathname === '/connect' && <p className="muted">{connectLead(new URLSearchParams(window.location.search).get('code'))}</p>}
        <Button variant="primary" loading={busy} onClick={login} onPointerDown={prepareLogin} data-analytics="sign-in/continue">Continue to sign in</Button>
        <SignInConsent className="muted" />
      </SignedOutPage>
      : <SignedOutPage title="Page not found">
        {authNotice}
        <Button variant="primary" loading={busy} onClick={login} onPointerDown={prepareLogin} data-analytics="sign-in/not-found">Sign in</Button>
        <SignInConsent className="muted" />
        <Link className="signed-out__link" to="/">Go to {productName}</Link>
      </SignedOutPage>
    : <SignedOutPage title="Couldn’t check your session">
        <Alert tone="warning">{unconfigured ? 'Sign-in is not configured on this installation.' : `${productName} couldn’t verify your session.`}</Alert>
        <Button loading={identity.isFetching} onClick={() => void identity.refetch()}>Try again</Button>
      </SignedOutPage>}
  </SessionContext.Provider></ToastScope></RequestScopeContext.Provider></ApiContext.Provider>
}
// The installation's canonical address (lib/public-origin.ts), for examples and connection URLs: PUBLIC_URL from
// /v1/me when signed in, else from /health, never the page's own Host. null until known; foreign when the page is
// open at another address.
export function useCanonicalOrigin() {
  const identity = useContext(SessionContext)?.identity?.origin ?? null
  const instance = useQuery({ queryKey: ['instance-origin'], enabled: !identity, staleTime: Infinity, gcTime: Infinity, retry: 2,
    queryFn: async ({ signal }) => {
      const response = await fetch('/health', { signal, headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error('Couldn’t load this installation’s address.')
      return ((await response.json()) as { origin?: string }).origin ?? null
    } })
  // (Drawn at build time there is no window: the page is drawn at the installation's own address, features/docs/prerender.tsx.)
  const page = typeof window === 'undefined' ? instance.data ?? '' : window.location.origin
  return { ...canonicalOrigin({ identity, instance: instance.data, page }), error: identity ? null : instance.error, retry: () => void instance.refetch() }
}
export function usePublicOrigin(): string | null { return useCanonicalOrigin().origin }
export function useApi() {
  const api = useContext(ApiContext)
  if (!api) throw new Error('ApiProvider is required')
  return api
}
// Polling is opt-in and foreground-only; pass a function to poll only while the data is in progress.
// keepPrevious keeps the last result on screen while a changed key (page, search, filter) loads, so a list never blanks.
// Pass a function to keep it only for some key changes (a region change must not show the old region's rows).
type KeepPrevious = boolean | ((previousKey: readonly unknown[]) => boolean)
type Poll<T> = { interval?: number | ((data: T | undefined, failed: boolean) => number | false); retryInterval?: (error: unknown, failures: number) => number | false; enabled?: boolean; keepPrevious?: KeepPrevious; staleTime?: number }
/** Stops polling on 422 READ_TOO_LARGE / non-429 4xx; backs off exponentially on 429/5xx/network and stops after 3 retries. */
export function politePollInterval(base: number | false, error: unknown, consecutiveFailures: number): number | false {
  if (base === false) return false
  if (!error) return base
  if (error instanceof ApiError && (error.code === tooBroadCode || (error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 429))) return false
  if (consecutiveFailures >= 4) return false
  const floor = error instanceof ApiError && error.status === 429 ? 60_000 : base
  return Math.min(300_000, floor * 2 ** Math.max(0, consecutiveFailures))
}

export function useApiQuery<T>(key: readonly unknown[], read: (api: Api, signal: AbortSignal) => Promise<T>, poll?: Poll<T>) {
  const api = useApi()
  const scope = useRequestScope()
  const interval = poll?.interval
  const keep = poll?.keepPrevious
  const keyId = JSON.stringify(key)
  const failures = useRef({ key: keyId, count: 0 })
  if (failures.current.key !== keyId) failures.current = { key: keyId, count: 0 }
  return useQuery({ queryKey: ['nightmail', ...key], queryFn: async ({ signal }) => {
    if (!isCurrentScope(scope)) throw aborted()
    try {
      const data = await read(api, signal)
      if (!isCurrentScope(scope)) throw aborted()
      if (failures.current.key === keyId) failures.current.count = 0
      return data
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError') && failures.current.key === keyId) failures.current.count += 1
      throw error
    }
  }, enabled: poll?.enabled, ...(poll?.staleTime === undefined ? {} : { staleTime: poll.staleTime }), refetchInterval: query => {
    if (query.state.error && poll?.retryInterval) return poll.retryInterval(query.state.error, failures.current.count)
    const base = typeof interval === 'function' ? interval(query.state.data, query.state.status === 'error') : interval ?? false
    return politePollInterval(base, query.state.error, failures.current.count)
  }, refetchIntervalInBackground: false,
    placeholderData: keep ? (previous, previousQuery) => keep === true || (previousQuery && keep(previousQuery.queryKey.slice(1))) ? previous : undefined : undefined })
}
export function useApiDef<T>(query: QueryDef<T>, poll?: Poll<T>) { return useApiQuery(query.key, query.read, poll) }
/** `target`: what the write acts on when its function closes over it rather than taking it as input (a thread, a
 *  domain, a campaign). It keys the in-flight guard with the operation and input (lib/single-flight.ts). */
export function useApiMutation<TInput, TResult>(write: (api: Api, input: TInput) => Promise<TResult>, successMessage?: string, refreshSes = false, invalidate: InvalidationTarget<TInput, TResult> = true, target?: unknown) {
  const api = useApi()
  const scope = useRequestScope()
  const client = useQueryClient()
  const toast = useToast()
  // One write while it is in flight: a repeat of the same operation on the same target with the same input is dropped
  // (lib/single-flight.ts). The operation is the write's source, the same in every render.
  return useGuardedMutation({
    operation: write.toString(), target, requestScope: scope,
    gcTime: 0,
    mutationFn: async (input: TInput) => {
      if (!isCurrentScope(scope)) throw aborted()
      const result = await write(api, input)
      if (!isCurrentScope(scope)) throw aborted()
      return result
    },
    onSuccess: (result, input) => {
      if (!isCurrentScope(scope)) return
      if (successMessage) toast(successMessage, 'success')
      if (!invalidate) return
      if (invalidate === true) {
        void client.invalidateQueries({predicate: query => staleAfterWrite(query.queryKey, refreshSes)}).catch(() => {})
        if (!refreshSes) void client.invalidateQueries({predicate: query => query.queryKey[0] === 'nightmail' && resourceOf(query.queryKey) === 'campaign-options', refetchType: 'none'}).catch(() => {})
        return
      }
      const resources = typeof invalidate === 'function' ? invalidate(result, input) : invalidate
      void invalidateResources(client, resources).catch(() => {})
    },
  })
}

const RegionContext = createContext<{ regionId: string; setRegionId: (id: string) => void } | null>(null)
export function RegionProvider({ children }: { children: ReactNode }) {
  const [regionId, setRegion] = useState(() => {
    const linked = new URLSearchParams(window.location.search).get('region')
    if (linked && /^[a-z0-9-]{1,40}$/.test(linked)) return linked
    try { return localStorage.getItem('nightmail.region') || '' } catch { return '' }
  })
  function setRegionId(id: string) {
    setRegion(id)
    try { localStorage.setItem('nightmail.region', id) } catch { /* Selection can remain session-only. */ }
  }
  return <RegionContext.Provider value={{ regionId, setRegionId }}>{children}</RegionContext.Provider>
}
// Hosted workspaces send from a region the platform picks per sender, so they view every region at once:
// an empty region omits the filter from every request.
const allRegions = { regionId: '', setRegionId: () => {} }
export function useRegion() {
  const region = useContext(RegionContext)
  const multiTenant = useContext(SessionContext)?.identity?.multiTenant === true
  if (!region) throw new Error('RegionProvider is required')
  return multiTenant ? allRegions : region
}
