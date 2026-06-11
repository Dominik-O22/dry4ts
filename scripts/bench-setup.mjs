#!/usr/bin/env node
// Fetch the pinned large-repo benchmark corpus (microsoft/TypeScript).
// Pinned to the tag matching the installed typescript dependency so numbers
// stay reproducible; update PINNED_TAG deliberately, not automatically.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PINNED_TAG = "v5.9.3";
const REPO = "https://github.com/microsoft/TypeScript.git";
const targetDir = path.join(".bench", "TypeScript");
const scanPath = path.join(targetDir, "src", "compiler");

if (existsSync(scanPath)) {
  console.log(JSON.stringify({ status: "already present", tag: PINNED_TAG, scanPath }, null, 2));
  process.exit(0);
}

await mkdir(".bench", { recursive: true });
const result = spawnSync(
  "git",
  ["clone", "--depth", "1", "--single-branch", "--branch", PINNED_TAG, REPO, targetDir],
  { stdio: "inherit" },
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(JSON.stringify({ status: "cloned", tag: PINNED_TAG, scanPath }, null, 2));
