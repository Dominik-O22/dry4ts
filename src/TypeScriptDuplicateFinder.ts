import fs from "node:fs";
import path from "node:path";

import ignore from "ignore";

import { ClusterCollector, compareLocations, locationKey } from "./Clusters.js";
import { type Entry, FileScanner, resolveExcludeKinds } from "./FileScanner.js";
import { Options, type OptionsInput } from "./Options.js";
import type { Cluster, ClusterLocation, Nearest } from "./types.js";

// [left, right, score, shared]: shared is the pairwise fingerprint-intersection
// count from the single similarity walk (full fingerprint length for an
// identical-fingerprint edge). Carried so --counterparts can report shared/total
// without a second pass; ignored entirely when the flag is off.
type MatchingPair = readonly [Entry, Entry, number, number];

type IgnoreMatcher = (filePath: string, isDirectory: boolean) => boolean;

// Preset expanded by --exclude-tests, merged into the --exclude glob list. High-
// precision test markers only: filename suffixes plus the conventional test
// directories. Bare `test/` / `tests/` / `e2e/` are intentionally omitted — too
// many projects use those for non-test code; callers add them via --exclude.
// gitignore syntax (no brace expansion): `*` covers every extension after the
// marker (e.g. `*.test.*` catches .test.ts/.test.tsx/.test.mts).
export const TEST_EXCLUDE_GLOBS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.e2e-spec.*",
  "**/__tests__/**",
  "**/__mocks__/**",
];

export interface ScanResult {
  readonly files: readonly string[];
  readonly clusters: readonly Cluster[];
}

export class TypeScriptDuplicateFinder {
  findClusters(options: Options | OptionsInput = Options.defaults()): Cluster[] {
    return [...this.scan(options).clusters];
  }

  // Like findClusters, but also reports which files were scanned — the gate
  // needs the file list for the untracked rule and the zero-files check.
  scan(options: Options | OptionsInput = Options.defaults()): ScanResult {
    const resolvedOptions = options instanceof Options ? options : Options.from(options);
    const files = this.sourceFiles(resolvedOptions);
    const excludeKinds = resolveExcludeKinds(resolvedOptions.excludeKinds);
    const entries = new FileScanner().scanFiles(
      files,
      resolvedOptions.minLines,
      resolvedOptions.minNodes,
      excludeKinds,
      resolvedOptions.minDistinctKinds,
      resolvedOptions.excludeTaggedTemplates,
    );
    return { files, clusters: this.clustersFor(entries, resolvedOptions) };
  }

  private clustersFor(entries: readonly Entry[], options: Options): Cluster[] {
    // FileScanner already enforces minNodes; entries arrive pre-filtered.
    const collector = new ClusterCollector();
    // Off the flag this stays null and no per-location bookkeeping happens, so
    // the off path does exactly what it did before. On, it accumulates each
    // location's running-max nearest partner keyed by canonical locationKey —
    // O(locations) memory, never the O(edges) full edge list (plan DD 1).
    const nearest = options.counterparts ? new Map<string, NearestAccumulator>() : null;
    // The nearest map (when present) is populated inside matchingPairs as edges
    // are found; the pair's shared count is consumed there, not here.
    for (const [left, right, score] of this.matchingPairs(entries, options.threshold, nearest)) {
      collector.addMatch(clusterLocation(left), clusterLocation(right), score);
    }
    const clusters = collector.clusters().filter((cluster) => cluster.locations.length >= options.minLocations);
    return nearest ? clusters.map((cluster) => joinNearest(cluster, nearest)) : clusters;
  }

