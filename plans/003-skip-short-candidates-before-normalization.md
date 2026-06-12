# Plan 003: Skip short candidates before normalization

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 9cb1714..HEAD -- src/TypeScriptDuplicateFinder.ts test/dry4ts.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-respect-gitignore.md
- **Category**: perf
- **Planned at**: commit `6bd3210`, 2026-06-11; reconciled against `9cb1714`,
  2026-06-12 (plans 001+002 merged: `scan` already takes full `Options` for
  gitignore handling, `findDuplicates` is removed, the short-candidate test
  already asserts clusters)

## Why this matters

The scanner currently normalizes every candidate root before applying the cheap
`minLines` filter. In a synthetic corpus of 10,000 one-line functions with
`minLines: 4`, the scan returned zero entries but still spent roughly 109 ms in
avoidable normalization work. This is a small, low-risk optimization that
reduces cost in codebases with many trivial declarations.

## Current state

- `entriesFor` filters by line count only after `scan` has already built
  entries. Note `scan` already receives the full `Options` (it needs
  `respectGitignore`), so threading `minLines` deeper is straightforward:

```ts
src/TypeScriptDuplicateFinder.ts:47   private entriesFor(options: Options): Entry[] {
src/TypeScriptDuplicateFinder.ts:48     return this.scan(options)
src/TypeScriptDuplicateFinder.ts:49       .filter((entry) => lines(entry) >= options.minLines)
src/TypeScriptDuplicateFinder.ts:50       .filter((entry) => entry.nodes >= options.minNodes);
src/TypeScriptDuplicateFinder.ts:53   private scan(options: Options): Entry[] {
src/TypeScriptDuplicateFinder.ts:54     const isIgnored = options.respectGitignore ? this.gitignoreMatcher() : null;
```

- `scan` ends with `.flatMap((file) => this.scanFile(file))`; `scanFile`
  (line 128) parses and calls `collectEntries`. `collectEntries` creates an
  entry for every candidate root, and `entry` normalizes before returning:

```ts
src/TypeScriptDuplicateFinder.ts:144   private collectEntries(file: string, sourceFile: ts.SourceFile, node: ts.Node, entries: Entry[]): void {
src/TypeScriptDuplicateFinder.ts:145     if (this.isCandidateRoot(node)) {
src/TypeScriptDuplicateFinder.ts:146       entries.push(this.entry(file, sourceFile, node));
src/TypeScriptDuplicateFinder.ts:148     node.forEachChild((child) => this.collectEntries(file, sourceFile, child, entries));
src/TypeScriptDuplicateFinder.ts:176   private entry(file: string, sourceFile: ts.SourceFile, node: ts.Node): Entry {
src/TypeScriptDuplicateFinder.ts:177     const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false)).line + 1;
src/TypeScriptDuplicateFinder.ts:178     const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
src/TypeScriptDuplicateFinder.ts:179     const normalized = this.normalizer.normalize(node);
```

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Test | `bun run test` | exits 0; all tests pass |
| Full gate | `bun run check` | exits 0; build, tests, and dry4ts scan pass |

## Scope

**In scope**:

- `src/TypeScriptDuplicateFinder.ts`
- `test/dry4ts.test.ts`

**Out of scope**:

- Changing minNodes behavior; node count still requires normalization.
- Changing candidate-root selection.
- Changing similarity or cluster output.

## Git workflow

- Branch: `advisor/003-skip-short-candidates`.
- Commit message style in this repo is short imperative/prose.
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Move the minLines check before normalization

In `src/TypeScriptDuplicateFinder.ts`, pass `Options` or at least `minLines`
through the scan pipeline so `collectEntries` can check line count before
calling `entry`.

Suggested shape:

- `scan` already receives `Options`; pass `options.minLines` (or `options`)
  through `scanFile` into `collectEntries`.
- Extract a helper that computes line range without normalization:

```ts
function lineRangeFor(sourceFile: ts.SourceFile, node: ts.Node): Location {
  return {
    file: sourceFile.fileName,
    startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false)).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
  };
}
```

Adapt the exact shape to the existing file conventions. The important behavior
is:

- always recurse into child nodes, even when a parent candidate is too short
- skip calling `this.entry(...)` when the candidate's line count is below
  `options.minLines`
- keep the `minNodes` filter after normalization

**Verify**: `bun run test` -> exits 0.

### Step 2: Add a regression test for behavior and optional instrumentation

Keep the existing test `filters candidates shorter than the minimum line count`
(around `test/dry4ts.test.ts:138`) — it already uses `findClusters` via the
`scanFixture` helper and asserts `assert.deepEqual(clusters, [])`.

Add one instrumentation-style test only if it is not brittle:

- Create a one-line function fixture.
- Set `minLines` high enough that the candidate is rejected.
- Replace the finder normalizer with a test double that throws if called, using
  a narrow test-only cast.
- Assert the scan returns no clusters and does not throw.

If that test becomes awkward because private fields are hardened by a future
TypeScript target, skip the instrumentation test and rely on code review plus
the benchmark command in Step 3.

**Verify**: `bun run test` -> exits 0.

### Step 3: Run a short-candidate benchmark

Run a small `bun --eval` benchmark that creates thousands of one-line functions
in a temp directory and scans them with `minLines: 4`. Compare timing before
and after this plan if you have a before value available.

Expected result:

- zero clusters
- no parse errors
- scan time lower than the before value for the same corpus

Do not commit benchmark artifacts; use `/tmp` or an OS temp directory.

**Verify**: `bun run check` -> exits 0.

## Test plan

- Preserve behavior tests for short-candidate filtering.
- Add an instrumentation test if practical to prove normalization is skipped
  for below-minLines candidates.
- Run `bun run test` and `bun run check`.

## Done criteria

- [ ] A below-minLines candidate is rejected before `normalizer.normalize` is
  called.
- [ ] `minNodes` filtering still happens after normalization.
- [ ] Child candidate roots are still visited when a parent candidate is too
  short.
- [ ] `bun run test` exits 0.
- [ ] `bun run check` exits 0.
- [ ] `plans/README.md` status row for plan 003 is updated.

## STOP conditions

Stop and report back if:

- The scanner structure no longer matches the excerpts in "Current state".
- Avoiding normalization would require changing candidate semantics.
- The change breaks line-range reporting.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- Keep this optimization focused. Do not combine it with fingerprint hashing or
  all-pairs pruning; those are separate plans.
- Reviewers should check nested declarations carefully: skipping a short parent
  must not prevent a longer child from being considered.
