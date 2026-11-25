import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useApiMutation, useWorkspaceAccess } from '../../data/context'
import { invalidate } from '../../data/invalidation'
import { ApiError, type ImportPreview, type RiskBreakdown } from '../../data/types'
import { Alert, Button, Checkbox, DataTable, Dialog, Field, Input, Select, fieldError, MutationError } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { evidenceRequired, ListPicker, nameTitle, number, riskBreakdown } from './shared'
import { AddressText } from '../../components/AddressText'
import { csvRows } from './csv'

// Columns the API imports, plus Last name, which only feeds Full name (the API has no last-name field). Headings are
// matched without case, spaces, dashes or underscores, so `first_name`, `First Name` and `firstname` all map.
const targets = [
  { value: 'email', label: 'Email (required)', aliases: ['email', 'emailaddress', 'mail'] },
  { value: 'name', label: 'Full name', aliases: ['name', 'fullname', 'contactname'] },
  { value: 'firstName', label: 'First name', aliases: ['firstname', 'first', 'givenname', 'forename'] },
  { value: 'lastName', label: 'Last name', aliases: ['lastname', 'last', 'surname', 'familyname'] },
  { value: 'plan', label: 'Plan', aliases: ['plan', 'tier'] },
  { value: 'country', label: 'Country', aliases: ['country', 'countrycode'] },
]
const COMBINED = '\u0000first-last'
// A file of up to 1,000,000 rows and 100 MiB goes up in parts the API takes (POST /v1/contact-imports: 50,000 rows and
// 5 MiB each), each previewed and then committed in order; rows keep the file's numbers. A row without an email, or one
// that repeats an earlier row's email, is skipped here, as the API would skip it, naming the earlier row.
const MAX_ROWS = 1_000_000, MAX_FILE_BYTES = 100 * 1024 * 1024, PART_ROWS = 50_000, PART_BYTES = 5 * 1024 * 1024 - 65_536
const sample = 'email,name,first_name,plan,country\nada@example.com,Ada Lovelace,Ada,pro,GB\ngrace@example.com,Grace Hopper,Grace,free,US\n'
const sampleHref = `data:text/csv;charset=utf-8,${encodeURIComponent(sample)}`
const quote = (value: string) => /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
const plural = (count: number, word: string) => `${number(count)} ${word}${count === 1 ? '' : 's'}`
const utf8Bytes = (value: string) => { let bytes = value.length; for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); if (code >= 0x80) bytes += code >= 0x800 && (code < 0xd800 || code > 0xdfff) ? 2 : 1 } return bytes }

type Issue = ImportPreview['errors'][number]
type Part = { csv: string; rows: number[]; skipped: Issue[] }
/** What the parts' previews found together: their IDs in order, the valid rows, the first ten of them and of the errors. */
type Review = { ids: string[]; total: number; rows: ImportPreview['rows']; errors: Issue[]; errorCount: number; risky: RiskBreakdown | null }
type Imported = { imported: number; subscribed: number; errors: Issue[]; errorCount: number; risky: RiskBreakdown | null }
// The parts' risky counts together (list hygiene): null while no part reported any.
function addRisky(sum: RiskBreakdown | null, part: RiskBreakdown | null | undefined): RiskBreakdown | null {
  if (!part) return sum
  const byReason = { ...part.byReason }
  if (sum) for (const reason of Object.keys(byReason) as (keyof typeof byReason)[]) byReason[reason] += sum.byReason[reason] ?? 0
  return { total: (sum?.total ?? 0) + part.total, byReason }
}
// "3,412 risky addresses" and "3,100 disposable, 290 mistyped, 22 role". Nothing when there are none.
const riskyCount = (risky: RiskBreakdown | null) => risky?.total ? `${number(risky.total)} risky ${risky.total === 1 ? 'address' : 'addresses'}` : null
const riskySkipped = 'They’re imported, but campaigns skip them.'

