# dry-ts

dry-ts finds candidate duplicate TypeScript code across files and directories. It reports fuzzy structural matches as clusters of related filename and line ranges so another mechanism can evaluate and reduce duplication.

## Overview

dry-ts parses TypeScript source with the TypeScript compiler API, selects TypeScript declarations and function-like nodes as comparison candidates, normalizes each candidate's AST, and compares sets of structural fingerprints with Jaccard similarity:

```text
score = shared fingerprints / all fingerprints seen in either candidate
```

Names and literal values normalize away, while TypeScript syntax shape remains. Classes, interfaces, type aliases, enums, functions, methods, constructors, properties, variable statements, accessors, enum members, arrow functions, and function expressions can all become candidates.

## Usage

Run without installing after the package is published:

```bash
bunx dry-ts [options] [file-or-directory ...]
npx dry-ts [options] [file-or-directory ...]
```

Run from this repository:

```bash
bun install
bun run build
bun ./dist/bin/dry-ts.js [options] [file-or-directory ...]
```

Options:

```text
--threshold N   Minimum structural similarity score, default 0.82
--min-lines N   Minimum source lines in a candidate declaration, default 4
--min-nodes N   Minimum normalized syntax nodes, default 20; candidates
                below this threshold are excluded before pair matching,
                so raising this speeds scans
--min-locations N
                Minimum locations in a reported cluster, default 2
--format F      text, json, or edn, default text
--edn           Same as --format edn
--json          Same as --format json
--text          Same as --format text
--changed-from REF
                Incremental gating: mark clusters that intersect code changed
                since merge-base(REF, HEAD) as status "new". Untracked scanned
                files count as fully changed. Requires a git repository.
--changed FILE  Incremental gating: mark clusters intersecting FILE (every
                line) as status "new". Repeatable; for agents/non-git callers.
                Cannot be combined with --changed-from.
--explain-changed
                Dump the resolved changed-region map to stderr for debugging.
--only-new      Restrict reported clusters to status "new". Output filter only:
                the exit code is unchanged (still governed by
                --fail-on-duplicates). Requires --changed-from/--changed.
                Totals print to stderr, e.g. "showing 6 new (73 known hidden)".
--fail-on-duplicates
                Exit 1 on findings. With --changed-from/--changed, only
                clusters with status "new" gate; otherwise any cluster does.
--no-gitignore  Include files and directories ignored by .gitignore
--exclude GLOB  Skip files/directories matching a .gitignore-style glob, e.g.
                --exclude '**/*.spec.*'. Repeatable. Applies during directory
                scans regardless of --no-gitignore; explicit file arguments are
                always scanned.
--exclude-kinds KIND[,KIND...]
                Drop candidate declarations of the given SyntaxKinds before
                matching. Comma-separated and repeatable. Opt-in only: with no
                flag, output is unchanged. Useful for suppressing boilerplate
                false positives such as dep-only DI constructors
                (--exclude-kinds Constructor) or port/interface member
                signatures (--exclude-kinds PropertySignature,MethodSignature).
                An unknown or non-candidate kind name is a hard error.
--exclude-tagged-templates
                Drop candidate declarations whose value is a tagged template
                literal (const X = styled(Button)`…`, css`…`, gql`…`). Opt-in,
                default off. Suppresses CSS-in-JS / styled-components clusters,
                a dominant false-positive class on frontend codebases.
```

Valid `--exclude-kinds` names are the candidate root kinds — the TypeScript AST
node types dry-ts treats as comparable units. The names are TypeScript
`SyntaxKind`s; what each one is in plain terms:

| Name | What it is |
| --- | --- |
| `ClassDeclaration` | a `class Foo {}` declaration |
| `InterfaceDeclaration` | an `interface Foo {}` declaration |
| `TypeAliasDeclaration` | a `type Foo = ...` alias |
| `EnumDeclaration` | an `enum Foo {}` declaration |
| `ModuleDeclaration` | a `namespace Foo {}` / `module Foo {}` block |
| `FunctionDeclaration` | a `function foo() {}` declaration |
| `MethodDeclaration` | a method body in a class or object literal: `foo() {}` |
| `Constructor` | a class `constructor() {}` |
| `GetAccessor` | a getter: `get foo() {}` |
| `SetAccessor` | a setter: `set foo(v) {}` |
| `PropertyDeclaration` | a class field: `foo = ...` / `foo: T` |
| `PropertySignature` | a property in an interface/type: `foo: T` |
| `MethodSignature` | a method signature in an interface/type: `foo(): T` |
| `CallSignature` | a callable signature in a type: `(arg: T): U` |
| `ConstructSignature` | a constructable signature in a type: `new (): T` |
| `IndexSignature` | an index signature: `[key: string]: T` |
| `VariableStatement` | a `const` / `let` / `var` statement (the whole declaration line) |
| `EnumMember` | a single member inside an enum |
| `ArrowFunction` | an arrow function used as a value: `() => {}` |
| `FunctionExpression` | a `function () {}` used as a value |

