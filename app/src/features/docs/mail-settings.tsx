import type { ReactNode } from 'react'
import { Button, Identifier, KeyValues } from '../../components/ui'
import { useSession } from '../../data/context'

/** The hosts mail apps connect to, or null when this installation has no IMAP/SMTP gateway. */
export const useMailServers = () => useSession()?.identity?.mailServers ?? null

export const imapPorts = '993 (TLS) or 143 (STARTTLS)'
export const smtpPorts = '465 (TLS) or 587 (STARTTLS)'

const host = (value: string, protocol: string) => <Identifier value={value} head={value.length} copyLabel={`Copy ${protocol} server`} />

/** What a mail app, or an app that sends over SMTP, needs: the SMTP & IMAP page's sections (`password`, the way to make
 *  one) and the secret dialog after creating one (the secret above it). One server reads Server and Port; both read IMAP
 *  and SMTP, each with its ports under it. */
export function MailSettings({ username, password = 'The secret above', imap = false, smtp = true }: { username: ReactNode; password?: ReactNode; imap?: boolean; smtp?: boolean }) {
  const servers = useMailServers()
  if (!servers) return null
  const shown = [...imap ? [['IMAP', servers.imap, imapPorts]] : [], ...smtp ? [['SMTP', servers.smtp, smtpPorts]] : []]
  const rows: [ReactNode, ReactNode][] = shown.length === 1
    ? [['Server', host(shown[0][1], shown[0][0])], ['Port', shown[0][2]]]
    : shown.map(([protocol, value, ports]) => [protocol, <span className="mail-settings__server">{host(value, protocol)}<span>{ports}</span></span>])
  return <KeyValues className="mail-settings" items={[...rows, ['Username', username], ['Password', password]]} />
}

/** The username an app signs in to SMTP with, beside any API key that can send (an SMTP login). */
export const SmtpUsername = () => <Identifier value="apikey" copyLabel="Copy username" />

/** The SMTP & IMAP page's two sections: the settings, and the button that makes the password as the password's value.
 *  Without `onCreate` (the page loading) the button waits, disabled, where it will be. */
export function MailSection({ kind, onCreate }: { kind: 'smtp' | 'imap'; onCreate?: () => void }) {
  const password = (button: string) => <span className="mail-settings__password"><Button size="sm" disabled={!onCreate} onClick={onCreate}>{button}</Button></span>
  return kind === 'smtp' ? <MailSettings username={<SmtpUsername />} password={password('Create SMTP login')} />
    : <MailSettings imap username="The inbox’s address" password={password('Create app password')} />
}
