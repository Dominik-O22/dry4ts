import fs from "node:fs";
import path from "node:path";

import ignore from "ignore";

import { ClusterCollector } from "./Clusters.js";
import { FileScanner, type Entry } from "./FileScanner.js";
import { Options, type OptionsInput } from "./Options.js";
import type { Cluster, Location } from "./types.js";

type MatchingPair = readonly [Entry, Entry, number];

type IgnoreMatcher = (filePath: string, isDirectory: boolean) => boolean;

export class TypeScriptDuplicateFinder {
  findClusters(options: Options | OptionsInput = Options.defaults()): Cluster[] {
    const resolvedOptions = options instanceof Options ? options : Options.from(options);
    const entries = new FileScanner().scanFiles(
      this.sourceFiles(resolvedOptions),
      resolvedOptions.minLines,
      resolvedOptions.minNodes,
    );
    return this.clustersFor(entries, resolvedOptions);
  }

  private clustersFor(entries: readonly Entry[], options: Options): Cluster[] {
    // FileScanner already enforces minNodes; entries arrive pre-filtered.
    const collector = new ClusterCollector();
    for (const [left, right, score] of this.matchingPairs(entries, options.threshold)) {
      collector.addMatch({ ...location(left), nodes: left.nodes }, { ...location(right), nodes: right.nodes }, score);
    }
    return collector.clusters().filter((cluster) => cluster.locations.length >= options.minLocations);
  }

  private matchingPairs(entries: readonly Entry[], threshold: number): MatchingPair[] {
    const pairs: MatchingPair[] = [];
    const fingerprintKeys = new Map<Entry, string>();
    const identicalGroups = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = fingerprintSetKey(entry);
      fingerprintKeys.set(entry, key);
      const group = identicalGroups.get(key) ?? [];
      group.push(entry);
      identicalGroups.set(key, group);
    }

    for (const group of identicalGroups.values()) {
      if (group.length > 1 && group[0].fingerprints.length > 0) {
        addIdenticalFingerprintPairs(group, pairs);
      }
    }

    const entriesBySize = [...entries].sort(compareEntriesByFingerprintSize);
    const prefixes = prefixTokens(entriesBySize, threshold);
    const postings = new Map<number, number[]>();
    const candidateMarks = new Int32Array(entriesBySize.length).fill(-1);
    const candidates: number[] = [];
    for (let i = 0; i < entriesBySize.length; i += 1) {
      const right = entriesBySize[i];
      candidates.length = 0;
      for (const token of prefixes[i]) {
        let list = postings.get(token);
        if (!list) {
          list = [];
          postings.set(token, list);
        }
        for (const j of list) {
          if (candidateMarks[j] !== i) {
            candidateMarks[j] = i;
            candidates.push(j);
          }
        }
        list.push(i);
      }
      // Candidate discovery order depends on token order; sort so pairs are
      // emitted in the same deterministic order as the previous full scan.
      candidates.sort((a, b) => a - b);
      for (const j of candidates) {
        const left = entriesBySize[j];
        // Slack keeps float division from flooring away a pair whose Jaccard
        // equals the threshold exactly (e.g. 405 / 0.81 → 499.9999…).
        if (right.fingerprints.length > Math.floor(left.fingerprints.length / threshold + CEIL_FLOAT_SLACK)) {
          continue;
        }
        if (fingerprintKeys.get(left) === fingerprintKeys.get(right)) {
          continue;
        }
        if (overlaps(left, right)) {
          continue;
        }
        const score = similarity(left, right);
        if (score >= threshold) {
          pairs.push([left, right, score]);
        }
      }
    }
    return pairs;
  }

  private sourceFiles(options: Options): string[] {
    const isIgnored = options.respectGitignore ? this.gitignoreMatcher() : null;
    return this.dedupeFiles(
      options.paths.flatMap((sourcePath) => this.typeScriptFiles(sourcePath, isIgnored)),
    ).sort();
  }

  private gitignoreMatcher(): IgnoreMatcher | null {
    const cwd = process.cwd();
    const gitignorePath = path.join(cwd, ".gitignore");
    let content: string;
    try {
      content = fs.readFileSync(gitignorePath, "utf8");
    } catch {
      return null;
    }
    const matcher = ignore().add(content);
    return (filePath, isDirectory) => {
      const relative = path.relative(cwd, filePath);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        return false;
      }
      const slashed = relative.split(path.sep).join("/");
      return matcher.ignores(isDirectory ? `${slashed}/` : slashed);
    };
  }

  private dedupeFiles(files: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const file of files) {
      const resolved = path.resolve(file);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        result.push(file);
      }
    }
    return result;
  }

  private typeScriptFiles(sourcePath: string, isIgnored: IgnoreMatcher | null): string[] {
    if (!fs.existsSync(sourcePath)) {
      return [];
    }
    const stats = fs.statSync(sourcePath);
    if (stats.isFile()) {
      return isTypeScriptSource(sourcePath) ? [sourcePath] : [];
    }
    if (!stats.isDirectory()) {
      return [];
    }

    const files: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (isIgnored?.(fullPath, true)) {
            continue;
          }
          visit(fullPath);
        } else if (entry.isFile() && isTypeScriptSource(fullPath)) {
          if (isIgnored?.(fullPath, false)) {
            continue;
          }
          files.push(fullPath);
        }
      }
    };
    visit(sourcePath);
    return files.sort();
  }
}

