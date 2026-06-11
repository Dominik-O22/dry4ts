export interface Location {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface ClusterLocation extends Location {
  readonly nodes: number;
}

export interface Candidate {
  readonly score: number;
  readonly left: Location;
  readonly right: Location;
  readonly leftNodes: number;
  readonly rightNodes: number;
}

export interface ScoreRange {
  readonly min: number;
  readonly max: number;
}

export interface Cluster {
  readonly score: ScoreRange;
  readonly locations: readonly ClusterLocation[];
}

export interface ClusterReport {
  readonly score: ScoreRange;
  readonly locationCount: number;
  readonly locations: readonly ClusterLocation[];
}

export type OutputFormat = "text" | "edn" | "json" | string;
