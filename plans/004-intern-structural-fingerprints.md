# Plan 004: Intern structural fingerprints

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7e77580..HEAD -- src/NormalizedNode.ts src/TypeScriptDuplicateFinder.ts src/TypeScriptNormalizer.ts test/dry4ts.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/003-skip-short-candidates-before-normalization.md
- **Category**: perf
- **Planned at**: commit `6bd3210`, 2026-06-11; reconciled against `7e77580`,
  2026-06-12. `src/NormalizedNode.ts` and `src/TypeScriptNormalizer.ts` are
  unchanged since planning. Plan 003 changed the finder pipeline:
  `scanFile(file, minLines)` at line 126,
  `collectEntries(file, sourceFile, node, entries, minLines)` at line 142
  (computes `lineRangeFor` before calling `entry`), and
  `entry(file, node, startLine, endLine)` at line 177 (calls
  `normalized.nodeCount()` / `normalized.fingerprints()` at lines 183-184).
  Thread the interner alongside `minLines` (or switch to a small context
  object). Plan 003 also added the test
  `does not normalize candidates shorter than minLines` which replaces the
  private `normalizer` with a throwing double — keep it passing.

## Why this matters

`NormalizedNode.fingerprints()` currently builds full recursive subtree strings
for every node. A synthetic nested function with about 1,208 normalized nodes
spent about 916 ms in node counting and fingerprint construction, while
normalization itself was sub-millisecond after warmup. Interning structural
fingerprints turns repeated full-subtree serialization into a single bottom-up
pass with compact IDs.

## Current state

- `NormalizedNode` recursively recounts nodes and rebuilds subtree strings:

```ts
src/NormalizedNode.ts:7   nodeCount(): number {
src/NormalizedNode.ts:8     return 1 + this.children.reduce((count, child) => count + child.nodeCount(), 0);
src/NormalizedNode.ts:11   fingerprints(): Set<string> {
src/NormalizedNode.ts:12     const result = new Set<string>();
src/NormalizedNode.ts:13     this.collectFingerprints(result);
src/NormalizedNode.ts:14     return new Set([...result].sort());
src/NormalizedNode.ts:17   private collectFingerprints(result: Set<string>): void {
src/NormalizedNode.ts:18     result.add(this.toFingerprint());
src/NormalizedNode.ts:24   private toFingerprint(): string {
src/NormalizedNode.ts:28     return `(${[this.tag, ...this.children.map((child) => child.toFingerprint())].join(" ")})`;
```

- The normalizer builds a `NormalizedNode` tree recursively:

```ts
src/TypeScriptNormalizer.ts:5 export class TypeScriptNormalizer {
src/TypeScriptNormalizer.ts:6   normalize(node: ts.Node): NormalizedNode {
src/TypeScriptNormalizer.ts:7     const children: NormalizedNode[] = [];
src/TypeScriptNormalizer.ts:11     node.forEachChild((child) => {
src/TypeScriptNormalizer.ts:13         children.push(this.normalize(child));
src/TypeScriptNormalizer.ts:16     return new NormalizedNode(this.tag(node), children);
```

- Entries currently call `nodeCount()` and `fingerprints()` separately:

```ts
src/TypeScriptDuplicateFinder.ts:177   private entry(file: string, node: ts.Node, startLine: number, endLine: number): Entry {
src/TypeScriptDuplicateFinder.ts:178     const normalized = this.normalizer.normalize(node);
src/TypeScriptDuplicateFinder.ts:183       nodes: normalized.nodeCount(),
src/TypeScriptDuplicateFinder.ts:184       fingerprints: normalized.fingerprints(),
```

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Test | `bun run test` | exits 0; all tests pass |
| Full gate | `bun run check` | exits 0; build, tests, and dry4ts scan pass |

## Scope

**In scope**:

- `src/NormalizedNode.ts`
- `src/TypeScriptDuplicateFinder.ts`
- `src/TypeScriptNormalizer.ts` for the memoization in Step 4 and any signature
  adjustments
- `test/dry4ts.test.ts`

**Out of scope**:

- Changing candidate selection.
- Changing similarity math.
- Adding probabilistic hash collisions. The implementation must remain exact
  within a scan.

## Git workflow

- Branch: `advisor/004-intern-fingerprints`.
- Commit message style in this repo is short imperative/prose.
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Introduce an exact fingerprint interner

In `src/NormalizedNode.ts`, add a small `FingerprintInterner` class. It should
assign stable IDs within one scan to structural keys built from a node tag and
its child fingerprint IDs.

Suggested shape:

```ts
export class FingerprintInterner {
  private readonly idsByKey = new Map<string, string>();
  private nextId = 0;

  idFor(tag: string, childIds: readonly string[]): string {
    const key = `${tag}\0${childIds.length}\0${childIds.join("\0")}`;
    const existing = this.idsByKey.get(key);
    if (existing) {
      return existing;
    }
    const id = String(this.nextId++);
    this.idsByKey.set(key, id);
    return id;
  }
}
```

The key always embeds the child arity (`tag\0count\0ids...`), including for
leaves (`tag\00\0`). This prevents ambiguity between a tag that happens to
contain separator bytes and a composite key; do not use the bare tag as a leaf
key.

