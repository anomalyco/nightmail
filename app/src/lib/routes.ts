import type { ReactNode } from 'react'
import { matchRoutes, type Params, type RouteObject } from 'react-router'

// The dashboard's route table (App.tsx sets it once, when it loads). Analytics names a page view by its template
// (/domains/:id), never its path; a signed-out page uses it to tell a dashboard page (sign in to open it) from an
// address the dashboard doesn't have (page not found).
let routes: RouteObject[] = []
export function setRouteTable(table: RouteObject[]) { routes = table }
export function routeTemplateOf(pathname: string) {
  const matches = matchRoutes(routes, pathname)
  return matches ? '/' + matches.map(match => match.route.path ?? '').filter(Boolean).join('/').replaceAll('?', '') : '/*'
}
/** Whether a route other than the dashboard's catch-all ("Page not found") answers this path. */
export const isKnownPath = (pathname: string) => matchRoutes(routes, pathname)?.at(-1)?.route.path !== '*'

/**
 * What a page needs before it can draw, given as its route's handle in App.tsx. A route takes the handles of the
 * routes around it, its own last, and composes their preloaders in parallel so a section's code is named once around
 * its pages.
 */
export type RouteHandle = {
  /** Starts loading the page's code: on a cold load alongside /v1/me, on hover, and in the idle sweep. */
  preload?: () => Promise<unknown>
  /** The page's code loads before /v1/me answers, even in a browser that may still need onboarding. */
  early?: true
  /** What the shell draws while the page's code loads (components/RouteSkeleton.tsx). */
  skeleton?: ReactNode | ((params: Params) => ReactNode)
}
export function routeHandle(pathname: string): { handle: RouteHandle; params: Params } {
  const matches = matchRoutes(routes, pathname) ?? []
  const handles = matches.map(match => match.route.handle as RouteHandle | undefined).filter((handle): handle is RouteHandle => !!handle)
  const preloads = handles.map(handle => handle.preload).filter((fn): fn is () => Promise<unknown> => !!fn)
  const handle: RouteHandle = Object.assign({}, ...handles)
  if (preloads.length > 1) handle.preload = () => Promise.all(preloads.map(fn => fn()))
  return { handle, params: matches.at(-1)?.params ?? {} }
}
