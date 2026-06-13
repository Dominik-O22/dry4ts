# Plan 007: Exclude boilerplate candidate kinds (issue #19)

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. On any "STOP conditions"
> item, stop and report. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 3c3bb77..HEAD -- src/FileScanner.ts src/Options.ts src/TypeScriptDuplicateFinder.ts test/dry4ts.test.ts`
> If any in-scope file changed since this plan was written, reconcile against the
> "Current state" excerpts before proceeding. On a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW-MED (touches the hot scan path and the default candidate set)
- **Depends on**: none (but see "Coordinate with plan 008" — both edit the same gate)
- **Category**: false-positive reduction (detection)
- **Issue**: #19
- **Planned at**: commit `3c3bb77`, 2026-06-14

## Why this matters

The two largest false-positive classes in real scans are dep-only DI
constructors and port/interface member signatures. Both are promoted to
standalone candidate roots by `candidateRootKinds`, so they cluster trivially
across DI-heavy or port-defining code. On the abholer run these drove most of
the 20–22 node noise clusters.

## Current state

`candidateRootKinds` is a hardcoded `const Set` in `src/FileScanner.ts`, and the
candidate gate reads it directly:

```ts
src/FileScanner.ts:62   if (candidateRootKinds.has(node.kind) && hashes.length - rangeStart >= minNodes) {
...
src/FileScanner.ts:115  const candidateRootKinds = new Set<ts.SyntaxKind>([
src/FileScanner.ts:123    ts.SyntaxKind.Constructor,
src/FileScanner.ts:127    ts.SyntaxKind.PropertySignature,
src/FileScanner.ts:128    ts.SyntaxKind.MethodSignature,
src/FileScanner.ts:129    ts.SyntaxKind.CallSignature,
src/FileScanner.ts:130    ts.SyntaxKind.ConstructSignature,
src/FileScanner.ts:131    ts.SyntaxKind.IndexSignature,
...
```

`FileScanner` is not constructed with `Options`; it is called by the finder with
loose params, so a new option must be threaded through:

```ts
src/FileScanner.ts:24   scanFiles(files: readonly string[], minLines: number, minNodes = 1): Entry[]
src/FileScanner.ts:28   scanFile(file: string, minLines: number, minNodes = 1): Entry[]
src/TypeScriptDuplicateFinder.ts:30   const entries = new FileScanner().scanFiles(files, resolvedOptions.minLines, resolvedOptions.minNodes);
```

`Options.parse` is CLI-only (`src/Options.ts:73`); flags are positional fields on
`Options`.

## Design decision (resolve before coding)

The issue proposes shipping the pure *signature* kinds excluded **by default**
(`PropertySignature`, `MethodSignature`, `CallSignature`, `ConstructSignature`,
`IndexSignature`). That changes default output and breaks the repo's standing
"behavior byte-for-byte unchanged unless opted in" rule the sibling issues
follow.

**Recommended**: ship the mechanism opt-in only (no default exclusions) in this
plan. If a default-excluded signature set is wanted, do it as a separate,
explicitly-versioned behavior change with updated cluster-count baselines. The
executor should NOT silently change defaults — STOP and confirm if tempted.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Test | `bun run test` | exits 0 |
| Full gate | `bun run check` | exits 0 |

## Scope

**In scope**: `src/Options.ts`, `src/FileScanner.ts`,
`src/TypeScriptDuplicateFinder.ts`, `src/DryTs.ts` (USAGE), README,
`test/dry4ts.test.ts`.

**Out of scope**: changing default candidate kinds (see Design decision),
similarity/cluster output, the diversity floor (plan 008).

## Git workflow

- Branch: `advisor/007-exclude-kinds`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Parse and validate `--exclude-kinds`

- Add `readonly excludeKinds?: readonly string[]` to `OptionsInput` and a
  positional field on `Options` (append at end; thread through `defaults`,
  `from`, `parse` like `changed`).
- CLI: `--exclude-kinds Constructor,PropertySignature` (comma-split, repeatable).
- Validate each token against `ts.SyntaxKind` **at parse time** and against the
  current `candidateRootKinds` membership — an unknown or non-candidate kind
  should throw `Unknown candidate kind: X` rather than silently no-op (silent
  no-op on a gate flag is a footgun, consistent with the existing
  "unknown option" stance at `src/Options.ts:136`).

**Verify**: `bun run test` -> exits 0.

### Step 2: Thread the resolved kind set into the scanner

- Resolve the string list to a `ReadonlySet<ts.SyntaxKind>` once (in the finder
  or a small helper), not per file.
- Extend `scanFiles`/`scanFile` to accept `excludeKinds: ReadonlySet<ts.SyntaxKind>`
  (default empty set to keep existing callers/tests working).
- In `src/TypeScriptDuplicateFinder.scan`, pass the resolved set through.

**Verify**: `bun run test` -> exits 0.

### Step 3: Gate the candidate push

At `src/FileScanner.ts:62`, add `!excludeKinds.has(node.kind)` to the condition.
Children are still always visited (the recursion at L54 is independent of the
candidate push), so excluding a kind never hides a longer child candidate.

**Verify**: `bun run test` -> exits 0.

### Step 4: Tests

- A file with N identical dep-only constructors yields **no** cluster when
  `--exclude-kinds Constructor` is set, and **does** cluster without the flag.
- A real method/function duplicate is unaffected by excluding `Constructor`.
- An interface-member-signature cluster disappears under
  `--exclude-kinds PropertySignature` but a child method body still clusters.
- `--exclude-kinds NotAKind` errors at parse time.

**Verify**: `bun run check` -> exits 0.

### Step 5: Docs

`--exclude-kinds` in USAGE and README, listing the valid kind names (the members
of `candidateRootKinds`).

**Verify**: `bun run check` -> exits 0.

## Done criteria

- [ ] N identical dep-only constructors yield no cluster when `Constructor`
  excluded; real function duplicates unaffected.
- [ ] Invalid/non-candidate kind names error at parse time.
- [ ] Default behavior is byte-for-byte unchanged with no flag (no default
  exclusions added).
- [ ] `bun run test` and `bun run check` exit 0.
- [ ] `plans/README.md` row for plan 007 updated.

## STOP conditions

- The candidate gate / `candidateRootKinds` no longer match "Current state".
- You find yourself changing default-excluded kinds (confirm first — see Design
  decision).
- A verification command fails twice after a reasonable fix.

## Coordinate with plan 008

Plan 008 (kind-diversity floor) edits the same `src/FileScanner.ts:62` gate.
Land 007 first, then rebase 008, or develop them together. Both add a parameter
threaded through `scanFiles`/`scanFile` — keep one consistent signature (a small
options object may be cleaner than positional params once both land; if you
refactor to that, update plan 008's excerpts).
