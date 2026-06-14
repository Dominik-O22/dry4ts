# Changelog

All notable changes to dry-ts are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`--profile NAME` curated presets** (`pr`, `src`, `audit`, `tests`). Seeds a
  bundle of flag defaults so the right combination no longer has to be discovered
  by trial and error; explicit flags override the profile (precedence: explicit
  flag > profile > built-in default, with list flags like `--exclude-kinds`
  unioning rather than replacing). `pr` is the recommended PR gate
  (`--exclude-tests --min-nodes 50 --exclude-kinds ArrowFunction,VariableStatement
  --only-new --fail-on-duplicates`) and deliberately requires `--changed-from` /
  `--changed` — it sets `--only-new`, which errors without an active scope, so it
  fails loud rather than gating against the wrong base. `src` is source-only,
  `audit` is a broad low-floor exploratory scan, `tests` targets
  test-infrastructure duplication (not anonymous test bodies). New exported
  `PROFILE_NAMES`. The curation footer now also points at the presets.
- **Same-name cross-file ranking.** Clusters where one declaration name recurs
  across two or more distinct files now sort to the top of the report — the
  strongest, near-zero-false-positive "real, copy-pasted duplicate" signal — and
  carry a trailing `same-name=<name>` tag (up to three names, then `(+N)`) in the
  text header so the reason for the ranking is legible in-band. Within each tier,
  ordering is unchanged (strongest score first). Names recurring only within a
  single file do not qualify. New exported helpers `crossFileSharedNames` and
  `hasCrossFileSharedName`.
- **Curation footer.** On a large text run (≥10 clusters) dry-ts prints a short
  footer to stderr naming the curation levers that would cut the noise and
  estimating the `--exclude-tests` reduction (e.g. "1250 disappear with
  --exclude-tests → ≈1324 left"). It teaches the curation workflow in-band
  instead of leaving it below the fold in the README. stderr keeps stdout pure
  findings; JSON/EDN never print it. New exported helpers `noiseSummary` and
  `isTestFile`.

### Changed

- Default report order now ranks same-name cross-file clusters first, so the
  cluster ordinals (and the first-listed cluster) in text/JSON/EDN output can
  differ from prior versions for the same scan. Scores, locations, statuses, and
  exit codes are unchanged.
- The `Options` constructor now takes a single named `ResolvedOptions` object
  instead of 19 positional parameters — a transposed field is a compile error,
  and new flags no longer append positionals. `Options.from` /
  `Options.parse` / `Options.defaults` are unchanged; only direct
  `new Options(...)` positional callers are affected (none in the codebase). New
  exported type `ResolvedOptions`.

### Documentation

- New README "Curating results" section documenting the ranking and footer.
- `// dry-ignore` is now documented as deliberately all-or-nothing and global to
  a declaration (no fingerprint-keyed "intentional pair" acknowledgment, by
  design — that would be a stored baseline); `--exclude` by path is named as the
  intended blunt instrument for intentional N-member families.
- New README "Quickstart" + positioning block up top (first-contact path):
  recommended PR-gate command, honest "what it is / is not" scoping (TypeScript-
  first structural *candidate* detector for PR gates and agents — not a general
  jscpd/PMD replacement), and a maturity/pinning note.
- Empty-result message now reads "No duplicate candidate clusters found." to keep
  the candidate-vs-confirmed-duplication framing honest.

## [0.10.0] - 2026-06-14

### Added

- `--counterparts` adds per-location nearest-counterpart provenance, the payload
  an agent needs to route a finding. For each cluster location it reports its
  nearest matching counterpart — the absolute strongest AST-similar partner in the
  same cluster — as `{ index, file, startLine, endLine, shared, total, score }`:
  `index` is the counterpart's position in that cluster's `locations` array (an
  O(1) deref), `file`/`startLine`/`endLine` are the self-contained reference,
  `shared`/`total` are the exact pairwise fingerprint-intersection and union
  counts, and `score` is `shared / total` (the same similarity value the cluster
  reports, so a consumer never recomputes a float). In a transitive (>2-member)
  cluster this exposes the edge structure the score *range* hides — a tight 1.0
  pair versus a chained 0.82 member. Computed without a second similarity pass
  (the shared count is captured from the existing pairwise walk).
- Under `--counterparts` **and** an active change scope (`--changed-from` /
  `--changed`), each location also carries a per-location `changed` boolean — so an
  autonomous fixer can tell *which* block in a `new` cluster to edit. With both
  sides' `changed` visible, a new/new duplicate (the agent reimplemented itself
  within its own diff) routes to refactoring the new code, and a new/old duplicate
  routes to extracting toward the existing definition.
