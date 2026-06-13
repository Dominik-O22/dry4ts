# TODOs

Known deferred work. Performance plans live in `plans/README.md`.

- [ ] Baseline-file provider for incremental gating (P3, M→S with CC): a
  checked-in fingerprint baseline as an alternative changed-region provider,
  enabling "debt only shrinks" ratchet workflows and repos without useful git
  refs. Plug-in point is the `ChangedRegions` provider seam from the
  incremental-gating plan. Fingerprints are deterministic content hashes
  (src/NormalizedNode.ts), but normalization changes between versions
  invalidate stored baselines — baseline file needs a version field and a
  clear "regenerate" error. Costs that deferred it: stateful file, merge
  conflicts, pre-snapshot step for agents. (Deferred from incremental-gating
  CEO review, 2026-06-13.)
- [ ] PR-grade reporting (P3, S): `--format github` emitting `::error
  file=...` annotations on finding locations, plus findings-first text
  output. The `status` field from the incremental-gating plan provides all
  data; only formatters needed. (Deferred from incremental-gating CEO
  review, 2026-06-13.)
- [ ] Pair-level counterpart provenance in output (P3, M→S/M with CC):
  clusters are transitive components, so cluster-level `status` doesn't tell
  an agent which counterpart a "new" location actually matches. Expose
  direct pair edges (or per-location nearest counterpart) in JSON for
  sharper fix targeting. Caveat: pair provenance is currently discarded in
  src/TypeScriptDuplicateFinder.ts (perf rework); retention has memory/perf
  cost — profile against .bench corpora first, retain only on the scoped
  path. (From Codex outside-voice review of incremental-gating plan,
  2026-06-13.)

- [ ] Line-range syntax for `--changed` (P3, S): optional `:start-end` suffix
  (`--changed foo.ts:10-42`) giving non-git callers line-level gating
  precision. Today `--changed` is whole-file granularity, so pre-existing
  duplication elsewhere in a touched file gates as "new" (documented trap;
  eng review 2026-06-13 chose docs + `--changed-from HEAD` steering over
  mechanism, decision 2B). Plug-in point: Options.ts parsing + the
  ChangedRegions provider seam from the incremental-gating plan; the
  intersection engine already works on line ranges. Cons that deferred it:
  CLI surface growth for a consumer (non-git agents tracking exact edit
  ranges) that may never materialize. Blocked by: incremental-gating plan
  shipping first. (Deferred from incremental-gating eng review, 2026-06-13.)

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
