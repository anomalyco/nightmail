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
export const isPublicPage = (pathname: string) => pathname === '/' || pathname === '/pricing' || /^\/(?:compare|docs|legal)(?:\/|$)/.test(pathname);

/** An address under the directories the build writes the site's own pages into (app/price-pages.ts): a comparison
 *  (/compare/<vendor>) or a vendor's pricing page (/pricing/<vendor>). The Worker serves them from the build's files. */
export const isSitePage = (pathname: string) => /^\/(?:compare|pricing)\//.test(pathname);
/** Where one of those the build didn't make is (and /compare, until it has a page): nowhere (404), never the dashboard. */
export const isMissingComparePage = (pathname: string) => pathname === '/compare' || isSitePage(pathname);

export function withSiteIndex(llms: string, site: string): string {
  const lines = site.trim();
  if (!lines) return llms;
  const at = llms.indexOf('\n## ');
  return at < 0 ? `${llms.trimEnd()}\n\n${lines}\n` : `${llms.slice(0, at + 1)}${lines}\n\n${llms.slice(at + 1)}`;
}