Excluding a kind never hides a longer child candidate — children are always
visited regardless.

### Dropping near-uniform candidates: `--min-distinct-kinds`

`--min-nodes` filters by raw node count, but a large candidate can still be
near-uniform boilerplate — a property-only interface, a flat config object —
that clears the node bar yet reaches the similarity threshold against any
similarly-shaped block. `--min-distinct-kinds N` drops a candidate whose subtree
spans fewer than `N` distinct node kinds, while keeping candidates with varied
control flow.

It complements `--min-nodes` (size) with a structure-variety floor. Default
**off** (`0`); markers do not count toward kind diversity, only node kinds do.
The off path tracks nothing, so it costs nothing.

### Suppressing CSS-in-JS declarations: `--exclude-tagged-templates`

Styled-components and other tagged-template idioms — `const X = styled(Button)\`…\``,
`styled('span')\`…\``, `css\`…\``, `gql\`…\`` — normalize to a near-identical AST: a
`VariableStatement` whose initializer is a `TaggedTemplateExpression`, with
`${p => p.theme.x}` arrow interpolations that add just enough distinct kinds to
clear the diversity floor. So they cluster across dozens of files despite sharing
no logic, and the existing reducers do not catch them (excluding `VariableStatement`
wholesale would also kill real const-bound function duplicates). On a large frontend
codebase like the Sentry corpus this is one of the single largest false-positive
classes.

`--exclude-tagged-templates` drops any candidate declaration whose value is a
tagged template literal. It matches by structure rather than by tag name, so it
suppresses `styled`, `css`, `gql`, and any styled alias uniformly, with no tag
allowlist to maintain. Default **off**; when off, output is byte-for-byte
unchanged and the check costs nothing. Like the other reducers it never stops
recursion into children — a genuine duplicate nested inside a tagged template is
still reported.

### Suppressing a single occurrence: `// dry-ignore`

For an intentional, idiomatic repetition that you do not want to exclude
wholesale by kind or file, annotate the specific declaration at the source:

```ts
// dry-ignore
export function knownDuplicate(): void {
  // ...
}
```

A `// dry-ignore` (or `// dry-ignore-next-line`) comment in a declaration's
**leading trivia** drops that declaration as a candidate. The block-comment form
`/* dry-ignore */` works too. No flag required; reads the existing source, no
second parse.

Placement rule: suppression is scoped to the node whose leading comment carries
the directive — put it on the exact declaration you mean. A directive on a
wrapping `const` statement suppresses that `VariableStatement` candidate but does
**not** reach a nested arrow function, which keeps its own (separate) leading
trivia and remains a candidate. Suppressing a parent never hides unrelated child
candidates inside it.

For file- or glob-level ignores, exclude the path via `.gitignore` (or
`--no-gitignore` to override); a config-level ignore surface is tracked
separately.

### Incremental gating

`--fail-on-duplicates` on its own is zero-tolerance: any cluster anywhere fails
the build, which no real codebase survives. Pair it with a changed-scope flag to
gate only on duplication a change introduces — "no change makes the codebase
wetter" — while still reporting known debt. No baseline file, no state.

Every cluster carries a `status`:

- `new` — at least one location intersects the changed scope. This is the
  *finding*, even when the counterpart location is old code (you copied
  something). Only `new` clusters gate under `--fail-on-duplicates`.
- `known` — pre-existing duplication, entirely in unchanged code. Reported,
  never gates.
- `unscoped` — emitted for every cluster when no changed-scope flag is active
  (the tool cannot know what is "known" without a scope).

In a CI gate the actionable `new` clusters are easily buried under pre-existing
`known` ones. `--only-new` filters the *report* down to `new` clusters across
all formats (text/json/edn); the exit code still reflects the full set, so the
gate behaves identically while the log stays readable. It requires a
changed-scope flag (there is no `new` status without one).

`--changed-from` resolves `merge-base(REF, HEAD)` and diffs from there, so a
branch behind its base does not see base-side changes pollute the result. Write
`--changed-from origin/main` and get correct PR semantics directly.

A file renamed into scope with no edits gates nothing — moving code is not
duplicating it. `--changed FILE` scopes the *whole* file (file granularity),
including any pre-existing duplication inside it; use `--changed-from` for
line-level precision.

