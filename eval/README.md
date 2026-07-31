# dry-ts labeled evaluation set

Purpose: a labeled corpus that answers one question with a number instead of a
vibe — **how good is dry-ts's ranking at floating real duplicates to the top?**
It is the gate for the "kill the knobs → confidence tiers" work (see the design
doc): a new ranking ships only if it beats the current baseline here.

## What is measured

`precision@k` of the cluster ranking, per corpus, for `k ∈ {5, 10, 20}`:

```
precision@k = (# clusters labeled `real` among the top-k ranked) / k
```

The "ranking" under test is whatever order dry-ts emits clusters in (its JSON
`clusters[]` array). Today that order is **`rankClusters`** (src/Clusters.ts:130):
cross-file-shared-name clusters first, then by descending `maxScore`. This is the
**baseline** any new tier ranking must beat — it is NOT "Jaccard-only."

## Labeling unit and definition

The unit is a **cluster** (a group of locations dry-ts reports as structural
twins). Each cluster is labeled binary:

- **`real`** — accidental reimplementation. A developer reviewing these locations
  would reasonably say "these are the same logic; one reinvents the other and they
  should share code." Same intent; differs only in renamed identifiers / types /
  literals. This is the thing dry-ts exists to catch before it lands.

- **`fp`** — structurally similar but should NOT be flagged for de-duplication.
  De-duplicating would be wrong, pointless, or would force a bad abstraction.

The test is **intent**, not mechanical possibility. "Could this technically be
deduped" is the wrong question. "Is this an accidental reimplementation a reviewer
would want caught" is the right one. When two similar things are *intentionally*
separate, that is `fp`.

### Known false-positive classes (tag the `fpClass` when labeling `fp`)

From prior corpus analysis (sentry: ~49% test files, ~8% styled-components; n8n
cli/src: ~82% test files, DI constructors):

- `test-boilerplate` — distinct test cases / tables / setup that look alike by
  test-framework convention, not reimplemented logic.
- `framework-boilerplate` — DI constructors, lifecycle hooks, trivial
  getters/setters, decorator-mandated shapes.
- `styling` — CSS-in-JS / styled-components template literals, structurally alike
  but visually distinct, no logic to share.
- `data-shape` — interface / type / DTO / enum declarations that share a shape but
  model different domains.
- `declarative-config` — declarative node / route / schema definitions (e.g. n8n
  nodes) similar by spec, not logic worth sharing.
- `coincidental` — small / generic structures (guards, mappers, switch arms) whose
  similarity is incidental; abstracting them would be a net negative.

Borderline calls are forced to a side and given **low confidence** (`< 0.6`) so
they surface for human review.

## Methodology

1. Corpora fetched at pinned tags via `bun run bench:setup sentry n8n` (sparse,
   blobless — `.bench/` is gitignored, so this fixture stores location refs +
   signatures + labels, and is reproducible by re-fetching the pinned tags).
2. Scan the two per-corpus targets to JSON, using the **strict pool**, not the
   permissive default. The default gate (min-nodes 20, min-lines 4) is calibrated
   for clean code (short functions, shallow nesting) and is too sensitive on
   real-world repos — its top is dominated by tiny boilerplate, so measuring it
   mostly re-confirms the known. The strict pool is the realistic "sensible run":

   ```
   FLAGS="--exclude-tests --min-nodes 50 --exclude-kinds ArrowFunction,VariableStatement --format json --counterparts --no-gitignore"
   bun ./dist/bin/dry-ts.js $FLAGS .bench/sentry/static/app    > .bench/eval-raw/strict-sentry.json
   bun ./dist/bin/dry-ts.js $FLAGS .bench/n8n/packages/cli/src > .bench/eval-raw/strict-n8n-cli.json
   ```
   (pass the flags inline — zsh does not word-split an unquoted `$FLAGS`.)
