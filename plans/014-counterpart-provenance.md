# Plan 014: agent-first nearest-counterpart provenance (supersedes 012; issue #29 item 1 + TODOS pair-provenance)

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result. On any "STOP conditions" item, stop and
> report. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 0.9.0..HEAD -- src/TypeScriptDuplicateFinder.ts src/Clusters.ts src/types.ts`
> This plan assumes `matchingPairs` still emits `[Entry, Entry, score]` edges
> before `ClusterCollector` unions them (`TypeScriptDuplicateFinder.ts:59`), that
> `similarity()` computes a shared-fingerprint count internally
> (`TypeScriptDuplicateFinder.ts:374`), and that every `ClusterLocation` already
> carries `kind`/`name` (PR #38). If any is missing, STOP and reconcile.

## Status

- **Priority**: P2
- **Effort**: M (engine: opt-in pair-edge retention + per-location nearest map; plumbing + 3 renderers)
- **Risk**: LOW-MED (new compute is opt-in and gated; off-path must stay byte-for-byte identical)
- **Depends on**: PR #38 (`kind`/`name` per location — shipped). No dependency on plan 008/012.
- **Supersedes**: plan 012 (`--explain` dominant-kind histogram — REJECTED, see below)
- **Category**: explainability / agent-actionable output (the right half of #29)
- **Issue**: #29 (item 1, reframed per-location), TODOS "Pair-level counterpart provenance"

## Positioning (why this shape, decided 2026-06-14)

dry-ts is an **AI-native** tool: it catches LLMs reimplementing the same *structure*
repeatedly via AST similarity (not exact-string copy-paste). The **primary consumer
of its output is an agent**, in two scenarios:

1. **Self-catch** — an agent runs dry-ts on its own diff (`--changed <files>`) to
   see whether the block it just wrote re-implements existing structure.
2. **CI catch** — `--changed-from main --only-new --fail-on-duplicates --json`
   gates a PR; a reviewer/fixer agent consumes the JSON.

jscpd / PMD CPD / Simian are **token/line** matchers built for humans reviewing
copy-paste; they are **not** the competitive frame, so "show the matched source"
(their table-stakes) is **not** dry-ts's job — an agent already has the file:line
ranges and reads files for free. What an agent **cannot** cheaply recompute is
dry-ts's unique output: *which blocks are AST-similar to which, and how strongly.*
That is the payload to expose.

> **Validated differentiation (not "they can't ignore names").** Token matchers are
> not all rename-blind — PMD CPD's `ignore-identifiers`/`ignore-literals` reach Type 2.
> The honest distinction is **contiguous token-run** matching (Type 1/2) vs. dry-ts's
> **set-based fuzzy Jaccard** over normalized-AST fingerprints (Type 2/3:
> rename- AND reorder-tolerant, graded score). dry-ts owns the Type-2/Type-3 middle —
> the class an LLM produces reimplementing structure. Canonical writeup lives in
> `README.md` → "How dry-ts differs from token and line matchers"; keep this section
> in sync with it.

This supersedes plan 012. 012 proposed a per-location dominant-kind **histogram**,
which describes a single candidate and does not explain the *match*; it steers
toward tuning knobs (`--min-distinct-kinds`/`--min-nodes`) that the n8n FP-class
audit shows have ~0 effect on the residual. Both autoplan CEO voices (Claude +
Codex) rejected its premise 6/6. The histogram was agent-conceived with no user or
real-user investment, so it is dropped rather than salvaged.

## Why this matters

When dry-ts reports a cluster it gives a **score range** and a member list, but it
does not say, for a given location, *which member it actually matches and how
strongly*. In a transitive cluster (>2 members) the score range hides the edge
structure: you cannot tell a tight 0.97 pair from a 0.82-chained transitive member.
An agent fixing "my new block" needs exactly that — "your block at X re-implements
existing Y (shared 44/52)" — to route the finding to **extract** (real) or
**suppress** (`// dry-ignore`, acceptable). Per-location nearest-counterpart
provenance is the minimum that makes the output agent-actionable.

This is the **right half of #29**. #29 item 1 (cluster-level shared-fingerprint
count) was deferred in TODOS as "ill-defined for transitive clusters — which pair's
shared?" Reframing it **per location, as the nearest edge** makes it well-defined: a
location's nearest counterpart is a specific pair, with a specific pairwise
shared/total. The transitive ambiguity disappears.

