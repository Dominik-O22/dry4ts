#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const runsFlag = args.indexOf("--runs");
const runs = runsFlag === -1 ? 3 : Number.parseInt(args.splice(runsFlag, 2)[1] ?? "", 10);
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error("--runs must be a positive integer");
}

const scanPaths = args.length === 0 ? ["src", "test"] : args;
const timings = [];
let clusters = 0;

for (let i = 0; i < runs; i += 1) {
  const start = performance.now();
  const result = spawnSync(
    "bun",
    ["./dist/bin/dry4ts.js", "--format", "json", "--no-gitignore", ...scanPaths],
    { cwd: process.cwd(), encoding: "utf8", maxBuffer: 1024 * 1024 * 256 },
  );
  const elapsed = performance.now() - start;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stderr.write(result.stdout);
    process.exit(result.status ?? 1);
  }
  const report = JSON.parse(result.stdout);
  clusters = report.clusters.length;
  timings.push(elapsed);
}

const seconds = timings.map((ms) => ms / 1000);
const best = Math.min(...seconds);
const average = seconds.reduce((sum, value) => sum + value, 0) / seconds.length;

console.log(JSON.stringify({
  paths: scanPaths,
  runs,
  clusters,
  seconds: seconds.map((value) => Number(value.toFixed(3))),
  bestSeconds: Number(best.toFixed(3)),
  averageSeconds: Number(average.toFixed(3)),
}, null, 2));
