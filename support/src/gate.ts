// The output gate: one implementation in the API (api/src/output-gate.ts), shared with the support inbox, where a staff
// member's agent's replies pass it too. Plain text for email, likewise (api/src/plain-text.ts).
export { gate, LINK_ORIGINS, namedIn, promptFragmentsOf } from '../../api/src/output-gate.js'
export { plainText } from '../../api/src/plain-text.js'
