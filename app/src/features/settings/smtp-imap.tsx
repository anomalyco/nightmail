import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { EmptyState, PageHeader, SectionHeader, SecretDialog } from '../../components/ui'
import { useWorkspaceAccess } from '../../data/context'
import { MailSection, MailSettings, useMailServers } from '../docs/mail-settings'
import { AdminOnlyPage } from './admin-only'
import { CreateKeyDialog, type CreatedSecret } from './create-key'
import { KeyTable } from './key-table'
import './api-keys.css'

/** SMTP & IMAP: what an app's own SMTP settings take, and what a mail app takes, each with the password it signs in
 *  with. No mail gateway means neither is offered on this installation, so the address is as unknown as any hidden
 *  page's. Owners and admins only, as the API keys it makes are. */
export function SmtpImapPage() {
  const servers = useMailServers(), { canAdminister } = useWorkspaceAccess()
  // No mail gateway: nothing to show, so the address is unknown here rather than an empty page.
  if (!servers) return <EmptyState headingAs="h1" title="Page not found" action={<Link to="/overview">Return to overview</Link>} />
  return canAdminister ? <SmtpImap /> : <AdminOnlyPage title="SMTP & IMAP" />
}
function SmtpImap() {
  // Which form the page's one Create button opens: an SMTP login, or an app password for a mail app.
  const [creating, setCreating] = useState<'smtp' | 'app' | null>(null)
  const [secret, setSecret] = useState<CreatedSecret | null>(null)
  const { hash, key } = useLocation()
  // #smtp and #imap (⌘K's SMTP settings and IMAP settings) bring their section to the top, again when the same one is
  // asked for while the page is open: each of those is a new history entry (its key changes).
  useEffect(() => {
    if (!hash) return
    let id = hash.slice(1)
    try { id = decodeURIComponent(id) } catch { /* A malformed hash names no section. */ }
    const frame = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }))
    return () => cancelAnimationFrame(frame)
  }, [hash, key])
  return <div className="stack">
    <PageHeader title="SMTP & IMAP" />
    <div className="keys-sections">
      <section id="smtp" className="section stack" aria-label="SMTP">
        <SectionHeader title="SMTP" />
        <MailSection kind="smtp" onCreate={() => setCreating('smtp')} />
      </section>
      <section id="imap" className="section stack" aria-label="IMAP">
        <SectionHeader title="IMAP" />
        <MailSection kind="imap" onCreate={() => setCreating('app')} />
        {/* App passwords are ordinary credentials, listed as on API keys' App passwords tab; which of them open which
            inbox is the Inbox line of each row. */}
        <KeyTable type="app" showRevoked={false} />
      </section>
    </div>
    {creating && <CreateKeyDialog open onOpenChange={next => { if (!next) setCreating(null) }} initial={creating === 'smtp' ? { smtp: true } : { app: true }} onCreated={setSecret} />}
    <SecretDialog secret={secret?.secret ?? null} title={secret?.title ?? 'Created'} description={secret?.description} onClose={() => setSecret(null)}>{secret?.mail && <MailSettings username={secret.mail.username} imap={secret.mail.imap} smtp={secret.mail.smtp} />}</SecretDialog>
  </div>
}
