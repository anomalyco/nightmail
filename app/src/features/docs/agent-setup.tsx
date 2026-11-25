import type { ReactNode } from 'react'
import { Download } from 'lucide-react'
import { SectionHeader } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { PrivateAddress } from '../../components/PrivateAddress'
import { isMailbox } from '../../lib/private-address'
import type { Domain } from '../../data/types'
import { recordsFor } from '../settings/domain-records'
import { McpSignInSetup } from './connect-agent'
import './developer.css'
import { apiKeyEnv, productName, productSlug, sdkPackage } from '../../../../api/src/brand'

function receivingMx(domain: Domain) {
  const record = recordsFor(domain, 'receiving').find(row => row.type === 'MX')
  const match = record?.value.match(/^(\d+)\s+(\S+)$/)
  return record ? { name: record.name, host: match ? match[2] : record.value, priority: match ? match[1] : '10' } : null
}

// domain is undefined when the reader is signed out and the workspace's domains are unknown.
// `testSender`: the shared test sender (GET /v1/me), offered until a domain is verified so an agent can send a first email at once.
export function agentPrompt({ origin, domain, email, multiTenant, testSender }: { origin: string; domain: Domain | null | undefined; email: string | null; multiTenant: boolean; testSender?: { address: string; perDay: number } | null }) {
  const lines = [
    `Set up ${productName} email in this project.`,
    '',
    `- API base URL: ${origin}`,
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

// A null prompt is still loading: the section keeps its place and its actions stay hidden. `compact` (onboarding) is the
// prompt and its actions without the docs' paragraph on how to use it.
export function AgentPrompt({ prompt, compact = false }: { prompt: string | null; compact?: boolean }) {
  return <section id="agent-prompt" className="section stack developer-section" aria-label="Agent prompt" aria-busy={prompt === null || undefined}>
    <SectionHeader title="Agent prompt" actions={<span className="developer-icon-actions" data-pending={prompt === null || undefined} inert={prompt === null}>
      <button type="button" className="ui-button ui-button--ghost ui-button--sm developer-copy-icon" aria-label="Download agent prompt as .txt" title="Download as .txt" onClick={() => downloadText(`${productSlug}-agent-prompt.txt`, prompt ?? '')}><Download size={14} aria-hidden="true" /></button>
      <CopyAction value={prompt ?? ''} label="Copy agent prompt" variant="ghost" size="sm" compact className="developer-copy-icon" />
    </span>} />
    {!compact && <p className="muted developer-copy">Paste this into your coding agent, or download it as a .txt file for it to read. It has this workspace’s real values; the API key stays in your environment.</p>}
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