## Current state

- `matchingPairs(entries, threshold)` builds `MatchingPair[]` = `[Entry, Entry,
  number][]` (`TypeScriptDuplicateFinder.ts:65`), then `clustersFor` feeds each into
  `ClusterCollector.addMatch(clusterLocation(left), clusterLocation(right), score)`
  (`:59`), which union-finds members and keeps only a per-cluster **score range**
  (`Clusters.ts:81-87`). The per-pair edges are discarded after union.
- `similarity(left, right)` (`:374`) walks the two sorted `Float64Array`s and
  computes a `shared` count, but returns only `shared / (a+b-shared)`. The shared
  count we need is already computed — it is just thrown away.
- `addIdenticalFingerprintPairs` (`:246`) emits exact-dup edges with score `1`;
  their `shared` is the full fingerprint length.
- Every counterpart of a location is **in the same cluster** (a pair is unioned into
  one component), so provenance is an **intra-cluster** reference — no cross-cluster
  bookkeeping.
- `clusterLocation(entry)` (`:231`) is the Entry→ClusterLocation bridge where new
  per-location fields are attached (as `kind`/`name` are today).

## Naming

Use `--counterparts` for the flag (agent reads "show me each location's
counterpart"). **Both DX voices confirmed it**; thread the **same word**
end-to-end (flag, `Options.counterparts`, the internal param) — do NOT use
`provenance` internally (one stray remains in this plan; fixed). `--nearest` is the
only acceptable fallback (more precise iff GATE B picks absolute-nearest, B1).
**Rejected: `--provenance`** (both voices — implies git-blame/supply-chain origin,
mis-sells a structural-similarity fact) and `--why` (collides with the deferred
"would be suppressed by X" routing). Distinct from existing `--explain-changed`
(stderr debug) and the rejected `--explain`. Note: no parse collision with
`--only-new`, but docs MUST state `--only-new` filters **clusters**, not locations
or counterparts.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Test | `bun run test` | exits 0 |
| Full gate | `bun run check` | exits 0 |
| Off-path bench | `bun run bench -- src test` | no regression vs pre-change |

## Scope

**In scope**: `src/Options.ts` (the `counterparts` flag), `src/TypeScriptDuplicateFinder.ts`
(inline `nearestByLocationKey` map + post-`clusters()` join, gated), `src/Clusters.ts`
(**export `compareLocations`** for the tie-break), `src/DryTs.ts` (USAGE + 3
renderers + per-location `changed` at the `reported`/`statusFor` pass, GATE C),
`src/types.ts` (`ClusterLocation.nearest?` + `ClusterLocation.changed?`), README,
`test/dry-ts.test.ts`, `plans/README.md`, `skills/*/SKILL.md` +
`skills/_artifacts/skill_tree.yaml`.

**Explicitly NOT touched**: `FileScanner.scanFiles` — provenance is a clustering-phase
concern, not a scan-phase one; do not add a scanner positional.

**Out of scope**: top-K counterparts per location (MVP is the single nearest), the
"would be suppressed by X" routing engine (separate follow-up), shared-core /
span-level diff highlighting (needs node→span retention — separate follow-up),
source-snippet emission (an agent reads files itself).

**Accepted debt (called out, not fixed here):** `Options` already has 18 positional
constructor params (`Options.ts:26-45`); `counterparts` is a 19th, and it sits among
three adjacent **booleans** (`excludeTaggedTemplates`/`excludeTests`/`counterparts`)
that `tsc` cannot tell apart on transposition. MVP mitigates with the Step-6 ordering
pin test. The real fix — an internal options object/builder — is too big to smuggle
into this plan; **file it as a follow-up** (see TODOS / a new plan).

## Git workflow

- Branch `advisor/014-counterpart-provenance` (or continue on `advisor/012-explain`,
  renamed). Do not push or open a PR unless instructed.

## Design decisions (decide before coding)

> **Both autoplan eng voices (Claude + Codex) converged on the same required pivot:**
> *inline per-location nearest aggregation keyed by the canonical location key* — NOT
> retain-all-edges + attach-via-`clusterLocation`. The decisions below encode that.

1. **Inline running-max keyed by `locationKey`, joined AFTER `clusters()`.**
   `ClusterCollector.add` (`Clusters.ts:52-64`) dedupes locations by
   `locationKey = file:start-end` and may **replace** the stored `ClusterLocation`
   with a higher-`nodes` Entry. So attaching `nearest` to the per-`Entry`
   `clusterLocation(entry)` object (`:231`) attaches to throwaway objects and risks a
   record whose `nodes`/`kind` come from one Entry but whose `shared` describes
   another (it could even report `shared` > the rendered location's own fingerprint
   count — a corrupt, agent-misleading fact). **Instead:** maintain
   `nearestByLocationKey: Map<string, Nearest>`, update it for **both endpoints** as
   each accepted pair is found, then in a post-pass over `collector.clusters()` look
   up each canonical location by its key and produce a `ClusterLocation` with
   `nearest` set. `O(locations)` extra memory, not `O(edges)` — no hidden memory
   multiplier on large transitive clusters.

   > **Implementation correction (post-ship hardening, Codex adversarial).** Keying
   > the running-max by `locationKey` alone is **insufficient**: when nested candidate
   > roots share one line-based key (a one-line `const x = (…) => …` emits both a
   > `VariableStatement` and its inner `ArrowFunction` at the same `file:start-end`),
   > merging *all* their edges under one key leaks a non-rendered sibling's score onto
   > the rendered (max-nodes) location — on **either** endpoint. The shipped engine
   > therefore aggregates nearest in a post-pass over the full edge set
   > (`aggregateNearest`): it derives the canonical **entry** per key by identity,
   > mirroring `ClusterCollector`'s keep-rule exactly (strictly-greater nodes,
   > first-wins on ties, same add order), and selects nearest only over
   > canonical↔canonical edges, with a throw-safe fallback for the rare orphan whose
   > only edges reach non-canonical sub-nodes. Two regression tests lock both sides.
