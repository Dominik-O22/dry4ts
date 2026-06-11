import { maxScore, minScore } from "./Clusters.js";
import { Options } from "./Options.js";
import { TypeScriptDuplicateFinder } from "./TypeScriptDuplicateFinder.js";
import type { Candidate, Cluster, ClusterLocation, ClusterReport, Location } from "./types.js";

export const USAGE = [
  "Usage: dry4ts [options] [file-or-directory ...]",
  "",
  "Options:",
  "  --threshold N   Minimum structural similarity score, default 0.82",
  "  --min-lines N   Minimum source lines in a candidate declaration, default 4",
  "  --min-nodes N   Minimum normalized syntax nodes, default 20",
  "  --format F      text, json, or edn, default text",
  "  --edn           Same as --format edn",
  "  --json          Same as --format json",
  "  --text          Same as --format text",
  "  --fail-on-duplicates",
  "                  Exit with status 1 when duplicate candidates are found",
  "  --no-gitignore  Include files and directories ignored by .gitignore",
].join("\n");

export function main(args: readonly string[] = process.argv.slice(2)): void {
  let options: Options;
  try {
    options = Options.parse(...args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const clusters = new TypeScriptDuplicateFinder().findClusters(options);
  switch (options.format) {
    case "edn":
      console.log(toEdn(clusters));
      break;
    case "json":
      console.log(toJson(clusters));
      break;
    case "text":
      printText(clusters);
      break;
    default:
      console.error(`Unknown format: ${options.format}`);
      process.exitCode = 2;
  }

  if (options.failOnDuplicates && clusters.length > 0 && process.exitCode === undefined) {
    process.exitCode = 1;
  }
}

export function printText(clusters: readonly Cluster[]): void {
  if (clusters.length === 0) {
    console.log("No duplicate clusters found.");
    return;
  }
  clusters.forEach((cluster, index) => {
    if (index > 0) {
      // Bun's console.log() prints nothing when called with no arguments.
      console.log("");
    }
    console.log(formatCluster(cluster, index + 1));
  });
}

export function formatCluster(cluster: Cluster, ordinal: number): string {
  const header = `CLUSTER ${ordinal} score=${scoreRange(cluster)} locations=${cluster.locations.length}`;
  const lines = cluster.locations.map((location) => `  ${clusterLineRange(location)}`);
  return [header, ...lines].join("\n");
}

export function formatCandidate(candidate: Candidate): string {
  return `DUPLICATE score=${candidate.score.toFixed(2)}\n  ${lineRange(candidate.left)}\n  ${lineRange(candidate.right)}`;
}

export function toEdn(clusters: readonly Cluster[]): string {
  if (clusters.length === 0) {
    return "{:clusters []}";
  }
  const entries = clusters
    .map(
      (cluster) =>
        `{:score-min ${minScore(cluster)}\n   :score-max ${maxScore(cluster)}\n   :location-count ${cluster.locations.length}\n   :locations [${cluster.locations.map(locationEdn).join("\n               ")}]}`,
    )
    .join("\n  ");
  return `{:clusters\n [${entries}]}`;
}

export function toJson(clusters: readonly Cluster[]): string {
  const reports: ClusterReport[] = clusters.map((cluster) => ({
    score: {
      min: minScore(cluster),
      max: maxScore(cluster),
    },
    locationCount: cluster.locations.length,
    locations: cluster.locations,
  }));
  return `${JSON.stringify({ clusters: reports }, null, 2)}\n`;
}

function locationEdn(location: ClusterLocation): string {
  return `{:file "${escapeEdn(location.file)}", :start-line ${location.startLine}, :end-line ${location.endLine}, :nodes ${location.nodes}}`;
}

function escapeEdn(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function scoreRange(cluster: Cluster): string {
  const min = minScore(cluster).toFixed(2);
  const max = maxScore(cluster).toFixed(2);
  return min === max ? max : `${min}-${max}`;
}

function lineRange(location: Location): string {
  return `${location.file}:${location.startLine}-${location.endLine}`;
}

function clusterLineRange(location: ClusterLocation): string {
  return `${lineRange(location)} nodes=${location.nodes}`;
}
