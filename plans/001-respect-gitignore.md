# Plan 001: Respect .gitignore during directory scans

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 87665c4..HEAD -- package.json bun.lock README.md src/Options.ts src/Dry4Ts.ts src/TypeScriptDuplicateFinder.ts test/dry4ts.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding. On a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `87665c4`, 2026-06-11 (re-verified against live code; the
  original `6bd3210` stamp predated unrelated benchmark/docs commits)

## Why this matters

`dry4ts .` currently descends into generated and vendor directories, including
`dist/` and `node_modules/`, even when the project `.gitignore` says those
paths are not source. In this repository, scanning `src test` averages about
0.35 seconds, while scanning `.` took 29.1 seconds just to build entries,
produced 15,695 candidates, and implied 123,158,665 pair checks. The CLI should
default to repository source-code behavior and provide an explicit opt-out for
users who really want ignored files included.

## Current state

- `.gitignore` currently excludes the directories that caused the scan blow-up:

```text
.gitignore:1 node_modules/
.gitignore:2 dist/
.gitignore:3 *.tgz
```

- `package.json` has no ignore parser dependency today. Runtime dependencies
  are currently only TypeScript:

```json
package.json:43   "dependencies": {
package.json:44     "typescript": "^5.4.0"
package.json:45   },
```

- CLI options are parsed in `src/Options.ts`. The option model does not carry
  any ignore behavior yet:

```ts
src/Options.ts:3 export interface OptionsInput {
src/Options.ts:4   readonly paths?: readonly string[];
src/Options.ts:5   readonly threshold?: number;
src/Options.ts:6   readonly minLines?: number;
src/Options.ts:7   readonly minNodes?: number;
src/Options.ts:8   readonly format?: OutputFormat;
src/Options.ts:9   readonly help?: boolean;
src/Options.ts:10   readonly failOnDuplicates?: boolean;
src/Options.ts:13 export class Options {
src/Options.ts:24   static defaults(): Options {
src/Options.ts:25     return new Options(["src"], 0.82, 4, 20, "text", false, false);
```

- The CLI usage text in `src/Dry4Ts.ts` lists current options but not
  `.gitignore` behavior:

```ts
src/Dry4Ts.ts:6 export const USAGE = [
src/Dry4Ts.ts:10   "  --threshold N   Minimum structural similarity score, default 0.82",
src/Dry4Ts.ts:11   "  --min-lines N   Minimum source lines in a candidate declaration, default 4",
src/Dry4Ts.ts:12   "  --min-nodes N   Minimum normalized syntax nodes, default 20",
src/Dry4Ts.ts:17   "  --fail-on-duplicates",
src/Dry4Ts.ts:18   "                  Exit with status 1 when duplicate candidates are found",
```

- Directory traversal in `src/TypeScriptDuplicateFinder.ts` currently visits
  every directory and every TypeScript/JavaScript source file below each input:

```ts
src/TypeScriptDuplicateFinder.ts:78   private scan(paths: readonly string[]): Entry[] {
src/TypeScriptDuplicateFinder.ts:79     return paths
src/TypeScriptDuplicateFinder.ts:80       .flatMap((sourcePath) => this.typeScriptFiles(sourcePath))
src/TypeScriptDuplicateFinder.ts:81       .sort()
src/TypeScriptDuplicateFinder.ts:82       .flatMap((file) => this.scanFile(file));
src/TypeScriptDuplicateFinder.ts:85   private typeScriptFiles(sourcePath: string): string[] {
src/TypeScriptDuplicateFinder.ts:99       for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
src/TypeScriptDuplicateFinder.ts:100         const fullPath = path.join(dir, entry.name);
src/TypeScriptDuplicateFinder.ts:101         if (entry.isDirectory()) {
src/TypeScriptDuplicateFinder.ts:102           visit(fullPath);
src/TypeScriptDuplicateFinder.ts:103         } else if (entry.isFile() && isTypeScriptSource(fullPath)) {
src/TypeScriptDuplicateFinder.ts:104           files.push(fullPath);
```

- Tests are in `test/dry4ts.test.ts` and use Node's built-in `node:test` plus
  `assert`. Temporary file fixtures follow the `writeFixture` pattern at
  `test/dry4ts.test.ts:309`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Add dependency | `bun add ignore` | exits 0; `package.json` and `bun.lock` update |
