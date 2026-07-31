#!/usr/bin/env node
// Assemble the labeled fixture: join the pre-label records with the agent verdicts
// (by cluster id) into the checked-in per-corpus label files.
//
// Inputs (under .bench, produced by eval-build-worklist.mjs + the labeling run):
//   .bench/eval-raw/records.json            — pre-label records (rank, locationKey, metadata)
//   .bench/eval-raw/verdicts/batch-*.json   — agent verdicts: [{id,label,confidence,fpClass,reasoning}]
// Output (checked in):
//   eval/labels/<corpus>.json
//
// Usage: node scripts/eval-assemble.mjs
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const records = JSON.parse(readFileSync(".bench/eval-raw/records.json", "utf8"));
const verdicts = {};
for (const f of readdirSync(".bench/eval-raw/verdicts").filter((f) => f.endsWith(".json"))) {
  for (const v of JSON.parse(readFileSync(`.bench/eval-raw/verdicts/${f}`, "utf8"))) verdicts[v.id] = v;
}

const byCorpus = {};
const missing = [];
for (const r of records) {
  const v = verdicts[r.id];
  if (!v) {
    missing.push(r.id);
    continue;
  }
  if (!byCorpus[r.corpus]) byCorpus[r.corpus] = [];
  byCorpus[r.corpus].push({
    id: r.id,
    corpus: r.corpus,
    corpusTag: r.corpusTag,
    pool: r.pool,
    rank: r.rank,
    label: v.label,
    confidence: v.confidence,
    fpClass: v.fpClass,
    reasoning: v.reasoning,
    scoreMin: r.scoreMin,
    scoreMax: r.scoreMax,
    locationCount: r.locationCount,
    sameName: r.sameName,
    maxShared: r.maxShared,
    split: r.split,
    locationKey: r.locationKey,
    locationSignatures: r.locationSignatures,
  });
}

mkdirSync("eval/labels", { recursive: true });
for (const [corpus, recs] of Object.entries(byCorpus)) {
  recs.sort((a, b) => a.rank - b.rank);
  writeFileSync(`eval/labels/${corpus}.json`, `${JSON.stringify(recs, null, 2)}\n`);
  console.log(
    `${corpus}: ${recs.length} (real ${recs.filter((r) => r.label === "real").length}, fp ${recs.filter((r) => r.label === "fp").length})`,
  );
}
if (missing.length) console.log("MISSING:", missing.join(","));
