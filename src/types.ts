export interface Location {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ClusterLocation extends Location {
  readonly nodes: number;
  // The candidate root SyntaxKind name and the declaration identifier (null when
  // anonymous), so a consumer can classify a finding without opening the file.
  // Optional only so synthetic locations (tests, the cross-check finder) need not
  // set them; a scan always populates both.
  readonly kind?: string;
  readonly name?: string | null;
}

export interface ScoreRange {
  readonly min: number;
  readonly max: number;
}

// "new" iff ≥1 location intersects the active changed scope (the finding —
// even when the counterpart location is old code); "known" otherwise;
// "unscoped" for every cluster when no changed scope is active (without a
// scope, claiming "known" would be a machine-readable lie).
export type ClusterStatus = "new" | "known" | "unscoped";

export interface Cluster {
  readonly score: ScoreRange;
  readonly locations: readonly ClusterLocation[];
  readonly status?: ClusterStatus;
}

export interface ClusterReport {
  readonly score: ScoreRange;
  readonly locationCount: number;
  readonly locations: readonly ClusterLocation[];
  readonly status: ClusterStatus;
}

export type OutputFormat = "text" | "edn" | "json";