| Test | `bun run test` | exits 0; all tests pass |
| Full gate | `bun run check` | exits 0; build, tests, and dry4ts scan pass |
| Manual CLI check | `bun ./dist/bin/dry4ts.js --format json .` | exits 0 and does not scan ignored `node_modules/` or `dist/` |
| Opt-out check | `bun ./dist/bin/dry4ts.js --no-gitignore --format json .` | attempts ignored paths; expect a nonzero exit, because `scanFile` throws on the first parse error and `node_modules/` will contain unparseable files |

## Scope

**In scope**:

- `package.json`
- `bun.lock`
- `README.md`
- `src/Options.ts`
- `src/Dry4Ts.ts`
- `src/TypeScriptDuplicateFinder.ts`
- `test/dry4ts.test.ts`

**Out of scope**:

- Changing the duplicate similarity algorithm.
- Changing output JSON/EDN/text cluster shape.
- Adding custom ignore files such as `--ignore-path`; this plan only adds the default `.gitignore` behavior and `--no-gitignore`.
- Removing `findDuplicates`; that is handled by `plans/002-remove-raw-pair-api.md`.

## Git workflow

- Branch: `advisor/001-respect-gitignore`.
- Commit message style in this repo is short imperative/prose, for example
  `Add Intent agent skills`.
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the ignore parser dependency

Run `bun add ignore`. Keep `ignore` in `dependencies`, not `devDependencies`,
because the published CLI needs it at runtime. The `ignore` package ships its
own type definitions; do not add `@types/ignore` (it does not exist).

**Verify**: `bun run test` -> exits 0.

### Step 2: Extend Options with gitignore behavior

In `src/Options.ts`:

- Add `readonly respectGitignore?: boolean` to `OptionsInput`.
- Add a constructor parameter `public readonly respectGitignore: boolean`.
- Set the default to `true`.
- Preserve `Options.from` behavior by using
  `input.respectGitignore ?? defaults.respectGitignore`.
- Teach `Options.parse` to recognize `--no-gitignore` and set
  `respectGitignore = false`.
- Keep the default path behavior unchanged: no paths still means `["src"]`.

Add a test next to `test/dry4ts.test.ts:147` asserting:

- `Options.parse("--no-gitignore", ".").respectGitignore === false`.
- `Options.parse(".").respectGitignore === true`.

**Verify**: `bun run test` -> exits 0 and includes the new option parse test.

### Step 3: Document the CLI option

In `src/Dry4Ts.ts`, add usage text for `--no-gitignore`. In `README.md`, update
the options block and the paragraph around `README.md:46` so it states:

- Directory scans respect `.gitignore` by default.
- Explicit file arguments are still scanned even if ignored.
- `--no-gitignore` disables `.gitignore` filtering.

Do not change the JSON, EDN, or text output examples.

**Verify**: `bun run test` -> exits 0.

### Step 4: Apply .gitignore filtering to directory traversal

In `src/TypeScriptDuplicateFinder.ts`, change scanning so it can see the full
`Options` object, not only `paths`.

Implement behavior with the `ignore` package:

- Load `.gitignore` from `process.cwd()` when `options.respectGitignore` is
  true.
- If `.gitignore` is absent, use an empty ignore set.
- Match paths relative to `process.cwd()`, using forward slashes for the ignore
  matcher.
- **Guard against out-of-cwd inputs.** The `ignore` matcher throws a
  `RangeError` for paths that are not relative beneath its base directory.
  When `path.relative(process.cwd(), candidate)` starts with `..` (or is
  absolute, on Windows cross-drive), skip ignore matching entirely and include
  the path. Without this guard, `dry4ts /some/other/repo` crashes. Add a test
  covering a scanned directory outside cwd.
- For directory traversal, skip ignored directories before recursing.
- For files discovered through directory traversal, skip ignored files.
- For explicit file path arguments, include the file if it is a supported source
  file even when it is ignored. This preserves intent when a user names a file
  directly.
- Dedupe resolved file paths after all inputs are expanded so overlapping inputs
  like `src src/bin` do not parse the same file twice.

Suggested shape:

