import type { LucideIcon } from 'lucide-react';
import type { Tone } from './primitives';

// Every glyph in the dashboard is a static Lucide icon on one scale, each size with the stroke that keeps lines equally
// heavy beside text: xs 12 (checkbox ticks, inline marks), sm 14 (chevrons, copy, small buttons), md 16 (the default:
// buttons, menus, navigation), lg 18 (page-level marks), xl 32 (empty states). Styles: .ui-icon in styles/ui.css.
export const ICON_SIZES = { xs: 12, sm: 14, md: 16, lg: 18, xl: 32 } as const;
export const ICON_STROKES = { xs: 1.75, sm: 1.6, md: 1.5, lg: 1.75, xl: 1.5 } as const;
export type IconSize = keyof typeof ICON_SIZES;
/** `inherit`: the surrounding text's colour (a button's label); `muted`/`faint`/`text`: a neutral ink; a Tone: its ink. */
export type IconTone = 'inherit' | 'muted' | 'faint' | 'text' | Tone;

const cx = (...values: (string | false | null | undefined)[]) => values.filter(Boolean).join(' ');
const neutral = new Set<IconTone>(['inherit', 'muted', 'faint', 'text']);

/** A Lucide glyph at a standard size and stroke. Decorative (aria-hidden) unless `label` names it. */
export function Icon({ icon: Glyph, size = 'md', tone = 'inherit', label, className }: { icon: LucideIcon; size?: IconSize; tone?: IconTone; label?: string; className?: string }) {
  const toneClass = tone === 'inherit' ? null : neutral.has(tone) ? `ui-icon--${tone}` : `ui-tone--${tone}`;
  return <Glyph className={cx('ui-icon', `ui-icon--${size}`, toneClass, className)} size={ICON_SIZES[size]} strokeWidth={ICON_STROKES[size]} aria-hidden={label ? undefined : true} aria-label={label} role={label ? 'img' : undefined} focusable={false} />;
}