// The mapping the API gets and the file's parts. Full name from first and last name is one more column holding "first
// last" (a contact without either keeps no name).
function importParts(text: string, mapping: Record<string, string>) {
  const rows = csvRows(text), header: string[] = rows.next().value || [], headings = header.map(h => h.trim())
  const selected = Object.fromEntries(Object.entries(mapping).filter(([key, value]) => value && key !== 'lastName' && value !== COMBINED))
  let column = ''
  if (mapping.name === COMBINED) { column = 'Full name'; for (let n = 2; headings.includes(column); n++) column = `Full name (${n})`; selected.name = column }
  const first = headings.indexOf(mapping.firstName), last = headings.indexOf(mapping.lastName), email = headings.indexOf(mapping.email)
  const fullName = (row: string[]) => [first >= 0 ? row[first] : '', last >= 0 ? row[last] : ''].map(value => value?.trim() ?? '').filter(Boolean).join(' ')
  const line = (cells: string[]) => cells.map(quote).join(',')
  const top = line(column ? [...header, column] : header), topBytes = utf8Bytes(top)
  function* parts(): Generator<Part> {
    const earlier = new Map<string, number>(), current = new Map<string, number>()
    let lines: string[] = [], numbers: number[] = [], skipped: Issue[] = [], bytes = topBytes, row = 1
    for (const cells of rows) {
      row++
      const key = (cells[email] ?? '').trim().toLowerCase(), text = line(column ? [...cells, fullName(cells)] : cells), size = utf8Bytes(text) + 1
      if (lines.length && (lines.length >= PART_ROWS || bytes + size > PART_BYTES)) {
        yield { csv: `${top}\n${lines.join('\n')}`, rows: numbers, skipped }
        for (const [seen, first] of current) earlier.set(seen, first)
        current.clear(); lines = []; numbers = []; skipped = []; bytes = topBytes
      }
      if (!key) { skipped.push({ row, field: 'email', message: 'Email is empty' }); continue }
      const first = earlier.get(key) ?? current.get(key)
      if (first !== undefined) { skipped.push({ row, field: 'email', message: `Same email as row ${first}` }); continue }
      lines.push(text); numbers.push(row); bytes += size
      current.set(key, row)
    }
    yield { csv: lines.length ? `${top}\n${lines.join('\n')}` : '', rows: numbers, skipped }
  }
  return { mapping: selected, parts: parts() }
}
const firstIssues = (issues: Issue[]) => issues.sort((a, b) => a.row - b.row).slice(0, 10)
// The API can name one row twice (a blank email is invalid and not ASCII): the first message is enough, and the count counts rows.
const onePerRow = (issues: Issue[]) => { const seen = new Set<number>(); return issues.filter(issue => !seen.has(issue.row) && Boolean(seen.add(issue.row))) }

