import { ApiError, type Config } from '../core.js';
import { formatUsd, microCents } from './money.js';
import type { BillingGate } from './types.js';
import { productName } from '../brand.js';

/** True when this workspace is metered and may be gated: Hosted installations only, never the platform's own workspace. */
export const billed = (config: Pick<Config, 'multiTenant' | 'platformDomainWorkspace'>, workspaceId: string) =>
  config.multiTenant && workspaceId !== config.platformDomainWorkspace;

/** An enforced prepaid balance that cannot pay for a send. The admission decision (send_admission) calls billing_gate. */
export const balanceExhausted = (config: Pick<Config, 'publicUrl'>, b: Pick<BillingGate, 'requiredUc' | 'availableUc'>) => new ApiError(402, 'BALANCE_EXHAUSTED',
  `Sending is paused: this workspace's ${productName} balance is empty. Add credit at ${config.publicUrl}/settings#billing. Required ${formatUsd(microCents(b.requiredUc))}, available ${formatUsd(microCents(b.availableUc))}.`, undefined, true);
