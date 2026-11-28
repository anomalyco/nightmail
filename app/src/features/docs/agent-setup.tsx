import { useEffect, useRef, useState, type ReactNode, type UIEvent } from 'react'
import { Check } from 'lucide-react'
import { SectionHeader } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { PrivateAddress } from '../../components/PrivateAddress'
import { isMailbox } from '../../lib/private-address'
import { useApiQuery, useRequestScope } from '../../data/context'
import { request } from '../../data/live'
import { errorText, type Domain } from '../../data/types'
import { recordsFor } from '../settings/domain-records'
import { McpSignInSetup } from './connect-agent'
import { mcpServerUrl } from '../../../../api/src/mcp-clients'
import './developer.css'
import { apiKeyEnv, productName, sdkPackage, secretPrefixes } from '../../../../api/src/brand'
import { builtinLimitsText } from '../../../../api/src/builtin-limits'
import { ATTACHMENT_LIMITS_TEXT, ATTACHMENT_RULES_TEXT } from '../../../../api/src/attachment-limits'

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
  const device = (body: string) => `POST ${origin}/v1/agent/device (JSON body ${body}), then show me its verification_uri_complete link on its own line and tell me to open it and approve you, with its user_code; poll POST ${origin}/v1/agent/device/token with {"device_code":"<device_code>"} every interval seconds until it returns the key (AUTHORIZATION_PENDING means keep waiting, and show me the link again if I haven't approved).`
  const keep = `Save the key it returns as ${apiKeyEnv} in the project's environment (a gitignored .env), never in code or a commit; it's shown once. It sends email and manages domains, inboxes and receiving; it can't create API keys, inbox connection keys, inbox keys or mail-client (IMAP/SMTP) passwords, and can't manage members or billing.`
  if (token === undefined) return [`- No ${apiKeyEnv} yet? Get your own key with a device code: ${device('{"client_name":"<your name>"}')} ${keep}`]
  return [
    `- Get your own API key first: exchange this one-time setup token (it works once, for 15 minutes) with POST ${origin}/v1/agent/setup and the JSON body {"token":"${token ?? setupTokenPlaceholder}","client_name":"<your name>"}. ${keep}`,
    `- If the setup token has expired or was replaced, ask me for a fresh copy of this prompt: that's quickest. Its refusal also carries a device code (error.details[0]): show me its link on its own line and poll it. If it was already used and you don't have the key, get a device code: ${device(`{"client_name":"<your name>","setup_token":"${token ?? setupTokenPlaceholder}"}`)}`,
  ]
}

