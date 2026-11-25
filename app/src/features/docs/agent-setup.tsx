import { useState, type ReactNode } from 'react'
import { Check, Download } from 'lucide-react'
import { SectionHeader } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { PrivateAddress } from '../../components/PrivateAddress'
import { isMailbox } from '../../lib/private-address'
import { useApiQuery } from '../../data/context'
import { request } from '../../data/live'
import { errorText, type Domain } from '../../data/types'
import { recordsFor } from '../settings/domain-records'
import { McpSignInSetup } from './connect-agent'
import './developer.css'
import { apiKeyEnv, productName, productSlug, sdkPackage, secretPrefixes } from '../../../../api/src/brand'

function receivingMx(domain: Domain) {
  const record = recordsFor(domain, 'receiving').find(row => row.type === 'MX')
  const match = record?.value.match(/^(\d+)\s+(\S+)$/)
  return record ? { name: record.name, host: match ? match[2] : record.value, priority: match ? match[1] : '10' } : null
}

/** What the prompt says in place of the setup token until it is copied, when copying adds one. */
export const setupTokenPlaceholder = `${secretPrefixes.agentSetup}… (added when you copy this prompt)`
// The agent's own API key (api/src/agent-setup.ts): from the setup token a copy carries, else the device flow, which an
// owner or admin approves at /connect.
function keyLines(origin: string, token: string | null | undefined) {
  const device = `POST ${origin}/v1/agent/device (JSON body {"client_name":"<your name>"}), show me its verification_uri_complete and user_code, then poll POST ${origin}/v1/agent/device/token with {"device_code":"<device_code>"} every interval seconds until it returns the key (AUTHORIZATION_PENDING means keep waiting).`
  const keep = `Save the key it returns as ${apiKeyEnv} in the project's environment (a gitignored .env), never in code or a commit; it's shown once. It sends email and manages domains, inboxes and receiving; it can't create API keys, inbox connection keys, inbox keys or mail-client (IMAP/SMTP) passwords, and can't manage members or billing.`
  if (token === undefined) return [`- No ${apiKeyEnv} yet? Get your own key with a device code: ${device} ${keep}`]
  return [
    `- Get your own API key first: exchange this one-time setup token (it works once, for 15 minutes) with POST ${origin}/v1/agent/setup and the JSON body {"token":"${token ?? setupTokenPlaceholder}"}. ${keep}`,
    `- If the setup token was already used or has expired, use a device code instead: ${device}`,
  ]
}

