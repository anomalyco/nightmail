import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsFetching, useQuery } from '@tanstack/react-query'
import { Link, Navigate, useLocation, useNavigationType, useParams } from 'react-router'
import { Alert, EmptyState, ErrorState, Input, SkeletonText, SubNav, Tabs } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { useApiQuery, useCanonicalOrigin, useSession, useWorkspaceAccess } from '../../data/context'
import { AgentPromptPanel, agentPrompt, useAgentSetup } from './agent-setup'
import { guides, type Guide } from './guides'
import { SendingLimitsGuide } from '../score/limits'
import { DocsArticleSkeleton, useDocsAudience } from './frame'
import { openApiQuery } from './openapi'
import { docsTitle, operationDescription, operationEntries, tagTitle } from './meta'
import './docs.css'
import { dashboardReference } from '../../../../api/src/dashboard-reference'
import { productName, productSlug, publicOrigin, sdkPackage } from '../../../../api/src/brand'
import { useShellTakeover } from '../../lib/shell-takeover'
import { describeBody, resolveSchema, responseRows, schemaType, type Field } from '../../../../api/src/schema-fields'

type Schema = Record<string, any>
export type Operation = { id: string; method: string; path: string; tag: string; summary: string; description: string; permission?: string; parameters: Schema[]; requestBody?: Schema; responses: Record<string, Schema>; samples: {lang: string; label: string; source: string}[] }
type QuickstartStep = { title: string; text: string; code?: string }
export type Document = { info: {title: string; version: string; description?: string; 'x-quickstart'?: QuickstartStep[]}; tags?: {name: string}[]; paths: Record<string, Record<string, Schema>>; components?: {schemas?: Record<string, Schema>; parameters?: Record<string, Schema>} }
// What each operation needs, stated by the API (operation-permissions.ts).
const permissionExtension = `x-${productSlug}-permission`
// Examples are written for the hosted origin; this instance's own goes in their place, so a copied command works here.
const here = (code: string, origin: string) => code.replaceAll(publicOrigin, origin)

export function operations(document?: Document): Operation[] {
  if (!document) return []
  const result: Operation[] = operationEntries(document).map(({ operation, pathItem, ...entry }) => ({ ...entry, permission: operation[permissionExtension]?.text, parameters: [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])], requestBody: operation.requestBody, responses: operation.responses ?? {}, samples: operation['x-codeSamples'] ?? [] }))
  // Groups follow the document's tag order (Emails and Domains first); operations keep path order within a group.
  const order = (document.tags ?? []).map(tag => tag.name)
  const rank = (tag: string) => { const index = order.indexOf(tag); return index === -1 ? order.length : index }
  return result.map((operation, index) => ({ operation, index })).sort((a, b) => rank(a.operation.tag) - rank(b.operation.tag) || a.index - b.index).map(item => item.operation)
}

// The installation's canonical address (useCanonicalOrigin). The page renders its examples only once it is known, and
// never on another host, so every example below has it.
const DocsOrigin = createContext('')
const useDocsOrigin = () => useContext(DocsOrigin)
/** Shown instead of any example when the docs are open somewhere other than the installation's own address. */
function ForeignHost({ origin }: { origin: string }) {
  const page = window.location.host, canonical = new URL(origin).host
  return <article className="docs-operation docs-foreign"><Alert tone="danger" title={`This isn’t this ${productName} installation’s address`}>
    These docs are open at <strong>{page}</strong>, but this installation is at <strong>{canonical}</strong>. Examples, keys and agent setup are only shown at its own address, so nothing you copy sends a key somewhere else. <a href={`${origin}${window.location.pathname}${window.location.hash}`}>Open the docs at {canonical}</a>.
  </Alert></article>
}

