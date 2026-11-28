import type { CSSProperties } from 'react'
import { Bot, CodeXml, Inbox, Megaphone, Newspaper, type LucideIcon } from 'lucide-react'
import { focusLabels, WORKSPACE_FOCUS, type WorkspaceFocus } from '../data/focus'
import './focus-picker.css'

export const focusChoices: Record<WorkspaceFocus, { icon: LucideIcon; line: string }> = {
  marketing: { icon: Megaphone, line: 'Campaigns to your contacts.' },
  newsletter: { icon: Newspaper, line: 'A list people sign up to, and the issues you send it.' },
  developer: { icon: CodeXml, line: 'Receipts, sign-in links and alerts your app sends.' },
  agents: { icon: Bot, line: 'Addresses your AI agents receive and read mail at.' },
  personal: { icon: Inbox, line: 'Your own address on your own domain, in place of Google Workspace and the like.' },
}

/**
 * The focuses as cards, any number picked: a card's mark shows its place, and the first pick leads. Picking again
 * removes it. `rise` staggers the cards in with the step they open on.
 */
export function FocusPicker({ value, onChange, rise }: { value: WorkspaceFocus[]; onChange: (value: WorkspaceFocus[]) => void; rise?: (index: number) => CSSProperties }) {
  return <div className="focus-picker" role="group" aria-label="What do you want to focus on?">
    {WORKSPACE_FOCUS.map((focus, index) => {
      const { icon: Icon, line } = focusChoices[focus], place = value.indexOf(focus)
      return <button key={focus} type="button" className={`focus-option${rise ? ' onb-rise' : ''}`} style={rise?.(index + 1)} aria-pressed={place >= 0} data-analytics={`focus/${focus}`}
        onClick={() => onChange(place >= 0 ? value.filter(item => item !== focus) : [...value, focus])}>
        <span className="focus-option__icon" aria-hidden="true"><Icon size={18} /></span>
        <span className="focus-option__title">{focusLabels[focus]}</span>
        <span className="focus-option__line">{line}</span>
        <span className="focus-option__mark" aria-hidden="true">{place >= 0 ? place + 1 : ''}</span>
        {place === 0 && value.length > 1 && <span className="sr-only">, leads</span>}
      </button>
    })}
  </div>
}