// domain is undefined when the reader is signed out and the workspace's domains are unknown. setupToken: the token a
// copy carries, null for its placeholder (the prompt as shown before copying), undefined for a prompt without one.
// One line in each agent prompt: an agent that hit friction tells us (api/src/feedback.ts), then carries on.
const feedbackLine = `- If something in ${productName} gets in your way, report it with sendFeedback (POST /v1/feedback): say what would have made it easier, then carry on.`
export function agentPrompt({ origin, domain, email, multiTenant, setupToken }: { origin: string; domain: Domain | null | undefined; email: string | null; multiTenant: boolean; setupToken?: string | null }) {
  const lines = [
    `Set up ${productName} email in this project.`,
    '',
    `- API base URL: ${origin}`,
    ...keyLines(origin, setupToken),
    `- Read the docs first: ${origin}/llms.txt (agent-readable index) and ${origin}/docs.md (API reference index; each tag links its full Markdown reference).`,
    `- TypeScript/Node: install ${sdkPackage} (npm i ${sdkPackage}), create the client with createClient from '${sdkPackage}/client' (baseUrl ${origin}), and call it from server code only. Other languages (Rust, Python, Go, etc.): call the HTTP API directly using ${origin}/openapi.json, and send an application User-Agent header (avoid default script User-Agents like Python-urllib).`,
    `- Auth: bearer API key from the ${apiKeyEnv} environment variable. Never hardcode it or ship it to a browser.`,
    // The attachment rules up front, so the agent doesn't find them one refused upload or send at a time.
    `- Attachments: ${ATTACHMENT_LIMITS_TEXT} ${ATTACHMENT_RULES_TEXT} A refusal names every attachment problem at once, in error.details.`,
    feedbackLine,
  ]
  if (domain === undefined) {
    lines.push(`- Sending domain: use a verified domain from Domains in the ${productName} dashboard. Ask me which one before sending.`)
    return lines.join('\n')
  }
  if (!domain) {
    lines.push(`- Sending domain: none yet. Ask me to add one under Domains in the ${productName} dashboard before sending.`)
    return lines.join('\n')
  }
  const verified = domain.status === 'verified'
  // The built-in domain sending to members only: the first email goes to my own sign-in address, never one I'd pick.
  const membersOnly = domain.builtIn && domain.limits?.scope === 'members'
  const to = email ?? (membersOnly ? `the email address I sign in to ${productName} with (ask me which)` : 'an address I control (ask me which)')
  lines.push(
    // A new workspace's built-in domain sends from its first moment: a send while it finishes setting up waits for it.
    `- Sending domain: ${domain.name} (${multiTenant ? '' : `region ${domain.regionId}, `}${domain.builtIn ? 'built-in: it needs no DNS and sends now; a send in its first seconds waits while it finishes setting up' : `status: ${verified ? 'verified' : `pending; its DNS records are in GET /v1/domains/${domain.id} (dns: each record's name, type, value and status): publish them at the DNS provider (or ask me to), then POST /v1/domains/${domain.id}/verify checks them now. They also verify automatically, and sending works once verified. One-click DNS setup is mine to do in the dashboard`}`}}).`,
    `- Send a first email from hello@${domain.name} to ${to} with sendEmail (POST /v1/emails/send)${multiTenant ? '' : `, region "${domain.regionId}"`} and an Idempotency-Key header. Give it a short, real subject and plain text: "test" or placeholder words in either send it to spam. 202 means queued, not delivered.`,
  )
  // The built-in domain's limits up front, so the agent doesn't find them one refused send at a time.
  if (domain.builtIn) lines.push(`- ${domain.name} is this workspace's built-in domain. ${domain.limits?.summary ?? builtinLimitsText()} ${membersOnly ? 'Send only to the sign-in addresses of people in this workspace; anyone else is refused with 422 BUILTIN_DOMAIN_RECIPIENT, so ask me to add our own domain before emailing anyone else. ' : ''}A send that uses any of the other limits is refused once with 422 BUILTIN_DOMAIN_UNSUPPORTED, listing them in error.details[0].unsupported; GET /v1/domains/${domain.id} has the same limits. It stops sending once a domain of my own verifies: then send from that domain (a send from ${domain.name} gets 409 OWN_DOMAIN_VERIFIED with the address to use in error.details[0].suggestedFrom).`)
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
  const scope = useRequestScope()
  const [minted, setMinted] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const watched = useApiQuery(['agent-setup', minted ?? ''], (api, signal) => request<SetupStatus>(`/v1/agent/setup-tokens/${encodeURIComponent(minted!)}`, { signal, scope: api.scope }),
    { enabled: enabled && minted !== null, interval: data => !data || data.status === 'waiting' ? 3000 : false })
  if (!enabled) return null
  const status = minted && watched.data?.id === minted ? watched.data : null
  return { state: error ? 'failed' : !minted ? 'idle' : status?.status ?? 'waiting', keyName: status?.keyName ?? null, error,
    copy: prompt => async () => {
      try {
        const made = await request<{ id: string; token: string }>('/v1/agent/setup-tokens', { method: 'POST', scope })
        setMinted(made.id); setError(null)
        return prompt(made.token)
      } catch (failure) { setError(failure); return prompt(undefined) }
    } }
}