- The new fields render in all three formats: `text` appends an abbreviated
  `→ nearest <file>:<start>-<end> (<shared>/<total>)` (plus `changed=…`) to the
  location's own line; `json` and `edn` carry the full payload including `index`
  and `score`. New exported types `Nearest` and `ClusterLocation` from the library
  entry point.

### Changed

- `--counterparts` is opt-in and the default path is byte-for-byte unchanged: with
  the flag off, no `nearest`/`changed` own-property is created on `ClusterLocation`
  objects (programmatic `findClusters()` consumers see an identical object shape),
  no per-location map is built, and the threshold-comparison float is bit-identical
  (the shared count is surfaced from the same walk, the arithmetic is unmoved).

### Fixed

- Nearest-counterpart selection is aggregated over **canonical-to-canonical** edges
  — both endpoints being the entry the cluster actually renders — identified by
  identity to mirror `ClusterCollector`'s keep-rule exactly (strictly-greater node
  count, first-wins on ties). This prevents a nested same-line candidate-root
  collision (e.g. a one-line `const x = (…) => …`, which emits both a
  `VariableStatement` and its inner `ArrowFunction` at the same line range) from
  attaching a non-rendered sibling's score to the rendered location on either the
  owner or the counterpart side. A throw-safe fallback covers the rare orphan whose
  only structural match is to a substructure of a larger member.

## [0.9.0] - 2026-06-14

### Added

- Each reported location now carries `kind` and `name`, so a consumer can
  classify a finding without re-reading the source. `kind` is the candidate root
  SyntaxKind name (`FunctionDeclaration`, `Constructor`, `InterfaceDeclaration`,
  `ArrowFunction`, …); `name` is the declaration identifier, or `null` when
  anonymous (an arrow function, a callable signature). A constructor is named
  `constructor`; a `VariableStatement` takes its first binding name. The text
  format appends `kind=… name=…` (dropping `name=` when anonymous); JSON and EDN
  add `kind`/`name` fields (`null`/`nil` when anonymous). The fields are computed
  only for kept candidates, so the scan path is otherwise unchanged. Additive to
  the JSON shape — existing fields are untouched.

## [0.8.0] - 2026-06-14

### Added

- `--exclude-tagged-templates` drops candidate declarations whose value is a
  tagged template literal (`const X = styled(Button)\`…\``, `styled('span')\`…\``,
  `css\`…\``, `gql\`…\``). CSS-in-JS and styled-components declarations normalize
  to a near-identical AST — a `VariableStatement` whose initializer is a
  `TaggedTemplateExpression`, with `${p => p.theme.x}` arrow interpolations that
  clear the kind-diversity floor — so they cluster across dozens of files
  despite sharing no logic, and the existing reducers cannot catch them without
  also dropping real const-bound function duplicates. The flag matches by
  structure rather than by tag name, suppressing `styled`/`css`/`gql` and any
  styled alias uniformly with no allowlist to maintain. On the Sentry corpus it
  removes 200 of 2574 clusters (~8%), the single largest remaining
  false-positive class after path and kind filters. Opt-in, default off; when
  off, output is byte-for-byte unchanged and the check costs nothing.

## [0.7.0] - 2026-06-14

### Added

- `--exclude GLOB` skips files and directories matching a `.gitignore`-style
  glob during directory scans, e.g. `--exclude '**/*.spec.*'`. Repeatable, and
  applies regardless of `--no-gitignore` (it is an explicit instruction, not
  repo config); explicit file arguments are still always scanned. This is the
  highest-leverage false-positive filter for real codebases: on a large
  frontend corpus, test and story files alone account for roughly half of all
  reported clusters, and a couple of `--exclude` globs remove them in one pass
  while keeping every real duplicate elsewhere.

