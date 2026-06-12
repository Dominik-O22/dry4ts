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
    return clusters.sort(compareClusters);
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

function locationKey(location: Location): string {
  return `${location.file}:${location.startLine}-${location.endLine}`;
}

function compareLocations(left: Location, right: Location): number {
  return left.file.localeCompare(right.file) || left.startLine - right.startLine || left.endLine - right.endLine;
}

function compareClusters(left: Cluster, right: Cluster): number {
  return maxScore(right) - maxScore(left) || compareLocations(left.locations[0], right.locations[0]);
}
