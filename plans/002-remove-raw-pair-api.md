# Plan 002: Remove the raw duplicate-pair API

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 6bd3210..HEAD -- package.json README.md src/Clusters.ts src/Dry4Ts.ts src/TypeScriptDuplicateFinder.ts src/index.ts src/types.ts test/dry4ts.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-respect-gitignore.md
- **Category**: cleanup (API surface)
- **Planned at**: commit `6bd3210`, 2026-06-11

## Why this matters

The package is intended to be used as a CLI, not as a library. The CLI never
calls `findDuplicates`, so removing it yields no runtime performance gain for
the product; this plan is API-surface cleanup, not a perf fix. The motivation
is that the raw pair shape is the least scalable output for dense duplicate
sets (a synthetic 1,200-candidate corpus produced 719,400 candidate objects
and used about 151 MB heap after `findDuplicates`), and keeping it invites
library consumers onto the worst code path while doubling the comparison-loop
maintenance burden.

## Current state

- `findDuplicates` materializes and sorts every pair:

```ts
src/TypeScriptDuplicateFinder.ts:22   findDuplicates(options: Options | OptionsInput = Options.defaults()): Candidate[] {
src/TypeScriptDuplicateFinder.ts:23     const resolvedOptions = options instanceof Options ? options : Options.from(options);
src/TypeScriptDuplicateFinder.ts:24     const entries = this.entriesFor(resolvedOptions);
src/TypeScriptDuplicateFinder.ts:25     const candidates: Candidate[] = [];
src/TypeScriptDuplicateFinder.ts:27     for (let i = 0; i < entries.length; i += 1) {
src/TypeScriptDuplicateFinder.ts:28       for (let j = i + 1; j < entries.length; j += 1) {
src/TypeScriptDuplicateFinder.ts:35         if (score >= resolvedOptions.threshold) {
src/TypeScriptDuplicateFinder.ts:36           candidates.push({
src/TypeScriptDuplicateFinder.ts:47     return candidates.sort(compareCandidates);
```

- `findClusters` already performs the CLI's needed behavior directly:

```ts
src/TypeScriptDuplicateFinder.ts:50   findClusters(options: Options | OptionsInput = Options.defaults()): Cluster[] {
src/TypeScriptDuplicateFinder.ts:51     const resolvedOptions = options instanceof Options ? options : Options.from(options);
src/TypeScriptDuplicateFinder.ts:52     const entries = this.entriesFor(resolvedOptions);
src/TypeScriptDuplicateFinder.ts:53     const collector = new ClusterCollector();
src/TypeScriptDuplicateFinder.ts:63         if (score >= resolvedOptions.threshold) {
src/TypeScriptDuplicateFinder.ts:64           collector.addMatch({ ...location(left), nodes: left.nodes }, { ...location(right), nodes: right.nodes }, score);
src/TypeScriptDuplicateFinder.ts:69     return collector.clusters();
```

- `Dry4Ts.ts` still exports raw candidate formatting even though the CLI uses
  clusters:

```ts
src/Dry4Ts.ts:4 import type { Candidate, Cluster, ClusterLocation, ClusterReport, Location } from "./types.js";
src/Dry4Ts.ts:76 export function formatCandidate(candidate: Candidate): string {
src/Dry4Ts.ts:77   return `DUPLICATE score=${candidate.score.toFixed(2)}\n  ${lineRange(candidate.left)}\n  ${lineRange(candidate.right)}`;
```

- `src/index.ts` exports library-facing symbols:

```ts
src/index.ts:1 export { clusterCandidates, maxScore, minScore } from "./Clusters.js";
src/index.ts:2 export { USAGE, formatCandidate, formatCluster, main, printText, toEdn, toJson } from "./Dry4Ts.js";
src/index.ts:5 export { TypeScriptDuplicateFinder } from "./TypeScriptDuplicateFinder.js";
src/index.ts:7 export type { Candidate, Cluster, ClusterReport, Location, OutputFormat } from "./types.js";
```

