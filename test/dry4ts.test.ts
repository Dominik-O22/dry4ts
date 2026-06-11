import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clusterCandidates,
  formatCandidate,
  formatCluster,
  Options,
  toEdn,
  toJson,
  TypeScriptDuplicateFinder,
  type Candidate,
} from "../src/index.js";

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
