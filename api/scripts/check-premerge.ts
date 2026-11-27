// Pre-merge invariants that broke dev only after merge. Fast and offline except the quarantine issue check.
//   node --import tsx scripts/check-premerge.ts [--base <sha>]
// --base is the commit this change lands on (the PR's base tip, the merge group's base, or the previous dev tip).
// Locally it defaults to the merge-base with dev. docs/ci.md explains each failure and how to fix it.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import { registeredDocument } from './registered-document.js';

const api = new URL('../', import.meta.url), root = new URL('../', api);
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const tryGit = (...args: string[]) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const argBase = process.argv.indexOf('--base');
const base = argBase > 0 ? git('rev-parse', '--verify', `${process.argv[argBase + 1]}^{commit}`)
  : ['origin/dev', 'bane/dev', 'dev'].map(ref => tryGit('merge-base', 'HEAD', ref)).find(Boolean) ?? null;
const atBase = (path: string) => base ? tryGit('show', `${base}:${path}`) : null;
let failed = 0;
// GitHub annotations: the message shows on the PR's Files tab and in the job summary.
function fail(check: string, message: string, file?: string, line?: number) {
  failed++;
  const where = file ? ` file=${file}${line ? `,line=${line}` : ''}` : '';
  console.log(`::error${where},title=${check}::${message.replaceAll('\n', '%0A')}`);
}
const warn = (check: string, message: string, file?: string) => console.log(`::warning${file ? ` file=${file}` : ''},title=${check}::${message}`);

// 1. Every OpenAPI operation is called or explicitly skipped in the live E2E (dev deploys broke twice on this).
// The live run enforces it again at the end; this catches it before merge. A string literal ('op'), an object
// key (op: 'reason') or SKIP.op in scripts/e2e.ts counts; comments do not.
{
  const spec = registeredDocument as { paths: Record<string, Record<string, { operationId?: string }>> };
  const operations = Object.values(spec.paths).flatMap(item => Object.values(item)).map(op => op.operationId).filter((id): id is string => !!id);
  const file = 'api/scripts/e2e.ts', source = ts.createSourceFile(file, readFileSync(new URL('scripts/e2e.ts', api), 'utf8'), ts.ScriptTarget.Latest, true);
  const named = new Set<string>(), called = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) named.add(node.text);
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'api' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) called.add(node.arguments[0].text);
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) named.add(node.name.text);
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'SKIP') named.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const missing = operations.filter(op => !named.has(op));
  for (const op of missing) fail('E2E coverage', `${op} is registered but neither called nor skipped in the live dev E2E, which fails the dev deploy after merge. Call it in a step with api('${op}', …), or add it to SKIP with the reason it cannot run against dev.`, file);
  // Behaviour a release has to prove live, where a skip doesn't count: these are called with api('…') in a dev step.
  // Every address is an inbox (#362): a temporary address's mail and folders through the inbox routes, by its address ID.
  const live = ['listInboxMessages', 'getInboxMessage', 'listInboxFolders', 'getInboxChanges', 'updateInboxMessage', 'copyInboxMessage', 'moveInboxMessage', 'deleteInboxMessage', 'expungeInboxFolder'];
  for (const op of live.filter(op => !called.has(op))) fail('E2E coverage', `${op} must run in the live dev E2E, not only be skipped: an address's mail through the inbox routes is proven there. Call it with api('${op}', …) in a dev step.`, file);
  console.log(`E2E coverage: ${operations.length - missing.length}/${operations.length} operations called or skipped in ${file}; ${live.filter(op => called.has(op)).length}/${live.length} required live operations called.`);
}

// 2. Cloudflare routing. Workers Assets answers any path outside run_worker_first itself (405 for POST, the SPA's
// index.html for GET), so a route missing there is unreachable on Cloudflare while the Node server still serves it.
// The Worker's own fetch also hands GET/HEAD outside its API prefixes to the assets binding.
{
  const before = failed, { createOpenApiApp } = await import('../src/app.js');
  const glob = (p: string) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*') + '$');
  const routes = (await createOpenApiApp()).routes.filter(r => r.path !== '*' && r.path !== '/*');
  const paths = [...new Set(routes.map(r => r.path.replace(/:[^/]+/g, 'x').replaceAll('*', 'x')))];
  if (!paths.includes('/internal/v1/mail') || !paths.includes('/v1/emails')) fail('Worker routes', 'The route inventory from createOpenApiApp() is incomplete; this check needs updating.');
  const configs: Record<string, { assets: { run_worker_first: string[] } }> = {};
  for (const name of ['wrangler.dev.jsonc', 'wrangler.prod.jsonc']) {
    const parsed = ts.parseConfigFileTextToJson(name, readFileSync(new URL(name, api), 'utf8'));
    if (parsed.error) { fail('Worker routes', `api/${name} does not parse: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, ' ')}`, `api/${name}`); continue; }
    const rules: string[] = (configs[name] = parsed.config).assets.run_worker_first;
    const first = (path: string) => rules.some(r => !r.startsWith('!') && glob(r).test(path)) && !rules.some(r => r.startsWith('!') && glob(r.slice(1)).test(path));
    for (const path of paths.filter(p => !first(p))) fail('Worker routes', `${path} is an API route but api/${name} assets.run_worker_first does not match it, so Cloudflare answers it from static assets (405 or the dashboard HTML). Add its prefix (for example "/${path.split('/')[1]}/*") to run_worker_first in both wrangler configs.`, `api/${name}`);
  }
  const [dev, prod] = [configs['wrangler.dev.jsonc'], configs['wrangler.prod.jsonc']];
  if (dev && prod && !isDeepStrictEqual(dev.assets, prod.assets)) fail('Worker routes', 'The assets block differs between api/wrangler.dev.jsonc and api/wrangler.prod.jsonc. dev is the only place production routing is tested before release: keep them identical.', 'api/wrangler.prod.jsonc');
  // The Worker module imports cloudflare:workers for its Durable Object and the SupportPlatform entrypoint; give Node empty stand-ins.
  register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s,c,n){return s==='cloudflare:workers'?{url:'data:text/javascript,export class DurableObject{};export class WorkerEntrypoint{}',shortCircuit:true}:n(s,c)}`));
  const worker = (await import('../src/worker.js')).default as { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };
  const env = { ASSETS: { fetch: async () => new Response('static asset', { headers: { 'x-premerge-asset': '1' } }) }, ADMISSION: { limit: async () => ({ success: false }) } };
  // An API path ends at admission (refused here, so nothing else loads); only the outcome matters, not its log line.
  const quiet = { log: console.log, warn: console.warn, info: console.info, error: console.error }, served: string[] = [];
  Object.assign(console, { log() {}, warn() {}, info() {}, error() {} });
  try {
    for (const path of paths) {
      const response = await worker.fetch(new Request(`https://premerge.invalid${path}`), env, { waitUntil() {}, passThroughOnException() {} });
      if (response.headers.get('x-premerge-asset')) served.push(path);
    }
  } finally { Object.assign(console, quiet); }
  for (const path of served) fail('Worker routes', `GET ${path} is an API route, but src/worker.ts hands it to the static assets binding. Add its prefix to the API path pattern in the Worker's fetch handler.`, 'api/src/worker.ts');
  if (failed === before) console.log(`Worker routes: ${paths.length} API paths reach the Worker in both wrangler configs and src/worker.ts.`);
}