- README currently documents a library API:

```text
README.md:84 ## Library API
README.md:87 import { TypeScriptDuplicateFinder } from "dry4ts";
README.md:89 const clusters = new TypeScriptDuplicateFinder().findClusters({
```

- Tests still use `findDuplicates` through `scanFixture`:

```ts
test/dry4ts.test.ts:300 async function scanFixture(
test/dry4ts.test.ts:303 ): Promise<{ files: Record<string, string>; candidates: Candidate[] }> {
test/dry4ts.test.ts:305   const candidates = new TypeScriptDuplicateFinder().findDuplicates({ paths: [dir], ...options });
test/dry4ts.test.ts:306   return { files, candidates };
```

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Test | `bun run test` | exits 0; all tests pass |
| Full gate | `bun run check` | exits 0; build, tests, and dry4ts scan pass |
| API grep | `rg -n "findDuplicates|formatCandidate|Candidate|clusterCandidates" src test README.md` | no production references to removed raw-pair API; test-only helper names are acceptable only if they are not exported API |

## Scope

**In scope**:

- `package.json`
- `README.md`
- `src/Clusters.ts`
- `src/Dry4Ts.ts`
- `src/TypeScriptDuplicateFinder.ts`
- `src/index.ts`
- `src/types.ts`
- `test/dry4ts.test.ts`

**Out of scope**:

- Changing cluster JSON/EDN/text output.
- Changing similarity scoring.
- Changing `.gitignore` behavior from plan 001.
- Removing the CLI `bin` entry; the CLI is the supported product.

## Git workflow

- Branch: `advisor/002-remove-raw-pair-api`.
- Commit message style in this repo is short imperative/prose, for example
  `Initial dry4ts implementation`.
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Remove findDuplicates from the finder

In `src/TypeScriptDuplicateFinder.ts`:

- Delete `findDuplicates`.
- Remove the `Candidate` import.
- Delete `compareCandidates` if nothing else uses it.
- Keep `findClusters`, `similarity`, `maxPossibleSimilarity`, and clustering
  behavior unchanged.

**Verify**: `bun run test` will fail at this point because tests still call
`findDuplicates`; the expected failure should mention missing
`findDuplicates`. Do not proceed if unrelated failures appear.

### Step 2: Remove raw candidate output helpers from production exports

In `src/Dry4Ts.ts`:

- Remove the `Candidate` type import.
- Delete `formatCandidate`.

In `src/types.ts`:

- Remove `Candidate` if no production code needs it after the next bullet.

In `src/Clusters.ts`:

- If `clusterCandidates` only exists to convert raw `Candidate[]` into clusters,
  remove it.
- Keep `ClusterCollector`, `maxScore`, and `minScore`.

In `src/index.ts`:

- Stop exporting `clusterCandidates`, `formatCandidate`, and `Candidate`.
- Before removing package-root exports, grep the shipped `skills/` directory
  (it is in the `files` array of `package.json`) for imports of `dry4ts` as a
  package: `rg -n "from .dry4ts.|require\(.dry4ts.\)" skills`. If any skill
  imports the library entry point, treat that as a STOP condition.
- Because this package is CLI-only, also remove package-root library exports
  from `package.json` if no tooling requires them:
  - remove `"main"`
  - remove `"types"`
  - remove `"exports"`
- Keep the `"bin"` field unchanged.

If removing package-root exports breaks `bun run check` for a reason unrelated
to tests, STOP and report. Do not reintroduce the raw pair API as a workaround.

**Verify**: `bun run test` still may fail until tests are updated, but
TypeScript errors should only point at removed test imports/usages.

### Step 3: Rewrite tests to assert clusters instead of raw pairs

In `test/dry4ts.test.ts`:

- Remove imports of `formatCandidate`, `clusterCandidates`, and `type Candidate`.
- Replace `scanFixture` with a helper that returns clusters:

```ts
async function scanFixture(
  sources: Record<string, string>,
  options: { threshold: number; minLines: number; minNodes: number },
): Promise<{ files: Record<string, string>; clusters: Cluster[] }> {
  const { files, dir } = await writeFixture(sources);
  const clusters = new TypeScriptDuplicateFinder().findClusters({ paths: [dir], ...options });
  return { files, clusters };
}
```

- Add or import `type Cluster` from `../src/index.js` if needed.
- Replace `hasDuplicate(candidates, left, right)` with a cluster assertion
  helper that checks whether two expected filenames appear in the same cluster:

```ts
function hasClusterContaining(clusters: readonly Cluster[], ...files: string[]): boolean {
  return clusters.some((cluster) =>
    files.every((file) => cluster.locations.some((location) => location.file.endsWith(file))),
  );
}
```

- Rewrite the first test to find the location for `left.ts` and `right.ts`
  inside a cluster instead of reading `candidate.left` and `candidate.right`.
- Remove the `formats text output with line ranges` test for `formatCandidate`.
  The existing `formats clusters with score range, location count, and node
  size` test covers the supported text output.
- Rewrite `groups transitively connected candidates into clusters` and
  `does not expose complete pairwise match counts in cluster output` to use
  `ClusterCollector` directly. It is acceptable for tests to import
  `ClusterCollector` from `../src/Clusters.js`; it does not need to be exported
  from `src/index.ts`.
- Remove the local `pair` helper if it only builds `Candidate` objects.

**Verify**: `bun run test` -> exits 0.

### Step 4: Remove library API documentation

In `README.md`:

- Delete the `## Library API` section at `README.md:84`.
- Keep CLI usage, CI, AI agent, publishing, and development sections.
- If package metadata exports were removed in Step 2, ensure README does not
  imply package import support anywhere else.

**Verify**: `rg -n "Library API|findDuplicates|formatCandidate|Candidate" README.md src test package.json` -> no matches, except `candidate` as a generic English word inside prose/tests only if not referring to the removed raw pair API.

### Step 5: Run the full gate

Run:

```bash
bun run check
```

Expected result:

- build exits 0
- all tests pass
- CLI duplicate scan exits 0 with "No duplicate clusters found."

## Test plan

- Existing semantic matching tests should continue to prove that structurally
  similar declarations are clustered.
- Existing output tests should focus on cluster output (`formatCluster`, `toEdn`,
  `toJson`).
- Tests should no longer construct raw `Candidate` values unless they are
  purely local test fixtures for a still-supported internal helper. Prefer
  `ClusterCollector` or real `findClusters` fixture scans.
- Run `bun run test` and `bun run check`.

## Done criteria

- [ ] `TypeScriptDuplicateFinder` exposes `findClusters` but not
  `findDuplicates`.
- [ ] No production code exports `Candidate`, `formatCandidate`, or
  `clusterCandidates`.
- [ ] README no longer contains a `Library API` section.
- [ ] `package.json` keeps the CLI `"bin"` entry and no longer advertises a
  package-root import surface unless a verification command proves it is needed.
- [ ] Tests assert cluster behavior directly.
- [ ] `bun run test` exits 0.
- [ ] `bun run check` exits 0.
- [ ] `plans/README.md` status row for plan 002 is updated.

## STOP conditions

Stop and report back if:

- Any external consumer requirement appears in repo docs or tests that requires
  keeping `findDuplicates`.
- Removing package-root exports breaks the CLI build or publish dry-run in a way
  that cannot be fixed without reintroducing a library API.
- Updating tests requires changing similarity or clustering semantics.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- If raw pairs are needed later, add a streaming iterator as a new deliberate
  feature. Do not return a full array of all pair matches by default.
- Reviewers should check that this plan removes API surface without changing
  cluster output shape, exit codes, or CLI options.
- This plan deliberately leaves the quadratic comparison algorithm for a
  separate performance plan.
