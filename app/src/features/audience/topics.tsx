import { useState } from 'react'
import { useApiMutation, useApiQuery, useWorkspaceAccess } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import type { Topic } from '../../data/types'
import { Button, Checkbox, ConfirmDialog, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, Field, Input, Select, Textarea, fieldError, MutationError } from '../../components/ui'
import { topicColumns } from './skeletons'
import { date, number } from './shared'
import { AudienceHeader } from './header'

// Who gets a topic's mail without having chosen, fixed when the topic is made (the API's subscribedByDefault).
export const topicDefault = (topic: Pick<Topic, 'subscribedByDefault'>) => topic.subscribedByDefault ? 'Everyone subscribed, until they opt out' : 'Only people who opt in'
const views = [{ value: 'active', label: 'Active topics' }, { value: 'archived', label: 'Archived topics' }]

// Topics: the kinds of marketing mail the workspace sends. A send or campaign may name one, and its unsubscribe link then
// opts a person out of that topic alone. Archived topics leave pickers and the preference page and can come back.
export function TopicsPage() {
  const [view, setView] = useState<'active' | 'archived'>('active')
  const [editing, setEditing] = useState<Topic | 'new' | null>(null)
  const [archiving, setArchiving] = useState<Topic | null>(null)
  const { canAdminister } = useWorkspaceAccess()
  const query = useApiQuery(['topics', view], (api, signal) => api.topics.list({ archived: view === 'archived' }, signal))
  // The counts are their own read, after the topics: the table shows at once and each count fills its dash in place.
  const counted = useApiQuery(['topics', view, 'counts'], (api, signal) => api.topics.list({ archived: view === 'archived', counts: true }, signal))
  const choices = (topic: Topic) => { const counts = counted.data?.find(row => row.id === topic.id)?.counts; return counts ? topic.subscribedByDefault ? `${number(counts.optedOut)} opted out` : `${number(counts.optedIn)} opted in` : null }
  const archive = useApiMutation((api, input: { id: string; archived: boolean }) => api.topics.update(input.id, { archived: input.archived }), undefined, false, invalidate.topics)
  const menu = (topic: Topic) => canAdminister && <DropdownMenu label={`Actions for ${topic.name}`} title={topic.name} items={view === 'active'
    ? [{ label: 'Edit', onSelect: () => setEditing(topic) }, { label: 'Archive', destructive: true, onSelect: () => { archive.reset(); setArchiving(topic) } }]
    : [{ label: 'Restore', onSelect: () => void archive.mutateAsync({ id: topic.id, archived: false }).catch(() => {}) }]} />
  return <div className="audience-page"><AudienceHeader actions={canAdminister && <Button variant="primary" onClick={() => setEditing('new')}>Create topic</Button>} />
    <div className="data-toolbar"><Select className="audience-status-filter" aria-label="Show" value={view} onValueChange={value => setView(value as 'active' | 'archived')} options={views} /></div>
    <MutationError error={view === 'archived' ? archive.error : null} />
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <DataTable className="audience-topics" rows={query.data ?? []} loading={query.isPending} skeletonRows={5} minRows={5} rowKey={row => row.id} empty={view === 'archived' ? <EmptyState title="No archived topics" /> : <EmptyState title="No topics yet" action={canAdminister ? <Button onClick={() => setEditing('new')}>Create topic</Button> : undefined} />}
      columns={[{ ...topicColumns[0], render: row => <span className="audience-cell-text" title={row.name}>{row.name}</span> }, { ...topicColumns[1], render: row => row.description ? <span className="audience-cell-text" title={row.description}>{row.description}</span> : '—', cardRender: row => row.description || null },
        { ...topicColumns[2], render: row => <span className="audience-cell-text" title={topicDefault(row)}>{topicDefault(row)}</span>, cardRender: row => topicDefault(row) }, { ...topicColumns[3], render: row => <span className="audience-count" title={counted.data && !choices(row) ? 'Couldn’t count in time' : undefined}>{choices(row) ?? '—'}</span>, cardRender: row => choices(row) ?? '—' },
        { ...topicColumns[4], render: row => date(row.createdAt) }, { ...topicColumns[5], render: row => menu(row) || null }]} />}
    {editing && <TopicEditor topic={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    <ConfirmDialog open={!!archiving} onOpenChange={open => { if (!open) setArchiving(null) }} title={`Archive ${archiving?.name ?? 'topic'}?`} description="New emails can’t use it and it leaves the preference page. Campaigns already sent with it keep skipping the people who opted out." confirmLabel="Archive topic" danger pending={archive.isPending} onConfirm={async () => { await archive.mutateAsync({ id: archiving!.id, archived: true }); setArchiving(null) }} />
  </div>
}

function TopicEditor({ topic, onClose }: { topic?: Topic; onClose: () => void }) {
  const [name, setName] = useState(topic?.name ?? '')
  const [description, setDescription] = useState(topic?.description ?? '')
  const [everyone, setEveryone] = useState(true)
  const save = useApiMutation((api, input: { name: string; description: string }) => topic ? api.topics.update(topic.id, input) : api.topics.create({ ...input, subscribedByDefault: everyone }), topic ? 'Topic updated' : 'Topic created', false, invalidate.topics)
  async function submit() { try { await save.mutateAsync({ name: name.trim(), description: description.trim() }); onClose() } catch { /* Shown inline. */ } }
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose() }} title={topic ? 'Edit topic' : 'Create topic'} footer={<><Button disabled={save.isPending} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="topic-editor" loading={save.isPending}>{topic ? 'Save changes' : 'Create topic'}</Button></>}>
    <form id="topic-editor" className="stack" onSubmit={event => { event.preventDefault(); void submit() }}>
      <MutationError error={save.error} />
      <Field label="Name" htmlFor="topic-name" error={fieldError(save.error, 'name')}><Input autoFocus id="topic-name" required maxLength={100} placeholder="Product updates" value={name} onChange={event => setName(event.target.value)} /></Field>
      <Field label="Description" htmlFor="topic-description" error={fieldError(save.error, 'description')}><Textarea id="topic-description" rows={2} maxLength={300} placeholder="New features, about once a month" value={description} onChange={event => setDescription(event.target.value)} /></Field>
      {topic ? <Field label="Who gets it"><p className="muted">{topicDefault(topic)}. This is set when a topic is made.</p></Field>
        : <Field label="Who gets it"><Checkbox checked={everyone} onCheckedChange={setEveryone} label="Everyone subscribed to marketing, until they opt out" /><p className="muted">{everyone ? 'Turn this off for a topic only people who opt in get.' : 'Only people who opt in get it.'} This can’t change later.</p></Field>}
    </form>
  </Dialog>
}
