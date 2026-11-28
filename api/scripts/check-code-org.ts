// Ratcheting code-organization guardrails: file line caps and folder breadth.
//   node --import tsx scripts/check-code-org.ts [--ratchet] [--annotations]
// Rules:
//   - Non-test source files: warn > 800 lines, hard cap > 1,500 lines
//   - Test files: hard cap > 1,000 lines
//   - Folder breadth: warn > 40 non-test source files per folder, hard cap > 60
// Existing over-cap files/folders live in api/scripts/code-org-exceptions.json with ceilings that only go down.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

interface ExceptionsFile {
  files: Record<string, number>;
  folders: Record<string, number>;
}

const NON_TEST_WARN = 800;
const NON_TEST_CAP = 1500;
const TEST_CAP = 1000;
const FOLDER_WARN = 40;
const FOLDER_CAP = 60;

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs']);
const apiDir = new URL('../', import.meta.url);
const rootDir = new URL('../', apiDir);
const exceptionsPath = new URL('code-org-exceptions.json', import.meta.url);

const args = new Set(process.argv.slice(2));
const ratchet = args.has('--ratchet');
const annotations = args.has('--annotations') || process.env.GITHUB_ACTIONS === 'true';

function isExcluded(path: string): boolean {
  if (path.endsWith('.d.ts')) return true;
  if (path === 'api/src/hygiene-snapshot.ts' || path === 'api/src/api-field-names.ts') return true;
  if (path.startsWith('sdk/src/')) return true;
  if (path.startsWith('api/migrations/') || path.startsWith('support/migrations/')) return true;
  if (path.startsWith('api/scripts/lint/')) return true;
  if (path.startsWith('vendor/') || path.includes('/vendor/')) return true;
  return false;
}

function isTestFile(path: string): boolean {
  if (/(?:^|\/)(?:[^/]+\.(?:test|spec)\.[a-z]+|[^/]+_tests\.rs)$/.test(path)) return true;
  if (path.startsWith('support/test/') || path.includes('/tests/')) return true;
  return false;
}

function extensionOf(path: string): string {
  const match = /\.[^./]+$/.exec(path);
  return match ? match[0] : '';
}

function lineCount(fileUrl: URL): number {
  const text = readFileSync(fileUrl, 'utf8');
  if (text.length === 0) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

function listCandidateFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  return [...new Set(output.split('\0').filter(Boolean))].sort();
}

function loadExceptions(): ExceptionsFile {
  const raw = JSON.parse(readFileSync(exceptionsPath, 'utf8')) as Partial<ExceptionsFile>;
  return {
    files: raw.files ?? {},
    folders: raw.folders ?? {},
  };
}

function serializeExceptions(data: ExceptionsFile): string {
  const sortRecord = (record: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const key of Object.keys(record).sort()) out[key] = record[key]!;
    return out;
  };
  return JSON.stringify({ files: sortRecord(data.files), folders: sortRecord(data.folders) }, null, 2) + '\n';
}

const exceptions = loadExceptions();
const fileSizes = new Map<string, { lines: number; test: boolean }>();
const folderCounts = new Map<string, number>();

for (const path of listCandidateFiles()) {
  if (isExcluded(path)) continue;
  if (!SOURCE_EXTS.has(extensionOf(path))) continue;
  const fileUrl = new URL(path, rootDir);
  if (!existsSync(fileUrl)) continue;
  const lines = lineCount(fileUrl);
  const test = isTestFile(path);
  fileSizes.set(path, { lines, test });
  if (!test) {
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash) : '.';
    folderCounts.set(dir, (folderCounts.get(dir) ?? 0) + 1);
  }
}

let failures = 0;
function reportError(message: string, file?: string): void {
  failures++;
  console.error(message);
  if (annotations) {
    const where = file ? ` file=${file}` : '';
    console.log(`::error${where},title=Code organization::${message.replaceAll('\n', '%0A')}`);
  }
}

const warnedFiles: Array<{ path: string; lines: number }> = [];
for (const [path, info] of fileSizes) {
  const cap = info.test ? TEST_CAP : NON_TEST_CAP;
  const ceiling = exceptions.files[path];
  if (ceiling !== undefined) {
    if (info.lines > ceiling) {
      reportError(
        `${path} grew to ${info.lines} lines, exceeding its ratcheted ceiling of ${ceiling} (cap ${cap}). Split the module instead of growing it.`,
        path,
      );
    }
  } else if (info.lines > cap) {
    reportError(
      `${path} has ${info.lines} lines, exceeding the ${info.test ? 'test' : 'non-test'} hard cap of ${cap} lines. Split into smaller focused modules.`,
      path,
    );
  } else if (!info.test && info.lines > NON_TEST_WARN) {
    warnedFiles.push({ path, lines: info.lines });
  }
}

