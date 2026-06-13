# Plan 006: `--only-new` output filter (issue #24)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP conditions" item occurs, stop and report; do not improvise. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 3c3bb77..HEAD -- src/DryTs.ts src/Options.ts test/dry4ts.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Status**: DONE (branch `advisor/006-only-new`, 2026-06-14; `bun run check`
  green at 103 pass / no duplicate clusters)
- **Priority**: P1 (highest ROI of the false-positive-reduction set)
- **Effort**: XS
- **Risk**: LOW
- **Depends on**: none
- **Category**: reporting (orthogonal to detection)
- **Issue**: #24
- **Planned at**: commit `3c3bb77`, 2026-06-14

## Why this matters

`--changed-from`/`--changed` already classify clusters as `new`/`known`/
`unscoped`, and `--fail-on-duplicates` fails on `new` only. But the report still
prints every cluster. Real CI run: 6 `new` + 73 `known` — the actionable 6 are
buried. This is a pure output filter; detection and exit code are unchanged.

## Current state

`run` in `src/DryTs.ts` builds `reported`, prints all of it, then derives the
exit code:

```ts
src/DryTs.ts:72   const reported: Cluster[] = clusters.map((cluster) => ({
src/DryTs.ts:73     ...cluster,
src/DryTs.ts:74     status: scope ? statusFor(cluster, scope) : "unscoped",
src/DryTs.ts:75   }));
src/DryTs.ts:77   switch (options.format) {
src/DryTs.ts:78     case "edn":  console.log(toEdn(reported)); break;
src/DryTs.ts:79     case "json": console.log(toJson(reported)); break;
src/DryTs.ts:80     case "text": printText(reported); break;
src/DryTs.ts:81   }
src/DryTs.ts:89   const failing = scope ? reported.some((c) => c.status === "new") : reported.length > 0;
```

`Options` has no `onlyNew` field yet. `changedFrom`/`changed` already exist
(`src/Options.ts:29-31`). The constructor already throws on the
`--changed-from`+`--changed` combination (`src/Options.ts:45`), so it is the
right place for the "requires a change scope" guard.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Test | `bun run test` | exits 0 |
| Full gate | `bun run check` | exits 0 |

## Scope

**In scope**: `src/Options.ts`, `src/DryTs.ts`, `test/dry4ts.test.ts`, README
usage section.

**Out of scope**: detection, scoring, status assignment, exit-code semantics.

## Git workflow

- Branch: `advisor/006-only-new`.
- Short imperative commit messages. Do not push or open a PR unless instructed.

## Steps

### Step 1: Add `onlyNew` to Options

- Add `readonly onlyNew?: boolean` to `OptionsInput`.
- Add a `public readonly onlyNew: boolean = false` constructor param (append at
  the end to avoid disturbing positional callers; thread it through
  `defaults()`, `from()`, and `parse()` the same way `explainChanged` is).
- Parse `--only-new` in `parse` (set `onlyNew = true`).
- In the constructor, add the guard:

```ts
if (onlyNew && changedFrom === undefined && changed.length === 0) {
  throw new Error("--only-new requires --changed-from or --changed");
}
```

**Verify**: `bun run test` -> exits 0.

### Step 2: Filter output in run(), keep exit code on the full set

In `src/DryTs.ts` `run`, after building `reported`:

- Compute `failing` from the **full** `reported` (unchanged) — exit code must
  not depend on `onlyNew`.
- Compute the visible set:
  `const visible = options.onlyNew ? reported.filter((c) => c.status === "new") : reported;`
- Pass `visible` to `toEdn`/`toJson`/`printText`.
- When `options.onlyNew`, print a summary to **stderr** (not stdout — stdout
  must stay valid json/edn):
  `console.error(\`showing ${visible.length} new (${reported.length - visible.length} known hidden)\`);`

`onlyNew` can only be true when a `scope` is active (constructor guard), so
`status` is always `new`/`known` here, never `unscoped`.

**Verify**: `bun run test` -> exits 0.

### Step 3: Tests

Add to `test/dry4ts.test.ts`:

- `--only-new` with `--changed`/`--changed-from`: text/json/edn outputs contain
  only `new` clusters; `known` omitted.
- Exit code unchanged: a run with `new` clusters hidden-or-not still exits 1
  under `--fail-on-duplicates`; a run with only `known` clusters still exits 0.
- `--only-new` without any change scope: throws/exits 2 with the clear message.
- Summary line appears on stderr with correct totals.

**Verify**: `bun run check` -> exits 0.

### Step 4: Docs

Add `--only-new` to the `USAGE` block in `src/DryTs.ts` and to README options.
Note it requires `--changed-from`/`--changed` and is output-only.

**Verify**: `bun run check` -> exits 0.

## Done criteria

- [ ] `--only-new` restricts reported clusters to `status == new` across text,
  json, and edn.
- [ ] Used without a change scope: clear error, exit 2.
- [ ] Exit code still governed by `--fail-on-duplicates` over `new` clusters,
  regardless of what is printed.
- [ ] Summary line (`showing N new (M known hidden)`) on stderr.
- [ ] `bun run test` and `bun run check` exit 0.
- [ ] `plans/README.md` row for plan 006 updated.

## STOP conditions

- The `run` reporting structure no longer matches "Current state".
- Making the filter would change exit-code semantics.
- A verification command fails twice after a reasonable fix.

## Maintenance notes

- Keep this output-only. Do not let `--only-new` influence detection, scoring,
  or status assignment.