function Quickstart({ steps }: { steps: QuickstartStep[] }) {
  const origin = useDocsOrigin()
  steps = steps.map(step => step.code ? { ...step, code: here(step.code, origin) } : step)
  return <section id="quickstart" className="docs-section docs-quickstart" aria-labelledby="docs-quickstart"><h2 id="docs-quickstart">Quickstart</h2>
    <ol>{steps.map(step => <li key={step.title}><strong>{step.title}.</strong> {step.text}
      {step.code && <div className="docs-quickstart-code"><pre className="docs-code" tabIndex={0}><code>{step.code}</code></pre><CopyAction value={step.code} label={`Copy ${step.title} example`} variant="ghost" size="sm" compact className="developer-copy-icon" /></div>}</li>)}</ol>
  </section>
}

// A body as schema-fields.ts describes it, which the API's Markdown copy lists the same way: its fields; each variant's,
// folded under its title with its fields named, so a long list reads as a short one; "No fields"; or its type.
function FieldList({ fields }: { fields: Field[] }) {
  return <div className="docs-field-list">{fields.map(({ path, type, required, description }) => <div className="docs-field" key={path}>
    <div><code>{path}</code>{required && <span className="docs-required">required</span>}<span className="docs-type">{type}</span></div>
    {description && <p>{description}</p>}
  </div>)}</div>
}
function SchemaDefinition({ document, input }: {document: Document; input: Schema}) {
  const body = describeBody(document, input)
  if (body.kind === 'value') return <div className="docs-schema-inline"><code>{body.name ?? body.type}</code>{body.description && <p>{body.description}</p>}</div>
  if (body.kind === 'empty') return <div className="docs-schema-inline docs-schema-empty"><span>No fields.</span>{body.description && <p>{body.description}</p>}</div>
  return <div className="docs-schema">
    {body.name && <code className="docs-schema-name">{body.name}</code>}
    {body.description && <p className="muted">{body.description}</p>}
    {body.kind === 'fields' ? <FieldList fields={body.fields} /> : <>
      <p className="muted">One of {body.variants.length}:</p>
      <div className="docs-variants">{body.variants.map(variant => <details key={variant.title}>
        <summary><code>{variant.title}</code><span>{variant.fields.filter(field => !field.path.includes('.')).map(field => field.path).join(', ')}</span></summary>
        {variant.description && <p>{variant.description}</p>}
        {variant.fields.length ? <FieldList fields={variant.fields} /> : <p>No fields.</p>}
      </details>)}</div>
    </>}
  </div>
}

function OperationPage({ document, operation: raw }: {document: Document; operation: Operation}) {
  const origin = useDocsOrigin()
  const operation = useMemo(() => ({ ...raw, samples: raw.samples.map(sample => ({ ...sample, source: here(sample.source, origin) })) }), [raw, origin])
  // The chosen language carries over to the next operation that has it.
  const [language, setLanguage] = useState(operation.samples[0]?.label ?? 'TypeScript SDK')
  const sample = operation.samples.find(item => item.label === language) ?? operation.samples[0]
  const body = operation.requestBody?.content?.['application/json']?.schema
  const parameters = operation.parameters.map(parameter => resolveSchema(document, parameter))
  // Statuses with the same description and body (the ten "Request failed" rows) are one row.
  const responses = useMemo(() => responseRows(operation.responses), [operation.responses])
  return <article className="docs-operation">
    <header className="docs-operation-header">
      <h1>{operation.summary}</h1>
      <div className="docs-endpoint"><span data-method={operation.method}>{operation.method}</span><code>{operation.path}</code><CopyAction value={operation.path} label="Copy endpoint path" variant="ghost" size="sm" compact className="developer-copy-icon" /></div>
      {operation.description && <p>{operation.description}</p>}
      {operation.permission && <p className="muted">{operation.permission}</p>}
    </header>
    {sample && <section className="docs-section" aria-labelledby="docs-example-title">
      <h2 id="docs-example-title">Example</h2>
      <div className="docs-example-bar"><Tabs label="Example language" value={sample.label} onValueChange={setLanguage} items={operation.samples.map(item => ({value: item.label, label: item.label}))} /><CopyAction key={`${operation.id}:${language}`} value={sample.source} label="Copy code example" variant="ghost" size="sm" compact className="developer-copy-icon" /></div>
      {/* Every language shares one cell, so switching tabs never changes the section's height. */}
      <div className="docs-example-panels">{operation.samples.map(item => <pre key={item.label} className="docs-code" tabIndex={0} aria-label={`${item.label} example`} data-active={item.label === sample.label || undefined} inert={item.label !== sample.label}><code>{item.source}</code></pre>)}</div>
    </section>}
    {parameters.length > 0 && <section className="docs-section"><h2>Parameters</h2><div className="docs-field-list">{parameters.map(parameter => <div className="docs-field" key={`${parameter.in}:${parameter.name}`}><div><code>{parameter.name}</code>{parameter.required && <span className="docs-required">required</span>}<span className="docs-type">{parameter.in} · {schemaType(document, parameter.schema)}</span></div>{parameter.description && <p>{parameter.description}</p>}</div>)}</div></section>}
    {body && <section className="docs-section"><h2>Request body</h2><SchemaDefinition document={document} input={body} /></section>}
    <section className="docs-section"><h2>Responses</h2><div className="docs-responses">{responses.map(({ statuses, description, schema }) => schema
      ? <details key={statuses[0]} open={statuses[0]!.startsWith('2')}><summary><code>{statuses.join(', ')}</code><span>{description}</span></summary><SchemaDefinition document={document} input={schema} /></details>
      : <div key={statuses[0]} className="docs-response"><code>{statuses.join(', ')}</code><span>{description}</span></div>)}</div></section>
  </article>
}

