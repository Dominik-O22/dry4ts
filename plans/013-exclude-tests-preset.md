# Plan 013: `--exclude-tests` test-path preset

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. On any "STOP conditions"
> item, stop and report. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 172cd0e..HEAD -- src/Options.ts src/TypeScriptDuplicateFinder.ts src/DryTs.ts test/dry-ts.test.ts`
> If any in-scope file changed since this plan was written, reconcile against the
> "Current state" excerpts before proceeding. On a mismatch, STOP.

## Status

- **Status**: DONE (executed 2026-06-14 on `advisor/013-exclude-tests` off main;
  opt-in `--exclude-tests` curated preset merged into the `--exclude` glob list at
  `TypeScriptDuplicateFinder.sourceFiles`, no scan/gate change; exported
  `TEST_EXCLUDE_GLOBS`; 5 tests incl. compose/off-path/explicit-file; one
  `// dry-ignore` on an intentional twin test scaffold to keep the self-scan
  green; `bun run check` green at 138 pass; n8n `cli/src` 1650 → 300 clusters
  under the flag, off-path byte-for-byte unchanged)
- **Priority**: P1 (highest-ROI false-positive reducer measured on both corpora)
- **Effort**: XS-S
- **Risk**: LOW (pure source-file filter preset over the existing `--exclude`
  matcher; no scan/gate/normalization change; off-path byte-for-byte unchanged)
