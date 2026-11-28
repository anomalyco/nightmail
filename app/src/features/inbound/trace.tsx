// Types for the rule dry run (POST /v1/rules/test), read by the flow panel (flow.tsx), a rule's page (rituals.tsx) and
// threads. Trace, the page this was, is gone: its old URL now opens Mail routing.
import { Navigate, useLocation } from 'react-router'

export type TimelineStep =
  | { kind: 'condition'; line: number; column: number; endLine: number; endColumn: number; result: boolean }
  | { kind: 'decisions'; line: number; scores: Record<string, number | boolean> }
  | { kind: 'action'; line: number; op: string; ref?: string; value?: string }
  | { kind: 'return'; line: number }
export type TraceRow = { recipient: string; kind: string; key: string; scores: Record<string, number | boolean>; steps: number; lines: number[]; error: string | null; actions: { op: string; ref?: string; value?: string }[]; timeline: TimelineStep[] }
export type TraceRecipient = { address: string; tier?: string; route?: string | null; inboxes?: string[]; webhooks?: string[]; labels?: string[]; junk?: boolean; dropped?: boolean; warnings?: string[]; domainDefault?: 'store' | 'create_address' }
export type DryRun = { version: number; steps: number; trace: TraceRow[]; recipients: TraceRecipient[] }

/** /receiving/trace, from before Test moved into the flow panel: Mail routing, the panel open on the address it was handed. */
export function TracePage() {
  const to = (useLocation().state as { to?: string } | null)?.to
  return <Navigate replace to={to ? `/receiving?q=${encodeURIComponent(to)}` : '/receiving'} />
}
