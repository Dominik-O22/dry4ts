#!/usr/bin/env node
// Honest, reproducible side-by-side comparison of dry-ts vs jscpd over the same
// real TypeScript corpora. Reports clusters/clones found and wall-clock time so
// the numbers are auditable, not marketing.
//
// The framing is COMPLEMENTARY, not "winner": dry-ts surfaces structural
// candidate duplicates (Type-2/Type-3 — rename/reorder tolerant) over normalized
// AST fingerprints; jscpd matches Type-1 contiguous token sequences. The two
// tools see different clone classes, so the counts are not directly comparable —
// they describe different zones. See the printed methodology and the README
// "How dry-ts differs from token and line matchers" section.
//
// Corpora are the pinned baselines fetched by `bun run bench:setup` (sentry, n8n,
// microsoft/TypeScript). This script does NOT vendor them — run bench:setup
// first. Missing corpora are skipped with a message instead of failing.
//
// jscpd is invoked on demand via `bunx jscpd` (npx-style), never a hard
// dependency. If it cannot be resolved, the dry-ts column is still reported and
// the jscpd column is marked unavailable.
//
// Usage: node scripts/bench-vs-jscpd.mjs [name ...]   (default: all corpora)
//   names: typescript | sentry | n8n-nodes | n8n-cli
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

// The scan targets mirror the documented baselines in the README "Benchmarking"
// section and the scanSubpaths in bench-setup.mjs. jscpd is given the same path,
// so both tools see the identical file set.
const CORPORA = {
  typescript: {
    label: "TypeScript v5.9.3 src/compiler",
    scanPath: path.join(".bench", "TypeScript", "src", "compiler"),
    setup: "bun run bench:setup typescript",
  },
  sentry: {
    label: "Sentry 25.10.0 static/app",
    scanPath: path.join(".bench", "sentry", "static", "app"),
    setup: "bun run bench:setup sentry",
  },
  "n8n-nodes": {
    label: "n8n 2.25.7 packages/nodes-base/nodes",
    scanPath: path.join(".bench", "n8n", "packages", "nodes-base", "nodes"),
    setup: "bun run bench:setup n8n",
  },
  "n8n-cli": {
    label: "n8n 2.25.7 packages/cli/src",
    scanPath: path.join(".bench", "n8n", "packages", "cli", "src"),
    setup: "bun run bench:setup n8n",
  },
};

const requested = process.argv.slice(2);
const names = requested.length === 0 ? Object.keys(CORPORA) : requested;
const unknown = names.filter((name) => !CORPORA[name]);
if (unknown.length > 0) {
  console.error(`Unknown corpus: ${unknown.join(", ")}. Known: ${Object.keys(CORPORA).join(", ")}`);
  process.exit(2);
}

if (!existsSync(path.join("dist", "bin", "dry-ts.js"))) {
  console.error("dist/bin/dry-ts.js missing — run `bun run build` first.");
  process.exit(2);
}

const jscpdAvailable = probeJscpd();
if (!jscpdAvailable) {
  console.error(
    "jscpd is not available (bunx could not resolve it). Reporting the dry-ts column only.\n" +
      "Install network access or pre-cache it, then re-run: `bunx jscpd --version`.",
  );
}

const rows = [];
for (const name of names) {
  const corpus = CORPORA[name];
  if (!existsSync(corpus.scanPath)) {
    rows.push({ name, label: corpus.label, skipped: `corpus not present — fetch with: ${corpus.setup}` });
    continue;
  }
  const dryTs = runDryTs(corpus.scanPath);
  const jscpd = jscpdAvailable ? runJscpd(corpus.scanPath) : null;
  rows.push({ name, label: corpus.label, dryTs, jscpd });
}

printReport(rows, jscpdAvailable);

function runDryTs(scanPath) {
  const start = performance.now();
  const result = spawnSync("bun", ["./dist/bin/dry-ts.js", "--format", "json", "--no-gitignore", scanPath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
  });
  const seconds = (performance.now() - start) / 1000;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.stderr.write(result.stdout ?? "");
    throw new Error(`dry-ts exited ${result.status} on ${scanPath}`);
  }
  const report = JSON.parse(result.stdout);
  return { clusters: report.clusters.length, seconds: Number(seconds.toFixed(3)) };
}