When no paths are provided, dry-ts scans `src`. Directory arguments recursively include `.js`, `.jsx`, `.ts`, `.tsx`, `.mts`, and `.cts` files, excluding TypeScript declaration files. Directory scans respect `.gitignore` from the working directory by default; pass `--no-gitignore` to include ignored paths. Explicit file arguments are always scanned even when they match a `.gitignore` pattern.

`--exclude GLOB` drops files and directories matching a `.gitignore`-style glob, e.g. `--exclude '**/*.spec.*' --exclude '**/*.stories.*'`. It is repeatable and applies during directory scans regardless of `--no-gitignore` (it is an explicit instruction, not repo config); explicit file arguments are still always scanned. This is the highest-leverage way to cut whole categories of expected duplication — on a large frontend codebase, test and story files alone are typically about half of all reported clusters.

Default text output:

```text
CLUSTER 1 score=0.89 locations=2 status=unscoped
  src/invoice.ts:12-25 nodes=88
  src/receipt.ts:30-44 nodes=91
```

Under a changed-scope, findings are marked: `status=new (intersects your change)`.

EDN output:

```clojure
{:clusters
 [{:score-min 0.8909090909090909
   :score-max 0.8909090909090909
   :status :unscoped
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
      "status": "unscoped",
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
import { TypeScriptDuplicateFinder } from "dry-ts";

const clusters = new TypeScriptDuplicateFinder().findClusters({
  paths: ["src"],
  threshold: 0.82,
  minLines: 4,
  minNodes: 20,
  minLocations: 2,
  respectGitignore: true, // default; set false to include .gitignore-d paths
});
```

`findClusters()` returns raw clusters with `status` unset. The changed-scope
flags (`--changed-from`, `--changed`) and the `status` field
(`"new" | "known" | "unscoped"`) are assigned by the CLI, not the library
finder.

## CI

Gate a PR only when it introduces *new* duplication, tolerating known debt, with
`--changed-from` against the PR's base branch:

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
      - run: bunx dry-ts --format json --fail-on-duplicates --changed-from origin/${{ github.base_ref || 'main' }} src
```

To gate on *all* duplication (zero-tolerance) instead, drop `--changed-from`:
`bunx dry-ts --format json --fail-on-duplicates src`.

For this repository, `bun run ci` builds, tests, and runs dry-ts against `src test`.

## AI Agents

If you use an AI agent, run `npx @tanstack/intent@latest install`.

Prefer JSON output for autonomous tools:

```bash
bunx dry-ts --format json src test
```

Exit codes are stable for automation:

```text
0  success: no findings, or no --fail-on-duplicates
1  findings with --fail-on-duplicates (status "new" under a changed-scope;
   any cluster otherwise)
2  usage/configuration error, or any git/scanner failure (fail-closed)
```

The gate fails closed: a missing git binary, a bad ref, unparseable diff output,
an unreadable source file, or zero files scanned under `--fail-on-duplicates` all
exit 2 with a message — never a silent green or a 1 that reads as "findings".

The JSON shape is intentionally small and stable: `{ "clusters": ClusterReport[] }`. Each cluster includes a `score` range, a `status` (`"new" | "known" | "unscoped"`), `locationCount`, and grouped `locations`. Each location includes `nodes`, the normalized syntax node count for that duplicated block.

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
2. **Pinned large repositories** — `bun run bench:setup` fetches two pinned
   real-world corpora into `.bench/` (gitignored). Pass a name
   (`bun run bench:setup sentry`) to fetch just one.
   - `microsoft/TypeScript` at a statically pinned tag (`v5.9.3`, chosen by
     maintainers to match the current `typescript` dependency — bumped by hand,
     not resolved automatically). Scan `.bench/TypeScript/src/compiler` for a
     worst-case stress:
     very large files, deeply nested ASTs, and high structural self-similarity.
     Already pushed quite low (~1.5s), so it has little regression headroom.
   - `getsentry/sentry` (sparse blobless clone of `static/app` only). Scan
     `.bench/sentry/static/app` — a large, messy real-world TS/TSX frontend
     (~6.8k files, ~2.6k clusters). Wider and more varied than the compiler
     subtree, so it surfaces hot-path regressions the compiler scan would miss.
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

Baselines (use as regression checks — cluster counts must stay fixed and timing
must not regress across changes):

- TypeScript v5.9.3 `src/compiler`: ~1.5s, 246 clusters (since v0.3.0).
- Sentry 25.10.0 `static/app`: ~5.3s, 2574 clusters (since v0.5.0,
  `--exclude-kinds` hot-path change measured against it).
