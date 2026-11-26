import { z } from 'zod';

// The private NIGHTMAIL_RAMP setting: JSON overriding the send review's ramp sizing (src/standing-model.ts RampLines),
// e.g. {"young":{"first":500}}. Unset or not valid, the defaults apply.
const Plan = z.object({ first: z.number().int().positive(), cleanFactor: z.number().nonnegative(), growth: z.number().min(1), maxBatches: z.number().int().min(1).max(30) }).partial().strict();
const FirstBatch = z.object({ size: z.number().int().positive(), waitMinutes: z.number().int().min(10).max(24 * 60) }).partial().strict();
export const RampLinesOverride = z.object({ newRegistrationDays: z.number().int().nonnegative(), usualJump: z.number().positive(), minimumSplit: z.number().int().nonnegative(), young: Plan, established: Plan, firstBatch: FirstBatch }).partial().strict();
export type RampLinesOverride = z.infer<typeof RampLinesOverride>;
export function parseRampLines(raw: unknown): RampLinesOverride | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try { return RampLinesOverride.parse(JSON.parse(raw)); } catch { return null; }
}
