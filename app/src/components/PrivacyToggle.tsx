import { togglePrivacy, usePrivacy } from '../lib/privacy'

/** Privacy mode (lib/privacy.ts), in the sidebar footer and the phone's More sheet. ⇧P toggles it too (AppShell). */
export function PrivacyToggle() {
  const on = usePrivacy()
  const state = on ? 'checked' : 'unchecked'
  return <button type="button" className="privacy-toggle" aria-pressed={on} aria-keyshortcuts="Shift+P" title="⇧P. Hold ⇧ and point at an address, or hold ⇧ on a highlighted row, to read it." onClick={togglePrivacy}>
    <span className="privacy-toggle__label">Blur email addresses</span>
    <span className="ui-switch privacy-toggle__switch" data-state={state} aria-hidden="true"><span className="ui-switch__thumb" data-state={state} /></span>
  </button>
}