3. Take the **top-20 ranked clusters per corpus** (current `rankClusters` order):
   `node scripts/eval-build-worklist.mjs`. top-20 is fully labeled, so
   `precision@{5,10,20}` is exact.
4. **Label** each cluster: an agent reads the real source at every location and
   applies the rubric above; an independent adversarial agent re-reads and tries
   to **refute** the label. Disagreements are marked `contested` and surfaced for
   human review. Labels are AI-generated pending human spot-check — the scorer
   recomputes from whatever labels live in the fixture, so any label can be flipped
   and the numbers re-derived.
5. A deterministic **`split`** (`train` / `holdout`) is assigned per cluster so the
   later tier-cut-point work fits on `train` and validates on `holdout`, never on
   the same clusters it tuned against.

## Files

- `eval/labels/sentry.json`, `eval/labels/n8n-cli.json` — the labeled clusters.
- `eval/baseline.json` — computed `precision@k` of the current ranking, per corpus.
- `scripts/eval-build-worklist.mjs` — scan JSON → top-20 records + labeling batches.
- `scripts/eval-assemble.mjs` — join records + agent verdicts → `eval/labels/*.json`.
- `scripts/eval-precision.mjs` — scorer: `precision@k` from the fixture (baseline),
  or `--ranking <scan.json>` to score a new ranking (matches by location-set,
  reports coverage@k). Run after any ranking change.

## Reproduce

```
bun run build && bun run bench:setup sentry n8n
# scan strict pool (commands above), then:
node scripts/eval-build-worklist.mjs 100    # top-100/corpus -> .bench/eval-raw/{records,batches}
# label the batches (read source, apply the rubric); write verdicts to
#   .bench/eval-raw/verdicts/batch-<n>.json as [{id,label,confidence,fpClass,reasoning}]
node scripts/eval-assemble.mjs              # -> eval/labels/*.json
node scripts/eval-precision.mjs             # -> eval/baseline.json + printed table
```

Labels here were produced by per-batch agents reading the real source; re-label or
flip any call in `eval/labels/*.json` and re-run the scorer — the numbers re-derive.

## Baseline result (strict pool)

Labeled set: top-100 sentry + all-43 n8n-cli (143 clusters, 92 real / 51 fp).
`precision@k` is measured over the top-20 (fully labeled), per corpus.

| corpus    | precision@5 | precision@10 | precision@20 | dominant FP classes                         |
|-----------|-------------|--------------|--------------|---------------------------------------------|
| sentry    | 0.80        | 0.80         | 0.80         | declarative-config 12, framework-boil. 9    |
| n8n-cli   | 0.20        | 0.50         | 0.50         | framework-boilerplate 15, data-shape 4      |

## Finding

The result splits by corpus, and that split is the whole story:

- **n8n-cli (backend):** `precision@5 = 0.2`. The top is large, identical **DI
  constructors** that `min-nodes` cannot kill (big *and* identical) and that
  `--min-distinct-kinds` cannot kill either (a TS constructor is *syntactically*
  diverse — params, type annotations, `private` modifiers — even though it does no
  work). This is a **mechanical** FP class.
- **sentry (frontend):** `precision@5 = 0.8`. Its residual FPs are
  declarative-config (same-skeleton components with different copy/URLs) and styling
  — the **semantic** kind.

### Signal analysis (which signals separate real from fp, on all 51 fp)

| down-rank signal                  | FP caught | real wrongly sunk | verdict                    |
|-----------------------------------|-----------|-------------------|----------------------------|
| **pure-wiring** (no ctrl/call/op) | 6/51      | **0/92**          | clean, low recall          |
| all-same-kind = Constructor       | 7/51      | 1/92              | clean                      |
| cyclomatic-complexity ≤ 1         | 21/51     | 13/92             | noisy — sinks real dups     |
| literal-divergence (litSim ≤ 0.3) | 25/51     | 16/92             | backfires (see below)      |

- **cyclomatic complexity** has recall but bad precision — branch-free *real*
  copy-pastes exist, so a CC floor sinks them.