// 3. Migrations. src/migrate.ts tracks applied filenames in nightmail_migrations and runs every unapplied
// /^\d+_[a-z_]+\.sql$/ file in name order (refusing a changed file). Any unused three-digit number is accepted so
// independent PRs can merge in any order; duplicate numbers (two files with the same number, or a number already on
// the base branch) are refused. Open-PR collisions are caught when the second PR merges. Because a fresh install
// applies migrations in number order, a later-merged lower-numbered migration must not depend on a higher-numbered one.
{
  const dir = 'api/migrations', applied = /^\d+_[a-z_]+\.sql$/, numbered = /^(\d{3})_[a-z_]+\.sql$/;
  // Pairs that shipped before this check, ordered by name everywhere since. Never add to this list.
  const grandfathered = new Set(['038', '093', '095', '098', '104', '105', '106', '120', '133', '140', '153', '154', '155', '158']);
  const head = readdirSync(new URL('migrations/', api)).filter(n => !n.startsWith('.')).sort();
  const number = (name: string) => numbered.exec(name)?.[1];
  for (const name of head) {
    if (!applied.test(name)) fail('Migrations', `${name} does not match ${applied} and src/migrate.ts would silently skip it. Name it NNN_lower_snake_case.sql (letters and underscores only after the number).`, `${dir}/${name}`);
    else if (!numbered.test(name)) fail('Migrations', `${name} must start with a three-digit number.`, `${dir}/${name}`);
  }
  const byNumber = new Map<string, string[]>();
  for (const name of head) { const n = number(name); if (n) byNumber.set(n, [...byNumber.get(n) ?? [], name]); }
  const baseList = base ? (tryGit('ls-tree', '--name-only', `${base}:${dir}`) ?? '').split('\n').filter(Boolean) : [];
  const baseNumbers = new Map<string, string>();
  for (const name of baseList) { const n = number(name); if (n && !baseNumbers.has(n)) baseNumbers.set(n, name); }
  const baseMax = baseList.map(number).filter(Boolean).sort().at(-1) ?? '000';
  const added = head.filter(n => !baseList.includes(n));
  let next = Math.max(Number(baseMax), ...[...byNumber.keys()].map(Number)) + 1;
  const free = () => String(next++).padStart(3, '0');
  for (const name of baseList) {
    if (!head.includes(name)) fail('Migrations', `${name} is on the base branch and was deleted or renamed. Applied migrations are permanent: restore it and add a new migration.`, `${dir}/${name}`);
    else if (atBase(`${dir}/${name}`) !== readFileSync(new URL(`migrations/${name}`, api), 'utf8').trim()) fail('Migrations', `${name} is already on the base branch, and dev has applied it. Editing it fails every upgraded database with MIGRATION_CHANGED: revert the edit and add a new migration.`, `${dir}/${name}`);
  }
  for (const name of added) {
    const n = number(name);
    if (!n) continue;
    const taken = baseNumbers.get(n);
    if (taken) fail('Migrations', `${name} reuses migration number ${n} (${taken} is already on the base branch). Renumber it to ${free()}.`, `${dir}/${name}`);
  }
  for (const [n, names] of byNumber) {
    if (names.length > 1 && !grandfathered.has(n) && !(baseNumbers.has(n) && names.some(name => added.includes(name)))) {
      fail('Migrations', `Migration number ${n} is used by ${names.join(' and ')}. Renumber the newer one to ${free()}.`, `${dir}/${names.find(name => added.includes(name)) ?? names.at(-1)}`);
    }
  }
  console.log(`Migrations: ${head.length} files, ${added.length} new${base ? ` (base ${base.slice(0, 12)}, highest ${baseMax})` : ' (no base: base collisions not checked)'}.`);
}