// domain is undefined when the reader is signed out and the workspace's domains are unknown. setupToken: the token a
// copy carries, null for its placeholder (the prompt as shown before copying), undefined for a prompt without one.
// testSender: the shared test sender (GET /v1/me), offered until a domain is verified so an agent can send a first email at once.
export function agentPrompt({ origin, domain, email, multiTenant, setupToken, testSender }: { origin: string; domain: Domain | null | undefined; email: string | null; multiTenant: boolean; setupToken?: string | null; testSender?: { address: string; perDay: number } | null }) {
  const lines = [
    `Set up ${productName} email in this project.`,
    '',
    `- API base URL: ${origin}`,
    ...keyLines(origin, setupToken),
    `- Read the docs first: ${origin}/llms.txt (agent-readable index) and ${origin}/docs.md (API reference index; each tag links its full Markdown reference).`,
    `- Install the TypeScript SDK: npm i ${sdkPackage}. Create the client with createClient from '${sdkPackage}/client' (baseUrl ${origin}) and call it from server code only.`,
    `- Auth: bearer API key from the ${apiKeyEnv} environment variable. Never hardcode it or ship it to a browser.`,
  ]
  if (domain === undefined) {
    lines.push(`- Sending domain: use a verified domain from Domains in the ${productName} dashboard. Ask me which one before sending.`)
    return lines.join('\n')
  }
  const test = testSender && email ? `- Until a domain is verified, send a test to ${email} from ${testSender.address}, the shared test sender, with sendEmail (POST /v1/emails/send) and an Idempotency-Key header: it sends to my own address only, at most ${testSender.perDay} a day, without fromName, replyTo or attachments. 202 means queued, not delivered.` : null
  if (!domain) {
    lines.push(`- Sending domain: none yet. Ask me to add one under Domains in the ${productName} dashboard before sending${test ? ' to anyone else' : ''}.`)
    if (test) lines.push(test)
    return lines.join('\n')
  }
  const verified = domain.status === 'verified'
  const to = email ?? 'an address I control (ask me which)'
  lines.push(
    `- Sending domain: ${domain.name} (${multiTenant ? '' : `region ${domain.regionId}, `}status: ${verified ? 'verified' : 'pending; its DNS records verify automatically, and sending works once verified'}).`,
    `- Send a test email from hello@${domain.name} to ${to} with sendEmail (POST /v1/emails/send)${multiTenant ? '' : `, region "${domain.regionId}"`} and an Idempotency-Key header. 202 means queued, not delivered.`,
  )
  if (!verified && test) lines.push(test)
  const mx = receivingMx(domain)
  // Hosted suggests reply.<domain>; never tell an agent to change the root MX, which would move the domain's existing mail.
  if (mx) lines.push(multiTenant
    ? `- Receiving (optional, only if I ask for it): add an MX record on ${mx.name} pointing to ${mx.host} (priority ${mx.priority}); receiving turns on automatically once it resolves.${mx.name === domain.name ? '' : ` Don't change the MX records of ${domain.name} itself: that would move its existing mailboxes to ${productName}.`}`
    : `- Receiving: enable it with POST /v1/inbound/domains/${domain.id}/enable, then point the MX record for ${mx.name} to ${mx.host} (priority ${mx.priority}).`)
  lines.push('- Inbound mail arrives as message.received webhooks (subscribe with POST /v1/inbound/webhooks); fetch full messages with GET /v1/inbound/messages/{messageId}.')
  return lines.join('\n')
}

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
/** Code or prose that holds mailbox addresses: each one goes through PrivateAddress, so it is blurred until hovered or
 * focused (and shown when privacy mode is off). Copy buttons keep copying the plain text, in full. */
