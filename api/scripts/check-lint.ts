// Ratcheting Oxlint runner across api/src, app/src and support/src.
//   node --import tsx scripts/check-lint.ts [--ratchet] [--annotations]
// Fails if any file introduces a new diagnostic or exceeds its grandfathered per-rule ceiling in
// api/scripts/lint-baseline.json. --ratchet tightens ceilings that dropped (and never raises one).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface OxlintSpan {
  line?: number;
  column?: number;
}
interface OxlintDiagnostic {
  code: string;
  filename: string;
  message: string;
  labels?: Array<{ span?: OxlintSpan }>;
}
interface OxlintOutput {
  diagnostics: OxlintDiagnostic[];
  number_of_files?: number;
  number_of_rules?: number;
}

const TARGETS = ['api/src', 'app/src', 'support/src'];
const apiDir = new URL('../', import.meta.url);
const rootDir = new URL('../', apiDir);
const baselinePath = new URL('lint-baseline.json', import.meta.url);
const oxlintBin = fileURLToPath(new URL('node_modules/.bin/oxlint', apiDir));

const args = new Set(process.argv.slice(2));
const ratchet = args.has('--ratchet');
const annotations = args.has('--annotations') || process.env.GITHUB_ACTIONS === 'true';

function runOxlint(): OxlintOutput {
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(oxlintBin, ['-c', '.oxlintrc.json', '--format', 'json', ...TARGETS], {
      cwd: rootDir,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    stdout = typeof failed.stdout === 'string' ? failed.stdout : '';
    stderr = typeof failed.stderr === 'string' ? failed.stderr : '';
    if (!stdout.trim().startsWith('{')) {
      throw new Error(`oxlint exited with status ${failed.status ?? 'unknown'}: ${stderr.trim() || String(error)}`);
    }
  }
  const parsed = JSON.parse(stdout) as Partial<OxlintOutput>;
  if (!Array.isArray(parsed.diagnostics)) {
    throw new Error(`Unexpected oxlint JSON output: ${stderr.trim() || stdout.slice(0, 300)}`);
  }
  return {
    diagnostics: parsed.diagnostics,
    number_of_files: parsed.number_of_files,
    number_of_rules: parsed.number_of_rules,
  };
}

function loadBaseline(): Map<string, Map<string, number>> {
  const raw = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, Record<string, number>>;
  const result = new Map<string, Map<string, number>>();
  for (const [file, rules] of Object.entries(raw)) {
    const map = new Map<string, number>();
    for (const [rule, count] of Object.entries(rules)) map.set(rule, count);
    result.set(file, map);
  }
  return result;
}

function serializeBaseline(map: Map<string, Map<string, number>>): string {
  const out: Record<string, Record<string, number>> = {};
  for (const file of [...map.keys()].sort()) {
    const rules = map.get(file);
    if (!rules || rules.size === 0) continue;
    const sorted: Record<string, number> = {};
    for (const rule of [...rules.keys()].sort()) {
      const count = rules.get(rule) ?? 0;
      if (count > 0) sorted[rule] = count;
    }
    if (Object.keys(sorted).length > 0) out[file] = sorted;
  }
  return JSON.stringify(out, null, 2) + '\n';
}

const report = runOxlint();
const baseline = loadBaseline();

const actual = new Map<string, Map<string, OxlintDiagnostic[]>>();
for (const diag of report.diagnostics) {
  const file = diag.filename.replaceAll('\\', '/');
  let byRule = actual.get(file);
  if (!byRule) {
    byRule = new Map<string, OxlintDiagnostic[]>();
    actual.set(file, byRule);
  }
  const list = byRule.get(diag.code) ?? [];
  list.push(diag);
  byRule.set(diag.code, list);
}

let regressions = 0;
let regressedDiagnostics = 0;
for (const file of [...actual.keys()].sort()) {
  const byRule = actual.get(file)!;
  const allowedByRule = baseline.get(file);
  for (const rule of [...byRule.keys()].sort()) {
    const list = byRule.get(rule)!;
    const ceiling = allowedByRule?.get(rule) ?? 0;
    if (list.length > ceiling) {
      regressions++;
      regressedDiagnostics += list.length - ceiling;
      const reason = ceiling === 0
        ? `${file}: ${rule} has ${list.length} violation${list.length === 1 ? '' : 's'} (not in lint baseline)`
        : `${file}: ${rule} grew from ceiling ${ceiling} to ${list.length}`;
      console.error(reason);
      for (const diag of list) {
        const span = diag.labels?.[0]?.span;
        const line = span?.line;
        const col = span?.column;
        const loc = line ? `${file}:${line}${col ? `:${col}` : ''}` : file;
        console.error(`  ${loc} [${rule}] ${diag.message}`);
        if (annotations) {
          const where = line ? ` file=${file},line=${line}` : ` file=${file}`;
          console.log(`::error${where},title=Lint::${rule}: ${diag.message.replaceAll('\n', '%0A')}`);
        }
      }
    }
  }
}

const lowerable: Array<{ file: string; rule: string; ceiling: number; now: number }> = [];
for (const file of [...baseline.keys()].sort()) {
  const rules = baseline.get(file)!;
  for (const rule of [...rules.keys()].sort()) {
    const ceiling = rules.get(rule)!;
    const now = actual.get(file)?.get(rule)?.length ?? 0;
    if (now < ceiling) lowerable.push({ file, rule, ceiling, now });
  }
}

if (regressions > 0) {
  console.error(
    `\nLint failed: ${regressedDiagnostics} new diagnostic${regressedDiagnostics === 1 ? '' : 's'} across ${regressions} file/rule pair${regressions === 1 ? '' : 's'}. Fix the violations above (never raise api/scripts/lint-baseline.json).`,
  );
  process.exit(1);
}

if (ratchet && lowerable.length > 0) {
  const next = new Map<string, Map<string, number>>();
  for (const [file, rules] of baseline) {
    const nextRules = new Map<string, number>();
    for (const [rule, ceiling] of rules) {
      const now = actual.get(file)?.get(rule)?.length ?? 0;
      const tightened = Math.min(ceiling, now);
      if (tightened > 0) nextRules.set(rule, tightened);
    }
    if (nextRules.size > 0) next.set(file, nextRules);
  }
  writeFileSync(baselinePath, serializeBaseline(next), 'utf8');
  console.log(`Ratcheted ${lowerable.length} ceiling${lowerable.length === 1 ? '' : 's'} in api/scripts/lint-baseline.json.`);
}

const filesChecked = report.number_of_files ?? 0;
const grandfathered = report.diagnostics.length;
console.log(
  `Lint: ${filesChecked} files checked across ${TARGETS.join(', ')}; ${grandfathered} grandfathered diagnostic${grandfathered === 1 ? '' : 's'} across ${actual.size} files, 0 regressions.`,
);

if (!ratchet && lowerable.length > 0) {
  console.log(`Lint ratchet: ${lowerable.length} ceiling${lowerable.length === 1 ? '' : 's'} can be lowered (run bun run lint -- --ratchet in api/):`);
  for (const item of lowerable.slice(0, 10)) {
    console.log(`  ${item.file} [${item.rule}]: ${item.ceiling} -> ${item.now}`);
  }
  if (lowerable.length > 10) console.log(`  ...and ${lowerable.length - 10} more.`);
}
