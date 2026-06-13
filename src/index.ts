export { canonicalPath, ChangedRegions, parseUnifiedDiff, type ChangedRange, type RegionSource } from "./ChangedRegions.js";
export { toGithub, toGitlab } from "./CiFormats.js";
export { locationKey, maxScore, minScore } from "./Clusters.js";
export { USAGE, formatCluster, main, printText, toEdn, toJson } from "./DryTs.js";
export {
  type ChangedScope,
  type ReportedCluster,
  type ReportedLocation,
  reportClusters,
  toLegacyClusters,
} from "./Report.js";
export { GitProvider } from "./GitProvider.js";
export { NormalizedNode } from "./NormalizedNode.js";
export { Options, type OptionsInput } from "./Options.js";
export { TypeScriptDuplicateFinder, type ScanResult } from "./TypeScriptDuplicateFinder.js";
export { TypeScriptNormalizer } from "./TypeScriptNormalizer.js";
export type { Cluster, ClusterReport, ClusterStatus, Location, OutputFormat } from "./types.js";
