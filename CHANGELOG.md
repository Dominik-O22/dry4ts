# Changelog

All notable changes to dry4ts are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Benchmark tooling: `bun run bench` measures scan time, `bun run bench:setup`
  pins a large real-world corpus (microsoft/TypeScript v5.9.3), and
  `bun run bench:corpus` generates deterministic synthetic corpora.
- Performance improvement plans under `plans/` with review notes and an
  execution-order index.

### Changed

- JSON and EDN output now contain a `clusters` array instead of `candidates`;
  each cluster holds its member locations and representative score. (Package is
  unpublished, so no published consumers are affected.)
- Text output groups duplicates by cluster instead of printing raw pairs.

### Fixed

- Trailing-slash `.gitignore` patterns (e.g. `build/`) now correctly prune the
  matching directories during scans.
- A `.gitignore` that disappears or becomes unreadable mid-scan no longer
  crashes the run; filtering degrades gracefully to scanning everything.
