import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

import {
  formatCluster,
  main,
  Options,
  printText,
  toEdn,
  toJson,
  USAGE,
  TypeScriptDuplicateFinder,
  TypeScriptNormalizer,
  type Cluster,
} from "../src/index.js";
import { canonicalPath, ChangedRegions, parseUnifiedDiff } from "../src/index.js";
import { ClusterCollector } from "../src/Clusters.js";
import { FileScanner } from "../src/FileScanner.js";
import { FingerprintInterner, type NormalizedNode } from "../src/NormalizedNode.js";

test("reports structural duplicate candidates with file and line ranges", async () => {
  const { files, clusters } = await scanFixture(
    {
      "left.ts": `
export class Left {
  alpha(xs: number[]): number {
    const ys = xs.filter((x) => x % 2 === 1);
    return ys.map((x) => x + 1).reduce((a, b) => a + b, 0);
  }
}
`,
      "right.ts": `
export class Right {
  beta(items: number[]): number {
    const kept = items.filter((item) => item % 2 === 0);
    return kept.map((item) => item - 1).reduce((sum, next) => sum + next, 10);
  }
}
`,
    },
    { threshold: 0.5, minLines: 3, minNodes: 8 },
  );

  assert.ok(hasClusterContaining(clusters, "left.ts", "right.ts"));
  const cluster = clusters.find((c) =>
    c.locations.some((loc) => loc.file === files["left.ts"]) &&
    c.locations.some((loc) => loc.file === files["right.ts"]),
  );
  assert.ok(cluster);
  // The cluster groups both class-level and method-level locations; find the method location (startLine 3).
  const leftLoc = cluster.locations.find((loc) => loc.file === files["left.ts"] && loc.startLine === 3);
  const rightLoc = cluster.locations.find((loc) => loc.file === files["right.ts"] && loc.startLine === 3);
  assert.ok(leftLoc);
  assert.ok(rightLoc);
  assert.equal(leftLoc.endLine, 6);
  assert.equal(rightLoc.endLine, 6);
});

const matchedPairCases = [
  {
    name: "matches interfaces and type aliases with different names and literals",
    sources: {
      "one.ts": `
export type Invoice = {
  id: string;
  amount: number;
  payable: (now: Date) => boolean;
};
`,
      "two.ts": `
export type Receipt = {
  code: string;
  total: number;
  closed: (today: Date) => boolean;
};
`,
    },
    options: { threshold: 0.8, minLines: 3, minNodes: 8 },
  },
  {
    name: "matches enums structurally",
    sources: {
      "one.ts": `
enum One {
  Ready = 1,
  Done = 2,
}
`,
      "two.ts": `
enum Two {
  Open = 10,
  Closed = 20,
}
`,
    },
    options: { threshold: 0.8, minLines: 3, minNodes: 3 },
  },
] satisfies Array<{
  name: string;
  sources: Record<string, string>;
  options: { threshold: number; minLines: number; minNodes: number };
}>;

for (const { name, sources, options } of matchedPairCases) {
  test(name, async () => {
    const { clusters } = await scanFixture(sources, options);

    assert.ok(hasClusterContaining(clusters, "one.ts", "two.ts"));
  });
}

test("scans JavaScript, JSX, and TSX files", async () => {
  const { clusters } = await scanFixture(
    {
      "one.js": `
export function total(items) {
  const kept = items.filter((item) => item.ready);
  return kept.map((item) => item.amount).reduce((sum, next) => sum + next, 0);
}
`,
      "two.jsx": `
export function subtotal(rows) {
  const selected = rows.filter((row) => row.enabled);
  return selected.map((row) => row.price).reduce((sum, next) => sum + next, 0);
}
`,
      "three.tsx": `
export function grandTotal(lines: Array<{ active: boolean; value: number }>): number {
  const active = lines.filter((line) => line.active);
  return active.map((line) => line.value).reduce((sum, next) => sum + next, 0);
}
`,
    },
    { threshold: 0.5, minLines: 3, minNodes: 8 },
  );

  assert.ok(hasClusterContaining(clusters, "one.js", "two.jsx"));
  assert.ok(hasClusterContaining(clusters, "one.js", "three.tsx"));
});

test("filters candidates shorter than the minimum line count", async () => {
  const { clusters } = await scanFixture(
    {
      "one.ts": "function one(x: number) { return x + 1; }\n",
      "two.ts": "function two(y: number) { return y + 2; }\n",
    },
    { threshold: 0.8, minLines: 3, minNodes: 1 },
  );

  assert.deepEqual(clusters, []);
});

test("parses command line options and paths", () => {
  const options = Options.parse(
    "--threshold",
    "0.9",
    "--min-lines",
    "5",
    "--min-nodes",
    "30",
    "--min-locations",
    "4",
    "--json",
    "--fail-on-duplicates",
    "spec",
  );

  assert.deepEqual(options.paths, ["spec"]);
  assert.equal(options.threshold, 0.9);
  assert.equal(options.minLines, 5);
  assert.equal(options.minNodes, 30);
  assert.equal(options.minLocations, 4);
  assert.equal(options.format, "json");
  assert.equal(options.failOnDuplicates, true);
});

test("defaults to src when no paths are provided", () => {
  assert.deepEqual(Options.parse().paths, ["src"]);
  assert.equal(Options.parse().minLocations, 2);
});

test("respects gitignore by default", () => {
  assert.equal(Options.parse(".").respectGitignore, true);
});

test("disables gitignore with --no-gitignore", () => {
  assert.equal(Options.parse("--no-gitignore", ".").respectGitignore, false);
});

test("creates options from partial objects", () => {
  const options = Options.from({ paths: ["lib"], format: "json", failOnDuplicates: true });

  assert.deepEqual(options.paths, ["lib"]);
  assert.equal(options.threshold, 0.82);
  assert.equal(options.minLocations, 2);
  assert.equal(options.format, "json");
  assert.equal(options.failOnDuplicates, true);
});

test("rejects invalid numeric option values", () => {
  assert.throws(() => Options.parse("--threshold", "high"), /Invalid number/);
  assert.throws(() => Options.parse("--min-lines", "many"), /Invalid integer/);
  assert.throws(() => Options.parse("--min-locations", "many"), /Invalid integer/);
});

test("rejects out-of-range option values", () => {
  assert.throws(() => Options.parse("--threshold", "0"), /threshold must be/);
  assert.throws(() => Options.parse("--threshold", "1.5"), /threshold must be/);
  assert.throws(() => Options.from({ minLines: 0 }), /minLines must be/);
  assert.throws(() => Options.from({ minNodes: -1 }), /minNodes must be/);
  assert.throws(() => Options.from({ minLocations: 1 }), /minLocations must be/);
});

test("groups transitively connected candidates into clusters", () => {
  const collector = new ClusterCollector();
  const loc = (file: string) => ({ file, startLine: 10, endLine: 14, nodes: 50 });
  collector.addMatch(loc("a.ts"), loc("b.ts"), 0.9);
  collector.addMatch(loc("b.ts"), loc("c.ts"), 0.85);
  collector.addMatch(loc("d.ts"), loc("e.ts"), 0.95);

  const clusters = collector.clusters();

  assert.equal(clusters.length, 2);
  assert.deepEqual(
    clusters.map((cluster) => cluster.locations.map((location) => location.file)),
    [["d.ts", "e.ts"], ["a.ts", "b.ts", "c.ts"]],
  );
  assert.deepEqual(clusters[1].score, { min: 0.85, max: 0.9 });
});

test("formats clusters with score range, location count, and node size", () => {
  const collector = new ClusterCollector();
  const loc = (file: string) => ({ file, startLine: 10, endLine: 14, nodes: 50 });
  collector.addMatch(loc("a.ts"), loc("b.ts"), 0.9);
  collector.addMatch(loc("b.ts"), loc("c.ts"), 0.85);

  const clusters = collector.clusters();

  assert.equal(
    formatCluster(clusters[0], 1),
    "CLUSTER 1 score=0.85-0.90 locations=3 status=unscoped\n  a.ts:10-14 nodes=50\n  b.ts:10-14 nodes=50\n  c.ts:10-14 nodes=50",
  );
});

