import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useApiDef, useApiMutation, useApiQuery, useWorkspaceAccess } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import { queries } from '../../data/queries'
import { errorText, type AudienceList, type Contact } from '../../data/types'
import { DataTable, DropdownMenu, Input, SkeletonText, StatusBadge, useToast } from '../../components/ui'
import { contactColumnsFor, memberColumnsFor } from './skeletons'
import { date as formatDate, number } from '../../lib/format'
import { PrivateAddress } from '../../components/PrivateAddress'
import { AddressText } from '../../components/AddressText'
import { addressParts } from '../../lib/private-address'
import { useDebounced } from '../../lib/pagination'
import { displayStatus, riskLabels, riskSkipped, statusTitle } from './consent'

export const pageSize = 8
export const date = (value: string | null) => value ? formatDate(value) : 'Never'
export { number }
export { consentTitle, displayStatus, evidenceRequired, noUnknown, riskBreakdown, riskLabels, riskSkipped, statusOptions, statusTitle } from './consent'
/** A contact name is free text: addresses in it are masked (AddressText), so it is a tooltip only when it holds none. */
export const nameTitle = (name?: string) => name && !addressParts(name).some(part => part.address) ? name : undefined
export function useAudienceLists(search = '', cursor?: string, enabled = true) {
  return useApiDef(queries.audienceLists(search, cursor), { keepPrevious: true, enabled })
}
/** A quoted AudienceQL string literal. */
export const aqlString = (value: string) => `'${value.replaceAll("'", "''")}'`
// A contact's suppression reason as the API records it, in plain words.
const suppressionWords: Record<string, string> = { hard_bounce: 'Bounced', soft_bounce: 'Bounced', transient: 'Bounced', complaint: 'Marked as spam', email_validation: 'Blocked' }
export const suppressionText = (reason?: string) => reason ? suppressionWords[reason] ?? 'Blocked' : undefined

/** A contact's status as a badge with its meaning on hover: Risky (warning) when campaigns skip its address. */
export function ContactStatus({ contact }: { contact: Pick<Contact, 'status' | 'risk'> }) {
  const status = displayStatus(contact)
  return <span title={statusTitle(contact)}><StatusBadge status={status} tone={status === 'risky' ? 'warning' : undefined} /></span>
}
/** Send anyway (allowed) or skip again a contact flagged as risky; a toast says so, with Undo. */
export function useAllowRisk() {
  const toast = useToast()
  const allow = useApiMutation((api, input: { id: string; allowed: boolean }) => api.contacts.allowRisk(input.id, input.allowed), undefined, false, invalidate.contactProfile)
  async function run(id: string, allowed: boolean, undo = true) {
    try {
      await allow.mutateAsync({ id, allowed })
      toast(allowed ? 'Campaigns will send to this contact' : 'Campaigns skip this contact again', 'success', undo ? { action: { label: 'Undo', onSelect: () => void run(id, !allowed, false) } } : undefined)
    } catch (cause) { toast(errorText(cause), 'error') }
  }
  return { run, pending: allow.isPending }
}

