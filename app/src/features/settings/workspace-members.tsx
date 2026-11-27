import { useState, type FormEvent } from 'react'
import { Share } from 'lucide-react'
import { Button, ConfirmDialog, CopyButton, SecretCode, DataTable, Dialog, Disclosure, DropdownMenu, EmptyState, ErrorState, Field, Input, SectionHeader, Select, useCopy, useToast, fieldError, MutationError } from '../../components/ui'
import { useApiMutation, useApiDef, useSession } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import { queries } from '../../data/queries'
import type { CreatedWorkspaceInvitation, WorkspaceInvitation, WorkspaceMember, WorkspaceRole } from '../../data/types'
import { roleLabel, workspaceApi } from '../../data/workspaces'
import { date } from '../../lib/format'
import { PrivateAddress } from '../../components/PrivateAddress'
import { settingsColumns } from './skeletons'
import { productName } from '../../../../api/src/brand'

// A phone shares an invitation link through the system share sheet; everything can copy it.
const canShare = () => typeof navigator.share === 'function'
async function shareLink(url: string, toast: ReturnType<typeof useToast>) {
  try { await navigator.share({ title: `Join the workspace on ${productName}`, url }) } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) toast('Couldn’t open sharing.', 'error') }
}
const roleOptions = (owner: boolean) => (owner ? ['owner', 'admin', 'member'] as const : ['admin', 'member'] as const).map(role => ({ value: role, label: roleLabel[role] }))
// One line per role, behind "What each role can do" where a role is chosen for someone new (the invitation); a change
// of role says what it does in its confirmation.
const roleHint: Record<WorkspaceRole, string> = {
  owner: 'Everything, including adding and removing other owners.',
  admin: 'Everything except owners: keys, domains, webhooks, sending and members.',
  member: 'Sends email, reads logs and edits content. Can’t manage keys, domains, webhooks or teammates.',
}
function RoleGuide({ owner }: { owner: boolean }) {
  return <Disclosure title="What each role can do"><dl className="settings-role-guide">{(owner ? ['owner', 'admin', 'member'] as const : ['admin', 'member'] as const).map(role => <div key={role}><dt>{roleLabel[role]}</dt><dd className="muted">{roleHint[role]}</dd></div>)}</dl></Disclosure>
}
// What a role change does, said before it happens. A promotion to owner can't be taken back by the person granting it.
function roleChange(member: WorkspaceMember, role: WorkspaceRole) {
  const name = member.name || 'this member'
  const who = member.name || <PrivateAddress value={member.email} />
  if (role === 'owner') return { title: `Make ${name} an owner?`, description: 'They can remove you; only another owner can undo this.', confirm: 'Make owner', danger: true }
  if (role === 'admin') return { title: `Make ${name} an admin?`, description: member.role === 'owner' ? <>{who} stops being an owner.</> : 'They can manage keys, domains, webhooks, sending and members.', confirm: 'Make admin', danger: false }
  return { title: `Change ${name} to member?`, description: 'They lose access to keys, domains, webhooks, sending and members at once.', confirm: 'Change to member', danger: false }
}


