// The new homepage's options (features/home/landing), side by side for review: `?home=a`, `?home=b` or `?home=c` shows one
// at "/" in the dev server and in a build made with VITE_DESIGN_SHEET=1 (lib/design-sheet.ts). Any other build folds
// LANDING_PREVIEW to false, leaves the options out and shows the homepage as it is.
export const LANDING_PREVIEW = import.meta.env.DEV || import.meta.env.VITE_DESIGN_SHEET === '1'
export type LandingVariant = 'a' | 'b' | 'c'
/** The option this address asks for, where options are shown; null for the homepage as it is. */
export function landingVariant(): LandingVariant | null {
  if (!LANDING_PREVIEW || typeof location === 'undefined') return null
  const home = new URLSearchParams(location.search).get('home')
  return home === 'a' || home === 'b' || home === 'c' ? home : null
}