## [0.6.0] - 2026-06-14

### Added

- `--min-distinct-kinds N` adds a structure-variety floor that complements
  `--min-nodes`. A large candidate can still be near-uniform boilerplate (a
  property-only interface, a flat config object) that clears the node-count bar
  yet reaches the similarity threshold against any similarly-shaped block.
  `--min-distinct-kinds` drops a candidate whose subtree spans fewer than `N`
  distinct node kinds, while keeping candidates with varied control flow.
  Default off (`0`); only node kinds count toward diversity, not markers. Tags
  are tracked only when the flag is active, so the default scan path is
  unchanged and adds no cost.
- `// dry-ignore` inline directive: a source-level escape hatch for an
  intentional, idiomatic repetition you do not want to exclude wholesale by kind
  or file. A `// dry-ignore` (or `// dry-ignore-next-line`) comment in a
  declaration's leading trivia drops that declaration as a candidate; the
  block-comment form `/* dry-ignore */` works too. Suppression is scoped to the
  node whose leading comment carries the directive (a directive on a wrapping
  `const` statement does not reach a nested arrow function), and never hides
  unrelated child candidates. No flag required and no second parse — the
  directive is read from the source already in memory.

## [0.5.0] - 2026-06-14

### Added

- `--only-new` restricts the report to clusters with `status: "new"` when used
  with `--changed-from`/`--changed`. In a CI gate the handful of actionable new
  clusters are otherwise buried under pre-existing `known` debt. This is an
  output filter only: the exit code stays governed by `--fail-on-duplicates`
  over `new` clusters, and a totals line (`showing N new (M known hidden)`)
  prints to stderr so the suppression is visible. Honored across `text`, `json`,
  and `edn`. Errors if used without a changed-scope flag (there is no `new`
  status without one).
- `--exclude-kinds KIND[,KIND...]` drops candidate declarations of the named
  `SyntaxKind`s before matching, to suppress structural false positives such as
  dep-only DI constructors (`--exclude-kinds Constructor`) or port/interface
  member signatures (`--exclude-kinds PropertySignature,MethodSignature`).
  Comma-separated and repeatable. Opt-in only: with no flag, output is
  byte-for-byte unchanged (no default exclusions). Excluding a kind never hides
  a longer child candidate — children are always visited. An unknown or
  non-candidate kind name is a hard error.

## [0.4.0] - 2026-06-13

### Added

- Incremental duplicate gating: gate a build only on duplication a change
  introduces, instead of failing on every duplicate in the codebase.
  - `--changed-from <ref>` marks clusters that intersect code changed since
    `merge-base(<ref>, HEAD)` as `status: "new"`. Untracked scanned files count
    as fully changed. Use `--changed-from origin/main` in CI for correct PR
    semantics; pair with `fetch-depth: 0` so the shallow checkout doesn't break
    merge-base.
  - `--changed <file>` (repeatable) marks clusters intersecting a named file as
    new — file-level granularity, for agents and non-git callers.
  - `--explain-changed` dumps the resolved changed-region map to stderr so a
    surprising gate result is diagnosable in one rerun.
- Every cluster now reports a `status` (`"new" | "known" | "unscoped"`) in all
  CLI output formats (JSON, EDN, and text). `--fail-on-duplicates` under a
  changed-scope exits 1 only on `new` clusters; with no scope it stays
  zero-tolerance and every cluster reports `unscoped`. (Status is assigned by
  the CLI; the `TypeScriptDuplicateFinder` library returns clusters with
  `status` unset.)

### Changed

- `OutputFormat` is now the closed union `"text" | "edn" | "json"`, and `status`
  is an additive field on the exported `Cluster` / `ClusterReport` types. It is
  optional on `Cluster` and populated by the CLI; library callers using
  `findClusters()` get clusters with `status` unset.
- The gate fails closed: a missing git binary, a bad ref, unparseable diff
  output, an unreadable source file, or zero files scanned under
  `--fail-on-duplicates` all exit 2 — never a silent green or a 1 that reads as
  "findings". Unknown `-`-prefixed flags are rejected (exit 2) instead of being
  treated as scan paths.

