# Plan 005: Prune candidate pairs before exact similarity

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 6bd3210..HEAD -- src/TypeScriptDuplicateFinder.ts test/dry4ts.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans/004-intern-structural-fingerprints.md
- **Category**: perf
- **Planned at**: commit `6bd3210`, 2026-06-11

## Why this matters

After scanning and normalization, the finder still compares every candidate
against every later candidate. Synthetic measurements showed the comparison
phase scaling quadratically: 400 candidates produced 79,800 pairs and about
0.30 seconds, 800 produced 319,600 pairs and about 1.2 seconds, and 1,200
produced 719,400 pairs and about 3.0 seconds. The fix must reduce exact
similarity calls without silently dropping valid fuzzy duplicate clusters.

## Current state

- `findClusters` contains a direct all-pairs nested loop:

```ts
src/TypeScriptDuplicateFinder.ts:55     for (let i = 0; i < entries.length; i += 1) {
src/TypeScriptDuplicateFinder.ts:56       for (let j = i + 1; j < entries.length; j += 1) {
src/TypeScriptDuplicateFinder.ts:57         const left = entries[i];
src/TypeScriptDuplicateFinder.ts:58         const right = entries[j];
src/TypeScriptDuplicateFinder.ts:59         if (overlaps(left, right) || maxPossibleSimilarity(left, right) < resolvedOptions.threshold) {
src/TypeScriptDuplicateFinder.ts:62         const score = similarity(left, right);
src/TypeScriptDuplicateFinder.ts:63         if (score >= resolvedOptions.threshold) {
```

- `maxPossibleSimilarity` is a useful filter but it is applied only after every
  `i,j` pair has already been visited:

```ts
src/TypeScriptDuplicateFinder.ts:221 function maxPossibleSimilarity(left: Entry, right: Entry): number {
src/TypeScriptDuplicateFinder.ts:222   const smaller = Math.min(left.fingerprints.size, right.fingerprints.size);
src/TypeScriptDuplicateFinder.ts:223   const larger = Math.max(left.fingerprints.size, right.fingerprints.size);
src/TypeScriptDuplicateFinder.ts:224   return larger === 0 ? 0 : smaller / larger;
```

- Exact similarity is still the final authority:

```ts
src/TypeScriptDuplicateFinder.ts:206 function similarity(left: Entry, right: Entry): number {
src/TypeScriptDuplicateFinder.ts:210   const smaller = left.fingerprints.size <= right.fingerprints.size ? left.fingerprints : right.fingerprints;
src/TypeScriptDuplicateFinder.ts:213   for (const fingerprint of smaller) {
src/TypeScriptDuplicateFinder.ts:214     if (larger.has(fingerprint)) {
src/TypeScriptDuplicateFinder.ts:218   return shared / (left.fingerprints.size + right.fingerprints.size - shared);
```

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Test | `bun run test` | exits 0; all tests pass |
| Full gate | `bun run check` | exits 0; build, tests, and dry4ts scan pass |
| Benchmark | `bun run bench -- --runs 5 src test` | exits 0 and prints JSON timing |

## Scope

**In scope**:

- `src/TypeScriptDuplicateFinder.ts`
- `test/dry4ts.test.ts`
- `scripts/benchmark.mjs` only if plan 001/002 has already committed it as a
  tracked benchmark script

**Out of scope**:

- Changing similarity scoring.
- Changing cluster output.
- Adding approximate matching with false negatives.
- Reintroducing raw pair output.

## Git workflow

- Branch: `advisor/005-prune-candidate-pairs`.
- Commit message style in this repo is short imperative/prose.
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract pair generation behind a small internal helper

Before changing behavior, isolate the pair-generation loop inside
`src/TypeScriptDuplicateFinder.ts`.

Suggested shape:

```ts
private matchingPairs(entries: readonly Entry[], threshold: number): Array<readonly [Entry, Entry, number]> {
  const pairs: Array<readonly [Entry, Entry, number]> = [];
  // initially move the existing nested loop here unchanged
  return pairs;
}
```

`findClusters` should consume this helper and add matches to `ClusterCollector`.
At this step, do not change the algorithm yet.

