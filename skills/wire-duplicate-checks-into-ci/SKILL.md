---
name: wire-duplicate-checks-into-ci
description: >
  Use dry-ts as a CI or automated review gate with --format json and --fail-on-duplicates. Load when writing GitHub Actions, gating a PR only on new duplication with --changed-from, parsing cluster JSON status, or handling dry-ts exit codes 0, 1, and 2.
type: core
library: dry-ts
library_version: "0.14.0"
sources:
  - "dry-ts:README.md"
  - "dry-ts:AGENTS.md"
  - "dry-ts:src/DryTs.ts"
  - "dry-ts:src/Options.ts"
  - "dry-ts:src/Config.ts"
  - "dry-ts:.github/workflows/ci.yml"
---

# dry-ts - Wire Duplicate Checks Into CI

## Setup

Gate a PR only when it introduces *new* duplication, tolerating known debt:

```yaml
name: Duplicate Code

on: [push, pull_request]

jobs:
  dry-ts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # merge-base needs history; the default shallow checkout breaks it.
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.6
      - run: bunx dry-ts --format json --fail-on-duplicates --changed-from origin/${{ github.base_ref || 'main' }} src test
```

To gate on *all* duplication (zero-tolerance) instead, drop `--changed-from`:
`bunx dry-ts --format json --fail-on-duplicates src test`.

## Core Patterns

### Gate only on new duplication (recommended)

```bash
bunx dry-ts --format json --fail-on-duplicates --changed-from origin/main src test
```

A cluster is a finding (`status: "new"`) when one of its locations intersects
code changed since `merge-base(origin/main, HEAD)`. Pre-existing duplication
stays `status: "known"` and never fails the build, so the gate only goes red
when the change makes the codebase wetter. Use this for PRs.

### Fail on all duplication (zero-tolerance)

```bash
bunx dry-ts --format json --fail-on-duplicates src test
```

With no changed-scope flag, `--fail-on-duplicates` turns *any* cluster into exit
code `1` and every cluster reports `status: "unscoped"`. Read the exit code, not
`status`, in this mode.

### Report only new clusters in PR output

```bash
bunx dry-ts --format json --fail-on-duplicates --changed-from origin/main --only-new src test
```

`--only-new` filters the *report* down to `status: "new"` clusters, so a PR
comment or annotation shows only the duplication the change introduced, not the
full known-debt list. It requires `--changed-from`/`--changed` and is an output
filter only: the exit code is unchanged (still `1` when new clusters exist), and
the suppressed-cluster totals go to stderr so nothing is silently lost.

### Commit the gate policy in `.dry-ts.json`

```json
{
  "paths": ["src", "test"],
  "excludeTests": true,
  "minNodes": 50,
  "excludeKinds": ["ArrowFunction", "VariableStatement"],
  "ignore": ["**/*.gen.ts"]
}
```

A `.dry-ts.json` in the repo root sets a committed baseline so the CI command
stays one line (`bunx dry-ts --fail-on-duplicates --changed-from origin/main`)
instead of carrying the whole flag list. Precedence is **explicit CLI flag >
`--profile` > `.dry-ts.json` > built-in default**, and list options
(`excludeKinds`, `exclude`/`ignore`) union across layers. The run-scoped
`--changed-from`/`--changed`/`--only-new` are CLI-only — keep them on the command.
A broken or unreadable config (bad JSON, unknown key, wrong type, a directory, a
permission error) fails the run loud at exit `2` naming the file; only an absent
file is a no-op. Persistable keys: `threshold`, `minLines`, `minNodes`,
`minLocations`, `minDistinctKinds`, `format`, `failOnDuplicates`,
`respectGitignore`, `excludeKinds`, `exclude`/`ignore`, `excludeTaggedTemplates`,
`excludeTests`, `counterparts`, `paths`.

**Gate sharp edge — a committed config can narrow the gate.** A committed
`paths`, `exclude`/`ignore`, `respectGitignore`, `excludeTests`,
`excludeTaggedTemplates`, `excludeKinds`, or a `threshold`/numeric floor changes
*what* `--fail-on-duplicates` sees: a too-broad `exclude` or a high
`minNodes` can shrink the scan so a real duplicate slips through and the gate
exits `0`. To keep that from being silent, under `--fail-on-duplicates` dry-ts
prints the config-derived gate inputs to stderr
(`.dry-ts.json shapes this --fail-on-duplicates run: …`), like the `--only-new`
totals line. Keep a CI-gating config narrow, and surface that stderr note in CI
logs.