- **literal-divergence** separates "same skeleton, different content" FPs from
  verbatim copies, BUT renamed real reimplementations (dry-ts's whole point) also
  have low literal similarity (renamed real dups: litSim median 0.2). It cannot tell
  a config FP from a renamed real dup — only intent differs. **This is the
  irreducible set:** structurally identical, lexically divergent, separable only by
  semantics. A literal filter would re-penalize the core use case.

### Rerank validation (demote, don't eliminate — helps the consuming agent)

Demoting clusters flagged **pure-wiring OR all-Constructor** to the bottom of the
ranking (clean signals only — NOT cc/litSim, which sink real dups):

| corpus  | p@5 base → rerank | p@10 | p@20 | demoted |
|---------|-------------------|------|------|---------|
| n8n-cli | **0.20 → 1.00**   | 0.50 → 0.70 | 0.50 → 0.65 | 8 |
| sentry  | 0.80 → 0.80       | 0.80 | 0.80 | 0 |

n8n's top-5 flips from 3 constructors + 2 real to **5/5 real** — an agent reading
the output hits real dups first. It plateaus at p@20 0.65 because data-shape /
coincidental FPs (which *do* real work) survive — the semantic residual. sentry is
untouched (0 demoted): its FPs are the semantic kind, correctly left as candidates.

### Engine prototype (`--demote-boilerplate`)

The rerank above is a harness. The same demote, implemented in the engine
(`FileScanner.doesRealWork` computes "no control flow / no non-`super` call / no
real operator" from the raw AST; `rankClusters` sinks all-boilerplate clusters),
re-scored via `dry-ts … --demote-boilerplate --format json` + `eval-precision
--ranking`:

| corpus  | p@5 base → engine | p@10 | p@20 | flagged |
|---------|-------------------|------|------|---------|
| n8n-cli | **0.20 → 0.80**   | 0.50 → **0.80** | 0.50 → 0.60 | 9 |
| sentry  | 0.80 → 0.80       | 0.80 | 0.80 | 0 |

The engine uses **only** the principled signal (does-no-work), not the harness's
blunt "all-Constructor" clause — and is *more correct* for it: the real constructor
dup `n8n-cli-9` (which does work) stays in the top, where the harness wrongly sank
it (that's why harness p@5 hit 1.0 — it demoted a real dup too). The one FP left in
the engine's top-5 (`n8n-cli-7`) is a constructor that does a little work — a
borderline/semantic case dry-ts correctly leaves as a candidate. p@10 0.80 > harness
0.70 confirms the principled signal is the better one. `super()` and decorators
(`@Inject(...)`) are skipped so they don't count as work.

### Conclusion

The "kill the knobs → tiers" idea, narrowed by evidence: a full weighted score
(jaccard + cc + diversity) is the wrong tool — jaccard is saturated (every head
cluster scores 1.0), cc and diversity are noisy. The right tool is a small set of
**high-precision demote rules** (pure-wiring + the existing `--exclude-tagged-templates`
for styling, ≈ issue #28). They cleanly fix the mechanical FP class and lift the
agent-facing top-k a lot; the semantic residual is the **candidate set** handed to
the consuming agent/human — by design, not a failure.

So "kill the knobs → confidence tiers" is corpus-specific: for clean-gated frontend
code the gate suffices; for backend DI code one kind-diversity signal would move the
metric most. A full weighted-tier system is not justified by this evidence — a
better default gate plus a single same-kind down-rank signal is.

## Known limitations

- Only the top-N of the *current* ranking is labeled. A future ranking that
  promotes a previously-unlabeled cluster into the top-k will show reduced label
  **coverage** there; the scorer reports coverage so this is visible, not silent.
  Tail sampling is future work.
- Labels are AI-generated with adversarial verification, not hand-curated by a
  domain expert. Treat `contested` and low-confidence labels as provisional.