test("does not expose complete pairwise match counts in cluster output", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
  const collector = new ClusterCollector();
  const loc = (file: string) => ({ file, startLine: 10, endLine: 14, nodes: 50 });
  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      collector.addMatch(loc(files[i]), loc(files[j]), 1);
    }
  }

  const [cluster] = collector.clusters();

  assert.equal(cluster.locations.length, 5);
  assert.equal(formatCluster(cluster, 1).split("\n")[0], "CLUSTER 1 score=1.00 locations=5 status=unscoped");
});

test("finds duplicate clusters directly", async () => {
  const { files, dir } = await writeFixture({
    "one.ts": `
export function one(items: number[]): number {
  const selected = items.filter((item) => item > 0);
  return selected.map((item) => item + 1).reduce((sum, next) => sum + next, 0);
}
`,
    "two.ts": `
export function two(values: number[]): number {
  const chosen = values.filter((value) => value < 10);
  return chosen.map((value) => value - 1).reduce((total, next) => total + next, 0);
}
`,
  });

  const clusters = new TypeScriptDuplicateFinder().findClusters({
    paths: [dir],
    threshold: 0.2,
    minLines: 3,
    minNodes: 8,
  });

  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].locations.map((location) => location.file), [files["one.ts"], files["two.ts"]]);
});

const exhaustiveEquivalenceFixtures = [
  {
    name: "functions with identical, near-identical, and different bodies",
    sources: {
      "same-a.ts": `
export function sameA(items: number[]): number {
  const kept = items.filter((item) => item % 2 === 0);
  return kept.map((item) => item * 2).reduce((sum, next) => sum + next, 0);
}
`,
      "same-b.ts": `
export function sameB(values: number[]): number {
  const chosen = values.filter((value) => value % 3 === 1);
  return chosen.map((value) => value + 4).reduce((total, next) => total + next, 10);
}
`,
      "near.ts": `
export function near(rows: number[]): number {
  const selected = rows.filter((row) => row > 10);
  const adjusted = selected.map((row) => row - 1);
  return adjusted.reduce((total, next) => total + next, 0);
}
`,
      "different.ts": `
export function different(limit: number): number {
  let total = 0;
  for (let outer = 0; outer < limit; outer += 1) {
    for (let inner = 0; inner < outer; inner += 1) {
      total += inner;
    }
  }
  return total;
}
`,
    },
  },
  {
    name: "classes, methods, and type aliases",
    sources: {
      "alpha.ts": `
export class Alpha {
  total(items: number[]): number {
    const kept = items.filter((item) => item.active);
    return kept.map((item) => item.amount).reduce((sum, next) => sum + next, 0);
  }
}
`,
      "beta.ts": `
export class Beta {
  subtotal(rows: Array<{ enabled: boolean; value: number }>): number {
    const selected = rows.filter((row) => row.enabled);
    return selected.map((row) => row.value).reduce((sum, next) => sum + next, 0);
  }
}
`,
      "types.ts": `
export type Invoice = {
  id: string;
  amount: number;
  payable: (now: Date) => boolean;
};

export type Receipt = {
  code: string;
  total: number;
  closed: (today: Date) => boolean;
};
`,
      "enum.ts": `
export enum Status {
  Ready = 1,
  Done = 2,
}
`,
    },
  },
  {
    name: "same-file and cross-file candidate roots",
    sources: {
      "container.ts": `
export class Container {
  one(items: number[]): number {
    const kept = items.filter((item) => item > 0);
    return kept.map((item) => item + 1).reduce((sum, next) => sum + next, 0);
  }

  two(items: number[]): number {
    const kept = items.filter((item) => item > 0);
    return kept.map((item) => item + 1).reduce((sum, next) => sum + next, 0);
  }
}
`,
      "external.ts": `
export function external(values: number[]): number {
  const chosen = values.filter((value) => value > 0);
  return chosen.map((value) => value + 1).reduce((total, next) => total + next, 0);
}
`,
      "unrelated.ts": `
export const unrelated = {
  read(input: string): string {
    return input.trim().toUpperCase();
  },
};
`,
    },
  },
] satisfies Array<{ name: string; sources: Record<string, string> }>;

for (const fixture of exhaustiveEquivalenceFixtures) {
  for (const threshold of [0.2, 0.5, 0.82]) {
    test(`matches exhaustive duplicate clusters for ${fixture.name} at threshold ${threshold}`, async () => {
      const { files } = await writeFixture(fixture.sources);
      const paths = Object.values(files);
      const options = { paths, threshold, minLines: 3, minNodes: 1 };

      const optimized = new TypeScriptDuplicateFinder().findClusters(options);
      const exhaustive = await exhaustiveClusters(paths, options);

      assert.deepEqual(canonicalClusters(optimized), canonicalClusters(exhaustive));
    });
  }
}

test("connects dense identical fingerprint groups without all pair matches", () => {
  const entries = Array.from({ length: 8 }, (_, index) =>
    matchingPairEntry(`dense-${index}.ts`, 1, 5, ["call", "filter", "map", "reduce"]),
  );

  const pairs = matchingPairsForTest(entries, 0.82);

  assert.equal(pairs.length, entries.length - 1);
  assert.ok(pairs.every(([left, right, score]) => score === 1 && !testEntriesOverlap(left, right)));

  const collector = new ClusterCollector();
  for (const [left, right, score] of pairs) {
    collector.addMatch(matchingPairLocation(left), matchingPairLocation(right), score);
  }
  assert.deepEqual(collector.clusters().map((cluster) => cluster.locations.length), [entries.length]);
});

test("does not emit identical fingerprint group matches for overlapping entries", () => {
  const contained = matchingPairEntry("same.ts", 3, 5, ["same", "shape"]);
  const container = matchingPairEntry("same.ts", 1, 8, ["same", "shape"]);

  assert.deepEqual(matchingPairsForTest([container, contained], 0.82), []);

  const external = matchingPairEntry("external.ts", 1, 8, ["same", "shape"]);
  const bridgedPairs = matchingPairsForTest([container, contained, external], 0.82);

  assert.equal(bridgedPairs.length, 2);
  assert.ok(bridgedPairs.every(([left, right]) => !testEntriesOverlap(left, right)));
});

test("keeps only size-window boundary candidates for exact similarity", () => {
  const base = matchingPairEntry("base.ts", 1, 5, ["a", "b", "c", "d"]);
  const lowerInside = matchingPairEntry("lower-inside.ts", 1, 5, ["a", "b"]);
  const lowerOutside = matchingPairEntry("lower-outside.ts", 1, 5, ["z"]);
  const upperInside = matchingPairEntry("upper-inside.ts", 1, 5, ["a", "b", "c", "d", "e", "f", "g", "h"]);
  const upperOutside = matchingPairEntry("upper-outside.ts", 1, 5, ["a", "b", "c", "d", "i", "j", "k", "l", "m"]);

  const pairKeys = matchingPairsForTest([base, lowerInside, lowerOutside, upperInside, upperOutside], 0.5).map(
    matchingPairKey,
  );

  assert.deepEqual(pairKeys, ["base.ts|lower-inside.ts", "base.ts|upper-inside.ts"]);
});

test("filters reported clusters by minimum location count", async () => {
  const { files, dir } = await writeFixture({
    "tuple-one.ts": "export type TupleOne = [string, number, boolean, Date];\n",
    "tuple-two.ts": "export type TupleTwo = [string, number, boolean, Date];\n",
    "tuple-three.ts": "export type TupleThree = [string, number, boolean, Date];\n",
    "union-one.ts": "export type UnionOne = string | number | boolean;\n",
    "union-two.ts": "export type UnionTwo = string | number | boolean;\n",
  });

  const clusters = new TypeScriptDuplicateFinder().findClusters({
    paths: [dir],
    threshold: 1,
    minLines: 1,
    minNodes: 1,
    minLocations: 3,
  });

  assert.equal(clusters.length, 1);
  assert.deepEqual(
    clusters[0].locations.map((location) => location.file),
    [files["tuple-one.ts"], files["tuple-three.ts"], files["tuple-two.ts"]],
  );
});

test("prints edn", () => {
  assert.equal(toEdn([]), "{:clusters []}");
});