- **Depends on**: none. Builds on the shipped `--exclude GLOB` machinery
  (`TypeScriptDuplicateFinder.ts:123`/`:147`). n8n bench corpus (PR #40) is a
  soft dependency — only used to reproduce the validation number below.
- **Category**: false-positive reduction (file selection)
- **Planned at**: commit `172cd0e`, 2026-06-14

## Why this matters

Test files are the single largest false-positive class in real scans, on **both**
ends of the stack:

- n8n `cli/src` backend (PR #40 corpus): test files are **82%** of clusters
  (1350/1650). `--exclude '**/*.test.ts' '**/*.spec.ts' '**/__tests__/**'` alone
  takes 1650 → **300** clusters. 87% of those test clusters are *intra-file*
  table-driven `it()` cases — identical ARRANGE/ACT/ASSERT shape differing only
  in data.
- Sentry `static/app` frontend: ~49% of remaining FPs are test files
  (see memory `sentry-fp-class-breakdown`).

Today users must hand-write the glob set and get every test convention right
(`.test.`, `.spec.`, `__tests__/`, `__mocks__/`, e2e). `--exclude-tests` packages
the curated set behind one flag.

**Why opt-in, not a default exclusion (design stance, do not change without
confirming):** the table-driven repetition that dominates the test FP count is
*correct by design* — test bodies should be DAMP (Descriptive And Meaningful
Phrases) over DRY; readability and failure-localization beat de-duplication, and
table-driven cases are the sanctioned form. What *is* worth catching in tests is
**test infrastructure** dup — builders, factories, custom matchers, shared setup
that drifted. A blanket default-exclude would hide that real signal **and**
contradict this repo's own practice of keeping its tests DRY. So this flag is an
opt-in convenience for callers who want to focus a run on `src` duplication; the
default keeps scanning tests. This matches the standing "behavior byte-for-byte
unchanged unless opted in" rule every reducer 006–034 follows.

## Current state

`--exclude` is already a repeatable glob list threaded as a positional field and
consumed by a gitignore-semantics matcher during the directory walk:

```ts
src/Options.ts:20    readonly exclude?: readonly string[];          // OptionsInput
src/Options.ts:41    public readonly exclude: readonly string[] = [], // Options ctor
src/Options.ts:93    input.exclude ?? [],                            // Options.from
src/Options.ts:132   case "--exclude": { ... exclude.push(glob); }   // parse
```

```ts
src/TypeScriptDuplicateFinder.ts:123  options.exclude.length > 0 ? this.globMatcher(options.exclude) : null,
src/TypeScriptDuplicateFinder.ts:147  const matcher = ignore().add(globs.join("\n"));
```

`excludeTaggedTemplates` (plan 034) is the closest precedent for a boolean reducer
flag: a positional boolean field on `Options`/`OptionsInput`, set by a no-arg CLI
case, defaulted off, documented in USAGE + README. Mirror that shape.

Notes that constrain the implementation:
- The `ignore` library uses **gitignore** semantics — **no brace expansion**.
  Do **not** write `{ts,tsx}`. Use `*` for the extension: `**/*.test.*` covers
  `.test.ts/.test.tsx/.test.mts/.test.js`. (README already models this with the
  `--exclude '**/*.spec.*'` example.)
- Per existing `--exclude` semantics (README): the matcher applies during
  **directory scans** and regardless of `--no-gitignore`; **explicit file
  arguments are always scanned**. `--exclude-tests` must follow the same rule —
  it filters the directory walk only, never an explicitly-named file.

## Design decision (resolve before coding)

**The preset glob set.** Ship a high-precision set — unambiguous test markers
only — so the preset never silently drops `src`:

```
**/*.test.*
**/*.spec.*
**/*.e2e-spec.*
**/__tests__/**
**/__mocks__/**
```

Bare directory names `test/`, `tests/`, `e2e/` are **intentionally excluded** from
the preset: too many projects use those for non-test code, and a preset that
hides `src` on a false hit is worse than one a user extends. Document that callers
wanting those add them with `--exclude '**/test/**'`. If the executor disagrees,
STOP and confirm — do not quietly widen the preset.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Test | `bun run test` | exits 0 |
| Full gate | `bun run check` | exits 0 |
| Corpus check (optional) | `bun run bench:setup n8n && bun ./dist/bin/dry-ts.js --no-gitignore --exclude-tests .bench/n8n/packages/cli/src \| grep -c '^'` | ≈300-cluster regime (vs 1650 without) |

## Scope

**In scope**: `src/Options.ts`, `src/TypeScriptDuplicateFinder.ts`, `src/DryTs.ts`
(USAGE), `README.md`, `test/dry-ts.test.ts`.

**Out of scope**: changing default behavior (preset is opt-in), the candidate
gate / `--exclude-kinds` / diversity floor, distinguishing test-infra dup from
scenario dup (a future heuristic, not this plan), bare `test/`/`tests/`/`e2e/`
dir globs (see Design decision).

## Git workflow

- Branch: `advisor/013-exclude-tests`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add the `excludeTests` flag

- Add `readonly excludeTests?: boolean` to `OptionsInput` and a positional
  boolean field on `Options` (append at end; thread through `defaults`, `from`,
  `parse` exactly like `excludeTaggedTemplates`).
- CLI: a no-arg `case "--exclude-tests": excludeTests = true; break;` in
  `Options.parse`.

**Verify**: `bun run test` → exits 0.

### Step 2: Merge the preset into the exclude matcher

- Define and export `const TEST_EXCLUDE_GLOBS: readonly string[]` (the five globs
  above) near `globMatcher` in `src/TypeScriptDuplicateFinder.ts`.
- Where the matcher is built (around `:123`), when `resolvedOptions.excludeTests`
  is set, build the matcher from `[...options.exclude, ...TEST_EXCLUDE_GLOBS]`
  instead of `options.exclude`. Keep the no-glob fast path (`null` matcher) only
  when both the explicit list is empty **and** `excludeTests` is false.
- Do not touch `FileScanner` — this is a file-selection change, not a candidate
  change.

**Verify**: `bun run test` → exits 0.

### Step 3: Tests (`test/dry-ts.test.ts`)

- A duplicate pair in `foo.test.ts` is **not** reported under `--exclude-tests`;
  the same pair in `foo.ts` (non-test) **is** still reported.
- A duplicate under `__tests__/` is excluded; a sibling under `src/` is not.
- `--exclude-tests` **composes** with `--exclude` (union of globs; a custom
  `--exclude` glob and the preset both apply).
- Off path: with no flag, a test-file duplicate is still reported (default
  unchanged).
- Explicit-file rule: passing a test file **as an explicit path argument** still
  scans it even with `--exclude-tests` (parity with `--exclude`).

**Verify**: `bun run check` → exits 0.

### Step 4: Docs

- USAGE block in `src/DryTs.ts`: add `--exclude-tests` with the one-line
  description and the exact preset globs (so the help is the source of truth).
- README: document the flag next to `--exclude`; list the five globs; state that
  it is opt-in / off by default / output byte-for-byte unchanged when off; and
  note the DAMP-vs-DRY rationale in one sentence (tests are excluded for focus,
  not because test dup never matters — test *infrastructure* dup is still worth a
  dedicated scan).

**Verify**: `bun run check` → exits 0.

## Done criteria

- [ ] `--exclude-tests` drops `*.test.*` / `*.spec.*` / `*.e2e-spec.*` /
  `__tests__/**` / `__mocks__/**` during directory scans; `src` files unaffected.
- [ ] Composes with `--exclude`; explicit test-file path args still scanned.
- [ ] Default behavior byte-for-byte unchanged with no flag.
- [ ] `bun run test` and `bun run check` exit 0.
- [ ] (Optional) n8n `cli/src` reproduces the ~300-cluster regime under the flag.
- [ ] `plans/README.md` row for plan 013 updated.

## STOP conditions

- `--exclude` wiring (`Options.ts:132`, `TypeScriptDuplicateFinder.ts:123/147`)
  no longer matches "Current state".
- You find yourself making the preset a **default** exclusion, or widening it to
  bare `test/`/`tests/`/`e2e/` dirs (confirm first — see Design decision).
- A verification command fails twice after a reasonable fix.
