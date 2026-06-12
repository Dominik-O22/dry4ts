# dry-ts

dry-ts is a CLI that finds candidate duplicate TypeScript code by comparing
normalized AST structure. See README.md for usage; AGENTS.md for agent notes.

Build/test/gate: `bun run build`, `bun run test`, `bun run check`.
Benchmarks: `bun run bench`, `bun run bench:setup`, `bun run bench:corpus` (see
README "Benchmarking").
Performance plans: `plans/README.md` — prioritized implementation plans, each
self-contained and ready to execute.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
