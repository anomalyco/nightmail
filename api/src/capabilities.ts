/**
 * Bearer capabilities: links whose text alone lets whoever holds it act, so the route gate that lets them in without a
 * credential, the copies that withhold them and the redaction of read-only views all match the same grammar.
 */
/** An unsubscribe link's token (audience/unsubscribe.ts randomSecret('u_')). */
export const UNSUBSCRIBE_TOKEN = /u_[0-9a-f]{64}/;
/** A forward confirmation's token (endpoints.ts randomSecret('fwd_')). */
export const FORWARD_CONFIRM_TOKEN = /fwd_[0-9a-f]{64}/;
/** A forward's stop link (endpoints.ts forwardStopUrl): the forward's ID and its HMAC-SHA256, base64url. */
export const FORWARD_STOP_TOKEN = /con_[0-9a-f]{32}\.[A-Za-z0-9_-]{43}/;
/** A sign-in link's `link=` value (signups.ts signinLinkUrl): an 18-byte ID and its HMAC-SHA256, both base64url. */
export const SIGNIN_LINK_TOKEN = /[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}/;

/** One global pattern matching any of `tokens`; a sign-in link's only after `link=`, where nothing else looks like it. */
export function capabilityPattern(...tokens: RegExp[]) {
  return new RegExp(tokens.map(token => token === SIGNIN_LINK_TOKEN ? `(?<=\\blink=)${token.source}` : token.source).join('|'), 'g');
}
