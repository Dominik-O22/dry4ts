# dry4ts - Skill Spec

dry4ts finds candidate duplicate TypeScript and JavaScript code by comparing normalized TypeScript AST structure. It is useful as a quick local check after generated edits and as a CI or autonomous review guard against incremental codebase sloppification.

## Domains

| Domain | Description | Skills |
| ------ | ----------- | ------ |
| Finding Duplicate Code | Running dry4ts against source paths and tuning structural matching so duplicate-code candidates are useful rather than noisy. | scan-code-for-duplicate-candidates |
| Automating Duplicate Checks | Using stable machine-readable output and exit codes to gate CI or drive autonomous agent review loops. | wire-duplicate-checks-into-ci, adopt-dry4ts-in-agent-workflow |

## Skill Inventory

| Skill | Type | Domain | What it covers | Failure modes |
| ----- | ---- | ------ | -------------- | ------------- |
| Scan Code for Duplicate Candidates | core | Finding Duplicate Code | CLI paths, candidate roots, threshold, minLines, minNodes, text output, library API | 3 |
| Wire Duplicate Checks Into CI | lifecycle | Automating Duplicate Checks | JSON output, --fail-on-duplicates, exit codes, Candidate JSON shape, GitHub Actions usage | 3 |
| Adopt dry4ts in an Agent Workflow | lifecycle | Automating Duplicate Checks | local review flow, agent-friendly JSON, candidate triage, CI escalation | 3 |

## Failure Mode Inventory

### Scan Code for Duplicate Candidates (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Expect exact clone detection | HIGH | README.md:7 | - |
| 2 | Scan default src accidentally | MEDIUM | README.md:46 | wire-duplicate-checks-into-ci |
| 3 | Use defaults for tiny candidates | MEDIUM | README.md:35 | - |

### Wire Duplicate Checks Into CI (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Forget fail-on-duplicates in CI | CRITICAL | README.md:109 | - |
| 2 | Parse text output in agents | HIGH | README.md:121 | - |
| 3 | Treat exit 1 as tool crash | HIGH | README.md:125 | - |

### Adopt dry4ts in an Agent Workflow (3 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| - | ------- | -------- | ------ | ------------ |
| 1 | Refactor every candidate immediately | HIGH | README.md:1 | scan-code-for-duplicate-candidates |
| 2 | Ignore parser failures | MEDIUM | src/TypeScriptDuplicateFinder.ts:85 | - |
| 3 | Scan generated declarations | MEDIUM | src/TypeScriptDuplicateFinder.ts:143 | - |

## Tensions

| Tension | Skills | Agent implication |
| ------- | ------ | ----------------- |
| Signal versus noise | scan-code-for-duplicate-candidates <-> adopt-dry4ts-in-agent-workflow | An agent may over-refactor harmless structural similarity if it optimizes only for zero findings. |
| Human output versus agent output | scan-code-for-duplicate-candidates <-> wire-duplicate-checks-into-ci | An agent may build brittle parsers if it uses local human output in CI or review loops. |

## Cross-References

| From | To | Reason |
| ---- | -- | ------ |
| scan-code-for-duplicate-candidates | wire-duplicate-checks-into-ci | A local scan that becomes team policy needs --fail-on-duplicates and stable JSON semantics. |
| wire-duplicate-checks-into-ci | scan-code-for-duplicate-candidates | Useful CI thresholds depend on understanding candidate size filters and score interpretation. |
| adopt-dry4ts-in-agent-workflow | scan-code-for-duplicate-candidates | Agent review loops need the same candidate interpretation rules as manual local scans. |

## Subsystems & Reference Candidates

| Skill | Subsystems | Reference candidates |
| ----- | ---------- | -------------------- |
| scan-code-for-duplicate-candidates | - | Candidate root kinds and normalization behavior |
| wire-duplicate-checks-into-ci | - | Exit-code and JSON contract |
| adopt-dry4ts-in-agent-workflow | - | Review policy examples |

## Remaining Gaps

| Skill | Question | Status |
| ----- | -------- | ------ |
| scan-code-for-duplicate-candidates | Which threshold and size-filter tuning guidance should be recommended for small libraries versus larger application codebases? Maintainer has no stronger guidance yet because the project is new. | open |
| adopt-dry4ts-in-agent-workflow | What local agent-review policy should be recommended when candidates are found: warn only, request human review, or automatically block? This remains a product-learning area. | open |

## Recommended Skill File Structure

- **Core skills:** scan-code-for-duplicate-candidates
- **Framework skills:** none
- **Lifecycle skills:** wire-duplicate-checks-into-ci, adopt-dry4ts-in-agent-workflow
- **Composition skills:** none
- **Reference files:** candidate root kinds and normalization behavior may deserve a compact reference file if the generated scan skill becomes too long

## Composition Opportunities

| Library | Integration points | Composition skill needed? |
| ------- | ------------------ | ------------------------- |
| GitHub Actions | CI example using Bun and --fail-on-duplicates | no |
| Agent review scripts | JSON output and exit-code handling | no |