// Pages: /docs (the overview), /docs/<guide> and /docs/api/<operationId>. Overview sections keep anchors (#sending-limits).
const operationPath = (id: string) => `/docs/api/${encodeURIComponent(id)}`
export type Page = { kind: 'overview' } | { kind: 'guide'; guide: Guide } | { kind: 'operation'; id: string } | { kind: 'missing' }
export function pageOf(splat: string): Page {
  const parts = splat.split('/').filter(Boolean)
  if (!parts.length) return { kind: 'overview' }
  const guide = parts.length === 1 ? guides.find(item => item.id === parts[0]) : undefined
  if (guide) return { kind: 'guide', guide }
  return parts.length === 2 && parts[0] === 'api' ? { kind: 'operation', id: parts[1]! } : { kind: 'missing' }
}
const pathOf = (page: Page) => page.kind === 'guide' ? `/docs/${page.guide.id}` : page.kind === 'operation' ? operationPath(page.id) : '/docs'
function anchor(hash: string) { try { return decodeURIComponent(hash.slice(1)) } catch { return '' } }
// Guides under their names before a rename: rules were called rituals.
const renamedGuides: Record<string, string> = { rituals: 'rules' }
// Links from before the docs had pages of their own: /docs#guide-rituals, /docs#mcp and /docs#sendEmail.
export function legacyPath(hash: string, all: Operation[]): string | null {
  const id = anchor(hash)
  const replacement = dashboardReference.get(id)
  if (replacement) return replacement
  if (id === 'mcp') return '/docs/mcp'
  const named = id.startsWith('guide-') ? renamedGuides[id.slice('guide-'.length)] ?? id.slice('guide-'.length) : null
  if (named && guides.some(guide => guide.id === named)) return `/docs/${named}`
  // Operation IDs are camelCase; overview sections are kebab-case.
  return /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(id) || all.some(operation => operation.id === id) ? operationPath(id) : null
}

function GuidePage({ guide }: { guide: Guide }) {
  const index = guides.indexOf(guide), next = guides[index + 1]
  return <article className="docs-operation docs-guide">
    <header className="docs-operation-header"><span className="docs-eyebrow">Guide</span><h1>{guide.title}</h1><p>{guide.summary}</p></header>
    {guide.body()}
    <nav className="docs-section docs-guide-next" aria-label="More guides">{next ? <Link to={`/docs/${next.id}`}>Next: {next.title}</Link> : <Link to="/docs">Back to the overview</Link>}</nav>
  </article>
}
function MissingPage() {
  return <article className="docs-operation"><EmptyState headingAs="h1" title="Page not found" description="This page isn’t in the docs. It may have moved." action={<Link to="/docs">Open the overview</Link>} /></article>
}

