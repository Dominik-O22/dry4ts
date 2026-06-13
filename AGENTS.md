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
  with `--changed-from`, bad ref) **or** any git/scanner failure. The gate fails
  closed: it never exits `0` or `1` on an error it could not interpret.

The JSON output shape is `{ "clusters": ClusterReport[] }`. Each cluster groups all locations that share structural similarity above the threshold, with a `score` range, a `status` (`"new" | "known" | "unscoped"`), `locationCount`, and `locations` array. Use `--min-locations N` to only report clusters with at least `N` locations; the default is 2. Each location has `file`, `startLine`, `endLine`, and `nodes`. Use `--explain-changed` to dump the resolved changed-region map to stderr when a gate result is surprising.
