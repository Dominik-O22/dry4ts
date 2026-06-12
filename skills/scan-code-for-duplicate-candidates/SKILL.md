---
name: scan-code-for-duplicate-candidates
description: >
  Run dry-ts locally or from code to find fuzzy structural duplicate clusters. Load when choosing paths, interpreting score and line-range output, tuning --threshold, --min-lines, --min-nodes, or using TypeScriptDuplicateFinder.findClusters.
type: core
library: dry-ts
library_version: "0.2.0"
sources:
  - "dry-ts:README.md"
  - "dry-ts:src/TypeScriptDuplicateFinder.ts"
  - "dry-ts:src/TypeScriptNormalizer.ts"
  - "dry-ts:src/Options.ts"
  - "dry-ts:src/types.ts"
---

# dry-ts - Scan Code for Duplicate Candidates

## Setup

```bash
bunx dry-ts src test
```

```ts
import { TypeScriptDuplicateFinder } from "dry-ts";

const clusters = new TypeScriptDuplicateFinder().findClusters({
  paths: ["src", "test"],
  threshold: 0.82,
  minLines: 4,
  minNodes: 20,
});

console.log(clusters);
```

## Core Patterns

### Scan changed source and tests

```bash
bunx dry-ts src test
```

Path arguments can be files or directories. Directories are scanned recursively for `.js`, `.jsx`, `.ts`, `.tsx`, `.mts`, and `.cts` files.

### Tune sensitivity for smaller candidates

```bash
bunx dry-ts src test --threshold 0.78 --min-lines 3 --min-nodes 12
```

Lower `--threshold`, `--min-lines`, and `--min-nodes` only when intentionally looking for smaller or fuzzier structural matches.

### Read cluster locations before refactoring

```text
CLUSTER 1 score=0.89 locations=2
  src/invoice.ts:12-25 nodes=88
  src/receipt.ts:30-44 nodes=91
```

The score is structural similarity, and the line ranges identify related duplicate regions for review. `nodes` is the normalized syntax node count for that duplicated block.

### Use the API from custom tooling

```ts
import { TypeScriptDuplicateFinder, type Cluster } from "dry-ts";

const finder = new TypeScriptDuplicateFinder();
const clusters = finder.findClusters({
  paths: ["src", "test"],
  threshold: 0.82,
  minLines: 4,
  minNodes: 20,
});

for (const cluster of clusters) {
  for (const location of cluster.locations) {
    console.log(`${cluster.score.max.toFixed(2)} ${location.file}:${location.startLine}`);
  }
}
```

## Common Mistakes

### HIGH Expect exact clone detection

Wrong:

```bash
bunx dry-ts src
```

Correct:

```bash
bunx dry-ts src
```

Treat the result as a fuzzy structural candidate list. dry-ts normalizes names and literal values away, so matches are not exact copy-paste proof.

Source: README.md:7

### MEDIUM Scan default src accidentally

Wrong:

```bash
bunx dry-ts
```

Correct:

```bash
bunx dry-ts src test
```

When no paths are passed, dry-ts scans only `src`, which can miss test duplication or package directories under review.

Source: README.md:46

### MEDIUM Use defaults for tiny candidates

Wrong:

```bash
bunx dry-ts src --threshold 0.82
```

Correct:

```bash
bunx dry-ts src --threshold 0.8 --min-lines 2 --min-nodes 8
```

The defaults require at least 4 source lines and 20 normalized nodes, so small repeated helpers or expressions are intentionally filtered out.

Source: README.md:35

### HIGH Tension: Signal versus noise

Lower thresholds and size filters catch more generated duplication but also increase candidate noise. Agents optimizing for zero findings tend to over-refactor harmless structural similarity.

See also: `adopt-dry-ts-in-agent-workflow/SKILL.md` - use cluster triage before extracting shared abstractions.

## References

- [Candidate selection and normalization](references/candidate-selection-and-normalization.md)

See also: `wire-duplicate-checks-into-ci/SKILL.md` - a local scan that becomes team policy needs `--fail-on-duplicates` and stable JSON semantics.
