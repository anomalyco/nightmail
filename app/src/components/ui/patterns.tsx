import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { CopyButton, PageHeader, type Tone } from './primitives';
import { Icon } from './icon';

// The dashboard's two page patterns, built from the primitives. Styles: "Page patterns" in styles/ui.css.
const cx = (...values: (string | false | null | undefined)[]) => values.filter(Boolean).join(' ');

/** A list page, top to bottom: its header (PageHeader), optional tabs, one toolbar row (ListToolbar), the table or list
 *  (children) and its pagination. It fills the page's column, so the pagination sits at the bottom. */
export function ListPage({ header, tabs, toolbar, pagination, children, className }: { header: ReactNode; tabs?: ReactNode; toolbar?: ReactNode; pagination?: ReactNode; children: ReactNode; className?: string }) {
  return <div data-component="ListPage" className={cx('ui-list-page', className)}>{header}{tabs}{toolbar}{children}{pagination}</div>;
}

/** A list's one row of controls: the search fills the free width, then the filters (selects), then trailing utilities
 *  (`end`: an export or settings icon button). On a phone the search takes its own row. */
export function ListToolbar({ search, filters, end, className }: { search?: ReactNode; filters?: ReactNode; end?: ReactNode; className?: string }) {
  return <div data-component="ListToolbar" className={cx('ui-list-toolbar', className)}>
    {search && <div className="ui-list-toolbar__search">{search}</div>}
    {filters && <div className="ui-list-toolbar__filters">{filters}</div>}
    {end && <div className="ui-list-toolbar__end">{end}</div>}
  </div>;
}

/** A detail page's header: the kind of thing it is (`typeLabel`, sentence case: "Sent email") over its title, the back
 *  button, and its actions level with the title. `icon`: a quiet flat square before the title, neutral or in `tone`. */
export function DetailHeader({ typeLabel, title, backTo, actions, subtitle, icon, tone = 'neutral', className }: { typeLabel: ReactNode; title: ReactNode; backTo?: string; actions?: ReactNode; subtitle?: ReactNode; icon?: LucideIcon; tone?: Tone; className?: string }) {
  return <PageHeader className={cx('ui-detail-header', className)} eyebrow={typeLabel} title={title} backTo={backTo} actions={actions} subtitle={subtitle}
    leading={icon && <span className={cx('ui-detail-header__icon', `ui-tone--${tone}`)} aria-hidden="true"><Icon icon={icon} size="lg" /></span>} />;
}

/** One fact of a detail page: a muted label over its value; `mono` for IDs, DNS, endpoints and timestamps. */
export type Fact = { key?: string; label: ReactNode; value: ReactNode; mono?: boolean; title?: string };
/** The facts under a detail header, in one row on a desktop (two columns on a phone), each value on one line. */
export function FactsRow({ items, label, className }: { items: Fact[]; label?: string; className?: string }) {
  return <dl data-component="FactsRow" className={cx('ui-facts-row', className)} aria-label={label}>{items.map((item, index) => <div key={item.key ?? (typeof item.label === 'string' ? item.label : index)} className="ui-facts-row__item">
    <dt>{item.label}</dt><dd className={item.mono ? 'ui-facts-row__mono' : undefined} title={item.title}>{item.value}</dd>
  </div>)}</dl>;
}

/** An ID or key, mono and cut in the middle (its first `head` and last `tail` characters stay), with a copy button that
 *  shows on hover and focus (always on a touch screen). The whole value is in its title and read to a screen reader. */
export function Identifier({ value, head = 10, tail = 8, copyLabel = 'Copy ID', className }: { value: string; head?: number; tail?: number; copyLabel?: string; className?: string }) {
  const cut = value.length > head + tail + 1;
  return <span data-component="Identifier" className={cx('ui-identifier', className)}>
    <code className="ui-identifier__value" title={cut ? value : undefined}>{cut ? <><span aria-hidden="true">{value.slice(0, head)}…{value.slice(-tail)}</span><span className="sr-only">{value}</span></> : value}</code>
    <CopyButton value={value} label={copyLabel} />
  </span>;
}
