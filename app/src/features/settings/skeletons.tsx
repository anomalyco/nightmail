import { Button, Checkbox, ControlSkeleton, FieldSkeleton, LoadingRegion, PageHeader, SectionHeader, Skeleton, SkeletonText, TableSkeleton, Tabs, type SkeletonColumn } from '../../components/ui'
import { useRegion, useWorkspaceAccess } from '../../data/context'
import './settings.css'
import './domain-records.css'
import './api-keys.css'

const twoLines = <div><SkeletonText width="74%" /><SkeletonText width="88%" /></div>
/** The API keys page's type filter: every credential, or one of its three types. */
export const keyTypes = [{ value: 'all', label: 'All' }, { value: 'api', label: 'API keys' }, { value: 'agent', label: 'Agent tokens' }, { value: 'app', label: 'App passwords' }] as const
export type KeyTypeFilter = typeof keyTypes[number]['value']
export const settingsColumns = {
  // A credential's card: its name and type, what it can do, then its prefix and last use (or when it expires); Revoke
  // is in the row's menu.
  keys: [
    { key: 'name', label: 'Name', width: '24%', skeleton: twoLines, card: 'title' },
    { key: 'type', label: 'Type', width: '12%', card: 'aside' },
    { key: 'access', label: 'Access', width: '30%', skeleton: twoLines, card: 'line' },
    { key: 'prefix', label: 'Key prefix', width: '13%', card: 'hide' },
    { key: 'last', label: 'Last used', card: 'line' },
    { key: 'actions', label: '', align: 'right', width: 100, skeleton: <ControlSkeleton width={32} />, card: 'end' },
  ],
  // A domain's card: its name and sending status, then the host it receives at (or Off). Every cell is one line.
  domains: [
    { key: 'name', label: 'Domain', width: '40%', card: 'title' },
    { key: 'status', label: 'Status', width: '30%', card: 'aside' },
    { key: 'receiving', label: 'Receiving', width: '32%', card: 'line' },
    { key: 'addresses', label: 'Addresses', align: 'right', card: 'hide' },
    { key: 'region', label: 'Region', card: 'hide' },
  ],
  // A receiving host's card: the host and its status, then its addresses and catch-all; Remove is in the row's menu.
  hosts: [
    { key: 'host', label: 'Host', width: '38%', card: 'title' },
    { key: 'status', label: 'Status', width: '24%', card: 'aside' },
    { key: 'addresses', label: 'Addresses', width: '14%', card: 'field' },
    { key: 'catchAll', label: 'Catch-all', card: 'field' },
    { key: 'actions', label: '', align: 'right', width: 56, skeleton: <ControlSkeleton width={32} />, card: 'end' },
  ],
  // A record's card: what it is for and its type, its status, then its name and value; Copy is in the row's menu.
  dns: [
    { key: 'purpose', label: 'Purpose', width: 112, card: 'title' },
    // A card shows the type in its title, beside the purpose.
    { key: 'type', label: 'Type', width: 72, card: 'hide' },
    { key: 'name', label: 'Name', width: '28%', card: 'field', skeleton: <SkeletonText width="70%" /> },
    { key: 'value', label: 'Value', card: 'field', skeleton: <SkeletonText width="64%" /> },
    { key: 'status', label: 'Status', width: 128, card: 'aside' },
    // Only rows with actions of their own (custom MAIL FROM, the receiving host) have a menu in the table; every card has one.
    { key: 'actions', label: '', align: 'right', width: 56, skeleton: <span />, card: 'end' },
  ],
  regions: [
    { key: 'region', label: 'Region', width: '45%' },
    { key: 'status', label: 'Status' },
    { key: 'actions', label: '', align: 'right', width: 120, skeleton: <ControlSkeleton width={76} /> },
  ],
  configurationSets: [
    {key: 'name', label: 'Configuration set', width: '44%', skeleton: twoLines},
    {key: 'exists', label: 'Exists', width: '9%'},
    {key: 'owned', label: 'Owned', width: '9%'},
    {key: 'sending', label: 'Sending', width: '12%'},
    {key: 'destination', label: 'Destination', width: '14%'},
    {key: 'wired', label: 'Connection', width: '12%'},
  ],
  // A member's card: name and role, then the email; Remove and the role change are in the row's menu.
  members: [
    { key: 'name', label: 'Name', width: '24%', card: 'title' },
    { key: 'email', label: 'Email', width: '38%', card: 'line' },
    { key: 'role', label: 'Role', width: 140, card: 'aside' },
    { key: 'actions', label: '', align: 'right', width: 112, skeleton: <ControlSkeleton width={70} />, card: 'end' },
  ],
  // An invitation's card: the address, its role, when it expires; copy and Revoke are in the row's menu.
  invitations: [
    { key: 'email', label: 'Email', width: '40%', card: 'title' },
    { key: 'role', label: 'Role', width: 160, card: 'line' },
    { key: 'expires', label: 'Expires', card: 'inline' },
    { key: 'actions', label: '', align: 'right', width: 160, skeleton: <ControlSkeleton width={120} />, card: 'end' },
  ],
  // A webhook's card: its name and status, its URL, then how many events it gets.
  webhooks: [
    { key: 'name', label: 'Name / Endpoint URL', width: '38%', skeleton: twoLines, card: 'title' },
    { key: 'url', label: 'URL', table: false, card: 'line' },
    { key: 'scope', label: 'Region scope', width: '18%', card: 'hide' },
    { key: 'events', label: 'Events', width: '10%', card: 'line' },
    { key: 'headers', label: 'Headers', width: '18%', card: 'hide' },
    { key: 'status', label: 'Status', card: 'aside' },
  ],
  // A delivery's card: when and its status, the event and response, then Retry and Inspect.
  deliveries: [
    { key: 'time', label: 'Time · UTC', width: '16%', skeleton: twoLines, card: 'title' },
    { key: 'region', label: 'Region', width: '14%', card: 'hide' },
    { key: 'event', label: 'Event', width: '16%', card: 'line' },
    { key: 'status', label: 'Status', width: '22%', skeleton: twoLines, card: 'aside' },
    { key: 'attempts', label: 'Attempts', card: 'inline' },
    { key: 'actions', label: '', align: 'right', width: 220, skeleton: <ControlSkeleton width={85} />, card: 'end' },
  ],
  // An activity card: what happened and when, then plain lines for who (and where from) and the target.
  activity: [
    { key: 'when', label: 'When', width: 112, card: 'aside' },
    { key: 'who', label: 'Who', width: '20%', card: 'line' },
    { key: 'action', label: 'Action', width: '22.5%', card: 'title' },
    { key: 'target', label: 'Target', width: '22.5%', card: 'line' },
    { key: 'from', label: 'From', card: 'hide' },
  ],
} satisfies Record<string, SkeletonColumn[]>
// Hosted workspaces span every region, so their domains table has no Region column.
const [domainName, domainStatus, domainReceiving, domainAddresses, domainRegion] = settingsColumns.domains
// The widths the loaded table forces (domain-records.css), so the skeleton and the list agree.
export const domainColumns = (multiTenant: boolean): SkeletonColumn[] => multiTenant
  ? [{ ...domainName, width: '38%' }, { ...domainStatus, key: 'sending', label: 'Sending', width: '29%' }, { ...domainReceiving, width: '23%' }, { ...domainAddresses, width: '10%' }]
  : [{ ...domainName, width: '34%' }, { ...domainStatus, key: 'sending', label: 'Sending', width: '26%' }, { ...domainReceiving, width: '21%' }, { ...domainAddresses, width: '9%' }, { ...domainRegion, width: '10%' }]
