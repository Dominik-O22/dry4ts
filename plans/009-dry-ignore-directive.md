# Plan 009: Inline `// dry-ignore` suppression directive (issue #22)

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result. On any "STOP conditions" item, stop and
> report. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 3c3bb77..HEAD -- src/FileScanner.ts test/dry4ts.test.ts`
> Reconcile against "Current state" before proceeding. On a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (independent of 007/008; minor merge friction in
  `FileScanner.scanFile` if developed concurrently)
- **Category**: false-positive reduction (source-level escape hatch)
- **Issue**: #22
- **Planned at**: commit `3c3bb77`, 2026-06-14

## Why this matters

There is no way to suppress an intentional, idiomatic repetition at the source.
The only escape hatch today is excluding the whole file via `.gitignore`, which
is too coarse — it hides real duplicates elsewhere in the same file. An
eslint-disable-style inline directive gives per-occurrence control.

## Current state

`scanFile` already has the raw `text` and parses without setting parent pointers
(`setParentNodes = false`), and pushes a candidate at the gate:

```ts
src/FileScanner.ts:29   const text = fs.readFileSync(file, "utf8");
src/FileScanner.ts:30   const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
...
src/FileScanner.ts:62   if (candidateRootKinds.has(node.kind) && hashes.length - rangeStart >= minNodes) {
src/FileScanner.ts:63     const { startLine, endLine } = lineRangeFor(sourceFile, node);
src/FileScanner.ts:64     if (endLine - startLine + 1 >= minLines) {
src/FileScanner.ts:65       entries.push({ order, entry: { ... } });
```

`forEachChild` skips comment trivia, so the directive must be read from `text`
via `ts.getLeadingCommentRanges(text, node.getFullStart())`. No second parse.

## Directive forms (start minimal)

- `// dry-ignore` and `// dry-ignore-next-line` on the line(s) immediately
  preceding a candidate node (or its enclosing statement) suppress that
  candidate. Match block comments too (`/* dry-ignore */`).
- Defer `dry-ignore-file` banner to a follow-up.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Test | `bun run test` | exits 0 |
| Full gate | `bun run check` | exits 0 |

## Scope

**In scope**: `src/FileScanner.ts`, README, `test/dry4ts.test.ts`.

**Out of scope**: `dry-ignore-file`, config-level ignores (plan 011),
kind-level exclusion (plan 007).

## Git workflow

- Branch: `advisor/009-dry-ignore`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Read leading comments at the candidate gate

In the candidate branch (`src/FileScanner.ts:62`), before pushing the entry,
read `ts.getLeadingCommentRanges(text, node.getFullStart())`. For each range,
slice `text.substring(range.pos, range.end)`, strip the comment markers, trim,
and test for the directive token. Skip the push when a directive is present.

Edge cases to handle deterministically:
- A candidate and its enclosing statement can both be candidate roots (e.g. a
  `VariableStatement` wrapping an `ArrowFunction`). Decide and document: a
  directive on the statement suppresses the statement candidate; whether it also
  suppresses the nested arrow should be explicit. **Recommended**: suppress only
  the node whose leading trivia carries the directive; document that users put
  the comment on the specific declaration they mean. Add a test pinning this.
- `getFullStart()` includes leading trivia of the node; for a node preceded by
  other tokens on the same construct, confirm the comment resolves to the
  intended node in the test fixtures.

**Verify**: `bun run test` -> exits 0.

### Step 2: Keep recursion intact

Suppression skips only the **entry push**, not the `visit` recursion — a
suppressed parent must not hide unrelated child candidates. The recursion at
`src/FileScanner.ts:54` is already independent of the push; confirm the skip is
scoped to the `entries.push` only.

**Verify**: `bun run test` -> exits 0.

### Step 3: Tests

- A duplicated block annotated with `// dry-ignore` is excluded from clusters;
  removing the comment restores the finding.
- An unannotated duplicate in the **same file** is still reported.
- `/* dry-ignore */` block-comment form works.
- A directive on one of two duplicate occurrences suppresses only that one (the
  pair drops below `minLocations` and the cluster disappears, or the remaining
  occurrence has no partner — assert the resulting cluster set).

**Verify**: `bun run check` -> exits 0.

### Step 4: Docs

Document `// dry-ignore` / `// dry-ignore-next-line` in README with the
placement rule decided in Step 1.

**Verify**: `bun run check` -> exits 0.

## Done criteria

- [ ] `// dry-ignore` excludes the annotated candidate; removal restores it.
- [ ] Unannotated duplicates in the same file still reported.
- [ ] Placement/scoping rule documented and pinned by a test.
- [ ] No second parse; directive read from existing `text`.
- [ ] `bun run test` and `bun run check` exit 0.
- [ ] `plans/README.md` row for plan 009 updated.

## STOP conditions

- `scanFile` parse/gate no longer matches "Current state".
- `getLeadingCommentRanges` cannot reliably attribute a comment to the intended
  candidate without parent pointers — if so, report the ambiguity rather than
  shipping a flaky rule.
- A verification command fails twice after a reasonable fix.

## Maintenance notes

- Keep to the two directive forms. A `dry-ignore-file` banner and config-glob
  ignores (plan 011) are deliberately separate.
