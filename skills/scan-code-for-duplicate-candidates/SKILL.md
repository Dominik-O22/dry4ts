---
name: scan-code-for-duplicate-candidates
description: >
  Run dry4ts locally or from code to find fuzzy structural duplicate candidates. Load when choosing paths, interpreting score and line-range output, tuning --threshold, --min-lines, --min-nodes, or using TypeScriptDuplicateFinder.findDuplicates.
type: core
library: dry4ts
library_version: "0.1.0"
sources:
  - "dry4ts:README.md"
  - "dry4ts:src/TypeScriptDuplicateFinder.ts"
  - "dry4ts:src/TypeScriptNormalizer.ts"
  - "dry4ts:src/Options.ts"
  - "dry4ts:src/types.ts"
---

# dry4ts - Scan Code for Duplicate Candidates

## Setup

```bash
bunx dry4ts src test
```

```ts
import { TypeScriptDuplicateFinder } from "dry4ts";

const candidates = new TypeScriptDuplicateFinder().findDuplicates({
  paths: ["src", "test"],
  threshold: 0.82,
  minLines: 4,
  minNodes: 20,
});

console.log(candidates);
```

## Core Patterns

### Scan changed source and tests

```bash
bunx dry4ts src test
```

Path arguments can be files or directories. Directories are scanned recursively for `.js`, `.jsx`, `.ts`, `.tsx`, `.mts`, and `.cts` files.

### Tune sensitivity for smaller candidates

```bash
bunx dry4ts src test --threshold 0.78 --min-lines 3 --min-nodes 12
```

Lower `--threshold`, `--min-lines`, and `--min-nodes` only when intentionally looking for smaller or fuzzier structural matches.

### Read candidate locations before refactoring

```text
DUPLICATE score=0.89
  src/invoice.ts:12-25
  src/receipt.ts:30-44
```

The score is structural similarity, and the line ranges identify candidate regions for review.

### Use the API from custom tooling

```ts
import { TypeScriptDuplicateFinder } from "dry4ts";

const finder = new TypeScriptDuplicateFinder();
const candidates = finder.findDuplicates({
  paths: ["src", "test"],
  threshold: 0.82,
  minLines: 4,
  minNodes: 20,
});

for (const candidate of candidates) {
  console.log(`${candidate.score.toFixed(2)} ${candidate.left.file}:${candidate.left.startLine}`);
}
```

## Common Mistakes

### HIGH Expect exact clone detection

Wrong:

```bash
bunx dry4ts src
```

Correct:

```bash
bunx dry4ts src
```

Treat the result as a fuzzy structural candidate list. dry4ts normalizes names and literal values away, so matches are not exact copy-paste proof.

Source: README.md:7

### MEDIUM Scan default src accidentally

Wrong:

```bash
bunx dry4ts
```

Correct:

```bash
bunx dry4ts src test
```

When no paths are passed, dry4ts scans only `src`, which can miss test duplication or package directories under review.

Source: README.md:46

### MEDIUM Use defaults for tiny candidates

Wrong:

```bash
bunx dry4ts src --threshold 0.82
```

Correct:

```bash
bunx dry4ts src --threshold 0.8 --min-lines 2 --min-nodes 8
```

The defaults require at least 4 source lines and 20 normalized nodes, so small repeated helpers or expressions are intentionally filtered out.

Source: README.md:35

### HIGH Tension: Signal versus noise

Lower thresholds and size filters catch more generated duplication but also increase candidate noise. Agents optimizing for zero findings tend to over-refactor harmless structural similarity.

See also: `adopt-dry4ts-in-agent-workflow/SKILL.md` - use candidate triage before extracting shared abstractions.

## References

- [Candidate selection and normalization](references/candidate-selection-and-normalization.md)

See also: `wire-duplicate-checks-into-ci/SKILL.md` - a local scan that becomes team policy needs `--fail-on-duplicates` and stable JSON semantics.