### Emit JSON for agent consumers

```bash
bunx dry-ts --format json src test
```

JSON output is stable and small: `{ "clusters": ClusterReport[] }`.

### Upload SARIF to GitHub code scanning

```yaml
      - run: bunx dry-ts --sarif --changed-from origin/${{ github.base_ref || 'main' }} src > dry-ts.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: dry-ts.sarif
```

`--format sarif` (alias `--sarif`) emits SARIF 2.1.0 so findings surface inline
on the PR via code scanning. One `result` per cluster under the rule
`dry-ts/structural-duplicate`; a cluster's `level` follows its status (`new` →
`warning`, `known`/`unscoped` → `note`), and `--counterparts` nearest data lands
in `relatedLocations`. Findings are framed as structural *candidates*. Drop
`--fail-on-duplicates` (omitted above) if you want the annotations without
failing the build.

### Handle exit codes by meaning

```ts
import { spawnSync } from "node:child_process";

const result = spawnSync("bunx", ["dry-ts", "--format", "json", "--fail-on-duplicates", "src", "test"], {
  encoding: "utf8",
});

if (result.status === 1) {
  const report = JSON.parse(result.stdout) as { clusters: unknown[] };
  console.error(`dry-ts found ${report.clusters.length} duplicate clusters`);
  process.exitCode = 1;
} else if (result.status === 2) {
  throw new Error(result.stderr.trim());
} else if (result.status !== 0) {
  throw new Error(`dry-ts exited with ${result.status}`);
}
```

## Common Mistakes

### CRITICAL Forget fail-on-duplicates in CI

Wrong:

```bash
bunx dry-ts --format json src test
```

Correct:

```bash
bunx dry-ts --format json --fail-on-duplicates src test
```

Without `--fail-on-duplicates`, dry-ts exits `0` even when duplicate clusters are found, so CI records a successful job.

Source: README.md:109

### HIGH Parse text output in agents

Wrong:

```bash
bunx dry-ts src test
```

Correct:

```bash
bunx dry-ts --format json src test
```

Text output is for humans; JSON is the stable cluster contract for tools and autonomous agents.

Source: README.md:121

### HIGH Treat exit 1 as tool crash

Wrong:

```ts
import { spawnSync } from "node:child_process";

const result = spawnSync("bunx", ["dry-ts", "--fail-on-duplicates", "src"], { encoding: "utf8" });
if (result.status !== 0) {
  throw new Error("dry-ts failed");
}
```

Correct:

```ts
import { spawnSync } from "node:child_process";

const result = spawnSync("bunx", ["dry-ts", "--format", "json", "--fail-on-duplicates", "src"], {
  encoding: "utf8",
});
if (result.status === 1) {
  console.error(result.stdout);
} else if (result.status === 2) {
  throw new Error(result.stderr.trim());
}
```

Exit code `1` means findings with `--fail-on-duplicates` (clusters with `status: "new"` under a changed-scope; any cluster otherwise). Exit code `2` is usage/configuration errors **and** any git or scanner failure — under `--changed-from`, a missing git binary, bad ref, or unparseable diff fails closed as `2`, never a silent green or a misleading `1`.

Source: README.md (Exit codes)

### MEDIUM Scan default src accidentally

Wrong:

```bash
bunx dry-ts --format json --fail-on-duplicates
```

Correct:

```bash
bunx dry-ts --format json --fail-on-duplicates src test
```

When no paths are passed, dry-ts scans only `src`, so CI can silently ignore test or package directories.

Source: README.md:46

### HIGH Tension: Human output versus agent output

Text output is easier to read locally, while JSON is the stable contract for automation. Agents that parse local text output tend to build brittle CI and review loops.

See also: `scan-code-for-duplicate-candidates/SKILL.md` - useful CI thresholds depend on score and size-filter interpretation.

## References

- [Output contract](references/output-contract.md)