function runJscpd(scanPath) {
  const outDir = mkdtempSync(path.join(tmpdir(), "dry-ts-jscpd-"));
  try {
    const start = performance.now();
    // --absolute keeps file paths unambiguous; --format typescript matches the
    // dry-ts candidate language so neither tool scans files the other skips.
    const result = spawnSync(
      "bunx",
      [
        "jscpd",
        "--silent",
        "--reporters",
        "json",
        "--output",
        outDir,
        "--format",
        "typescript",
        "--absolute",
        scanPath,
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 * 256 },
    );
    const seconds = (performance.now() - start) / 1000;
    if (result.status !== 0) {
      process.stderr.write(result.stderr ?? "");
      process.stderr.write(result.stdout ?? "");
      throw new Error(`jscpd exited ${result.status} on ${scanPath}`);
    }
    const report = JSON.parse(readFileSync(path.join(outDir, "jscpd-report.json"), "utf8"));
    return { clones: report.statistics.total.clones, seconds: Number(seconds.toFixed(3)) };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function probeJscpd() {
  const result = spawnSync("bunx", ["jscpd", "--version"], { encoding: "utf8" });
  return result.status === 0;
}

function printReport(reportRows, jscpdOk) {
  console.log("# dry-ts vs jscpd — candidate-duplicate comparison\n");
  console.log("| Corpus | dry-ts clusters | dry-ts time | jscpd clones | jscpd time |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const row of reportRows) {
    if (row.skipped) {
      console.log(`| ${row.label} | _skipped_ | — | _skipped_ | — |`);
      continue;
    }
    const dryClusters = String(row.dryTs.clusters);
    const dryTime = `${row.dryTs.seconds.toFixed(2)}s`;
    const jscpdClones = row.jscpd ? String(row.jscpd.clones) : "n/a";
    const jscpdTime = row.jscpd ? `${row.jscpd.seconds.toFixed(2)}s` : "n/a";
    console.log(`| ${row.label} | ${dryClusters} | ${dryTime} | ${jscpdClones} | ${jscpdTime} |`);
  }

  const skipped = reportRows.filter((row) => row.skipped);
  if (skipped.length > 0) {
    console.log("\nSkipped corpora:");
    for (const row of skipped) {
      console.log(`- ${row.label}: ${row.skipped}`);
    }
  }

  console.log(`\n${methodology()}`);
  if (!jscpdOk) {
    console.log(
      "\nNOTE: jscpd was unavailable, so the jscpd column reads `n/a`. The numbers " +
        "above are dry-ts only and are NOT a comparison. Re-run with jscpd resolvable.",
    );
  }
}

function methodology() {
  return `## Methodology

These two columns count DIFFERENT things; do not read them as one tool "winning".

- dry-ts "clusters" = groups of candidate declarations whose normalized-AST
  fingerprint sets overlap at Jaccard >= 0.82 (the default threshold). This is
  the Type-2/Type-3 zone: same structure with renamed identifiers, changed
  literals, or added/removed/reordered statements. Each cluster can hold more
  than two locations.
- jscpd "clones" = pairs of contiguous token sequences that match exactly
  (Rabin-Karp over Prism tokens, default min 5 lines / 50 tokens). This is the
  Type-1 zone: copy-paste modulo whitespace and comments.

A cluster and a clone are not the same unit (cluster of N locations vs. clone
pair), and the two tools target different clone classes, so the counts are NOT
directly comparable. They describe COMPLEMENTARY zones, not a single score.

Both tools scan the identical path with --format typescript, so the file set is
the same. Defaults are used for both (no tuned thresholds), so the comparison is
out-of-the-box behavior. Wall-clock time is a single cold run measured around the
child process from this harness; it includes process startup and is meant for
order-of-magnitude framing, not microbenchmark precision. For a hand-classified
Type-1/2/3 sample of what each tool finds that the other misses, see the README
"How dry-ts differs from token and line matchers" section, which documents the
sampling procedure so it is reproducible.

Reproduce:
  bun run build
  bun run bench:setup          # fetch the pinned corpora into .bench/ (gitignored)
  bun run bench:vs-jscpd       # all corpora; or pass: typescript sentry n8n-nodes n8n-cli`;
}
