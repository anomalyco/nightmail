import type { ReactNode } from 'react'
import { PageHeader } from '../../components/ui'
import { SectionNav } from '../../components/SectionNav'
import { useSetups } from '../setups/data'
import { navFor } from '../setups/nav'

const sections = [{ to: '/audience', label: 'Contacts' }, { to: '/audience/lists', label: 'Lists' }, { to: '/audience/segments', label: 'Segments' }]

// Contacts, lists and segments share one page; each section keeps its own URL.
export function AudienceHeader({ actions }: { actions?: ReactNode }) {
  // Pitch (pitch/setups): the page is called what the sidebar calls it (Readers, when the workspace is one newsletter).
  const setups = useSetups().data
  const title = setups ? navFor(setups, false).find(entry => entry.path === '/audience')?.title ?? 'Audience' : 'Audience'
  return <><PageHeader title={title} actions={actions} /><SectionNav label="Audience sections" items={sections} /></>
}
