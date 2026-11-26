/** The price pages (/pricing and /compare/*) are public: the homepage's footer and each other's link to them, the
 *  sitemap lists them, and search engines may index them (app/price-pages.ts). Set it to false to take them off the
 *  site again (their addresses keep working, with noindex). */
export const PRICE_PAGES_LIVE = true

/** The price pages' next version, built for the dev stage only until Ryan says yes (26 Nov 2026): the vendors' pricing
 *  pages (/pricing/<vendor>: docs/) with the links to them and their comparisons' head-to-head titles (docs/registry.ts),
 *  and the verdict look. VITE_PRICE_PAGES=verdict turns it on; .github/workflows/deploy.yml sets it for the dev stage and
 *  leaves it empty for production. app/vite.config.ts reads it once, from the build's own environment (an env file left
 *  on a machine can't change what a build ships), and writes it into the app's code as a literal, so a build without it
 *  drops what it gates; the build's own code in Node (price-pages.ts and what it imports) reads the same variable from
 *  that environment. Off, a build is the one production has today: none of those pages, links or titles. */
export const PRICE_PAGES_VERDICT: boolean = typeof __NIGHTMAIL_PRICE_PAGES__ === 'boolean' ? __NIGHTMAIL_PRICE_PAGES__
  : (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.VITE_PRICE_PAGES === 'verdict'
declare global {
  /** The same switch as the literal vite.config.ts writes into the app's code: true or false there, undefined in Node.
   *  The app's own gates on it read it directly where only a literal keeps a build without the pages what production
   *  has (a module at a dynamic import, shared code: features/pricing/index.tsx, App.tsx, data/live.ts, data/context.tsx). */
  const __NIGHTMAIL_PRICE_PAGES__: boolean | undefined
}

/** The price pages as their footers and the homepage's name them, in this order. (Here, not in pages.ts, so the
 *  homepage can link them without loading the prices.) */
export const PRICE_LINKS = [['/pricing', 'Pricing'], ['/compare/mailchimp', 'vs Mailchimp'], ['/compare/resend', 'vs Resend']] as const