2. **Per-location single nearest** (top-K deferred), defined by a **total**,
   explicit tie-break to kill float-score ambiguity: **max `score`, then max
   `shared`, then min `total`, then `compareLocations`(counterpart)**, applied with
   **strict-greater replacement** (`>`, never `>=`, so iteration order never leaks).
   `compareLocations` is currently private in `Clusters.ts:115` — **export it** (or a
   shared location comparator) rather than duplicate it.
3. **Nearest payload shape** (DX-reviewed): `{ index, file, startLine, endLine,
   shared, total, score }`.
   - `file`/`startLine`/`endLine` are the primary, self-contained reference (stable
     even if a consumer reshapes the locations array — both DX voices insisted on
     keeping these).
   - `index` = the counterpart's position in the **same cluster's** `locations`
     array, as an O(1) deref convenience for an agent that already holds the array.
     Added alongside file/range, not instead of it.
   - `shared`/`total` are the exact-integer truth: `total = aFP.length + bFP.length
     - shared`, computed from the **pairing Entries' fingerprint arrays at edge
     time** — never recomputed from the rendered `location.nodes` (which is node
     count, not fingerprint-array length).
   - `score = shared/total` is kept deliberately (not dropped as redundant): it is
     the canonical similarity value agents sort/filter on, matching the cluster-level
     `score`, so a consumer never recomputes a float. Documented redundancy.
   - **2-member clusters keep a symmetric `nearest`** (both DX voices: simple and
     predictable beats conditional presence — uniform shape is easier to parse than
     "present only when locationCount > 2").
4. **Opt-in, zero default cost — and no `nearest` property at all when off.**
   Without `--counterparts`, build no map and **do not create a `nearest: undefined`
   field** on `ClusterLocation` objects (programmatic `findClusters()` consumers
   observe own properties; the object shape must stay byte-identical, not just the
   JSON). The pairs are walked during clustering regardless; the *added* cost (the
   shared count + the per-key map) is gated behind the flag. **A join miss is a bug**,
   not an omission: every location in a rendered cluster was unioned via ≥1 edge, so
   it must carry `nearest`. Do not silently drop it; if a future location-level filter
   ever creates a genuine no-counterpart case, emit `nearest: null` with a reason,
   never absence (Codex DX).