// 4. Phone layout: below 640 px every DataTable renders cards from each column's `card` slot (AGENTS.md). A column
// defined without one falls back to a guessed slot. Existing columns are grandfathered; a new one must say where it goes.
{
  const columns = (file: string, text: string) => {
    const found: { key: string; line: number }[] = [];
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node) && !node.properties.some(ts.isSpreadAssignment)) {
        const props = new Map(node.properties.flatMap(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [[p.name.text, p] as const] : []));
        if (props.has('key') && props.has('label') && props.has('render') && !props.has('card')) {
          const key = props.get('key')!;
          found.push({ key: ts.isPropertyAssignment(key) ? key.initializer.getText(source) : 'key', line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };
  const files = git('ls-files', '--', 'app/src/*.tsx', 'app/src/*.ts').split('\n').filter(Boolean);
  let total = 0, added = 0;
  for (const file of files) {
    const now = columns(file, readFileSync(new URL(file, root), 'utf8'));
    total += now.length;
    if (!now.length) continue;
    const before = new Set(columns(file, atBase(file) ?? '').map(c => c.key));
    for (const column of now.filter(c => !before.has(c.key))) added++, fail('Card slots', `Table column ${column.key} has no card slot. Below 640 px DataTable renders each row as a card: set card to 'title', 'aside', 'line', 'inline', 'field', 'end' or 'hide' (see Column in app/src/components/ui/primitives.tsx).`, file, column.line);
  }
  console.log(`Card slots: ${total - added} grandfathered columns without a card slot, ${added} new.`);
}

// 5. Flake quarantine: an acceptance test named with [flaky #N] is skipped by the required job and run by the nightly.
// It must name its tracking issue, and that issue must still be open (closing it means the flake was fixed).
{
  const file = 'api/api.acceptance.test.ts', text = readFileSync(new URL('api.acceptance.test.ts', api), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const tagged: { name: string; issue?: number; line: number }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['test', 'it', 'describe'].includes(node.expression.text)) {
      const title = node.arguments[0];
      if (title && ts.isStringLiteralLike(title) && /flaky/i.test(title.text)) {
        tagged.push({ name: title.text, issue: Number(/\[flaky #(\d+)\]/.exec(title.text)?.[1]) || undefined, line: source.getLineAndCharacterOfPosition(title.getStart(source)).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const token = process.env.GH_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  for (const test of tagged) {
    if (!test.issue) { fail('Quarantine', `"${test.name}" mentions flaky but has no [flaky #<issue>] tag. Quarantine a test with the exact tag and its open issue, or rename it.`, file, test.line); continue; }
    if (!token || !repo) continue;
    const response = await fetch(`https://api.github.com/repos/${repo}/issues/${test.issue}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
    const issue = response.ok ? await response.json() as { state: string } : null;
    if (!issue) fail('Quarantine', `"${test.name}" is quarantined under #${test.issue}, which does not exist. Open an issue for the flake and use its number.`, file, test.line);
    else if (issue.state !== 'open') fail('Quarantine', `#${test.issue} is closed but "${test.name}" is still quarantined. Remove the [flaky #${test.issue}] tag so the test blocks again, or reopen the issue.`, file, test.line);
  }
  console.log(`Quarantine: ${tagged.length} acceptance test${tagged.length === 1 ? '' : 's'} quarantined${tagged.length ? ` (${tagged.map(t => `#${t.issue ?? '?'}`).join(', ')}); the nightly runs them` : ''}.`);
}

// 6. Identity is (issuer, subject). An issuer can assert a verified address that the sign-in method never vouched for
// (a GitHub-made account that links a personal Google account signs in with acr=google and its GitHub-verified work
// address), so nothing may admit, link or authorize a person by email. These names belonged to the removed email
// paths; one in the API sources, scripts or OIDC migrations means such a path came back. A line that must name one
// (the startup refusal of the removed settings) carries `premerge-identity: allowed`.
{
  const forbidden: [RegExp, string][] = [
    [/\bclaim_bane_legacy_user\b|\bbane_legacy_claims?\b/, 'links a subject to an existing user by email'],
    [/\bAUTH_ALLOWED_(?:EMAILS|DOMAINS)\b|\ballowed(?:Emails|Domains)\b|\bsignupApproved\b|\bgoogle_hosted_domain\b/, 'admits or authorizes by email address or domain'],
  ];
  const files = (dir: string, keep: (name: string) => boolean): string[] => readdirSync(new URL(dir, api), { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? files(`${dir}${e.name}/`, keep) : keep(e.name) ? [`${dir}${e.name}`] : []);
  const scanned = [...files('src/', n => n.endsWith('.ts')), ...files('scripts/', n => n.endsWith('.ts') && n !== 'check-premerge.ts'),
    ...files('migrations/', n => Number(n.slice(0, 3)) >= 270)];
  let hits = 0;
  for (const path of scanned) readFileSync(new URL(path, api), 'utf8').split('\n').forEach((text, i) => {
    if (text.includes('premerge-identity: allowed')) return;
    for (const [pattern, why] of forbidden) if (pattern.test(text)) hits++, fail('Identity', `${text.match(pattern)![0]} ${why}. Identity is (issuer, subject): admit or link a person by subject (see api/src/account-policy.ts), never by address.`, `api/${path}`, i + 1);
  });
  if (!hits) console.log(`Identity: ${scanned.length} API, script and OIDC migration files admit and link people by subject only.`);
}

// 7. Every operation states the permission it needs: x-nightmail-permission in openapi.json, from the table in
// src/operation-permissions.ts, which the acceptance test "permission table" checks against what REST enforces.
{
  const before = failed, file = 'api/src/operation-permissions.ts';
  const { OPERATION_PERMISSIONS, permissionExtension } = await import('../src/operation-permissions.js'), { PERMISSIONS } = await import('../src/core.js');
  const spec = registeredDocument as { paths: Record<string, Record<string, Record<string, unknown> & { operationId?: string }>> };
  const operations = Object.values(spec.paths).flatMap(item => Object.values(item)).filter(op => op.operationId);
  const valid = (row: Record<string, unknown> | undefined) => !!row && (row.access ? ['public', 'staff', 'any'].includes(String(row.access)) && Object.keys(row).every(k => ['access', 'text'].includes(k))
    : row.permission ? Object.hasOwn(PERMISSIONS, String(row.permission)) && (row.permission === 'sendEmail' ? row.level === 'on' : ['read', 'write'].includes(String(row.level)))
    : ['any', 'admin', 'owner'].includes(String(row.person)) && (row.level === undefined || ['read', 'write'].includes(String(row.level))) && !row.scope);
  for (const op of operations) {
    const row = op[permissionExtension] as Record<string, unknown> | undefined;
    if (!row) fail('Permissions', `${op.operationId} states no permission: it has no ${permissionExtension} in the registered contract. Add its row to ${file} with what its guards enforce (a permission and level, a person, or public), run bun run sdk in api/, and run the acceptance test "permission table".`, file);
    else if (!valid(row)) fail('Permissions', `${op.operationId}'s ${permissionExtension} is not a valid row: ${JSON.stringify(row)}. See OperationPermission in ${file}.`, file);
  }
  const ids = new Set(operations.map(op => op.operationId));
  for (const id of Object.keys(OPERATION_PERMISSIONS).filter(id => !ids.has(id))) fail('Permissions', `${file} has a row for ${id}, which is not an operation in the registered contract. Remove the row, or run bun run sdk in api/ if the operation is new.`, file);
  if (failed === before) console.log(`Permissions: all ${operations.length} operations state the permission they need.`);
}

// 8. Published BYO role templates. Customers' stacks run byo/<version>.yaml from S3, and Nightmail keeps working with
// every supported version, so a published file never changes or disappears: a change is a new, higher version. The
// acceptance test "BYO contract" checks every session the code asks for against each of them.
{
  const before = failed, dir = 'api/byo-templates', named = /^(\d+)\.(\d+)\.yaml$/;
  const head = (() => { try { return readdirSync(new URL('byo-templates/', api)).filter(n => !n.startsWith('.')).sort(); } catch { return []; } })();
  for (const name of head) if (!named.test(name)) fail('BYO templates', `${name} must be named <major>.<minor>.yaml, the version its stack reports.`, `${dir}/${name}`);
  const baseList = base ? (tryGit('ls-tree', '--name-only', `${base}:${dir}`) ?? '').split('\n').filter(Boolean) : [];
  for (const name of baseList) {
    if (!head.includes(name)) fail('BYO templates', `${name} is published and connected accounts may run it. Restore it; publish changes as a new version.`, `${dir}/${name}`);
    else if (atBase(`${dir}/${name}`) !== readFileSync(new URL(`byo-templates/${name}`, api), 'utf8').trim()) fail('BYO templates', `${name} is published and connected accounts may run it. Revert the edit and publish the change as a new version.`, `${dir}/${name}`);
  }
  const version = (name: string) => { const m = named.exec(name); return m ? Number(m[1]) * 1e6 + Number(m[2]) : -1; };
  const newest = Math.max(-1, ...baseList.map(version));
  for (const name of head.filter(n => !baseList.includes(n))) if (version(name) <= newest) fail('BYO templates', `${name} isn't newer than the newest published version. Use a higher version.`, `${dir}/${name}`);
  if (failed === before) console.log(`BYO templates: ${head.length} published, ${head.filter(n => !baseList.includes(n)).length} new.`);
}

// 9. Price pages (app/src/features/pricing). Every Nightmail figure the pages show must be what the billing rates
// (src/billing/rates.ts) charge for the usage beside it, and every competitor figure in the pages' data must name the
// vendor's page it was read on, the day and the text. The pages are rendered as React renders them for a browser (in a
// child process with the app's JSX settings), at their own sizes and at inputs a visitor might type.
{
  const before = failed, file = 'app/src/features/pricing/compare/index.ts'
  const { RATES, CREDIT, STORAGE_AFTER_DAYS, perThousandUsd } = await import('../src/billing/rates.js')
  const n = (value: number) => value.toLocaleString('en-US')
  // Written again here, apart from the pages' own code: micro-cents to dollars, half up, four places under a cent, and
  // no cents on a whole-dollar amount (the pages print "$19", "$26.50", "$0").
  const dollarsOf = (uc: bigint) => { const places = uc > 0n && uc < 1_000_000n ? 4 : 2, unit = 10n ** BigInt(8 - places), v = ((uc + unit / 2n) / unit).toString().padStart(places + 1, '0'); return '$' + n(Number(v.slice(0, -places))) + (v.slice(-places) === '00' ? '' : '.' + v.slice(-places)) }
  const charged = (sent: number, received: number) => BigInt(Math.max(0, sent - RATES.freeSentEmails) + Math.max(0, received - RATES.freeReceivedEmails)) * RATES.emailUc
  // What a typed value means: its digits, at most a billion.
  const typed = (value: string) => { const digits = value.replace(/\D/g, ''); return digits ? Math.min(Number(digits.slice(0, 10)), 1e9) : 0 }
  const inputs: Record<string, string>[] = [
    {}, { sent: '20000', received: '0', contacts: '5000', teammates: '3' }, { sent: '400000', received: '0', contacts: '100000', teammates: '3' },
    { sent: '4999', received: '5000', contacts: '0', teammates: '1' }, { sent: '5001', received: '5001', contacts: '250', teammates: '1' },
    { sent: '6000', received: '0', contacts: '12000', teammates: '4' }, { sent: '55000', received: '100', contacts: '5000', teammates: '3' },
    { sent: '101000', received: '9000', contacts: '1000', teammates: '6' }, { sent: '3000001', received: '0', contacts: '150000', teammates: '2' },
    { sent: 'abc', received: '-5', contacts: '1e9', teammates: '' }, { sent: '99999999999999', received: '1,234,567', contacts: '0.5', teammates: '99999999999' },
  ]
  const script = [
    "import { createElement as h, Fragment } from 'react'", "import { renderToStaticMarkup } from 'react-dom/server'", "import { MemoryRouter } from 'react-router'",
    "const scene = await import('./src/features/pricing/scene.tsx'), prices = await import('./src/features/pricing/prices.ts'), compare = await import('./src/features/pricing/compare/index.ts'), view = await import('./src/features/pricing/page/page.tsx'), page = await import('./src/features/pricing/page/comparison.ts')",
    'const at = (path, element) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [path] }, element))',
    `const calculator = ${JSON.stringify(inputs)}.map(input => { const path = '/pricing?' + new URLSearchParams(input); return { input, path, html: at(path, h(scene.Scene, {})) } })`,
    // Each comparison's page, both ways it is drawn: as a board (scene.tsx: the board in its hall, and the page's end, whose
    // Sources has its small print) and from its data (page/page.tsx, from page/comparison.ts: its verdict, its table of
    // every size, its small print; the dev stage's, VITE_PRICE_PAGES=verdict). And every size its fader can reach, with the
    // competitor's price there.
    "const boards = Object.entries(compare.comparisons).flatMap(([id, c]) => [{ id, html: at('/compare/' + id, h(Fragment, null, h(scene.Scene, { comparison: c }), h(scene.BoardEnd, { comparison: c }))) }, { id: id + ' (verdict)', html: at('/compare/' + id, h(view.PricePageView, { doc: page.comparisonDoc(c) })) }])",
    "const reach = Object.entries(compare.comparisons).map(([id, c]) => ({ id, sizes: prices.reachable(c).map(size => { const u = c.use(size), t = prices.theirPrice(c.offer, u); return { size, sent: u.sent, received: u.received, theirs: t ? t.cents : null } }) }))",
    // Each vendor's pricing page (docs/), drawn from its data as the build draws it.
    "const docs = (await import('./src/features/pricing/pages.ts')).PRICE_PAGES.filter(p => p.doc).map(p => ({ path: p.path, html: at(p.path, h(view.PricePageView, { doc: p.doc })) }))",
    'const { OFFERS, comparisons, resendOverage, resendReceived } = compare',
    // Every form the pages write the days their prices were read in (docs/alternatives.ts, checkedOn), so the day check
    // below is tested against the function itself.
    "const { checkedOn } = await import('./src/features/pricing/docs/alternatives.ts')",
    "const days = [['2026-11-25'], ['2026-11-25', '2026-11-26'], ['2026-11-30', '2026-12-01'], ['2026-12-31', '2027-01-01']].map(span => checkedOn(span))",
    "process.stdout.write(JSON.stringify({ days, calculator, boards, reach, docs, data: { OFFERS, comparisons, resendOverage, resendReceived } }, (_k, v) => typeof v === 'bigint' ? String(v) : v))",
  ].join('\n')
  type Rendered = { days: string[]; calculator: { input: Record<string, string>; path: string; html: string }[]; boards: { id: string; html: string }[]; docs: { path: string; html: string }[]; reach: { id: string; sizes: { size: number; sent: number; received: number; theirs: number | null }[] }[]; data: unknown }
  let out: Rendered | null = null
  try {
    out = JSON.parse(execFileSync('node', ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], { cwd: new URL('app/', root), encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] })) as Rendered
  } catch (error) {
    if (/Cannot find (module|package) '(react|react-dom|react-router|lucide-react)/.test(String((error as { stderr?: string }).stderr))) warn('Price pages', 'Skipped: run bun install in app/ to render the price pages.')
    else fail('Price pages', `Rendering the price pages failed: ${String((error as { stderr?: string }).stderr ?? error).slice(0, 600)}`, file)
  }
  if (out) {
    const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
    const figures = (html: string) => [...html.matchAll(/data-nightmail-sent="(\d+)" data-nightmail-received="(\d+)">([^<]*)</g)].map(m => ({ sent: Number(m[1]), received: Number(m[2]), shown: m[3]! }))
    const checkFigures = (where: string, html: string, least: number) => {
      const found = figures(html)
      if (found.length < least) fail('Price pages', `${where} shows ${found.length} Nightmail figures marked with the usage they price, not at least ${least}: mark each with data-nightmail-sent and data-nightmail-received (content.tsx, Ours).`, file)
      for (const f of found) if (f.shown !== dollarsOf(charged(f.sent, f.received))) fail('Price pages', `${where} shows ${f.shown} for ${n(f.sent)} sent and ${n(f.received)} received; src/billing/rates.ts charges ${dollarsOf(charged(f.sent, f.received))}.`, file)
    }
    // The rates and terms the pages quote, as the billing code has them.
    const minTopUp = '$' + n(CREDIT.minTopUpCents / 100)
    const terms = ['$' + perThousandUsd(RATES.emailUc) + ' per 1,000', n(RATES.freeSentEmails) + ' sent and ' + n(RATES.freeReceivedEmails) + ' received free', dollarsOf(RATES.storageUcPerGbMonth) + ' per GB a month after ' + Number(RATES.freeStorageBytes / 1_000_000_000n) + ' GB free',
      'past ' + STORAGE_AFTER_DAYS + ' days', 'Top-ups start at ' + minTopUp + ' and expire ' + CREDIT.expiresAfterMonths + ' months after purchase']
    for (const { input, path, html } of out.calculator) {
      const page = text(html), want = { sent: typed(input.sent ?? '100000'), received: typed(input.received ?? '0') }
      checkFigures(`The calculator at ${path}`, html, 4)
      const total = figures(html)[0]
      if (total && (total.sent !== want.sent || total.received !== want.received)) fail('Price pages', `The calculator at ${path} priced ${n(total.sent)} sent and ${n(total.received)} received, not the ${n(want.sent)} and ${n(want.received)} typed.`, file)
      for (const term of terms) if (!page.includes(term)) fail('Price pages', `The calculator at ${path} doesn't say “${term}”, as src/billing/rates.ts has it.`, file)
      const monthly = charged(want.sent, want.received), floor = monthly > 0n && monthly * 12n < BigInt(CREDIT.minTopUpCents) * 1_000_000n
      if (floor !== page.includes(`at least ${minTopUp} a year`)) fail('Price pages', `The calculator at ${path} ${floor ? 'doesn’t say' : 'says'} that a year costs at least the smallest top-up, at ${dollarsOf(monthly)} a month.`, file)
      if (/\bNaN\b|undefined|Infinity/.test(page)) fail('Price pages', `The calculator at ${path} shows NaN, undefined or Infinity.`, file)
      if (/Not (published|checked)/.test(page)) fail('Price pages', `The calculator at ${path} lists a vendor without a price that was read: list only vendors priced at the size.`, file)
    }
    // Every competitor figure (a tier, a per-email rate, a fact that names a price) and its source: the vendor's page
    // (https), the day it was read (not in the future) and the text it was read from. Facts without a source are
    // Nightmail's own (a comparison's \`rows\`).
    const sources: [string, Record<string, unknown>][] = []
    const walk = (value: unknown, at: string) => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) return value.forEach((item, i) => walk(item, `${at}[${i}]`))
      const record = value as Record<string, unknown>, cited = Object.keys(record).some(key => key === 'source' || key.endsWith('Source'))
      const price = 'cents' in record || 'ucPerEmail' in record || ('text' in record && /\$\d/.test(String(record.text)) && !/\.rows\[\d+\]$/.test(at))
      if (price && !cited) fail('Price pages', `${at} is a competitor price with no source.`, file)
      for (const [key, item] of Object.entries(record)) {
        if (key === 'source' || key.endsWith('Source') || key === 'resendOverage' || key === 'resendReceived') sources.push([`${at}.${key}`, (item ?? {}) as Record<string, unknown>])
        walk(item, `${at}.${key}`)
      }
    }
    walk(out.data, 'prices')
    const today = new Date().toISOString().slice(0, 10)
    for (const [at, source] of sources) {
      let url: URL | null = null
      try { url = new URL(String(source.url)) } catch { url = null }
      if (url?.protocol !== 'https:') fail('Price pages', `${at} has no https link to the vendor's page.`, file)
      if (typeof source.checked !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(source.checked) || Number.isNaN(Date.parse(source.checked)) || source.checked > today) fail('Price pages', `${at} has no valid day it was checked (YYYY-MM-DD, not in the future).`, file)
      if (typeof source.quote !== 'string' || source.quote.trim().length < 8) fail('Price pages', `${at} doesn't quote the text it was read from.`, file)
    }
    // On the calculator, each competitor row with a price names the day it was checked and links the vendor's page (a
    // row with none links it).
    const dated = /Checked \d{1,2} \w{3} \d{4} on <a href="https:\/\//
    for (const { path, html } of out.calculator) for (const row of html.split(/(?=<li [^>]*data-offer=)/).slice(1).map(part => part.split('</li>')[0]!))
      if (!(/Not checked/.test(row) ? /See <a href="https:\/\//.test(row) : dated.test(row))) fail('Price pages', `A competitor row on the calculator at ${path} has no date and link to the vendor's page: ${text(row).slice(0, 80)}`, file)
    // A comparison's page: every size its fader can reach is one the competitor's page prices, and Nightmail costs less
    // there (a size where it doesn't must not be offered); its Nightmail figure is the billed price for the emails a
    // month written beside it, the competitor's price is dated and linked, and the terms are in its small print.
    for (const { id, sizes } of out.reach) for (const s of sizes) {
      if (s.theirs === null) fail('Price pages', `The ${id} control reaches ${n(s.size)}, a size ${id}'s page doesn't price: take it out of the comparison's steps (compare/${id}.ts).`, file)
      else if (charged(s.sent, s.received) >= BigInt(s.theirs) * 1_000_000n) fail('Price pages', `The ${id} control reaches ${n(s.size)}, where Nightmail (${dollarsOf(charged(s.sent, s.received))}) isn't cheaper than ${id} (${dollarsOf(BigInt(s.theirs) * 1_000_000n)}): the control must not offer it (compare/${id}.ts, steps).`, file)
    }
    for (const { id, html } of out.boards) {
      const page = text(html), where = `Nightmail vs ${id}`
      checkFigures(where, html, 1)
      // The emails a month beside each figure: sent, received (a comparison of receiving), or (a comparison of inboxes) both.
      for (const f of figures(html)) if (!page.includes(f.received ? f.sent ? `${n(f.received)} received and ${n(f.sent)} sent a month` : `${n(f.received)} emails received a month` : `${n(f.sent)} emails a month`)) fail('Price pages', `${where} prices ${n(f.sent)} sent and ${n(f.received)} received without saying so beside the figure.`, file)
      for (const term of terms.slice(2)) if (!page.includes(term)) fail('Price pages', `${where} doesn't say “${term}”, as src/billing/rates.ts has it.`, file)
      if (!dated.test(html)) fail('Price pages', `${where} doesn't give the day its prices were checked and a link to the vendor's page.`, file)
      if (/\bNaN\b|undefined|Infinity/.test(page)) fail('Price pages', `${where} shows NaN, undefined or Infinity.`, file)
    }
    // A vendor's pricing page: its verdict's Nightmail figure is the billed price for the usage it is marked with (its table
    // is the comparison's, page/comparison.ts, priceTable: the same billAt figures, unmarked so only Nightmail's column is
    // in its colour), the price and the free allowance are the billing code's, and its figures carry the day they were read
    // and the vendor's page. (That Nightmail costs less at each size in its table, the build checks: docs/vendor-pricing.ts.)
    // The day a page's prices were read, in every form docs/alternatives.ts's checkedOn writes: a day ("25 Nov 2026"), a span
    // in one month ("25–26 Nov 2026"), across months ("30 Nov to 1 Dec 2026") or years ("31 Dec 2026 to 1 Jan 2027").
    // Tested against the function's own outputs, so the two can't drift; a page with no day still fails.
    const DAY = String.raw`\d{1,2} [A-Z][a-z]{2} \d{4}`, CHECKED_DAYS = new RegExp(String.raw`checked (?:\d{1,2}–|\d{1,2} [A-Z][a-z]{2} to |${DAY} to )?${DAY}`, 'i')
    for (const form of out.days) if (!new RegExp(`^${CHECKED_DAYS.source.replace(/^checked /, '')}$`).test(form)) fail('Price pages', `The day check doesn't accept "${form}", a form docs/alternatives.ts's checkedOn writes: update CHECKED_DAYS in scripts/check-premerge.ts.`, file)
    if (CHECKED_DAYS.test('checked recently')) fail('Price pages', 'The day check accepts a page with no day.', file)
    for (const { path, html } of out.docs) {
      const page = text(html)
      checkFigures(path, html, 1)
      for (const term of terms.slice(0, 2)) if (!page.includes(term)) fail('Price pages', `${path} doesn't say “${term}”, as src/billing/rates.ts has it.`, file)
      // (A page of several services, an alternatives page or a use-case page, links each to its comparison, which names the
      // pages read: docs/alternatives.ts, docs/agents.ts.)
      if (!CHECKED_DAYS.test(page) || !(!path.startsWith('/pricing/') ? /<a href="\/compare\/[a-z0-9-]+"/ : /<a href="https:\/\//).test(html)) fail('Price pages', `${path} doesn't give the day its prices were checked and a link to the vendor's page.`, file)
      if (/\bNaN\b|undefined|Infinity/.test(page)) fail('Price pages', `${path} shows NaN, undefined or Infinity.`, file)
    }
    if (failed === before) console.log(`Price pages: ${out.calculator.length} calculator inputs, ${out.boards.length} comparison pages (each as a board and from its data) and ${out.docs.length} pages of vendors and uses (pricing, alternatives, email for AI agents, email API prices, free plans) match src/billing/rates.ts; ${sources.length} competitor sources have a link, a day and a quote.`)
  }
}

// 10. Design rules (app/design-lint.config.ts): borderless, no focus rings, one surface step, tokens for colour, spacing,
// radius and type, Inter and OpenTUI Mono, Lucide icons, full-width pages, whole labels. app/scripts/design-lint prints
// the counts by rule and the first violations, each with why and what to use instead. Rules at level 'report' never
// fail; one set to 'error' fails here on its first violation.
{
  try {
    console.log(execFileSync('node', ['--import', import.meta.resolve('tsx'), 'app/scripts/design-lint/index.ts', '--limit', '10'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd());
  } catch (error) {
    const { status, stdout, stderr } = error as { status?: number; stdout?: string; stderr?: string };
    if (/Cannot find (module|package) 'stylelint'/.test(String(stderr))) warn('Design rules', 'Skipped: run bun install in app/ to check the design rules.');
    else if (status === 1 && stdout) { console.log(stdout.trimEnd()); fail('Design rules', 'A design rule at level error has violations (above). Fix them as each one says, or allowlist a sanctioned exception with its reason in app/design-lint.config.ts.', 'app/design-lint.config.ts'); }
    else fail('Design rules', `app/scripts/design-lint failed: ${String(stderr ?? error).slice(0, 600)}`, 'app/scripts/design-lint/index.ts');
  }
}

// 11. Job handlers. Every job type enqueued into the jobs table and every key exported from a job-handler map must
// resolve through dispatch.ts resolveJobHandler(), so a missing branch never fails jobs with JOB_HANDLER_MISSING.
{
  const before = failed;
  const { resolveJobHandler } = await import('../src/dispatch.js');
  const types = new Map<string, string>();
  const record = (type: string, where: string) => { if (!types.has(type)) types.set(type, where); };
  // A job's type in an INSERT INTO jobs statement (TypeScript sql`…` or a migration's SQL function): its quoted dotted names.
  const INSERT_JOBS = /INSERT\s+INTO\s+(?:public\.)?jobs\s*(?:AS\s+\w+\s*)?\(([^)]+)\)\s*([\s\S]*?)(?=\bON\s+CONFLICT\b|\bRETURNING\b|\)\s*,\s*[a-z_]+\s+AS\s*\(|`$|;)/gi;
  const insertedTypes = (raw: string, where: string) => {
    for (const ins of raw.matchAll(INSERT_JOBS)) {
      const cols = ins[1]!.split(',').map(c => c.trim().toLowerCase()), body = ins[2]!;
      if (cols.includes('status') && /'completed'/.test(body)) continue;
      for (const m of body.matchAll(/'([a-z][a-z0-9]*\.[a-zA-Z0-9_]+)'/g)) if (!/^(?:public|pg_catalog)\./.test(m[1]!)) record(m[1]!, where);
    }
  };
  const walkFiles = (dir: URL, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walkFiles(new URL(entry.name + '/', dir), `${rel}${entry.name}/`);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const file = `${rel}${entry.name}`, text = readFileSync(new URL(entry.name, dir), 'utf8');
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const consts = new Map<string, string>();
        const evalStr = (node: ts.Node): string | null => {
          if (ts.isStringLiteralLike(node)) return node.text;
          if (ts.isIdentifier(node)) return consts.get(node.text) ?? null;
          return null;
        };
        const collectConsts = (node: ts.Node) => {
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) consts.set(node.name.text, node.initializer.text);
          ts.forEachChild(node, collectConsts);
        };
        collectConsts(sf);
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node)) {
            const callee = node.expression.getText(sf);
            // A job enqueue takes (db, job); a stream controller's enqueue(chunk) takes one argument and is no job.
            if ((callee === 'enqueue' || callee.endsWith('.enqueue')) && node.arguments.length >= 2) {
              const arg = node.arguments[1]!;
              const prop = ts.isObjectLiteralExpression(arg) ? arg.properties.find(p => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'type') as ts.PropertyAssignment | undefined : undefined;
              const val = prop && evalStr(prop.initializer);
              if (val) record(val, file);
              // A type this check can't read could be one with no handler: name it with a literal or a const in the file.
              else fail('Job handlers', `${file}: enqueue's job type isn't a string literal or a const in this file, so this check can't verify it has a handler.`, file, sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
            }
            // Jobs inserted with Drizzle: insert(jobs).values(…), each row's literal type.
            if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'values' && /\binsert\(jobs\)$/.test(node.expression.expression.getText(sf))) {
              const types = (n: ts.Node): void => { if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'type') { const val = evalStr(n.initializer); if (val) record(val, file); } ts.forEachChild(n, types); };
              node.arguments.forEach(types);
            }
          }
          if (ts.isTaggedTemplateExpression(node) && node.tag.getText(sf) === 'sql') {
            // Inspect only each INSERT INTO jobs(...) statement up to its ON CONFLICT / RETURNING / CTE end,
            // ignoring sibling CTEs (audit events, webhook events) and state-marker rows inserted as completed.
            insertedTypes(node.template.getText(sf), file);
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
    }
  };
  walkFiles(new URL('src/', api), 'api/src/');
  // Jobs a migration's SQL function inserts (triggers, send_admission and the like) need handlers too.
  for (const name of readdirSync(new URL('migrations/', api)).filter(n => n.endsWith('.sql')).sort()) insertedTypes(readFileSync(new URL(`migrations/${name}`, api), 'utf8'), `api/migrations/${name}`);
  const registries = await Promise.all([
    import('../src/sending.js').then(m => ['api/src/sending.ts', m.jobHandlers] as const),
    import('../src/operations.js').then(m => ['api/src/operations.ts', m.operationJobs] as const),
    import('../src/ses-regions.js').then(m => ['api/src/ses-regions.ts', m.sesRegionJobs] as const),
    import('../src/reputation-alerts.js').then(m => ['api/src/reputation-alerts.ts', m.reputationAlertJobs] as const),
    import('../src/operator-alerts.js').then(m => ['api/src/operator-alerts.ts', m.operatorAlertJobs] as const),
    import('../src/mailbox-events.js').then(m => ['api/src/mailbox-events.ts', m.mailboxEventJobs] as const),
    import('../src/mailbox-setup.js').then(m => ['api/src/mailbox-setup.ts', m.mailboxSetupJobs] as const),
    import('../src/mailbox-ingest.js').then(m => ['api/src/mailbox-ingest.ts', m.mailboxIngestJobs] as const),
    import('../src/standing.js').then(m => ['api/src/standing.ts', m.standingJobs] as const),
    import('../src/newsletters.js').then(m => ['api/src/newsletters.ts', m.newsletterJobs] as const),
    import('../src/billing/jobs.js').then(m => ['api/src/billing/jobs.ts', m.billingJobs] as const),
    import('../src/account-notices.js').then(m => ['api/src/account-notices.ts', m.accountNoticeJobs] as const),
    import('../src/signups.js').then(m => ['api/src/signups.ts', m.signupJobs] as const),
    import('../src/byo-regional.js').then(m => ['api/src/byo-regional.ts', m.regionalByoJobs] as const),
  ]);
  for (const [file, map] of registries) for (const type of Object.keys(map)) record(type, file);
  for (const [type, file] of [...types.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const handler = await resolveJobHandler(type);
    if (typeof handler !== 'function') fail('Job handlers', `Job type '${type}' (from ${file}) has no handler in api/src/dispatch.ts resolveJobHandler(). Add a route for it there.`, 'api/src/dispatch.ts');
  }
  if (failed === before) console.log(`Job handlers: all ${types.size} enqueued and registered job types resolve through dispatch.ts.`);
}

// 12. An operation's summary is a name. It is the docs page's title in the browser tab and in search results
// (docsTitle, app/src/features/docs/meta.ts), the docs sidebar's entry and the SDK's comment, and the MCP tool leads
// with it: a sentence there runs past the 60 characters a search result shows. Sentences go in the description.
{
  // The app's own title rule, by URL: the API's type check doesn't take in the app's sources.
  const { docsTitle, operationTitle } = await import(new URL('../../app/src/features/docs/meta.ts', import.meta.url).href) as { docsTitle: (page: string) => string; operationTitle: (id: string) => string };
  const before = failed;
  const spec = JSON.parse(readFileSync(new URL('openapi.json', api), 'utf8')) as { paths: Record<string, Record<string, { operationId?: string; summary?: string }>> };
  const operations = Object.values(spec.paths).flatMap(item => Object.values(item)).filter(op => op.operationId);
  const most = 60 - docsTitle('').length;
  for (const op of operations) {
    const name = op.summary ?? operationTitle(op.operationId!), title = docsTitle(name);
    if (title.length > 60 || /[.;:!?](\s|$)/.test(name)) fail('Operation summaries', `${op.operationId}'s summary “${name}” is ${title.length > 60 ? `${name.length} characters` : 'a sentence'}. A summary is a name of at most ${most} characters with no full stop, because it is the docs page's title (“${title}”, ${title.length} of 60 characters) and the SDK's comment. Keep a short name (“Create an inbox app password”), move the sentence word for word into the operation's description, warnings first, and run bun run sdk in api/.`);
  }
  if (failed === before) console.log(`Operation summaries: all ${operations.length} operations are named in at most ${most} characters, so every docs title fits in 60.`);
}

// 13. Accepted mail is stamped with clock_timestamp() inside the statement that writes it. The abuse sample records how
// far it read a workspace (src/abuse.ts sampleBound) and relies on it: such a statement takes its write lock on
// sending_email_events when it starts, before any row is stamped, so a stamp is never earlier than the lock. A stamp
// from now(), transaction_timestamp() or current_timestamp (the transaction's start, maybe long before the lock), from
// statement_timestamp() (the statement's start, just before its lock), from the column's default now() or from another
// clock (a Worker's, SES's) can become visible behind that mark and is never read. So every statement that inserts into
// sending_email_events either gives created_at, in its own projection, exactly clock_timestamp() or
// CASE WHEN <type>='accepted' AND NOT <simulated> THEN clock_timestamp() ELSE <anything> END, or says inside the
// statement that it never writes type 'accepted': /* premerge-accepted: never (why) */. The projection is parsed (the
// value in created_at's position), not searched, so a clock_timestamp() elsewhere in the statement doesn't count.
{
  const before = failed;
  const files = (dir: string, keep: (name: string) => boolean): string[] => readdirSync(new URL(dir, api), { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? files(`${dir}${e.name}/`, keep) : keep(e.name) ? [`${dir}${e.name}`] : []);
  const scanned = [...files('src/', n => n.endsWith('.ts')), ...files('scripts/', n => n.endsWith('.ts') && n !== 'check-premerge.ts'), ...files('migrations/', n => Number(n.slice(0, 3)) >= 580)];
  // The top-level items of the SELECT or VALUES list that starts at `from`, or null. Skips SQL strings and comments,
  // nested parentheses and ${...} interpolations (JS, possibly with nested templates), and stops at the list's end.
  const projection = (text: string, from: number): string[] | null => {
    let at = from;
    const skipSpace = () => { for (;;) { const rest = text.slice(at); const m = /^(\s+|--[^\n]*|\/\*[\s\S]*?\*\/)/.exec(rest); if (!m) return; at += m[0].length; } };
    // Past a ${...} starting at `k` (pointing at '$'): JS code with braces, strings and nested templates.
    const interpolation = (k: number): number => {
      let depth = 0;
      for (let c = k + 1; c < text.length; c++) {
        const ch = text[c]!;
        if (ch === '{') depth++;
        else if (ch === '}') { if (--depth === 0) return c + 1; }
        else if (ch === "'" || ch === '"') { c++; while (c < text.length && text[c] !== ch) { if (text[c] === '\\') c++; c++; } }
        else if (ch === '`') { c++; while (c < text.length && text[c] !== '`') { if (text[c] === '\\') c++; else if (text[c] === '$' && text[c + 1] === '{') { c = interpolation(c) - 1; } c++; } }
      }
      return text.length;
    };
    skipSpace();
    const values = /^VALUES\s*\(/i.exec(text.slice(at)), select = /^SELECT\b/i.exec(text.slice(at));
    if (!values && !select) return null;
    at += (values ?? select)![0].length;
    const items: string[] = [];
    let depth = 0, start = at;
    for (; at < text.length; at++) {
      const ch = text[at]!;
      if (ch === '$' && text[at + 1] === '{') { at = interpolation(at) - 1; continue; }
      if (ch === "'") { at++; while (at < text.length && !(text[at] === "'" && text[at + 1] !== "'")) { if (text[at] === "'") at++; at++; } continue; }
      if (ch === '-' && text[at + 1] === '-') { at = text.indexOf('\n', at); if (at < 0) at = text.length; continue; }
      if (ch === '/' && text[at + 1] === '*') { at = text.indexOf('*/', at) + 1; continue; }
      if (ch === '`') break;
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      else if (depth === 0 && ch === ',') { items.push(text.slice(start, at)); start = at + 1; }
      else if (depth === 0 && select && /^FROM\b/i.test(text.slice(at)) && /\W/.test(text[at - 1] ?? ' ')) break;
    }
    items.push(text.slice(start, at));
    return items.map(item => item.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim());
  };
  const stampsAccepted = (value: string) => /^clock_timestamp\(\)$/i.test(value) || (() => {
    const m = /^CASE WHEN (.+) THEN clock_timestamp\(\) ELSE (.+) END$/i.exec(value);
    return !!m && /^(\$\{[\w.]+\}|[\w.]+)(::text)?\s*=\s*'accepted' AND NOT [\w.]*simulated$/i.test(m[1]!) && !/\bWHEN\b/i.test(m[2]!);
  })();
  let stamped = 0, never = 0;
  for (const path of scanned) {
    const text = readFileSync(new URL(path, api), 'utf8');
    for (const match of text.matchAll(/INSERT\s+INTO\s+sending_email_events\s*\(([^)]*)\)/gi)) {
      const line = text.slice(0, match.index).split('\n').length, where = `api/${path}`, end = match.index! + match[0].length;
      const head = text.slice(end, end + 200);
      if (/^\s*\/\*\s*premerge-accepted: never \([^)]+\)\s*\*\//.test(head)) { never++; continue; }
      const columns = match[1]!.split(',').map(c => c.trim().toLowerCase()), k = columns.indexOf('created_at');
      if (k < 0) { fail('Accepted mail stamp', 'This insert into sending_email_events leaves created_at to the column default now(), its transaction\'s start. Give it clock_timestamp() for accepted mail in the statement, or put /* premerge-accepted: never (why) */ right after its column list if it never writes accepted mail.', where, line); continue; }
      const items = projection(text, end), value = items?.[k];
      if (!items || items.length !== columns.length || value === undefined) { fail('Accepted mail stamp', `Can't read what this insert into sending_email_events puts in created_at (${items ? `${items.length} values for ${columns.length} columns` : 'no SELECT or VALUES list'}). Write it as INSERT ... (columns) SELECT/VALUES with created_at's value in its place.`, where, line); continue; }
      if (!stampsAccepted(value)) { fail('Accepted mail stamp', `This insert into sending_email_events stamps created_at with ${value.slice(0, 120)}. Accepted mail (not simulated) must get clock_timestamp() there, in the statement that writes it (or CASE WHEN type='accepted' AND NOT simulated THEN clock_timestamp() ELSE ... END): the abuse sample's mark relies on it (src/abuse.ts sampleBound).`, where, line); continue; }
      stamped++;
    }
  }
  if (failed === before) console.log(`Accepted mail stamp: all ${stamped + never} inserts into sending_email_events: ${stamped} give created_at clock_timestamp() for accepted mail in their own projection, ${never} never write it.`);
}

// 14. Announced changes to the legal pages (src/policy-changes.ts). The pages date themselves by a change's `announced`
// day and the build counts its 31 days' notice from it, so a change that is new here, or whose day changed, must be
// announced today (UTC): the day this runs, which in the merge queue is the day it merges. Only a change's own pull
// request is checked; one that leaves the file's days alone passes on any day.
{
  const before = failed, file = 'api/src/policy-changes.ts', { POLICY_CHANGES } = await import('../src/policy-changes.js');
  const days = (source: string | null) => new Map([...(source ?? '').matchAll(/(\w+): \{ announced: '([^']*)'/g)].map(match => [match[1]!, match[2]!]));
  const here = days(readFileSync(new URL('src/policy-changes.ts', api), 'utf8')), there = days(atBase(file)), today = new Date().toISOString().slice(0, 10);
  if (here.size !== Object.keys(POLICY_CHANGES).length) fail('Announced changes', `Can't read each change's announced day in ${file}: write each as name: { announced: 'YYYY-MM-DD', from: '…' }.`, file);
  for (const [name, day] of here) if (there.get(name) !== day && day !== today) fail('Announced changes', `${name} is announced on ${day}, but this change merges on ${today} (UTC). Set its announced to ${today}, so the legal pages' updated date and the 31 days' notice count from the day it ships.`, file);
  if (failed === before) console.log(`Announced changes: ${here.size} in ${file}, each announced on its own day.`);
}

if (failed) {
  console.log(`\n${failed} pre-merge check${failed === 1 ? '' : 's'} failed. docs/ci.md explains each one and how to fix it.`);
  process.exitCode = 1;
}
