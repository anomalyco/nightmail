// Loads generated/hygiene-snapshot.json so tsc checks callers via hygiene-snapshot.d.ts without parsing the snapshot.
import snapshot from './hygiene-snapshot.json' with { type: 'json' };
export const HYGIENE_SNAPSHOT = snapshot;