**Verify**: `bun run test` -> exits 0.

### Step 2: Add equivalence tests before optimizing

Add test coverage that can catch missed matches:

- Build several synthetic fixtures with identical, near-identical, and clearly
  different functions.
- For each fixture, compare the new helper's output against a deliberately
  simple exhaustive reference implementation in the test file.
- Cover at least thresholds `0.2`, `0.5`, and `0.82`.

If the helper remains private and cannot be tested directly without awkward
exports, test through `findClusters` by comparing cluster locations from the
optimized path to cluster locations from a test-only exhaustive implementation
copied into the test file.

**Verify**: `bun run test` -> exits 0.

### Step 3: Add exact fingerprint-set grouping

Add a first pruning pass that groups entries with identical fingerprint sets.
For each group of size > 1:

- add enough score-1 matches to connect the group into one cluster, such as
  matching the first entry to every other entry
- do not compare every pair inside the group

Use a stable key built from sorted fingerprint IDs. This is exact: identical
sets have Jaccard score 1.

Keep exact `similarity` as the authority for all non-identical groups.

**Verify**: `bun run test` -> exits 0 and dense identical fixtures still form
one cluster.

### Step 4: Add safe size-window pruning

Sort or bucket remaining entries by fingerprint-set size. For a given left
entry of size `n` and threshold `t`, only compare right entries whose sizes are
between:

- `ceil(n * t)`
- `floor(n / t)`

This is the same logic as `maxPossibleSimilarity`, but applied before entering
the full nested comparison range where possible.

Keep the old `maxPossibleSimilarity` guard as a defensive check before exact
similarity.

**Verify**: `bun run test` -> exits 0.

### Step 5: Add a no-false-negative inverted index only if equivalence tests pass

If more pruning is still needed after exact grouping and size windows, add a
Jaccard prefix-filter index:

- compute global fingerprint frequencies
- sort each entry's fingerprints by ascending frequency, then lexical ID
- index the prefix needed by the standard Jaccard prefix-filter theorem
- generate exact-similarity candidates only from entries sharing a prefix token
  and satisfying the size window

This step is high risk. If you cannot prove the prefix length formula with
tests against exhaustive comparison, STOP and report with the grouping and size
window work complete.

**Verify**: `bun run test` -> exits 0 and equivalence tests pass for randomized
fixtures.

### Step 6: Benchmark and document the measured impact

Run the existing benchmark:

```bash
bun run bench -- --runs 5 src test
```

Also run a synthetic dense-identical corpus benchmark similar to the audit:

- 400, 800, and 1,200 identical-shape functions
- measure `findClusters`
- record pair-generation/similarity call counts if you added counters behind a
  local benchmark-only script

Expected result:

- dense identical groups should no longer perform all pairwise comparisons
- normal repo scan still passes and remains fast

Do not commit temporary benchmark data unless the repo already has a tracked
benchmark artifact convention.

## Test plan

- Add equivalence tests comparing optimized pair generation to exhaustive
  comparison.
- Add dense-identical cluster tests to prove grouping produces the same cluster
  with fewer exact comparisons.
- Add size-window boundary tests where candidate sizes are just inside and just
  outside the valid threshold range.
- Run `bun run test` and `bun run check`.

## Done criteria

- [ ] Dense identical fingerprint sets are clustered without all-pairs
  comparison inside the group.
- [ ] Size-window pruning happens before exact similarity for non-identical
  sets.
- [ ] Any inverted-index/prefix-filter pruning is proven against exhaustive
  comparison tests; otherwise it is not included.
- [ ] Similarity scoring and cluster output shape are unchanged.
- [ ] `bun run test` exits 0.
- [ ] `bun run check` exits 0.
- [ ] `plans/README.md` status row for plan 005 is updated.

## STOP conditions

Stop and report back if:

- An optimized pair generator disagrees with exhaustive comparison in tests.
- The only way to get a speedup is to accept possible false negatives.
- The change requires exposing new public APIs.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- This is the highest-risk performance plan. Land plans 001-004 first so this
  work starts from a smaller, cleaner performance surface.
- Reviewers should inspect the equivalence tests before the implementation
  details; the main risk is silently missing duplicate clusters.
