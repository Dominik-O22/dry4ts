export interface Location {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

// A location's nearest matching counterpart in the same cluster (the strongest
// AST-similar partner). Populated only under --counterparts; see Nearest below.
export interface Nearest extends Location {
  // The counterpart's position in the SAME cluster's `locations` array — an O(1)
  // deref for a consumer that already holds the array. file/startLine/endLine are
  // the self-contained reference; index is an addition, not a replacement.
  readonly index: number;
  // Exact-integer pairwise fingerprint counts: total = aFP.length + bFP.length -
  // shared, computed from the pairing Entries at edge time (never recomputed from
  // the rendered location.nodes, which is node count, not fingerprint length).
  readonly shared: number;
  readonly total: number;
  // shared/total — the canonical similarity value, kept so a consumer never
  // recomputes a float; matches the cluster-level score scale. Documented redundancy.
  readonly score: number;
}

export interface ClusterLocation extends Location {
  readonly nodes: number;
  // The candidate root SyntaxKind name and the declaration identifier (null when
  // anonymous), so a consumer can classify a finding without opening the file.
  // Optional only so synthetic locations (tests, the cross-check finder) need not
  // set them; a scan always populates both.
  readonly kind?: string;
  readonly name?: string | null;
  // The nearest matching counterpart (--counterparts only). Off the flag, this
  // own-property is absent — never set to undefined — so findClusters() consumers
  // observe a byte-identical object shape.
  readonly nearest?: Nearest;
  // Whether this specific location intersects the active changed scope
  // (--counterparts + an active scope only). Absent when the flag is off or no
  // scope is active, mirroring cluster status "unscoped".
  readonly changed?: boolean;
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

export type OutputFormat = "text" | "edn" | "json" | "sarif";