// Hosted webhooks cover every region, so they have no region scope or region columns.
const hostedWebhookColumns: SkeletonColumn[] = [{ ...settingsColumns.webhooks[0], width: '54%' }, settingsColumns.webhooks[1], { ...settingsColumns.webhooks[3], width: '16%' }, { ...settingsColumns.webhooks[4], width: '12%' }, settingsColumns.webhooks[5]]
const hostedDeliveryColumns: SkeletonColumn[] = [settingsColumns.deliveries[0], { ...settingsColumns.deliveries[2], width: '30%' }, ...settingsColumns.deliveries.slice(3)]
export const webhookColumns = (multiTenant: boolean): SkeletonColumn[] => multiTenant ? hostedWebhookColumns : settingsColumns.webhooks
export const deliveryColumns = (multiTenant: boolean): SkeletonColumn[] => multiTenant ? hostedDeliveryColumns : settingsColumns.deliveries

export function RegionDiscoverySkeleton() {
  return <LoadingRegion label="Checking AWS" className="settings-loading-body">
    <div className="settings-report"><div className="stack settings-discovery-section"><h3>Account</h3><dl className="settings-facts settings-account-summary">{['AWS account', 'SES access', 'Sent / SES quota', 'Send rate'].map(name => <div key={name}><dt>{name}</dt><dd><SkeletonText width={120} /></dd></div>)}</dl></div>
    <div className="settings-aws-details"><SkeletonText width={90} /></div></div>
  </LoadingRegion>
}