5. **Intra-cluster reference.** The counterpart is always a member of the same
   cluster (a pair is unioned into one component), so `--only-new` filtering (which
   filters whole **clusters**, not locations) never orphans it. Assert as a tested
   done-criterion: every emitted `nearest` resolves to a location present in the same
   rendered cluster, under ALL filter combinations (`--only-new`, `--min-locations`,
   changed-scope). The `index` field makes this self-enforcing (a non-dereferenceable
   index is an immediately-caught bug).

### GATE DECISION A — exact-duplicate-group nearest → **RESOLVED: A1** (user, 2026-06-14)

`addIdenticalFingerprintPairs` (`:246`) emits only **N-1 connector edges** (a spanning
tree), not the full clique (`dry-ts.test.ts:551`), so "nearest among emitted edges"
would be topology-dependent and arbitrary. **Decision: compute the true nearest within
the identical group** — all members are score-1, so pick the counterpart by
`compareLocations` among ALL group members. Intuitive, deterministic, a few extra lines
in the identical-group path. (Rejected A2 "nearest among emitted edges" as
agent-surprising.)

### GATE DECISION B — `--only-new` nearest semantics → **RESOLVED: B1, absolute nearest** (user, 2026-06-14)

A changed location's max-score nearest may be **another changed location**. The two DX
voices split (B1 absolute vs B2 prefer-old). **Decision: B1 — report the absolute
strongest structural match regardless of new/old.** It is a measurement tool; it must
not hide what is closest.

**Key rationale (user):** a **new/new** match is not a weakness of B1 — it is the
*strongest* actionable signal. It means the agent reimplemented itself within its own
diff, which is the **highest-confidence, lowest-risk fix**: the duplicated code is new,
nothing stable depends on it yet, so it is the easiest to refactor. B2's "prefer-old"
would actively *hide* the best catch. So: absolute nearest, no policy baked into the
field, field stays `nearest`, flag stays `--counterparts`. The new/old distinction the
agent needs to prioritize comes from per-location `changed` (GATE C), **not** from
biasing the nearest pick. (B1's separate `counterpartIsNew` tag is therefore dropped —
subsumed by C1: the agent reads `changed` on the counterpart's own location.)

### GATE DECISION C — per-location `changed` state → **RESOLVED: C1, include now** (user, 2026-06-14)

`--changed-from --only-new` exposes only **cluster-level** `status: "new"`, so an
autonomous fixer cannot tell **which location** to edit. **Decision: add a per-location
`changed: boolean`** to `ClusterLocation`, computed from the same changed-scope
intersection `statusFor` already does (`DryTs.run:222`) but **per location** instead of
per cluster. Gated behind `--counterparts` **and** an active change scope (no scope ⇒
`changed` omitted, like cluster `status: "unscoped"`); this keeps the default path and
existing `--changed`-without-`--counterparts` output byte-identical. With B1 + C1 the
agent sees both sides' `changed`: counterpart `changed:true` ⇒ new/new (refactor the
new code, easiest); counterpart `changed:false` ⇒ duped existing old code. Full info,
agent routes. See Step 4.5.

## Steps

### Step 1: Surface the shared count from the single similarity walk

Have the pair loop capture the `shared` count from the **one** walk `similarity`
already does (refactor `similarity` to return `{ score, shared }` internally, or
capture `shared` in `matchingPairs`). Do **not** add a second `sharedCount` walk —
done criteria forbid a second similarity pass. The threshold test
(`TypeScriptDuplicateFinder.ts:122`) must keep comparing the **bit-identical** float
it computes today: do not reorder the arithmetic (no recomputing `score` as
`shared/total` with a differently-formed `total`). See STOP conditions.

**Verify**: `bun run test` → exits 0 (no output change yet).

### Step 2: Thread `counterparts: boolean`; aggregate nearest inline by location key

Thread `counterparts` from `Options` → `TypeScriptDuplicateFinder.scan` →
`clustersFor`/`matchingPairs`. This feature is computed entirely in
`TypeScriptDuplicateFinder`/`Clusters` — **do NOT touch `FileScanner.scanFiles`**
(no scanner positional). When on, maintain `nearestByLocationKey: Map<string,
Nearest>` and, for each accepted pair (both the similarity pairs and the score-1
edges from `addIdenticalFingerprintPairs`), update the entry for **both** endpoints'
`locationKey` using the strict-greater tie-break from Design Decision 2. When off,
build no map and do exactly what the code does today.

**Verify**: `bun run test` → exits 0.

