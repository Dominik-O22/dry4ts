#!/usr/bin/env node
// Score a cluster ranking against the labeled eval set.
//
//   precision@k = (# clusters labeled `real` among the top-k ranked) / k
//
// Two modes:
//   (default)            baseline — use the `rank` recorded in the fixture (the
//                        ranking order at labeling time). top-20 is fully labeled,
//                        so precision@{5,10,20} is exact.
//   --ranking <file.json> regression — read a fresh dry-ts JSON scan, match its
//                        clusters to labels by location-set, and compute
//                        precision@k over the NEW order. Reports coverage@k
//                        (fraction of the top-k that is labeled) so a ranking that
//                        promotes unlabeled clusters into the head is visible, not
//                        silently scored as if those were false.
//
// Usage:
//   node scripts/eval-precision.mjs                       # baseline, all corpora
//   node scripts/eval-precision.mjs --ranking scan.json --corpus sentry
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const KS = [5, 10, 20];
const LABEL_FILES = {
  sentry: "eval/labels/sentry.json",
  "n8n-cli": "eval/labels/n8n-cli.json",
};

const argv = process.argv.slice(2);
const rankingFile = flag("--ranking");
const onlyCorpus = flag("--corpus");

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function locationKeyOf(cluster) {
  return cluster.locations
    .map((l) => `${l.file}:${l.startLine}-${l.endLine}`)
    .sort()
    .join("|");
}

function precisionAtK(orderedLabels, k) {
  const top = orderedLabels.slice(0, k);
  const labeled = top.filter((l) => l === "real" || l === "fp");
  const real = top.filter((l) => l === "real").length;
  return {
    precision: labeled.length ? +(real / k).toFixed(4) : null,
    coverage: +(labeled.length / k).toFixed(4),
    real,
    k,
  };
}

const corpora = Object.keys(LABEL_FILES).filter((c) => !onlyCorpus || c === onlyCorpus);
const report = { mode: rankingFile ? "rerank" : "baseline", ranking: rankingFile ?? "fixture rank", corpora: {} };

for (const corpus of corpora) {
  const path = LABEL_FILES[corpus];
  if (!existsSync(path)) {
    console.error(`skip ${corpus}: ${path} missing`);
    continue;
  }
  const labels = JSON.parse(readFileSync(path, "utf8"));
  const byKey = new Map(labels.map((r) => [r.locationKey, r.label]));

  let ordered;
  if (rankingFile) {
    const scan = JSON.parse(readFileSync(rankingFile, "utf8"));
    // dry-ts JSON paths are relative; the fixture's locationKey uses the same
    // relative form, so match directly.
    ordered = scan.clusters.map((c) => byKey.get(locationKeyOf(c)) ?? null);
  } else {
    ordered = [...labels].sort((a, b) => a.rank - b.rank).map((r) => r.label);
  }

  const at = {};
  for (const k of KS) at[`@${k}`] = precisionAtK(ordered, k);
  const fpClasses = {};
  for (const r of labels) {
    if (r.label === "fp") fpClasses[r.fpClass] = (fpClasses[r.fpClass] || 0) + 1;
  }
  report.corpora[corpus] = {
    labeled: labels.length,
    real: labels.filter((r) => r.label === "real").length,
    fp: labels.filter((r) => r.label === "fp").length,
    fpClasses,
    precisionAtK: at,
  };
}

const out = `${JSON.stringify(report, null, 2)}\n`;
if (!rankingFile) writeFileSync("eval/baseline.json", out);
console.log(out);
