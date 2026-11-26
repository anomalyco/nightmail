import type { CampaignInput } from '../../data/types'
import { blockHtmlToDocument, documentToBlockHtml } from './block-content'

// Two people saving one draft: what this person changed since the version they started from (base), laid over the
// version someone else saved since (theirs), field by field. A field only one side changed takes that side's value; a
// field both changed differently is a conflict, settled by `prefer`. The message is one field. Whether this person
// edited it comes from the composer (bodyEdited); whether the other did is read through the composer's own import and
// export, because every save from the composer rewrites the HTML even when nobody touched the message (an agent's
// HTML, or HTML from before the block vocabulary, comes back in its exported form). Attachments merge as a set, and
// fallbacks key by key.
const groups = {
  name: ['name'], sender: ['fromName', 'fromEmail', 'regionId'], replyTo: ['replyTo'], subject: ['subject'], previewText: ['previewText'],
  audience: ['listId', 'segmentId', 'topicId'], unsubscribePageUrl: ['unsubscribePageUrl'], requiredNotice: ['requiredNotice'],
} as const satisfies Record<string, readonly (keyof CampaignInput)[]>
export type MergeField = keyof typeof groups | 'html' | 'defaults'
export type Merged = { input: CampaignInput; conflicts: MergeField[]; taken: Set<MergeField> }

// Values as a save sends them: trimmed text, and blank, null, false and absent alike.
function normal(value: unknown): unknown {
  if (typeof value === 'string') return value.trim() || null
  if (Array.isArray(value)) return value.map(normal)
  return value === undefined || value === false || value === '' ? null : value
}
const same = (a: unknown, b: unknown) => JSON.stringify(normal(a)) === JSON.stringify(normal(b))
const exported = new Map<string, string>()
function asExported(html: string) {
  let value = exported.get(html)
  if (value === undefined) { value = documentToBlockHtml(blockHtmlToDocument(html)); if (exported.size > 8) exported.clear(); exported.set(html, value) }
  return value
}
const sameMessage = (a: string, b: string) => a === b || asExported(a) === asExported(b)
const fallbacks = (input: CampaignInput) => Object.fromEntries(Object.entries(input.defaults ?? {}).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value))

export function mergeCampaign(base: CampaignInput, mine: CampaignInput, theirs: CampaignInput, bodyEdited: boolean, prefer: 'mine' | 'theirs'): Merged {
  const input: CampaignInput = { ...mine, id: theirs.id, revision: theirs.revision, draft: theirs.draft }
  const conflicts: MergeField[] = [], taken = new Set<MergeField>()
  const set = input as Record<string, unknown>
  for (const [field, keys] of Object.entries(groups) as [MergeField, readonly (keyof CampaignInput)[]][]) {
    // The region follows the sender's address (and a new draft's form never learns the one the server chose): only
    // the name and address count as this person's change.
    const mineChanged = keys.some(key => key !== 'regionId' && !same(mine[key], base[key])), theirsChanged = keys.some(key => !same(theirs[key], base[key]))
    if (!theirsChanged || keys.every(key => same(mine[key], theirs[key]))) continue
    if (mineChanged) conflicts.push(field)
    if (!mineChanged || prefer === 'theirs') { for (const key of keys) set[key] = theirs[key]; taken.add(field) }
  }
  if (!sameMessage(theirs.html, base.html)) {
    if (bodyEdited) conflicts.push('html')
    if (!bodyEdited || prefer === 'theirs') { input.html = theirs.html; taken.add('html') }
  } else if (!bodyEdited) input.html = theirs.html // their bytes, where they differ only in what the composer's export evens out
  const [b, m, t] = [fallbacks(base), fallbacks(mine), fallbacks(theirs)], defaults: Record<string, string> = {}
  for (const key of new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(t)])) {
    const theirsChanged = t[key] !== b[key], mineChanged = m[key] !== b[key]
    if (theirsChanged && mineChanged && m[key] !== t[key]) { if (!conflicts.includes('defaults')) conflicts.push('defaults') }
    const value = theirsChanged && (!mineChanged || prefer === 'theirs') ? t[key] : m[key]
    if (value !== m[key]) taken.add('defaults')
    if (value) defaults[key] = value
  }
  input.defaults = defaults
  // Theirs, plus what this person added, minus what this person removed.
  const before = new Set(base.attachments ?? []), now = new Set(mine.attachments ?? [])
  const attachments = [...new Set([...(theirs.attachments ?? []).filter(id => !before.has(id) || now.has(id)), ...[...now].filter(id => !before.has(id))])]
  input.attachments = attachments
  return { input, conflicts, taken }
}

const labels: Record<MergeField, string> = { name: 'the name', sender: 'the sender', replyTo: 'the reply-to address', subject: 'the subject', previewText: 'the inbox preview', audience: 'the recipients', unsubscribePageUrl: 'the unsubscribe page', requiredNotice: 'the campaign kind', html: 'the message', defaults: 'the fallbacks' }
/** "the subject and the message", for a sentence. */
export const mergeFieldsText = (fields: MergeField[]) => { const words = fields.map(field => labels[field]); return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0] ?? '' }