### Step 3: Join nearest onto the canonical locations (post-`clusters()`)

Add `nearest?: { index: number; file: string; startLine: number; endLine: number;
shared: number; total: number; score: number }` to `ClusterLocation` in `types.ts`
(optional, like `kind`/`name`). In a post-pass over `collector.clusters()`, for each
canonical location look up `nearestByLocationKey.get(locationKey(loc))`, resolve the
counterpart's `index` within that cluster's `locations` array, and **only when
present** return a `ClusterLocation` carrying `nearest`. When the flag is off, do
not add the property at all (Design Decision 4). Resolve GATE DECISION A for the
exact-dup-group path before coding this step.

**Verify**: `bun run test` → exits 0.

### Step 4: Add `--counterparts` to Options

Add `counterparts` to `OptionsInput`/`Options`/`parse` (boolean, positional field
appended at the end, default `false`), mirroring `excludeTests`. Thread into the scan.

**Verify**: `bun run test` → exits 0.

### Step 4.5: Per-location `changed` under an active scope (GATE C / C1)

Add `changed?: boolean` to `ClusterLocation` (`types.ts`). When `--counterparts` is on
**and** a change scope is active, set `changed` per location from the same intersection
`statusFor` uses (`DryTs.run:222`) — intersect **each** location's range with the
changed regions, instead of the per-cluster "any location intersects" reduction. When
no scope is active, or the flag is off, do **not** add the property (preserves
byte-identical default and existing `--changed`-without-`--counterparts` output).
This is a `DryTs.run`-layer concern (it owns the scope); compute it where `reported`
is built (`:118-121`), not in the engine.

**Verify**: `bun run test` → exits 0.

### Step 5: Render in all three formats

- **text**: when present, append the counterpart to the location's **own line**
  (keep one line per location — a per-location *sub-line* doubles vertical density
  and breaks the scannable format on large transitive clusters, per DX). E.g.
  `src/a.ts:10-40 nodes=52 kind=InterfaceDeclaration changed=true → nearest src/b.ts:5-33 (44/52)`.
  Omit the `changed=…` token and the `→ nearest …` suffix when their values are
  undefined.
- **json**: add `nearest: { index, file, startLine, endLine, shared, total, score }`
  and (when set) `changed: boolean` per location object; `JSON.stringify` drops both
  when undefined — verify (and confirm the off path never sets either property; see
  Design Decision 4).
- **edn**: build the location fields **independently** — base fields, then optional
  `:kind`/`:name`, optional `:changed true|false`, then optional `:nearest {:index N
  :file "..." :start-line N :end-line N :shared N :total N :score F}`. `locationEdn`
  (`DryTs.ts:281`) currently **early-returns when `kind` is undefined**; do NOT nest
  the new fields inside that branch or they silently drop for synthetic/API locations.
  Refactor to append each optional group separately.

**Verify**: `bun run check` → exits 0.

### Step 6: Tests

- Two-member exact-dup pair with `--counterparts`: each location's `nearest` points
  at the other, `shared == total`, `score == 1`.
- A ≥3-member **transitive** (similarity) cluster: the nearest edge for a member is
  its **highest-score** partner, not an arbitrary one; determinism stable across runs.
- A ≥3-member **identical-fingerprint** group (exercises `addIdenticalFingerprintPairs`'
  spanning-tree edges, not a clique): each member's `nearest.score === 1`,
  `shared === total`, counterpart is another group member — per the resolution of
  GATE DECISION A.
- **Same-`locationKey` collision** (forces the `nodes` tie-break replacement at
  `Clusters.ts:59`): the rendered location's `nearest`/`shared`/`total` are
  self-consistent — `shared <=` the rendered location's own fingerprint count, and the
  counterpart is a real same-cluster member. (This is the A1/C1 regression test.)
- **No undefined leak:** in a `--counterparts` run, assert **no** location in a
  rendered cluster has `nearest === undefined` (catches a join miss).
- **Default (no `--counterparts`) shape byte-for-byte identical:** an existing
  cluster fixture's text/json/edn is unchanged AND the `ClusterLocation` objects from
  `findClusters()` carry **no `nearest` own-property** (not even `undefined`).
