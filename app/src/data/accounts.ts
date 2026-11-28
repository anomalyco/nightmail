import { useQuery } from '@tanstack/react-query'
import { request } from './live'
import type { WorkspaceMembership } from './types'

// The accounts this browser connected to Nightmail, one session each (api/src/account-login.ts). Only accounts added here
// are listed, never every account signed in at the account service. Each tab acts as one of them (live.ts).
export type ConnectedAccount = { id: string; name: string; email: string | null; workspaces: WorkspaceMembership[] }
export type AccountList = { accounts: ConnectedAccount[]; active: string | null; limit: number; connection?: { id: string; account: string | null } }
export const accountsKey = ['accounts'] as const
export const accountApi = {
  list: (signal?: AbortSignal, connection?: string) => request<AccountList>(`/api/auth/accounts${connection ? `?connection=${encodeURIComponent(connection)}` : ''}`, { signal, scope: 'unscoped' }),
  // The browser's default account: what a new tab, or a link opened outside the dashboard, acts as.
  makeDefault: (account: string) => request<{ account: string }>('/api/auth/accounts/switch', { method: 'POST', body: { account }, scope: 'unscoped' }),
  signOut: (input: { account?: string; all?: true }) => request<{ success: true; accounts: string[]; active: string | null }>('/api/auth/sign-out', { method: 'POST', body: input, scope: 'unscoped' }),
  // select: the account service shows its account chooser (Add account), and Nightmail learns only the account picked.
  signIn: async (callbackURL: string, select: boolean) => {
    const { url } = await request<{ url: string }>('/api/auth/sign-in/account', { method: 'POST', body: { callbackURL, ...(select ? { prompt: 'select_account' } : {}) }, scope: 'unscoped' })
    if (new URL(url).protocol !== 'https:') throw new Error('Invalid sign-in redirect.')
    return url
  },
  // A sign-in link to an address a raise let in. The answer is the same whether or not one was sent.
  signInLink: (email: string) => request<{ requested: true }>('/api/auth/sign-in/link', { method: 'POST', body: { email }, scope: 'unscoped' }),
}
// The tab's own account comes with the session (GET /v1/me), so a list of accounts is complete before the list arrives;
// its workspaces are always the session's, which a rename has already updated.
export function withOwnAccount(self: ConnectedAccount, list: AccountList | undefined): ConnectedAccount[] {
  return list?.accounts.some(account => account.id === self.id) ? list.accounts.map(account => account.id === self.id ? { ...account, workspaces: self.workspaces } : account) : [self]
}
export function useAccounts(enabled = true) {
  return useQuery({ queryKey: accountsKey, queryFn: ({ signal }) => accountApi.list(signal), enabled, staleTime: 30_000, gcTime: Infinity })
}
// The popup an add runs in (public/signed-in/): it starts the sign-in, and when it is back announces the result to this
// browser's tabs and closes.
export const POPUP_PATH = '/signed-in/'
// A sign-in returns with ?account=<id>, and a provider return can too. The tab follows it only after a sign-in or setup
// that the person started in this tab (within 15 minutes), never because a link said so.
const expectKey = 'nightmail.expect-account'
export function expectAccount() { try { sessionStorage.setItem(expectKey, String(Date.now())) } catch { /* Then the tab stays as it is. */ } }
export function takeExpectedAccount() {
  try { const at = Number(sessionStorage.getItem(expectKey)); sessionStorage.removeItem(expectKey); return at > 0 && Date.now() - at < 15 * 60_000 } catch { return false }
}

// Tabs tell each other about sign-ins and sign-outs, so a tab showing an account that was just signed out leaves it at once.
export type AccountEvent = { type: 'signed-in'; tab: string | null; account: string | null; auth: string | null } | { type: 'add-started'; tab: string | null } | { type: 'signed-out'; accounts: string[] | 'all' }
// Still named bane.accounts: tabs on the build before the rename listen there, and the sign-in popup they open is always
// the deployed one (public/signed-in/signed-in.js, which must use the same name). Rename after rename cleanup.
// (None where the docs are drawn at build time, in Node: an open channel there would keep the build from ending.)
const channel = typeof window === 'undefined' || typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('bane.accounts')
export const announce = (event: AccountEvent) => channel?.postMessage(event)
export function onAccountEvent(listener: (event: AccountEvent) => void) {
  const handle = (message: MessageEvent<AccountEvent>) => listener(message.data)
  channel?.addEventListener('message', handle)
  return () => channel?.removeEventListener('message', handle)
}
export const initials = (name: string | null | undefined, email?: string | null) => {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? email ?? '?').slice(0, 1)
  return letters.toUpperCase()
}
