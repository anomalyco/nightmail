/** The API's practical ASCII address shape (its z.email()), not a general mailbox grammar: a browser's type=email accepts
 *  name@example, which the API refuses. */
export const validEmail = (email: string) => email.length <= 254 && /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/.test(email)

export const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

// Accepts what people paste: a URL, an email address, www., a port, a path or a trailing dot.
export function normalizeDomain(input: string) {
  return input.trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]*@/, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '')
}

/** Picks the workspace's preferred verified sending domain: its own verified domain first, else the verified built-in domain when allowed. */
export function preferredSendingDomain<T extends { status: string; builtIn?: boolean }>(
  domains: readonly T[],
  { allowBuiltIn }: { allowBuiltIn: boolean },
): T | null {
  return domains.find(domain => !domain.builtIn && domain.status === 'verified')
    ?? (allowBuiltIn ? domains.find(domain => domain.builtIn && domain.status === 'verified') : undefined)
    ?? null
}
