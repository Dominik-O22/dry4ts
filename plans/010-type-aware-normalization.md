# Plan 010: Optional type-identifier-aware normalization (issue #21)

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result. On any "STOP conditions" item, stop and
> report. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 3c3bb77..HEAD -- src/TypeScriptNormalizer.ts src/FileScanner.ts src/Options.ts test/dry4ts.test.ts`
> Reconcile against "Current state" before proceeding. On a mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (touches the fingerprint core; the off path must be provably
  unchanged)
- **Depends on**: none functionally; land after 007/008 so the FP-reduction flag
  surface is settled
- **Category**: false-positive reduction (detection)
- **Issue**: #21
- **Planned at**: commit `3c3bb77`, 2026-06-14

## Naming (codex second-opinion, 2026-06-14)

`--type-aware` is a misnomer: keeping `TypeReference` names is **syntax**-aware,
not type-aware. Real type awareness means a TS checker/program, module
resolution, aliases. Users would expect `{ a: UserId }` aliases and imported
types to behave semantically. **Recommended**: name the flag
`--keep-type-reference-names` (or similar explicitly-syntactic name). Do NOT
ship it as `--type-aware`. Adjust all references below accordingly.

## Why this matters

`isName`/`keepsStructuralChild` strip **all** identifiers, so two unrelated DTOs
with the same shape but different field/type names match. That name-blindness is
the correct default (it catches copy-paste-then-rename), but it is a frequent
false positive for distinct domain types that merely share a shape. An opt-in
mode that retains type-position identifiers as structural markers splits
`{a: Foo; b: Bar}` from `{a: Baz; b: Qux}` while leaving the default intact.

## Current state

The normalizer drops all identifiers and emits structural markers via
`markers()`. The fingerprint walk in `FileScanner` calls `keepsStructuralChild`,
`markers`, and `tag` — it must stay in lockstep with the normalizer:

```ts
src/TypeScriptNormalizer.ts:33   keepsStructuralChild(child: ts.Node): boolean {
src/TypeScriptNormalizer.ts:34     return !this.isName(child) && !this.isLiteral(child) && child.kind !== ts.SyntaxKind.JSDocComment;
src/TypeScriptNormalizer.ts:37   private isName(node: ts.Node): boolean {
src/TypeScriptNormalizer.ts:38     return ts.isIdentifier(node) || node.kind === ts.SyntaxKind.PrivateIdentifier;
src/TypeScriptNormalizer.ts:54   markers(node: ts.Node): string[] {        // sorted, fed into the hash
```

```ts
src/FileScanner.ts:20   private readonly normalizer = new TypeScriptNormalizer();
src/FileScanner.ts:49   for (const marker of this.normalizer.markers(node)) { ... }
src/FileScanner.ts:54   node.forEachChild((child) => { if (this.normalizer.keepsStructuralChild(child)) ... });
src/FileScanner.ts:59   const hash = this.interner.idFor(this.normalizer.tag(node), childHashes);
```

`FileScanner` constructs the normalizer with no args (`src/FileScanner.ts:20`),
so the mode must be passed into the scanner and then into the normalizer.

## Approach

Emit type-position identifiers as **markers** rather than keeping them as
structural children — markers already participate in the fingerprint and are
sorted, so this rides the existing mechanism without restructuring the child
walk. Specifically, when the mode is on, add a marker like
`typeref:<name>` for `TypeReference.typeName` identifiers (and optionally a
`propname:<name>` marker for property names, behind the same flag — recommend
type names first, property names as a documented sub-option or follow-up).

The key invariant: **with the flag off, `markers()`/`keepsStructuralChild`/`tag`
produce byte-for-byte identical output to today**, so fingerprints are
unchanged. Add the new markers only inside an `if (this.typeAware)` branch.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Test | `bun run test` | exits 0 |
| Full gate | `bun run check` | exits 0 |

## Scope

**In scope**: `src/TypeScriptNormalizer.ts`, `src/FileScanner.ts`,
`src/Options.ts`, `src/TypeScriptDuplicateFinder.ts`, `src/DryTs.ts` (USAGE),
README, `test/dry4ts.test.ts`.

**Out of scope**: changing the default (must stay name-blind), value-literal
retention, kind exclusion/diversity (plans 007/008).

## Git workflow

- Branch: `advisor/010-type-aware`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add `--type-aware` to Options and thread it through

- Add a boolean `typeAware` (off by default) to `OptionsInput`/`Options`/`parse`.
- Thread it into `TypeScriptDuplicateFinder.scan` → `FileScanner` constructor (or
  `scanFiles`) → `new TypeScriptNormalizer(typeAware)`.

**Verify**: `bun run test` -> exits 0.

### Step 2: Emit type-position markers when on

- Add a constructor flag to `TypeScriptNormalizer`.
- In `markers()` (or `addTypeScriptShapeMarkers`), when `typeAware`, push a
  `typeref:<typeName text>` marker for `ts.isTypeReferenceNode(node)` using
  `node.typeName.getText()` or the identifier escapedText (avoid `getText` if the
  source file isn't retained — confirm what is available at marker time; the node
  has the identifier child, read `escapedText`).
- Keep markers sorted (the method already sorts at the end).

**Verify**: `bun run test` -> exits 0.

### Step 3: Off-path invariance test (critical)

Add a test that scans a fixture corpus with the flag **off** and asserts the
resulting clusters are identical to a snapshot of current behavior — this is the
guard the issue's acceptance criterion ("byte-for-byte unchanged") demands.

**Verify**: `bun run test` -> exits 0.

### Step 4: On-path behavior tests

- With `--type-aware`, two same-shaped/different-typed interfaces drop below
  threshold (no cluster).
- A genuine copy-paste-then-rename of the **same** types still clusters with the
  flag on.

**Verify**: `bun run check` -> exits 0.

### Step 5: Docs

`--type-aware` in USAGE and README; explain it trades recall (catches fewer
renamed clones) for precision (splits same-shape distinct types), default off.

**Verify**: `bun run check` -> exits 0.

## Done criteria

- [ ] Flag on: same-shape/different-typed interfaces diverge below threshold.
- [ ] Flag off: clusters byte-for-byte identical to current (snapshot test).
- [ ] `markers()` stays sorted; fingerprint walk unchanged on the off path.
- [ ] `bun run test` and `bun run check` exit 0.
- [ ] `plans/README.md` row for plan 010 updated.

## STOP conditions

- Normalizer or fingerprint walk no longer matches "Current state".
- The off-path snapshot test shows ANY cluster difference — the change leaked
  into the default. STOP and isolate.
- Type-name text is not reliably reachable at marker time without re-parsing.
- A verification command fails twice after a reasonable fix.

## Maintenance notes

- `FileScanner` and `TypeScriptNormalizer` must agree on what is kept vs marked;
  any change here is mirrored in both. The off path is sacred — never let a new
  marker fire without the flag.
