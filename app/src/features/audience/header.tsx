import type { ReactNode } from 'react'
import { PageHeader } from '../../components/ui'
import { SectionNav } from '../../components/SectionNav'

const sections = [{ to: '/audience', label: 'Contacts' }, { to: '/audience/lists', label: 'Lists' }, { to: '/audience/segments', label: 'Segments' }, { to: '/audience/topics', label: 'Topics' }]

// Contacts, lists, segments and topics share one page; each section keeps its own URL.
export function AudienceHeader({ actions }: { actions?: ReactNode }) {
  return <><PageHeader title="Audience" actions={actions} /><SectionNav label="Audience sections" items={sections} /></>
}
