import type { Cluster, ClusterLocation, Location, ScoreRange } from "./types.js";

export class ClusterCollector {
  private readonly parents = new Map<string, string>();
  private readonly locationsByKey = new Map<string, ClusterLocation>();
  private readonly scoresByRoot = new Map<string, ScoreRange>();

  addMatch(left: ClusterLocation, right: ClusterLocation, score: number): void {
    const leftRoot = this.add(left);
    const rightRoot = this.add(right);
    const root = this.union(leftRoot, rightRoot);
    this.addScore(root, score);
  }

  clusters(): Cluster[] {
    const membersByRoot = new Map<string, ClusterLocation[]>();
    for (const [key, location] of this.locationsByKey) {
      const root = this.find(key);
      const members = membersByRoot.get(root) ?? [];
      members.push(location);
      membersByRoot.set(root, members);
    }

    const clusters: Cluster[] = [];
    for (const [root, locations] of membersByRoot) {
      const score = this.scoresByRoot.get(root);
      if (!score) {
        continue;
      }
      clusters.push({
        score,
        locations: locations.sort(compareLocations),
      });
    }
    return rankClusters(clusters);
  }

  private find(key: string): string {
    let root = key;
    while (this.parents.get(root) !== root) {
      root = this.parents.get(root)!;
    }
    let current = key;
    while (current !== root) {
      const next = this.parents.get(current)!;
      this.parents.set(current, root);
      current = next;
    }
    return root;
  }

  private add(location: ClusterLocation): string {
    const key = locationKey(location);
    if (!this.parents.has(key)) {
      this.parents.set(key, key);
      this.locationsByKey.set(key, location);
    } else {
      const existing = this.locationsByKey.get(key);
      if (existing && location.nodes > existing.nodes) {
        this.locationsByKey.set(key, location);
      }
    }
    return this.find(key);
  }

  private union(leftRoot: string, rightRoot: string): string {
    if (leftRoot === rightRoot) {
      return leftRoot;
    }

    this.parents.set(leftRoot, rightRoot);
    const leftScore = this.scoresByRoot.get(leftRoot);
    const rightScore = this.scoresByRoot.get(rightRoot);
    if (leftScore || rightScore) {
      this.scoresByRoot.set(rightRoot, mergeScores(leftScore, rightScore));
      this.scoresByRoot.delete(leftRoot);
    }
    return rightRoot;
  }

  private addScore(root: string, score: number): void {
    const existing = this.scoresByRoot.get(root);
    this.scoresByRoot.set(root, {
      min: existing ? Math.min(existing.min, score) : score,
      max: existing ? Math.max(existing.max, score) : score,
    });
  }
}

export function maxScore(cluster: Cluster): number {
  return cluster.score.max;
}

export function minScore(cluster: Cluster): number {
  return cluster.score.min;
}

function mergeScores(left: ScoreRange | undefined, right: ScoreRange | undefined): ScoreRange {
  if (!left) {
    return right!;
  }
  if (!right) {
    return left;
  }
  return {
    min: Math.min(left.min, right.min),
    max: Math.max(left.max, right.max),
  };
}

// Exported so the nearest-counterpart join (plan 014) keys by the SAME canonical
// location key the collector dedupes on — a divergent key would silently miss the
// join. Single source of truth.
export function locationKey(location: Location): string {
  return `${location.file}:${location.startLine}-${location.endLine}`;
}

// Exported as the deterministic location tie-break for the nearest-counterpart
// total order (plan 014, DD 2) — reused rather than duplicated so the two never drift.
export function compareLocations(left: Location, right: Location): number {
  return left.file.localeCompare(right.file) || left.startLine - right.startLine || left.endLine - right.endLine;
}

// Report order. Primary key: clusters whose SAME declaration name recurs across
// two or more distinct files float to the top — the strongest "this is a real,
// copy-pasted duplicate" signal (a `validateUser` cloned into another module),
// near-zero false positive in practice. Within each tier, strongest score first,
// then the deterministic location tie-break. Decorated up front (Schwartzian) so
// the cross-file-name scan runs once per cluster, not once per comparison.
function rankClusters(clusters: readonly Cluster[]): Cluster[] {
  return clusters
    .map((cluster) => ({
      cluster,
      // Highest-priority (most significant) key: all-boilerplate clusters sink
      // below everything, even cross-file-name ones (the n8n DI-constructor case).
      // Off --demote-boilerplate no location carries the flag, so this is 0 for
      // every cluster and the order is byte-identical to before.
      boilerplate: isBoilerplate(cluster) ? 1 : 0,
      crossFile: hasCrossFileSharedName(cluster) ? 1 : 0,
    }))
    .sort(
      (left, right) =>
        left.boilerplate - right.boilerplate ||
        right.crossFile - left.crossFile ||
        maxScore(right.cluster) - maxScore(left.cluster) ||
        compareLocations(left.cluster.locations[0], right.cluster.locations[0]),
    )
    .map(({ cluster }) => cluster);
}

// A cluster is boilerplate iff every location's candidate does no real work
// (--demote-boilerplate only; the flag is uniform across a cluster's structural
// twins). Off the flag, `boilerplate` is undefined everywhere, so this is false.
function isBoilerplate(cluster: Cluster): boolean {
  return cluster.locations.length > 0 && cluster.locations.every((location) => location.boilerplate === true);
}

// The set of declaration names that appear in two or more distinct files within a
// cluster — the cross-file recurrence that marks a cluster as a likely real
// duplicate (vs an incidental structural twin). Names recurring within a single
// file (overloads, shadowed locals) do not qualify: cross-file is the signal.
// Anonymous locations (null name) are skipped. Returned sorted for deterministic
// rendering; callers needing only the boolean use hasCrossFileSharedName.
export function crossFileSharedNames(cluster: Cluster): string[] {
  const filesByName = new Map<string, Set<string>>();
  for (const location of cluster.locations) {
    if (location.name == null) {
      continue;
    }
    const files = filesByName.get(location.name) ?? new Set<string>();
    files.add(location.file);
    filesByName.set(location.name, files);
  }
  const shared: string[] = [];
  for (const [name, files] of filesByName) {
    if (files.size >= 2) {
      shared.push(name);
    }
  }
  return shared.sort();
}

export function hasCrossFileSharedName(cluster: Cluster): boolean {
  const filesByName = new Map<string, Set<string>>();
  for (const location of cluster.locations) {
    if (location.name == null) {
      continue;
    }
    const files = filesByName.get(location.name) ?? new Set<string>();
    files.add(location.file);
    if (files.size >= 2) {
      return true;
    }
    filesByName.set(location.name, files);
  }
  return false;
}
