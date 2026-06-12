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

Exit codes:

- `0`: command ran successfully and either no duplicates were found or `--fail-on-duplicates` was not set
- `1`: duplicate candidates were found with `--fail-on-duplicates`
- `2`: CLI usage/configuration error — unknown format, invalid or out-of-range option value (e.g. `--threshold` outside `(0, 1]`, `--min-lines` below 1, `--min-nodes` below 1, `--min-locations` below 2)

The JSON output shape is `{ "clusters": ClusterReport[] }`. Each cluster groups all locations that share structural similarity above the threshold, with a `score` range, `locationCount`, and `locations` array. Use `--min-locations N` to only report clusters with at least `N` locations; the default is 2. Each location has `file`, `startLine`, `endLine`, and `nodes`.