const warnedFolders: Array<{ dir: string; count: number }> = [];
for (const [dir, count] of [...folderCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const ceiling = exceptions.folders[dir];
  if (ceiling !== undefined) {
    if (count > ceiling) {
      reportError(
        `${dir}/ has ${count} non-test source files, exceeding its ratcheted ceiling of ${ceiling} (cap ${FOLDER_CAP}). Group related modules into a capability subfolder.`,
      );
    }
  } else if (count > FOLDER_CAP) {
    reportError(
      `${dir}/ has ${count} non-test source files, exceeding the folder breadth hard cap of ${FOLDER_CAP}. Split into capability subfolders.`,
    );
  } else if (count > FOLDER_WARN) {
    warnedFolders.push({ dir, count });
  }
}

const lowerableFiles: Array<{ path: string; ceiling: number; now: number; remove: boolean }> = [];
for (const path of Object.keys(exceptions.files).sort()) {
  const ceiling = exceptions.files[path]!;
  const info = fileSizes.get(path);
  const now = info?.lines ?? 0;
  const cap = info?.test ? TEST_CAP : NON_TEST_CAP;
  if (!info || now <= cap) lowerableFiles.push({ path, ceiling, now, remove: true });
  else if (now < ceiling) lowerableFiles.push({ path, ceiling, now, remove: false });
}

const lowerableFolders: Array<{ dir: string; ceiling: number; now: number; remove: boolean }> = [];
for (const dir of Object.keys(exceptions.folders).sort()) {
  const ceiling = exceptions.folders[dir]!;
  const now = folderCounts.get(dir) ?? 0;
  if (now <= FOLDER_CAP) lowerableFolders.push({ dir, ceiling, now, remove: true });
  else if (now < ceiling) lowerableFolders.push({ dir, ceiling, now, remove: false });
}

if (failures > 0) {
  console.error(
    `\nCode organization check failed with ${failures} violation${failures === 1 ? '' : 's'}. Never raise ceilings in api/scripts/code-org-exceptions.json.`,
  );
  process.exit(1);
}

const totalLowerable = lowerableFiles.length + lowerableFolders.length;
if (ratchet && totalLowerable > 0) {
  const nextFiles: Record<string, number> = { ...exceptions.files };
  for (const item of lowerableFiles) {
    if (item.remove) delete nextFiles[item.path];
    else nextFiles[item.path] = item.now;
  }
  const nextFolders: Record<string, number> = { ...exceptions.folders };
  for (const item of lowerableFolders) {
    if (item.remove) delete nextFolders[item.dir];
    else nextFolders[item.dir] = item.now;
  }
  writeFileSync(exceptionsPath, serializeExceptions({ files: nextFiles, folders: nextFolders }), 'utf8');
  console.log(`Ratcheted ${totalLowerable} code-org exception${totalLowerable === 1 ? '' : 's'} in api/scripts/code-org-exceptions.json.`);
}

console.log(
  `Code organization: ${fileSizes.size} source files across ${folderCounts.size} folders checked; ${Object.keys(exceptions.files).length} excepted file${Object.keys(exceptions.files).length === 1 ? '' : 's'}, ${Object.keys(exceptions.folders).length} excepted folder${Object.keys(exceptions.folders).length === 1 ? '' : 's'}, ${warnedFiles.length} file warning${warnedFiles.length === 1 ? '' : 's'} (>${NON_TEST_WARN} lines), ${warnedFolders.length} folder warning${warnedFolders.length === 1 ? '' : 's'} (>${FOLDER_WARN} files).`,
);
for (const folder of warnedFolders) {
  console.log(`  warn folder breadth: ${folder.dir}/ has ${folder.count} non-test source files (warn >${FOLDER_WARN}, cap ${FOLDER_CAP})`);
}

if (!ratchet && totalLowerable > 0) {
  console.log(`Code-org ratchet: ${totalLowerable} ceiling${totalLowerable === 1 ? '' : 's'} can be lowered (run bun run code-org -- --ratchet in api/):`);
  for (const item of lowerableFiles) {
    console.log(`  ${item.path}: ${item.ceiling} -> ${item.remove ? `${item.now} (remove exception)` : item.now}`);
  }
  for (const item of lowerableFolders) {
    console.log(`  ${item.dir}/: ${item.ceiling} -> ${item.remove ? `${item.now} (remove exception)` : item.now}`);
  }
}
