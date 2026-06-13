import fs from "node:fs";

import { canonicalPath, ChangedRegions, parseUnifiedDiff } from "./ChangedRegions.js";
import { maxScore, minScore } from "./Clusters.js";
import { GitProvider } from "./GitProvider.js";
import { Options } from "./Options.js";
import { TypeScriptDuplicateFinder } from "./TypeScriptDuplicateFinder.js";
import type { Cluster, ClusterLocation, ClusterReport, ClusterStatus, Location } from "./types.js";

export const USAGE = [
  "Usage: dry-ts [options] [file-or-directory ...]",
  "",
  "Options:",
  "  --threshold N   Minimum structural similarity score, default 0.82",
  "  --min-lines N   Minimum source lines in a candidate declaration, default 4",
  "  --min-nodes N   Minimum normalized syntax nodes, default 20",
  "  --min-locations N",
  "                  Minimum locations in a reported cluster, default 2",
  "  --format F      text, json, or edn, default text",
  "  --edn           Same as --format edn",
  "  --json          Same as --format json",
  "  --text          Same as --format text",
  "  --changed-from REF",
  "                  Mark clusters intersecting changes since merge-base(REF, HEAD)",
  "                  as status new; untracked scanned files count as fully changed",
  "  --changed FILE  Mark clusters intersecting FILE (every line) as status new;",
  "                  repeatable, cannot be combined with --changed-from",
  "  --explain-changed",
  "                  Dump the resolved changed-region map to stderr",
  "  --fail-on-duplicates",
  "                  Exit 1 on findings: with --changed-from/--changed only",
  "                  clusters with status new; otherwise any cluster",
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

  try {
    run(options);
  } catch (error) {
    // Fail closed: any error in the scan/gate pipeline is exit 2, never an
    // uncaught throw (which would exit 1 and read as "findings" to CI).
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

function run(options: Options): void {
  const { files, clusters } = new TypeScriptDuplicateFinder().scan(options);
  if (options.failOnDuplicates && files.length === 0) {
    throw new Error("No files were scanned; refusing to exit 0 under --fail-on-duplicates");
  }

  const scope = resolveChangedScope(options, files);
  if (options.explainChanged) {
    console.error("Changed regions (--explain-changed):");
    console.error(scope ? scope.regions.describe() : "  (no changed scope active)");
  }

  const reported: Cluster[] = clusters.map((cluster) => ({
    ...cluster,
    status: scope ? statusFor(cluster, scope) : "unscoped",
  }));

  switch (options.format) {
    case "edn":
      console.log(toEdn(reported));
      break;
    case "json":
      console.log(toJson(reported));
      break;
    case "text":
      printText(reported);
      break;
  }

  const failing = scope ? reported.some((cluster) => cluster.status === "new") : reported.length > 0;
  if (options.failOnDuplicates && failing) {
    process.exitCode = 1;
  }
}

interface ChangedScope {
  readonly root: string;
  readonly regions: ChangedRegions;
}

function resolveChangedScope(options: Options, files: readonly string[]): ChangedScope | null {
  if (options.changedFrom !== undefined) {
    return gitScope(options.changedFrom, options, files);
  }
  if (options.changed.length > 0) {
    return listedScope(options, files);
  }
  return null;
}

function gitScope(ref: string, options: Options, files: readonly string[]): ChangedScope {
  const root = new GitProvider().repoRoot();
  const git = new GitProvider(root);
  git.verifyRef(ref);
  const regions = parseUnifiedDiff(git.diffSince(git.mergeBase(ref)));

  // Untracked rule: a scanned file not in git's index counts as fully
  // changed. Decided per file the scanner actually read, so it is immune to
  // divergence between the scanner's ignore logic and git's full ignore
  // stack; without it a brand-new duplicate file would bypass the gate.
  const pathspecs = options.paths.map((p) => canonicalPath(root, p)).map((p) => (p === "" ? "." : p));
  const indexed = git.indexedFiles(pathspecs);
  for (const file of files) {
    const canonical = canonicalPath(root, file);
    if (!indexed.has(canonical)) {
      regions.addWholeFile(canonical, "untracked");
    }
  }
  return { root, regions };
}

function listedScope(options: Options, files: readonly string[]): ChangedScope {
  const root = process.cwd();
  const regions = new ChangedRegions();
  const scanned = new Set(files.map((file) => canonicalPath(root, file)));
  const problems: string[] = [];
  for (const arg of options.changed) {
    if (!fs.existsSync(arg)) {
      problems.push(`--changed path does not exist: ${arg}`);
      continue;
    }
    if (fs.statSync(arg).isDirectory()) {
      problems.push(`--changed expects a file, got a directory: ${arg}`);
      continue;
    }
    const canonical = canonicalPath(root, arg);
    if (!scanned.has(canonical)) {
      problems.push(`--changed file is outside the scanned paths: ${arg}`);
    }
    regions.addWholeFile(canonical, "listed");
  }
  if (problems.length > 0) {
    // Under active gating an ungateable changed file is a configuration
    // error — a green build with an ignored warning is a silent bypass.
    if (options.failOnDuplicates) {
      throw new Error(problems.join("\n"));
    }
    for (const problem of problems) {
      console.error(`warning: ${problem} (the gate cannot see it)`);
    }
  }
  return { root, regions };
}

function statusFor(cluster: Cluster, scope: ChangedScope): ClusterStatus {
  const intersects = cluster.locations.some((location) =>
    scope.regions.intersectsLocation(canonicalPath(scope.root, location.file), location.startLine, location.endLine),
  );
  return intersects ? "new" : "known";
}

function statusOf(cluster: Cluster): ClusterStatus {
  return cluster.status ?? "unscoped";
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
  const status = statusOf(cluster);
  const marker = status === "new" ? " (intersects your change)" : "";
  const header = `CLUSTER ${ordinal} score=${scoreRange(cluster)} locations=${cluster.locations.length} status=${status}${marker}`;
  const lines = cluster.locations.map((location) => `  ${clusterLineRange(location)}`);
  return [header, ...lines].join("\n");
}

export function toEdn(clusters: readonly Cluster[]): string {
  if (clusters.length === 0) {
    return "{:clusters []}";
  }
  const entries = clusters
    .map(
      (cluster) =>
        `{:score-min ${minScore(cluster)}\n   :score-max ${maxScore(cluster)}\n   :status :${statusOf(cluster)}\n   :location-count ${cluster.locations.length}\n   :locations [${cluster.locations.map(locationEdn).join("\n               ")}]}`,
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
    status: statusOf(cluster),
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
