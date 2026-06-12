# TODOs

Known deferred work. Performance plans live in `plans/README.md`.

- [ ] Per-file parse-error tolerance: a single unparseable source file currently
  aborts the whole scan (`scanFile` throws). Skip the file with a warning on
  stderr instead, and add a `--strict` flag to restore fail-fast behavior.
  (Deferred from feat/respect-gitignore review, 2026-06-12.)
- [ ] Hash-collision spot check: fingerprints are 53-bit content hashes; a
  collision could fabricate or merge a candidate pair. Negligible in practice,
  but a cheap post-filter (re-compare normalized tags for score-1 pairs) would
  make it impossible. (Deferred from perf/scan-pipeline review, 2026-06-13.)
- [ ] `addIdenticalFingerprintPairs` is O(G²) per identical group via
  `Array.find`; replace with Map-based component lookup if huge identical
  groups ever show up in profiles. (Deferred from perf/scan-pipeline review,
  2026-06-13.)
- [ ] Sub-1s scans: prototype an oxc-parser raw-transfer backend (parse drops
  ~550ms → ~170ms, removes the typescript.js startup import; node-only until
  Bun supports raw transfer). (Identified 2026-06-13.)
- [ ] Symlink policy: directory walks in `typeScriptFiles` follow whatever
  `readdirSync`/`statSync` report; symlinked directories and files are neither
  documented nor cycle-guarded. Decide policy (skip symlinks vs. follow with
  cycle detection), implement, and document in README.
  (Deferred from feat/respect-gitignore review, 2026-06-12.)
