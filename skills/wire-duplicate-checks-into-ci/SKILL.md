---
name: wire-duplicate-checks-into-ci
description: >
  Use dry-ts as a CI or automated review gate with --format json and --fail-on-duplicates. Load when writing GitHub Actions, gating a PR only on new duplication with --changed-from, parsing cluster JSON status, or handling dry-ts exit codes 0, 1, and 2.
type: core
library: dry-ts
library_version: "0.4.0"
sources:
  - "dry-ts:README.md"
  - "dry-ts:AGENTS.md"
  - "dry-ts:src/DryTs.ts"
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

### Emit JSON for agent consumers

```bash
bunx dry-ts --format json src test
```

JSON output is stable and small: `{ "clusters": ClusterReport[] }`.

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
