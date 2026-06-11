#!/usr/bin/env node
// Deterministic synthetic corpora for benchmarking specific scan regimes.
// Usage: node scripts/bench-corpus.mjs <identical|oneliners|nested> [--count N] [--out DIR]
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const REGIMES = {
  identical: {
    defaultCount: 800,
    describe: (count) => `${count} structurally identical functions (stresses pair comparison/grouping)`,
    generate: generateIdentical,
  },
  oneliners: {
    defaultCount: 10000,
    describe: (count) => `${count} one-line functions below min-lines (stresses pre-normalization filtering)`,
    generate: generateOneliners,
  },
  nested: {
    defaultCount: 300,
    describe: (count) => `expressions nested to depths up to ${count} (stresses fingerprint construction)`,
    generate: generateNested,
  },
};

const FUNCTIONS_PER_FILE = 50;

const args = process.argv.slice(2);
const regime = args[0];
if (!REGIMES[regime]) {
  console.error(`Usage: bench-corpus.mjs <${Object.keys(REGIMES).join("|")}> [--count N] [--out DIR]`);
  process.exit(2);
}
const count = integerFlag("--count", REGIMES[regime].defaultCount);
const outDir = stringFlag("--out", path.join(".bench", "corpus", regime));

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const files = REGIMES[regime].generate(count);
for (const [name, content] of files) {
  await writeFile(path.join(outDir, name), content);
}
console.log(JSON.stringify({ regime: REGIMES[regime].describe(count), files: files.length, out: outDir }, null, 2));

function generateIdentical(total) {
  const files = [];
  for (let fileIndex = 0; fileIndex * FUNCTIONS_PER_FILE < total; fileIndex += 1) {
    const inFile = Math.min(FUNCTIONS_PER_FILE, total - fileIndex * FUNCTIONS_PER_FILE);
    const functions = [];
    for (let i = 0; i < inFile; i += 1) {
      const id = fileIndex * FUNCTIONS_PER_FILE + i;
      functions.push(identicalFunction(id));
    }
    files.push([`identical-${fileIndex}.ts`, functions.join("\n\n") + "\n"]);
  }
  return files;
}

function identicalFunction(id) {
  return [
    `export function compute${id}(items: readonly number[]): number {`,
    `  let total = ${id};`,
    `  for (const item of items) {`,
    `    if (item > ${id + 1}) {`,
    `      total += item * ${id + 2};`,
    `    } else {`,
    `      total -= item;`,
    `    }`,
    `  }`,
    `  return total;`,
    `}`,
  ].join("\n");
}

function generateOneliners(total) {
  const files = [];
  const perFile = 500;
  for (let fileIndex = 0; fileIndex * perFile < total; fileIndex += 1) {
    const inFile = Math.min(perFile, total - fileIndex * perFile);
    const lines = [];
    for (let i = 0; i < inFile; i += 1) {
      const id = fileIndex * perFile + i;
      lines.push(`export const one${id} = (value: number): number => value + ${id};`);
    }
    files.push([`oneliners-${fileIndex}.ts`, lines.join("\n") + "\n"]);
  }
  return files;
}

function generateNested(maxDepth) {
  const files = [];
  for (const depth of [Math.ceil(maxDepth / 3), Math.ceil((2 * maxDepth) / 3), maxDepth]) {
    let expression = "seed";
    for (let i = 0; i < depth; i += 1) {
      expression = `(seed + ${expression})`;
    }
    const content = [
      `export function nested${depth}(seed: number): number {`,
      `  return ${expression};`,
      `}`,
      "",
    ].join("\n");
    files.push([`nested-${depth}.ts`, content]);
  }
  return files;
}

function integerFlag(flag, fallback) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return fallback;
  }
  const parsed = Number.parseInt(args[index + 1] ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function stringFlag(flag, fallback) {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
}