  private matchingPairs(
    entries: readonly Entry[],
    threshold: number,
    nearest: Map<string, NearestAccumulator> | null,
  ): MatchingPair[] {
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
        const { score, shared } = similarity(left, right);
        if (score >= threshold) {
          pairs.push([left, right, score, shared]);
        }
      }
    }
    if (nearest) {
      aggregateNearest(pairs, identicalGroups, nearest);
    }
    return pairs;
  }

  private sourceFiles(options: Options): string[] {
    // Two ignore sources, both gitignore-syntax globs matched relative to cwd:
    // .gitignore (when respected) and the user's --exclude globs. A path is
    // skipped if either matches. --exclude applies regardless of
    // respectGitignore — it is an explicit instruction, not repo config.
    // --exclude-tests appends the curated test-path preset to that same list.
    const excludeGlobs = options.excludeTests ? [...options.exclude, ...TEST_EXCLUDE_GLOBS] : options.exclude;
    const matchers = [
      options.respectGitignore ? this.gitignoreMatcher() : null,
      excludeGlobs.length > 0 ? this.globMatcher(excludeGlobs) : null,
    ].filter((matcher): matcher is IgnoreMatcher => matcher !== null);
    const isIgnored: IgnoreMatcher | null =
      matchers.length === 0 ? null : (filePath, isDirectory) => matchers.some((m) => m(filePath, isDirectory));
    return this.dedupeFiles(options.paths.flatMap((sourcePath) => this.typeScriptFiles(sourcePath, isIgnored))).sort();
  }

  private gitignoreMatcher(): IgnoreMatcher | null {
    const gitignorePath = path.join(process.cwd(), ".gitignore");
    let content: string;
    try {
      content = fs.readFileSync(gitignorePath, "utf8");
    } catch {
      return null;
    }
    return this.globMatcher([content]);
  }

  // Builds a relative-to-cwd matcher from gitignore-syntax globs. Shared by
  // .gitignore (one entry: the file contents) and --exclude (one entry per
  // glob). Directories are matched with a trailing slash so patterns like
  // `node_modules/` prune the whole tree during traversal.
  private globMatcher(globs: readonly string[]): IgnoreMatcher {
    const cwd = process.cwd();
    const matcher = ignore().add(globs.join("\n"));
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

function clusterLocation(entry: Entry): ClusterLocation {
  return {
    file: entry.file,
    startLine: entry.startLine,
    endLine: entry.endLine,
    nodes: entry.nodes,
    kind: entry.kind,
    name: entry.name,
  };
}

function overlaps(left: Entry, right: Entry): boolean {
  return left.file === right.file && left.startLine <= right.endLine && right.startLine <= left.endLine;
}

// The running-max nearest counterpart for one location: the partner Entry (so its
// canonical location key resolves at join time) plus the exact-integer shared/total
// and the score, before the cluster `index` is known (resolved in joinNearest).
interface NearestAccumulator {
  readonly counterpart: Entry;
  readonly shared: number;
  readonly total: number;
  readonly score: number;
}

// Strict-greater replacement under the total tie-break (plan DD 2): max score,
// then max shared, then min total, then compareLocations(counterpart). `>`/`<`
// only — never `>=` — so iteration order never leaks into the result.
function isBetterNearest(candidate: NearestAccumulator, existing: NearestAccumulator): boolean {
  if (candidate.score !== existing.score) {
    return candidate.score > existing.score;
  }
  if (candidate.shared !== existing.shared) {
    return candidate.shared > existing.shared;
  }
  if (candidate.total !== existing.total) {
    return candidate.total < existing.total;
  }
  return compareLocations(candidate.counterpart, existing.counterpart) < 0;
}

function updateNearest(
  nearest: Map<string, NearestAccumulator>,
  location: Entry,
  counterpart: Entry,
  score: number,
  shared: number,
  total: number,
): void {
  const key = locationKey(location);
  const candidate: NearestAccumulator = { counterpart, shared, total, score };
  const existing = nearest.get(key);
  if (!existing || isBetterNearest(candidate, existing)) {
    nearest.set(key, candidate);
  }
}

// Aggregate each rendered location's nearest counterpart from the fully-built edge
// set, AFTER pairs are known. Computed here (not inline) because the correct nearest
// is the strongest edge between two RENDERED locations, and "rendered" is only known
// once we can take the max-nodes entry per locationKey across all edge endpoints —
// the same keep-rule ClusterCollector applies (Clusters.ts:59).
//
// Why this matters (Codex adversarial, plan 014 collision findings): multiple candidate
// roots can share one line-based locationKey — a one-line `const x = (...) => ...` emits
// both a VariableStatement and its inner ArrowFunction at the same file:start-end. The
// collector renders only the max-nodes entry; an inner sibling's edge must NOT be
// reported as the rendered node's similarity (it would mislabel a partial match as an
// exact one) on EITHER endpoint.
function aggregateNearest(
  pairs: readonly MatchingPair[],
  identicalGroups: ReadonlyMap<string, Entry[]>,
  nearest: Map<string, NearestAccumulator>,
): void {
  // The rendered (canonical) entry per key, mirroring ClusterCollector EXACTLY
  // (Clusters.ts:59): among edge endpoints sharing a key, the strictly-max-nodes one,
  // ties broken first-seen in the SAME add order the collector uses (it walks the same
  // pairs array, each pair contributing left then right). Tracked by Entry IDENTITY,
  // not by node count: two distinct candidate roots can share a line-based key at equal
  // node count (e.g. two statements on one physical line under --min-lines 1), and only
  // the one the collector actually keeps may source the rendered location's nearest.
  // Every entry that reaches a cluster is an edge endpoint, so this set is complete.
  const canonicalByKey = new Map<string, Entry>();
  const note = (entry: Entry): void => {
    const key = locationKey(entry);
    const seen = canonicalByKey.get(key);
    if (seen === undefined || entry.nodes > seen.nodes) {
      canonicalByKey.set(key, entry);
    }
  };
  for (const [left, right] of pairs) {
    note(left);
    note(right);
  }
  const isCanonical = (entry: Entry): boolean => canonicalByKey.get(locationKey(entry)) === entry;

  // Tier 1 — edges between two rendered locations. These describe the rendered-to-
  // rendered similarity exactly, so they are always preferred.
  for (const group of identicalGroups.values()) {
    if (group.length > 1 && group[0].fingerprints.length > 0) {
      updateIdenticalGroupNearest(group, nearest, isCanonical);
    }
  }
  for (const [left, right, score, shared] of pairs) {
    // Identical-group edges (score exactly 1) are handled in full by the group pass
    // above; similarity edges are always < 1 (identical sets are filtered before the
    // similarity walk), so this cleanly skips the duplicates.
    if (score >= 1) {
      continue;
    }
    if (!isCanonical(left) || !isCanonical(right)) {
      continue;
    }
    const total = left.fingerprints.length + right.fingerprints.length - shared;
    updateNearest(nearest, left, right, score, shared, total);
    updateNearest(nearest, right, left, score, shared, total);
  }

  // Tier 2 — throw-safe fallback. A rendered owner whose ONLY edges go to non-rendered
  // sub-nodes (e.g. it matches the inner body of a larger declaration but not the whole
  // declaration) has no Tier-1 nearest. Give it the strongest owner-side edge; joinNearest
  // resolves the counterpart to its rendered representative by key. This is the one place
  // the reported score reflects an edge to a substructure of the pointed location — rare,
  // and documented. The orphan key set is frozen before the loop so the running-max picks
  // the strongest edge deterministically (not the first one seen).
  const orphanKeys = new Set<string>();
  for (const key of canonicalByKey.keys()) {
    if (!nearest.has(key)) {
      orphanKeys.add(key);
    }
  }
  if (orphanKeys.size > 0) {
    const isOrphan = (entry: Entry): boolean => isCanonical(entry) && orphanKeys.has(locationKey(entry));
    for (const [left, right, score, shared] of pairs) {
      const total = left.fingerprints.length + right.fingerprints.length - shared;
      if (isOrphan(left)) {
        updateNearest(nearest, left, right, score, shared, total);
      }
      if (isOrphan(right)) {
        updateNearest(nearest, right, left, score, shared, total);
      }
    }
  }
}

// A1: register each identical-group member's true nearest among ALL other group
// members (not just the spanning-tree partners). Every pair is score 1 with
// shared == total == fingerprint length, so the tie-break reduces to
// compareLocations. Overlapping members never edge together, so they are skipped
// as candidate counterparts (an overlapping pair is not a real co-located match).
// Only rendered (canonical) members participate — a non-canonical inner sibling is
// neither an owner (it is not rendered) nor a counterpart (its key renders the
// canonical entry). Cost note: O(group²) per identical group (the running-max map
// is O(locations) memory); real code keeps identical groups small, so the quadratic
// walk is only noticeable on a synthetic all-identical corpus, and it is opt-in.
function updateIdenticalGroupNearest(
  group: readonly Entry[],
  nearest: Map<string, NearestAccumulator>,
  isCanonical: (entry: Entry) => boolean,
): void {
  for (const location of group) {
    if (!isCanonical(location)) {
      continue;
    }
    const len = location.fingerprints.length;
    for (const counterpart of group) {
      if (counterpart === location || overlaps(location, counterpart) || !isCanonical(counterpart)) {
        continue;
      }
      updateNearest(nearest, location, counterpart, 1, len, len);
    }
  }
}

// Post-clusters() join: attach `nearest` to each canonical location by its key.
// A join miss is a bug (every rendered location was unioned via ≥1 edge), so this
// asserts presence rather than silently dropping (plan DD 4). `index` is resolved
// against THIS cluster's locations array, which makes the intra-cluster invariant
// self-enforcing.
function joinNearest(cluster: Cluster, nearest: Map<string, NearestAccumulator>): Cluster {
  const indexByKey = new Map<string, number>();
  cluster.locations.forEach((location, index) => {
    indexByKey.set(locationKey(location), index);
  });
  const locations = cluster.locations.map((location) => {
    const accumulator = nearest.get(locationKey(location));
    if (!accumulator) {
      throw new Error(`nearest counterpart missing for ${locationKey(location)} (join miss — see plan 014)`);
    }
    const counterpartKey = locationKey(accumulator.counterpart);
    const index = indexByKey.get(counterpartKey);
    if (index === undefined) {
      throw new Error(`nearest counterpart ${counterpartKey} is not a member of its own cluster`);
    }
    const nearestPayload: Nearest = {
      index,
      file: accumulator.counterpart.file,
      startLine: accumulator.counterpart.startLine,
      endLine: accumulator.counterpart.endLine,
      shared: accumulator.shared,
      total: accumulator.total,
      score: accumulator.score,
    };
    return { ...location, nearest: nearestPayload };
  });
  return { ...cluster, locations };
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

    // Identical fingerprints: shared == total == fingerprint length for the edge
    // (both endpoints share the whole set). The per-location nearest for these
    // groups is computed separately in updateIdenticalGroupNearest (A1).
    const sharedLen = entry.fingerprints.length;
    const primary = connectors[0];
    pairs.push([primary.entry, entry, 1, sharedLen]);
    components[primary.componentIndex].push(entry);

    for (let i = connectors.length - 1; i >= 1; i -= 1) {
      const connector = connectors[i];
      pairs.push([connector.entry, entry, 1, sharedLen]);
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

// The single similarity walk, now also surfacing the integer `shared` count so
// --counterparts can report shared/total without a second pass. `score` is the
// SAME float the threshold compared before (shared / (a+b-shared)) — the
// arithmetic is unchanged, so the off-path borderline-pair decision is bit-
// identical. See Step 1 / STOP conditions in plan 014.
function similarity(left: Entry, right: Entry): { score: number; shared: number } {
  const a = left.fingerprints;
  const b = right.fingerprints;
  if (a.length === 0 && b.length === 0) {
    return { score: 0, shared: 0 };
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
  return { score: shared / (a.length + b.length - shared), shared };
}
