import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** A page its own file paints before the app's code (app/painted-page.ts: the same page in a shell over #root, with its
 *  CSS) goes as the app's page is first drawn, in the same frame and at the same place, so nothing moves and nothing the
 *  reader did is undone: the page's scroll stays, every box they scrolled (the contents, a code block sideways) is where
 *  they left it, their focus moves to the same control here, their selection selects the same words, the rows they
 *  opened stay open, what they typed or slid is set here, and a button they pressed while the app loaded (home/shell/
 *  boot.js holds it) is pressed here. A painted picker the reader has open (a native select) is theirs until they close
 *  it: boot.js follows their pick, and the takeover waits.
 *  shell: the shell's id; page: the app's page under #root; ready: whether the app's page has all it shows (a reference
 *  page waits for the API definition and this installation's address, and the painted page stays over it until then).
 *  Whether there was one. */
export function useShellTakeover(shellId: string, page: string, ready = true) {
  const [painted] = useRef([typeof document !== 'undefined' && document.getElementById(shellId) !== null]).current
  const carried = useRef<{ typed: (string | null)[]; pressed: Place | null } | null>(null)
  const [, retry] = useState(0)
  useLayoutEffect(() => {
    const shell = document.getElementById(shellId)
    if (!shell || !ready) return
    const picking = document.activeElement instanceof HTMLSelectElement && shell.contains(document.activeElement) ? document.activeElement : null
    if (picking) { picking.addEventListener('blur', () => retry(n => n + 1), { once: true }); return }
    const focused = placeOf(shell, document.activeElement), opened = [...shell.querySelectorAll('details')].map(row => row.open)
    const scrolled = scrollsOf(shell.firstElementChild), selected = selectionIn(shell.firstElementChild)
    const held = window as Window & { __nightmailShellPress?: Element }
    carried.current = { typed: [...shell.querySelectorAll('input')].map(input => input.value !== input.defaultValue ? input.value : null), pressed: placeOf(shell, held.__nightmailShellPress) }
    delete held.__nightmailShellPress
    shell.remove()
    document.querySelector('[data-shell-css]')?.remove()
    // The rows the reader opened (a price page's questions, a legal page's contents) stay open, before the app's page is
    // first painted.
    const app = document.querySelector(page)
    app?.querySelectorAll('details').forEach((row, i) => { if (opened[i]) row.open = true })
    for (const box of scrolled) { const into = placed(app, box.key)[box.nth]; if (into) { into.scrollTop = box.top; into.scrollLeft = box.left } }
    if (selected && app) select(app, selected)
    atPlace(app, focused)?.focus({ preventScroll: true })
  })
  useEffect(() => {
    const was = carried.current, app = document.querySelector(page)
    if (!was || !app) return
    carried.current = null
    const inputs = [...app.querySelectorAll('input')], setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    was.typed.forEach((value, i) => { const input = inputs[i]; if (value !== null && input) { setValue.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) } })
    atPlace(app, was.pressed)?.click()
  })
  return painted
}
// The controls a reader can see: a painted page may draw one in two forms and show the one for the theme (a legal page's
// theme switch, features/legal/prerender.tsx), where the app draws only that one.
const controls = (root: ParentNode | null) => [...root?.querySelectorAll<HTMLElement>('a[href], button, input') ?? []].filter(control => control.getClientRects().length > 0)
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
const placed = (root: ParentNode | null, key: string) => [...root?.querySelectorAll<HTMLElement>('*') ?? []].filter(el => el instanceof HTMLElement && boxKey(el) === key)
function scrollsOf(root: Element | null): Scrolled[] {
  const seen = new Map<string, number>(), boxes: Scrolled[] = []
  for (const el of root?.querySelectorAll<HTMLElement>('*') ?? []) {
    if (!(el instanceof HTMLElement)) continue
    const key = boxKey(el), nth = seen.get(key) ?? 0
    seen.set(key, nth + 1)
    if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) continue
    const style = getComputedStyle(el)
    if (/auto|scroll/.test(style.overflowX + style.overflowY)) boxes.push({ key, nth, top: el.scrollTop, left: el.scrollLeft })
  }
  return boxes
}
// A selection inside the painted page, as offsets into its text, which the app's page has the same of.
function selectionIn(root: Element | null): [number, number] | null {
  const selection = getSelection()
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const offset = (node: Node, at: number) => { const before = document.createRange(); before.setStart(root, 0); before.setEnd(node, at); return before.toString().length }
  return [offset(range.startContainer, range.startOffset), offset(range.endContainer, range.endOffset)]
}
function select(root: Element, [start, end]: [number, number]) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), range = document.createRange()
  let seen = 0, began = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).data.length
    if (!began && start <= seen + length) { range.setStart(node, start - seen); began = true }
    if (began && end <= seen + length) { range.setEnd(node, end - seen); getSelection()?.removeAllRanges(); getSelection()?.addRange(range); return }
    seen += length
  }
}