const [nameColumn, emailColumn, roleColumn, memberActions] = settingsColumns.members
const [inviteEmail, inviteRole, inviteExpires, inviteActions] = settingsColumns.invitations
export function Members({ owner, onInvite }: { owner: boolean; onInvite: () => void }) {
  const session = useSession()
  const members = useApiDef(queries.workspaceMembers())
  const update = useApiMutation((_api, input: { id: string; role: WorkspaceRole }) => workspaceApi.updateMember(input.id, input.role), 'Role updated', false, invalidate.workspaceMembers)
  const remove = useApiMutation((_api, id: string) => workspaceApi.removeMember(id), 'Member removed', false, invalidate.workspaceMembers)
  const [removing, setRemoving] = useState<WorkspaceMember | null>(null)
  const [changing, setChanging] = useState<{ member: WorkspaceMember; role: WorkspaceRole } | null>(null)
  const change = changing && roleChange(changing.member, changing.role)
  const owners = members.data?.filter(member => member.role === 'owner').length ?? 0
  // Only owners manage owners; the last owner stays until another is promoted. Your own row is read-only.
  const manageable = (member: WorkspaceMember) => member.userId !== session?.identity?.id && (owner || member.role !== 'owner')
  const lastOwner = (member: WorkspaceMember) => member.role === 'owner' && owners <= 1
  return <section className="section stack settings-rule">
    <div className="settings-actions"><Button onClick={onInvite} data-analytics="members/invite">Invite teammate</Button></div>
    <MutationError error={update.error} />
    {members.error ? <ErrorState error={members.error} onRetry={() => void members.refetch()} /> : <DataTable className="settings-people" loading={members.isPending} skeletonRows={3} minRows={3} rows={members.data ?? []} rowKey={member => member.id} empty={<EmptyState title="No members" />} columns={[
      { ...nameColumn, render: member => <span className="settings-cell" title={`${member.name || '—'}${member.userId === session?.identity?.id ? ' · You' : ''}`}>{member.name || '—'}{member.userId === session?.identity?.id && <span className="muted"> · You</span>}</span>, cardRender: member => member.name || '—' },
      { ...emailColumn, render: member => <PrivateAddress value={member.email} /> },
      { ...roleColumn, render: member => manageable(member) && !lastOwner(member) ? <Select aria-label={`Role for ${member.name || 'this member'}`} value={member.role} onValueChange={role => { if (role !== member.role) setChanging({ member, role: role as WorkspaceRole }) }} disabled={update.isPending} options={roleOptions(owner)} /> : roleLabel[member.role], cardRender: member => member.userId === session?.identity?.id ? `${roleLabel[member.role]} · You` : roleLabel[member.role] },
      // A phone puts the role and Remove in the row's action sheet.
      { ...memberActions, render: member => manageable(member) && !lastOwner(member) ? <Button variant="danger" onClick={() => setRemoving(member)}>Remove</Button> : null,
        cardRender: member => manageable(member) && !lastOwner(member) ? <DropdownMenu label={`Actions for ${member.name || 'this member'}`} title={member.name || <PrivateAddress value={member.email} />} items={[
          ...roleOptions(owner).filter(option => option.value !== member.role).map(option => ({ label: `Make ${option.label.toLowerCase()}`, disabled: update.isPending, onSelect: () => setChanging({ member, role: option.value }) })),
          { label: 'Remove from workspace', destructive: true, onSelect: () => setRemoving(member) },
        ]} /> : <span className="settings-card-end" /> },
    ]} />}
    <ConfirmDialog open={changing !== null} onOpenChange={open => { if (!open) setChanging(null) }} title={change?.title ?? ''} description={change?.description ?? ''} confirmLabel={change?.confirm} danger={change?.danger} pending={update.isPending} onConfirm={async () => { if (changing) await update.mutateAsync({ id: changing.member.id, role: changing.role }) }} />
    <ConfirmDialog open={removing !== null} onOpenChange={open => { if (!open) setRemoving(null) }} title={`Remove ${removing?.name || 'this member'}?`} description={removing && !removing.name ? <><PrivateAddress value={removing.email} /> loses access to this workspace immediately. You can invite them again later.</> : 'They lose access to this workspace immediately. You can invite them again later.'} confirmLabel="Remove member" danger pending={remove.isPending} onConfirm={async () => { if (removing) await remove.mutateAsync(removing.id) }} />
  </section>
}

export function Invitations({ owner }: { owner: boolean }) {
  const toast = useToast(), { copy } = useCopy()
  const invitations = useApiDef(queries.workspaceInvitations())
  const revoke = useApiMutation((_api, id: string) => workspaceApi.revokeInvitation(id), 'Invitation revoked', false, invalidate.workspaceInvitations)
  const [revoking, setRevoking] = useState<WorkspaceInvitation | null>(null)
  return <section className="section stack settings-rule">
    <SectionHeader title="Invitations" />
    {invitations.error ? <ErrorState error={invitations.error} onRetry={() => void invitations.refetch()} /> : <DataTable className="settings-people" loading={invitations.isPending} skeletonRows={2} rows={invitations.data ?? []} rowKey={invitation => invitation.id} minRows={2} empty={<EmptyState title="No pending invitations" />} columns={[
      { ...inviteEmail, render: invitation => <PrivateAddress value={invitation.email} /> },
      { ...inviteRole, render: invitation => roleLabel[invitation.role] },
      { ...inviteExpires, render: invitation => date(invitation.expiresAt), cardRender: invitation => `Expires ${date(invitation.expiresAt)}` },
      { ...inviteActions, render: invitation => <span className="cluster settings-row-actions"><CopyButton value={invitation.acceptUrl} label="Copy invitation link" />{(owner || invitation.role !== 'owner') && <Button variant="danger" onClick={() => setRevoking(invitation)}>Revoke</Button>}</span>,
        cardRender: invitation => <DropdownMenu label="Actions for this invitation" title="Invitation" items={[
          ...canShare() ? [{ label: 'Share invitation link', onSelect: () => void shareLink(invitation.acceptUrl, toast) }] : [],
          { label: 'Copy invitation link', onSelect: () => void copy(invitation.acceptUrl, 'Invitation link copied') },
          ...owner || invitation.role !== 'owner' ? [{ label: 'Revoke invitation', destructive: true, onSelect: () => setRevoking(invitation) }] : [],
        ]} /> },
    ]} />}
    <ConfirmDialog open={revoking !== null} onOpenChange={open => { if (!open) setRevoking(null) }} title="Revoke this invitation?" description={revoking ? <>The invitation link for <PrivateAddress value={revoking.email} /> stops working.</> : ''} confirmLabel="Revoke invitation" danger pending={revoke.isPending} onConfirm={async () => { if (revoking) await revoke.mutateAsync(revoking.id) }} />
  </section>
}