export function MaskedText({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let from = 0
  for (const match of text.matchAll(ADDRESS)) {
    if (!isMailbox(match[0])) continue
    if (match.index > from) parts.push(text.slice(from, match.index))
    parts.push(<PrivateAddress key={match.index} value={match[0]} />)
    from = match.index + match[0].length
  }
  parts.push(text.slice(from))
  return <>{parts}</>
}

// A data URL needs no object URL to revoke, so the download can't race the cleanup.
function downloadText(name: string, text: string) {
  Object.assign(document.createElement('a'), { href: `data:text/plain;charset=utf-8,${encodeURIComponent(text + '\n')}`, download: name }).click()
}

type SetupStatus = { id: string; status: 'waiting' | 'connected' | 'expired' | 'replaced'; keyName: string | null }
export type AgentSetupState = 'idle' | SetupStatus['status'] | 'failed'
export type AgentSetup = { state: AgentSetupState; keyName: string | null; error: unknown;
  /** Copy's value for a prompt: a fresh setup token in it each time. Without one (the mint failed), the prompt's device flow. */
  copy: (prompt: (token: string | undefined) => string) => () => Promise<string> }

/**
 * The setup token a copied prompt carries (api/src/agent-setup.ts), for an owner or admin: each copy mints one, which
 * replaces their unused one, and the newest is watched until the agent exchanges it, so the prompt can say it connected.
 * Null for everyone else, whose prompt has the device flow instead.
 */
export function useAgentSetup(enabled: boolean): AgentSetup | null {
  const [minted, setMinted] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const watched = useApiQuery(['agent-setup', minted ?? ''], (_api, signal) => request<SetupStatus>(`/v1/agent/setup-tokens/${encodeURIComponent(minted!)}`, { signal }),
    { enabled: enabled && minted !== null, interval: data => !data || data.status === 'waiting' ? 3000 : false })
  if (!enabled) return null
  const status = minted && watched.data?.id === minted ? watched.data : null
  return { state: error ? 'failed' : !minted ? 'idle' : status?.status ?? 'waiting', keyName: status?.keyName ?? null, error,
    copy: prompt => async () => {
      try {
        const made = await request<{ id: string; token: string }>('/v1/agent/setup-tokens', { method: 'POST' })
        setMinted(made.id); setError(null)
        return prompt(made.token)
      } catch (failure) { setError(failure); return prompt(undefined) }
    } }
}

// Every state is laid out in one cell, so the line never changes the section's height.
const sampleKey = 'Agent (set up 0000-00-00)'
const setupLines: Record<AgentSetupState, (keyName: string) => ReactNode> = {
  idle: () => 'Copying adds a one-time setup token, so your agent gets its own API key. Revoke it any time under API keys.',
  waiting: () => 'Waiting for your agent to use the setup token. It works once, for 15 minutes.',
  connected: keyName => <>Your agent connected. Its key is <strong>{keyName}</strong>, under API keys.</>,
  expired: () => 'The setup token expired before your agent used it. Copy the prompt again for a new one.',
  replaced: () => 'A newer copy replaced this setup token. Use the prompt you copied last.',
  failed: () => 'Couldn’t add a setup token, so the copied prompt connects with a device code instead.',
}
export function AgentSetupStatus({ setup }: { setup: AgentSetup }) {
  const { state } = setup, keyName = setup.keyName ?? sampleKey
  return <div className="agent-setup-status" data-state={state}>
    {(Object.keys(setupLines) as AgentSetupState[]).map(key => <p key={key} data-state={key} data-active={key === state || undefined} aria-hidden={key !== state || undefined}>
      {(key === 'connected' || key === 'waiting') && <span className="agent-setup-status__mark" aria-hidden="true">{key === 'connected' ? <Check size={14} strokeWidth={2.5} /> : <span className="connect-agent__pulse" />}</span>}
      <span>{setupLines[key](key === state ? keyName : sampleKey)}</span>
    </p>)}
    <span className="sr-only" role="status">{state === 'idle' ? '' : state === 'connected' ? `Your agent connected. Its key is ${keyName}.` : state === 'failed' ? `Couldn’t add a setup token: ${errorText(setup.error)}` : String(setupLines[state](keyName))}</span>
  </div>
}

// A null prompt is still loading: the section keeps its place and its actions stay hidden. `compact` (onboarding) is the
// prompt and its actions without the docs' paragraph on how to use it. With `setup` (an owner or admin), copying puts a
// fresh setup token in the prompt (`copy` makes it), and the line above it says when the agent used it. A download never
// has one, so no live credential lands in a file: it is `download`, the prompt with the device flow instead.
export function AgentPrompt({ prompt, compact = false, setup, copy, download }: { prompt: string | null; compact?: boolean; setup?: AgentSetup | null; copy?: () => Promise<string>; download?: string }) {
  const value = setup && copy ? copy : prompt ?? ''
  return <section id="agent-prompt" className="section stack developer-section" aria-label="Agent prompt" aria-busy={prompt === null || undefined}>
    <SectionHeader title="Agent prompt" actions={<span className="developer-icon-actions" data-pending={prompt === null || undefined} inert={prompt === null}>
      <button type="button" className="ui-button ui-button--ghost ui-button--sm developer-copy-icon" aria-label="Download agent prompt as .txt" title="Download as .txt" onClick={() => downloadText(`${productSlug}-agent-prompt.txt`, download ?? prompt ?? '')}><Download size={14} aria-hidden="true" /></button>
      <CopyAction value={value} label="Copy agent prompt" variant="ghost" size="sm" compact className="developer-copy-icon" />
    </span>} />
    {!compact && <p className="muted developer-copy">Paste this into your coding agent, or download it as a .txt file for it to read. It has this workspace’s real values; the API key stays in your environment.</p>}
    {setup && <AgentSetupStatus setup={setup} />}
    <pre className="developer-code developer-code--prompt" tabIndex={0} aria-label="Agent prompt"><code><MaskedText text={prompt ?? ''} /></code></pre>
  </section>
}

// The hosted MCP server, set up as you: the same URL and one-line setups as Connect an agent (connect-agent.tsx).
// `compact` (onboarding) is the setup alone, without the docs' lead line.
export function McpSetup({ compact = false }: { compact?: boolean }) {
  return <section id="mcp" className="section stack developer-section" aria-label="MCP server">
    <SectionHeader title="MCP server" />
    {!compact && <p className="muted developer-copy">Add this URL as a remote (HTTP) server in your MCP client.</p>}
    <McpSignInSetup />
  </section>
}