test("prints edn clusters instead of every candidate pair", () => {
  const collector = new ClusterCollector();
  const loc = (file: string) => ({ file, startLine: 10, endLine: 14, nodes: 50 });
  collector.addMatch(loc("a.ts"), loc("b.ts"), 0.875);

  const clusters = collector.clusters();

  assert.equal(
    toEdn(clusters),
    '{:clusters\n [{:score-min 0.875\n   :score-max 0.875\n   :status :unscoped\n   :location-count 2\n   :locations [{:file "a.ts", :start-line 10, :end-line 14, :nodes 50}\n               {:file "b.ts", :start-line 10, :end-line 14, :nodes 50}]}]}',
  );
});

test("prints json clusters for agents and ci integrations", () => {
  const collector = new ClusterCollector();
  const loc = (file: string) => ({ file, startLine: 10, endLine: 14, nodes: 50 });
  collector.addMatch(loc("a.ts"), loc("b.ts"), 0.875);
  collector.addMatch(loc("b.ts"), loc("c.ts"), 0.925);

  const clusters = collector.clusters();

  assert.deepEqual(JSON.parse(toJson(clusters)), {
    clusters: [{
      score: { min: 0.875, max: 0.925 },
      status: "unscoped",
      locationCount: 3,
      locations: [
        { file: "a.ts", startLine: 10, endLine: 14, nodes: 50 },
        { file: "b.ts", startLine: 10, endLine: 14, nodes: 50 },
        { file: "c.ts", startLine: 10, endLine: 14, nodes: 50 },
      ],
    }],
  });
});

const duplicateBody = `
export function process(items: number[]): number {
  const kept = items.filter((item) => item % 2 === 0);
  return kept.map((item) => item * 2).reduce((sum, next) => sum + next, 0);
}
`;

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("directory scan skips files and directories listed in .gitignore", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "dry-ts-gitignore-"));
  const keptDir = path.join(projectDir, "kept");
  const ignoredDir = path.join(projectDir, "ignored");
  await mkdir(keptDir);
  await mkdir(ignoredDir);
  await writeFile(path.join(projectDir, ".gitignore"), "ignored/\n");
  await writeFile(path.join(keptDir, "one.ts"), duplicateBody);
  await writeFile(path.join(keptDir, "two.ts"), duplicateBody);
  await writeFile(path.join(ignoredDir, "three.ts"), duplicateBody);

  const originalCwd = process.cwd();
  try {
    process.chdir(projectDir);
    const clusters = new TypeScriptDuplicateFinder().findClusters({
      paths: ["."],
      threshold: 0.2,
      minLines: 3,
      minNodes: 8,
    });
    const allFiles = clusters.flatMap((cluster) => cluster.locations.map((loc) => loc.file));
    assert.ok(
      allFiles.every((f) => !f.includes("ignored")),
      `Expected no ignored/ files in results, got: ${JSON.stringify(allFiles)}`,
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test("directory scan includes ignored files when --no-gitignore is set", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "dry-ts-no-gitignore-"));
  const keptDir = path.join(projectDir, "kept");
  const ignoredDir = path.join(projectDir, "ignored");
  await mkdir(keptDir);
  await mkdir(ignoredDir);
  await writeFile(path.join(projectDir, ".gitignore"), "ignored/\n");
  await writeFile(path.join(keptDir, "one.ts"), duplicateBody);
  await writeFile(path.join(ignoredDir, "three.ts"), duplicateBody);

  const originalCwd = process.cwd();
  try {
    process.chdir(projectDir);
    const clusters = new TypeScriptDuplicateFinder().findClusters({
      paths: ["."],
      threshold: 0.2,
      minLines: 3,
      minNodes: 8,
      respectGitignore: false,
    });
    const allFiles = clusters.flatMap((cluster) => cluster.locations.map((loc) => loc.file));
    assert.ok(
      allFiles.some((f) => f.includes("ignored")),
      `Expected ignored/ files in results with --no-gitignore, got: ${JSON.stringify(allFiles)}`,
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test("explicit file argument scans ignored file even with gitignore enabled", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "dry-ts-explicit-"));
  const keptDir = path.join(projectDir, "kept");
  const ignoredDir = path.join(projectDir, "ignored");
  await mkdir(keptDir);
  await mkdir(ignoredDir);
  await writeFile(path.join(projectDir, ".gitignore"), "ignored/\n");
  await writeFile(path.join(keptDir, "one.ts"), duplicateBody);
  await writeFile(path.join(ignoredDir, "three.ts"), duplicateBody);

  const originalCwd = process.cwd();
  try {
    process.chdir(projectDir);
    const clusters = new TypeScriptDuplicateFinder().findClusters({
      paths: [path.join(ignoredDir, "three.ts"), path.join(keptDir, "one.ts")],
      threshold: 0.2,
      minLines: 3,
      minNodes: 8,
      respectGitignore: true,
    });
    const allFiles = clusters.flatMap((cluster) => cluster.locations.map((loc) => loc.file));
    assert.ok(
      allFiles.some((f) => f.includes("ignored")),
      `Expected ignored file to be scanned when passed explicitly, got: ${JSON.stringify(allFiles)}`,
    );
  } finally {
    process.chdir(originalCwd);
  }
});

function scanFromCwd(projectDir: string) {
  const originalCwd = process.cwd();
  try {
    process.chdir(projectDir);
    return new TypeScriptDuplicateFinder().findClusters({
      paths: ["."],
      threshold: 0.2,
      minLines: 3,
      minNodes: 8,
    });
  } finally {
    process.chdir(originalCwd);
  }
}

test("scans without error when cwd has no .gitignore", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "dry-ts-no-ignore-file-"));
  await writeFile(path.join(projectDir, "a.ts"), duplicateBody);
  await writeFile(path.join(projectDir, "b.ts"), duplicateBody);

  assert.equal(scanFromCwd(projectDir).length, 1);
});

test("does not parse files inside gitignored directories", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "dry-ts-prune-"));
  const ignoredDir = path.join(projectDir, "ignored");
  await mkdir(ignoredDir);
  await writeFile(path.join(projectDir, ".gitignore"), "ignored/\n");
  await writeFile(path.join(projectDir, "one.ts"), duplicateBody);
  await writeFile(path.join(projectDir, "two.ts"), duplicateBody);
  await writeFile(path.join(ignoredDir, "broken.ts"), "const = (((((\n");

  assert.equal(scanFromCwd(projectDir).length, 1);
});

test("scans directory outside cwd and still finds duplicates", async () => {
  const externalDir = await mkdtemp(path.join(tmpdir(), "dry-ts-external-"));
  await writeFile(path.join(externalDir, "a.ts"), duplicateBody);
  await writeFile(path.join(externalDir, "b.ts"), duplicateBody);

  const clusters = new TypeScriptDuplicateFinder().findClusters({
    paths: [externalDir],
    threshold: 0.2,
    minLines: 3,
    minNodes: 8,
    respectGitignore: true,
  });
  const hasPair = clusters.some(
    (cluster) =>
      cluster.locations.some((loc) => loc.file.endsWith("a.ts")) &&
      cluster.locations.some((loc) => loc.file.endsWith("b.ts")),
  );
  assert.ok(hasPair, `Expected a cluster containing a.ts and b.ts, got: ${JSON.stringify(clusters)}`);
});

test("dedupes overlapping input paths", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "dry-ts-dedup-"));
  const subDir = path.join(projectDir, "sub");
  await mkdir(subDir);
  await writeFile(path.join(subDir, "a.ts"), duplicateBody);
  await writeFile(path.join(subDir, "b.ts"), duplicateBody);

  const clusters = new TypeScriptDuplicateFinder().findClusters({
    paths: [projectDir, subDir],
    threshold: 0.2,
    minLines: 3,
    minNodes: 8,
  });
  const clusterFiles = clusters.flatMap((cluster) => cluster.locations.map((loc) => loc.file));
  const aFiles = clusterFiles.filter((f) => f.endsWith("a.ts"));
  const bFiles = clusterFiles.filter((f) => f.endsWith("b.ts"));
  assert.equal(aFiles.length, 1, `Expected a.ts exactly once, got ${aFiles.length}`);
  assert.equal(bFiles.length, 1, `Expected b.ts exactly once, got ${bFiles.length}`);
});

