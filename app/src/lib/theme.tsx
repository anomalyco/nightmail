import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'

type Theme = 'light' | 'dark'
const storageKey = 'nightmail.theme'
const ThemeContext = createContext<{ theme: Theme; toggleTheme: () => void } | null>(null)
const parseTheme = (value: string | null): Theme | null => value === 'light' || value === 'dark' ? value : null
function savedTheme() {
  try { return parseTheme(localStorage.getItem(storageKey)) } catch { return null }
}
function systemTheme(): Theme { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }

// The homepage ("/") has no theme switch: it is always in the system's theme, whatever the dashboard's switch chose
// (public/theme.js decides the same before the first paint). Everywhere else a saved choice wins over the system's.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<Theme | null>(savedTheme)
  const [system, setSystem] = useState<Theme>(systemTheme)
  const home = useLocation().pathname === '/'
  const theme = home ? system : preference ?? system

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    // Both theme-color tags (light and dark system themes) take the chosen theme's frame colour.
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', theme === 'dark' ? '#111111' : '#EFEFEF')
  }, [theme])

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const onSystemChange = (event: MediaQueryListEvent) => setSystem(event.matches ? 'dark' : 'light')
    const onStorageChange = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) setPreference(parseTheme(event.newValue))
    }
    media.addEventListener('change', onSystemChange)
    window.addEventListener('storage', onStorageChange)
    return () => {
      media.removeEventListener('change', onSystemChange)
      window.removeEventListener('storage', onStorageChange)
    }
  }, [])

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setPreference(next)
    try { localStorage.setItem(storageKey, next) } catch { /* Theme remains usable without persistence. */ }
  }, [theme])

  // (The same value until the theme changes: a navigation re-renders this, never everything that reads the theme.)
  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('ThemeProvider is required')
  return context
}
