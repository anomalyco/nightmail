import { useQueryClient } from '@tanstack/react-query'
import { WORKSPACE_FOCUS, type WorkspaceFocus } from '../../../api/src/workspace-focus.js'
import { analytics } from '../lib/analytics'
import { useToast } from '../components/ui'
import { useApi } from './context'
import type { LandingFocus } from './landing-focus'
import type { Identity, WorkspaceSettings } from './types'

// What the workspace is here for (api/src/workspace-focus.ts): Settings sets it, or a landing link's focus as onboarding
// opens.
export { WORKSPACE_FOCUS, type WorkspaceFocus }
export const focusLabels: Record<WorkspaceFocus, string> = { marketing: 'Marketing emails', newsletter: 'Newsletter', developer: 'Developer emails', agents: 'Agent inboxes', personal: 'An inbox for myself' }

/**
 * Saves a focus in the background: the session and Settings show it at once, PATCH /v1/settings/workspace follows, and
 * the picks go to analytics (focus_chosen, lead first; focus/skip for none; landing/<focus>[/<comparison page>] for one a
 * landing link brought, data/landing-focus.ts). A failed save says so and keeps the choice for this visit.
 */
export function useSaveFocus() {
  const api = useApi(), client = useQueryClient(), toast = useToast()
  return (focus: WorkspaceFocus[], landing?: Pick<LandingFocus, 'from'>) => {
    client.setQueryData<Identity>(['identity'], identity => identity && { ...identity, focus })
    client.setQueryData<WorkspaceSettings>(['nightmail', 'workspace-settings'], settings => settings && { ...settings, focus })
    analytics().track('focus_chosen', landing ? ['landing', ...focus, ...landing.from ? [landing.from] : []].join('/') : focus.length ? ['focus', ...focus].join('/') : 'focus/skip')
    void api.workspace.updateSettings({ focus })
      .catch(() => toast('Couldn’t save what you want to focus on. You can set it in Settings.', 'error'))
  }
}
