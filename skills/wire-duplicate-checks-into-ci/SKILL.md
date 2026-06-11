---
name: wire-duplicate-checks-into-ci
description: >
  Use dry4ts as a CI or automated review gate with --format json and --fail-on-duplicates. Load when writing GitHub Actions, parsing Candidate JSON, or handling dry4ts exit codes 0, 1, and 2.
type: core
library: dry4ts
library_version: "0.1.0"
sources:
  - "dry4ts:README.md"
  - "dry4ts:AGENTS.md"
  - "dry4ts:src/Dry4Ts.ts"
  - "dry4ts:.github/workflows/ci.yml"
---

# dry4ts - Wire Duplicate Checks Into CI

## Setup

```yaml
name: Duplicate Code

on: [push, pull_request]

jobs:
  dry4ts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.6
      - run: bunx dry4ts --format json --fail-on-duplicates src test
```

## Core Patterns

### Fail only when candidates are present

```bash
bunx dry4ts --format json --fail-on-duplicates src test
```

`--fail-on-duplicates` changes duplicate findings from a report into exit code `1`.

### Emit JSON for agent consumers

```bash
bunx dry4ts --format json src test
```

JSON output is stable and small: `{ "candidates": Candidate[] }`.

### Handle exit codes by meaning

```ts
import { spawnSync } from "node:child_process";

const result = spawnSync("bunx", ["dry4ts", "--format", "json", "--fail-on-duplicates", "src", "test"], {
  encoding: "utf8",
});

if (result.status === 1) {
  const report = JSON.parse(result.stdout) as { candidates: unknown[] };
  console.error(`dry4ts found ${report.candidates.length} duplicate candidates`);
  process.exitCode = 1;
} else if (result.status === 2) {
  throw new Error(result.stderr.trim());
} else if (result.status !== 0) {
  throw new Error(`dry4ts exited with ${result.status}`);
}
```

## Common Mistakes

### CRITICAL Forget fail-on-duplicates in CI

Wrong:

```bash
bunx dry4ts --format json src test
```

Correct:

```bash
bunx dry4ts --format json --fail-on-duplicates src test
```

Without `--fail-on-duplicates`, dry4ts exits `0` even when candidates are found, so CI records a successful job.

Source: README.md:109

### HIGH Parse text output in agents

Wrong:

```bash
bunx dry4ts src test
```

Correct:

```bash
bunx dry4ts --format json src test
```

Text output is for humans; JSON is the stable candidate contract for tools and autonomous agents.

Source: README.md:121

### HIGH Treat exit 1 as tool crash

Wrong:

```ts
import { spawnSync } from "node:child_process";

const result = spawnSync("bunx", ["dry4ts", "--fail-on-duplicates", "src"], { encoding: "utf8" });
if (result.status !== 0) {
  throw new Error("dry4ts failed");
}
```

Correct:

```ts
import { spawnSync } from "node:child_process";

const result = spawnSync("bunx", ["dry4ts", "--format", "json", "--fail-on-duplicates", "src"], {
  encoding: "utf8",
});
if (result.status === 1) {
  console.error(result.stdout);
} else if (result.status === 2) {
  throw new Error(result.stderr.trim());
}
```

Exit code `1` means duplicates were found with `--fail-on-duplicates`; usage and configuration errors use exit code `2`.

Source: README.md:125

### MEDIUM Scan default src accidentally

Wrong:

```bash
bunx dry4ts --format json --fail-on-duplicates
```

Correct:

```bash
bunx dry4ts --format json --fail-on-duplicates src test
```

When no paths are passed, dry4ts scans only `src`, so CI can silently ignore test or package directories.

Source: README.md:46

### HIGH Tension: Human output versus agent output

Text output is easier to read locally, while JSON is the stable contract for automation. Agents that parse local text output tend to build brittle CI and review loops.

See also: `scan-code-for-duplicate-candidates/SKILL.md` - useful CI thresholds depend on score and size-filter interpretation.

## References

- [Output contract](references/output-contract.md)
