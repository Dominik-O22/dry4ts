# Agent Instructions

This repository contains `dry-ts`, a TypeScript/JavaScript duplicate-code candidate finder.

## Commands

- Install dependencies: `bun install`
- Run tests directly from TypeScript sources: `bun run test`
- Build, test, and self-scan: `bun run check`
- Full CI gate: `bun run ci`
- Run the CLI locally after build: `bun ./dist/bin/dry-ts.js src test`

## Agent-Friendly Output

Use JSON output when another tool or agent needs to consume results:

```bash
bun ./dist/bin/dry-ts.js --format json src test
```

Use `--fail-on-duplicates` in CI or autonomous review loops:

```bash
bun ./dist/bin/dry-ts.js --format json --fail-on-duplicates src test
```

By default, directory scans skip files and directories matched by `.gitignore`. Pass `--no-gitignore` to include everything:

```bash
bun ./dist/bin/dry-ts.js --format json --no-gitignore src test
```

## Committed Config: `.dry-ts.json`

A `.dry-ts.json` in the working directory sets a committed baseline so a repo's
scan policy lives in one file instead of a flag list every run. dry-ts reads it
automatically; precedence is **explicit CLI flag > `--profile` > `.dry-ts.json` >
built-in default**, so a flag you pass for one run still wins. It accepts the
persistable options (`threshold`, `minNodes`, `excludeKinds`, `excludeTests`,
`exclude`/`ignore` globs, …) but **not** the run-scoped `--changed-from`,
`--changed`, `--only-new`, or the diagnostic `--explain-changed` — those describe
one invocation, not a baseline.

A broken or present-but-unreadable config (bad JSON, unknown key, wrong type, a
directory, a permission error) fails the run loud at exit `2`, naming the file —
it never silently scans with the wrong policy. Only a genuinely absent file is a
no-op. See the README "Config file" section for the full key list.

**Gate sharp edge.** A committed `paths`, `exclude`/`ignore`, `respectGitignore`,
`excludeTests`, `excludeTaggedTemplates`, `excludeKinds`, or a `threshold`/numeric
floor changes *what* `--fail-on-duplicates` gates against — a committed `exclude`
or higher `minNodes` can shrink the gate so a
real duplicate slips through and the gate exits `0`. To keep that from being
silent, under `--fail-on-duplicates` dry-ts prints the config-derived gate inputs
to stderr (`.dry-ts.json shapes this --fail-on-duplicates run: …`), like the
`--only-new` totals line. Keep a CI-gating config narrow, and read that note.

## Self-Correcting Edit Loop

After editing, gate only on duplication *your edit* introduced instead of the
whole codebase. Each cluster reports a `status`; a finding is `status: "new"`.

```bash
# After editing foo.ts and bar.ts:
bun ./dist/bin/dry-ts.js --format json --fail-on-duplicates --changed foo.ts --changed bar.ts src
```

If this exits `1`, inspect the clusters with `status: "new"` and refactor them
(extract a shared helper), then re-run until it exits `0`.

`--changed FILE` scopes the **whole file**, including any pre-existing
duplication already in it — so a `new` finding can point at a copy you did not
just write. If you commit before gating and want line-level precision, prefer
`--changed-from`:

```bash
bun ./dist/bin/dry-ts.js --format json --fail-on-duplicates --changed-from HEAD src   # uncommitted edits
bun ./dist/bin/dry-ts.js --format json --fail-on-duplicates --changed-from HEAD~1 src # after one commit
```

Findings are worded "intersects your change", never "you created this": the
counterpart of a `new` cluster may be old code you copied from.

`--profile agent` bundles this whole loop into one flag: it expands to the `pr`
gate plus `--counterparts --format json --demote-boilerplate`, so it gates on
`status: "new"`, hands you each finding's nearest existing match to route the
fix, and sinks work-free clusters (the classic DI constructor that only wires
fields) below real candidates so you read the likely-real duplicates first. It
inherits `pr`'s `--only-new`, so it still needs a `--changed-from`/`--changed`
scope and fails loud (exit `2`) without one:

```bash
bun ./dist/bin/dry-ts.js --profile agent --changed-from HEAD src   # uncommitted edits
```

Without a `--changed`/`--changed-from` flag, `--fail-on-duplicates` is
zero-tolerance and every cluster reports `status: "unscoped"` — so a build can
exit `1` while no cluster says `"new"`. Read the exit code, not just `status`,
when no changed-scope is active.

Exit codes:

- `0`: success — no findings, or `--fail-on-duplicates` was not set
- `1`: findings with `--fail-on-duplicates` (clusters with `status: "new"` under
  a changed-scope; any cluster otherwise)
- `2`: usage/configuration error (unknown flag/format, out-of-range value, both
  scope flags, an ungateable `--changed` file under the gate, not a git repo
  with `--changed-from`, bad ref, a broken or unreadable `.dry-ts.json`) **or**
  any git/scanner failure. The gate fails closed: it never exits `0` or `1` on an
  error it could not interpret.

The JSON output shape is `{ "clusters": ClusterReport[] }`. Each cluster groups all locations that share structural similarity above the threshold, with a `score` range, a `status` (`"new" | "known" | "unscoped"`), `locationCount`, and `locations` array. Use `--min-locations N` to only report clusters with at least `N` locations; the default is 2. Each location has `file`, `startLine`, `endLine`, and `nodes`. Use `--explain-changed` to dump the resolved changed-region map to stderr when a gate result is surprising.