- **`--only-new` + `--counterparts`, new/new/old cluster (GATE B=B1, GATE C=C1):**
  each location carries `changed` (the two new locations `changed:true`, the old one
  `changed:false`); a new location's `nearest` is the **absolute** max-score
  counterpart even when that is the **other new** location (B1 — assert it is NOT
  forced to the old one); `nearest.index` dereferences to a location present in the
  same printed cluster.
- **Per-location `changed` gating:** with a change scope active but **without**
  `--counterparts`, no location carries `changed` (byte-identical to today's
  `--changed` output); with no scope at all, `changed` is absent even under
  `--counterparts`.
- **Options ordering pin:** `Options.parse("--counterparts").counterparts === true`
  AND `Options.parse().counterparts === false && .excludeTests === false` — guards
  against a silent transposition of the three adjacent booleans (see Scope).

**Verify**: `bun run check` → exits 0.

### Step 7: Docs + skill bundle

- `--counterparts` in USAGE and README, agent-first. The README is the contract for
  an agent-first tool, so **show literal output**, not prose promises (DX, both
  voices): include one literal JSON block of a **>2-member** cluster with `nearest`
  populated (the transitive case the feature exists for), placed in the README's AI
  Agents section.
- **Copy-paste recipes for both scenarios** (DX, both voices):
  - self-catch: `dry-ts --counterparts --json --changed src/foo.ts src test`
  - line-precise self-catch: `dry-ts --counterparts --only-new --fail-on-duplicates --changed-from HEAD src test`
  - CI fixer: `dry-ts --counterparts --only-new --fail-on-duplicates --changed-from origin/main --json src test`
- **Document the exit-code contract** an agent depends on: exit `1` still emits
  parseable JSON on stdout (findings); exit `2` is infra/config failure and must NOT
  be read as duplicate findings. State that `--only-new` filters **clusters**, not
  locations or counterparts.
- **Bump the skill bundle** (CLAUDE.md "Releasing" step 2): a new CLI flag drifts
  `skills/*/SKILL.md` (`library_version` + the flag) and `skills/_artifacts/
  skill_tree.yaml` (`version`) silently. Update them in this PR.

**Verify**: `bun run check` → exits 0.

## Done criteria

- [ ] `--counterparts` adds per-location nearest counterpart (`index` + file/range +
      shared/total/score) in text/json/edn; nearest is the **absolute** max-score
      partner (B1), `index` dereferences within the same cluster.
- [ ] Exact-dup groups: nearest is the true nearest among ALL group members (A1),
      `compareLocations`-stable.
- [ ] Under `--counterparts` + an active change scope, each location carries
      `changed` (C1); a new/new dup is reported as the nearest when it is the strongest
      (not forced to old code).
- [ ] Flag off → output byte-for-byte identical (no `nearest`/`changed` own-property);
      `--changed` without `--counterparts` also unchanged. No edge retention, no map.
- [ ] Nearest is computed without a second similarity pass (reuses the shared count
      from the existing pair walk); threshold float stays bit-identical.
- [ ] An agent can read a "new" finding, see `changed` on both sides, and route it
      (new/new → refactor the new code; new/old → extract toward existing).
- [ ] `bun run test` and `bun run check` exit 0; off-path bench unchanged.
- [ ] `plans/README.md` updated: 012 REJECTED-superseded, 014 DONE; #29 item 1 noted.
      Skill bundle bumped.

## STOP conditions

- `matchingPairs` no longer emits per-pair edges, or `similarity` no longer computes
  a shared count (the engine assumptions above are gone).
- The threshold-comparison float (`TypeScriptDuplicateFinder.ts:122`) is no longer
  bit-identical to today's after the Step-1 refactor — this can silently add/drop a
  borderline pair and break byte-identical off-path output. Hard STOP.
- The off path (no `--counterparts`) measurably regresses `bun run bench`.
- Default-output-unchanged test fails — any new field/line leaks without the flag,
  OR a `ClusterLocation` from `findClusters()` gains a `nearest` own-property when the
  flag is off.
- A verification command fails twice after a reasonable fix.

## Findings deferred (out of scope, on purpose)

- **Top-K counterparts** per location — MVP is the single nearest; revisit if agents
  ask for the full edge list.
- **"Would be suppressed by X" routing** — per-cluster exact finite-knob predicate
  pass (which flag would drop this cluster). Real value for the suppress route, but
  separable; file as a follow-up after provenance lands.