### Fixed

- Filenames containing spaces or control characters (tab, newline, quote,
  backslash) are now handled correctly under `--changed-from`: git appends a tab
  to `+++` headers for spaced names and C-quotes control-char names, which
  previously made a region key mismatch the scanner's path — silently passing a
  new duplicate as `known`, or falsely flagging a clean tracked file as changed.

## [0.3.0] - 2026-06-13

### Changed

- Large performance rework of the scan and matching pipeline. Scanning the
  TypeScript compiler sources dropped from ~5.4s to ~1.5s; the Sentry frontend
  (8.5k files), which previously did not finish within five minutes, now scans
  in ~6.6s. Reported clusters are unchanged (verified byte-identical on both
  corpora).
  - Candidate pairs are found through prefix filtering over a rarest-first
    fingerprint index instead of comparing all size-window pairs.
  - Structural fingerprints are 53-bit content hashes stored in sorted
    `Float64Array`s instead of interned strings in `Set`s. Hashing is
    deterministic and stateless; the chance of a hash collision affecting a
    result is negligible for candidate finding.
  - Files are parsed and fingerprinted in a single AST walk (new
    `FileScanner`) without materializing a normalized tree, and without
    parent-node wiring in the TypeScript parser.
  - `--min-nodes` now prunes candidates before fingerprinting, so raising it
    speeds up scans.
- Internals: `NormalizedNode.fingerprints()` returns a sorted `Float64Array`
  (was `Set<string>`), and `FingerprintInterner.idFor()` returns a number
  (was string). dry-ts is a CLI; these types only matter if you import its
  modules directly. CLI behavior is unchanged.

### Fixed

- A pair whose similarity equals the threshold exactly could be skipped when
  floating-point division floored the size window (e.g. `405 / 0.81`).

## [0.2.1] - 2026-06-12

### Changed

- Renamed to `dry-ts` (the `dry4ts` name was taken on npm by an unrelated
  scraped copy). The npm package, the CLI binary, and the docs now use `dry-ts`;
  internal source files were renamed (`src/Dry4Ts.ts` → `src/DryTs.ts`,
  `src/bin/dry4ts.ts` → `src/bin/dry-ts.ts`). The GitHub repository keeps the
  dry4ts name, so clone URLs are unchanged.

### Added

- Release automation: pushing a published GitHub Release (tag `vX.Y.Z`) now
  builds, tests, and publishes to npm with provenance via
  `.github/workflows/publish.yml`. Requires the `NPM_TOKEN` repo secret.

## [0.2.0] - 2026-06-12

### Added

- Duplicate findings are now reported as clusters: overlapping pairs are merged
  via union-find so each group of similar code appears once, with all member
  locations listed together.
- Scans respect `.gitignore` by default — ignored directories (e.g.
  `node_modules/`, `dist/`) are skipped entirely; pass `--no-gitignore` to scan
  everything. Files passed explicitly on the command line are always scanned.
- Option validation: out-of-range `--threshold`, `--min-lines`, and
  `--min-nodes` values now fail fast with a clear error and exit code 2.
- `--min-locations N` filters reported clusters to those with at least `N`
  member locations (default 2); values below 2 fail fast with exit code 2.
- Benchmark tooling: `bun run bench` measures scan time, `bun run bench:setup`
  pins a large real-world corpus (microsoft/TypeScript v5.9.3), and
  `bun run bench:corpus` generates deterministic synthetic corpora.
- Performance improvement plans under `plans/` with review notes and an
  execution-order index.

### Changed

- JSON and EDN output now contain a `clusters` array instead of `candidates`;
  each cluster holds its member locations and a score range (min/max). (Package is
  unpublished, so no published consumers are affected.)
- Text output groups duplicates by cluster instead of printing raw pairs.

### Fixed

- Trailing-slash `.gitignore` patterns (e.g. `build/`) now correctly prune the
  matching directories during scans.
- A `.gitignore` that cannot be read at scan start (missing, unreadable)
  no longer crashes the run; filtering is skipped and all paths are scanned.
- Overlapping path arguments (e.g. `dry4ts src src/utils`) no longer cause
  files in the overlap to be scanned and compared twice.
