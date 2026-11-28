import { ArrowUpRight } from 'lucide-react'
import { Alert, Button, CopyButton, Dialog } from '../../components/ui'
import { useApiDef } from '../../data/context'
import { queries } from '../../data/queries'
import type { DisconnectSummary, ProviderConnection } from '../../data/types'
import { productName } from '../../../../api/src/brand'
import './aws-disconnect.css'

// A connected AWS account's disconnect: the cleanup's progress, what it couldn't remove, the stack to delete, and the SES
// identities that stay in the account, with the DNS records of those Nightmail created. Shown in a dialog once the
// disconnect is confirmed, and by onboarding while the cleanup runs.
export function cleanupStatus(cleanup: ProviderConnection['cleanup'], done = false) {
  return done ? `${productName} removed the configuration sets and topics it created in your AWS account.`
    : cleanup?.lastError ? `AWS refused a cleanup step (${cleanup.lastError.code}). Fix access to the ${productName} role and disconnect again to retry.`
    : `Removing the configuration sets and topics ${productName} created…`
}
export function DisconnectDetails({ summary }: { summary: DisconnectSummary }) {
  return <>
    {summary.leftBehind.length > 0 && <Alert tone="warning" title="Left in your AWS account">
      <p>Delete these in the SES and SNS consoles.</p>
      <ul className="aws-disconnect__list">{summary.leftBehind.map(item => <li key={item.resource}><code>{item.resource}</code></li>)}</ul>
    </Alert>}
    {summary.stack && <p className="aws-disconnect__status">The {productName} role stays until you delete its stack: <a href={summary.stack.consoleUrl} target="_blank" rel="noopener noreferrer">delete {summary.stack.name} in AWS<ArrowUpRight size={14} aria-hidden="true" /></a></p>}
    {summary.retained.length > 0 && <section className="aws-disconnect__section">
      <h3>SES identities that stay</h3>
      {summary.retained.map(identity => <div key={identity.region + identity.domain} className="aws-disconnect__identity">
        <h4>{identity.domain} <span className="muted">{identity.regionLabel}{identity.createdByNightmail ? '' : ' · already in your account'}</span></h4>
        {/* The records to remove with the identity, by name; the API has their values too. */}
        {identity.records.length > 0 && <ul className="aws-disconnect__records">{identity.records.map(record => <li key={record.type + record.name + record.value}>
          <span className="aws-disconnect__type">{record.type}</span><code>{record.name}</code><CopyButton value={record.name} label={`Copy ${record.type} name`} />
        </li>)}</ul>}
      </div>)}
    </section>}
  </>
}
// Polls until the connection is gone; closing early leaves the cleanup running (onboarding then shows it).
export function AwsDisconnectDialog({ open, summary, onClose }: { open: boolean; summary: DisconnectSummary; onClose: () => void }) {
  const live = useApiDef(queries.connection(), { enabled: open, interval: data => data === null ? false : 2000 })
  const done = live.data === null
  const cleanup = live.data?.cleanup
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose() }} title={done ? 'Disconnected' : 'Disconnecting'} className="aws-disconnect"
    footer={<Button variant="primary" onClick={onClose}>{done ? 'Done' : 'Close'}</Button>}>
    <p className="aws-disconnect__status" role="status">{cleanupStatus(cleanup, done)}</p>
    <DisconnectDetails summary={cleanup?.summary ?? summary} />
  </Dialog>
}
