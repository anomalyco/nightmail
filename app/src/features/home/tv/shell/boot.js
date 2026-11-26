// The television homepage's first screen before the app (home.html, home-tv.ts; features/home/shell/boot.js is the
// factory's, and the price pages'): it starts the app's code at a touch, key or scroll, a press of a button, or after
// 8 s, and once the first screen's pictures are in and the page is idle, so nothing else takes their bandwidth; it
// holds a press for the page to act on; and it gives way at once to anything the app shows other than the page itself.
// The page itself takes over from it (tv.tsx, takeOver). Its script tag names the app's files (data-css, data-preload,
// data-entry) and the page's: data-shell, the first screen's id (home-shell); data-wait, the pictures to wait for (the
// set's photograph and the tape's still, .chy-scene and .hs-still), or none to wait for the reader; data-keep, what the
// app may show under it in the meantime (.boot-loader, .chy); data-press, the buttons whose press is held (the
// homepage's Get started, button[data-cta="sign-in"], shown pressed at once). The app's stylesheet goes in before the
// page's own inlined one (style[data-shell-css]) where there is one, so it can't restyle the painted page while the app
// loads. Where theme.js turned the first screen off (html[data-shell=off]: an address it doesn't show), the app starts
// at once.
;(() => {
  const me = document.currentScript, set = me.dataset, root = document.getElementById('root')
  const shell = document.getElementById(set.shell || 'home-shell'), keep = set.keep || '.boot-loader, .chy'
  let started = false
  const add = (tag, props, before = null) => document.head.insertBefore(Object.assign(document.createElement(tag), props), before)
  const start = () => {
    if (started) return
    started = true
    // The stylesheet and the modules download side by side; the entry runs once the stylesheet is in.
    const css = add('link', { rel: 'stylesheet', href: set.css, crossOrigin: '' }, document.querySelector('style[data-shell-css]'))
    for (const href of (set.preload || '').split(' ').filter(Boolean)) add('link', { rel: 'modulepreload', href, crossOrigin: '' })
    const entry = () => add('script', { type: 'module', src: set.entry, crossOrigin: '' })
    css.addEventListener('load', entry, { once: true }); css.addEventListener('error', entry, { once: true })
  }
  if (!shell || !root || document.documentElement.dataset.shell === 'off') { if (shell) shell.remove(); start(); return }

  shell.addEventListener('click', event => {
    const button = event.target instanceof Element && event.target.closest(set.press || 'button[data-cta="sign-in"]')
    if (!button) return
    window.__nightmailShellPress = button
    if (!set.press) { window.__nightmailHomeStart = true; button.setAttribute('aria-busy', 'true'); button.dataset.busy = '' }
    start()
  })
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(type, start, { once: true, passive: true })
  // (Once the pictures have been painted too: two frames on, so the app's files never start before the first screen shows.)
  const idle = () => { if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 1000 }); else setTimeout(start, 200) }
  const later = () => requestAnimationFrame(() => requestAnimationFrame(idle))
  if (set.wait !== 'none') {
    const pictures = [...shell.querySelectorAll(set.wait || '.chy-scene, .hs-still')].filter(img => img.getClientRects().length && !img.complete)
    let left = pictures.length
    const one = () => { if (--left === 0) later() }
    if (!left) later()
    for (const img of pictures) { img.addEventListener('load', one, { once: true }); img.addEventListener('error', one, { once: true }) }
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
