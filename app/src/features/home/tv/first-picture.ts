import scene from './crt/scene.webp'

// The television's photograph (tv.tsx), apart from the page's code so the app can start loading it before that code
// arrives (App.tsx, beside the session check). With VITE_HOME=tv the app's import of features/home/first-picture
// resolves here (home-tv.ts). home.html paints it before any of the app's code, so there the page takes it from the cache.

/** Starts loading the homepage's photograph ahead of the page that shows it. */
export function preloadFirstPicture() {
  if (document.getElementById('home-shell')) return
  const link = document.createElement('link')
  link.rel = 'preload'; link.as = 'image'; link.href = scene; link.fetchPriority = 'high'
  document.head.append(link)
}
