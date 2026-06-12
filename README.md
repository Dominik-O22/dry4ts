# dry4ts

dry4ts finds candidate duplicate TypeScript code across files and directories. It reports fuzzy structural matches as clusters of related filename and line ranges so another mechanism can evaluate and reduce duplication.

## Overview

dry4ts parses TypeScript source with the TypeScript compiler API, selects TypeScript declarations and function-like nodes as comparison candidates, normalizes each candidate's AST, and compares sets of structural fingerprints with Jaccard similarity:

```text
score = shared fingerprints / all fingerprints seen in either candidate
```

Names and literal values normalize away, while TypeScript syntax shape remains. Classes, interfaces, type aliases, enums, functions, methods, constructors, properties, variable statements, accessors, enum members, arrow functions, and function expressions can all become candidates.

## Usage

Run without installing after the package is published:

```bash
bunx dry4ts [options] [file-or-directory ...]
npx dry4ts [options] [file-or-directory ...]
```

Run from this repository:

```bash
bun install
bun run build
bun ./dist/bin/dry4ts.js [options] [file-or-directory ...]
```

Options:

```text
--threshold N   Minimum structural similarity score, default 0.82
--min-lines N   Minimum source lines in a candidate declaration, default 4
--min-nodes N   Minimum normalized syntax nodes, default 20
--format F      text, json, or edn, default text
--edn           Same as --format edn
--json          Same as --format json
--text          Same as --format text
--fail-on-duplicates
                Exit with status 1 when duplicate candidates are found
--no-gitignore  Include files and directories ignored by .gitignore
```

When no paths are provided, dry4ts scans `src`. Directory arguments recursively include `.js`, `.jsx`, `.ts`, `.tsx`, `.mts`, and `.cts` files, excluding TypeScript declaration files. Directory scans respect `.gitignore` from the working directory by default; pass `--no-gitignore` to include ignored paths. Explicit file arguments are always scanned even when they match a `.gitignore` pattern.

Default text output:

```text
CLUSTER 1 score=0.89 locations=2
  src/invoice.ts:12-25 nodes=88
  src/receipt.ts:30-44 nodes=91
```

EDN output:

```clojure
{:clusters
 [{:score-min 0.8909090909090909
   :score-max 0.8909090909090909
   :location-count 2
   :locations [{:file "src/invoice.ts", :start-line 12, :end-line 25, :nodes 88}
               {:file "src/receipt.ts", :start-line 30, :end-line 44, :nodes 91}]}]}
```

JSON output:

```json
{
  "clusters": [
    {
      "score": { "min": 0.8909090909090909, "max": 0.8909090909090909 },
      "locationCount": 2,
      "locations": [
        { "file": "src/invoice.ts", "startLine": 12, "endLine": 25, "nodes": 88 },
        { "file": "src/receipt.ts", "startLine": 30, "endLine": 44, "nodes": 91 }
      ]
    }
  ]
}
```

## Library API

```ts
import { TypeScriptDuplicateFinder } from "dry4ts";

const clusters = new TypeScriptDuplicateFinder().findClusters({
  paths: ["src"],
  threshold: 0.82,
  minLines: 4,
  minNodes: 20,
  respectGitignore: true, // default; set false to include .gitignore-d paths
});
```

## CI

Use `--fail-on-duplicates` to make duplicate candidates fail the job:

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
      - run: bunx dry4ts --format json --fail-on-duplicates src
```

For this repository, `bun run ci` builds, tests, and runs dry4ts against `src test`.

## AI Agents

If you use an AI agent, run `npx @tanstack/intent@latest install`.

Prefer JSON output for autonomous tools:

```bash
bunx dry4ts --format json src test
```

Exit codes are stable for automation:

```text
0  success
1  duplicate candidates found with --fail-on-duplicates
2  CLI usage/configuration error
```

The JSON shape is intentionally small and stable: `{ "clusters": ClusterReport[] }`. Each cluster includes a `score` range, `locationCount`, and grouped `locations`. Each location includes `nodes`, the normalized syntax node count for that duplicated block.

## Publishing

Before publishing:

```bash
bun install --frozen-lockfile
bun run ci
bun run pack:dry-run
npm publish
```

## Development

```bash
bun run test
bun run check
bun run ci
bun run bench -- /path/to/project/src /path/to/project/tests
```

### Benchmarking

Three corpus tiers, all scanned with `bun run bench -- <paths>`:

1. **Real mid-size project** — any ~30k LOC repository you have locally.
   Use it as a regression check: cluster output should stay identical across
   performance changes, and timing should not regress.
2. **Pinned large repository** — `bun run bench:setup` shallow-clones
   `microsoft/TypeScript` at the tag matching the installed `typescript`
   dependency into `.bench/TypeScript` (gitignored). Scan
   `.bench/TypeScript/src/compiler` for a worst-case stress: very large
   files, deeply nested ASTs, and high structural self-similarity.
3. **Synthetic regimes** — `bun run bench:corpus <regime>` generates a
   deterministic corpus into `.bench/corpus/<regime>`:
   - `identical` (default 800 functions): dense identical structures,
     stresses the pairwise comparison phase
   - `oneliners` (default 10000): trivial declarations below `--min-lines`,
     stresses entry filtering
   - `nested` (default depth 300): deeply nested expressions, stresses
     fingerprint construction

   Both `bench:corpus` and `bench` pass `--no-gitignore` so corpus paths under
   `.bench/` (which is gitignored) are scanned correctly.

   `bench:corpus` also accepts `--count N` to override the default size and
   `--out DIR` to write the corpus to a custom directory.

Example:

```bash
bun run bench:corpus identical -- --count 1200
bun run bench -- --runs 5 .bench/corpus/identical
```

Baseline (2026-06-11, pre-optimization, TypeScript v5.9.3 corpus):
`src/compiler` scans in ~16.2s and reports 246 clusters. Performance work
should reduce the time without changing the cluster count.
