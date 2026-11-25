import type { CSSProperties, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { DropdownMenu, type MenuItem, type Tone } from './primitives';
import { Icon } from './icon';

// Data display (Signal Log): flat, hairline-drawn pieces for dense pages. Labels are small and muted, values mono with
// tabular figures, and colour only says how something went (a tone's dot, ink or bar). Every piece has a fixed height in
// every state, so a loading page and a loaded one hold the same space.
const cx = (...values: (string | false | null | undefined)[]) => values.filter(Boolean).join(' ');
const clamp = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/** A value against its limit: a 2px track, the share filled in the tone's colour, and a tick where the limit (or a warning line) sits; `title` names the tick on hover. */
export function Meter({ value, max = 1, mark, tone = 'neutral', label, title, className }: { value: number; max?: number; mark?: number; tone?: Tone; label?: string; title?: string; className?: string }) {
  const share = clamp(value / max), at = mark === undefined ? undefined : clamp(mark / max);
  return <span className={cx('ui-meter', `ui-tone--${tone}`, className)} title={title} role={label ? 'meter' : undefined} aria-label={label} aria-valuemin={label ? 0 : undefined} aria-valuemax={label ? max : undefined} aria-valuenow={label ? value : undefined} aria-hidden={label ? undefined : true}
    style={{ '--share': `${share * 100}%`, ...at !== undefined && { '--mark': `${at * 100}%` } } as CSSProperties}><i />{at !== undefined && <b />}</span>;
}

/** A series as one line, oldest first, from zero to its largest value: a metric row's trend. No axes and no labels; it
 *  fills the box it is given, so an empty or flat series holds the same space. */
export function Sparkline({ values, tone, className }: { values: readonly number[]; tone?: Tone; className?: string }) {
  const max = Math.max(0, ...values), y = (value: number) => max > 0 ? 19 - Math.max(0, value) / max * 18 : 19;
  const points = values.length === 1 ? `0,${y(values[0]!)} 100,${y(values[0]!)}` : values.map((value, i) => `${i / (values.length - 1) * 100},${y(value)}`).join(' ');
  return <svg className={cx('ui-spark', tone && `ui-tone--${tone}`, className)} viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">{values.length > 0 && <polyline points={points} />}</svg>;
}

/** One metric as a row: label (and a muted hint), its series, the mono value with a muted unit; a meter is the row's rule. */
export function MetricRow({ label, hint, spark, value, unit, tone, meter, className }: { label: ReactNode; hint?: ReactNode; spark?: ReactNode; value: ReactNode; unit?: ReactNode; tone?: Tone; meter?: ReactNode; className?: string }) {
  return <div className={cx('ui-metric', meter ? 'ui-metric--meter' : null, className)} data-tone={tone}>
    <span className="ui-metric__label"><span>{label}</span>{hint !== undefined && <span className="ui-metric__hint">{hint}</span>}</span>
    <span className="ui-metric__spark">{spark}</span>
    {/* Laid out from the cell's right edge and pulled back by its own width: a figure that tweens through wider and
        narrower numbers never moves its box (a transform, not a layout shift). */}
    <span className={cx('ui-metric__value', tone && tone !== 'neutral' && `ui-tone--${tone}`)}><span className="ui-metric__figure">{value}{unit && <span className="ui-metric__unit">{unit}</span>}</span></span>
    {meter}
  </div>;
}

/** A facet: a value, its tone's dot and its count. Selectable when it has onSelect, or a menu of more values (`menu`);
 *  `slot` reserves an empty row. `series`: the data palette's hue for the value (sent, received, delivered, opened,
 *  clicked, bounced, complained); else its tone's. With neither, or `dot: false`, the value has no dot: colour only says
 *  how mail went. `atLeast`: the count is a lower bound (shown with a +). `title`: why a value without onSelect can't be chosen. */
export type Facet = { key: string; label?: ReactNode; count?: number | null; atLeast?: boolean; title?: string; tone?: Tone; series?: string; dot?: boolean; selected?: boolean; onSelect?: () => void; menu?: MenuItem[]; menuLabel?: string; onMenuOpenChange?: (open: boolean) => void; slot?: boolean };
export type FacetGroup = { key: string; title: ReactNode; items: Facet[] };
/** The facets beside a list: each group a small caps title over its values, each value with its count. */
export function FacetRail({ groups, label = 'Facets', countSlot }: { groups: FacetGroup[]; label?: string; countSlot?: { width: number; detail?: string } }) {
  return <nav className="ui-facets" aria-label={label} aria-description={countSlot?.detail}>
    {groups.map(group => <section key={group.key} className="ui-facets__group" aria-label={typeof group.title === 'string' ? group.title : undefined}>
      <h3 className="ui-facets__title">{group.title}</h3>
      <ul>{group.items.map(item => {
        if (item.slot) return <li key={item.key} className="ui-facet ui-facet--slot" aria-hidden="true" />;
        // Keep the count's slot and the focused control; only the changing value is replaced.
        const value = item.count === null || item.count === undefined ? '–' : `${item.count.toLocaleString()}${item.atLeast ? '+' : ''}`;
        const noChoices = Boolean(item.onMenuOpenChange && item.menu?.length === 0);
        const body = <><span className={cx('ui-facet__dot', `ui-tone--${item.tone ?? 'neutral'}`, item.series && `ui-series--${item.series}`, (item.dot === false || (!item.tone && !item.series)) && 'ui-facet__dot--none')} aria-hidden="true" /><span className="ui-facet__label">{item.label}{item.menu && !noChoices && <Icon icon={ChevronDown} size="xs" />}</span><span className="ui-facet__count" style={countSlot && { inlineSize: countSlot.width, whiteSpace: 'nowrap' }} title={item.count == null ? undefined : countSlot?.detail}>{countSlot ? <span key={value}>{value}</span> : value}</span></>;
        const empty = !item.count || undefined;
        return <li key={item.key}>{item.menu ? <DropdownMenu items={item.menu} label={item.menuLabel} align="start" onOpenChange={item.onMenuOpenChange} trigger={<button type="button" className="ui-facet" aria-label={item.menuLabel} aria-disabled={noChoices || undefined} tabIndex={noChoices ? -1 : undefined} aria-pressed={item.selected ?? false} data-empty={empty}>{body}</button>} />
          : item.onSelect ? <button type="button" className="ui-facet" aria-pressed={item.selected ?? false} data-empty={empty} onClick={item.onSelect}>{body}</button> : <span className="ui-facet" data-empty={empty} title={item.title}>{body}</span>}</li>;
      })}</ul>
    </section>)}
  </nav>;
}

/** A list beside its rail (facets, a thread): a hairline between them. `collapse`: below 1200 px the rail hides, or becomes a row over the list. */
export function SplitPane({ rail, children, collapse = 'hide', className }: { rail: ReactNode; children: ReactNode; collapse?: 'hide' | 'row'; className?: string }) {
  return <div className={cx('ui-split', className)} data-collapse={collapse}><div className="ui-split__rail">{rail}</div><div className="ui-split__main">{children}</div></div>;
}

/** Events in order, oldest first: a row each with its dot, name and the time since the first. No bar: a shared axis for
 *  milliseconds and minutes needs a log scale, which made the shortest step look longest. */
export type WaterfallRow = { key: string; label: ReactNode; tone: Tone; series?: string; delta: ReactNode };
export function Waterfall({ rows, label, className }: { rows: WaterfallRow[]; label: string; className?: string }) {
  return <ol className={cx('ui-waterfall', className)} aria-label={label}>{rows.map(row => <li key={row.key} className={cx('ui-waterfall__row', `ui-tone--${row.tone}`, row.series && `ui-series--${row.series}`)}>
    <span className="ui-waterfall__dot" aria-hidden="true" /><span className="ui-waterfall__label">{row.label}</span><span className="ui-waterfall__delta">{row.delta}</span>
  </li>)}</ol>;
}
/** Elapsed time, compact, without a zero second part: 400ms, 2.1s, 4m, 4m 12s, 3h 5m, 2d 4h. */
export function elapsed(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const s = Math.round(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  const pair = (big: number, bigUnit: string, small: number, smallUnit: string) => small ? `${big}${bigUnit} ${small}${smallUnit}` : `${big}${bigUnit}`;
  if (d) return pair(d, 'd', h % 24, 'h');
  if (h) return pair(h, 'h', m % 60, 'm');
  return pair(m, 'm', s % 60, 's');
}

/** Facts as muted keys and mono values. */
export function KeyValues({ items, className }: { items: [key: ReactNode, value: ReactNode][]; className?: string }) {
  return <dl className={cx('ui-kv', className)}>{items.map(([key, value], i) => <div key={i}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>;
}
