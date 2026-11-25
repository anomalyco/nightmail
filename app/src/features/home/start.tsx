import type { CSSProperties, ReactNode, Ref } from 'react'
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router'
import { useRouteIntent } from '../../data/prefetch'
import type { HomeStart } from '.'
import { GetStartedButton } from './get-started'
import { useSignupsFull } from './signups-open'

// Into the dashboard, for someone signed in: Overview's code and first data start loading when the pointer rests on the
// link or presses it (as the dashboard's own links do), never with the page.
export function DashboardLink({ className, style, ref, children }: { className?: string; style?: CSSProperties; ref?: Ref<HTMLAnchorElement>; children: ReactNode }) {
  return <Link className={className} style={style} ref={ref} to="/overview" {...useRouteIntent()('/overview')}>{children}</Link>
}
/** The page's button, on the machine and on the last plate: Get started signs a visitor in; Open dashboard opens Overview.
 *  warm: the sign-in starts when the pointer rests on Get started or it takes focus, not at the press (get-started.tsx). */
export function StartButton({ start, className, style, ref, warm = false }: { start: HomeStart; className: string; style?: CSSProperties; ref?: Ref<HTMLElement>; warm?: boolean }) {
  const full = useSignupsFull(!start.signedIn)
  if (start.signedIn) return <DashboardLink className={className} style={style} ref={ref as Ref<HTMLAnchorElement>}><span className="srt-cta-label">Open dashboard<ArrowRight className="srt-cta-arrow" size={16} strokeWidth={2} aria-hidden="true" /></span></DashboardLink>
  return <GetStartedButton className={className} style={style} ref={ref as Ref<HTMLButtonElement>} busy={start.busy} full={full} onSignIn={start.onSignIn} onSignInIntent={start.onSignInIntent} onWarm={warm ? () => start.onSignInIntent({ button: 0 }) : undefined} />
}
