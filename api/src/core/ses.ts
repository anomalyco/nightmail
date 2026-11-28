import type { SESv2Client } from '@aws-sdk/client-sesv2';
import type { ReadyConnection } from '../provider-credentials.js';
import { addSesBodySplice } from '../ses-body.js';
import type { Runtime } from './types.js';
import { ApiError, lazyModule, wrapModuleLoad } from './errors.js';

export function region(runtime: Runtime, value: string) {
  if (!runtime.config.regions.includes(value)) throw new ApiError(422, 'REGION_NOT_CONFIGURED', 'The requested region is not configured for this deployment.', 'region');
  return value;
}
// Runtime identities are invocation-local in Workers; never reuse an I/O client
// across requests. Node drains also receive a fresh resolved runtime.
const sesClients = new WeakMap<Runtime, Map<string, SESv2Client>>();
export const isSimulatedSes = (runtime: Runtime) => !runtime.config.liveEnabled || !runtime.config.aws;
export function assertSesConfigured(runtime: Runtime) {
  if (isSimulatedSes(runtime)) throw new ApiError(503, 'SES_NOT_CONFIGURED', 'Live SES access is disabled or AWS credentials are missing.');
}
export function assertSharedAccount(runtime: Runtime, row: Pick<ReadyConnection, 'kind' | 'aws_account_id'>) {
  if (runtime.config.multiTenant && row.kind === 'shared' && runtime.config.platformAccount && row.aws_account_id !== null && row.aws_account_id !== runtime.config.platformAccount)
    throw new ApiError(503, 'AWS_ACCOUNT_MISMATCH', 'This Hosted binding belongs to a different platform account.', undefined, true);
}
// Old queued simulator jobs and SNS receipts retain their original topic as a deduplication key.
export function simulatedTopic(topic: unknown, region?: unknown) {
  if (typeof topic !== 'string') return false;
  return ['urn:bane:simulated-ses:', 'urn:opensend:simulated-ses:'].some(prefix => region === undefined ? topic.startsWith(prefix) : topic === prefix + region);
}
/** The bane_email_id tag the dispatcher stamps on every SES message (only meaningful after SNS signature verification). */
export function taggedEmailId(message: unknown): string | undefined {
  const tags = (message as { mail?: { tags?: Record<string, unknown> } } | undefined)?.mail?.tags;
  const tag = tags?.bane_email_id ?? tags?.opensend_email_id;
  const value = Array.isArray(tag) ? tag[0] : undefined;
  return typeof value === 'string' && /^email_[a-z0-9]{8,64}$/.test(value) ? value : undefined;
}
const loadSesClientDeps = lazyModule(() => Promise.all([import('@aws-sdk/client-sesv2'), import('@smithy/fetch-http-handler'), import('../provider-credentials.js')]));
export async function preloadSesTransport(multiTenant = false) {
  const [sesv2, { FetchHttpHandler }, creds] = await wrapModuleLoad(() => loadSesClientDeps());
  if (multiTenant) await wrapModuleLoad(() => creds.loadStsSdk());
  const getSesSync = (runtime: Runtime, selectedRegion: string, connection?: ReadyConnection, runClients?: Map<string, SESv2Client>): SESv2Client => {
    region(runtime, selectedRegion);
    assertSesConfigured(runtime);
    if (runtime.config.multiTenant && connection) assertSharedAccount(runtime, connection); // Even a cached SDK client must not cross a rebind.
    let clients = runClients ?? sesClients.get(runtime);
    if (!clients) { clients = new Map(); sesClients.set(runtime, clients); }
    // The dispatcher leases the connection alongside the mail. One shared-account client can
    // sign for all Hosted tenants (TenantName is on the command); BYO role rotations must get
    // a new provider. Never put a request-bound client or pending STS promise across invocations.
    const key = runClients && connection
      ? JSON.stringify([selectedRegion, connection.kind, connection.aws_account_id, connection.role_arn, connection.external_id, connection.deliverySession])
      : connection ? JSON.stringify([selectedRegion, connection.id, connection.identitySession, connection.deliverySession]) : selectedRegion;
    let client = clients.get(key);
    if (!client) {
      client = new sesv2.SESv2Client({ region: selectedRegion, ...(runtime.config.multiTenant ? { credentials: () => creds.workspaceCredentials(runtime, selectedRegion, connection), ignoreConfiguredEndpointUrls: true } : { credentials: runtime.config.aws }), maxAttempts: 1, cacheMiddleware: !!runClients, requestHandler: new FetchHttpHandler({ requestTimeout: 15000 }) });
      addSesBodySplice(client.middlewareStack);
      clients.set(key, client);
    }
    return client;
  };
  return { sesv2, getSesSync };
}
export async function getSes(runtime: Runtime, selectedRegion: string, connection?: ReadyConnection, runClients?: Map<string, SESv2Client>): Promise<SESv2Client> {
  region(runtime, selectedRegion);
  assertSesConfigured(runtime);
  if (runtime.config.multiTenant && connection) assertSharedAccount(runtime,connection); // Even a cached SDK client must not cross a rebind.
  const { getSesSync } = await preloadSesTransport(runtime.config.multiTenant);
  return getSesSync(runtime, selectedRegion, connection, runClients);
}