- **Shared-core / structural-diff highlighting** — mapping the shared fingerprints
  back to source spans to mark "extract this / this varies." The deepest refactor
  aid, but needs opt-in node→span retention during the scan (currently discarded for
  perf). Separate plan.

## Maintenance notes

- Off-path discipline mirrors plan 008/038: the only added-when-on cost is the
  shared count + the per-location `nearestByLocationKey` map, both gated behind
  `counterparts`. Compute nearest inline (running-max), never retain the full edge list
  (Design Decision 1).
- `nearest` is additive and optional on `ClusterLocation`, like `kind`/`name`; the
  stable JSON shape contract is preserved (existing fields untouched).

---

## GSTACK REVIEW REPORT

_/autoplan 2026-06-14, branch `advisor/012-explain`. Phase 1 (CEO) drove the pivot
from rejected plan 012 to this plan; Phase 3 (Eng) hardened the engine design below.
Phase 2 (Design) skipped — no UI scope. Phase 3.5 (DX) + Phase 4 gate follow._

### Phase 3 — Eng dual voices

```
ENG DUAL VOICES — CONSENSUS TABLE
  Dimension                     Claude  Codex   Consensus
  1. Architecture sound?        Partial Partial CONFIRMED-PARTIAL
  2. Test coverage sufficient?  No      Partial CONFIRMED-NO
  3. Perf risks addressed?      Partial Partial CONFIRMED-PARTIAL
  4. Determinism preserved?     Partial Partial CONFIRMED-PARTIAL
  5. Off-path invariant safe?   Yes(+1) Partial CONFIRMED-PARTIAL
  6. Deployment/scope risk?     Partial Partial CONFIRMED-PARTIAL
```

Both voices: **direction sound, NOT approvable as originally written.** Required
pivot (now baked into Design Decisions 1-5 + Steps 1-3): *inline per-location nearest
aggregation keyed by the canonical location key.* CONFIRMED findings, all folded in:

- **Attach point (high, both):** per-`Entry` `clusterLocation` attach fights
  `ClusterCollector`'s per-`locationKey` dedup (keeps max-`nodes` Entry) → could
  report `shared` > the rendered location's own fingerprint count. Fix: key by
  `locationKey`, join after `clusters()`. → Design Decision 1, Step 3.
- **Memory (med, both):** retain-all-edges is `O(edges)`; inline running-max is
  `O(locations)`. → Design Decision 1, Step 2.
- **Determinism (med, both):** float-score ties (esp. score-1 exact dups) need a
  total tie-break with strict-greater replacement; `compareLocations` is private →
  export it. → Design Decision 2.
- **Off-path (med, both):** capture `shared` in the single existing similarity walk;
  threshold float must stay bit-identical (hard STOP). Don't create `nearest:
  undefined` own-property when off (API-shape contract, not just JSON). → Step 1,
  Design Decision 4, STOP conditions.
- **Exact-dup groups (high, Codex / med, Claude):** `addIdenticalFingerprintPairs`
  emits an N-1 spanning tree, not a clique → "nearest among emitted edges" is
  arbitrary. → GATE DECISION A (surfaced).
- **`--only-new` semantics (med, Codex):** a new location's max-score nearest may be
  another new location, contradicting the "reimplements existing Y" story. → GATE
  DECISION B (surfaced).
- **Renderer EDN early-return (low, Codex):** `locationEdn` returns early when `kind`
  is undefined → build optional groups independently. → Step 5.
- **19th positional `Options` param (high, both):** three adjacent transposable
  booleans, `tsc`-invisible. → Scope "Accepted debt" + Step-6 ordering pin; don't
  touch `scanFiles` (Codex). Options-object refactor filed as follow-up.

Two items NOT auto-decided (reasonable people could disagree) → final gate:
**GATE DECISION A** (exact-dup nearest) and **GATE DECISION B** (`--only-new`
nearest semantics).

### Phase 3.5 — DX dual voices (agent is the primary output consumer)

```
DX DUAL VOICES — CONSENSUS TABLE
  Dimension                       Claude  Codex   Consensus
  1. Output ergonomics for agents 6/10    Partial CONFIRMED-PARTIAL
  2. Naming / discoverability      8/10    Agree   CONFIRMED (--counterparts; reject --provenance)
  3. Scenario coverage             5/10    Partial CONFIRMED-NO (recipes + literal JSON missing)
  4. Error / empty states          6/10    Partial CONFIRMED-PARTIAL
  5. Consistency                   7/10    Partial CONFIRMED-PARTIAL