export function SesSendingSkeleton({ regionId }: { regionId: string }) {
  return <LoadingRegion label="Loading sending regions" className="settings-loading-body">
    <section id="sending" className="section stack settings-group"><SectionHeader title="Regions" actions={<div className="cluster"><ControlSkeleton width={88} /><ControlSkeleton width={114} /></div>} /><div className="ui-field"><span className="ui-field__label">Default sending region</span><ControlSkeleton width={320} /></div><TableSkeleton columns={settingsColumns.regions} rows={2} /></section>
    <section className="section stack settings-rule"><SectionHeader title={<span className="cluster">{regionId}<Skeleton width={64} /></span>} actions={<div className="cluster"><ControlSkeleton width={100} /><ControlSkeleton width={180} /></div>} /><div className="settings-setup-checklist"><h3>Provisioning</h3><ul className="settings-setup-steps">{['AWS account access', 'SES configuration sets', 'SNS topic and permissions', 'SES event destinations', 'HTTPS subscription'].map(name => <li key={name}><Skeleton width={16} /><div className="settings-setup-step-heading settings-setup-step"><span>{name}</span><SkeletonText width={100} /></div></li>)}</ul></div><RegionDiscoverySkeleton /></section>
  </LoadingRegion>
}

// Members and invitations as they will be, so the section holds its place while the two lists load.
export function TeamSkeleton() {
  return <LoadingRegion label="Loading members" className="settings-loading-body">
    <section className="section stack settings-rule"><div className="settings-actions"><ControlSkeleton width={134} /></div><TableSkeleton className="settings-people" columns={settingsColumns.members} rows={3} /></section>
    <section className="section stack settings-rule"><SectionHeader title="Invitations" /><TableSkeleton className="settings-people" columns={settingsColumns.invitations} rows={2} /></section>
  </LoadingRegion>
}

export function WorkspaceFormSkeleton() {
  return <LoadingRegion label="Loading workspace" className="settings-loading-body">
    <section id="workspace" className="section stack settings-group settings-rule"><SectionHeader title="Workspace" actions={<ControlSkeleton width={70} />} /><FieldSkeleton label="Name" /><FieldSkeleton label="Postal address" multiline /></section>
  </LoadingRegion>
}

export function EndpointFieldsSkeleton({ isNew = false, selectedRegions = false }: { isNew?: boolean; selectedRegions?: boolean }) {
  const { multiTenant } = useWorkspaceAccess()
  return <div className="stack">
    <div className="form-grid webhook-fields"><FieldSkeleton label="Name" /><FieldSkeleton label="Endpoint URL" /></div>
    {!multiTenant && <div className="stack settings-region-scope"><div className="ui-field"><span className="ui-field__label">Region scope</span><ControlSkeleton /></div>
    {selectedRegions && <div className="settings-choices"><ControlSkeleton width={135} /><ControlSkeleton width={135} /></div>}</div>}
    <div className="stack"><div>Events</div><div className="settings-choices settings-choices--events">{['Sent', 'Delivered', 'Bounced', 'Complained', 'Rejected', 'Rendering failed', 'Delivery delayed', 'Opened', 'Clicked', 'Contact subscription changed', 'Sending standing changed'].map(event => <div className="ui-check-field" key={event} aria-hidden="true"><Skeleton width={14} height={14} /><span>{event}</span></div>)}</div></div>
    <div className="ui-field webhook-headers"><span className="ui-field__label">Headers</span><div className="webhook-headers__actions"><Skeleton width={isNew ? 100 : 124} height="var(--control-height-sm)" /></div></div>
  </div>
}

