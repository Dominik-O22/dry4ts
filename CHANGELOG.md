# Changelog

All notable changes to dry-ts are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-06-13

### Changed

- Large performance rework of the scan and matching pipeline. Scanning the
  TypeScript compiler sources dropped from ~5.4s to ~1.5s; the Sentry frontend
  (8.5k files), which previously did not finish within five minutes, now scans
  in ~6.6s. Reported clusters are unchanged (verified byte-identical on both
  corpora).
  - Candidate pairs are found through prefix filtering over a rarest-first
    fingerprint index instead of comparing all size-window pairs.
  - Structural fingerprints are 53-bit content hashes stored in sorted
    `Float64Array`s instead of interned strings in `Set`s. Hashing is
    deterministic and stateless; the chance of a hash collision affecting a
    result is negligible for candidate finding.
  - Files are parsed and fingerprinted in a single AST walk (new
    `FileScanner`) without materializing a normalized tree, and without
    parent-node wiring in the TypeScript parser.
  - `--min-nodes` now prunes candidates before fingerprinting, so raising it
    speeds up scans.
- Internals: `NormalizedNode.fingerprints()` returns a sorted `Float64Array`
  (was `Set<string>`), and `FingerprintInterner.idFor()` returns a number
  (was string). dry-ts is a CLI; these types only matter if you import its
  modules directly. CLI behavior is unchanged.

### Fixed

- A pair whose similarity equals the threshold exactly could be skipped when
  floating-point division floored the size window (e.g. `405 / 0.81`).

## [0.2.1] - 2026-06-12

### Changed

- Renamed to `dry-ts` (the `dry4ts` name was taken on npm by an unrelated
  scraped copy). The npm package, the CLI binary, and the docs now use `dry-ts`;
  internal source files were renamed (`src/Dry4Ts.ts` → `src/DryTs.ts`,
  `src/bin/dry4ts.ts` → `src/bin/dry-ts.ts`). The GitHub repository keeps the
  dry4ts name, so clone URLs are unchanged.

### Added

- Release automation: pushing a published GitHub Release (tag `vX.Y.Z`) now
  builds, tests, and publishes to npm with provenance via
  `.github/workflows/publish.yml`. Requires the `NPM_TOKEN` repo secret.

## [0.2.0] - 2026-06-12

### Added

- Duplicate findings are now reported as clusters: overlapping pairs are merged
  via union-find so each group of similar code appears once, with all member
  locations listed together.
- Scans respect `.gitignore` by default — ignored directories (e.g.
  `node_modules/`, `dist/`) are skipped entirely; pass `--no-gitignore` to scan
  everything. Files passed explicitly on the command line are always scanned.
- Option validation: out-of-range `--threshold`, `--min-lines`, and
  `--min-nodes` values now fail fast with a clear error and exit code 2.
- `--min-locations N` filters reported clusters to those with at least `N`
  member locations (default 2); values below 2 fail fast with exit code 2.
- Benchmark tooling: `bun run bench` measures scan time, `bun run bench:setup`
  pins a large real-world corpus (microsoft/TypeScript v5.9.3), and
  `bun run bench:corpus` generates deterministic synthetic corpora.
- Performance improvement plans under `plans/` with review notes and an
  execution-order index.

### Changed

- JSON and EDN output now contain a `clusters` array instead of `candidates`;
  each cluster holds its member locations and a score range (min/max). (Package is
  unpublished, so no published consumers are affected.)
- Text output groups duplicates by cluster instead of printing raw pairs.

### Fixed

- Trailing-slash `.gitignore` patterns (e.g. `build/`) now correctly prune the
  matching directories during scans.
- A `.gitignore` that cannot be read at scan start (missing, unreadable)
  no longer crashes the run; filtering is skipped and all paths are scanned.
- Overlapping path arguments (e.g. `dry4ts src src/utils`) no longer cause
  files in the overlap to be scanned and compared twice.