async function writeSource(dir: string, name: string, text: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, text);
  return file;
}

async function scanFixture(
  sources: Record<string, string>,
  options: { threshold: number; minLines: number; minNodes: number },
): Promise<{ files: Record<string, string>; clusters: Cluster[] }> {
  const { files, dir } = await writeFixture(sources);
  const clusters = new TypeScriptDuplicateFinder().findClusters({ paths: [dir], ...options });
  return { files, clusters };
}

async function writeFixture(sources: Record<string, string>): Promise<{ files: Record<string, string>; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "dry-ts-"));
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(sources)) {
    files[name] = await writeSource(dir, name, text);
  }
  return { files, dir };
}

type ExhaustiveEntry = MatchingPairProbeEntry;

async function exhaustiveClusters(
  files: readonly string[],
  options: { threshold: number; minLines: number; minNodes: number },
): Promise<Cluster[]> {
  const entries = await exhaustiveEntries(files, options);
  const collector = new ClusterCollector();

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const left = entries[i];
      const right = entries[j];
      if (testEntriesOverlap(left, right) || exhaustiveMaxPossibleSimilarity(left, right) < options.threshold) {
        continue;
      }
      const score = exhaustiveSimilarity(left, right);
      if (score >= options.threshold) {
        collector.addMatch(exhaustiveLocation(left), exhaustiveLocation(right), score);
      }
    }
  }

  return collector.clusters();
}

async function exhaustiveEntries(
  files: readonly string[],
  options: { minLines: number; minNodes: number },
): Promise<ExhaustiveEntry[]> {
  const normalizer = new TypeScriptNormalizer();
  const interner = new FingerprintInterner();
  const entries: ExhaustiveEntry[] = [];

  for (const file of [...files].sort()) {
    const text = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, exhaustiveScriptKind(file));
    const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] })
      .parseDiagnostics;
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      const first = parseDiagnostics[0];
      const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
      throw new Error(`Unable to parse ${file}: ${message}`);
    }

    const memo = new Map<ts.Node, NormalizedNode>();
    exhaustiveCollectEntries(file, sourceFile, sourceFile, entries, options, normalizer, interner, memo);
  }

  return entries.filter((entry) => entry.nodes >= options.minNodes);
}

function exhaustiveCollectEntries(
  file: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  entries: ExhaustiveEntry[],
  options: { minLines: number },
  normalizer: TypeScriptNormalizer,
  interner: FingerprintInterner,
  memo: Map<ts.Node, NormalizedNode>,
): void {
  if (exhaustiveIsCandidateRoot(node)) {
    const { startLine, endLine } = exhaustiveLineRangeFor(sourceFile, node);
    if (endLine - startLine + 1 >= options.minLines) {
      const normalized = normalizer.normalize(node, memo);
      entries.push({
        file,
        startLine,
        endLine,
        nodes: normalized.nodeCount(),
        fingerprints: normalized.fingerprints(interner),
      });
    }
  }
  node.forEachChild((child) =>
    exhaustiveCollectEntries(file, sourceFile, child, entries, options, normalizer, interner, memo),
  );
}

const exhaustiveCandidateChecks: ReadonlyArray<(node: ts.Node) => boolean> = [
  ts.isClassDeclaration,
  ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration,
  ts.isEnumDeclaration,
  ts.isModuleDeclaration,
  ts.isFunctionDeclaration,
  ts.isMethodDeclaration,
  ts.isConstructorDeclaration,
  ts.isGetAccessorDeclaration,
  ts.isSetAccessorDeclaration,
  ts.isPropertyDeclaration,
  ts.isPropertySignature,
  ts.isMethodSignature,
  ts.isCallSignatureDeclaration,
  ts.isConstructSignatureDeclaration,
  ts.isIndexSignatureDeclaration,
  ts.isVariableStatement,
  ts.isEnumMember,
  ts.isArrowFunction,
  ts.isFunctionExpression,
];

function exhaustiveIsCandidateRoot(node: ts.Node): boolean {
  return exhaustiveCandidateChecks.some((isCandidate) => isCandidate(node));
}

