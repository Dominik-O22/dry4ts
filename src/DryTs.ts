import fs from "node:fs";

import { ChangedRegions, canonicalPath, parseUnifiedDiff } from "./ChangedRegions.js";
import { crossFileSharedNames, maxScore, minScore } from "./Clusters.js";
import { candidateKindNames } from "./FileScanner.js";
import { GitProvider } from "./GitProvider.js";
import { Options } from "./Options.js";
import { isTestFile, TypeScriptDuplicateFinder } from "./TypeScriptDuplicateFinder.js";
import type { Cluster, ClusterLocation, ClusterReport, ClusterStatus, Location, Nearest } from "./types.js";

// Wrap a comma-joined list to fit under the usage column.
function wrapKinds(names: readonly string[], indent: string, width: number): string[] {
  const lines: string[] = [];
  let current = `${indent}Valid kinds: `;
  for (const [index, name] of names.entries()) {
    const token = index < names.length - 1 ? `${name},` : name;
    const candidate =
      current.trimEnd() === indent.trimEnd() || current.endsWith(": ") ? current + token : `${current} ${token}`;
    if (candidate.length > width && current.trim() !== "") {
      lines.push(current.trimEnd());
      current = `${indent}${token}`;
    } else {
      current = candidate;
    }
  }
  if (current.trim() !== "") lines.push(current.trimEnd());
  return lines;
}

