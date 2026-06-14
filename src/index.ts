export {
  type ChangedRange,
  ChangedRegions,
  canonicalPath,
  parseUnifiedDiff,
  type RegionSource,
} from "./ChangedRegions.js";
export { maxScore, minScore } from "./Clusters.js";
export { formatCluster, main, printText, toEdn, toJson, USAGE } from "./DryTs.js";
export { GitProvider } from "./GitProvider.js";
export { NormalizedNode } from "./NormalizedNode.js";
export { Options, type OptionsInput } from "./Options.js";
export { type ScanResult, TypeScriptDuplicateFinder } from "./TypeScriptDuplicateFinder.js";
export { TypeScriptNormalizer } from "./TypeScriptNormalizer.js";
export type {
  Cluster,
  ClusterLocation,
  ClusterReport,
  ClusterStatus,
  Location,
  Nearest,
  OutputFormat,
} from "./types.js";
