# Plan 011: `.dryrc` config file with ignore globs and per-path overrides (issue #23)

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result. On any "STOP conditions" item, stop and
> report. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 3c3bb77..HEAD -- src/Options.ts src/TypeScriptDuplicateFinder.ts src/DryTs.ts test/dry4ts.test.ts`
> Reconcile against "Current state" before proceeding. On a mismatch, STOP.

## Status

- **Priority**: P3 (umbrella config surface — build last)
- **Effort**: L
- **Risk**: MED-HIGH (touches option resolution, file selection, and per-pair
  scoring precedence)
- **Depends on**: plans 007, 008 (and optionally 010) — their flags become the
  per-path override fields, so land those first and let the option shapes settle
- **Category**: false-positive reduction (config)
- **Issue**: #23
- **Planned at**: commit `3c3bb77`, 2026-06-14

## Why this matters

`Options.parse` is CLI-only, and the only path filtering is `.gitignore`.
Consequences: no repo-checked-in ignore globs independent of `.gitignore`, and
one global `threshold`/`minNodes`/`minLines` for the whole scan — you can't run
`tests/**` looser than `src/**` even though test arrange-blocks are a known
noise source (~half the clusters on the abholer run).

## Current state

```ts
src/Options.ts:54   static from(input: OptionsInput = {}): Options {   // merge point candidate
src/Options.ts:73   static parse(...args: string[]): Options {          // CLI only today
src/TypeScriptDuplicateFinder.ts:108  private sourceFiles(options: Options): string[] {
src/TypeScriptDuplicateFinder.ts:109    const isIgnored = options.respectGitignore ? this.gitignoreMatcher() : null;
src/TypeScriptDuplicateFinder.ts:148  private typeScriptFiles(sourcePath, isIgnored): string[] { ... }   // where extra ignore globs apply
src/TypeScriptDuplicateFinder.ts:34   private clustersFor(entries, options): Cluster[] {                 // global threshold/minLocations
src/TypeScriptDuplicateFinder.ts:43   private matchingPairs(entries, threshold): MatchingPair[] {        // single threshold for all pairs
```

The `ignore` dependency is already imported in `TypeScriptDuplicateFinder.ts:4`.
`FileScanner` is per-file (`scanFiles` maps over files), so per-file
`minNodes`/`minLines` is tractable; per-pair `threshold` is the hard part
(`matchingPairs` uses one global threshold for its prefix-index math).

## Precedence model

CLI flags override config; config overrides `Options.defaults()`. Read config
from cwd (`.dryrc` JSON, or `dry.config.json`). Implement the merge in a small
loader that feeds `Options.from` — do NOT scatter file IO through `Options`.

## The hard part: per-path threshold

`matchingPairs` (`src/TypeScriptDuplicateFinder.ts:43`) builds a single
prefix-inverted index parameterized by one `threshold`. A pair can span two
override scopes (left in `src/**`, right in `tests/**`). The issue says use the
stricter of the two. Concretely:

- Per-file `minNodes`/`minLines`: easy — apply at scan time per file in
  `FileScanner` (thread a resolver `(file) => { minNodes, minLines }`).
- Per-pair `threshold`: the prefix index must be built with the **lowest**
  threshold in play (so no real pair is pruned), then each surviving pair
  re-checked against the **stricter** (higher) of its two endpoints' thresholds
  at the `score >= threshold` test (`src/TypeScriptDuplicateFinder.ts:100`).
  Document this two-phase rule; it is the correctness crux.

If the per-pair threshold turns out to materially complicate the index math,
ship per-path `ignore` + per-path `minNodes`/`minLines` first and defer per-path
`threshold` to a follow-up — note that split in the plan row rather than forcing
it all at once.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Test | `bun run test` | exits 0 |
| Full gate | `bun run check` | exits 0 |

## Scope

**In scope**: a new config loader module, `src/Options.ts`,
`src/TypeScriptDuplicateFinder.ts`, `src/FileScanner.ts` (per-file params),
`src/DryTs.ts` (USAGE), README, `test/dry4ts.test.ts`.

**Out of scope**: nested config discovery up the tree (cwd only for v1), config
schema beyond `ignore` + `overrides` (+ the global option mirrors).

## Git workflow

- Branch: `advisor/011-dryrc`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Config loader + merge precedence

- New module (e.g. `src/Config.ts`) that reads `.dryrc`/`dry.config.json` from
  cwd, validates shape, and returns a partial `OptionsInput` plus `ignore` and
  `overrides`.
- Merge in `DryTs.main`/`run` boundary: `defaults < config < CLI`. CLI parsing
  stays in `Options.parse`; the loader supplies the base that CLI overrides.
- Missing config file → no-op (behavior unchanged).

**Verify**: `bun run test` -> exits 0.

### Step 2: Extra ignore globs

- Support `ignore: string[]` applied in addition to `.gitignore` in
  `typeScriptFiles` (`src/TypeScriptDuplicateFinder.ts:148`), reusing the
  `ignore` dependency already imported.

**Verify**: `bun run test` -> exits 0.

### Step 3: Per-path overrides — file-level params

- Support `overrides: [{ paths: glob, threshold?, minNodes?, minLines?, ... }]`.
- Thread a per-file resolver into `FileScanner` so each file gets its
  `minNodes`/`minLines` (and per-path `excludeKinds`/`minDistinctKinds` from
  plans 007/008 if landed).

**Verify**: `bun run test` -> exits 0.

### Step 4: Per-path threshold (two-phase)

- Build the prefix index at the minimum active threshold; re-test each pair
  against the stricter endpoint threshold at the final `score >=` gate.
- If too costly/complex, STOP and confirm the deferral split (see "The hard
  part").

**Verify**: `bun run test` -> exits 0.

### Step 5: Tests

- `minNodes: 30` for `tests/**` and `20` for `src/**` in one run produces the
  expected per-tree filtering.
- `ignore` globs exclude matching files without touching `.gitignore`.
- CLI flags still override config values.
- A pair spanning two override scopes is gated by the stricter threshold.
- No config file present → output identical to current.

**Verify**: `bun run check` -> exits 0.

### Step 6: Docs

Document `.dryrc` schema, precedence, the stricter-of-two pair rule, and that
discovery is cwd-only for now.

**Verify**: `bun run check` -> exits 0.

## Done criteria

- [ ] Per-path `minNodes`/`minLines`/`ignore` work in a single run.
- [ ] CLI overrides config; config overrides defaults.
- [ ] Cross-scope pairs gated by the stricter threshold (or per-path threshold
  explicitly deferred with a noted split).
- [ ] No config file → output unchanged.
- [ ] `bun run test` and `bun run check` exit 0.
- [ ] `plans/README.md` row for plan 011 updated.

## STOP conditions

- Option resolution / scan pipeline no longer matches "Current state".
- Per-pair threshold cannot be done without breaking the prefix-index
  correctness — deferral confirmation required.
- A verification command fails twice after a reasonable fix.

## Maintenance notes

- This is the umbrella surface: per-path `excludeKinds` (007) and
  `minDistinctKinds` (008) should ride the same `overrides` mechanism. Land 011
  after those so their option shapes are stable before they become config keys.
