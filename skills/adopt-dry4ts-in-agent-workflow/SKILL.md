---
name: adopt-dry4ts-in-agent-workflow
description: >
  Run dry4ts after AI-generated edits to catch structural duplication before it accumulates. Load when building autonomous review loops, triaging duplicate clusters, using JSON output after generated changes, or deciding when local duplicate checks should become CI gates.
type: core
library: dry4ts
library_version: "0.2.0"
sources:
  - "dry4ts:README.md"
  - "dry4ts:AGENTS.md"
  - "dry4ts:src/TypeScriptDuplicateFinder.ts"
  - "dry4ts:src/Dry4Ts.ts"
  - "dry4ts:test/dry4ts.test.ts"
---

# dry4ts - Adopt in an Agent Workflow

## Setup

```bash
bunx dry4ts --format json src test
```

Run this after generated edits to produce machine-readable duplicate clusters for review.

## Core Patterns

### Run a local guard after generated edits

```bash
bunx dry4ts --format json src test
```

Use JSON when another agent, script, or review tool will consume the clustered result.

### Keep cluster triage separate from refactoring

```ts
import { TypeScriptDuplicateFinder, type Cluster } from "dry4ts";

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
bunx dry4ts --format json --fail-on-duplicates src test
```

Use the failing form only when the team wants duplicate clusters to block a pipeline.

## Common Mistakes

### HIGH Refactor every cluster immediately

Wrong:

```ts
import { TypeScriptDuplicateFinder } from "dry4ts";

const clusters = new TypeScriptDuplicateFinder().findClusters({ paths: ["src"] });
for (const cluster of clusters) {
  console.log(`extract shared helper for ${cluster.locations.map((l) => l.file).join(" and ")}`);
}
```

Correct:

```ts
import { TypeScriptDuplicateFinder } from "dry4ts";

const clusters = new TypeScriptDuplicateFinder().findClusters({ paths: ["src"] });
for (const cluster of clusters) {
  console.log(`review structural cluster at ${cluster.locations[0].file}:${cluster.locations[0].startLine}`);
}
```

dry4ts emits candidate duplicate regions, not a semantic proof that a new abstraction is warranted.

Source: README.md:1

### MEDIUM Ignore parser failures

Wrong:

```ts
import { TypeScriptDuplicateFinder } from "dry4ts";

const clusters = new TypeScriptDuplicateFinder().findClusters({ paths: ["src"] });
console.log(clusters.length);
```

Correct:

```ts
import { TypeScriptDuplicateFinder } from "dry4ts";

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
bunx dry4ts dist
```

Correct:

```bash
bunx dry4ts src test
```

Declaration files are excluded by design, so agents should scan implementation sources rather than expecting `.d.ts` findings.

Source: src/TypeScriptDuplicateFinder.ts:143

### HIGH Tension: Signal versus noise

Lower thresholds and size filters catch more generated duplication but also increase candidate noise. Agents optimizing for zero findings tend to over-refactor harmless structural similarity.

See also: `scan-code-for-duplicate-candidates/SKILL.md` - use score, line range, and size filters to triage before refactoring.

See also: `scan-code-for-duplicate-candidates/SKILL.md` - agent review loops need the same cluster interpretation rules as manual local scans.