Use IDs only within one scan. Do not create a new interner for every candidate,
because independent interners can assign the same ID to different structures and
cause false matches.

**Verify**: `bun run test` -> exits 0 if no public calls changed yet; otherwise
continue to Step 2 and verify there.

### Step 2: Compute fingerprints in one bottom-up traversal

Change `NormalizedNode.fingerprints` to require a shared interner:

```ts
fingerprints(interner: FingerprintInterner): Set<string>
```

Implement collection so each node:

- asks children for their fingerprint IDs first
- interns its own `(tag, childIds)` structural key
- adds that compact ID to the result set
- returns its own ID to the parent

Remove `toFingerprint()` if it is no longer needed. Avoid sorting the result set
unless a test truly needs deterministic iteration; similarity uses membership,
not order.

Optionally cache `nodeCount` in the constructor if it stays simple. Do not make
that the main change if it complicates the fingerprint rewrite.

**Verify**: `bun run test` -> exits 0 after Step 3 updates call sites.

### Step 3: Share one interner per scan

In `src/TypeScriptDuplicateFinder.ts`, create one `FingerprintInterner` for the
entry-building operation and pass it into every `entry` call.

Suggested behavior:

- `entriesFor(options)` creates a fresh interner.
- `scan`, `scanFile`, `collectEntries`, and `entry` receive that interner, or a
  small context object carrying it.
- Every candidate in the same scan uses the same interner.
- A later independent CLI invocation or `findClusters` call gets a fresh
  interner.

**Verify**: `bun run test` -> exits 0.

### Step 4: Memoize normalization for nested candidates within a file

Interning fixes the per-node fingerprint cost, but a second quadratic source
remains: `collectEntries` creates an entry for every candidate root, including
nested ones, and each `entry` call normalizes its subtree from the raw
TypeScript AST. A function containing nested functions re-normalizes the
shared inner subtrees once per enclosing candidate.

Fix it with a per-file memo:

- In `scanFile`, create a `Map<ts.Node, NormalizedNode>` for the file being
  scanned.
- Change `TypeScriptNormalizer.normalize` (or wrap it in the finder) so that
  before normalizing a node it checks the memo, and after normalizing it
  stores the result. Because `normalize` recurses through `forEachChild`, a
  memo hit on any subtree short-circuits the whole branch.
- Scope the memo to one file scan; do not let it outlive `scanFile`, or memory
  grows with corpus size and stale `ts.Node` references pin entire ASTs.

If threading the memo through `TypeScriptNormalizer` requires changing its
public constructor or method signatures beyond adding an optional parameter,
keep the memo in the finder and walk candidates outer-to-inner instead. Do not
expand scope beyond the in-scope files.

**Verify**: `bun run test` -> exits 0.

### Step 5: Add regression tests for matching and non-matching structures

Add tests that protect against interner mistakes:

- Two structurally identical snippets with different names/literals still
  cluster.
- Two clearly different snippets do not cluster at a high threshold.
- Running `findClusters` twice with the same `TypeScriptDuplicateFinder`
  instance still returns the same result shape.

Use the existing fixture helpers in `test/dry4ts.test.ts` as the pattern.

**Verify**: `bun run test` -> exits 0.

### Step 6: Run a bounded nested-candidate benchmark

Run a bounded `bun --eval` benchmark similar to this:

- build one deeply nested binary expression
- normalize it
- call `nodeCount()` and `fingerprints(sharedInterner)`
- report elapsed time for depths 100, 200, and 300

Expected result:

- no runaway process
- depth 300 completes comfortably faster than the previous 916 ms observation
- `bun run check` still exits 0

Do not commit benchmark artifacts.

## Test plan

- Existing duplicate-detection tests must continue to pass.
- Add tests for identical and distinct structures to guard against interner ID
  collisions caused by using separate interners per candidate.
- Run `bun run test` and `bun run check`.

## Done criteria

- [ ] `NormalizedNode` no longer recursively serializes full subtree strings for
  every node.
- [ ] One shared exact interner is used for all candidates in a scan.
- [ ] Nested candidate roots within one file reuse memoized subtree
  normalization instead of re-normalizing from the raw TypeScript AST.
- [ ] Similarity behavior remains set-based and exact within the scan.
- [ ] New tests guard against false matches from independent interner IDs.
- [ ] `bun run test` exits 0.
- [ ] `bun run check` exits 0.
- [ ] `plans/README.md` status row for plan 004 is updated.

## STOP conditions

Stop and report back if:

- The implementation would introduce probabilistic hash collisions instead of
  exact interning.
- Sharing the interner across a scan requires broad API changes outside the
  in-scope files.
- Existing duplicate detection tests change expected results.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- The interner is an internal performance detail. Do not expose fingerprint IDs
  in CLI output.
- Interning alone does not remove the nested-candidate re-normalization cost;
  Step 4's memo does. If Step 4 is skipped or deferred, record that in the
  status row so the deep-nesting benchmark expectation is adjusted.
- Fingerprint IDs could be numbers instead of strings (`Set<number>`) for less
  memory; optional, only if it does not complicate the `Entry` type.
- Reviewers should look for the specific bug where each candidate gets a fresh
  interner; that can create false positives because different structures may
  receive the same compact ID.