// Every state is laid out in one cell, so the line never changes the section's height.
// The line reserves this name's width: a longer one (an agent's own name) is cut to it, so the line never wraps further.
const sampleKey = 'Agent, set up 0000-00-00'
const setupLines: Record<AgentSetupState, (keyName: string) => ReactNode> = {
  idle: () => null,
  waiting: () => 'Waiting for your agent to use the setup token. It works once, for 15 minutes.',
  connected: keyName => <>Your agent connected. Its key is <strong className="agent-setup-status__key" title={keyName}>{keyName}</strong>, under API keys.</>,
  expired: () => 'The setup token expired before your agent used it. Copy the prompt again for a new one.',
  replaced: () => 'A newer copy replaced this setup token. Use the prompt you copied last.',
  failed: () => 'Couldn’t add a setup token, so the copied prompt connects with a device code instead.',
}
// `idle`: the line before the first copy, where a page words it its own way (onboarding).
export function AgentSetupStatus({ setup, idle }: { setup: AgentSetup; idle?: ReactNode }) {
  const { state } = setup, keyName = setup.keyName ?? sampleKey
  return <div className="agent-setup-status" data-state={state}>
    {(Object.keys(setupLines) as AgentSetupState[]).map(key => <p key={key} data-state={key} data-active={key === state || undefined} aria-hidden={key !== state || undefined}>
      {(key === 'connected' || key === 'waiting') && <span className="agent-setup-status__mark" aria-hidden="true">{key === 'connected' ? <Check size={14} strokeWidth={2.5} /> : <span className="connect-agent__pulse" />}</span>}
      <span>{key === 'idle' && idle ? idle : setupLines[key](key === state ? keyName : sampleKey)}</span>
    </p>)}
    <span className="sr-only" role="status">{state === 'idle' ? '' : state === 'connected' ? `Your agent connected. Its key is ${keyName}.` : state === 'failed' ? `Couldn’t add a setup token: ${errorText(setup.error)}` : String(setupLines[state](keyName))}</span>
  </div>
}

/**
 * The agent prompt as Get started and the docs show it, one source for both: Copy (the primary action), a line saying
 * what copying does (for an owner or admin, AgentSetupStatus: copying adds a setup token, then whether the agent used
 * it), and the prompt as the agent will read it, in a box that scrolls with its edges fading where it runs on. `value`:
 * the prompt, or a function that makes it when Copy is pressed (with a fresh setup token); `preview` is what the box
 * shows. `pending`: the prompt is still loading; Copy keeps its place, hidden. A fragment, so the page lays it out.
 */
export function AgentPromptPanel({ value, preview, setup, idle, line, pending = false }: { value: string | (() => Promise<string>); preview: string; setup: AgentSetup | null; idle?: ReactNode; line: ReactNode; pending?: boolean }) {
  return <>
    <div className="agent-prompt__actions" data-pending={pending || undefined} inert={pending}><CopyAction value={value} label="Copy agent prompt" text="Copy agent prompt" variant="primary" /></div>
    {setup ? <AgentSetupStatus setup={setup} idle={idle} /> : <p className="muted agent-prompt__line">{line}</p>}
    <PromptBox text={preview} />
  </>
}
function PromptBox({ text }: { text: string }) {
  const ref = useRef<HTMLElement>(null)
  const fade = (node: HTMLElement) => {
    node.style.setProperty('--fade-top', `${Math.min(24, node.scrollTop)}px`)
    node.style.setProperty('--fade-bottom', `${Math.min(24, node.scrollHeight - node.clientHeight - node.scrollTop)}px`)
  }
  useEffect(() => { if (ref.current) fade(ref.current) }, [text])
  return <pre className="developer-code developer-code--prompt agent-prompt__box"><code ref={ref} tabIndex={0} aria-label="Agent prompt" onScroll={(event: UIEvent<HTMLElement>) => fade(event.currentTarget)}><MaskedText text={text} /></code></pre>
}

// The hosted MCP server, set up as you: the same URL and one-line setups as Connect an agent (connect-agent.tsx).
// `compact` (onboarding) is the setup alone, without the docs' lead line.
export function McpSetup({ compact = false }: { compact?: boolean }) {
  return <section id="mcp" className="section stack developer-section" aria-label="MCP server">
    <SectionHeader title="MCP server" />
    <McpSignInSetup />
  </section>
}
