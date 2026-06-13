---
name: adopt-dry-ts-in-agent-workflow
description: >
  Run dry-ts after AI-generated edits to catch structural duplication before it accumulates. Load when building autonomous review loops, gating only on duplication an edit introduced with --changed/--changed-from, triaging duplicate clusters by status, using JSON output after generated changes, or deciding when local duplicate checks should become CI gates.
type: core
library: dry-ts
library_version: "0.4.0"
sources:
  - "dry-ts:README.md"
  - "dry-ts:AGENTS.md"
  - "dry-ts:src/TypeScriptDuplicateFinder.ts"
  - "dry-ts:src/DryTs.ts"
  - "dry-ts:test/dry-ts.test.ts"
---

# dry-ts - Adopt in an Agent Workflow

## Setup

```bash
bunx dry-ts --format json src test
```

Run this after generated edits to produce machine-readable duplicate clusters for review.

## Core Patterns

### Self-correct on duplication your edit introduced

```bash
# After editing foo.ts and bar.ts, gate only on duplication the edit added:
bunx dry-ts --format json --fail-on-duplicates --changed foo.ts --changed bar.ts src
# git-aware agents get line-level precision from uncommitted edits instead:
bunx dry-ts --format json --fail-on-duplicates --changed-from HEAD src
```

Exit `1` means a cluster with `status: "new"` intersects your change. Refactor
those clusters (extract a shared helper) and re-run until it exits `0`. `--changed
<file>` scopes the *whole file*, so a `new` finding can point at pre-existing code
you copied; the wording is "intersects your change", never "you created this".
This keeps the loop honest without a full-codebase zero-tolerance gate.

### Run a local guard after generated edits

```bash
bunx dry-ts --format json src test
```

Use JSON when another agent, script, or review tool will consume the clustered
result. With no changed-scope flag every cluster reports `status: "unscoped"`.

### Keep cluster triage separate from refactoring

```ts
import { TypeScriptDuplicateFinder, type Cluster } from "dry-ts";

const clusters = new TypeScriptDuplicateFinder().findClusters({
  paths: ["src", "test"],
  threshold: 0.82,
  minLines: 4,
  minNodes: 20,
});

const reviewItems = clusters.map((cluster) => ({
  scoreMax: cluster.score.max,
  scoreMin: cluster.score.min,
  locations: cluster.locations.map((loc) => `${loc.file}:${loc.startLine}-${loc.endLine}`),
}));

console.log(JSON.stringify({ reviewItems }, null, 2));
```

Cluster output should drive a review decision before any abstraction is extracted.

### Escalate repeated local checks into CI

```bash
bunx dry-ts --format json --fail-on-duplicates --changed-from origin/main src test
```

For a PR gate, pair `--fail-on-duplicates` with `--changed-from` so only *new*
duplication blocks the pipeline; known debt stays reported but green. Drop
`--changed-from` for a zero-tolerance gate. See `wire-duplicate-checks-into-ci`.

## Common Mistakes

### HIGH Refactor every cluster immediately

Wrong:

```ts
import { TypeScriptDuplicateFinder } from "dry-ts";

const clusters = new TypeScriptDuplicateFinder().findClusters({ paths: ["src"] });
for (const cluster of clusters) {
  console.log(`extract shared helper for ${cluster.locations.map((l) => l.file).join(" and ")}`);
}
```

Correct:

```ts
import { TypeScriptDuplicateFinder } from "dry-ts";

const clusters = new TypeScriptDuplicateFinder().findClusters({ paths: ["src"] });
for (const cluster of clusters) {
  console.log(`review structural cluster at ${cluster.locations[0].file}:${cluster.locations[0].startLine}`);
}
```

dry-ts emits candidate duplicate regions, not a semantic proof that a new abstraction is warranted.

Source: README.md:1

### MEDIUM Ignore parser failures

Wrong:

```ts
import { TypeScriptDuplicateFinder } from "dry-ts";

const clusters = new TypeScriptDuplicateFinder().findClusters({ paths: ["src"] });
console.log(clusters.length);
```

Correct:

```ts
import { TypeScriptDuplicateFinder } from "dry-ts";

try {
  const clusters = new TypeScriptDuplicateFinder().findClusters({ paths: ["src"] });
  console.log(clusters.length);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
```

Syntax errors throw during scanning, so agent workflows should report parse failures separately from clean duplicate results.

Source: src/TypeScriptDuplicateFinder.ts:85

### MEDIUM Scan generated declarations

Wrong:

```bash
bunx dry-ts dist
```

Correct:

```bash
bunx dry-ts src test
```

Declaration files are excluded by design, so agents should scan implementation sources rather than expecting `.d.ts` findings.

Source: src/TypeScriptDuplicateFinder.ts:143

### HIGH Tension: Signal versus noise

Lower thresholds and size filters catch more generated duplication but also increase candidate noise. Agents optimizing for zero findings tend to over-refactor harmless structural similarity.

See also: `scan-code-for-duplicate-candidates/SKILL.md` - use score, line range, and size filters to triage before refactoring.

See also: `scan-code-for-duplicate-candidates/SKILL.md` - agent review loops need the same cluster interpretation rules as manual local scans.
