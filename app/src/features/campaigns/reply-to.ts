// Reply-To as typed: comma-separated addresses, kept as text while typing and split, trimmed and checked for the draft
// (the campaign editor and the template editor share it). Each address is checked as the API checks it.
import { validEmail } from '../../lib/domain'

export const replyToAddresses = (value: string) => value.split(',').map(address => address.trim()).filter(Boolean)
export const replyToError = (value: string) => { const addresses = replyToAddresses(value); return addresses.length > 10 ? 'Use at most 10 reply-to addresses.' : addresses.some(address => !validEmail(address)) ? 'Enter valid reply-to addresses, separated by commas.' : '' }
