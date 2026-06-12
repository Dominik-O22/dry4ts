# TODOs

Known deferred work. Performance plans live in `plans/README.md`.

- [ ] Per-file parse-error tolerance: a single unparseable source file currently
  aborts the whole scan (`scanFile` throws). Skip the file with a warning on
  stderr instead, and add a `--strict` flag to restore fail-fast behavior.
  (Deferred from feat/respect-gitignore review, 2026-06-12.)
- [ ] Symlink policy: directory walks in `typeScriptFiles` follow whatever
  `readdirSync`/`statSync` report; symlinked directories and files are neither
  documented nor cycle-guarded. Decide policy (skip symlinks vs. follow with
  cycle detection), implement, and document in README.
  (Deferred from feat/respect-gitignore review, 2026-06-12.)