export function WebhookBodySkeleton({ isNew = false, selectedRegions = false }: { isNew?: boolean; selectedRegions?: boolean }) {
  const { multiTenant } = useWorkspaceAccess()
  return <LoadingRegion label={isNew ? 'Loading webhook form' : 'Loading webhook endpoint'} className="settings-loading-body">
    {isNew ? <div className="stack"><EndpointFieldsSkeleton isNew /><div className="cluster"><ControlSkeleton width={128} /></div></div> : <>
      <EndpointFieldsSkeleton selectedRegions={selectedRegions} />
      <section className="section stack settings-rule settings-secret"><SectionHeader title={<span className="settings-guide-title">Signing secret<span className="guide-link">Guide</span></span>} actions={<><ControlSkeleton width={76} /><ControlSkeleton width={138} /></>} /></section>
      <section className="section stack settings-rule"><SectionHeader title="Delivery history" /><TableSkeleton columns={deliveryColumns(multiTenant)} rows={2} /></section>
      <div><ControlSkeleton width={146} /></div>
    </>}
  </LoadingRegion>
}

export function DomainDetailSkeleton() {
  const { multiTenant } = useWorkspaceAccess()
  return <LoadingRegion className="stack" label="Loading domain">
    <PageHeader title={<SkeletonText width={260} lineHeight={28} />} backTo="/domains" actions={<><Skeleton className="domain-status-skeleton" width={72} height={20} /><ControlSkeleton width={112} /><ControlSkeleton width={124} /></>} />
    <div className="domain-sections"><section className="section stack domain-records-section"><div className="domain-records-actions"><ControlSkeleton width={128} /><ControlSkeleton width={104} /></div><div className="domain-records-list"><TableSkeleton className="domain-records" columns={settingsColumns.dns} rows={multiTenant ? 6 : 4} /><div className="domain-records-add"><SkeletonText width={176} /></div></div></section></div>
  </LoadingRegion>
}

// The API keys header, inert while the page loads: the same controls, so nothing in it moves when they come alive.
function KeysHeaderActions() {
  return <><Checkbox label="Show inactive" checked={false} onCheckedChange={() => {}} disabled /><Button variant="primary" disabled>Create key</Button></>
}

export function SettingsRouteSkeleton({ kind, isNew = false }: { kind: 'keys' | 'domains' | 'domain' | 'settings' | 'webhook'; isNew?: boolean }) {
  const { regionId } = useRegion()
  const { multiTenant } = useWorkspaceAccess()
  if (kind === 'domain') return <DomainDetailSkeleton />
  if (kind === 'webhook') return <LoadingRegion className="stack settings-page" label="Loading webhook"><PageHeader title={isNew ? 'Add webhook' : <SkeletonText width={240} lineHeight={28} />} backTo="/settings#webhooks" actions={isNew ? undefined : <><Skeleton width={70} /><ControlSkeleton width="calc(5ch + 26px)" /><ControlSkeleton width={128} /></>} /><WebhookBodySkeleton isNew={isNew} /></LoadingRegion>
  if (kind === 'settings') return <LoadingRegion className="stack settings-ses settings-page" label="Loading settings"><PageHeader title="Settings" />{!multiTenant && <><SesSendingSkeleton regionId={regionId} /><WorkspaceFormSkeleton /></>}</LoadingRegion>
  if (kind === 'keys') return <LoadingRegion className="stack" label="Loading API keys"><PageHeader title="API keys" actions={<KeysHeaderActions />} /><div className="keys-sections"><section className="section stack"><Tabs label="Type" value="all" onValueChange={() => {}} disabled items={[...keyTypes]} /><TableSkeleton className="keys-table keys-table--two-line" columns={settingsColumns.keys} rows={3} /></section></div></LoadingRegion>
  return <LoadingRegion className="stack" label="Loading domains"><PageHeader title="Domains" actions={<ControlSkeleton width="calc(10ch + 26px)" />} /><TableSkeleton className="domains-table" columns={domainColumns(multiTenant)} rows={3} pagination /></LoadingRegion>
}