```

CONFIRMED (folded into the plan above):
- **`index` into `locations`** added to `nearest` (alongside file/range, not
  instead — Claude wanted it, Codex okayed it as an addition). O(1) deref for agents.
- **Keep `score`** (Codex strong: canonical sort key; Claude allowed as documented
  redundancy). Kept, documented.
- **Uniform `nearest` on 2-member clusters** (both: simple/predictable > conditional).
- **Join miss = bug; `nearest: null` + reason only for a future location-filter**
  (Codex); dangling-ref invariant now a tested done-criterion (both).
- **`--counterparts` locked; `--provenance` rejected** (both); fixed the stray
  internal `provenance` Codex caught (`:345`).
- **README must show literal JSON + copy-paste recipes for both scenarios; document
  exit-1-still-emits-JSON / exit-2-is-infra** (both). → Step 7.
- **Text: counterpart on the location's own line**, not a sub-line (Claude) → Step 5.

DISAGREEMENT / scope (→ final gate):
- **GATE DECISION B** — Claude DX = **B1** (absolute nearest + `counterpartIsNew`
  tag); Codex DX = **B2** (old-preferred `counterpart` field). Genuine split.
- **GATE DECISION C** — both flagged that the CI agent needs per-location `changed`
  state (cluster-level `status:new` is insufficient to know which block to edit).
  Include now (boil-the-lake, subsumes B1's tag) or defer.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale |
|---|-------|----------|----------------|-----------|-----------|
| 1 | CEO | Reject 012, pivot to agent-first counterpart provenance | USER CHALLENGE → user-locked | n/a | Both CEO voices 6/6; user locked the reframe |
| 2 | CEO/positioning | Correct "exact string matchers" overclaim; PMD CPD reaches Type 2 | Mechanical | P5 | Fork-validated against sources; token-run vs fuzzy-Jaccard is the honest line |
| 3 | Eng | Inline nearest map keyed by locationKey, join post-clusters() | Mechanical | P5,P3 | Both eng voices; fixes the dedup/attach mismatch |
| 4 | Eng | Single similarity walk; threshold float bit-identical (STOP) | Mechanical | P1 | Both eng voices; protects off-path invariant |
| 5 | Eng | Total tie-break + strict-greater; export compareLocations | Mechanical | P5 | Both eng voices; kills float-tie nondeterminism |
| 6 | Eng | No `nearest:undefined` own-property when off | Mechanical | P5 | Codex; API-shape contract for findClusters() consumers |
| 7 | Eng | Don't touch FileScanner.scanFiles | Mechanical | P3 | Codex; provenance is a clustering concern |
| 8 | Eng | 19th positional debt: pin test now, options-object refactor deferred | Taste→pragmatic | P3,P6 | Both flag debt; refactor too big to smuggle |
| 9 | Eng/gate | Exact-dup-group nearest → **A1** true nearest among all members | TASTE → user | n/a | GATE A resolved by user 2026-06-14 |
| 10 | Eng+DX/gate | `--only-new` nearest → **B1** absolute nearest, no policy baked | TASTE → user | n/a | GATE B resolved; user: new/new is the *strongest* signal (easiest, safest fix) — drop counterpartIsNew, subsumed by C1 |
| 11 | DX | Add `index` into locations to `nearest` | Mechanical | P1,P5 | Both DX; O(1) agent deref alongside file/range |
| 12 | DX | Keep `score` in JSON/EDN | Mechanical | P3 | Codex strong (canonical sort key); Claude allowed |
| 13 | DX | Uniform `nearest` on 2-member clusters | Mechanical | P5 | Both DX; uniform shape easier to parse |
| 14 | DX | Counterpart on location's own text line | Mechanical | P5 | Claude DX; preserves one-line-per-location |
| 15 | DX | README literal JSON + recipes + exit-code doc | Mechanical | P1 | Both DX; output example IS the contract |
| 16 | DX/gate | Per-location `changed` → **C1** include now | TASTE → user | n/a | GATE C resolved by user 2026-06-14; gives B1 the new/old signal |