// Wait up to a bounded number of retries when another upload in the workspace hits the 40/min preview budget (429) or
// holds the per-workspace commit lock (503 IMPORT_COMMIT_BUSY), so concurrent multi-part uploads finish instead of failing.
const BUSY_BACKOFF_MS = [1500, 3000, 5000, 8000, 12000, 15000]
function sleepAbortable(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
async function withImportRetry<T>(work: () => Promise<T>, signal: AbortSignal, onWait: (message: string) => void): Promise<T> {
  let rateTries = 0, busyTries = 0, truncatedTries = 0
  for (;;) {
    try { return await work() } catch (err) {
      if (!(err instanceof ApiError) || signal.aborted) throw err
      if ((err.status === 429 || err.code === 'IMPORT_PREVIEW_RATE_LIMITED') && rateTries < 5) {
        rateTries++
        const waitSec = Math.min(65, Math.max(5, err.retryAfter ?? 60))
        onWait(`Preview limit reached — retrying in ${waitSec}s…`)
        await sleepAbortable(waitSec * 1000 + Math.round(Math.random() * 1500), signal)
        onWait('Retrying…')
        continue
      }
      if ((err.code === 'IMPORT_COMMIT_BUSY' || (err.status === 503 && err.retryable)) && busyTries < 16) {
        const base = BUSY_BACKOFF_MS[Math.min(busyTries, BUSY_BACKOFF_MS.length - 1)]!
        busyTries++
        onWait('Another import is finishing — waiting to continue…')
        await sleepAbortable(base + Math.round(Math.random() * 1000), signal)
        onWait('Retrying…')
        continue
      }
      if (err.code === 'INVALID_RESPONSE' && err.retryable && truncatedTries < 2) {
        truncatedTries++
        onWait('Response cut short — retrying…')
        await sleepAbortable(1000 * truncatedTries, signal)
        onWait('Retrying…')
        continue
      }
      throw err
    }
  }
}

export function ImportContactsDialog({ listId: initialListId = '', onClose }: { listId?: string; onClose: () => void }) {
  // Adding contacts to a list is an owner's or admin's call (the API wants manage for a list import); members import without one.
  const { canAdminister } = useWorkspaceAccess()
  const [listId, setListId] = useState(canAdminister ? initialListId : '')
  // The file's text stays out of the mutations' inputs: each write's input is serialized to guard against a double submit.
  const source = useRef(''), committed = useRef(new Map<number, ImportPreview>())
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    abortRef.current = controller
    return () => controller.abort()
  }, [])
  const [csv, setCsv] = useState(false), [rowCount, setRowCount] = useState(0), [headers, setHeaders] = useState<string[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({}), [fileError, setFileError] = useState<unknown>(null), [reading, setReading] = useState(false)
  const [consent, setConsent] = useState(false), [evidence, setEvidence] = useState(''), [checked, setChecked] = useState(false)
  const [preview, setPreview] = useState<Review | null>(null), [result, setResult] = useState<Imported | null>(null), [progress, setProgress] = useState('')
  // Consent belongs to the whole import: once a part is in, the rest commit with the same choice.
  const [started, setStarted] = useState(false)
  const review = useApiMutation(async (api, input: { mapping: Record<string, string>; listId?: string }) => {
    const signal = abortRef.current?.signal ?? new AbortController().signal
    const { mapping: selected, parts } = importParts(source.current, input.mapping)
    const found: Review = { ids: [], total: 0, rows: [], errors: [], errorCount: 0, risky: null }
    const note = (issues: Issue[]) => { found.errorCount += issues.length; found.errors = firstIssues([...found.errors, ...issues]) }
    let done = 0
    for (const part of parts) {
      note(part.skipped)
      done += part.rows.length + part.skipped.length
      if (!part.csv) continue
      const answer = await withImportRetry(() => api.imports.preview({ csv: part.csv, mapping: selected, ...(input.listId ? { listId: input.listId } : {}) }, signal), signal, setProgress)
      const fileRow = (row: number) => part.rows[row - 2] ?? row
      found.ids.push(answer.id); found.total += answer.rows.length; found.risky = addRisky(found.risky, answer.risky)
      found.rows.push(...answer.rows.slice(0, 10 - found.rows.length).map(item => ({ ...item, row: fileRow(item.row) })))
      note(onePerRow(answer.errors).map(issue => ({ ...issue, row: fileRow(issue.row) })))
      if (done < rowCount) setProgress(`Checked ${number(done)} of ${number(rowCount)} rows`)
    }
    return found
  }, undefined, false, false)
  // Parts commit in order. One that failed is retried from where it stopped: a committed part isn't sent again.
  // If another concurrent upload evicted an uncommitted preview past the 50-preview cap (404), re-preview that part on the fly.
  const commit = useApiMutation(async (api, input: { ids: string[]; mapping: Record<string, string>; listId?: string; evidence?: string }) => {
    const signal = abortRef.current?.signal ?? new AbortController().signal
    let imported = 0, subscribed = 0, risky: RiskBreakdown | null = null
    let fallbackParts: { mapping: Record<string, string>; csvs: string[] } | null = null
    const getPartCsv = (index: number) => {
      if (!fallbackParts) {
        const built = importParts(source.current, input.mapping)
        fallbackParts = { mapping: built.mapping, csvs: [...built.parts].filter(p => p.csv).map(p => p.csv) }
      }
      return { mapping: fallbackParts.mapping, csv: fallbackParts.csvs[index] }
    }
    for (const [index, initialId] of input.ids.entries()) {
      let answer = committed.current.get(index)
      if (!answer) {
        const payload = input.evidence ? { consent: { status: 'subscribed' as const, evidence: input.evidence } } : undefined
        let partId = initialId
        for (let refreshes = 0; ; refreshes++) {
          try {
            answer = await withImportRetry(() => api.imports.commit(partId, payload, signal), signal, setProgress)
            break
          } catch (err) {
            if (!(err instanceof ApiError && err.status === 404) || refreshes >= 3) throw err
            const part = getPartCsv(index)
            if (!part.csv) throw err
            setProgress(`Refreshing part ${index + 1} of ${input.ids.length}…`)
            const refreshed = await withImportRetry(() => api.imports.preview({ csv: part.csv!, mapping: part.mapping, ...(input.listId ? { listId: input.listId } : {}) }, signal), signal, setProgress)
            partId = refreshed.id
          }
        }
        committed.current.set(index, answer)
        setStarted(true)
      }
      imported += answer.imported; subscribed += answer.subscribed ?? 0; risky = addRisky(risky, answer.risky)
      if (index + 1 < input.ids.length) setProgress(`Imported part ${index + 1} of ${input.ids.length}`)
    }
    return { imported, subscribed, risky }
  }, undefined, false, invalidate.audienceBulk)
  function resetPreview() { setPreview(null); setProgress(''); setStarted(false); committed.current.clear(); review.reset(); commit.reset() }
  async function readFile(file?: File) {
    if (!file) return
    resetPreview(); source.current = ''; setCsv(false); setRowCount(0); setHeaders([]); setFileError(null); setReading(true)
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error('This file is larger than 100 MiB. Split it into smaller files.')
      const raw = await file.text(), rows = csvRows(raw), first: string[] = rows.next().value || [], heading = first.map(h => h.trim())
      let count = 0
      while (!rows.next().done) count++
      if (!count) throw new Error('Choose a CSV with a header and at least one contact row.')
      if (count > MAX_ROWS) throw new Error(`This file has ${number(count)} rows. Import at most ${number(MAX_ROWS)} at a time.`)
      if (heading.some(h => !h)) throw new Error('Every column needs a heading in the first row.')
      if (new Set(heading).size !== heading.length) throw new Error('Give every column a different heading in the first row.')
      source.current = raw; setCsv(true); setRowCount(count); setHeaders(heading)
      const detected = Object.fromEntries(targets.map(target => [target.value, heading.find(h => target.aliases.includes(h.toLowerCase().replace(/[ _-]/g, ''))) ?? '']))
      if (!detected.name && (detected.firstName || detected.lastName)) detected.name = COMBINED
      setMapping(detected)
    } catch (cause) { setFileError(cause) } finally { setReading(false) }
  }
  async function submitPreview() {
    try { setPreview(await review.mutateAsync({ mapping, ...(listId ? { listId } : {}) })) } catch { /* Shown inline. */ }
    finally { setProgress('') }
  }
  async function submitImport() {
    setChecked(true)
    if (!preview || (consent && !evidence.trim())) return
    try {
      const done = await commit.mutateAsync({ ids: preview.ids, mapping, ...(listId ? { listId } : {}), evidence: consent ? evidence.trim() : undefined })
      setResult({ ...done, errors: preview.errors, errorCount: preview.errorCount })
    } catch { /* Shown inline. */ }
    finally { setProgress('') }
  }
  const busy = reading || review.isPending || commit.isPending
  const locked = busy || Boolean(preview)
  const combinedAvailable = Boolean(mapping.firstName || mapping.lastName || mapping.name === COMBINED)
  function handleCancel() {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setProgress('')
    onClose()
  }
  const visibleError = (cause: unknown) => cause instanceof DOMException && cause.name === 'AbortError' ? null : cause
  const error = fileError || visibleError(review.error) || visibleError(commit.error)
  const unknownHref = listId ? `/audience/lists/${listId}?status=unknown` : '/audience?status=unknown'
  const riskyHref = listId ? `/audience/lists/${listId}?status=risky` : '/audience?status=risky'
  if (result) {
    const imported = result.imported, subscribed = result.subscribed ?? 0, risky = riskyCount(result.risky)
    return <Dialog open onOpenChange={open => { if (!open) onClose() }} title="Import complete" footer={<>{!consent && imported > 0 && <Link className="ui-button ui-button--secondary ui-button--md" to={unknownHref} onClick={onClose}>Review unknown contacts</Link>}<Button variant="primary" onClick={onClose}>Done</Button></>}><div className="stack audience-result">
      <p>{plural(imported, 'contact')} imported{consent ? ` · ${number(subscribed)} marked subscribed${subscribed < imported ? ` · ${number(imported - subscribed)} kept their earlier consent` : ''}` : ''}.</p>
      {!consent && imported > 0 && <p>They can’t receive campaigns until they consent. Once they do, choose Review unknown contacts, then Mark as subscribed.</p>}
      {risky && <p>{risky}: {riskBreakdown(result.risky!.byReason, number)}. {riskySkipped} <Link to={riskyHref} onClick={onClose}>Review them</Link></p>}
      {result.errorCount > 0 && <RejectedRows errors={result.errors} count={result.errorCount} skipped />}
    </div></Dialog>
  }
  return <Dialog className="audience-import-dialog" open onOpenChange={open => { if (!open && !reading) handleCancel() }} title="Import contacts" footer={<>{progress && <p className="muted audience-import-status" role="status">{progress}</p>}<Button disabled={reading} onClick={handleCancel}>Cancel</Button>{preview ? <Button variant="primary" loading={commit.isPending} disabled={busy || !preview.total} onClick={() => void submitImport()}>{preview.total ? `Import ${plural(preview.total, 'contact')}` : 'Nothing to import'}</Button> : <Button variant="primary" loading={busy} disabled={!csv || !mapping.email} onClick={() => void submitPreview()}>Preview import</Button>}</>}>
    <div className="stack">
      <div className="stack audience-import-fields" hidden={Boolean(preview)}>
        {/* The columns are the mapping below once a file is read; the row and size limits are the file's errors. */}
        <Field label="Add to list" htmlFor="import-list" hint={canAdminister ? undefined : 'Only owners and admins can add contacts to a list.'}><ListPicker id="import-list" emptyLabel="No list" value={listId} disabled={locked || !canAdminister} onChange={value => { setListId(value); resetPreview() }} /></Field>
        <Field label="CSV file" htmlFor="import-file"><div className="audience-import-file"><Input type="file" id="import-file" accept=".csv,text/csv" disabled={locked} onClick={event => { event.currentTarget.value = '' }} onChange={event => void readFile(event.target.files?.[0])} /><a className="ui-button ui-button--ghost ui-button--md" href={sampleHref} download="contacts-sample.csv">Sample CSV</a></div></Field>
        {csv && <div className="form-grid">{targets.map(target => <Field key={target.value} label={target.label} htmlFor={`map-${target.value}`} error={fieldError(review.error, `mapping.${target.value}`)}>
          <Select id={`map-${target.value}`} disabled={locked} value={mapping[target.value] ?? ''} onValueChange={value => { setMapping({ ...mapping, [target.value]: value }); resetPreview() }} options={[{ value: '', label: 'Do not import' }, ...(target.value === 'name' && combinedAvailable ? [{ value: COMBINED, label: 'First + last name' }] : []), ...headers.map(header => ({ value: header, label: header }))]} />
        </Field>)}</div>}
      </div>
      {preview && <>
        {/* The first 10 rows; the import button counts them all. */}
        <div className="cluster audience-review-bar"><Button size="sm" disabled={busy} onClick={resetPreview}>Change mapping</Button></div>
        {preview.rows.length > 0 && <DataTable className="audience-import-preview" rows={preview.rows} rowKey={row => String(row.row)} columns={[{ key: 'row', label: 'Row', width: '16%', card: 'aside', render: row => row.row, cardRender: row => `Row ${row.row}` }, { key: 'email', label: 'Email', width: '50%', card: 'title', render: row => <span className="audience-cell-text"><PrivateAddress value={row.email} /></span> }, { key: 'name', label: 'Full name', width: '34%', card: 'line', render: row => <span className="audience-cell-text" title={nameTitle(row.name)}>{row.name ? <AddressText text={row.name} /> : '—'}</span> }]} />}
        {preview.errorCount > 0 && <RejectedRows errors={preview.errors} count={preview.errorCount} />}
        {riskyCount(preview.risky) && <Alert tone="warning" title={riskyCount(preview.risky)}>{riskBreakdown(preview.risky!.byReason, number)}. {riskySkipped}</Alert>}
      </>}
      <div className="audience-consent">
        {/* The consequence is in the label; opt-outs and suppressions stay, and the result says how many kept their consent. */}
        <Checkbox checked={consent} disabled={busy || started} onCheckedChange={value => { setConsent(value); setChecked(false) }} label="They agreed to receive marketing email" />
        {consent && <Field label="How did they agree?" htmlFor="import-evidence" error={checked && !evidence.trim() ? evidenceRequired : fieldError(commit.error, 'consent.evidence')}><Input id="import-evidence" autoFocus maxLength={2000} placeholder="Signed up on our website" disabled={busy || started} value={evidence} onChange={event => setEvidence(event.target.value)} /></Field>}
      </div>
      <MutationError error={error} />
    </div>
  </Dialog>
}

function RejectedRows({ errors, count, skipped = false }: { errors: Issue[]; count: number; skipped?: boolean }) {
  const rows = <>{errors.slice(0, 10).map((issue, index) => <div key={index}>Row {issue.row}: {issue.message}</div>)}{count > 10 && <div>and {number(count - 10)} more</div>}</>
  // After the import the rows are a plain record; before it, a warning.
  if (skipped) return <div><p>{plural(count, 'row')} skipped</p><div className="muted">{rows}</div></div>
  return <Alert tone="warning" title={`${plural(count, 'row')} will be skipped`}>{rows}</Alert>
}
