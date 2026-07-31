#!/usr/bin/env node
// Build the pre-labeling work-list + labeling batches from raw dry-ts scan JSON.
//
// Prerequisite — scan the two corpora into .bench/eval-raw/ (the "strict" pool:
// the realistic gate, since the permissive default is calibrated for clean code
// and is too sensitive on real-world repos):
//
//   FLAGS="--exclude-tests --min-nodes 50 --exclude-kinds ArrowFunction,VariableStatement --format json --counterparts --no-gitignore"
//   bun ./dist/bin/dry-ts.js $FLAGS .bench/sentry/static/app          > .bench/eval-raw/strict-sentry.json
//   bun ./dist/bin/dry-ts.js $FLAGS .bench/n8n/packages/cli/src       > .bench/eval-raw/strict-n8n-cli.json
//   (pass the flags inline — zsh does not word-split an unquoted $FLAGS)
//
// Takes the top-N per corpus (current rankClusters order preserved), normalizes
// file paths to absolute, derives the cross-file shared-name set (the primary sort
// key, not emitted by toJson), assigns a deterministic train/holdout split, and
// writes per-corpus records + labeling batches. Output lives under .bench (gitignored);
// the labeled fixture (eval/labels/*.json) is the checked-in artifact.
//
// Usage: node scripts/eval-build-worklist.mjs [N] [BATCH]   (defaults: N=20, BATCH=7)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const N = Number(process.argv[2] ?? 20);
const BATCH = Number(process.argv[3] ?? 7);
const ROOT = process.cwd();

const CORPORA = [
  { key: "sentry", raw: ".bench/eval-raw/strict-sentry.json", tag: "25.10.0", scanRoot: ".bench/sentry/static/app" },
  {
    key: "n8n-cli",
    raw: ".bench/eval-raw/strict-n8n-cli.json",
    tag: "n8n@2.25.7",
    scanRoot: ".bench/n8n/packages/cli/src",
  },
];

const records = [];
for (const c of CORPORA) {
  const clusters = JSON.parse(readFileSync(c.raw, "utf8")).clusters ?? [];
  clusters.slice(0, N).forEach((cluster, i) => {
    const rank = i + 1;
    const locs = cluster.locations.map((l) => ({
      file: path.resolve(ROOT, l.file),
      relFile: l.file,
      startLine: l.startLine,
      endLine: l.endLine,
      kind: l.kind ?? null,
      name: l.name ?? null,
      nodes: l.nodes,
      shared: l.nearest?.shared ?? null,
    }));
    const nameFiles = new Map();
    for (const l of locs) {
      if (l.name == null) continue;
      const s = nameFiles.get(l.name) ?? new Set();
      s.add(l.relFile);
      nameFiles.set(l.name, s);
    }
    const sameName = [...nameFiles].filter(([, f]) => f.size > 1).map(([n]) => n);
    const locationKey = locs
      .map((l) => `${l.relFile}:${l.startLine}-${l.endLine}`)
      .sort()
      .join("|");
    records.push({
      id: `${c.key}-${rank}`,
      corpus: c.key,
      corpusTag: c.tag,
      pool: "strict",
      rank,
      scoreMin: cluster.score.min,
      scoreMax: cluster.score.max,
      locationCount: cluster.locationCount,
      sameName,
      maxShared: locs.reduce((m, l) => Math.max(m, l.shared ?? 0), 0),
      locationKey,
      split: rank % 3 === 0 ? "holdout" : "train",
      locationSignatures: locs.map((l) => `${l.relFile}:${l.startLine}-${l.endLine} ${l.kind} ${l.name}`),
      locations: locs,
    });
  });
}

mkdirSync(".bench/eval-raw/batches", { recursive: true });
mkdirSync(".bench/eval-raw/verdicts", { recursive: true });
writeFileSync(".bench/eval-raw/records.json", `${JSON.stringify(records, null, 2)}\n`);

let batchCount = 0;
for (let i = 0; i < records.length; i += BATCH) {
  const slice = records.slice(i, i + BATCH).map((r) => ({
    id: r.id,
    corpus: r.corpus,
    scoreMax: r.scoreMax,
    locationCount: r.locationCount,
    sameName: r.sameName,
    maxShared: r.maxShared,
    shownLocations: Math.min(6, r.locations.length),
    locations: r.locations
      .slice(0, 6)
      .map((l) => ({ file: l.file, lines: `${l.startLine}-${l.endLine}`, kind: l.kind, name: l.name })),
  }));
  writeFileSync(`.bench/eval-raw/batches/batch-${batchCount}.json`, `${JSON.stringify(slice, null, 2)}\n`);
  batchCount++;
}

const countBy = (key) => {
  const o = {};
  for (const r of records) o[r[key]] = (o[r[key]] || 0) + 1;
  return o;
};

console.log(
  JSON.stringify(
    {
      records: records.length,
      batches: batchCount,
      perCorpus: countBy("corpus"),
      split: countBy("split"),
    },
    null,
    2,
  ),
);
