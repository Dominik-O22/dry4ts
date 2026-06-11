# dry4ts

dry4ts finds candidate duplicate TypeScript code across files and directories. It reports fuzzy structural matches by filename and line range so another mechanism can evaluate and reduce duplication.

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
```

When no paths are provided, dry4ts scans `src`. Directory arguments recursively include `.js`, `.jsx`, `.ts`, `.tsx`, `.mts`, and `.cts` files, excluding TypeScript declaration files.

Default text output:

```text
DUPLICATE score=0.89
  src/invoice.ts:12-25
  src/receipt.ts:30-44
```

EDN output:

```clojure
{:candidates
 [{:score 0.8909090909090909
   :left {:file "src/invoice.ts", :start-line 12, :end-line 25}
   :right {:file "src/receipt.ts", :start-line 30, :end-line 44}
   :left-nodes 88
   :right-nodes 91}]}
```

JSON output:

```json
{
  "candidates": [
    {
      "score": 0.8909090909090909,
      "left": { "file": "src/invoice.ts", "startLine": 12, "endLine": 25 },
      "right": { "file": "src/receipt.ts", "startLine": 30, "endLine": 44 },
      "leftNodes": 88,
      "rightNodes": 91
    }
  ]
}
```

## Library API

```ts
import { TypeScriptDuplicateFinder } from "dry4ts";

const candidates = new TypeScriptDuplicateFinder().findDuplicates({
  paths: ["src"],
  threshold: 0.82,
  minLines: 4,
  minNodes: 20,
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

The JSON shape is intentionally small and stable: `{ "candidates": Candidate[] }`, where each candidate includes score, left/right locations, and normalized node counts.

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
```