// Workspace admins get a prompt with this workspace's domain; null while it loads.
// Members and signed-out readers get the general prompt, so they never call /v1/domains.
function useAgentPrompt() {
  const identity = useSession()?.identity
  const checkingSession = useIsFetching({ queryKey: ['identity'] }) > 0
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const withDomain = Boolean(identity) && canAdminister
  const origin = useDocsOrigin()
  const domains = useApiQuery(['domains', 'agent-prompt'], (api, signal) => api.domains.list({ page: 1, pageSize: 10, refresh: false }, signal), { enabled: withDomain })
  // An admin's copied prompt carries a setup token; everyone else's has the device flow.
  const setup = useAgentSetup(withDomain)
  if ((!identity && checkingSession) || (withDomain && domains.isPending)) return { prompt: null, setup }
  // Prefer a verified domain for the test send; any domain still gives the agent its DNS context.
  const items = domains.data?.items ?? []
  const domain = withDomain ? items.find(row => row.status === 'verified') ?? items[0] ?? null : undefined
  const promptFor = (setupToken: string | null | undefined) => agentPrompt({ origin, domain, email: identity?.email ?? null, multiTenant, setupToken })
  return { prompt: promptFor(setup ? null : undefined), setup, copy: setup?.copy(promptFor) }
}

// The first thing on the docs' first page: the prompt that hands the whole setup to a coding agent, with one Copy, as
// Get started shows it (AgentPromptPanel). An owner's or admin's copy carries a fresh setup token; everyone else's prompt
// connects with a device code.
function DocsAgentPrompt() {
  const { prompt, setup, copy } = useAgentPrompt()
  // Signed out there is no workspace: the prompt has this API's address and a device sign-in, nothing of an account.
  const signedIn = Boolean(useSession()?.identity)
  return <section id="agent-prompt" className="docs-section docs-agent-prompt" aria-labelledby="docs-agent-prompt" aria-busy={prompt === null || undefined}>
    <h2 id="docs-agent-prompt">Set up with your agent</h2>
    <p className="muted">{signedIn ? 'Paste this prompt into your coding agent. It has this workspace’s real values; the API key stays in your environment.' : 'Paste this prompt into your coding agent. It has this API’s address, and the key your agent gets stays in your environment.'}</p>
    <AgentPromptPanel value={setup && copy ? copy : prompt ?? ''} preview={prompt ?? ''} pending={prompt === null} setup={setup} line="It connects with a device code: an owner or admin approves it." />
  </section>
}

function DocsOverview({ document, all }: {document: Document; all: Operation[]}) {
  const groups = [...new Set(all.map(operation => operation.tag))]
  const install = `npm install ${sdkPackage}`
  return <article className="docs-operation docs-overview">
    <header className="docs-operation-header"><h1>{productName} API</h1><p>{document.info.description}</p></header>
    <DocsAgentPrompt />
    {document.info['x-quickstart']?.length ? <Quickstart steps={document.info['x-quickstart']} /> : null}
    <section id="guides" className="docs-section" aria-labelledby="docs-guides"><h2 id="docs-guides">Guides</h2><div className="docs-resource-list">
      {guides.map(guide => <Link key={guide.id} to={`/docs/${guide.id}`}><strong>{guide.title}</strong><span>{guide.summary}</span></Link>)}
    </div></section>
    <section id="sdk" className="docs-section"><h2>TypeScript SDK</h2><p className="muted">Generated client and types, <a href={`https://www.npmjs.com/package/${sdkPackage}`}>published on npm</a>. Call it from a trusted server with an API key.</p><div className="docs-install"><code>{install}</code><CopyAction value={install} label="Copy install command" variant="ghost" size="sm" compact className="developer-copy-icon" /></div></section>
    <section id="formats" className="docs-section"><h2>Documentation formats</h2><div className="docs-resource-list">
      <a href="/docs.md"><strong>Markdown reference</strong><span>API index for agents and text tools, with a complete reference per tag.</span></a>
      <a href="/llms.txt"><strong>Agent index</strong><span>Canonical links to every focused operation page.</span></a>
      <a href="/openapi.json"><strong>OpenAPI 3.1</strong><span>Machine-readable schemas and generated code examples.</span></a>
    </div></section>
    <section id="sending-limits" className="docs-section" aria-labelledby="sending-limits-title"><h2 id="sending-limits-title">How sending limits work</h2><SendingLimitsGuide /></section>
    <section id="operations" className="docs-section"><h2 className="docs-section-heading">API operations<span>{all.length}</span></h2>
      <div className="docs-overview-groups">{groups.map(group => <section key={group}><h3>{tagTitle(group)}<span>{all.filter(operation => operation.tag === group).length}</span></h3><div>{all.filter(operation => operation.tag === group).map(operation => <Link key={operation.id} to={operationPath(operation.id)}><span data-method={operation.method}>{operation.method}</span><span>{operation.summary}</span><code>{operation.path}</code></Link>)}</div></section>)}</div>
    </section>
  </article>
}

