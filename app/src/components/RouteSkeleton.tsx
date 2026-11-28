import { useLocation } from 'react-router'
import { ChunkFallback } from '../lib/preloadable'
import { routeHandle } from '../lib/routes'

// The shell's placeholder while a page's code loads: the skeleton its route names (App.tsx). A skeleton with code of its
// own (the staff pages') draws nothing until that arrives, never this placeholder again.
export function RouteSkeleton() {
  const { handle: { skeleton }, params } = routeHandle(useLocation().pathname)
  return <ChunkFallback.Provider value={null}>{typeof skeleton === 'function' ? skeleton(params) : skeleton}</ChunkFallback.Provider>
}
