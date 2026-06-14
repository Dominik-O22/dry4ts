# dry-ts

dry-ts finds candidate duplicate TypeScript code across files and directories. It reports fuzzy structural matches as clusters of related filename and line ranges so another mechanism can evaluate and reduce duplication.

## Quickstart

```bash
# Scan a source tree for candidate duplicates
bunx dry-ts src

# PR gate — fail only if THIS change adds duplication (the recommended workflow)
bunx dry-ts --profile pr --changed-from origin/main src
```

`--profile pr` is a curated preset; it expands to `--exclude-tests --min-nodes 50 --exclude-kinds ArrowFunction,VariableStatement --only-new --fail-on-duplicates`. See [Curating results](#curating-results) for the other profiles.

**What it is:** a TypeScript-first *structural* duplicate-**candidate** detector, built for PR gates and AI/agent consumers. It catches Type-2/Type-3 clones — same shape, renamed identifiers, reordered or slightly varied statements — that token and line matchers miss.

**What it is not:** a general-purpose, multi-language copy/paste detector. For broad Type-1 token cloning across many languages with mature CI reporters, reach for [jscpd](https://github.com/kucherenko/jscpd) or PMD CPD. dry-ts reports structural *similarity candidates*, not confirmed semantic duplication — keep that framing when you triage.

**Maturity:** young package — pin the version (`dry-ts@x.y.z`). Normalization can change between releases, so an unpinned bump can shift findings. It has no install hooks and two runtime dependencies (`ignore`, `typescript`); `git` is spawned only for `--changed-from`.

## Overview

dry-ts parses TypeScript source with the TypeScript compiler API, selects TypeScript declarations and function-like nodes as comparison candidates, normalizes each candidate's AST, and compares sets of structural fingerprints with Jaccard similarity:

```text
score = shared fingerprints / all fingerprints seen in either candidate
```

Names and literal values normalize away, while TypeScript syntax shape remains. Classes, interfaces, type aliases, enums, functions, methods, constructors, properties, variable statements, accessors, enum members, arrow functions, and function expressions can all become candidates.

## How dry-ts differs from token and line matchers

Most duplicate-code tools match **tokens** or **lines**. dry-ts matches
**normalized AST structure**. The difference is which kind of clone each can see,
in the standard Type 1–4 clone taxonomy:

- **Type 1** — identical code, modulo whitespace and comments.
- **Type 2** — Type 1 with renamed identifiers and changed literals; same structure.
- **Type 3** — near-miss: statements added, removed, or reordered.
- **Type 4** — semantically equivalent but structurally different.

| Tool | Method | Catches |
| --- | --- | --- |
| Simian | line hashing (ignores whitespace, braces, comments) | mostly Type 1 |
| jscpd | contiguous token-sequence matching (Rabin–Karp over Prism tokens) | Type 1 |
| PMD CPD | contiguous token-sequence matching (Rabin–Karp / suffix tree); can normalize identifiers and literals | Type 1, Type 2 |
| **dry-ts** | **set similarity over normalized-AST fingerprints (Jaccard)** | **Type 2 and Type 3** |

Two properties follow from comparing *sets* of structural fingerprints instead of
contiguous token runs:

1. **Rename- and reorder-tolerant.** Names and literals normalize away before
   fingerprinting, and Jaccard scores *partial* overlap, so two blocks with the
   same shape but added, removed, or reordered statements still score high. Token-
   and line-sequence matchers need a contiguous run, so a single insertion splits
   the match. (PMD CPD's `ignore-identifiers` / `ignore-literals` reach Type 2, but
   still match contiguous token sequences — not fuzzy structural overlap.)
2. **Graded, not binary.** The output is a similarity score (default ≥ 0.82), not
   "≥ N identical tokens" — you tune by structural similarity, not run length.

dry-ts does **not** target Type 4 (semantic) clones; it compares structure, not
behavior. What it adds over token/line matchers is the Type-2/Type-3 middle:
same shape, different names, slight variations. That is exactly the class an LLM
produces when it reimplements existing structure — and dry-ts is built for
**agents as the primary consumer** of its output (catching their own
reimplementations, or gating others' in CI), not for humans reading copy-paste
reports.

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
--exclude-tests Skip test files during directory scans: a curated preset of
                **/*.test.*, **/*.spec.*, **/*.e2e-spec.*, **/__tests__/**, and
                **/__mocks__/**, merged into the --exclude glob list (composes
                with any --exclude globs; explicit file arguments still scanned).
                Opt-in, default off; output byte-for-byte unchanged when off.
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
--counterparts  Add, per cluster location, its nearest matching counterpart
                ({index, file, startLine, endLine, shared, total, score}) and —
                under an active change scope (--changed-from/--changed) — a
                per-location "changed" boolean. The nearest is the absolute
                strongest AST-similar partner in the same cluster (intra-cluster
                reference, so --only-new never orphans it). Opt-in, default off;
                off-path output is byte-for-byte unchanged. Note: --only-new
                filters whole clusters, never individual locations or counterparts.
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

### Curating results

Out of the box on a large frontend monorepo a scan can report thousands of
clusters, much of it *expected* duplication — test scaffolding, CSS-in-JS,
generated code. The raw output is a candidate list, not a ranked verdict. Two
things cut it down to the findings that matter:

**Ranking.** Clusters where the *same declaration name* recurs across two or
more distinct files float to the top, tagged `same-name=<name>` in the text
header. A `validateUser` copied into another module is the strongest "real,
copy-pasted duplicate" signal there is — near-zero false positive — so it leads
the report regardless of score. Everything below is ordered strongest score
first, as before. (A name repeated only *within* one file — overloads, shadowed
locals — does not count; cross-file is the signal.)

**The curation footer.** On a large run (≥10 clusters) the text format prints a
short footer to **stderr** that names the levers which would cut the noise and
estimates the reduction:

```text
2574 clusters. Curation levers (see README "Curating results"):
  - 1250 disappear with --exclude-tests (clusters that fall below --min-locations
    once test files are dropped) → ≈1324 left
  - --exclude-tagged-templates drops CSS-in-JS / styled-components clusters
  - --min-nodes N raises the size floor (currently 20); --exclude '<glob>' drops paths
```

It is a teaching aid, not a finding: it goes to stderr (not stdout), so it never
pollutes the findings stream — pipe or redirect stdout and the footer stays out
of it. The `≈` is
honest — the `--exclude-tests` count is estimated from the reported clusters,
not a re-scan, so a removed location that bridged two halves of a cluster can
split it rather than delete it. JSON/EDN output never prints the footer.

The levers themselves, roughly in order of leverage on a frontend codebase:
`--exclude-tests` (test scaffolding is typically about half the noise),
`--exclude-tagged-templates` (CSS-in-JS), `--exclude '<glob>'` (whole paths:
generated code, fixtures, stories), `--min-nodes N` (raise the size floor), and
the kind filters below.

#### Profiles: `--profile NAME`

Rather than rediscover the right flag combination per run, start from a curated
preset. `--profile NAME` seeds a bundle of defaults; any explicit flag you pass
overrides it. Precedence is **explicit flag > profile > built-in default**, and
list flags (`--exclude-kinds`) **union** the profile's entries with yours rather
than replacing them — so `--profile pr --exclude-kinds Constructor` excludes
`ArrowFunction`, `VariableStatement`, *and* `Constructor`.

| Profile | Expands to | For |
| --- | --- | --- |
| `pr` | `--exclude-tests --min-nodes 50 --exclude-kinds ArrowFunction,VariableStatement --only-new --fail-on-duplicates` | PR gate, highest signal. **Requires** `--changed-from`/`--changed` (it sets `--only-new`, which errors without a scope — so it fails loud rather than gating against the wrong base). |
| `src` | `--exclude-tests` | Source-only scan with test scaffolding dropped. |
| `audit` | `--min-nodes 12` | Broad exploratory scan — lower the floor to surface near-misses the default filters out. |
| `tests` | `--exclude-kinds ArrowFunction --min-nodes 40` | Test-*infrastructure* duplication (shared setup/fixtures/builders), explicitly **not** the anonymous arrow bodies that dominate a raw test scan. Point it at your test directories. |

A profile only ever *turns things on* (there is no negation flag to switch one
back off), so each stays at the high-signal defaults its name implies.

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

### Skipping test files: `--exclude-tests`

Test files are the single largest false-positive class in real scans — ~82% of
clusters on a Node/TS backend (n8n `cli/src`), ~49% on a frontend (Sentry). Most
of that is table-driven test cases: identical arrange/act/assert blocks differing
only in data. That repetition is **correct** — test bodies should be DAMP
(descriptive and meaningful) over DRY, so readability and failure-localization
win, and table-driven cases are the sanctioned form. `--exclude-tests` exists to
focus a run on `src` duplication, **not** because test duplication never matters:
real test *infrastructure* dup (builders, factories, custom matchers, shared
setup) is worth its own dedicated scan — just point the tool at the test tree
without this flag.

The flag merges a curated preset (`**/*.test.*`, `**/*.spec.*`,
`**/*.e2e-spec.*`, `**/__tests__/**`, `**/__mocks__/**`) into the `--exclude`
glob list, so it composes with any explicit `--exclude` globs and follows the
same rules (directory scans only; explicitly-named file arguments are always
scanned). Bare `test/` / `tests/` / `e2e/` directories are deliberately left out
of the preset — too many projects use those names for non-test code; add them
with `--exclude '**/test/**'` if your layout needs it. Default **off**; when off,
output is byte-for-byte unchanged.

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

**Limitation — `// dry-ignore` is all-or-nothing and global to that
declaration.** It drops the node as a candidate entirely, including against any
*future* accidental clone of it. There is deliberately no "this particular pair
is intentional, but keep watching each member for *other* clones"
acknowledgment: that would be a stored, fingerprint-keyed baseline, and dry-ts
is stateless by design (no snapshot to drift or rot). The consequence is honest:
for an intentional N-member family (say 18 sibling templates) you either
annotate all N declarations, or — the intended blunt instrument — exclude the
whole path with `--exclude '<glob>'` (or `.gitignore`), accepting that it also
hides any real duplicate that later lands there.

For file- or glob-level ignores, exclude the path via `--exclude`/`.gitignore`
(or `--no-gitignore` to override). Persisting *flags* in config (so you do not
retype `--exclude-tests --min-nodes 40 …` every run) is a separate, planned
convenience — config state, not a findings baseline — and does not exist yet.

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
  src/invoice.ts:12-25 nodes=88 kind=FunctionDeclaration name=renderInvoice
  src/receipt.ts:30-44 nodes=91 kind=FunctionDeclaration name=renderReceipt
```

Under a changed-scope, findings are marked: `status=new (intersects your change)`.
A cluster whose declaration name recurs across files carries a trailing
`same-name=<name>` tag (up to three names, then `(+N)`) and is ranked to the top
— see [Curating results](#curating-results).

Each location carries two diagnostic facts so a reader can classify a finding
without opening the file: `kind` (the candidate root SyntaxKind — `Constructor`,
`InterfaceDeclaration`, `ArrowFunction`, …) and `name` (the declaration
identifier). A `Constructor` is named `constructor`; an anonymous candidate (an
arrow function, a callable signature) has no name — the text format drops the
`name=` token, JSON/EDN report `null`/`nil`.

EDN output:

```clojure
{:clusters
 [{:score-min 0.8909090909090909
   :score-max 0.8909090909090909
   :status :unscoped
   :location-count 2
   :locations [{:file "src/invoice.ts", :start-line 12, :end-line 25, :nodes 88, :kind "FunctionDeclaration", :name "renderInvoice"}
               {:file "src/receipt.ts", :start-line 30, :end-line 44, :nodes 91, :kind "FunctionDeclaration", :name "renderReceipt"}]}]}
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
        { "file": "src/invoice.ts", "startLine": 12, "endLine": 25, "nodes": 88, "kind": "FunctionDeclaration", "name": "renderInvoice" },
        { "file": "src/receipt.ts", "startLine": 30, "endLine": 44, "nodes": 91, "kind": "FunctionDeclaration", "name": "renderReceipt" }
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

The JSON shape is intentionally small and stable: `{ "clusters": ClusterReport[] }`. Each cluster includes a `score` range, a `status` (`"new" | "known" | "unscoped"`), `locationCount`, and grouped `locations`. Each location includes `nodes` (the normalized syntax node count for that duplicated block), `kind` (the candidate root SyntaxKind name), and `name` (the declaration identifier, or `null` when anonymous). `kind` and `name` let an agent triage a finding — e.g. skip a `Constructor` in a `*.spec.ts` as dependency-injection boilerplate — without a second read of the source.

### Nearest-counterpart provenance: `--counterparts`

A cluster's `score` range and member list do not say, for a given location,
*which* member it actually matches and *how strongly* — in a transitive cluster
(>2 members) the range hides the edge structure. `--counterparts` adds that
missing payload: per location, its nearest matching counterpart (the absolute
strongest AST-similar partner in the same cluster) as `{ index, file, startLine,
endLine, shared, total, score }`, plus — under an active change scope — a
per-location `changed` boolean. `index` is the counterpart's position in the same
cluster's `locations` array (an O(1) deref); `file`/`startLine`/`endLine` are the
self-contained reference; `shared`/`total` are the exact pairwise
fingerprint-intersection and union counts; `score` is `shared / total`, the same
similarity value the cluster reports, so you never recompute a float.

```json
{
  "clusters": [
    {
      "score": { "min": 0.8205128205128205, "max": 1 },
      "status": "new",
      "locationCount": 3,
      "locations": [
        {
          "file": "new_a.ts", "startLine": 1, "endLine": 4, "nodes": 41,
          "kind": "FunctionDeclaration", "name": "summarizeRows",
          "nearest": {
            "index": 2, "file": "old.ts", "startLine": 1, "endLine": 4,
            "shared": 34, "total": 34, "score": 1
          },
          "changed": true
        },
        {
          "file": "new_b.ts", "startLine": 1, "endLine": 5, "nodes": 46,
          "kind": "FunctionDeclaration", "name": "reduceEntries",
          "nearest": {
            "index": 0, "file": "new_a.ts", "startLine": 1, "endLine": 4,
            "shared": 32, "total": 39, "score": 0.8205128205128205
          },
          "changed": true
        },
        {
          "file": "old.ts", "startLine": 1, "endLine": 4, "nodes": 41,
          "kind": "FunctionDeclaration", "name": "normalizeRecord",
          "nearest": {
            "index": 0, "file": "new_a.ts", "startLine": 1, "endLine": 4,
            "shared": 34, "total": 34, "score": 1
          },
          "changed": false
        }
      ]
    }
  ]
}
```

Reading this: `new_a` re-implements `old` exactly (`score 1`, a tight pair),
while `new_b` chains in more loosely (`shared 32/39`, `score 0.82`). The
`changed` flag on both sides tells an agent how to route the fix:

- counterpart `changed: true` ⇒ **new/new** — the agent reimplemented itself
  within its own diff; refactor the new code (highest-confidence, lowest-risk fix,
  nothing stable depends on it yet).
- counterpart `changed: false` ⇒ **new/old** — the new code duplicates existing
  code; extract toward the existing definition.

The nearest is always a member of the *same* cluster, so the `index` always
dereferences within that cluster's `locations`, and `--only-new` (which filters
whole clusters, never individual locations or counterparts) never orphans it.
The reported `score`/`shared`/`total` describe the edge between the two **rendered**
locations. (One rare exception: when a location's only structural match is to a
substructure *inside* a larger member — e.g. it matches another declaration's inner
body but not the whole declaration — the counterpart resolves to that enclosing
rendered member, and the score reflects the substructure edge.)

The **full payload** (`index` + `score` included) lives in `json` and `edn`. The
`text` format keeps one scannable line per location and appends an **abbreviated**
counterpart — `→ nearest <file>:<start>-<end> (<shared>/<total>)` — without `index`
or `score`; read `--format json`/`edn` when an agent needs those fields.

Copy-paste recipes:

```bash
# Self-catch: did the block I just wrote re-implement existing structure?
dry-ts --counterparts --json --changed src/foo.ts src test

# Line-precise self-catch against the last commit, gated.
dry-ts --counterparts --only-new --fail-on-duplicates --changed-from HEAD src test

# CI fixer: gate a PR and hand a reviewer/fixer agent the routed JSON.
dry-ts --counterparts --only-new --fail-on-duplicates --changed-from origin/main --json src test
```

On a finding, exit `1` still emits the parseable JSON above on stdout — read it.
Exit `2` is an infra/config failure (see the exit-code table) and must **not** be
read as duplicate findings.

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
2. **Pinned large repositories** — `bun run bench:setup` fetches three pinned
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
   - `n8n-io/n8n` (sparse blobless clone of two subtrees). A large real-world
     Node/TS backend that keeps the corpus from hyper-indexing on frontend code.
     Two complementary scan targets, both checked out by `bench:setup n8n`:
     - `.bench/n8n/packages/nodes-base/nodes` (~3.7k files, ~20 MB) — declarative
       integration nodes with real near-duplicate boilerplate; volume + recall
       and pair-comparison stress. This is the documented default baseline.
     - `.bench/n8n/packages/cli/src` (~1.9k files, ~14 MB) — the server itself
       (controllers, services, entities, queue, auth), representative imperative
       backend app logic. Scan it explicitly with `bun run bench -- <path>`.
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
- n8n 2.25.7 `packages/nodes-base/nodes`: ~3.3s, 1720 clusters (since v0.8.0).
- n8n 2.25.7 `packages/cli/src`: ~2.9s, 1650 clusters (since v0.8.0).
