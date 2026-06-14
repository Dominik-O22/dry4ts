# Plan 012: `--explain` match-explanation output (issue #29)

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result. On any "STOP conditions" item, stop and
> report. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 0.6.0..HEAD -- src/FileScanner.ts src/Options.ts src/DryTs.ts src/types.ts`
> This plan assumes the `kind`/`name` location enrichment from PR #38
> (branch `feat/finding-enrichment`) has landed: every `ClusterLocation` already
> carries `kind` and `name`. If that surface is missing, STOP and reconcile.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (reuses plan 008's tag machinery; new work is opt-in)
- **Depends on**: plan 008 (`tags[]` per-node tracking + the candidate gate),
  PR #38 (`kind`/`name` on each location — #29 item 3, already shipped)
- **Category**: false-positive reduction (explainability / tuning evidence)
- **Issue**: #29
- **Planned at**: branch `feat/finding-enrichment`, 2026-06-14

## Why this matters

When a cluster is reported there is no signal for *why* it matched, so tuning the
FP-reduction knobs (`--min-nodes`, `--exclude-kinds` #19, `--min-distinct-kinds`
#20) is guesswork. #29 asks for three explainability fields:

1. **Shared-fingerprint count** per cluster.
2. **Dominant node kinds** of each candidate (top-N `SyntaxKind` by frequency
   over its subtree).
3. **Candidate root kind per location** — **already shipped in PR #38** (`kind`).

This plan delivers **item 2**, the highest-value remaining signal: it tells a
user *which knob* would drop a noisy cluster ("90% `PropertySignature` → reach
for `--min-distinct-kinds`"), which `kind` alone only implies for the simplest
boilerplate. Its payoff is at scale — tuning a multi-thousand-cluster run
(sentry corpus ~2574 clusters), exactly #29's acceptance scenario.

**Item 1 (shared-fingerprint count) is deliberately OUT OF SCOPE here** — see
"Findings deferred" below.

## Current state

- PR #38 added `kind: string` and `name: string | null` to `Entry`
  (`src/FileScanner.ts`) and optional `kind?`/`name?` to `ClusterLocation`
  (`src/types.ts`); all three formats render them.
- Plan 008 added a parallel `tags: string[]` pushed in lockstep with `hashes`,
  but **only when `minDistinctKinds > 0`** (`const trackKinds = minDistinctKinds
  > 0`). The off path tracks nothing, by design. `distinctKindCount(tags,
  tagStart)` already counts distinct kinds over a candidate's subtree slice
  `[tagStart, end)`.
- `--explain-changed` already exists and is **unrelated** — it dumps the resolved
  changed-region map to stderr for debugging. Do not overload it.

So the histogram is a *frequency* count over the same `tags` slice 008 already
slices for its distinct count. The machinery exists; what is new is (a) tracking
tags when explain is on, (b) computing top-N frequency, (c) plumbing + rendering.

## Naming

Recommend `--explain` for the flag. It is distinct from `--explain-changed`
(stderr debug dump). If the executor judges the collision too close, fall back to
`--explain-matches`; pick one and use it consistently in USAGE + README + tests.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Test | `bun run test` | exits 0 |
| Full gate | `bun run check` | exits 0 |
| Off-path bench | `bun run bench -- src test` | no regression vs pre-change |

## Scope

**In scope**: `src/Options.ts`, `src/FileScanner.ts`,
`src/TypeScriptDuplicateFinder.ts`, `src/DryTs.ts` (USAGE + renderers),
`src/types.ts`, README, `test/dry-ts.test.ts`, `plans/README.md` (status row).

**Out of scope**: shared-fingerprint count (#29 item 1 — deferred), pair
provenance, similarity/cluster grouping changes, the entropy variant.

## Git workflow

- Stack on `feat/finding-enrichment` (PR #38) or branch from it once merged.
- Do not push or open a PR unless instructed.

## Design decisions (decide before coding)

1. **Per-location, not per-cluster.** Dominant kinds are a property of a single
   candidate, so attach them to each location (like `kind`/`name`), not the
   cluster. This sidesteps the transitive-cluster ambiguity that sinks item 1.
2. **Opt-in, zero default cost.** Without `--explain`, track no tags (unless
   `--min-distinct-kinds > 0` already does) and emit no new fields → default
   output stays byte-for-byte identical. This is the non-negotiable invariant
   (matches plan 008 and the additive promise of PR #38).
3. **Top-N, not the full histogram.** Default N = 3 dominant kinds per candidate,
   each as `{ kind, count }`, plus the candidate's total node count (already
   `nodes`) so a consumer can compute a ratio. Keeps text output to one extra
   line; full pairs go in json/edn.

## Steps

### Step 1: Track tags when explain is active

In `scanFile`, widen the tracking guard from `minDistinctKinds > 0` to
`minDistinctKinds > 0 || explain`. Thread an `explain: boolean` param through
`scanFiles`/`scanFile` (coordinate with the existing scan-param list). The
lockstep `tags.push(tag)` is the only unconditional-when-on cost; leave it gated.

**Verify**: `bun run test` → exits 0 (no output change yet — flag not wired to
rendering).

### Step 2: Compute the top-N histogram for kept candidates

Add a helper `dominantKinds(tags, start, n)` that counts tag frequency over
`[start, tags.length)` and returns the top-N `{ kind, count }[]` (stable tie-break
by kind name for determinism). Call it at the candidate-push site **only when
explain (or trackKinds) is active**; otherwise leave the field undefined. Add
`dominantKinds?: readonly { kind: string; count: number }[]` to `Entry` and to
`ClusterLocation` (optional, like `kind`/`name`).

**Verify**: `bun run test` → exits 0.

### Step 3: Add `--explain` to Options

Add `explain` to `OptionsInput`/`Options`/`parse` (boolean, positional field
appended at the end, default `false`), mirroring `onlyNew`. Thread it into
`TypeScriptDuplicateFinder.scan` → `FileScanner.scanFiles`.

**Verify**: `bun run test` → exits 0.

### Step 4: Render in all three formats

- **text**: when present, append one compact line per location, e.g.
  `    kinds: PropertySignature×28, TypeReference×27, Identifier×26`. Omit
  entirely when undefined (default scans unaffected).
- **json**: add `dominantKinds: [{ "kind": ..., "count": ... }, ...]` to each
  location object. `JSON.stringify` drops it when undefined — verify.
- **edn**: add `:dominant-kinds [{:kind "..." :count N} ...]`; omit when
  undefined (same branch pattern as the `kind`/`name` work in `locationEdn`).

**Verify**: `bun run check` → exits 0.

### Step 5: Tests

- Scan a property-only interface pair with `--explain`: each location's
  `dominantKinds` is dominated by `PropertySignature` (assert the top kind +
  that count/`nodes` is a high ratio).
- A varied-control-flow function shows a spread of kinds (no single dominant).
- **Default (no `--explain`) output is byte-for-byte identical** to before:
  assert an existing cluster fixture's text/json/edn is unchanged and no
  `dominantKinds` key appears.
- Top-N tie-break is deterministic (fixed order across runs).

**Verify**: `bun run check` → exits 0.

### Step 6: Docs

`--explain` in USAGE and README (a short subsection near `--min-distinct-kinds`,
since it is the knob the histogram steers you toward). State: opt-in, default
off, per-location dominant kinds, points at #29's tuning workflow.

**Verify**: `bun run check` → exits 0.

## Done criteria

- [ ] `--explain` adds per-location dominant kinds in text/json/edn.
- [ ] Flag off → output byte-for-byte identical to current; no tag tracking.
- [ ] Histogram computed without a second AST walk (reuses the existing visit).
- [ ] A user can read a noisy cluster and identify the dominant kind → knob.
- [ ] `bun run test` and `bun run check` exit 0; off-path bench unchanged.
- [ ] `plans/README.md` row for plan 012 updated; #29 item 2 noted done.

## STOP conditions

- The `scanFile` walk no longer matches "Current state" (008's `tags`/`trackKinds`
  gone or restructured).
- The off path (no `--explain`, `--min-distinct-kinds 0`) measurably regresses
  `bun run bench` — the default must stay free.
- Default-output-unchanged test fails (any new field/line leaks without the flag).
- A verification command fails twice after a reasonable fix.

## Findings deferred (out of scope, on purpose)

- **#29 item 1 — shared-fingerprint count.** Marginal value over the existing
  `score` + per-location `nodes` (which already convey similarity and absolute
  size). Worse, it is ill-defined for transitive clusters (>2 members — which
  pair's `shared`?) and a correct implementation requires reviving per-pair edges,
  which the perf rework discarded (see TODOS "Pair-level counterpart provenance":
  retention has memory/perf cost, profile against `.bench` first, retain only on
  the scoped path). Do it as a rider on that pair-provenance work, scoped and
  profiled — not standalone, not here.

## Maintenance notes

- Same off-path discipline as plan 008: the `tags.push` is the one
  unconditional-when-on cost; everything else is guarded behind
  `explain || trackKinds`. If a benchmark shows the push matters even gated,
  gate it too.
- `dominantKinds` is additive and optional on `ClusterLocation`, like `kind`/
  `name`; the stable JSON shape contract is preserved (existing fields untouched).