const isTypeScriptSourceExtensions = [".js", ".jsx", ".ts", ".tsx", ".mts", ".cts"];
const declarationExtensions = [".d.ts", ".d.mts", ".d.cts"];

function isTypeScriptSource(file: string): boolean {
  return (
    isTypeScriptSourceExtensions.some((extension) => file.endsWith(extension)) &&
    !declarationExtensions.some((extension) => file.endsWith(extension))
  );
}

function location(entry: Entry): Location {
  return { file: entry.file, startLine: entry.startLine, endLine: entry.endLine };
}

function overlaps(left: Entry, right: Entry): boolean {
  return left.file === right.file && left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function addIdenticalFingerprintPairs(group: readonly Entry[], pairs: MatchingPair[]): void {
  const components: Entry[][] = [];
  for (const entry of group) {
    const connectors: Array<{ componentIndex: number; entry: Entry }> = [];
    for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
      const connector = components[componentIndex].find((candidate) => !overlaps(candidate, entry));
      if (connector) {
        connectors.push({ componentIndex, entry: connector });
      }
    }

    if (connectors.length === 0) {
      components.push([entry]);
      continue;
    }

    const primary = connectors[0];
    pairs.push([primary.entry, entry, 1]);
    components[primary.componentIndex].push(entry);

    for (let i = connectors.length - 1; i >= 1; i -= 1) {
      const connector = connectors[i];
      pairs.push([connector.entry, entry, 1]);
      components[primary.componentIndex].push(...components[connector.componentIndex]);
      components.splice(connector.componentIndex, 1);
    }
  }
}

function fingerprintSetKey(entry: Entry): string {
  return entry.fingerprints.join("\0");
}

function compareEntriesByFingerprintSize(left: Entry, right: Entry): number {
  return left.fingerprints.length - right.fingerprints.length;
}

// For each entry, the first (size - ceil(threshold * size) + 1) fingerprints under a
// rarest-first global token order. Two entries can only reach the Jaccard threshold
// if their prefixes share a token, so the pair loop only compares entries that
// collide in the prefix inverted index. Tokens are reported as dense ranks in that
// global order, which keeps the per-entry ordering a plain numeric sort. Everything
// runs on typed arrays: counting sort for the rarity order, binary search for the
// fingerprint-to-rank lookup.
// Guards against float rounding inflating Math.ceil, which would shorten a
// prefix and could drop a real match.
const CEIL_FLOAT_SLACK = 1e-9;

function prefixTokens(entriesBySize: readonly Entry[], threshold: number): Uint32Array[] {
  let total = 0;
  for (const entry of entriesBySize) {
    total += entry.fingerprints.length;
  }
  const all = new Float64Array(total);
  let cursor = 0;
  for (const entry of entriesBySize) {
    all.set(entry.fingerprints, cursor);
    cursor += entry.fingerprints.length;
  }
  all.sort();

  let uniqueCount = 0;
  for (let i = 0; i < total; i += 1) {
    if (i === 0 || all[i] !== all[i - 1]) {
      uniqueCount += 1;
    }
  }
  const unique = new Float64Array(uniqueCount);
  const counts = new Uint32Array(uniqueCount);
  for (let i = 0, u = -1; i < total; i += 1) {
    if (i === 0 || all[i] !== all[i - 1]) {
      u += 1;
      unique[u] = all[i];
    }
    counts[u] += 1;
  }

  // Counting sort by frequency; iterating ids in ascending order keeps the
  // (frequency, id) tie-break stable.
  let maxCount = 0;
  for (let u = 0; u < uniqueCount; u += 1) {
    if (counts[u] > maxCount) {
      maxCount = counts[u];
    }
  }
  const bucketStarts = new Uint32Array(maxCount + 2);
  for (let u = 0; u < uniqueCount; u += 1) {
    bucketStarts[counts[u] + 1] += 1;
  }
  for (let c = 1; c < bucketStarts.length; c += 1) {
    bucketStarts[c] += bucketStarts[c - 1];
  }
  const rank = new Uint32Array(uniqueCount);
  for (let u = 0; u < uniqueCount; u += 1) {
    rank[u] = bucketStarts[counts[u]]++;
  }

  return entriesBySize.map((entry) => {
    const size = entry.fingerprints.length;
    if (size === 0) {
      return new Uint32Array(0);
    }
    const prefixLength = Math.max(size - Math.ceil(threshold * size - CEIL_FLOAT_SLACK) + 1, 0);
    const entryRanks = new Uint32Array(size);
    for (let i = 0; i < size; i += 1) {
      entryRanks[i] = rank[indexOf(unique, entry.fingerprints[i])];
    }
    entryRanks.sort();
    // slice, not subarray: a view would pin the full-size buffer for the whole
    // pair phase.
    return entryRanks.slice(0, prefixLength);
  });
}

function indexOf(sorted: Float64Array, value: number): number {
  let low = 0;
  let high = sorted.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] < value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function similarity(left: Entry, right: Entry): number {
  const a = left.fingerprints;
  const b = right.fingerprints;
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x === y) {
      shared += 1;
      i += 1;
      j += 1;
    } else if (x < y) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return shared / (a.length + b.length - shared);
}
