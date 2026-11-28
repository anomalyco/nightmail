import { ApiError } from './core/errors.js';
import type { EndpointType } from './ritual-schema.js';

/** A rule action that should run again later. Every endpoint type schedules retries through this one class. */
export class ActionRetry extends ApiError {
  constructor(code: string, readonly afterMs: number = 0) {
    super(503, code, 'Rule delivery will be retried.', undefined, true);
  }
}
/**
 * Exponential backoff from 15 s, quadrupling each attempt, spread evenly over ±25% so work that failed together (a
 * batch of webhooks to one endpoint, every job during a database outage) does not retry together. Never longer than
 * `capMs`: waits at the cap spread evenly over its last quarter. Never sooner than `afterMs` (an endpoint's Retry-After).
 */
export function retryDelay(attempt: number, { capMs, afterMs = 0, random = Math.random }: { capMs: number; afterMs?: number; random?: () => number }) {
  const raw = 15_000 * 4 ** Math.min(20, Math.max(0, attempt - 1));
  const lo = Math.min(0.75 * raw, 0.75 * capMs), hi = Math.min(1.25 * raw, capMs);
  return Math.max(afterMs, Math.round(lo + (hi - lo) * random()));
}
/** A webhook answer that retrying will not change: a 4xx other than 408 (timeout) and 429 (throttled). Those, a 5xx and a
 *  network error are retried (the delivery contract in createWebhook's description). */
export const refusedForGood = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;
/** Retry-After as delta seconds (integer or decimal, as Discord sends) or an HTTP date; capped at 7 days. */
export function retryAfterMs(value?: string | null, now = Date.now()) {
  if (!value) return 0;
  const trimmed = value.trim();
  const ms = /^\d+(?:\.\d+)?$/.test(trimmed) ? Math.ceil(Number(trimmed) * 1000) : /[a-z]/i.test(trimmed) ? Date.parse(trimmed) - now : NaN;
  return Number.isFinite(ms) ? Math.max(0, Math.min(ms, 7 * 86400000)) : 0;
}

export type EndpointPolicy = { perMinute: number; retryOnTimeout: boolean; idempotent: boolean };
/**
 * Defaults per endpoint type, overridden per endpoint with updateEndpoint. Chat posts are not
 * idempotent, so an ambiguous timeout is not retried unless asked. A forward is deduplicated by
 * message and endpoint inside the send transaction, so retrying it is always safe.
 */
export const DEFAULT_POLICY: Record<EndpointType, EndpointPolicy> = {
  slack: { perMinute: 60, retryOnTimeout: false, idempotent: false },
  discord: { perMinute: 30, retryOnTimeout: false, idempotent: false },
  webhook: { perMinute: 600, retryOnTimeout: false, idempotent: false },
  forward: { perMinute: 60, retryOnTimeout: true, idempotent: true },
};
export function endpointPolicy(type: EndpointType, row?: { per_minute?: number | null; retry_on_timeout?: boolean | null; idempotent?: boolean | null } | null): EndpointPolicy {
  const base = DEFAULT_POLICY[type];
  return {
    perMinute: row?.per_minute ?? base.perMinute,
    retryOnTimeout: type === 'forward' || (row?.retry_on_timeout ?? base.retryOnTimeout),
    idempotent: type === 'forward' || (row?.idempotent ?? base.idempotent),
  };
}
/** Whether an attempt whose outcome is unknown (timeout, dropped connection, lost worker) may be sent again. */
export const replaySafe = (policy: EndpointPolicy) => policy.idempotent || policy.retryOnTimeout;
