// The website's own pages in /llms.txt: the dashboard build lists them in llms-site.txt (app/price-pages.ts: the product,
// the price calculator and every comparison, as Markdown), and the Worker (src/worker.ts) and the Node server
// (src/server.ts) put that under llms.txt's title and summary, before the API's own sections (openapi-docs.ts,
// createLlmsText). Without a dashboard build, llms.txt is the API's alone. No imports: the Worker loads it eagerly.

/** The build's file with the site's lines for llms.txt. */
export const SITE_INDEX = '/llms-site.txt';
/** What robots.txt asks crawlers not to fetch (app/price-pages.ts writes it): the API, its auth and MCP endpoints, and
 *  the addresses in customers' mail. They answer a crawler 401, 403 or 404 and hold nothing to index; Google found
 *  /v1/… addresses in the docs' code samples and crawled them by the hundred. Nothing public is under them: the pages,
 *  their Markdown twins, /llms.txt, /llms-full.txt, /docs.md, /docs/operations/ and /openapi.json are all elsewhere. Not
 *  /health: the docs page reads the installation's address from it before it shows anything, and a search engine
 *  rendering the page fetches only what robots.txt allows. (/v1/me, refused the same way, leaves the docs signed out.) */
export const CRAWL_DISALLOW = ['/v1/', '/api/', '/mcp', '/internal/', '/unsubscribe/', '/i/'];
/** The pages search engines may index: the homepage, the price pages, the docs and the legal pages. Every other address
 *  the dashboard's shell answers is a signed-in screen (Overview, Domains, Connect …), which a crawler sees only as the
 *  sign-in, so the Worker and the Node server send it with X-Robots-Tag: noindex. */
export const isPublicPage = (pathname: string) => pathname === '/' || /^\/(?:pricing|compare|docs|legal)(?:\/|$)/.test(pathname);

/** An address under the directories the build writes the site's own pages into (app/price-pages.ts): a comparison
 *  (/compare/<vendor>) or a vendor's pricing page (/pricing/<vendor>). The Worker serves them from the build's files. */
export const isSitePage = (pathname: string) => /^\/(?:compare|pricing)\//.test(pathname);
/** The docs' and legal pages and their Markdown twins (app/site-pages.ts): files the Worker answers from the assets, as it
 *  does the price pages, untransformed (worker.ts), so Cloudflare adds nothing to them. */
export const isDocsOrLegalPage = (pathname: string) => /^\/(?:docs|legal)(?:\/|$)/.test(pathname);
/** Where one of those the build didn't make is (and /compare, without its page): nowhere (404), never the dashboard. */
export const isMissingComparePage = (pathname: string) => pathname === '/compare' || isSitePage(pathname);
/** Where a reference page the build didn't make is (app/site-pages.ts writes one per operation): not found, rather than
 *  the docs' "Page not found" with 200, which search engines count as a soft 404. */
export const isMissingDocsPage = (pathname: string) => pathname.startsWith('/docs/api/');
/** Where a legal document the build didn't make a page for is (app/site-pages.ts writes one per document): not found,
 *  for the same reason. (/legal itself, and /legal/ on its way there, are the index.) */
export const isMissingLegalPage = (pathname: string) => /^\/legal\/[^/]/.test(pathname);
/** Reference pages search engines indexed under an operation's old name (Search Console, 26 Nov 2026): rules were
 *  called rituals, and AI decisions omens. Each old address moves for good (301) to the page under the new name, so it
 *  keeps what it had; the other operations that left the API (the support agent's, and the removed ones) stay not found.
 *  The old names are in no sitemap or llms.txt. app/site-pages.ts refuses a build where a new name has no page. */
export const RENAMED_OPERATIONS: Record<string, string> = {
  applyRituals: 'applyRules', attachRituals: 'attachRules', checkRitual: 'checkRule', createRitualFromRecipe: 'createRuleFromRecipe',
  deleteRitual: 'deleteRule', getRitual: 'getRule', getRituals: 'getRules', getRitualTypings: 'getRuleTypings', getRitualVersion: 'getRuleVersion',
  listRitualRecipes: 'listRuleRecipes', listRitualTemplates: 'listRuleTemplates', listRitualVersions: 'listRuleVersions',
  restoreRitualVersion: 'restoreRuleVersion', saveRitual: 'saveRule', testRituals: 'testRules', updateRitual: 'updateRule',
  updateRitualFromRecipe: 'updateRuleFromRecipe', setOmenOptIns: 'setDecisionOptIns',
};
/** Where a reference page under an operation's old name went, or null. */
export const renamedDocsPage = (pathname: string) => {
  const id = pathname.startsWith('/docs/api/') ? pathname.slice('/docs/api/'.length) : '';
  return Object.hasOwn(RENAMED_OPERATIONS, id) ? `/docs/api/${RENAMED_OPERATIONS[id]}` : null;
};

export function withSiteIndex(llms: string, site: string): string {
  const lines = site.trim();
  if (!lines) return llms;
  const at = llms.indexOf('\n## ');
  return at < 0 ? `${llms.trimEnd()}\n\n${lines}\n` : `${llms.slice(0, at + 1)}${lines}\n\n${llms.slice(at + 1)}`;
}