```ts
private entriesFor(options: Options): Entry[] {
  return this.scan(options)
    .filter((entry) => lines(entry) >= options.minLines)
    .filter((entry) => entry.nodes >= options.minNodes);
}
```

Use small private helpers rather than putting all behavior in `scan`. Good
helper names would be `gitignoreForCwd`, `relativeForIgnore`, and
`dedupeFiles`.

**Verify**: `bun run test` -> exits 0.

### Step 5: Add regression tests for ignored files and opt-out

In `test/dry4ts.test.ts`, add tests using the existing temporary fixture style:

- Create a temp project with:
  - `.gitignore` containing `ignored/`
  - `kept/one.ts`
  - `kept/two.ts`
  - `ignored/three.ts`
- Temporarily run the finder with `process.chdir(projectDir)` and restore the
  previous cwd in `finally`.
- Default behavior: `new TypeScriptDuplicateFinder().findClusters({ paths: ["."], threshold: 0.2, minLines: 3, minNodes: 8 })` must not include any location under `ignored/`.
- Opt-out behavior: the same call with `respectGitignore: false` must include
  an ignored file when its structure duplicates a kept file.
- Explicit file behavior: `paths: ["ignored/three.ts"]` with default options
  must scan that file when it is a supported source file.

Keep tests independent: create a fresh temp project per test or carefully
restore cwd in `finally`.

**Verify**: `bun run test` -> exits 0 and includes the new regression tests.

### Step 6: Run the full gate and manual CLI checks

Run the full repo gate:

**Verify**: `bun run check` -> exits 0.

Then run:

```bash
bun ./dist/bin/dry4ts.js --format json .
```

Expected result:

- exits 0
- completes quickly in this repository
- JSON output does not contain paths beginning with `node_modules/` or `dist/`

Then run:

```bash
bun ./dist/bin/dry4ts.js --no-gitignore --format json .
```

Expected result:

- `--no-gitignore` is accepted, not treated as a path
- the command attempts to include ignored files; expect a nonzero exit with a
  parse error, because `scanFile` throws on the first parse failure and
  `node_modules/` contains files the parser rejects. A nonzero exit here is
  success for this check; the point is that ignored paths were attempted.

## Test plan

- Add option parsing tests next to the existing command-line option tests.
- Add fixture-based traversal tests next to existing scanner tests.
- Existing `finds duplicate clusters directly` is the closest structural
  pattern for invoking `findClusters` against a temp directory.
- Run `bun run test` and `bun run check`.

## Done criteria

- [ ] `ignore` is present in `dependencies` and the lockfile is updated.
- [ ] `Options.parse(".").respectGitignore` defaults to `true`.
- [ ] `Options.parse("--no-gitignore", ".").respectGitignore` is `false`.
- [ ] Directory scans skip paths ignored by `.gitignore`.
- [ ] Explicit file arguments still scan supported source files even if ignored.
- [ ] Overlapping input paths do not parse/report the same file twice.
- [ ] README and usage text document `--no-gitignore`.
- [ ] `bun run test` exits 0.
- [ ] `bun run check` exits 0.
- [ ] `plans/README.md` status row for plan 001 is updated.

## STOP conditions

Stop and report back if:

- The live code no longer has `Options`, `TypeScriptDuplicateFinder`, or the
  scanner structure shown in "Current state".
- `ignore` cannot be installed or has incompatible ESM/TypeScript behavior and
  fixing it would require swapping to a different library.
- Supporting `.gitignore` correctly appears to require implementing full nested
  `.gitignore` discovery across every traversed subdirectory. That is out of
  scope for this first pass.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- This first pass intentionally uses `.gitignore` from `process.cwd()`. If
  users later need per-subdirectory `.gitignore` behavior, add it as a separate
  feature with dedicated tests.
- Paths outside cwd bypass ignore filtering by design in this pass. A later
  improvement could load `.gitignore` from each input root (or nearest
  ancestor) and match relative to that root, which would also make
  `dry4ts /other/repo` respect that repo's ignore rules.
- Reviewers should scrutinize path normalization: ignore matching should be
  stable on Unix and Windows path separators.
- This plan does not address the all-pairs comparison algorithm; it prevents the
  most common accidental candidate explosion before comparison begins.
