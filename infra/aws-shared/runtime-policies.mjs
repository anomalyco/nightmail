// Offline renderer for dedicated Nightmail accounts. Substitute only the account and SNS origin.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const names = ['bane-runtime', 'bane-runtime-ohio', 'bane-runtime-trusted'];
// The platform accounts the BYO broker never enters. The retired shared account may be connected like any customer's.
const hostedAccounts = ['009882681002', '905840579680'];
const read = (/** @type {string} */ file, /** @type {string} */ account) => JSON.parse(readFileSync(new URL(`./${file}.json`, import.meta.url), 'utf8').replaceAll('YOUR_AWS_ACCOUNT_ID', account)
  .replaceAll('"NIGHTMAIL_ACCOUNTS"', JSON.stringify([...new Set([account, ...hostedAccounts])])));
/** @param {string} account */
function dedicated(account) {
  if (!/^\d{12}$/.test(account)) throw new Error('Expected a 12-digit account');
  if (account === '438095551154') throw new Error('The retired shared account is not a dedicated Nightmail account');
}
// broker: false drops the runtime's grant to enter the BYO broker (the legacy bane-runtime user never needs it).
/** @param {string} mode @param {{ account: string, origin: string, broker?: boolean }} options */
export function render(mode, { account, origin, broker = true }) {
  if (mode !== '--fresh' || !/^\d{12}$/.test(account) || typeof origin !== 'string' || origin.length > 261 || !/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(origin)) throw new Error('Expected --fresh, a 12-digit account and an https origin');
  dedicated(account);
  const files = ['runtime-policy', 'runtime-ohio-policy', 'runtime-trusted-policy'];
  return Object.fromEntries(names.map((name, i) => {
    const policy = JSON.parse(JSON.stringify(read(files[i], account)).replaceAll('https://bane.mx/v1/events/ses', origin + '/v1/events/ses'));
    if (!broker) policy.Statement = policy.Statement.filter(s => s.Sid !== 'ByoBroker');
    if (JSON.stringify(policy).length > 6144) throw new Error(`${name} exceeds 6,144 characters; split, never widen`);
    return [name, policy];
  }));
}
/** The BYO broker role: the only principal that assumes connected-account roles, and only the runtime user enters it. */
/** @param {string} account */
export function renderBroker(account) {
  dedicated(account);
  return { name: 'nightmail-byo-broker', trust: read('byo-broker-trust-policy', account), policy: read('byo-broker-policy', account) };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , mode, name, account, origin] = process.argv;
  if (mode === '--broker' && ['trust', 'policy'].includes(name) && process.argv.length === 5) console.log(JSON.stringify(renderBroker(account)[name]));
  else if (process.argv.length !== 6 || mode !== '--fresh' || !names.includes(name)) throw new Error(`Usage: node runtime-policies.mjs --fresh <${names.join('|')}> <account> <https origin>, or --broker <trust|policy> <account>`);
  else console.log(JSON.stringify(render(mode, { account, origin })[name]));
}
