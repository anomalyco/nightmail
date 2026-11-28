# Upstream

- Repository: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Copied: `src/` verbatim into this directory, plus the repository `LICENSE`
- Local edits: `no-manual-tagged-construction` also exempts partial patterns in
  `toMatchObject(...)` and `expect.objectContaining(...)` arguments
  (`isPartialMatcherPattern` in `effect/shared/tagged-values.ts`), and encoded
  input in `JSON.stringify(...)` and `Schema.decode*(schema)(...)` arguments
  (`isEncodedInput`); carry both forward when updating

To update, copy a newer upstream `src/` over this directory, record the new
commit here, and run the RuleTester suites with `node --test-reporter=dot test.ts`
from a repository that has the pack synced.