function exhaustiveScriptKind(file: string): ts.ScriptKind {
  switch (path.extname(file)) {
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
      return ts.ScriptKind.JS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function exhaustiveLineRangeFor(sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    endLine: end.line + 1,
  };
}

function exhaustiveLocation(entry: ExhaustiveEntry): { file: string; startLine: number; endLine: number; nodes: number } {
  return { file: entry.file, startLine: entry.startLine, endLine: entry.endLine, nodes: entry.nodes };
}

function exhaustiveSimilarity(left: ExhaustiveEntry, right: ExhaustiveEntry): number {
  const union = new Set([...left.fingerprints, ...right.fingerprints]);
  if (union.size === 0) {
    return 0;
  }
  const [smaller, larger] =
    left.fingerprints.length <= right.fingerprints.length
      ? [left.fingerprints, right.fingerprints]
      : [right.fingerprints, left.fingerprints];
  const largerSet = new Set(larger);
  let shared = 0;
  smaller.forEach((fingerprint) => {
    if (largerSet.has(fingerprint)) {
      shared += 1;
    }
  });
  return shared / union.size;
}

function exhaustiveMaxPossibleSimilarity(left: ExhaustiveEntry, right: ExhaustiveEntry): number {
  const [smaller, larger] = [left.fingerprints.length, right.fingerprints.length].sort((a, b) => a - b);
  return larger > 0 ? smaller / larger : 0;
}

function canonicalClusters(clusters: readonly Cluster[]): Array<{
  readonly score: { readonly min: number; readonly max: number };
  readonly locations: readonly string[];
}> {
  return clusters
    .map((cluster) => ({
      score: cluster.score,
      locations: cluster.locations.map(canonicalLocation).sort(),
    }))
    .sort((left, right) => left.locations.join("\0").localeCompare(right.locations.join("\0")));
}

function canonicalLocation(location: { file: string; startLine: number; endLine: number; nodes: number }): string {
  return `${location.file}:${location.startLine}-${location.endLine}:${location.nodes}`;
}

type MatchingPairProbeEntry = {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly nodes: number;
  readonly fingerprints: Float64Array;
};

type MatchingPairProbe = readonly [MatchingPairProbeEntry, MatchingPairProbeEntry, number];

function matchingPairsForTest(entries: readonly MatchingPairProbeEntry[], threshold: number): MatchingPairProbe[] {
  const finder = new TypeScriptDuplicateFinder() as unknown as {
    matchingPairs(entries: readonly MatchingPairProbeEntry[], threshold: number): MatchingPairProbe[];
  };
  return finder.matchingPairs(entries, threshold);
}

const probeFingerprintIds = new Map<string, number>();

function probeFingerprintId(fingerprint: string): number {
  const existing = probeFingerprintIds.get(fingerprint);
  if (existing !== undefined) {
    return existing;
  }
  const id = probeFingerprintIds.size;
  probeFingerprintIds.set(fingerprint, id);
  return id;
}

function matchingPairEntry(
  file: string,
  startLine: number,
  endLine: number,
  fingerprints: readonly string[],
): MatchingPairProbeEntry {
  const ids = Float64Array.from(new Set(fingerprints.map(probeFingerprintId)));
  ids.sort();
  return { file, startLine, endLine, nodes: ids.length, fingerprints: ids };
}

function matchingPairLocation(entry: MatchingPairProbeEntry): {
  file: string;
  startLine: number;
  endLine: number;
  nodes: number;
} {
  return { file: entry.file, startLine: entry.startLine, endLine: entry.endLine, nodes: entry.nodes };
}

function testEntriesOverlap(left: MatchingPairProbeEntry, right: MatchingPairProbeEntry): boolean {
  if (left.file !== right.file) {
    return false;
  }
  const firstEndingLine = Math.min(left.endLine, right.endLine);
  const lastStartingLine = Math.max(left.startLine, right.startLine);
  return lastStartingLine <= firstEndingLine;
}

function matchingPairKey([left, right]: MatchingPairProbe): string {
  return [left.file, right.file].sort().join("|");
}

function hasClusterContaining(clusters: readonly Cluster[], ...files: string[]): boolean {
  return clusters.some((cluster) =>
    files.every((file) => cluster.locations.some((location) => location.file.endsWith(file))),
  );
}

test("structurally identical snippets with different names cluster together", async () => {
  const { clusters } = await scanFixture(
    {
      "alpha.ts": `
function computeAlpha(items: number[]): number {
  const kept = items.filter((item) => item % 2 === 0);
  return kept.map((item) => item * 2).reduce((acc, val) => acc + val, 0);
}
`,
      "beta.ts": `
function computeBeta(values: number[]): number {
  const kept = values.filter((value) => value % 3 === 1);
  return kept.map((value) => value + 1).reduce((acc, val) => acc + val, 0);
}
`,
    },
    { threshold: 0.5, minLines: 3, minNodes: 8 },
  );

  assert.ok(hasClusterContaining(clusters, "alpha.ts", "beta.ts"));
});

test("clearly different snippets do not cluster at high threshold", async () => {
  const { dir } = await writeFixture({
    "add.ts": `
function add(a: number, b: number): number {
  return a + b;
}
`,
    "nested.ts": `
function deeply(x: number): number {
  if (x > 0) {
    for (let i = 0; i < x; i++) {
      while (i > 0) {
        i -= 1;
      }
    }
  }
  return x;
}
`,
  });
  const clusters = new TypeScriptDuplicateFinder().findClusters({
    paths: [dir],
    threshold: 0.95,
    minLines: 3,
    minNodes: 1,
  });
  assert.equal(clusters.length, 0, "structurally distinct functions should not cluster at 0.95 threshold");
});

test("findClusters called twice on same instance returns same shape", async () => {
  const { dir } = await writeFixture({
    "one.ts": `
export function process(items: number[]): number {
  const kept = items.filter((item) => item % 2 === 0);
  return kept.map((item) => item * 2).reduce((sum, next) => sum + next, 0);
}
`,
    "two.ts": `
export function handle(values: number[]): number {
  const kept = values.filter((value) => value % 2 === 1);
  return kept.map((value) => value + 1).reduce((sum, next) => sum + next, 0);
}
`,
  });

  const finder = new TypeScriptDuplicateFinder();
  const opts = { paths: [dir], threshold: 0.3, minLines: 3, minNodes: 4 };
  const first = finder.findClusters(opts);
  const second = finder.findClusters(opts);

  assert.equal(first.length, second.length, "cluster count should be stable across calls");
  assert.deepEqual(
    first.map((c) => c.locations.map((l) => l.file).sort()).sort(),
    second.map((c) => c.locations.map((l) => l.file).sort()).sort(),
    "cluster files should be identical across calls",
  );
});

test("main --help prints USAGE to stdout", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await main(["--help"]);
  } finally {
    console.log = original;
  }
  assert.ok(lines.some((line) => line.includes("Usage: dry-ts")), `Expected USAGE in stdout, got: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((line) => line.includes(USAGE.split("\n")[0])));
});

test("main with invalid --threshold value sets exitCode 2 and writes to stderr", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    process.exitCode = 0;
    await main(["--threshold", "bad"]);
    assert.equal(process.exitCode, 2);
    assert.ok(errors.length > 0, "Expected something written to stderr");
  } finally {
    console.error = originalError;
    process.exitCode = 0;
  }
});

test("main with --format xml sets exitCode 2", async () => {
  const { dir } = await writeFixture({ "solo.ts": duplicateBody });
  const originalError = console.error;
  console.error = () => {};
  const originalLog = console.log;
  console.log = () => {};
  try {
    process.exitCode = 0;
    await main(["--format", "xml", dir]);
    assert.equal(process.exitCode, 2);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.exitCode = 0;
  }
});

test("main --fail-on-duplicates with duplicates sets exitCode 1", async () => {
  const { dir } = await writeFixture({
    "alpha.ts": duplicateBody,
    "beta.ts": duplicateBody,
  });
  const result = Bun.spawnSync(
    ["bun", "run", "src/bin/dry-ts.ts", "--fail-on-duplicates", "--threshold", "0.2", "--min-lines", "3", "--min-nodes", "8", dir],
    { cwd: repoRoot },
  );
  assert.equal(result.exitCode, 1);
});

test("main --fail-on-duplicates with no duplicates leaves exitCode 0", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dry-ts-nodups-"));
  await writeFile(path.join(dir, "solo.ts"), duplicateBody);
  const result = Bun.spawnSync(
    ["bun", "run", "src/bin/dry-ts.ts", "--fail-on-duplicates", "--threshold", "0.99", "--min-lines", "100", "--min-nodes", "9999", dir],
    { cwd: repoRoot },
  );
  assert.equal(result.exitCode, 0);
});

test("printText with empty clusters prints no duplicate clusters found", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    printText([]);
  } finally {
    console.log = original;
  }
  assert.deepEqual(lines, ["No duplicate clusters found."]);
});

test("printText with two clusters separates them with a blank line", () => {
  const collector = new ClusterCollector();
  const loc = (file: string) => ({ file, startLine: 10, endLine: 14, nodes: 50 });
  collector.addMatch(loc("a.ts"), loc("b.ts"), 0.9);
  collector.addMatch(loc("c.ts"), loc("d.ts"), 0.8);
  const clusters = collector.clusters();
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    printText(clusters);
  } finally {
    console.log = original;
  }
  assert.ok(lines.includes(""), "Expected a blank line separator between clusters");
  assert.ok(lines.some((l) => l.startsWith("CLUSTER 1")));
  assert.ok(lines.some((l) => l.startsWith("CLUSTER 2")));
});

test("toJson with empty clusters returns object with empty clusters array", () => {
  assert.deepEqual(JSON.parse(toJson([])), { clusters: [] });
});

test("toEdn with two clusters includes both entries", () => {
  const collector = new ClusterCollector();
  const loc = (file: string) => ({ file, startLine: 10, endLine: 14, nodes: 50 });
  collector.addMatch(loc("x.ts"), loc("y.ts"), 0.9);
  collector.addMatch(loc("p.ts"), loc("q.ts"), 0.8);
  const clusters = collector.clusters();
  const edn = toEdn(clusters);
  assert.ok(edn.includes('"x.ts"'), `Expected x.ts in edn, got: ${edn}`);
  assert.ok(edn.includes('"y.ts"'), `Expected y.ts in edn, got: ${edn}`);
  assert.ok(edn.includes('"p.ts"'), `Expected p.ts in edn, got: ${edn}`);
  assert.ok(edn.includes('"q.ts"'), `Expected q.ts in edn, got: ${edn}`);
});

test("ClusterCollector updates location to higher node count on same location added twice", () => {
  const collector = new ClusterCollector();
  const loc = { file: "a.ts", startLine: 1, endLine: 5, nodes: 10 };
  const locHigher = { file: "a.ts", startLine: 1, endLine: 5, nodes: 50 };
  const other = { file: "b.ts", startLine: 1, endLine: 5, nodes: 10 };
  collector.addMatch(loc, other, 0.9);
  collector.addMatch(locHigher, other, 0.9);
  const clusters = collector.clusters();
  const aLoc = clusters[0].locations.find((l) => l.file === "a.ts");
  assert.ok(aLoc);
  assert.equal(aLoc.nodes, 50);
});

test("Options.from with respectGitignore false sets respectGitignore to false", () => {
  assert.equal(Options.from({ respectGitignore: false }).respectGitignore, false);
});

test("toEdn escapes backslash and double quote in file names", () => {
  const collector = new ClusterCollector();
  const left = { file: 'path\\to\\"file".ts', startLine: 1, endLine: 5, nodes: 10 };
  const right = { file: "other.ts", startLine: 1, endLine: 5, nodes: 10 };
  collector.addMatch(left, right, 0.9);
  const edn = toEdn(collector.clusters());
  assert.ok(edn.includes('path\\\\to\\\\\\"file\\"'), `Expected escaped path in edn, got: ${edn}`);
});

// Regression: minLines gate in FileScanner — normalizer mock on TypeScriptDuplicateFinder
// no longer intercepts FileScanner's internal normalizer. Verify the gate via FileScanner directly.
test("FileScanner.scanFile excludes candidates shorter than minLines", async () => {
  const { dir } = await writeFixture({
    "short.ts": "function short(x: number) { return x; }\n",
  });
  const file = path.join(dir, "short.ts");
  const entries = new FileScanner().scanFile(file, 5, 1);
  assert.deepEqual(entries, [], "single-line function should not produce an entry when minLines=5");
});

test("FileScanner.scanFile includes candidates spanning exactly minLines", async () => {
  const { dir } = await writeFixture({
    "exact.ts": "function exact(x: number): number {\n  const y = x + 1;\n  return y;\n}\n",
  });
  const file = path.join(dir, "exact.ts");
  assert.equal(new FileScanner().scanFile(file, 4, 1).length, 1, "4-line function included at minLines=4");
  assert.equal(new FileScanner().scanFile(file, 5, 1).length, 0, "4-line function excluded at minLines=5");
});

test("FileScanner.scanFile propagates errors for missing files", async () => {
  const { dir } = await writeFixture({});
  assert.throws(() => new FileScanner().scanFile(path.join(dir, "missing.ts"), 1, 1), /ENOENT/);
});

test("FingerprintInterner.idFor is order-sensitive over children", () => {
  const interner = new FingerprintInterner();
  const a = interner.idFor("LeafA", []);
  const b = interner.idFor("LeafB", []);
  assert.notEqual(a, b);
  const ab = interner.idFor("Parent", [a, b]);
  const ba = interner.idFor("Parent", [b, a]);
  assert.notEqual(ab, ba, "child order must change the hash");
  assert.equal(interner.idFor("Parent", [a, b]), ab, "same children give same hash");
});

test("FileScanner.scanFile throws on files with parse errors", async () => {
  const { dir } = await writeFixture({
    "broken.ts": "const = (((((\n",
  });
  const file = path.join(dir, "broken.ts");
  assert.throws(
    () => new FileScanner().scanFile(file, 1, 1),
    /Unable to parse/,
    "Expected scanFile to throw on syntactically invalid TypeScript",
  );
});

test("FingerprintInterner.idFor returns consistent hashes for same tag and children", () => {
  const interner = new FingerprintInterner();
  const id1 = interner.idFor("FunctionDeclaration", []);
  const id2 = interner.idFor("FunctionDeclaration", []);
  assert.equal(id1, id2, "Same tag+children should produce the same 53-bit hash");
  const id3 = interner.idFor("ClassDeclaration", []);
  assert.notEqual(id1, id3, "Different tags should produce different hashes");
  assert.ok(id1 >= 0, "Hash should be non-negative");
  assert.ok(id1 < 2 ** 53, "Hash should fit in 53 bits");
});

// ---------------------------------------------------------------------------
// Incremental duplicate gating (--changed-from / --changed)
// ---------------------------------------------------------------------------

const uniqueBody = `
export function lookup(table: Map<string, number>, key: string): string {
  if (!table.has(key)) {
    throw new Error("missing " + key);
  }
  return key + "=" + String(table.get(key));
}
`;

// Same structure as uniqueBody with renamed identifiers: clusters with it.
const uniqueBodyCopy = `
export function fetchEntry(store: Map<string, number>, name: string): string {
  if (!store.has(name)) {
    throw new Error("absent " + name);
  }
  return name + "=" + String(store.get(name));
}
`;

const gateFlags = ["--threshold", "0.5", "--min-lines", "3", "--min-nodes", "8"];

const hermeticGitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function runCli(
  args: readonly string[],
  cwd: string,
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", "run", path.join(repoRoot, "src/bin/dry-ts.ts"), ...args], {
    cwd,
    env: hermeticGitEnv,
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=dry-ts", "-c", "user.email=dry-ts@test", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, env: hermeticGitEnv },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

async function writeTree(dir: string, sources: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(sources)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

// Hermetic git fixture: explicit identity, no gpg, explicit initial branch,
// global/system config masked, so runner-global git config can never flake
// the suite.
async function gitRepo(sources: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dry-ts-git-"));
  await writeTree(dir, sources);
  git(dir, "init", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "base");
  return dir;
}

function statusByFile(stdout: string): Map<string, string> {
  const byFile = new Map<string, string>();
  for (const cluster of JSON.parse(stdout).clusters) {
    for (const location of cluster.locations) {
      byFile.set(location.file.split(path.sep).join("/"), cluster.status);
    }
  }
  return byFile;
}

const parseDiffCases: Array<{
  name: string;
  diff: string[];
  expect: Array<{ file: string; start: number; end: number }>;
}> = [
  {
    name: "modification hunk yields post-image range",
    diff: [
      "diff --git a/a.ts b/a.ts",
      "index 1111111..2222222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3,2 +3,3 @@ export function f() {",
      "-old",
      "-old",
      "+new",
      "+new",
      "+new",
    ],
    expect: [{ file: "a.ts", start: 3, end: 5 }],
  },
  {
    name: "omitted counts default to 1",
    diff: ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -3 +4 @@", "-x", "+y"],
    expect: [{ file: "a.ts", start: 4, end: 4 }],
  },
  {
    name: "deletion-only hunk marks the post-image boundary line",
    diff: ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -10,2 +9,0 @@", "-x", "-y"],
    expect: [{ file: "a.ts", start: 9, end: 9 }],
  },
  {
    name: "deletion at top of file marks line 1",
    diff: ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +0,0 @@", "-x", "-y"],
    expect: [{ file: "a.ts", start: 1, end: 1 }],
  },
  {
    name: "new file marks added lines",
    diff: [
      "diff --git a/n.ts b/n.ts",
      "new file mode 100644",
      "index 0000000..2222222",
      "--- /dev/null",
      "+++ b/n.ts",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
    ],
    expect: [{ file: "n.ts", start: 1, end: 2 }],
  },
  {
    name: "deleted file marks nothing (no post-image)",
    diff: [
      "diff --git a/d.ts b/d.ts",
      "deleted file mode 100644",
      "--- a/d.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
    ],
    expect: [],
  },
  {
    name: "binary file marker is skipped",
    diff: ["diff --git a/x.png b/x.png", "index 1111111..2222222 100644", "Binary files a/x.png and b/x.png differ"],
    expect: [],
  },
  {
    name: "rename headers are skipped and ranges land on the new path",
    diff: [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "index 1111111..2222222 100644",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -5,1 +5,1 @@",
      "-x",
      "+y",
    ],
    expect: [{ file: "new.ts", start: 5, end: 5 }],
  },
  {
    name: "mode-change-only block is skipped",
    diff: ["diff --git a/a.ts b/a.ts", "old mode 100644", "new mode 100755"],
    expect: [],
  },
  {
    name: "no-newline marker inside a hunk is skipped",
    diff: ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,1 @@", "-x", "\\ No newline at end of file", "+y", "\\ No newline at end of file"],
    expect: [{ file: "a.ts", start: 1, end: 1 }],
  },
  {
    name: "submodule log line is skipped",
    diff: ["Submodule lib 1111111..2222222:"],
    expect: [],
  },
];

for (const { name, diff, expect } of parseDiffCases) {
  test(`parseUnifiedDiff: ${name}`, () => {
    const regions = parseUnifiedDiff(`${diff.join("\n")}\n`);
    const actual = regions
      .entries()
      .flatMap(({ file, ranges }) => ranges.map((range) => ({ file, start: range.start, end: range.end })));
    assert.deepEqual(actual, expect);
  });
}

const parseDiffErrorCases: Array<{ name: string; diff: string[] }> = [
  { name: "unrecognized line", diff: ["this is not a diff"] },
  { name: "truncated hunk", diff: ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,2 @@", "-x", "+y"] },
  { name: "hunk before any file header", diff: ["@@ -1,1 +1,1 @@", "-x", "+y"] },
  { name: "context line inside a -U0 hunk", diff: ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,1 @@", " context"] },
];

for (const { name, diff } of parseDiffErrorCases) {
  test(`parseUnifiedDiff rejects ${name}`, () => {
    assert.throws(() => parseUnifiedDiff(`${diff.join("\n")}\n`));
  });
}

test("ChangedRegions intersection is inclusive on boundary lines", () => {
  const regions = new ChangedRegions();
  regions.addRange("a.ts", 10, 12, "hunk");
  assert.equal(regions.intersectsLocation("a.ts", 12, 20), true);
  assert.equal(regions.intersectsLocation("a.ts", 1, 10), true);
  assert.equal(regions.intersectsLocation("a.ts", 13, 20), false);
  assert.equal(regions.intersectsLocation("b.ts", 10, 12), false);
  regions.addWholeFile("b.ts", "untracked");
  assert.equal(regions.intersectsLocation("b.ts", 5000, 5001), true);
});

test("canonicalPath produces root-relative forward-slash keys", () => {
  assert.equal(canonicalPath("/repo", "/repo/src/a.ts"), "src/a.ts");
  const cwdRelative = canonicalPath(process.cwd(), path.join("src", "DryTs.ts"));
  assert.equal(cwdRelative, "src/DryTs.ts");
});

test("--changed-from marks a copied function as new and pre-existing duplication as known", async () => {
  const dir = await gitRepo({
    "known1.ts": duplicateBody,
    "known2.ts": duplicateBody,
    "lib.ts": uniqueBody,
  });
  await writeFile(path.join(dir, "known1.ts"), duplicateBody + uniqueBodyCopy);

  const json = runCli([...gateFlags, "--json", "--changed-from", "HEAD", "."], dir);
  assert.equal(json.exitCode, 0);
  const statuses = statusByFile(json.stdout);
  assert.equal(statuses.get("lib.ts"), "new", json.stdout);
  assert.equal(statuses.get("known2.ts"), "known", json.stdout);

  const gated = runCli([...gateFlags, "--fail-on-duplicates", "--changed-from", "HEAD", "."], dir);
  assert.equal(gated.exitCode, 1, gated.stderr);
});

test("--changed-from with a clean tree reports everything known and exits 0 under the gate", async () => {
  const dir = await gitRepo({ "known1.ts": duplicateBody, "known2.ts": duplicateBody });
  const result = runCli([...gateFlags, "--json", "--fail-on-duplicates", "--changed-from", "HEAD", "."], dir);
  assert.equal(result.exitCode, 0, result.stderr);
  const statuses = [...statusByFile(result.stdout).values()];
  assert.ok(statuses.length > 0 && statuses.every((status) => status === "known"), result.stdout);
});

test("--changed-from counts an untracked duplicate file as fully changed", async () => {
  const dir = await gitRepo({ "lib.ts": uniqueBody });
  await writeFile(path.join(dir, "copy.ts"), uniqueBodyCopy);

  const result = runCli([...gateFlags, "--json", "--fail-on-duplicates", "--changed-from", "HEAD", "."], dir);
  assert.equal(result.exitCode, 1, result.stderr);
  assert.equal(statusByFile(result.stdout).get("copy.ts"), "new", result.stdout);
});

test("--changed-from gates a scanned file hidden from git by a nested .gitignore", async () => {
  // The scanner honors only the cwd .gitignore; git's ignore stack also reads
  // nested ones. The untracked rule is index-based, so the divergence cannot
  // open a bypass: the scanned-but-ignored file still counts as changed.
  const dir = await gitRepo({ "lib.ts": uniqueBody });
  await writeTree(dir, { "deep/.gitignore": "copy.ts\n", "deep/copy.ts": uniqueBodyCopy });

  const result = runCli([...gateFlags, "--json", "--fail-on-duplicates", "--changed-from", "HEAD", "."], dir);
  assert.equal(result.exitCode, 1, result.stderr);
  assert.equal(statusByFile(result.stdout).get("deep/copy.ts"), "new", result.stdout);
});

test("--changed-from follows renames and only edited hunks count as changed", async () => {
  const dir = await gitRepo({
    "pair.ts": duplicateBody + uniqueBody,
    "pair2.ts": duplicateBody,
  });
  git(dir, "mv", "pair.ts", "moved.ts");
  // Edit only the lookup() region of the renamed file; the duplicate process()
  // region at the top is untouched, so its cluster must stay known.
  const moved = (await readFile(path.join(dir, "moved.ts"), "utf8")).replace(
    'throw new Error("missing " + key);',
    'console.warn(key);\n    throw new Error("missing " + key);',
  );
  await writeFile(path.join(dir, "moved.ts"), moved);

  const result = runCli([...gateFlags, "--json", "--fail-on-duplicates", "--changed-from", "HEAD", "."], dir);
  assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(statusByFile(result.stdout).get("moved.ts"), "known", result.stdout);
});

test("--changed-from diffs from merge-base, not literally from the ref", async () => {
  // A branch behind its base must not see base-side changes pollute the
  // changed set: a literal diff against main would mark the duplicate region
  // changed and fail the gate with a false "new".
  const dir = await gitRepo({ "known1.ts": duplicateBody, "known2.ts": duplicateBody });
  git(dir, "checkout", "-b", "feature");
  git(dir, "checkout", "main");
  await writeFile(path.join(dir, "known1.ts"), uniqueBody);
  git(dir, "commit", "-am", "rewrite known1 on main");
  git(dir, "checkout", "feature");

  const result = runCli([...gateFlags, "--json", "--fail-on-duplicates", "--changed-from", "main", "."], dir);
  assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
  const statuses = [...statusByFile(result.stdout).values()];
  assert.ok(statuses.every((status) => status === "known"), result.stdout);
});

test("--changed-from sees edits in a tracked file whose name contains a space", async () => {
  // git diff appends a trailing TAB to the +++ header when the path has a
  // space; if the parser keeps it, the region keys under "a file.ts\t" and
  // never matches the scanner's "a file.ts" key, waving the new dup through.
  const dir = await gitRepo({ "a file.ts": uniqueBody });
  await writeFile(path.join(dir, "a file.ts"), uniqueBody + uniqueBodyCopy);

  const result = runCli([...gateFlags, "--json", "--fail-on-duplicates", "--changed-from", "HEAD", "."], dir);
  assert.equal(result.exitCode, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(statusByFile(result.stdout).get("a file.ts"), "new", result.stdout);
});

test("--changed-from does not misflag a clean tracked file whose name contains a tab", async () => {
  // git ls-files C-quotes "a\tb.ts" while the scanner reads the literal tab;
  // comparing without -z would mark the clean tracked file untracked -> new
  // -> a false exit 1 on a tree nobody changed.
  const tab = "a\tb.ts";
  const dir = await gitRepo({ [tab]: duplicateBody, "plain.ts": duplicateBody });
  const result = runCli([...gateFlags, "--json", "--fail-on-duplicates", "--changed-from", "HEAD", "."], dir);
  assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
  const statuses = [...statusByFile(result.stdout).values()];
  assert.ok(statuses.length > 0 && statuses.every((status) => status === "known"), result.stdout);
});

test("--changed-from sees edits in a tracked file whose name contains a tab", async () => {
  // git quotes the +++ header for control-char names ("b/a\tb.ts"); if the
  // parser keeps the escapes the region keys under a path the scanner never
  // produces, silently waving the new dup through as known.
  const tab = "a\tb.ts";
  const dir = await gitRepo({ [tab]: uniqueBody });
  await writeFile(path.join(dir, tab), uniqueBody + uniqueBodyCopy);
  const result = runCli([...gateFlags, "--json", "--fail-on-duplicates", "--changed-from", "HEAD", "."], dir);
  assert.equal(result.exitCode, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(statusByFile(result.stdout).get(tab), "new", result.stdout);
});

test("--changed-from canonicalizes paths when cwd is not the repo root", async () => {
  const dir = await gitRepo({ "pkg/src/lib.ts": uniqueBody, "pkg/src/other.ts": duplicateBody });
  await writeFile(path.join(dir, "pkg/src/lib.ts"), uniqueBody + uniqueBodyCopy);

  const result = runCli(
    [...gateFlags, "--json", "--fail-on-duplicates", "--changed-from", "HEAD", "src"],
    path.join(dir, "pkg"),
  );
  assert.equal(result.exitCode, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(statusByFile(result.stdout).get("src/lib.ts"), "new", result.stdout);
});

test("--changed scopes the whole listed file and leaves other clusters known", async () => {
  const { dir } = await writeFixture({
    "edited.ts": uniqueBody + uniqueBodyCopy,
    "known1.ts": duplicateBody,
    "known2.ts": duplicateBody,
  });
  const result = runCli([...gateFlags, "--json", "--changed", "edited.ts", "."], dir);
  assert.equal(result.exitCode, 0, result.stderr);
  const statuses = statusByFile(result.stdout);
  assert.equal(statuses.get("edited.ts"), "new", result.stdout);
  assert.equal(statuses.get("known1.ts"), "known", result.stdout);

  const gated = runCli([...gateFlags, "--fail-on-duplicates", "--changed", "edited.ts", "."], dir);
  assert.equal(gated.exitCode, 1, gated.stderr);
});

test("--changed is repeatable and scopes every listed file independently", async () => {
  // Three independent clusters. Two --changed flags target one file in each of
  // the first two; the third cluster is never listed. A single global "any
  // --changed -> all new" bug would wrongly flip the third to new.
  const thirdBody = `
export function classify(score: number): string {
  if (score > 90) {
    return "high";
  }
  return score > 50 ? "mid" : "low";
}
`;
  const { dir } = await writeFixture({
    "look1.ts": uniqueBody,
    "look2.ts": uniqueBodyCopy,
    "proc1.ts": duplicateBody,
    "proc2.ts": duplicateBody,
    "cls1.ts": thirdBody,
    "cls2.ts": thirdBody,
  });
  const result = runCli([...gateFlags, "--json", "--changed", "look1.ts", "--changed", "proc1.ts", "."], dir);
  assert.equal(result.exitCode, 0, result.stderr);
  const statuses = statusByFile(result.stdout);
  assert.equal(statuses.get("look2.ts"), "new", result.stdout);
  assert.equal(statuses.get("proc2.ts"), "new", result.stdout);
  assert.equal(statuses.get("cls2.ts"), "known", result.stdout);
});

async function twoDuplicateFiles(): Promise<string> {
  const { dir } = await writeFixture({ "one.ts": duplicateBody, "two.ts": duplicateBody });
  return dir;
}

test("status appears in every output format", async () => {
  const dir = await twoDuplicateFiles();
  const text = runCli([...gateFlags, "--changed", "one.ts", "."], dir);
  assert.ok(text.stdout.includes("status=new (intersects your change)"), text.stdout);
  const edn = runCli([...gateFlags, "--edn", "--changed", "one.ts", "."], dir);
  assert.ok(edn.stdout.includes(":status :new"), edn.stdout);
  const unscoped = runCli([...gateFlags, "--json", "."], dir);
  assert.ok(unscoped.stdout.includes('"status": "unscoped"'), unscoped.stdout);
});

test("--explain-changed dumps the resolved changed-region map to stderr", async () => {
  const result = runCli([...gateFlags, "--explain-changed", "--changed", "one.ts", "."], await twoDuplicateFiles());
  assert.ok(result.stderr.includes("Changed regions (--explain-changed):"), result.stderr);
  assert.ok(result.stderr.includes("one.ts (entire file, listed)"), result.stderr);
});

test("ungateable --changed files warn without the gate and exit 2 under it", async () => {
  const { dir } = await writeFixture({ "one.ts": duplicateBody });
  await writeTree(dir, { "sub/two.ts": uniqueBody });
  await mkdir(path.join(dir, "emptydir"), { recursive: true });
  const cases = ["missing.ts", "emptydir", path.join("sub", "two.ts")];
  for (const changed of cases) {
    const warned = runCli([...gateFlags, "--changed", changed, "one.ts"], dir);
    assert.equal(warned.exitCode, 0, `${changed}: ${warned.stderr}`);
    assert.ok(warned.stderr.includes("warning:"), `${changed}: ${warned.stderr}`);
    const gated = runCli([...gateFlags, "--fail-on-duplicates", "--changed", changed, "one.ts"], dir);
    assert.equal(gated.exitCode, 2, `${changed}: ${gated.stderr}`);
  }
});

test("usage and environment errors exit 2", async () => {
  const { dir } = await writeFixture({ "one.ts": duplicateBody });
  const gitDir = await gitRepo({ "lib.ts": uniqueBody });
  const cases: Array<{ args: string[]; cwd: string; stderrIncludes: string }> = [
    { args: ["--changed-from", "HEAD", "--changed", "one.ts", "."], cwd: dir, stderrIncludes: "cannot be combined" },
    { args: ["--changed-from", "HEAD", "."], cwd: dir, stderrIncludes: "not a git repository" },
    { args: ["--changed-from", "no-such-ref", "."], cwd: gitDir, stderrIncludes: "no-such-ref" },
    { args: ["--changed-from", "-output=x", "."], cwd: gitDir, stderrIncludes: "must not start with" },
    { args: ["--changed-frm", "HEAD", "."], cwd: dir, stderrIncludes: "Unknown option: --changed-frm" },
  ];
  for (const { args, cwd, stderrIncludes } of cases) {
    const result = runCli(args, cwd);
    assert.equal(result.exitCode, 2, `${args.join(" ")}: exited ${result.exitCode}\n${result.stderr}`);
    assert.ok(result.stderr.includes(stderrIncludes), `${args.join(" ")}: ${result.stderr}`);
  }
});

test("--changed-from rejects a ref that resolves to a non-commit object", async () => {
  // verifyRef appends ^{commit} precisely to reject tree/blob targets; a plain
  // rev-parse --verify would accept a tree sha and then merge-base would fail
  // with a murkier error. Point it at HEAD's tree and assert the clean exit 2.
  const dir = await gitRepo({ "lib.ts": uniqueBody });
  const tree = Bun.spawnSync(["git", "rev-parse", "HEAD^{tree}"], { cwd: dir, env: hermeticGitEnv })
    .stdout.toString()
    .trim();
  const result = runCli([...gateFlags, "--changed-from", tree, "."], dir);
  assert.equal(result.exitCode, 2, `tree=${tree}: exited ${result.exitCode}\n${result.stderr}`);
});

test("zero files scanned under --fail-on-duplicates exits 2", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dry-ts-empty-"));
  const gated = runCli(["--fail-on-duplicates", "."], dir);
  assert.equal(gated.exitCode, 2, gated.stderr);
  assert.ok(gated.stderr.includes("No files were scanned"), gated.stderr);
  const ungated = runCli(["."], dir);
  assert.equal(ungated.exitCode, 0, ungated.stderr);
});

test("scanner errors under gating exit 2, never 1", async () => {
  const { dir } = await writeFixture({ "bad.ts": "let 123 = ;\n", "one.ts": duplicateBody });
  const result = runCli([...gateFlags, "--fail-on-duplicates", "--changed", "one.ts", "."], dir);
  assert.equal(result.exitCode, 2, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.stderr.includes("bad.ts"), result.stderr);
});

test("unscoped --fail-on-duplicates still exits 1 while clusters report status unscoped", async () => {
  const { dir } = await writeFixture({ "one.ts": duplicateBody, "two.ts": duplicateBody });
  const result = runCli([...gateFlags, "--json", "--fail-on-duplicates", "."], dir);
  assert.equal(result.exitCode, 1, result.stderr);
  const statuses = [...statusByFile(result.stdout).values()];
  assert.ok(statuses.length > 0 && statuses.every((status) => status === "unscoped"), result.stdout);
});

test("ChangedRegions.describe reports empty, line-range, and whole-file entries", () => {
  const empty = new ChangedRegions();
  assert.equal(empty.describe(), "  (no changed regions)");

  const regions = new ChangedRegions();
  regions.addRange("a.ts", 3, 5, "hunk");
  regions.addWholeFile("b.ts", "listed");
  assert.equal(regions.describe(), "  a.ts:3-5 (hunk)\n  b.ts (entire file, listed)");
});

test("--explain-changed without any changed scope reports no scope active", async () => {
  const { dir } = await writeFixture({ "one.ts": duplicateBody, "two.ts": duplicateBody });
  const result = runCli([...gateFlags, "--explain-changed", "."], dir);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(result.stderr.includes("Changed regions (--explain-changed):"), result.stderr);
  assert.ok(result.stderr.includes("(no changed scope active)"), result.stderr);
});
