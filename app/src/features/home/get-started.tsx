import type { CSSProperties, Ref } from 'react'
import { ArrowRight, LoaderCircle } from 'lucide-react'

/** Get started, a visitor's way in: it signs in (start.tsx, StartButton). Here on its own, without the session or the
 *  dashboard's prefetching, so a page painted before any of the app's code can show it as it will be (pricing/prerender.tsx).
 *  full: no place is open (signups-open.ts), so signing in joins the waitlist, and the button says so. Both labels are
 *  always laid out, one over the other, and only the one shown is visible: the button keeps the longer one's width
 *  from the first paint, so the swap after load moves nothing. onWarm: the pointer resting on it, or keyboard focus, starts
 *  the sign-in ahead of the press (the new homepage's options: landing/index.tsx). */
export function GetStartedButton({ className, style, ref, busy = false, full = false, onSignIn, onSignInIntent, onWarm }: { className: string; style?: CSSProperties; ref?: Ref<HTMLButtonElement>; busy?: boolean; full?: boolean; onSignIn?: () => void; onSignInIntent?: (event: { button: number }) => void; onWarm?: () => void }) {
  const icon = busy ? <LoaderCircle className="ui-spinner" size={16} aria-hidden="true" /> : <ArrowRight className="srt-cta-arrow" size={16} strokeWidth={2} aria-hidden="true" />
  return <button type="button" className={className} ref={ref} style={style} disabled={busy} aria-busy={busy || undefined} data-busy={busy || undefined} data-cta="sign-in" data-full={full || undefined} onClick={onSignIn} onPointerDown={onSignInIntent}
    onPointerEnter={onWarm && (event => { if (event.pointerType === 'mouse') onWarm() })} onFocus={onWarm}>
    <span className="srt-cta-labels">
      <span className="srt-cta-label" data-off={full ? '' : undefined}>Get started{icon}</span>
      <span className="srt-cta-label srt-cta-wait" data-off={full ? undefined : ''}>Join the waitlist{icon}</span>
    </span>
  </button>
}
/** What a full Nightmail means for a visitor, under the way in. Always laid out, and visible only when `full`, so it
 *  appearing after load moves nothing. */
export function WaitlistLine({ className, full = false }: { className: string; full?: boolean }) {
  return <p className={`srt-wait-line ${className}`} data-off={full ? undefined : ''}>Full for now. Join the waitlist and we’ll email you.</p>
}