export const USAGE = [
  "Usage: dry-ts [options] [file-or-directory ...]",
  "",
  "Options:",
  "  --threshold N   Minimum structural similarity score, default 0.82",
  "  --min-lines N   Minimum source lines in a candidate declaration, default 4",
  "  --min-nodes N   Minimum normalized syntax nodes, default 20",
  "  --min-distinct-kinds N",
  "                  Minimum distinct node kinds in a candidate's subtree,",
  "                  default 0 (off). Complements --min-nodes: drops large but",
  "                  near-uniform candidates (e.g. property-only interfaces).",
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
  "  --only-new      Restrict reported clusters to status new; requires",
  "                  --changed-from/--changed. Output filter only; exit code",
  "                  is unchanged. Totals go to stderr.",
  "  --fail-on-duplicates",
  "                  Exit 1 on findings: with --changed-from/--changed only",
  "                  clusters with status new; otherwise any cluster",
  "  --no-gitignore  Include files and directories ignored by .gitignore",
  "  --exclude GLOB  Skip files/directories matching a .gitignore-style glob,",
  "                  e.g. --exclude '**/*.spec.*'. Repeatable. Applies during",
  "                  directory scans regardless of --no-gitignore; explicit file",
  "                  arguments are always scanned.",
  "  --exclude-tests Skip test files: *.test.*, *.spec.*, *.e2e-spec.*,",
  "                  __tests__/, __mocks__/. A curated preset over --exclude;",
  "                  composes with it. Opt-in, default off. (Excludes tests for a",
  "                  focused src scan — not because test duplication never matters;",
  "                  test-infra dup is still worth a dedicated run.)",
  "  --counterparts  Add each location's nearest matching counterpart (file,",
  "                  line range, index, shared/total, score) and — under an",
  "                  active change scope — a per-location changed flag. Opt-in,",
  "                  default off; off-path output is byte-identical. --only-new",
  "                  filters clusters, not locations or counterparts.",
  "  --exclude-tagged-templates",
  "                  Drop candidate declarations whose value is a tagged template",
  "                  literal, e.g. `const X = styled(Button)`…`` / `css`…`` /",
  "                  `gql`…``. Suppresses CSS-in-JS (styled-components) clusters,",
  "                  a dominant false-positive class on frontend codebases. Opt-in,",
  "                  default off.",
  "  --exclude-kinds KIND[,KIND...]",
  "                  Drop candidate declarations of these SyntaxKinds; comma-",
  "                  separated, repeatable. Opt-in only (no default exclusions).",
  ...wrapKinds(candidateKindNames, "                  ", 76),
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

  // Per-location `changed` is added only under --counterparts AND an active
  // scope (GATE C/C1). Without it the default path and existing
  // --changed-without-counterparts output stay byte-identical: no `changed`
  // own-property is created. It is a run-layer concern — run owns the scope —
  // computed from the SAME intersection statusFor uses, but per location.
  const reported: Cluster[] = clusters.map((cluster) => ({
    ...cluster,
    status: scope ? statusFor(cluster, scope) : "unscoped",
    locations:
      scope && options.counterparts
        ? cluster.locations.map((location) => ({ ...location, changed: locationChanged(location, scope) }))
        : cluster.locations,
  }));

  // --only-new scopes the OUTPUT only; the exit code below still considers the
  // full set. onlyNew is unreachable without a scope (Options guards it), so
  // every reported status here is new/known, never unscoped.
  const visible = options.onlyNew ? reported.filter((cluster) => cluster.status === "new") : reported;
  if (options.onlyNew) {
    console.error(`showing ${visible.length} new (${reported.length - visible.length} known hidden)`);
  }

  switch (options.format) {
    case "edn":
      console.log(toEdn(visible));
      break;
    case "json":
      console.log(toJson(visible));
      break;
    case "text": {
      printText(visible);
      // Teaching footer to stderr (diagnostic, like --only-new's totals): keeps
      // stdout pure findings while surfacing the curation levers in-band. Text
      // format only — machine formats stay clean.
      const summary = noiseSummary(visible, options);
      if (summary) {
        console.error(summary);
      }
      break;
    }
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
      // Out-of-scope: its canonical can never equal a scanned cluster
      // location, so registering a region would be dead. Skip like the
      // other ungateable branches above.
      problems.push(`--changed file is outside the scanned paths: ${arg}`);
      continue;
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
  const intersects = cluster.locations.some((location) => locationChanged(location, scope));
  return intersects ? "new" : "known";
}

// Per-location changed-scope membership — the same intersection statusFor reduces
// over the whole cluster, applied to one location (plan 014 Step 4.5).
function locationChanged(location: ClusterLocation, scope: ChangedScope): boolean {
  return scope.regions.intersectsLocation(
    canonicalPath(scope.root, location.file),
    location.startLine,
    location.endLine,
  );
}

function statusOf(cluster: Cluster): ClusterStatus {
  return cluster.status ?? "unscoped";
}

// Below this many clusters the output is not a firehose and a curation lecture
// is noise — a small, clean run gets no footer.
const NOISE_FOOTER_MIN_CLUSTERS = 10;

// Builds the teaching footer: which curation levers would cut the current noise,
// and by how much. Returns null when there is nothing useful to say (too few
// clusters, or every applicable lever is already in effect).
//
// The --exclude-tests estimate is computed from the REPORTED clusters, not by
// re-scanning: a cluster drops out once excluding test files leaves it under
// --min-locations. This is an estimate (the `≈`): removing a location that
// bridged two halves could split a cluster rather than delete it, so the true
// remaining count can differ slightly — but never silently, and the dominant
// effect (all-test clusters vanishing) is exact.
export function noiseSummary(clusters: readonly Cluster[], options: Options): string | null {
  if (clusters.length < NOISE_FOOTER_MIN_CLUSTERS) {
    return null;
  }
  const bullets: string[] = [];

  if (!options.excludeTests) {
    const dropped = clusters.filter(
      (cluster) => cluster.locations.filter((location) => !isTestFile(location.file)).length < options.minLocations,
    ).length;
    if (dropped > 0) {
      bullets.push(
        `${dropped} disappear with --exclude-tests (clusters that fall below --min-locations once test files are dropped) → ≈${clusters.length - dropped} left`,
      );
    }
  }
  if (!options.excludeTaggedTemplates) {
    bullets.push(
      "--exclude-tagged-templates drops CSS-in-JS / styled-components clusters (a frontend false-positive class)",
    );
  }
  bullets.push(`--min-nodes N raises the size floor (currently ${options.minNodes}); --exclude '<glob>' drops paths`);

  return [
    `${clusters.length} clusters. Curation levers (see README "Curating results"):`,
    ...bullets.map((bullet) => `  - ${bullet}`),
  ].join("\n");
}

export function printText(clusters: readonly Cluster[]): void {
  if (clusters.length === 0) {
    console.log("No duplicate candidate clusters found.");
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
  const header = `CLUSTER ${ordinal} score=${scoreRange(cluster)} locations=${cluster.locations.length} status=${status}${marker}${sameNameSuffix(cluster)}`;
  const lines = cluster.locations.map((location) => `  ${clusterLineRange(location)}`);
  return [header, ...lines].join("\n");
}

// Surfaces the ranking signal in-band: when one declaration name recurs across
// files in this cluster (the reason it floats to the top — see rankClusters),
// name it so the reader sees WHY it ranked high without scanning every location.
// At most three names listed; the rest collapse to "(+N)". Omitted entirely when
// no name is shared cross-file, keeping the common case byte-identical.
function sameNameSuffix(cluster: Cluster): string {
  const shared = crossFileSharedNames(cluster);
  if (shared.length === 0) {
    return "";
  }
  const shown = shared.slice(0, 3).join(",");
  const rest = shared.length > 3 ? `(+${shared.length - 3})` : "";
  return ` same-name=${shown}${rest}`;
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

// Built by appending each optional field group independently — never nested
// inside the kind branch — so :changed and :nearest survive for synthetic/API
// locations that carry no :kind (plan Step 5, Codex DX).
function locationEdn(location: ClusterLocation): string {
  let fields = `{:file "${escapeEdn(location.file)}", :start-line ${location.startLine}, :end-line ${location.endLine}, :nodes ${location.nodes}`;
  if (location.kind !== undefined) {
    const name = location.name == null ? "nil" : `"${escapeEdn(location.name)}"`;
    fields += `, :kind "${escapeEdn(location.kind)}", :name ${name}`;
  }
  if (location.changed !== undefined) {
    fields += `, :changed ${location.changed}`;
  }
  if (location.nearest !== undefined) {
    fields += `, :nearest ${nearestEdn(location.nearest)}`;
  }
  return `${fields}}`;
}

function nearestEdn(nearest: Nearest): string {
  return `{:index ${nearest.index} :file "${escapeEdn(nearest.file)}" :start-line ${nearest.startLine} :end-line ${nearest.endLine} :shared ${nearest.shared} :total ${nearest.total} :score ${nearest.score}}`;
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
  return `${lineRange(location)} nodes=${location.nodes}${kindSuffix(location)}${changedSuffix(location)}${nearestSuffix(location)}`;
}

// One line per location stays one line: changed and the counterpart append to the
// location's own line, never a sub-line (plan Step 5, DX). Both omit cleanly when
// their value is undefined.
function changedSuffix(location: ClusterLocation): string {
  return location.changed === undefined ? "" : ` changed=${location.changed}`;
}

function nearestSuffix(location: ClusterLocation): string {
  const nearest = location.nearest;
  if (nearest === undefined) {
    return "";
  }
  return ` → nearest ${nearest.file}:${nearest.startLine}-${nearest.endLine} (${nearest.shared}/${nearest.total})`;
}

// Appends the diagnostic facts the scanner attaches (kind, and name when the
// declaration has one). Synthetic locations without a kind render as before.
function kindSuffix(location: ClusterLocation): string {
  if (location.kind === undefined) {
    return "";
  }
  const name = location.name == null ? "" : ` name=${location.name}`;
  return ` kind=${location.kind}${name}`;
}
