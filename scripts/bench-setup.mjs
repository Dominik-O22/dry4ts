#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Fetch the pinned large-repo benchmark corpora.
//
// Each corpus is pinned to a deliberate tag so numbers stay reproducible; update
// a PINNED tag on purpose, not automatically. microsoft/TypeScript's tag tracks
// the installed typescript dependency. Sentry adds a large, messy real-world
// TS/TSX frontend where there is still headroom to surface a regression (the
// TypeScript src/compiler scan is already pushed quite low).
//
// Usage: node scripts/bench-setup.mjs [name ...]   (default: all corpora)
//   names: typescript | sentry
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const CORPORA = {
  typescript: {
    repo: "https://github.com/microsoft/TypeScript.git",
    tag: "v5.9.3",
    targetDir: path.join(".bench", "TypeScript"),
    // Whole-repo clone; the scan targets a single dense subtree.
    sparse: null,
    scanSubpath: path.join("src", "compiler"),
  },
  sentry: {
    repo: "https://github.com/getsentry/sentry.git",
    tag: "25.10.0",
    targetDir: path.join(".bench", "sentry"),
    // Python + TS monorepo; only the frontend TS/TSX is interesting here.
    // Sparse + blobless keeps the checkout to the app tree instead of GBs.
    sparse: ["static/app"],
    scanSubpath: path.join("static", "app"),
  },
};

const requested = process.argv.slice(2);
const names = requested.length === 0 ? Object.keys(CORPORA) : requested;
const unknown = names.filter((name) => !CORPORA[name]);
if (unknown.length > 0) {
  console.error(`Unknown corpus: ${unknown.join(", ")}. Known: ${Object.keys(CORPORA).join(", ")}`);
  process.exit(2);
}

await mkdir(".bench", { recursive: true });
const results = [];
for (const name of names) {
  results.push(setupCorpus(name, CORPORA[name]));
}
console.log(JSON.stringify({ corpora: results }, null, 2));

function setupCorpus(name, corpus) {
  const scanPath = path.join(corpus.targetDir, corpus.scanSubpath);
  if (existsSync(scanPath) && atPinnedTag(corpus)) {
    return { name, status: "already present", tag: corpus.tag, scanPath };
  }
  if (existsSync(corpus.targetDir)) {
    // A stale or partial checkout: clone is idempotent only into a fresh dir.
    removeDir(corpus.targetDir);
  }

  if (corpus.sparse) {
    cloneSparse(corpus);
  } else {
    cloneFull(corpus);
  }
  if (!existsSync(scanPath)) {
    throw new Error(`${name}: expected scan path missing after clone: ${scanPath}`);
  }
  return { name, status: "cloned", tag: corpus.tag, scanPath };
}

function atPinnedTag(corpus) {
  const check = spawnSync("git", ["describe", "--tags", "--exact-match", "HEAD"], {
    cwd: path.resolve(corpus.targetDir),
    encoding: "utf8",
  });
  return check.stdout?.trim() === corpus.tag;
}

function cloneFull(corpus) {
  run("git", ["clone", "--depth", "1", "--single-branch", "--branch", corpus.tag, corpus.repo, corpus.targetDir]);
}

function cloneSparse(corpus) {
  // Blobless partial clone + cone sparse-checkout: fetch only the trees and the
  // blobs under the requested paths at the pinned tag.
  run("git", [
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--branch",
    corpus.tag,
    "--filter=blob:none",
    "--no-checkout",
    corpus.repo,
    corpus.targetDir,
  ]);
  run("git", ["-C", corpus.targetDir, "sparse-checkout", "init", "--cone"]);
  run("git", ["-C", corpus.targetDir, "sparse-checkout", "set", ...corpus.sparse]);
  run("git", ["-C", corpus.targetDir, "checkout"]);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
