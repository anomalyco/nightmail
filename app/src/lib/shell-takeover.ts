import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { focusInPlace } from '../components/ui/scroll-fade'

/** A page its own file paints before the app's code (app/painted-page.ts: the same page in a shell over #root, with its
 *  CSS) goes as the app's page is first drawn, in the same frame and at the same place, so nothing moves and nothing the
 *  reader did is undone: the page's scroll stays, every box they scrolled (the contents, a code block sideways) is where
 *  they left it, their focus moves to the same control here, their selection selects the same words, the rows they
 *  opened stay open, what they typed or slid is set here, and a button they pressed while the app loaded (home/shell/
 *  boot.js holds it) is pressed here. A painted picker the reader has open (a native select's list) is theirs until they
 *  close it: boot.js follows their pick, and the takeover waits for it (only while it is open, which every current
 *  browser can tell, :open; where one can't, while it has focus, for 30 s at most).
 *  shell: the shell's id; page: the app's page under #root; ready: whether the app's page has all it shows (a reference
 *  page waits for the API definition and this installation's address, and the painted page stays over it until then).
 *  Whether there was one. */
export function useShellTakeover(shellId: string, page: string, ready = true) {
  const [painted] = useRef([typeof document !== 'undefined' && document.getElementById(shellId) !== null]).current
  const carried = useRef<{ typed: (string | null)[]; pressed: Place | null } | null>(null)
  const [, retry] = useState(0), waited = useRef<number | null>(null)
  useLayoutEffect(() => {
    const shell = document.getElementById(shellId)
    if (!shell || !ready) return
    const picking = document.activeElement instanceof HTMLSelectElement && shell.contains(document.activeElement) ? document.activeElement : null
    if (picking) {
      const open = isOpen(picking)
      waited.current ??= performance.now()
      if (open === true || (open === null && performance.now() - waited.current < 30_000)) { setTimeout(() => retry(n => n + 1), 250); return }
    }
    const focused = placeOf(shell, document.activeElement), opened = [...shell.querySelectorAll('details')].map(row => row.open)
    const scrolled = scrollsOf(shell.firstElementChild), selected = selectionIn(shell.firstElementChild)
    const held = window as Window & { __nightmailShellPress?: Element }
    carried.current = { typed: fields(shell).map(field => field.value !== initial(field) ? field.value : null), pressed: placeOf(shell, held.__nightmailShellPress) }
    delete held.__nightmailShellPress
    shell.remove()
    document.querySelector('[data-shell-css]')?.remove()
    // The rows the reader opened (a price page's questions, a legal page's contents) stay open, before the app's page is
    // first painted.
    const app = document.querySelector(page)
    app?.querySelectorAll('details').forEach((row, i) => { if (opened[i]) row.open = true })
    for (const box of scrolled) { const into = placed(app, box.key)[box.nth]; if (into) { into.scrollTop = box.top; into.scrollLeft = box.left } }
    if (selected && app) select(app, selected)
    const focus = atPlace(app, focused)
    if (focus) focusInPlace(focus)
  })
  useEffect(() => {
    const was = carried.current, app = document.querySelector(page)
    if (!was || !app) return
    carried.current = null
    // What the reader typed in a field or chose in a picker, set in the same field of the app's page as their own change.
    const inputs = fields(app)
    was.typed.forEach((value, i) => {
      const field = inputs[i]
      if (value === null || !field) return
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
      field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    })
    atPlace(app, was.pressed)?.click()
  })
  return painted
}
// The controls a reader can see: a painted page may draw one in two forms and show the one for the theme or the window (a
// legal page's theme switch, features/legal/prerender.tsx; a guide's tabs or picker, features/docs/prerender.tsx), where the
// app draws only that one.
const shown = (el: Element) => el.getClientRects().length > 0
// The fields and pickers a reader can see, in order, and what each held when the page arrived.
const fields = (root: ParentNode) => [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].filter(shown)
const initial = (field: HTMLInputElement | HTMLSelectElement) => field instanceof HTMLSelectElement ? [...field.options].find(option => option.defaultSelected)?.value ?? field.options[0]?.value ?? '' : field.defaultValue
// (A code block or box the reader can focus to scroll it by keyboard is one: tabindex="0".)
const controls = (root: ParentNode | null) => [...root?.querySelectorAll<HTMLElement>('a[href], button, input, select, [tabindex="0"]') ?? []].filter(shown)
// A control's place, the same on the painted page and the app's: which of the controls with its class it is (Get started
// and the Open dashboard drawn in its place for someone signed in share theirs), or for one without a class, of those
// with its tag, address and words. Not its place among all controls: signed in, the app's page has no sign-in consent
// and its links, so every control after them would be another one, pressed or focused in the reader's place.
type Place = { key: string; nth: number }
const keyOf = (control: HTMLElement) => control.className ? `.${control.className}` : `${control.tagName}|${control.getAttribute('href') ?? ''}|${control.textContent?.trim() ?? ''}`
function placeOf(root: ParentNode | null, control: Element | null | undefined): Place | null {
  const all = controls(root), at = all.indexOf(control as HTMLElement)
  if (at < 0) return null
  const key = keyOf(all[at]!)
  return { key, nth: all.slice(0, at).filter(other => keyOf(other) === key).length }
}
const atPlace = (root: ParentNode | null, place: Place | null) => place ? controls(root).filter(control => keyOf(control) === place.key)[place.nth] : undefined

