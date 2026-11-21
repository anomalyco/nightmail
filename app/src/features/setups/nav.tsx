import type { ReactNode } from 'react'
import { BookOpen, Globe, Inbox, KeyRound, LayoutGrid, LifeBuoy, Newspaper, Plus, ScrollText, Send, Settings, ShieldCheck, Users } from 'lucide-react'
import { newsletterPath, type Setups } from './data'

// Pitch: the sidebar is what the workspace has set up, for the person looking at it. No mode: an item is there because
// the thing behind it exists. Add is last, and lists what else can be turned on.
export type NavEntry = { path: string; title: string; icon: ReactNode; count?: number; add?: boolean }
export const addPath = '/add'
export function navFor(data: Setups, staff: boolean): NavEntry[] {
  const newsletters = data.setups.filter(setup => setup.kind === 'newsletter').map(setup => ({ path: newsletterPath(setup.id), title: setup.name, icon: <Newspaper />, count: setup.waiting || undefined }))
  // Someone invited to one newsletter sees that newsletter.
  if (data.only) return newsletters
  const { has } = data, admin = data.role === 'owner' || data.role === 'admin'
  const onlyNewsletter = newsletters.length === 1 && !has.app && !has.campaigns
  const entries: (NavEntry | false | undefined)[] = [
    has.app && { path: '/overview', title: 'Overview', icon: <LayoutGrid /> },
    has.app && { path: '/logs', title: 'Logs', icon: <ScrollText /> },
    has.receiving && { path: '/receiving', title: 'Receiving', icon: <Inbox /> },
    // A newsletter sits where Campaigns does, under its own name.
    ...newsletters,
    has.campaigns && { path: '/campaigns', title: 'Campaigns', icon: <Send /> },
    has.audience && { path: '/audience', title: onlyNewsletter ? 'Readers' : 'Audience', icon: <Users /> },
    has.domains && { path: '/domains', title: 'Domains', icon: <Globe /> },
    has.app && { path: '/api-keys', title: 'API keys', icon: <KeyRound /> },
    has.app && { path: '/docs', title: 'Docs', icon: <BookOpen /> },
    { path: '/settings', title: 'Settings', icon: <Settings /> },
    staff && { path: '/support', title: 'Support', icon: <LifeBuoy /> },
    staff && { path: '/operator', title: 'Operator', icon: <ShieldCheck /> },
    admin && { path: addPath, title: 'Add', icon: <Plus />, add: true },
  ]
  return entries.filter((entry): entry is NavEntry => Boolean(entry))
}
/** Where the wordmark goes, and where a page this person has no use for sends them. */
export const homeFor = (data: Setups) => data.setups.length || Object.values(data.has).some(Boolean) ? navFor(data, false)[0]?.path ?? addPath : addPath
export const isEmpty = (data: Setups) => !data.setups.length && !Object.values(data.has).some(Boolean)
