import { Button, CopyButton, Dialog, Field, SecretCode, type SelectOption } from '../../components/ui'
import type { InboundAddress, MailAddress, WebhookSecrets } from '../../data/types'
import { PrivateAddress } from '../../components/PrivateAddress'
import { cleanName, nameParts } from '../../lib/private-address'

export { cleanName }
/** A secret shown once (an inbox's API key, a webhook endpoint's signing secret) with its copy button, and the one thing
 *  to know about it now. */
export function SecretField({ label, value, copyLabel }: { label: string; value: string; copyLabel: string }) {
  return <Field label={label} hint="It won’t be shown again."><div className="settings-copy-cell"><SecretCode>{value}</SecretCode><CopyButton value={value} label={copyLabel} /></div></Field>
}
/** A webhook's new signing secret and inbound-format verification token, shown once after a save or a rotation that
 *  returned either. Open while `secrets` holds one. */
export function WebhookSecretsDialog({ secrets, title, onClose }: { secrets: WebhookSecrets | null; title: string; onClose: () => void }) {
  return <Dialog sensitive dismissible={false} open={Boolean(secrets?.secret || secrets?.verificationToken)} onOpenChange={open => { if (!open) onClose() }} title={title}
    description={secrets?.secret ? 'The old secret stopped working.' : 'Your server checks this in the X-Webhook-Verification-Token header.'} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
    <div className="stack">
      {secrets?.secret && <SecretField label="Signing secret" value={secrets.secret} copyLabel="Copy secret" />}
      {secrets?.verificationToken && <SecretField label="Verification token" value={secrets.verificationToken} copyLabel="Copy token" />}
    </div>
  </Dialog>
}
/** A sender in words, for a label or a title: the display name, never a piece of the address. */
export const nameOf = (value: MailAddress) => { const parts = nameParts(value.name, value.address); return parts && parts.every(part => !part.address) ? parts.map(part => part.text).join('') : 'this sender' }
export const full = (value: MailAddress) => cleanName(value.name) ? `${cleanName(value.name)} <${value.address}>` : value.address
/** A name for something new (a rule's key, an endpoint) made from `base`: lowercase words joined by dashes, numbered
 *  past the names already taken, `fallback` when nothing of `base` is left. */
export function freeKey(base: string, taken: Set<string>, fallback: string) {
  const stem = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || fallback
  for (let n = 1; ; n++) { const name = n === 1 ? stem : `${stem}-${n}`; if (!taken.has(name)) return name }
}
export const addressName = (addresses: Map<string, InboundAddress>, id: string) => addresses.get(id)?.address ?? id
export function when(value: string) {
  const at = new Date(value), now = new Date()
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}

/** A rule's page. A rule named "new" shares its path with the add screen, so its page is /new/code (recipes.tsx, NewRecipeRoute). */
export const rulePath = (key: string) => key === 'new' ? '/receiving/rules/new/code' : `/receiving/rules/${encodeURIComponent(key)}`
/** The address builder on the one address a two-way rule (split, split-by-meaning) runs on; null when it runs on several, or none. */
export function splitBuilderPath(key: string, attachedTo: string[], options: { id: string; address: string }[] | undefined) {
  const target = attachedTo.length === 1 ? attachedTo[0]! : null
  const id = target && (target.startsWith('mbx_') ? target : options?.find(a => a.address === target)?.id)
  return id ? `/receiving?tab=rules&build=${encodeURIComponent(id)}&rule=${encodeURIComponent(key)}` : null
}

export const openBuilder = 'Open in the address builder'

/** Reuse one Idempotency-Key while the operator retries the same payload; a changed payload gets a new key. */
export function idempotencyFor(state: { key: string; body: string }, body: unknown) {
  const next = JSON.stringify(body)
  if (state.body !== next) { state.key = crypto.randomUUID(); state.body = next }
  return state.key
}

/** An option of a ui/Select that lists addresses: the address (with its display name, if any) is masked like every address, in the trigger, the menu and a phone's sheet. */
export const addressOption = (value: string, address: string, name?: string): SelectOption => ({ value, text: name ? `${name} ${address}` : address, label: <>{name ? `${name} ` : ''}<PrivateAddress value={address} /></> })
