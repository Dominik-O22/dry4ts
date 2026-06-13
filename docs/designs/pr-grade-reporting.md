---
status: REVIEWED
---
# Plan: PR-grade reporting (GitHub + GitLab)

Branch: main | Repo: Dominik-O22/dry4ts
Origin: TODOS.md D4 ("PR-grade reporting"), extended to GitLab per user direction
("github for GA, gitlab because at work we use gitlab").

## Problem

dry-ts emits `text` / `json` / `edn`. None of these render as inline
annotations in a pull/merge request. A CI run that finds new duplication
(`status: "new"`) exits 1, but the developer must read raw CLI logs to find
*where*. The counterpart location is in the output, but not surfaced on the
diff line that introduced the duplication.

The incremental-gating plan (shipped v0.4.0) already computes everything
needed: per-cluster `status` and every location's `file:startLine-endLine`.
Only formatters are missing.

Two CI platforms matter, equally:
1. **GitHub** — general-availability target, public users.
2. **GitLab** — the user's workplace CI.

## The asymmetry (the core design decision)

GitHub and GitLab expose inline annotations through different channels:

- **GitHub Actions** reads *workflow commands* from a step's **stdout**:
  `::error file={path},line={n},endLine={m},title={t}::{message}`
  The runner renders each as a **check annotation** on the Files-changed tab +
  Checks summary — NOT a threaded PR review comment. Ephemeral, no file
  artifact. Limit: **10 error annotations per step** (GitHub Actions cap).

- **GitLab CI** has **no stdout-annotation channel**. Inline MR annotations
  come from a **Code Quality report**: a JSON file in CodeClimate format,
  declared as `artifacts: reports: codequality: <file>`. Each finding needs a
  stable `fingerprint`, `location.path`, `location.lines.begin`, `severity`,
  and `description`. GitLab diffs the report against the target branch and
  renders new findings inline.

So "support both" cannot be one symmetric stdout format. GitHub is a stdout
command stream; GitLab is a structured JSON document.

## Chosen approach

Two new `OutputFormat` members, both written to **stdout** (consistent with
every existing formatter — pure string in, `console.log` out, no file IO in
the formatter):

- `--format github` → one `::error::` workflow command per finding location,
  on stdout. CI step needs no redirection.
- `--format gitlab` → a CodeClimate-format JSON array on stdout. The
  `.gitlab-ci.yml` recipe redirects it to `gl-code-quality-report.json` and
  declares it under `artifacts:reports:codequality`.

Keeping GitLab on stdout (redirected by the recipe) rather than adding a
`--report-file` flag preserves the existing "formatters are pure, IO lives in
DryTs" boundary and avoids new CLI surface. Documented in the recipe.

### What gets emitted (resolved at Phase-1 gate)

**Goal (user):** auto-create MR/PR comments with code references, annotating
**only the changed hunks** — never the whole cluster or old counterpart code,
to avoid PR scope-creep / noise.

- Only `status: "new"` clusters are findings. Within a finding, annotate **only
  the location(s) whose line-range intersects the changed scope** (the changed
  hunk), not every copy. A cluster's other locations (the counterparts you
  duplicated) are named in the comment/message *text*, never annotated as
  separate diff comments.
- `known` / `unscoped` clusters produce no annotations — PR-grade is about this
  change.
- GitLab semantics (gate decision): **change-scoped, dry-ts owns the diff** —
  emit CodeClimate entries only for changed-hunk findings, NOT a full-codebase
  report for GitLab to diff. One mental model across both platforms; pair the
  format with `--changed-from` in the recipe.
- No active scope (all `unscoped`): emit nothing actionable — GitHub: no
  commands; GitLab: `[]` (valid empty CodeClimate report).
- Annotation cap (anti-spam): cap emitted annotations (e.g. 50) with an
  overflow summary line; exact cap set in Eng review.

- **GitHub**: emit one `::error::` per **changed** location of each finding
  (a location whose line range intersects the changed scope), never per copy.
  `title` = `dry-ts: duplicate code`. `message` lists the cluster's **other**
  locations as candidate counterparts (see counterpart wording below). Escaping
  uses **two distinct tables** (GitHub Actions spec):
  - message/data (after `::`): `%`→`%25`, `\r`→`%0D`, `\n`→`%0A`, `%` first.
    `:` and `,` are NOT escaped here (escaping `:` would render `%3A` in text).
  - property values (`file=…`, `title=…`): the three above **plus** `,`→`%2C`
    and `:`→`%3A`. Without this a path like `src/a,b.ts` truncates the property
    list and the annotation points at the wrong file.