// The tab's title and the description search results and link previews read, per page (meta.ts): the same as the
// page's own HTML carries (app/site-pages.ts).
const defaultDescription = typeof window === 'undefined' ? '' : window.document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? ''
function useDocumentMeta(title: string, description: string) {
  useEffect(() => {
    window.document.title = title
    window.document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', description)
  }, [title, description])
  useEffect(() => () => window.document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', defaultDescription), [])
}
// A new page opens at its top, or at the section its link names once that section has rendered. Back and Forward
// leave scrolling to the dashboard (or the browser), which restores where that page was left. A page that takes over
// from the one painted before the app (painted) stays where the reader has it: that one opened at the section itself.
function useAnchorScroll(ready: boolean, painted: boolean) {
  const location = useLocation(), navigationType = useNavigationType()
  const landed = useRef(false)
  useEffect(() => {
    if (!ready) return
    const first = !landed.current
    landed.current = true
    if ((navigationType === 'POP' && !first) || (first && painted)) return
    const id = anchor(location.hash)
    const target = id ? window.document.getElementById(id) : null
    if (target) target.scrollIntoView({ block: 'start' })
    else if (!first) window.scrollTo(0, 0)
  }, [location.key, ready])
}

export function DocsPage() {
  const site = useCanonicalOrigin()
  const query = useQuery(openApiQuery)
  const spec = query.data as Document | undefined
  const all = useMemo(() => operations(spec), [spec])
  const location = useLocation()
  const splat = useParams()['*'] ?? '', page = pageOf(splat)
  const inShell = useDocsAudience() === 'shell'
  const current = page.kind === 'operation' ? all.find(operation => operation.id === page.id) : undefined
  const missing = page.kind === 'missing' || (page.kind === 'operation' && Boolean(spec) && !current)
  const title = missing ? 'Page not found' : page.kind === 'guide' ? page.guide.title : page.kind === 'operation' ? current?.summary ?? 'API reference' : `${productName} API`
  const description = page.kind === 'guide' ? page.guide.summary : current ? operationDescription(current) : spec?.info.description ?? defaultDescription
  useDocumentMeta(docsTitle(page.kind === 'overview' ? null : title), description)
  // A docs page's own file paints it for a visitor before this code (app/site-pages.ts, prerender.tsx): this page takes
  // its place once it has what it shows: the API definition, this installation's address, and the session check's answer
  // (a visitor's agent prompt and settings are drawn only once it's in: useAgentPrompt, MailServers).
  const checking = useIsFetching({ queryKey: ['identity'] }) > 0
  const painted = useShellTakeover('page-shell', '#root .docs-page', (Boolean(spec) && Boolean(site.origin) && !checking) || site.foreign)
  useAnchorScroll(Boolean(site.origin) && (page.kind === 'guide' || missing || Boolean(spec)), painted)
  const legacy = page.kind === 'overview' && location.hash ? legacyPath(location.hash, all) : null
  if (legacy) return <Navigate replace to={legacy} />
  const replacement = page.kind === 'operation' && dashboardReference.get(page.id)
  if (replacement) return <Navigate replace to={replacement} />
  const renamed = renamedGuides[splat.replace(/\/$/, '')]
  if (renamed) return <Navigate replace to={`/docs/${renamed}${location.hash}`} />
  return <DocsView spec={spec} all={all} page={page} missing={missing} title={title} site={site} inShell={inShell} pending={query.isPending} error={query.isError ? query.error : null} retry={() => query.refetch()} />
}

/** A docs page as the app draws it once it has the API definition and this installation's address: the contents beside
 *  the page. DocsPage draws it in the app, and prerender.tsx at build time, where a reference page is painted for a
 *  visitor before the app's code (app/site-pages.ts). */
export function DocsView({ spec, all, page, missing, title, site, inShell, pending, error, retry }: {
  spec?: Document; all: Operation[]; page: Page; missing: boolean; title: string; site: { origin: string | null; foreign: boolean; error?: unknown; retry?: () => void }
  inShell: boolean; pending: boolean; error: unknown; retry: () => void
}) {
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const filtered = q ? all.filter(operation => `${operation.id} ${operation.summary} ${operation.path} ${operation.tag}`.toLowerCase().includes(q)) : all
  const groups = [...new Set(filtered.map(operation => operation.tag))]
  const shownGuides = q ? guides.filter(item => `${item.title} ${item.summary}`.toLowerCase().includes(q)) : guides
  const active = pathOf(page)
  const current = page.kind === 'operation' ? all.find(operation => operation.id === page.id) : undefined
  // The contents keep the open page in view: a deep link to an operation far down the list shows where it is, from the
  // first frame (a painted page's contents are kept so too: home/shell/boot.js, data-shell-reveal).
  const contents = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const box = contents.current, item = box?.querySelector('[aria-current="page"]')
    if (!box || !item) return
    const outer = box.getBoundingClientRect(), inner = item.getBoundingClientRect()
    if (inner.top < outer.top || inner.bottom > outer.bottom - 24) box.scrollTop += inner.top - outer.top - outer.height / 3
  }, [active, all.length])
  // The contents list what the search matches; the phone's picker always lists every page.
  const item = (to: string, label: string, method?: string) => ({ to, label, current: active === to, ...method && { lead: <span data-method={method}>{method}</span>, text: `${method.toUpperCase()} ${label}` } })
  const guideItems = (list: Guide[], overview: boolean) => [...overview ? [item('/docs', 'Overview and quickstart')] : [], ...list.map(guide => item(`/docs/${guide.id}`, guide.title))]
  const operationGroups = (list: Operation[]) => [...new Set(list.map(operation => operation.tag))].map(group => ({ title: tagTitle(group), items: list.filter(operation => operation.tag === group).map(operation => item(operationPath(operation.id), operation.summary, operation.method)) }))
  const shownGroups = [...shownGuides.length ? [{ title: 'Guides', items: guideItems(shownGuides, !q) }] : [], ...pending ? [] : operationGroups(filtered)]
  return <SubNav className="docs-frame" title="Docs" titleAs="div" label="Guides and API operations" main={inShell ? 'div' : 'main'} scrollRef={contents} fallback={title}
    top={<Input type="search" aria-label="Search the documentation" placeholder="Search guides and API" value={search} onChange={event => setSearch(event.target.value)} />}
    groups={shownGroups} pickerGroups={[{ title: 'Guides', items: guideItems(guides, true) }, ...operationGroups(all)]}
    after={pending ? <div className="stack docs-nav-loading"><SkeletonText /><SkeletonText /><SkeletonText /></div> : !groups.length && q && !shownGuides.length ? <p className="muted docs-nav-empty">Nothing matches.</p> : null}>
    {site.foreign && site.origin ? <ForeignHost origin={site.origin} /> : !site.origin ? (site.error ? <ErrorState error={site.error} onRetry={site.retry} /> : <DocsArticleSkeleton />) : <DocsOrigin.Provider value={site.origin}>{missing ? <MissingPage /> : page.kind === 'guide' ? <GuidePage guide={page.guide} /> : error ? <ErrorState error={error} onRetry={retry} /> : !spec ? <DocsArticleSkeleton /> : current ? <OperationPage document={spec} operation={current} /> : <DocsOverview document={spec} all={all} />}</DocsOrigin.Provider>}
  </SubNav>
}
