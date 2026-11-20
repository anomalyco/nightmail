import { useEffect, useMemo, useRef, useState } from 'react'
import { useApiMutation } from '../../data/context'
import type { AudienceList, ListMergeInput, ListMergeResult } from '../../data/types'
import { Button, Checkbox, Dialog, Input, MetricRow, MutationError, Select, SkeletonText, useToast } from '../../components/ui'
import { number } from './shared'

const count = (n: number, word: string) => `${number(n)} ${word}${n === 1 ? '' : 's'}`
const merged = (lists: number, result: ListMergeResult) => `${lists} lists merged into ${result.list?.name ?? 'one'}: ${count(result.added, 'contact')} added${result.deletedListIds.length ? `, ${count(result.deletedListIds.length, 'list')} deleted` : ''}`

// "Merge…" on the Lists page: the selected lists' members join one of them or a new list, each contact once, and the
// others can be deleted. The API copies memberships only, so consent and suppression stay as they are; a dry run of
// the same request counts the merged list before anything changes, and refuses what the merge would refuse.
export function MergeListsDialog({ lists, onClose, onMerged }: { lists: AudienceList[]; onClose: () => void; onMerged: () => void }) {
  const toast = useToast()
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  // The largest list keeps its members by default; a new list is named after the lists it merges.
  const [targetId, setTargetId] = useState(() => lists.reduce((best, list) => (list.total ?? 0) > (best.total ?? 0) ? list : best).id)
  const [name, setName] = useState(() => lists.map(list => list.name).join(' + ').slice(0, 200))
  const [deleteSources, setDeleteSources] = useState(false)
  const [checked, setChecked] = useState(false)
  const existing = mode === 'existing', target = lists.find(list => list.id === targetId), others = lists.filter(list => list.id !== targetId)
  const body: ListMergeInput = existing ? { sourceIds: others.map(list => list.id), into: { listId: targetId }, deleteSources } : { sourceIds: lists.map(list => list.id), into: { name: name.trim() }, deleteSources }
  const request = JSON.stringify(body)
  // One key per request, so pressing Merge again after a lost answer repeats that merge instead of making a second one.
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [request])
  const preview = useApiMutation((api, input: ListMergeInput) => api.lists.merge({ ...input, dryRun: true }), undefined, false, false)
  const merge = useApiMutation((api, input: ListMergeInput) => api.lists.merge(input))
  // The name doesn't change the counts, so typing it doesn't count again. `mutate` is new each render: the effect
  // waits on the request alone.
  const previewRequest = existing ? request : JSON.stringify({ ...body, into: { name: lists[0]!.name } })
  const run = useRef(preview.mutate)
  run.current = preview.mutate
  useEffect(() => { run.current(JSON.parse(previewRequest) as ListMergeInput) }, [previewRequest])
  const missingName = checked && !existing && !name.trim()
  async function submit() {
    setChecked(true)
    if (!existing && !name.trim()) return
    try {
      const result = await merge.mutateAsync({ ...body, idempotencyKey })
      toast(merged(lists.length, result), 'success')
      onMerged(); onClose()
    } catch { /* Shown in the dialog. */ }
  }
  const total = preview.data?.total ?? 0, added = preview.data?.added ?? 0
  return <Dialog open onOpenChange={open => { if (!open && !merge.isPending) onClose() }} title={`Merge ${lists.length} lists`} footer={<><Button disabled={merge.isPending} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="merge-lists" loading={merge.isPending} disabled={preview.isError}>Merge lists</Button></>}>
    <form id="merge-lists" className="stack" onSubmit={event => { event.preventDefault(); void submit() }}>
      <fieldset className="audience-merge-into" disabled={merge.isPending}>
        <legend className="ui-field__label">Merge into</legend>
        <label className="ui-choice"><input type="radio" name="merge-into" checked={existing} onChange={() => setMode('existing')} /><span>An existing list</span></label>
        <Select aria-label="Existing list" value={targetId} onValueChange={setTargetId} options={lists.map(list => ({ value: list.id, label: list.name }))} disabled={!existing || merge.isPending} />
        <label className="ui-choice"><input type="radio" name="merge-into" checked={!existing} onChange={() => setMode('new')} /><span>A new list</span></label>
        <Input aria-label="New list name" maxLength={200} value={name} onChange={event => setName(event.target.value)} disabled={existing} aria-invalid={missingName || undefined} aria-describedby={missingName ? 'merge-name-error' : undefined} />
        {missingName && <p id="merge-name-error" className="ui-field__error audience-merge-error" role="alert">Name the new list.</p>}
      </fieldset>
      <Checkbox checked={deleteSources} onCheckedChange={setDeleteSources} disabled={merge.isPending} label={existing ? others.length === 1 ? `Delete ${others[0]!.name}` : `Delete the other ${others.length} lists` : `Delete the ${lists.length} original lists`} />
      {/* The merged list's size as one Signal Log row: a fixed height while it counts, then its mono figure and what it adds. */}
      <div className="audience-merge-preview" aria-live="polite" aria-busy={preview.isPending || undefined}>
        {preview.isError ? <MutationError error={preview.error} />
          : <MetricRow label={existing ? target?.name : 'New list'} hint={preview.data && existing ? `+${number(added)}` : undefined} value={preview.data && !preview.isPending ? number(total) : <SkeletonText width={48} />} unit={preview.data && !preview.isPending ? (total === 1 ? 'member' : 'members') : undefined} />}
      </div>
      <MutationError error={merge.error} />
    </form>
  </Dialog>
}
