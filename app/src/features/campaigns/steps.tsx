import { useRef, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Link } from 'react-router'
import { BackLink, Icon } from '../../components/ui'

// The campaign pages' 48px top bar: back, the path (Campaigns / the status, then the campaign's name), the steps in the
// middle, the actions (with their shortcuts) at the end. The status leads the name on Write and Review alike, so a name
// that loads or changes never moves it. `crumb`: where back leads (Campaigns, or a newsletter).
export function CampaignBar({ back = '/campaigns', crumb = 'Campaigns', title, status, steps, actions }: { back?: string; crumb?: ReactNode; title: ReactNode; status?: ReactNode; steps?: ReactNode; actions?: ReactNode }) {
  return <header className="studio-bar">
    <div className="studio-bar__start"><BackLink to={back} /><span className="studio-bar__crumb" aria-hidden="true"><span className="studio-bar__crumb-text">{crumb}</span><span className="studio-bar__sep">/</span></span>{status && <span className="studio-bar__status">{status}</span>}{title}</div>
    <div className="studio-bar__steps">{steps}</div>
    <div className="studio-bar__end">{actions}</div>
  </header>
}

// A header row's problem, on the line under the row (never a tinted row): it folds open and closed like the rows around
// it, keeping its words while it closes.
export function RowProblem({ id, message }: { id: string; message: string }) {
  const last = useRef(message)
  if (message) last.current = message
  return <div className="campaign-compose-preview" data-open={message ? '' : undefined} aria-hidden={!message}>
    <div><p id={id} className="campaign-compose-problem ui-field__error" role="alert">{last.current}</p></div>
  </div>
}

// Write, then Review: a campaign is put together first and checked and sent after, as in other mail tools.
export function CampaignSteps({ step, onReview, writeTo }: { step: 'write' | 'review'; onReview?: () => void; writeTo?: string }) {
  const write = <><span className="campaign-steps__mark" aria-hidden="true">{step === 'review' ? <Icon icon={Check} size="xs" /> : '1'}</span>Write</>
  const review = <><span className="campaign-steps__mark" aria-hidden="true">2</span>Review</>
  return <ol className="campaign-steps" aria-label="Steps">
    <li aria-current={step === 'write' ? 'step' : undefined}>{step === 'review' && writeTo ? <Link to={writeTo}>{write}</Link> : <span>{write}</span>}</li>
    <li aria-current={step === 'review' ? 'step' : undefined}>{step === 'write' ? <button type="button" disabled={!onReview} onClick={onReview}>{review}</button> : <span>{review}</span>}</li>
  </ol>
}
