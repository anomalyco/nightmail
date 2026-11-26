// The dashboard's storage keys were bane.* before the rename. Before anything reads them, each moves to its nightmail.*
// name, so the theme, privacy mode, region and this tab's account carry over. Once the nightmail.* name exists it wins:
// a bane.* key seen later was written by a tab still on the old build, and is dropped. The workspace choice is never
// carried over, so a stale one can't send this tab's requests to another workspace: the tab picks it as on a first
// visit (the server's choice, then remembered). features/support still keeps its conversations under bane.support.*.
// Remove after rename cleanup.
;(() => {
  for (const area of ['localStorage', 'sessionStorage']) {
    let storage, old = []
    try { storage = window[area]; for (let i = 0; i < storage.length; i++) old.push(storage.key(i)) } catch { continue }
    for (const key of old) {
      if (!key?.startsWith('bane.') || key.startsWith('bane.support.')) continue
      const name = 'nightmail.' + key.slice('bane.'.length)
      try {
        if (!key.startsWith('bane.workspace') && storage.getItem(name) === null) storage.setItem(name, storage.getItem(key))
        storage.removeItem(key)
      } catch {}
    }
  }
})()

// home.html's first screen (app/home-shell.ts) is the plain homepage's: off at any other address, and where "/" shows
// something else (an invitation, another account, ?home=); with the member's button where this browser has had a
// dashboard ready. (Only home.html's script tag has data-home.)
;(() => {
  if (!document.currentScript?.hasAttribute('data-home')) return
  const root = document.documentElement, query = new URLSearchParams(location.search)
  if (location.pathname !== '/' || ['invitation', 'account', 'home'].some(name => query.has(name))) { root.dataset.shell = 'off'; return }
  try { if (localStorage.getItem('nightmail.dashboard-ready')) root.dataset.member = '' } catch {}
})()

// A painted page (app/painted-page.ts: the price pages, the legal and docs pages) is drawn at build time for its
// plain address, so the app draws it instead, from the start (home/shell/boot.js), wherever the address could change what
// it shows: a query key the app may read (the calculator's sizes, ?auth=, ?invitation=, ?account=), or the hash its
// script tag names (data-plain). A tracking key (utm_*, ref, a click ID) is read by no page, so it never does: whoever
// follows a tagged link, crawler or reader, gets the same painted page. A page painted for an address (data-origin: the
// docs pages, whose examples name it) is the app's anywhere else. A page painted for visitors (data-members) is the
// app's from the start too where this browser has signed in, as far as data/live.ts sessionLikely can tell, so a member
// gets the app as before.
;(() => {
  const set = document.currentScript?.dataset
  if (set?.plain === undefined) return
  const tracking = name => name.startsWith('utm_') || ['ref', 'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid', 'twclid', 'li_fat_id', 'mc_cid', 'mc_eid', 'igshid', 'yclid', 'srsltid', '_hsenc', '_hsmi'].includes(name)
  if ([...new URLSearchParams(location.search).keys()].some(name => !tracking(name)) || (set.plain && location.hash === set.plain)) document.documentElement.dataset.shell = 'off'
  if (set.origin && location.origin !== set.origin) document.documentElement.dataset.shell = 'off'
  // A page that names the hashes it answers (data-anchors: the docs overview's sections) is the app's at any other: the
  // app moves an old address elsewhere (/docs#guide-rituals, /docs#sendEmail; features/docs/index.tsx, legacyPath).
  if (set.anchors !== undefined && location.hash.length > 1) {
    let id = ''
    try { id = decodeURIComponent(location.hash.slice(1)) } catch {}
    if (!set.anchors.split(' ').includes(id)) document.documentElement.dataset.shell = 'off'
  }
  if (set.members === undefined) return
  let hint = null, likely = false
  try { hint = localStorage.getItem('nightmail.session'); likely = hint === 'in' || (hint === null && (localStorage.getItem('nightmail.dashboard-ready') !== null || sessionStorage.getItem('nightmail.account') !== null)) } catch {}
  if (likely) document.documentElement.dataset.shell = 'off'
})()

;(() => {
  // The homepage has no theme switch: it is in the system's theme (lib/theme.tsx). Elsewhere a saved choice wins.
  let saved = null
  try { if (location.pathname !== '/') saved = localStorage.getItem('nightmail.theme') } catch {}
  const theme = saved === 'light' || saved === 'dark'
    ? saved
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  // The browser's own bars (a phone's status bar, Safari's toolbar) take the page's frame colour.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', theme === 'dark' ? '#111111' : '#EFEFEF')
})()

// Overview's detail column, where this browser hid it (features/overview/panel.ts): laid out without it from the first paint.
try { if (localStorage.getItem('nightmail.overview-panel') === 'hidden') document.documentElement.dataset.overviewPanel = 'hidden' } catch {}

// Start the session check while the app's scripts download. The app (data/live.ts) takes these
// responses over, and only when the account and workspace headers match what it would have sent itself.
// The account is this tab's (sessionStorage); a new tab asks as the browser default account.
;(() => {
  const path = location.pathname, query = new URLSearchParams(location.search)
  if (path === '/docs' || path.startsWith('/docs/') || query.get('invitation') || query.get('account')) return
  let account = null, workspace = null, ready = null, session = null
  try { account = sessionStorage.getItem('nightmail.account'); workspace = account && localStorage.getItem('nightmail.workspace:' + account); ready = localStorage.getItem('nightmail.dashboard-ready'); session = localStorage.getItem('nightmail.session') } catch {}
  // A visitor on a public page with no trace of a session here isn't asked about one (data/live.ts, sessionLikely). The
  // pages are api/src/site-index.ts's PUBLIC_PAGE, filled in by vite.config.ts, as data/live.ts's asksOnlyIfLikely reads them.
  const marketing = new RegExp('%PUBLIC_PAGE%').test(path)
  const visitor = marketing && session !== 'in' && (session === 'out' || (ready === null && account === null))
  const header = '%HEADER_PREFIX%' // api/src/brand.ts's headerPrefix, filled in by vite.config.ts
  const start = url => {
    const response = fetch(url, { credentials: 'include', headers: { Accept: 'application/json', ...(account ? { [header + 'Account']: account } : {}), ...(workspace ? { [header + 'Workspace']: workspace } : {}) } })
    response.catch(() => {}) // The app awaits the real rejection; this only silences the unhandled one.
    return response
  }
  const responses = visitor ? {} : { '/v1/me': start('/v1/me') }
  // The public homepage check, for visitors whose workspace is not remembered as ready.
  if (path === '/' && ready !== (workspace ?? '*')) responses['/health'] = start('/health')
  window.__nightmailEarly = { account, workspace: workspace || null, at: Date.now(), responses }
})()
