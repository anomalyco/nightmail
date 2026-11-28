// Refreshes generated/hygiene-snapshot.json, the vendored fallback of list hygiene's lists (the union of the sources in
// src/hygiene-sources.ts, less the allowlist), from the same sources and checks as the nightly sync.
// Usage, from api/: node --import tsx scripts/update-hygiene-snapshot.ts
// Commit the regenerated file. Nightmail uses it only until the nightly sync has stored lists, or while every sync fails.
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLists, fetchSource, SOURCES } from '../src/hygiene-sources.js';

const fetched = [];
for (const source of SOURCES) {
  const got = await fetchSource(source, null);
  console.log(`${source.name} (${source.license}): ${got.entries.length} entries`);
  fetched.push(got);
}
const built = buildLists(fetched);
const target = fileURLToPath(new URL('../generated/hygiene-snapshot.json', import.meta.url));
const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
mkdirSync(dirname(target), { recursive: true });
try {
  writeFileSync(tmp, `${JSON.stringify(built)}\n`, 'utf8');
  renameSync(tmp, target);
} catch (error) {
  rmSync(tmp, { force: true });
  throw error;
}
console.log(`Wrote ${built.disposable ? built.disposable.split('\n').length : 0} disposable domains, ${built.providers.length} providers, ${built.roles.length} roles, version ${built.version}`);
