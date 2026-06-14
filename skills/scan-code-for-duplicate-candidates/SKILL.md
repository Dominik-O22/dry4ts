---
name: scan-code-for-duplicate-candidates
description: >
  Run dry-ts locally or from code to find fuzzy structural duplicate clusters. Load when choosing paths, interpreting score, status, and line-range output, tuning --threshold, --min-lines, --min-nodes, or using TypeScriptDuplicateFinder.findClusters.
type: core
library: dry-ts
library_version: "0.10.0"
sources:
  - "dry-ts:README.md"
  - "dry-ts:src/TypeScriptDuplicateFinder.ts"
  - "dry-ts:src/TypeScriptNormalizer.ts"
  - "dry-ts:src/FileScanner.ts"
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

### Suppress boilerplate candidate kinds

```bash
bunx dry-ts src --exclude-kinds Constructor,PropertySignature,MethodSignature
```

`--exclude-kinds` drops candidate declarations of the named TypeScript
`SyntaxKind`s before matching, so structurally-identical boilerplate stops
clustering: dependency-injection constructors (`Constructor`) or port/interface
member signatures (`PropertySignature,MethodSignature`). It is opt-in — with no
flag, nothing is excluded — comma-separated and repeatable. An unknown or
non-candidate kind name is a hard error (exit `2`); valid names are the
candidate root kinds listed in the README. Excluding a kind never hides a
longer child candidate, since children are always visited.

### Drop near-uniform candidates (kind-diversity floor)

```bash
bunx dry-ts src --min-distinct-kinds 8
```

`--min-distinct-kinds N` drops a candidate whose subtree spans fewer than `N`
distinct node kinds. It complements `--min-nodes` (size) with a structure-variety
floor: a property-only interface or a flat config object can clear the node-count
bar yet reach the threshold against any similarly-shaped block. Opt-in, default
`0` (off); markers do not count, only node kinds. The off path tracks nothing, so
it costs nothing.

### Exclude whole files by path glob

```bash
bunx dry-ts src --exclude '**/*.spec.*' --exclude '**/*.stories.*'
```

`--exclude GLOB` skips files/directories matching a `.gitignore`-style glob during
directory scans. Repeatable; applies regardless of `--no-gitignore` (it is an
explicit instruction, not repo config); explicit file arguments are still always
scanned. This is the highest-leverage filter for expected duplication — on a large
frontend codebase, test and story files alone are typically about half of all
reported clusters.

### Suppress CSS-in-JS / styled-components declarations

```bash
bunx dry-ts src --exclude-tagged-templates
```

`--exclude-tagged-templates` drops candidate declarations whose value is a tagged
template literal — `const X = styled(Button)\`…\``, `styled('span')\`…\``, `css\`…\``,
`gql\`…\``. These normalize to a near-identical AST and cluster across dozens of
files despite sharing no logic; the kind/path filters cannot catch them without
dropping real const-bound function duplicates. The flag matches by structure, not
by tag name, so it covers `styled`/`css`/`gql` and any alias uniformly. Opt-in,
default off; on a large frontend codebase it is the single largest remaining
false-positive class after path and kind filters (~8% of clusters on the Sentry
corpus).

### Suppress one occurrence at the source (`// dry-ignore`)

```ts
// dry-ignore
export function knownDuplicate(): void {
  // ...
}
```

A `// dry-ignore` (or `// dry-ignore-next-line`, or `/* dry-ignore */`) comment in
a declaration's leading trivia drops that declaration as a candidate. No flag
required. Suppression is scoped to the node whose comment carries the directive —
a directive on a wrapping `const` statement does not reach a nested arrow function,
and suppressing a parent never hides unrelated child candidates inside it.

### Read cluster locations before refactoring

```text
CLUSTER 1 score=0.89 locations=2 status=unscoped
  src/invoice.ts:12-25 nodes=88 kind=FunctionDeclaration name=renderInvoice
  src/receipt.ts:30-44 nodes=91 kind=FunctionDeclaration name=renderReceipt
```

The score is structural similarity, and the line ranges identify related duplicate regions for review. `nodes` is the normalized syntax node count for that duplicated block. `kind` is the candidate root SyntaxKind name (e.g. `FunctionDeclaration`, `Constructor`, `InterfaceDeclaration`, `ArrowFunction`) and `name` is the declaration identifier — so you can classify a finding without opening the file; `name=` is dropped for anonymous declarations (arrows, callable signatures), where JSON/EDN report `null`/`nil`. `status` is `unscoped` for a plain scan; under a changed-scope flag it becomes `new` (marked `status=new (intersects your change)`) or `known`.

### Add per-location nearest-counterpart provenance (`--counterparts`)

```bash
bunx dry-ts src test --counterparts --json
```

`--counterparts` adds, per cluster location, its nearest matching counterpart —
the absolute strongest AST-similar partner in the same cluster — as `{ index,
file, startLine, endLine, shared, total, score }`, and (under an active change
scope) a per-location `changed` boolean. In a transitive cluster (>2 members) the
`score` range alone hides the edge structure; the counterpart resolves *which*
member a location actually matches and *how strongly* (`shared`/`total` are the
exact pairwise fingerprint-intersection/union counts, `score` is `shared/total`).
`index` dereferences within the same cluster's `locations`. In text it appends to
the location's own line: `… changed=true → nearest src/b.ts:5-33 (44/52)`. With
`changed` on both sides an agent routes the fix: counterpart `changed:true` ⇒
new/new (refactor the new code); `changed:false` ⇒ new/old (extract toward the
existing code). Opt-in, default off; off-path output is byte-for-byte unchanged.
`--only-new` filters whole clusters, never individual locations or counterparts.

### Diagnose a surprising changed-scope result

```bash
bunx dry-ts --explain-changed --changed-from HEAD src
```

`--explain-changed` dumps the resolved changed-region map (file → line ranges, with source: hunk / untracked / listed) to stderr, so a confusing `new`/`known` verdict — usually a path-normalization mismatch — is diagnosable in one rerun.

### Use the API from custom tooling

```ts
import { TypeScriptDuplicateFinder, type Cluster } from "dry-ts";

const finder = new TypeScriptDuplicateFinder();
const clusters = finder.findClusters({
  paths: ["src", "test"],
  threshold: 0.82,
  minLines: 4,
  minNodes: 20,
  excludeKinds: ["Constructor", "PropertySignature"],
  minDistinctKinds: 8,
  exclude: ["**/*.spec.*", "**/*.stories.*"],
  counterparts: true,
});

for (const cluster of clusters) {
  for (const location of cluster.locations) {
    const nearest = location.nearest;
    const ref = nearest ? ` → ${nearest.file}:${nearest.startLine} (${nearest.shared}/${nearest.total})` : "";
    console.log(`${cluster.score.max.toFixed(2)} ${location.file}:${location.startLine}${ref}`);
  }
}
```

With `counterparts: true`, each location carries a `nearest` field (`{ index,
file, startLine, endLine, shared, total, score }`); without it, `nearest` is
absent (the object shape is byte-identical to the default).

`findClusters` returns clusters with `status` unset — the `new`/`known`/`unscoped`
labels and the `--changed-from`/`--changed` scope are CLI behavior, not library
behavior.

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
