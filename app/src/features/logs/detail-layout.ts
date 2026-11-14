import { SHELL_COMPACT, useMediaQuery } from '../../lib/media'

// A sent email's layout by window, one rule for the page and its skeleton. Below 900 px (the compact shell) the page
// scrolls as one column: delivery, the preview as tall as the email, then the score (stack). From 1200 px the preview
// fills the window's height beside a details column with the delivery and the score (column); between, the preview takes
// the width and the score opens beside it from its toolbar (panel). From 960 px of height there is room for every finding.
export type DetailMode = 'stack' | 'panel' | 'column'
export function useDetailLayout() {
  const compact = useMediaQuery(SHELL_COMPACT), column = useMediaQuery('(min-width: 1200px)'), roomy = useMediaQuery('(min-height: 960px)')
  const mode: DetailMode = compact ? 'stack' : column ? 'column' : 'panel'
  return { mode, roomy }
}