// One control to find and choose a list by name: type to search, arrows and Enter to choose. The first option is
// `emptyLabel` (all lists, or no list). Lists are never shown by ID.
export function ListPicker({ value, onChange, emptyLabel, id, label, disabled = false, className, 'aria-describedby': describedBy }: { value: string; onChange: (id: string) => void; emptyLabel: string; id?: string; label?: string; disabled?: boolean; className?: string; 'aria-describedby'?: string }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(0)
  const listbox = useId(), menu = useRef<HTMLDivElement>(null)
  const query = useDebounced(search.trim(), 200)
  const all = useAudienceLists(), found = useAudienceLists(query)
  const options = open && query ? found : all
  const known = all.data?.find(list => list.id === value)
  const selected = useApiQuery(['lists', value], (api, signal) => api.lists.get(value, signal), { enabled: Boolean(value) && !all.isPending && !known })
  const name = value ? known?.name ?? selected.data?.name : ''
  const items: { id: string; name: string }[] = [{ id: '', name: emptyLabel }, ...(options.data ?? [])]
  const activeIndex = Math.min(active, items.length - 1)
  // Escape closes the open options, not the dialog around the picker: dialogs listen on the document in the capture
  // phase, so this listens on the window, which comes first.
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); event.preventDefault(); setOpen(false); setSearch('') } }
    window.addEventListener('keydown', close, { capture: true })
    return () => window.removeEventListener('keydown', close, { capture: true })
  }, [open])
  function choose(next: string) { setOpen(false); setSearch(''); if (next !== value) onChange(next) }
  function show() { if (disabled || open) return; setOpen(true); setSearch(''); setActive(Math.max(0, items.findIndex(item => item.id === value))) }
  function move(step: number) { const next = (activeIndex + step + items.length) % items.length; setActive(next); menu.current?.querySelectorAll('[role="option"]')[next]?.scrollIntoView({ block: 'nearest' }) }
  return <div className={className ? `audience-list-picker ${className}` : 'audience-list-picker'} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setSearch('') } }}>
    <Input id={id} role="combobox" title={open ? undefined : name || undefined} aria-label={label} aria-describedby={describedBy} aria-expanded={open} aria-controls={open ? listbox : undefined} aria-autocomplete="list" aria-activedescendant={open ? `${listbox}-${activeIndex}` : undefined} autoComplete="off" spellCheck={false} disabled={disabled}
      placeholder={open ? 'Search lists by name' : value && !name ? (selected.isError ? 'List not found' : 'Loading list…') : emptyLabel} value={open ? search : name ?? ''}
      onClick={show} onChange={event => { setSearch(event.target.value); setActive(event.target.value.trim() ? 1 : 0); setOpen(true) }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) show(); else move(event.key === 'ArrowDown' ? 1 : -1) }
        else if (event.key === 'Enter' && open) { event.preventDefault(); if (items[activeIndex]) choose(items[activeIndex].id) }
        else if (event.key === 'Tab') { setOpen(false); setSearch('') }
      }} />
    <ChevronDown size={14} aria-hidden="true" />
    {open && <div ref={menu} id={listbox} role="listbox" aria-label={label ?? 'Lists'} className="ui-popover audience-list-options"><div className="ui-popover-scroll">
      {items.map((item, index) => <button key={item.id || 'none'} id={`${listbox}-${index}`} type="button" role="option" title={item.name} tabIndex={-1} aria-selected={index === activeIndex} data-current={item.id === value || undefined} className="audience-list-option" onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(item.id)}><span>{item.name}</span>{item.id === value && <Check size={14} aria-hidden="true" />}</button>)}
      {options.isPending ? <div className="audience-list-note" role="status">Loading lists…</div> : options.isError ? <div className="audience-list-note" role="alert">Couldn’t load lists. Close and reopen to try again.</div> : query && !options.data.length ? <div className="audience-list-note">No list named “{query}”.</div> : options.data.nextCursor ? <div className="audience-list-note">More lists exist.</div> : null}
    </div></div>}
  </div>
}

