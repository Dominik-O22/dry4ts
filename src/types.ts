export interface Location {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface Candidate {
  readonly score: number;
  readonly left: Location;
  readonly right: Location;
  readonly leftNodes: number;
  readonly rightNodes: number;
}

export type OutputFormat = "text" | "edn" | "json" | string;
