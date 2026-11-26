// A public page's first screen before the app (home.html, home-shell.ts; the price pages, price-pages.ts): it starts the
// app's code at a touch, key or scroll, a press of a button, or after 8 s, and on the homepage once the first picture is
// in and the page is idle, so nothing else takes the picture's bandwidth; it holds a press for the page to act on; and
// it gives way at once to anything the app shows other than the page itself. The page itself takes over from it
// (features/home/factory-home.tsx, features/pricing/index.tsx). Its script tag names the app's files (data-css,
// data-preload, data-entry) and the page's: data-shell, the first screen's id (home-shell); data-wait, the first
// picture (.fac-poster), or none to wait for the reader; data-keep, what the app may show over it in the meantime
// (.boot-loader, .fac-page); data-press, the buttons whose press is held (the homepage's Get started, button.fac-cta,
// shown pressed at once). The app's stylesheet goes in before the page's own CSS ([data-shell-css]: inlined, or a
// stylesheet painted pages share) where there is one, so it can't restyle the painted page while the app loads. Where
// theme.js turned the first screen off (html[data-shell=off]: an address it doesn't show), the app starts at once.
;(() => {
  const me = document.currentScript, set = me.dataset, root = document.getElementById('root')
  const shell = document.getElementById(set.shell || 'home-shell'), keep = set.keep || '.boot-loader, .fac-page'
  let started = false, sheet = null
  const add = (tag, props, before = null) => document.head.insertBefore(Object.assign(document.createElement(tag), props), before)
  const start = () => {
    if (started) return
    started = true
    // The stylesheet and the modules download side by side; the entry runs once the stylesheet is in.
    const css = sheet = add('link', { rel: 'stylesheet', href: set.css, crossOrigin: '' }, document.querySelector('[data-shell-css]'))
    for (const href of (set.preload || '').split(' ').filter(Boolean)) add('link', { rel: 'modulepreload', href, crossOrigin: '' })
    const entry = () => add('script', { type: 'module', src: set.entry, crossOrigin: '' })
    css.addEventListener('load', entry, { once: true }); css.addEventListener('error', entry, { once: true })
  }
  // With the first screen off, its inlined CSS (a cut-down copy of the app's) goes once the app's stylesheet is in, before
  // the app draws anything, so the app runs on its own stylesheet. The first fonts' faces stay, as where the app takes over
  // from the first screen: this page preloads those fonts and not the app's whole ones, which text drawn before they
  // arrive would move for. They are the same fonts cut down, so a glyph is the same either way.
  if (!shell || !root || document.documentElement.dataset.shell === 'off') {
    if (shell) shell.remove()
    start()
    const drop = () => document.querySelectorAll('[data-shell-css]').forEach(styles => styles.remove())
    sheet.addEventListener('load', drop, { once: true }); sheet.addEventListener('error', drop, { once: true })
    return
  }

  // A scrolling box that keeps an item in view (data-shell-reveal: the reference pages' contents, the open page) scrolls to
  // it as the app's page does from its first frame (features/docs/index.tsx, DocsView): a third of the way down.
  for (const box of shell.querySelectorAll('[data-shell-reveal]')) {
    const item = box.querySelector(box.dataset.shellReveal)
    if (!item) continue
    const outer = box.getBoundingClientRect(), inner = item.getBoundingClientRect()
    if (inner.top < outer.top || inner.bottom > outer.bottom - 24) box.scrollTop += inner.top - outer.top - outer.height / 3
  }

  // What works on the painted page itself, before the app is up: a pick in a page picker (data-shell-navigate: the reference
  // pages' phone picker, whose options are addresses) goes to that page, and a copy button (data-shell-copy names the
  // element whose text it copies) copies at once, as the app's do, and shows it has (data-copied, the app's mark).
  shell.addEventListener('change', event => {
    const picker = event.target instanceof Element && event.target.closest('select[data-shell-navigate]')
    if (picker && picker.value) location.assign(picker.value)
  })
  shell.addEventListener('click', event => {
    // Only a press a person made is held for the app: a click a script dispatched is not.
    if (!event.isTrusted) return
    const copy = event.target instanceof Element && event.target.closest('button[data-shell-copy]')
    if (copy) {
      const text = document.querySelector(copy.dataset.shellCopy)?.textContent
      if (text != null && navigator.clipboard) navigator.clipboard.writeText(text).then(() => { copy.dataset.copied = ''; setTimeout(() => { delete copy.dataset.copied }, 1800) }, () => {})
      start()
      return
    }
    const button = event.target instanceof Element && event.target.closest(set.press || 'button.fac-cta')
    if (!button) return
    window.__nightmailShellPress = button
    if (!set.press) { window.__nightmailHomeStart = true; button.setAttribute('aria-busy', 'true'); button.dataset.busy = '' }
    start()
  })
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(type, start, { once: true, passive: true })
  // (Once the picture has been painted too: two frames on, so the app's files never start before the first screen shows.)
  const idle = () => { if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 1000 }); else setTimeout(start, 200) }
  const later = () => requestAnimationFrame(() => requestAnimationFrame(idle))
  if (set.wait !== 'none') {
    const picture = [...shell.querySelectorAll(set.wait || '.fac-poster')].find(img => img.getClientRects().length)
    if (!picture || picture.complete) later()
    else { picture.addEventListener('load', later, { once: true }); picture.addEventListener('error', later, { once: true }) }
  }
  setTimeout(start, 8000)

  // Anything but the page (and the moment's spinner before it) replaces the first screen at once.
  new MutationObserver((_, observer) => {
    const first = root.firstElementChild
    if (!shell.isConnected) return observer.disconnect()
    if (!first || first.matches(keep)) return
    shell.remove(); observer.disconnect()
  }).observe(root, { childList: true })
})()