// How the answer to an invitation opens: it was emailed, or why the link is the inviter's to send (a reason without a
// line of its own, such as a paused workspace, opens as not_available does). The address follows on its own line.
const inviteAnswer = {
  emailed: 'We emailed this link to:',
  new_workspace: 'Invitations are emailed once this workspace has a verified domain or finishes its evaluation. For now, send this link to:',
  allowance_used: 'Today’s invitation emails are used. Send this link to:',
  not_available: 'No email was sent. Send this link to:',
} as const

export function InviteDialog({ open, owner, onOpenChange }: { open: boolean; owner: boolean; onOpenChange: (open: boolean) => void }) {
  const toast = useToast()
  const create = useApiMutation((_api, input: { email: string; role: WorkspaceRole }) => workspaceApi.invite(input), undefined, false, invalidate.workspaceInvitations)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('member')
  const [emailError, setEmailError] = useState('')
  const [created, setCreated] = useState<CreatedWorkspaceInvitation | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = email.trim()
    if (!value) { setEmailError('Enter their email address.'); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { setEmailError('Enter an email address like name@company.com.'); return }
    setEmailError('')
    try { setCreated(await create.mutateAsync({ email: value, role })) } catch { /* The mutation error is shown in the form. */ }
  }
  function close() { onOpenChange(false); setCreated(null); setEmail(''); setRole('member'); setEmailError(''); create.reset() }
  // One dialog from the form to the answer, and nothing in it moves when the answer arrives, however late: the form
  // and the answer share one grid cell (settings-invite), the one not shown laid out but hidden, so the body is as tall
  // as the taller of the two from the start and the footer stays where it is. The answer's height does not depend on
  // what the answer is: every opening line is laid out and one shown, and the address and the link keep to one line each.
  // The link works only for the invited address; its expiry is in Invitations, where it can be copied again.
  const reason = created?.notEmailedReason
  const answer = created ? created.emailed ? 'emailed' : reason && reason in inviteAnswer ? reason : 'not_available' : null
  return <Dialog sensitive={created !== null} open={open} onOpenChange={next => { if (created) { if (!next) close() } else if (!create.isPending) { if (next) onOpenChange(true); else close() } }}
    title={created ? created.emailed ? 'Invitation sent' : 'Share this invitation link' : 'Invite teammate'}
    footer={created ? <Button key="done" variant="primary" autoFocus onClick={close}>Done</Button> : <><Button disabled={create.isPending} onClick={close}>Cancel</Button><Button className="settings-invite__submit" variant="primary" loading={create.isPending} type="submit" form="invite-member">Invite</Button></>}>
    <div className="settings-invite">
      <form id="invite-member" className="stack" onSubmit={submit} noValidate inert={created !== null}>
        <MutationError error={create.error} />
        <Field label="Their sign-in email" htmlFor="invite-email" error={emailError || fieldError(create.error, 'email')}><Input id="invite-email" type="email" value={email} onChange={event => { setEmail(event.target.value); if (emailError) setEmailError(''); if (create.error) create.reset() }} autoFocus required disabled={create.isPending} placeholder="name@company.com" /></Field>
        <Field label="Role" htmlFor="invite-role"><Select id="invite-role" value={role} onValueChange={value => setRole(value as WorkspaceRole)} disabled={create.isPending} options={roleOptions(owner)} /></Field>
        <RoleGuide owner={owner} />
      </form>
      <div className="settings-invite__answer" inert={created === null}>
        <div>
          <p className="settings-invite__lead">{Object.entries(inviteAnswer).map(([key, text]) => <span key={key} aria-hidden={key !== answer || undefined}>{text}</span>)}</p>
          <p className="settings-invite__address">{created ? <PrivateAddress value={created.email} /> : '\u00a0'}</p>
        </div>
        <div className="ui-secret"><SecretCode className="settings-invite__link">{created?.acceptUrl ?? '\u00a0'}</SecretCode><CopyButton value={created?.acceptUrl ?? ''} label="Copy invitation link" /></div>
        {canShare() && <Button className="settings-share" onClick={() => { if (created) void shareLink(created.acceptUrl, toast) }}><Share size={16} />Share link</Button>}
        <p className="muted">Only that address can accept it, by signing in with an emailed link or its Google account.</p>
      </div>
    </div>
  </Dialog>
}

