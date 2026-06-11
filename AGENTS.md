# Agent Instructions

This repository contains `dry4ts`, a TypeScript/JavaScript duplicate-code candidate finder.

## Commands

- Install dependencies: `bun install`
- Run tests directly from TypeScript sources: `bun run test`
- Build and test: `bun run check`
- Full CI gate: `bun run ci`
- Run the CLI locally after build: `bun ./dist/bin/dry4ts.js src test`

## Agent-Friendly Output

Use JSON output when another tool or agent needs to consume results:

```bash
bun ./dist/bin/dry4ts.js --format json src test
```

Use `--fail-on-duplicates` in CI or autonomous review loops:

```bash
bun ./dist/bin/dry4ts.js --format json --fail-on-duplicates src test
```

Exit codes:

- `0`: command ran successfully and either no duplicates were found or `--fail-on-duplicates` was not set
- `1`: duplicate candidates were found with `--fail-on-duplicates`
- `2`: CLI usage/configuration error, such as an unknown output format
