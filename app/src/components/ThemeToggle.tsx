import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../lib/theme'
import { Icon, IconButton } from './ui'

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
  return <IconButton className="theme-toggle" variant="ghost" size="sm" label={label} title={label} onClick={toggleTheme}>
    <Icon icon={theme === 'dark' ? Sun : Moon} />
  </IconButton>
}
