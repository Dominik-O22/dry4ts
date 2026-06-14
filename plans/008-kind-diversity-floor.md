# Plan 008: Kind-diversity (entropy) floor (issue #20)

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result. On any "STOP conditions" item, stop and
> report. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 3c3bb77..HEAD -- src/FileScanner.ts src/Options.ts src/TypeScriptDuplicateFinder.ts test/dry4ts.test.ts`
> Reconcile against "Current state" before proceeding. On a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S-M
- **Risk**: LOW-MED (hot scan path)
- **Depends on**: plan 007 (same gate; land 007 first or co-develop)
- **Category**: false-positive reduction (detection)
- **Issue**: #20
- **Planned at**: commit `3c3bb77`, 2026-06-14

## Why this matters

`--min-nodes` filters by raw node count, but a large candidate can still be
near-uniform boilerplate — an interface body is mostly `PropertySignature` +
type repeated; a config object is mostly `PropertyAssignment`. These clear the
node-count bar yet carry little structure, so they reach the Jaccard threshold
against any similarly-shaped block. A diversity floor drops them while keeping
varied-control-flow candidates. Complements plan 007: that removes whole kinds,
this filters uniform *instances* of kinds you still want.

## Current state

`scanFile` walks the AST once and builds `hashes` (post-order fingerprints) but
does **not** materialize tags per node — the candidate gate works on counts and
fingerprint slices only:

```ts
src/FileScanner.ts:45   const visit = (node: ts.Node): number => {
src/FileScanner.ts:46     const order = nextOrder++;
src/FileScanner.ts:47     const rangeStart = hashes.length;
...
src/FileScanner.ts:59     const hash = this.interner.idFor(this.normalizer.tag(node), childHashes);
src/FileScanner.ts:60     hashes.push(hash);
src/FileScanner.ts:62     if (candidateRootKinds.has(node.kind) && hashes.length - rangeStart >= minNodes) {
```

`this.normalizer.tag(node)` (the syntax-kind name) is already computed at L59 for
the fingerprint. To get diversity per candidate we need the set/distribution of
tags over the subtree range `[rangeStart, end)`, which is not tracked today.

Note: `sortedUnique(hashes, rangeStart)` counts distinct **fingerprints**
(structural subtrees), which is NOT the same as distinct **kinds** — a uniform
interface has many distinct fingerprints (each `PropertySignature` over a
different type name normalizes the name away... actually they fingerprint
identically, but config objects with distinct values still differ). Do not reuse
fingerprint-distinctness as a kind-diversity proxy; track tags explicitly.

## Metric choice

Two options in the issue: distinct-tag count or Shannon entropy of the tag
distribution. **Recommended**: ship `--min-distinct-kinds <n>` first — it is
trivial to compute, easy to reason about, and easy to test. Leave
`--min-kind-entropy` as a possible follow-up; entropy is harder to pick a
threshold for. Default **off** (0 / unset) so current behavior is preserved.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Test | `bun run test` | exits 0 |
| Full gate | `bun run check` | exits 0 |

## Scope

**In scope**: `src/Options.ts`, `src/FileScanner.ts`,
`src/TypeScriptDuplicateFinder.ts`, `src/DryTs.ts` (USAGE), README,
`test/dry4ts.test.ts`.

**Out of scope**: similarity/cluster output, kind exclusion (plan 007), entropy
variant unless the executor chooses to include it.

## Git workflow

- Branch: `advisor/008-kind-diversity-floor`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Track tags per node alongside hashes

In `scanFile`, add a parallel `tags: string[]` (or `number[]` of interned tag
ids) pushed in lockstep with `hashes` so that for a candidate the slice
`tags[rangeStart .. end)` describes its subtree. Push the tag at the same point
`hashes.push(hash)` happens (L60); also push marker pseudo-tags if you want
markers to count toward diversity (recommend: count node kinds only, not
markers — simpler and matches "kind"-diversity intent; document the choice).

**Verify**: `bun run test` -> exits 0 (no behavior change yet — floor not wired).

### Step 2: Add `--min-distinct-kinds`

- Add to `OptionsInput`/`Options`/`parse` (positional field, append at end),
  default `0` (off).
- Thread it into `scanFiles`/`scanFile` (coordinate the signature with plan 007;
  if 007 introduced a scan-options object, add the field there).

**Verify**: `bun run test` -> exits 0.

### Step 3: Apply the floor at the candidate gate

At `src/FileScanner.ts:62`, after the existing `minNodes` and the `minLines`
check, compute the distinct-tag count over `[rangeStart, end)` and skip the
candidate when it is below `minDistinctKinds`. Keep it cheap — a `Set` over the
range slice is fine; only build it when `minDistinctKinds > 0`.

**Verify**: `bun run test` -> exits 0.

### Step 4: Tests

- A 30-member interface no longer clusters with an unrelated 30-member interface
  once `--min-distinct-kinds` is set above their tag variety.
- A 25-node function with varied control flow still qualifies.
- With the flag unset/0, output is byte-for-byte unchanged vs today (assert an
  existing cluster fixture is identical).

**Verify**: `bun run check` -> exits 0.

### Step 5: Docs

`--min-distinct-kinds` in USAGE and README; note it is a complement to
`--min-nodes`, default off.

**Verify**: `bun run check` -> exits 0.

## Done criteria

- [ ] Uniform large candidate dropped above the floor; varied candidate kept.
- [ ] Flag off → output identical to current.
- [ ] Diversity computed without a second AST walk (reuses the existing visit).
- [ ] `bun run test` and `bun run check` exit 0.
- [ ] `plans/README.md` row for plan 008 updated.

## STOP conditions

- The `scanFile` walk no longer matches "Current state".
- Tracking tags measurably regresses the scan benchmark (run `bun run bench`;
  if a clear regression with the flag OFF, STOP — the off path must stay free).
- A verification command fails twice after a reasonable fix.

## Maintenance notes

- The off-path must add no measurable cost: guard the tag-set build behind
  `minDistinctKinds > 0`. Pushing into the `tags` array on every node is the one
  unconditional cost — if benchmarks show it matters, gate the push too and only
  collect tags when the floor is active.