// A box that scrolls (overflow auto or scroll, with more to show): its place among the boxes like it (its class, else its
// tag), and where it is scrolled to.
type Scrolled = { key: string; nth: number; top: number; left: number }
const boxKey = (el: HTMLElement) => typeof el.className === 'string' && el.className ? `.${el.className}` : el.tagName
const placed = (root: ParentNode | null, key: string) => [...root?.querySelectorAll<HTMLElement>('*') ?? []].filter(el => el instanceof HTMLElement && boxKey(el) === key && shown(el))
function scrollsOf(root: Element | null): Scrolled[] {
  const seen = new Map<string, number>(), boxes: Scrolled[] = []
  for (const el of root?.querySelectorAll<HTMLElement>('*') ?? []) {
    if (!(el instanceof HTMLElement) || !shown(el)) continue
    const key = boxKey(el), nth = seen.get(key) ?? 0
    seen.set(key, nth + 1)
    if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) continue
    const style = getComputedStyle(el)
    if (/auto|scroll/.test(style.overflowX + style.overflowY)) boxes.push({ key, nth, top: el.scrollTop, left: el.scrollLeft })
  }
  return boxes
}
// A selection inside the painted page, as offsets into the text a reader sees there, which the app's page has the same of.
const seenText = (root: Element) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement && shown(node.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT })
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}
function selectionIn(root: Element | null): [number, number] | null {
  const selection = getSelection()
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  let seen = 0, start = -1, end = -1
  for (const node of seenText(root)) {
    if (node === range.startContainer) start = seen + range.startOffset
    if (node === range.endContainer) end = seen + range.endOffset
    seen += node.data.length
  }
  return start >= 0 && end >= 0 ? [start, end] : null
}
function select(root: Element, [start, end]: [number, number]) {
  const range = document.createRange()
  let seen = 0, began = false
  for (const node of seenText(root)) {
    const length = node.data.length
    // A start where one text ends and the next begins is at the next one's start: the words selected, not the line before.
    if (!began && start < seen + length) { range.setStart(node, start - seen); began = true }
    if (began && end <= seen + length) { range.setEnd(node, end - seen); getSelection()?.removeAllRanges(); getSelection()?.addRange(range); return }
    seen += length
  }
}
// Whether a select's list is open (:open), or null where the browser can't tell.
function isOpen(select: HTMLSelectElement): boolean | null {
  try { return select.matches(':open') } catch { return null }
}
