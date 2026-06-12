import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clusterCandidates,
  formatCandidate,
  formatCluster,
  main,
  Options,
  printText,
  toEdn,
  toJson,
  USAGE,
  TypeScriptDuplicateFinder,
  type Candidate,
} from "../src/index.js";
import { ClusterCollector } from "../src/Clusters.js";

test("reports structural duplicate candidates with file and line ranges", async () => {
  const { files, candidates } = await scanFixture(
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

  const candidate = candidates.find(
    (each) =>
      each.left.file === files["left.ts"] &&
      each.right.file === files["right.ts"] &&
      each.left.startLine === 3 &&
      each.right.startLine === 3,
  );
  assert.ok(candidate);
  assert.equal(candidate.left.endLine, 6);
  assert.equal(candidate.right.endLine, 6);
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
    const { candidates } = await scanFixture(sources, options);

    assert.ok(hasDuplicate(candidates, "one.ts", "two.ts"));
  });
}

test("scans JavaScript, JSX, and TSX files", async () => {
  const { candidates } = await scanFixture(
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

  assert.ok(hasDuplicate(candidates, "one.js", "two.jsx"));
  assert.ok(hasDuplicate(candidates, "one.js", "three.tsx"));
});

test("filters candidates shorter than the minimum line count", async () => {
  const { candidates } = await scanFixture(
    {
      "one.ts": "function one(x: number) { return x + 1; }\n",
      "two.ts": "function two(y: number) { return y + 2; }\n",
    },
    { threshold: 0.8, minLines: 3, minNodes: 1 },
  );

  assert.deepEqual(candidates, []);
});

test("parses command line options and paths", () => {
  const options = Options.parse(
    "--threshold",
    "0.9",
    "--min-lines",
    "5",
    "--min-nodes",
    "30",
    "--json",
    "--fail-on-duplicates",
    "spec",
  );

  assert.deepEqual(options.paths, ["spec"]);
  assert.equal(options.threshold, 0.9);
  assert.equal(options.minLines, 5);
  assert.equal(options.minNodes, 30);
  assert.equal(options.format, "json");
  assert.equal(options.failOnDuplicates, true);
});

test("defaults to src when no paths are provided", () => {
  assert.deepEqual(Options.parse().paths, ["src"]);
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
  assert.equal(options.format, "json");
  assert.equal(options.failOnDuplicates, true);
});

test("rejects invalid numeric option values", () => {
  assert.throws(() => Options.parse("--threshold", "high"), /Invalid number/);
  assert.throws(() => Options.parse("--min-lines", "many"), /Invalid integer/);
});

test("rejects out-of-range option values", () => {
  assert.throws(() => Options.parse("--threshold", "0"), /threshold must be/);
  assert.throws(() => Options.parse("--threshold", "1.5"), /threshold must be/);
  assert.throws(() => Options.from({ minLines: 0 }), /minLines must be/);
  assert.throws(() => Options.from({ minNodes: -1 }), /minNodes must be/);
});

test("formats text output with line ranges", () => {
  assert.equal(
    formatCandidate({
      score: 0.875,
      left: { file: "a.ts", startLine: 10, endLine: 14 },
      right: { file: "b.ts", startLine: 20, endLine: 24 },
      leftNodes: 88,
      rightNodes: 91,
    }),
    "DUPLICATE score=0.88\n  a.ts:10-14\n  b.ts:20-24",
  );
});

test("groups transitively connected candidates into clusters", () => {
  const ab = pair("a.ts", "b.ts", 0.9);
  const bc = pair("b.ts", "c.ts", 0.85);
  const de = pair("d.ts", "e.ts", 0.95);

  const clusters = clusterCandidates([de, ab, bc]);

  assert.equal(clusters.length, 2);
  assert.deepEqual(
    clusters.map((cluster) => cluster.locations.map((location) => location.file)),
    [["d.ts", "e.ts"], ["a.ts", "b.ts", "c.ts"]],
  );
  assert.deepEqual(clusters[1].score, { min: 0.85, max: 0.9 });
});

test("formats clusters with score range, location count, and node size", () => {
  const clusters = clusterCandidates([pair("a.ts", "b.ts", 0.9), pair("b.ts", "c.ts", 0.85)]);

  assert.equal(
    formatCluster(clusters[0], 1),
    "CLUSTER 1 score=0.85-0.90 locations=3\n  a.ts:10-14 nodes=50\n  b.ts:10-14 nodes=50\n  c.ts:10-14 nodes=50",
  );
});

test("does not expose complete pairwise match counts in cluster output", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
  const candidates = files.flatMap((left, leftIndex) =>
    files.slice(leftIndex + 1).map((right) => pair(left, right, 1)),
  );

  const [cluster] = clusterCandidates(candidates);

  assert.equal(cluster.locations.length, 5);
  assert.equal(formatCluster(cluster, 1).split("\n")[0], "CLUSTER 1 score=1.00 locations=5");
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

test("prints edn", () => {
  assert.equal(toEdn([]), "{:clusters []}");
});

test("prints edn clusters instead of every candidate pair", () => {
  const candidate = pair("a.ts", "b.ts", 0.875);
  const clusters = clusterCandidates([candidate]);

  assert.equal(
    toEdn(clusters),
    '{:clusters\n [{:score-min 0.875\n   :score-max 0.875\n   :location-count 2\n   :locations [{:file "a.ts", :start-line 10, :end-line 14, :nodes 50}\n               {:file "b.ts", :start-line 10, :end-line 14, :nodes 50}]}]}',
  );
});

test("prints json clusters for agents and ci integrations", () => {
  const ab = pair("a.ts", "b.ts", 0.875);
  const bc = pair("b.ts", "c.ts", 0.925);
  const clusters = clusterCandidates([ab, bc]);

  assert.deepEqual(JSON.parse(toJson(clusters)), {
    clusters: [{
      score: { min: 0.875, max: 0.925 },
      locationCount: 3,
      locations: [
        { ...ab.left, nodes: ab.leftNodes },
        { ...ab.right, nodes: ab.rightNodes },
        { ...bc.right, nodes: bc.rightNodes },
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
  const projectDir = await mkdtemp(path.join(tmpdir(), "dry4ts-gitignore-"));
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
  const projectDir = await mkdtemp(path.join(tmpdir(), "dry4ts-no-gitignore-"));
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
  const projectDir = await mkdtemp(path.join(tmpdir(), "dry4ts-explicit-"));
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
  const projectDir = await mkdtemp(path.join(tmpdir(), "dry4ts-no-ignore-file-"));
  await writeFile(path.join(projectDir, "a.ts"), duplicateBody);
  await writeFile(path.join(projectDir, "b.ts"), duplicateBody);

  assert.equal(scanFromCwd(projectDir).length, 1);
});

test("does not parse files inside gitignored directories", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "dry4ts-prune-"));
  const ignoredDir = path.join(projectDir, "ignored");
  await mkdir(ignoredDir);
  await writeFile(path.join(projectDir, ".gitignore"), "ignored/\n");
  await writeFile(path.join(projectDir, "one.ts"), duplicateBody);
  await writeFile(path.join(projectDir, "two.ts"), duplicateBody);
  await writeFile(path.join(ignoredDir, "broken.ts"), "const = (((((\n");

  assert.equal(scanFromCwd(projectDir).length, 1);
});

test("scans directory outside cwd and still finds duplicates", async () => {
  const externalDir = await mkdtemp(path.join(tmpdir(), "dry4ts-external-"));
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
  const projectDir = await mkdtemp(path.join(tmpdir(), "dry4ts-dedup-"));
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
): Promise<{ files: Record<string, string>; candidates: Candidate[] }> {
  const { files, dir } = await writeFixture(sources);
  const candidates = new TypeScriptDuplicateFinder().findDuplicates({ paths: [dir], ...options });
  return { files, candidates };
}

async function writeFixture(sources: Record<string, string>): Promise<{ files: Record<string, string>; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "dry4ts-"));
  const files: Record<string, string> = {};
  for (const [name, text] of Object.entries(sources)) {
    files[name] = await writeSource(dir, name, text);
  }
  return { files, dir };
}

function pair(left: string, right: string, score: number): Candidate {
  const location = (file: string) => ({ file, startLine: 10, endLine: 14 });
  return { score, left: location(left), right: location(right), leftNodes: 50, rightNodes: 50 };
}

function hasDuplicate(candidates: readonly Candidate[], left: string, right: string): boolean {
  return candidates.some((candidate) => candidate.left.file.endsWith(left) && candidate.right.file.endsWith(right));
}

test("main --help prints USAGE to stdout", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    main(["--help"]);
  } finally {
    console.log = original;
  }
  assert.ok(lines.some((line) => line.includes("Usage: dry4ts")), `Expected USAGE in stdout, got: ${JSON.stringify(lines)}`);
  assert.ok(lines.some((line) => line.includes(USAGE.split("\n")[0])));
});

test("main with invalid --threshold value sets exitCode 2 and writes to stderr", () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    process.exitCode = 0;
    main(["--threshold", "bad"]);
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
    main(["--format", "xml", dir]);
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
    ["bun", "run", "src/bin/dry4ts.ts", "--fail-on-duplicates", "--threshold", "0.2", "--min-lines", "3", "--min-nodes", "8", dir],
    { cwd: repoRoot },
  );
  assert.equal(result.exitCode, 1);
});

test("main --fail-on-duplicates with no duplicates leaves exitCode 0", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dry4ts-nodups-"));
  await writeFile(path.join(dir, "solo.ts"), duplicateBody);
  const result = Bun.spawnSync(
    ["bun", "run", "src/bin/dry4ts.ts", "--fail-on-duplicates", "--threshold", "0.99", "--min-lines", "100", "--min-nodes", "9999", dir],
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
  const clusters = clusterCandidates([pair("a.ts", "b.ts", 0.9), pair("c.ts", "d.ts", 0.8)]);
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
  const clusters = clusterCandidates([pair("x.ts", "y.ts", 0.9), pair("p.ts", "q.ts", 0.8)]);
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
