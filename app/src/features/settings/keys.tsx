import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Button, Checkbox, PageHeader, SecretDialog, Tabs } from '../../components/ui'
import { useApiDef, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { AdminOnlyPage } from './admin-only'
import { KeySendExample } from '../docs/first-send'
import { CreateKeyDialog, useDomainOptions, type CreatedSecret, type Purpose } from './create-key'
import { keyTypes, type KeyTypeFilter } from './skeletons'
import './api-keys.css'
import { ConnectAgentButton, ConnectAgentDialog, McpKeySetup } from '../docs/connect-agent'
import { MailSettings, useMailServers } from '../docs/mail-settings'
import { KeyTable } from './key-table'
import { apiKeyEnv } from '../../../../api/src/brand'

export function ApiKeysPage() {
  // /api-keys?connect=1 (from Overview and Docs) opens Connect your agent. Members connect one as themselves too, so
  // their locked page keeps the button.
  const [connectLink] = useState(() => new URLSearchParams(window.location.search).has('connect'))
  return useWorkspaceAccess().canAdminister ? <ApiKeys connectLink={connectLink} /> : <AdminOnlyPage title="API keys" button="Create key" actions={<ConnectAgentButton initiallyOpen={connectLink} />} />
}
function ApiKeys({ connectLink }: { connectLink: boolean }) {
  const [showRevoked, setShowRevoked] = useState(false)
  const [type, setType] = useState<KeyTypeFilter>('all')
  // Counts only (which types have any): the list itself is KeyTable's.
  // Placeholder counts while Show inactive refetches: the tabs never lose a type (and KeyTable its tab) in between.
  const keys = useApiDef(queries.keys(undefined, showRevoked), { keepPrevious: true })
  const agents = useApiDef(queries.agents(showRevoked), { keepPrevious: true })
  const passwords = useApiDef(queries.appPasswords())
  // /api-keys?create=send&domain=acme.com opens Create key on an API key, filled in (Overview's setup step links here),
  // /api-keys?create=smtp on an SMTP login and /api-keys?create=app on an app password (onboarding's inbox for myself
  // links there); the parameters then leave the URL, so Back and reload don't open it again. A link followed while the
  // page is open (⌘K's New API key) opens the form the same way; Create key opens it from the start.
  const [params, setParams] = useSearchParams()
  const mailServers = useMailServers()
  const linked = (params: URLSearchParams) => {
    if (!params.has('create')) return undefined
    // Without a mail gateway an SMTP login could never sign in: the link opens the key types instead.
    if (params.get('create') === 'smtp') return mailServers ? { smtp: true } : {}
    if (params.get('create') === 'app') return { app: true }
    const asked = params.get('create') === 'inbound' ? 'addresses' : params.get('create')
    return { purpose: (['send', 'read_send', 'read', 'manage', 'addresses', 'inbox', 'create'] as Purpose[]).find(value => value === asked) ?? 'send', domain: params.get('domain') || undefined }
  }
  const [initial, setInitial] = useState(() => linked(params))
  const [open, setOpen] = useState(Boolean(initial))
  // Warm domains while on API keys so Create key opens directly to the API key form without shifting as domains land.
  const createDomains = useDomainOptions(true)
  const [connecting, setConnecting] = useState(connectLink)
  useEffect(() => {
    if (!params.has('create')) return
    setInitial(linked(params)); setOpen(true)
    setParams(previous => { const next = new URLSearchParams(previous); next.delete('create'); next.delete('domain'); return next }, { replace: true })
  }, [params, setParams]) // eslint-disable-line react-hooks/exhaustive-deps
  const [secret, setSecret] = useState<CreatedSecret | null>(null)

  // Hide empty credential-type tabs once counts arrive; keep a tab if its read failed so the user can retry it.
  const countsReady = !keys.isPending && !agents.isPending && !passwords.isPending
  const nonEmpty = keyTypes.filter(item => item.value !== 'all' && (
    item.value === 'api' ? Boolean(keys.error || keys.data?.length)
      : item.value === 'agent' ? Boolean(agents.error || agents.data?.length)
      : Boolean(passwords.error || passwords.data?.length)
  ))
  const visibleTabs = !countsReady ? [...keyTypes].filter(item => item.value !== 'app') : nonEmpty.length > 1 ? [keyTypes[0], ...nonEmpty] : []
  const activeType: KeyTypeFilter = visibleTabs.some(item => item.value === type) ? type : 'all'

  return <div className="stack">
    <PageHeader title="API keys" actions={<Button variant="primary" onClick={() => { setInitial(undefined); setOpen(true) }} data-analytics="keys/create">Create key</Button>} />
    <div className="keys-sections">
      <section className="section stack" aria-label="Keys">
        <div className="data-toolbar keys-toolbar">
          {visibleTabs.length > 0 && <Tabs label="Type" value={activeType} disabled={!countsReady} onValueChange={value => setType(value as KeyTypeFilter)} items={visibleTabs} />}
          <div className="keys-inactive"><Checkbox label="Show inactive" checked={showRevoked} onCheckedChange={setShowRevoked} /></div>
        </div>
        {/* A tab is its own visit: its table remounts on one, so it starts on the first page with no dialog open. */}
        <KeyTable key={`${activeType}:${showRevoked}`} type={activeType} showRevoked={showRevoked} onConnectAgent={() => setConnecting(true)} />
      </section>
    </div>
    {open && !createDomains.isPending && <CreateKeyDialog open onOpenChange={setOpen} initial={initial} onCreated={setSecret} />}
    <ConnectAgentDialog open={connecting} onOpenChange={setConnecting} />
    <SecretDialog secret={secret?.secret ?? null} title={secret?.title ?? 'Key created'} description={secret?.description} onClose={() => setSecret(null)}>{secret?.sendExample && <KeySendExample apiKey={secret.secret} />}{secret?.agent && <McpKeySetup secret={secret.secret} env={apiKeyEnv} />}{secret?.mail && <MailSettings username={secret.mail.username} imap={secret.mail.imap} smtp={secret.mail.smtp} />}</SecretDialog>
  </div>
}
