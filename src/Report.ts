import { canonicalPath, ChangedRegions } from "./ChangedRegions.js";
import { locationKey } from "./Clusters.js";
import type { Cluster, ClusterLocation, ClusterStatus, ScoreRange } from "./types.js";

// Report layer: the PR-grade formatters (github / gitlab) need more than the
// legacy Cluster carries — per-location "does this copy intersect the change",
// the first changed line inside it (the annotation anchor), and a
// line-independent structural key for a stable GitLab fingerprint. None of
// that belongs on the exported Cluster/ClusterLocation (findClusters has no
// scope), so it lives here, built in DryTs.run after scope resolution. The
// formatters stay pure: (ReportedCluster[]) => string.

export interface ChangedScope {
  readonly root: string;
  readonly regions: ChangedRegions;
}

export interface ReportedLocation extends ClusterLocation {
  // Repo/cwd-relative canonical path — what CI annotations must reference.
  readonly path: string;
  readonly intersectsChangedScope: boolean;
  // First changed line inside the location, or null when it does not intersect.
  // Annotations anchor here, not at startLine, so they land inside the diff
  // hunk GitHub/GitLab will render.
  readonly annotationLine: number | null;
  // Line-independent structural identity (the location's fingerprint set);
  // hashed into the GitLab fingerprint so line drift does not re-flag.
  readonly structuralKey: string;
}

export interface ReportedCluster {
  readonly score: ScoreRange;
  readonly status: ClusterStatus;
  readonly locations: readonly ReportedLocation[];
}

export function reportClusters(
  clusters: readonly Cluster[],
  structuralKeys: ReadonlyMap<string, string>,
  scope: ChangedScope | null,
): ReportedCluster[] {
  const root = scope ? scope.root : process.cwd();
  return clusters.map((cluster) => {
    const locations = cluster.locations.map((location): ReportedLocation => {
      const path = canonicalPath(root, location.file);
      const intersectsChangedScope = scope
        ? scope.regions.intersectsLocation(path, location.startLine, location.endLine)
        : false;
      const annotationLine = scope
        ? scope.regions.firstChangedLine(path, location.startLine, location.endLine)
        : null;
      return {
        ...location,
        path,
        intersectsChangedScope,
        annotationLine,
        structuralKey: structuralKeys.get(locationKey(location)) ?? "",
      };
    });
    const status: ClusterStatus = scope
      ? locations.some((location) => location.intersectsChangedScope)
        ? "new"
        : "known"
      : "unscoped";
    return { score: cluster.score, status, locations };
  });
}

// Legacy Cluster view for the text/json/edn formatters: strip the report-only
// fields so JSON/EDN output shape is unchanged.
export function toLegacyClusters(model: readonly ReportedCluster[]): Cluster[] {
  return model.map((cluster) => ({
    score: cluster.score,
    status: cluster.status,
    locations: cluster.locations.map(
      (location): ClusterLocation => ({
        file: location.file,
        startLine: location.startLine,
        endLine: location.endLine,
        nodes: location.nodes,
      }),
    ),
  }));
}