// A contact's lists as the first list's name and a count of the rest, "Customers +2", so no name is cut midway; the
// hover title names them all.
const listNames = (row: Contact, lists: AudienceList[]) => row.listIds.map(id => lists.find(list => list.id === id)?.name).filter((name): name is string => Boolean(name))
function listsText(row: Contact, lists: AudienceList[]) {
  const count = row.listIds.length, first = listNames(row, lists)[0]
  return !count ? '—' : first ? count > 1 ? `${first} +${count - 1}` : first : `${count} list${count === 1 ? '' : 's'}`
}
const listsTitle = (row: Contact, lists: AudienceList[]) => listNames(row, lists).join(', ') || undefined
export function ContactTable({ contacts, lists = [], members = false, status, loading = false, minRows = pageSize, listsLoading = false, tableRef, empty }: { contacts: Contact[]; lists?: AudienceList[]; members?: boolean; status?: string; loading?: boolean; minRows?: number; listsLoading?: boolean; tableRef?: (node: HTMLDivElement | null) => void; empty?: ReactNode }) {
  const columns = members ? memberColumnsFor(status ?? '') : contactColumnsFor(status ?? '')
  const allow = useAllowRisk(), { canAdminister } = useWorkspaceAccess()
  // Send anyway is an owner's or admin's call (the API wants manage for it).
  const riskMenu = (row: Contact) => canAdminister && row.risk && <DropdownMenu label="Actions for this contact" title={<PrivateAddress value={row.email} />} items={[row.risk.allowed ? { label: 'Skip again', hint: 'Campaigns skip this address', onSelect: () => void allow.run(row.id, false) } : { label: 'Send anyway', hint: 'Campaigns send to this address', onSelect: () => void allow.run(row.id, true) }]} />
  // Why campaigns skip a contact: its suppression, else its risk.
  const reason = (row: Contact) => suppressionText(row.suppressionReason) ?? (riskSkipped(row) ? riskLabels[row.risk!.reason] : undefined)
  return <DataTable className="audience-contacts" tableRef={tableRef} rows={contacts} loading={loading} skeletonRows={minRows} minRows={minRows} rowKey={row => row.id} rowHref={row => `/audience/contacts/${row.id}`} empty={empty} columns={columns.map(column => ({ ...column, cardRender: column.key === 'email' ? (row: Contact) => <span className="audience-cell-text"><PrivateAddress value={row.email} /></span>
    // A card gives the name its own line, so its title is the address alone.
    : column.key === 'name' ? (row: Contact) => <span title={nameTitle(row.name)}>{row.name ? <AddressText text={row.name} /> : 'No name'}</span>
    // A member card's second line: the suppression reason when there is one, else the name (never an empty dash).
    : column.key === 'suppression' ? (row: Contact) => reason(row) ? <span title={reason(row)}>{reason(row)}</span> : <span title={nameTitle(row.name)}>{row.name ? <AddressText text={row.name} /> : 'No name'}</span>
    : column.key === 'actions' ? riskMenu
    : column.key === 'created' ? (row: Contact) => { const names = members || listsLoading ? null : listsText(row, lists); return <>{`Added ${date(row.createdAt)}`}{names && names !== '—' && <span title={listsTitle(row, lists)}> · {names}</span>}</> } : undefined, render: (row: Contact) => {
    // The name, when there is one, follows the address on its line, muted; it gives way first when the cell is tight.
    if (column.key === 'email') return <span className="audience-contact"><span className="audience-contact__email"><PrivateAddress value={row.email} /></span>{row.name && <span className="audience-contact__name" title={nameTitle(row.name)}><AddressText text={row.name} /></span>}</span>
    if (column.key === 'status') return <ContactStatus contact={row} />
    if (column.key === 'suppression' || column.key === 'reason') return <span className="audience-cell-text" title={reason(row)}>{reason(row) ?? '—'}</span>
    if (column.key === 'actions') return riskMenu(row)
    if (column.key === 'lists') {
      if (listsLoading && row.listIds.length) return <SkeletonText width="70%" />
      const text = listsText(row, lists)
      return <span className="audience-cell-text" title={listsTitle(row, lists) ?? text}>{text}</span>
    }
    return date(row.createdAt)
  } }))} />
}

// A segment's public rule (API SegmentRule) as one readable line: `Country is DE`, `Not opened in 90 days`,
// `Plan is pro and (Country is DE or Country is FR)`, `joined_at is before 2026-11-20`.
type PublicRule = { field?: string; key?: string; type?: string; operator?: string; value?: unknown; days?: unknown; rules?: PublicRule[] }
const ruleFields: Record<string, string> = { email: 'Email', firstName: 'First name', plan: 'Plan', country: 'Country' }
const propertyVerbs: Record<string, string> = { 'string:eq': 'is', 'string:neq': 'is not', 'string:contains': 'contains', 'number:eq': '=', 'number:lt': '<', 'number:gt': '>', 'date:before': 'is before', 'date:after': 'is after', 'date:on': 'is on' }
export function ruleSummary(rule: unknown, nested = false): string {
  const r = (rule ?? {}) as PublicRule
  if (Array.isArray(r.rules)) {
    const parts = r.rules.map(child => ruleSummary(child, true))
    const text = parts.join(r.operator === 'or' ? ' or ' : ' and ')
    return nested && parts.length > 1 ? `(${text})` : text || 'Everyone'
  }
  if (r.field === 'lastOpenAt' || r.field === 'lastClickAt') {
    const verb = r.field === 'lastOpenAt' ? 'opened' : 'clicked', days = number(Number(r.days))
    return r.operator === 'inactive' ? `Not ${verb} in ${days} days` : `${verb[0].toUpperCase()}${verb.slice(1)} in the last ${days} days`
  }
  if (r.field === 'property') return r.operator === 'set' || r.operator === 'notSet' ? `${r.key ?? ''} ${r.operator === 'set' ? 'is set' : 'is not set'}`
    : `${r.key ?? ''} ${propertyVerbs[`${r.type}:${r.operator}`] ?? r.operator ?? 'is'} ${String(r.value ?? '')}`
  const op = r.operator === 'neq' ? 'is not' : r.operator === 'contains' ? 'contains' : 'is'
  return `${ruleFields[r.field ?? ''] ?? r.field ?? 'Value'} ${op} ${String(r.value ?? '')}`
}