- **GitLab**: emit one CodeClimate entry per **changed** location of each
  finding. Required fields: `description`, `check_name` (e.g.
  `dry-ts/duplicate-code`), `fingerprint`, `severity` (`major`),
  `location.path` (repo-relative), `location.lines.begin` (startLine).
  `fingerprint` = hash of a **versioned, line-independent structural key**
  (`v1:` prefix + the location's normalized fingerprint set), NOT start/end
  lines — so a comment inserted above the block shifts `lines.begin` but keeps
  `fingerprint` stable, and GitLab does not re-flag the whole backlog.

**Counterpart wording (both eng voices):** clusters are transitive components
(A–B–C: A may not directly match C), and pair provenance is discarded in the
finder. So the message says **"candidate counterparts in the same duplicate
cluster"**, never "the counterpart". Exclude the annotated location, sort
deterministically, cap with `+N more`. If the changed scope covers every
location (whole-file change), there are no counterparts — the message degrades
to "duplicates code elsewhere in this change" with no empty list.

**Annotation cap is platform-specific:** GitHub caps at **10** `::error` per
step (Actions limit — not 50); on overflow emit a trailing `::notice::` summary.
GitLab MUST stay a valid CodeClimate JSON array — truncate deterministically and
note truncation inside a finding `description`, never an out-of-schema object.

**Anchor line (both DX voices, critical):** a duplicated block spans many lines
but a change may touch only one inside it. Anchoring the annotation at the
block's `startLine` can land *outside* the rendered diff hunk → GitHub silently
drops the annotation. The report layer must carry the **first changed line
inside the location** (`annotationLine`); GitHub `line=`/GitLab
`location.lines.begin` use that, while the message still names the full
duplicate span.

### Composition with existing flags

- `--format github|gitlab` is orthogonal to `--fail-on-duplicates` and the
  changed-scope flags. Typical CI: `--format github --fail-on-duplicates
  --changed-from origin/main` → annotations on stdout AND exit 1 on findings.
- Without a changed scope, there are no `new` clusters → no annotations. The
  recipe always pairs the format with `--changed-from`.

## Accepted scope (this plan)

- `OutputFormat` union gains `"github" | "gitlab"` (src/types.ts). Switch in
  DryTs.run stays compile-time exhaustive.
- `formatValue` (Options.ts) accepts `github` / `gitlab`. No new alias flags
  (`--github` style) — keep CLI surface tight; `--format X` only.
- New pure formatters `toGithub(reported)` / `toGitlab(reported)` in DryTs.ts,
  string-returning, `console.log`'d like the others. Both consume the report
  layer (T2) and emit only **changed locations** of `status === "new"` clusters.
- GitHub escaping uses two tables (message vs property values); see "What gets
  emitted". `%` replaced first. Tested both tables.
- GitLab `fingerprint` = `sha256("v1:" + per-location structural key)` — line
  independent (T1b). Tested: stable across line-drift AND across processes.
- README: a GitHub Actions recipe and a GitLab CI recipe, both copy-paste,
  both paired with `--changed-from` and `--fail-on-duplicates`.
- AGENTS.md: note that `github`/`gitlab` formats are CI-presentation only; the
  agent loop keeps using `--format json`.
- Public API: `OutputFormat` is exported; adding members is additive, minor
  version bump (0.5.0), per the 0.3.0/0.4.0 precedent.

## NOT in scope
- `--report-file` / arbitrary-path output (stdout + redirect covers CI).
- SARIF, JUnit, other CI formats.
- Annotating `known` debt (PR-grade = the change only).

## Open questions — RESOLVED (Phase-1 gate + Eng review)
1. GitLab unscoped → emit `[]` (valid empty CodeClimate report). PR-grade is
   change-scoped (gate).
2. GitHub per-location vs per-cluster → one annotation per **changed** location
   only; counterparts in message text (gate F-SPAM + eng critical E1).
3. GitLab fingerprint basis → versioned line-independent structural key threaded
   from the finder (eng critical E2; see T1b). Not cluster locations.

## VERDICT — APPROVED (autoplan 2026-06-13)

Scope: ship BOTH `--format github` + `--format gitlab` this release (0.5.0).
User gate: annotations (not threaded comments) accepted; GitLab inline refs are
Ultimate-tier, widget on all tiers — acknowledged. CEO+Eng+DX cleared, dual
voices ran all three phases, 2 criticals folded (T1b finder threading, T2 report
layer). Ready to implement — start with T1b (it gates T4's fingerprint).

## CEO Review (Phase 1) — dual voices

Ran Claude subagent (independent) + Codex (web-researched SARIF/GitLab tiers).

```
CEO DUAL VOICES — CONSENSUS TABLE
  Dimension                              Claude   Codex    Consensus
  -------------------------------------- -------- -------- ----------
  1. Right problem to solve now?         partial  partial  DISAGREE(w/user)
  2. Premise "two formats" valid?        no       no       CONFIRMED challenge
  3. Ship both platforms at once?        no       no       CONFIRMED challenge
  4. SARIF dismissed too fast?           yes      yes      CONFIRMED (resolved below)
  5. Per-location annotation correct?    no       no       CONFIRMED
  6. Fingerprint determinism settled?    no       n/a      Claude-only critical
```

### Findings (both models)
- **F-SCOPE [critical, both] — don't ship both platforms at once.** "GitHub for
  GA, GitLab because work uses it" mixes product strategy with personal demand.
  Recommendation: ship one, gate the other behind an adoption trigger. → USER
  CHALLENGE (not auto-decided; see gate).
- **F-SARIF [high, both] — SARIF was dismissed in one line.** Codex research:
  GitHub ingests SARIF but routes it to the *Security tab*, not inline PR-diff
  annotations (for non-CodeQL third-party uploads). `::error` stdout is the
  documented path to inline PR-*diff* annotations. GitLab SARIF is
  security/vuln-oriented, **Ultimate-tier**, feature-flag sensitive — wrong fit
  for code-quality MR annotations; CodeClimate is the right GitLab bet.
  **Resolved (auto, P5):** keep `::error` for GitHub and CodeClimate for GitLab.
  SARIF does NOT collapse the two. Record the analysis so it's not re-litigated.
- **F-SPAM [high, both] — per-location annotations spam, and annotate old
  counterpart code.** In a transitive cluster, annotating "every copy" tags
  unchanged code too. **Resolved (auto, P1+P5):** annotate only locations that
  intersect the changed scope; name counterparts in the message; add an
  annotation cap with an overflow summary line.
- **F-GLMODEL [high, Codex] — GitLab Code Quality is a *full* report GitLab
  diffs itself.** GitLab compares the MR report against the target-branch
  report and renders new findings. Emitting only `status:"new"` may make the
  pipeline/full quality view incomplete. Opens a cleaner GitLab story: emit all
  clusters unscoped, let GitLab do the diffing (no `--changed-from` needed for
  GitLab). → surfaced as Eng-phase semantics decision (see open Q1).
- **F-FINGERPRINT [critical, Claude] — fingerprint must survive line drift.**
  If the GitLab fingerprint includes line numbers, inserting a comment above a
  block changes it and GitLab shows the whole backlog as new every run.
  **Resolved (auto, P1):** fingerprint = hash of the cluster's normalized
  structural identity (the AST fingerprint set the finder already computes),
  excluding line numbers/paths. Acceptance test: drift line numbers, assert
  fingerprint unchanged.
- **F-PROVENANCE [high, Codex] — cluster-level status doesn't name *which* old
  block the changed block duplicated.** Pair-level provenance already deferred
  in TODOS.md. **Resolved (auto, P3):** message lists all other cluster
  locations as candidate counterparts; sharper pair-provenance stays deferred,
  noted as a known message-quality limit.
- **F-DOGFOOD [critical, both] — annotation polish before the detector's
  precision is proven on real PRs.** Advisory: the user has chosen to build
  reporting; noted as context, not a blocker. The differentiator (structural +
  stateless changed-scope gating) lives in the message content — make
  counterpart-naming + score + "extract a helper" wording a hard requirement.

### Decision Audit Trail
| # | Phase | Decision | Class | Principle | Rationale |
|---|-------|----------|-------|-----------|-----------|
| 1 | CEO | Keep `::error`(GH)+CodeClimate(GL); reject SARIF | Mechanical | P5 | SARIF→Security tab not PR diff; GL SARIF Ultimate-tier |
| 2 | CEO | Annotate changed locations only + counterparts in msg + cap | Mechanical | P1,P5 | per-location spam/old-code finding |
| 3 | CEO | Fingerprint = structural identity, line-drift test | Mechanical | P1 | GitLab report-diff correctness |
| 4 | CEO | Message names counterparts; pair-provenance stays deferred | Mechanical | P3 | DRY w/ existing TODO |
| 5 | CEO | Ship-both-vs-one | **User Challenge** | — | both models challenge user direction → gate |
| 6 | CEO | GitLab full-report-vs-new-only | Taste | P1 | surfaced Eng phase |

## Eng Review (Phase 3) — dual voices

Claude subagent + Codex (both read the finder/collector/types). **Near-total
agreement** — same critical, same architectural fix.

```
ENG DUAL VOICES — CONSENSUS TABLE
  Dimension                                        Claude  Codex  Consensus
  ------------------------------------------------ ------- ------ ----------
  1. Per-location intersection threadable today?   no      no     CONFIRMED critical
  2. Fingerprint data reaches formatter?           no      no     CONFIRMED critical
  3. GitHub escaping spec correct?                 no      no     CONFIRMED (fixed)
  4. Switch compile-time exhaustive?               no      no     CONFIRMED (fixed)
  5. Counterpart naming sound (3+ loc)?            no       no     CONFIRMED (reworded)
  6. Cap behavior valid both platforms?            partial no      CONFIRMED (split)
```

### Findings (both, unless noted)
- **E1 [critical] — changed-hunk-only is not implementable from current
  formatter input.** `statusFor` (DryTs.ts:168) yields a cluster-level boolean;
  no per-location marker exists. **Fix:** add report-layer types
  `ReportedLocation = ClusterLocation & { intersectsChangedScope: boolean }` and
  `ReportedCluster`, built in `run()` after scope resolution. Keep
  `ChangedRegions` out of formatters; do NOT mutate exported `Cluster`/
  `ClusterLocation` (public API; `findClusters()` has no scope).
- **E2 [critical] — the structural fingerprint is discarded before the report
  stage.** `clustersFor` (TypeScriptDuplicateFinder.ts:38) keeps only
  file/line/nodes; `Entry.fingerprints` is dropped (verified). `fingerprintSetKey`
  (line 229) is the line-independent identity but private to `matchingPairs`.
  **Fix:** thread a per-location structural key into the report model. New task
  T1b — a finder change, the main effort the first estimate missed.
- **E3 [high] — GitHub escaping tables conflated** (fixed in "What gets emitted").
- **E4 [medium] — switch lacks a compile-time exhaustiveness backstop;** a
  missing arm compiles, selects no output, yet `--fail-on-duplicates` still
  exits 1 (fails red, annotates nothing). **Fix:** `default: assertNever` (T5).
- **E5 [medium] — counterpart wording overclaims** for transitive A–B–C clusters
  (fixed: "candidate counterparts in the same duplicate cluster").
- **E6 [medium] — cap must stay schema-valid on GitLab** (fixed: platform-split).

### Decision Audit Trail (Eng)
| # | Phase | Decision | Class | Principle |
|---|-------|----------|-------|-----------|
| 7 | Eng | Report-layer `ReportedCluster/Location` built in run() | Mechanical | P5 |
| 8 | Eng | Thread structural key from finder (T1b) | Mechanical | P1 |
| 9 | Eng | Two GitHub escape helpers, `%` first | Mechanical | P1 |
| 10 | Eng | `assertNever` switch default | Mechanical | P5 |
| 11 | Eng | "candidate counterparts" wording + `+N more` | Mechanical | P5 |
| 12 | Eng | Platform-specific cap (GH notice / GL truncate-in-desc) | Mechanical | P1 |

## Implementation tasks (revised after Eng review)
- [ ] **T1** — types: extend `OutputFormat` to `…|"github"|"gitlab"`;
  `formatValue` (Options.ts) accepts them; update USAGE strings.
- [ ] **T1b (CRITICAL)** — finder: thread a line-independent structural key
  (`fingerprintSetKey`) per location from `clustersFor` into the report model.
  Without this, T4's fingerprint is unimplementable.
- [ ] **T2** — report layer: `ReportedCluster`/`ReportedLocation` with
  `intersectsChangedScope` AND `annotationLine` (first changed line inside the
  location), built in `run()` after scope resolution; formatters consume it and
  stay pure `(reported) => string`.
- [ ] **T3** — `toGithub`: per-changed-location `::error::` anchored at
  `annotationLine`; two escape helpers; counterpart message + `+N more`; cap
  **10**/step + trailing `::notice::` overflow summary.
- [ ] **T4** — `toGitlab`: CodeClimate entries per changed location,
  `location.lines.begin = annotationLine`; versioned structural `fingerprint`;
  `check_name`/`severity`; `[]` when empty; deterministic truncation in
  `description`.
- [ ] **T5** — DryTs.run switch arms + `default: assertNever(options.format)`.
- [ ] **T6** — Tests: `--format github/gitlab` accepted (xml still rejected);
  per-location intersection (3-loc, 1 changed → 1 annotation, 2 named);
  `annotationLine` = first changed line when change is mid-block; fingerprint
  line-drift stability + cross-process determinism; GitHub escaping (path with
  `,`, message with `\n`/`%`); empty-scope (`[]` / no commands); whole-file
  degenerate (no empty counterpart list); cap overflow both platforms (GH 10,
  GL stays valid JSON).
- [ ] **T7** — Docs (DX-hardened): README GitHub Actions recipe
  (`permissions: contents: read`, keep `fetch-depth: 0`, "annotations not
  comments" note) + **full GitLab recipe** — `GIT_DEPTH: "0"`, `rules:` guarded
  to `merge_request_event` (+ default-branch baseline), `git fetch origin
  $CI_MERGE_REQUEST_TARGET_BRANCH_NAME` → `--changed-from FETCH_HEAD`, single
  pass `… --fail-on-duplicates … > gl-code-quality-report.json` (plain `>`
  preserves exit code; NO `|| true`/`allow_failure`), `artifacts: when: always`
  + `reports: codequality:`. **Bold tier caveat:** Free/Premium → MR Code
  Quality widget only; **inline Changes-view annotations require Ultimate**.
  AGENTS.md note (CI-presentation only; agent loop keeps `--format json`).
  Effort note: T1b + report-layer lift CC estimate to ~2-3 h.

## DX Review (Phase 3.5) — dual voices

Claude subagent + Codex (web-checked GitHub/GitLab docs). Both flagged the
anchor-line critical and the GitLab tier trap.

```
DX DUAL VOICES — CONSENSUS TABLE
  Dimension                                   Claude  Codex  Consensus
  ------------------------------------------- ------- ------ ----------
  1. Annotation anchors to a changed line?    no      no     CONFIRMED critical
  2. GitHub recipe copy-paste complete?       partial partial CONFIRMED (permissions/wording)
  3. GitHub annotation cap correct?           n/a     no     Codex: 10 not 50
  4. GitLab recipe copy-paste complete?       no      no     CONFIRMED critical
  5. GitLab tier story documented?            no      no     CONFIRMED (Ultimate=inline)
  6. Redirect breaks the gate?                yes(F3) no     Codex correct: plain > keeps exit
  7. "comments" vs "annotations" honest?      no      no     CONFIRMED → user gate
```

### Findings
- **D1 [critical, both] — anchor at first changed line, not block startLine**
  (fixed: `annotationLine` in T2).
- **D2 [high, Codex] — GitHub cap is 10/step, not 50** (fixed: T3).
- **D3 [critical, both] — GitLab recipe not copy-paste complete:** needs
  `GIT_DEPTH`, `merge_request_event` rules, target fetch + `FETCH_HEAD`,
  `artifacts: when: always` (fixed: T7).
- **D4 [high, both] — GitLab tier trap:** Free/Premium get the MR widget only;
  inline Changes-view annotations are **Ultimate** (fixed: T7 bold caveat). →
  also a user gate (see below) since the user's workplace tier decides whether
  the inline goal is even reachable via Code Quality.
- **D5 [medium, both] — no `permissions: checks: write` needed;** `::error`
  rides stdout. Use `contents: read` (fixed: T7).
- **D6 [resolved] — F3 redirect/exit-code:** Codex corrected the subagent —
  plain `cmd > file` preserves dry-ts's exit 1, so a single pass gates AND
  produces the artifact with `when: always`. No `--report-file`, no two-pass.
- **D7 [→ user gate] — "comments" vs "annotations":** the user asked for MR/PR
  *comments*; `::error` + Code Quality produce *annotations*, not threaded
  review comments. True comments need a bot token + review API (much larger).
  Surfaced at the final gate.

### Decision Audit Trail (DX)
| # | Phase | Decision | Class | Principle |
|---|-------|----------|-------|-----------|
| 13 | DX | `annotationLine` in report layer | Mechanical | P1 |
| 14 | DX | GitHub cap 10/step | Mechanical | P1 |
| 15 | DX | Full DX-hardened GitLab recipe | Mechanical | P1 |
| 16 | DX | `contents: read` only, no checks:write | Mechanical | P5 |
| 17 | DX | Single-pass `>` + `when: always` (reject two-pass/`--report-file`) | Mechanical | P3 |
| 18 | DX | Bold GitLab tier caveat | Mechanical | P1 |

**TTHW:** GitHub ~3 steps; GitLab ~5 (add job, default-branch baseline, open MR,
check widget, inline only if Ultimate).
