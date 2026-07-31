import fs from "node:fs";

import { ChangedRegions, canonicalPath, parseUnifiedDiff } from "./ChangedRegions.js";
import { crossFileSharedNames, maxScore, minScore } from "./Clusters.js";
import { CONFIG_FILENAME, type ConfigOptions, loadConfig } from "./Config.js";
import { candidateKindNames } from "./FileScanner.js";
import { GitProvider } from "./GitProvider.js";
import { Options, PROFILE_NAMES } from "./Options.js";
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
  `  --profile NAME  Start from a curated flag preset (${PROFILE_NAMES.join(", ")}), then`,
  "                  apply any explicit flags on top (explicit flag > profile >",
  "                  default; list flags union). pr: PR gate — exclude-tests,",
  "                  min-nodes 50, exclude-kinds ArrowFunction,VariableStatement,",
  "                  only-new, fail-on-duplicates (needs --changed-from). src:",
  "                  source-only (exclude-tests). audit: broad (min-nodes 12).",
  "                  tests: test-infra dup, not bodies (exclude ArrowFunction,",
  "                  min-nodes 40). agent: pr preset + counterparts + json +",
  "                  demote-boilerplate, for after-edit agent loops (needs",
  "                  --changed-from/--changed).",
  "  --threshold N   Minimum structural similarity score, default 0.82",
  "  --min-lines N   Minimum source lines in a candidate declaration, default 4",
  "  --min-nodes N   Minimum normalized syntax nodes, default 20",
  "  --min-distinct-kinds N",
  "                  Minimum distinct node kinds in a candidate's subtree,",
  "                  default 0 (off). Complements --min-nodes: drops large but",
  "                  near-uniform candidates (e.g. property-only interfaces).",
  "  --min-locations N",
  "                  Minimum locations in a reported cluster, default 2",
  "  --format F      text, json, edn, or sarif, default text",
  "  --edn           Same as --format edn",
  "  --json          Same as --format json",
  "  --text          Same as --format text",
  "  --sarif         Same as --format sarif. SARIF 2.1.0 for GitHub code",
  "                  scanning / SARIF consumers. status new -> warning, else note.",
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
  "  --demote-boilerplate",
  "                  Rank clusters whose candidates do no real work (no control",
  "                  flow, no call other than super(), no real operator — the",
  "                  classic DI constructor that only wires fields) BELOW all",
  "                  others, even cross-file-name ones. Demotes, never drops:",
  "                  the candidates stay, they just stop crowding the top. Opt-in,",
  "                  default off; off-path byte-identical. On in --profile agent.",
  "  --exclude-kinds KIND[,KIND...]",
  "                  Drop candidate declarations of these SyntaxKinds; comma-",
  "                  separated, repeatable. Opt-in only (no default exclusions).",
  ...wrapKinds(candidateKindNames, "                  ", 76),
  "",
  "Config file:",
  "  .dry-ts.json in the working directory sets a committed baseline for the",
  "  options above (threshold, minNodes, exclude, excludeKinds, excludeTests, …),",
  "  plus an `ignore` glob list. Precedence: CLI flag > --profile > .dry-ts.json >",
  "  default. Run-scoped flags (--changed-from/--changed/--only-new) are CLI-only.",
].join("\n");

export function main(args: readonly string[] = process.argv.slice(2)): void {
  let options: Options;
  let config: ConfigOptions = {};
  try {
    // .dry-ts.json (when present in cwd) layers under the CLI args; a malformed
    // config throws here and is reported as exit 2, like any other option error.
    // --help is read straight from argv so `dry-ts --help` still prints usage even
    // when the repo's config is broken — the one command that must never fail.
    const wantsHelp = args.includes("--help") || args.includes("-h");
    config = wantsHelp ? {} : loadConfig();
    options = Options.fromCli(args, config);
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
    run(options, config);
  } catch (error) {
    // Fail closed: any error in the scan/gate pipeline is exit 2, never an
    // uncaught throw (which would exit 1 and read as "findings" to CI).
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

function run(options: Options, config: ConfigOptions = {}): void {
  const { files, clusters } = new TypeScriptDuplicateFinder().scan(options);
  if (options.failOnDuplicates && files.length === 0) {
    throw new Error("No files were scanned; refusing to exit 0 under --fail-on-duplicates");
  }

  // A committed .dry-ts.json silently shaping WHAT the gate sees (scan scope,
  // file skips, floors) is the sharpest config footgun: a valid config can flip a
  // red gate green at exit 0 (the empty-scan guard above misses it — a redirected
  // scan is non-empty-but-wrong). Surface the config-derived gate inputs to stderr
  // (like --only-new's totals) so a config-narrowed gate is never silent.
  if (options.failOnDuplicates) {
    const note = configGateNote(config);
    if (note) {
      console.error(note);
    }
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
    case "sarif":
      console.log(toSarif(visible));
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

// The committed-config keys whose value changes WHAT a --fail-on-duplicates run
// gates against: scan scope (paths), file skips (exclude/ignore/respectGitignore/
// excludeTests/excludeTaggedTemplates/excludeKinds), and the floors/threshold that
// decide which clusters survive. failOnDuplicates/format/counterparts do not
// narrow scope, so they are excluded from the note.
const GATE_SHAPING_KEYS: readonly (keyof ConfigOptions)[] = [
  "paths",
  "exclude",
  "ignore",
  "respectGitignore",
  "excludeTests",
  "excludeTaggedTemplates",
  "excludeKinds",
  "threshold",
  "minLines",
  "minNodes",
  "minLocations",
  "minDistinctKinds",
];

function configGateNote(config: ConfigOptions): string | null {
  const parts: string[] = [];
  for (const key of GATE_SHAPING_KEYS) {
    const value = config[key];
    if (value !== undefined) {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return `${CONFIG_FILENAME} shapes this --fail-on-duplicates run: ${parts.join(", ")} (a committed config narrows what the gate sees)`;
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
  bullets.push(`or start from a preset: --profile ${PROFILE_NAMES.join("|")} (see README "Curating results")`);

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

const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const SARIF_RULE_ID = "dry-ts/structural-duplicate";
const TOOL_INFO_URI = "https://github.com/Dominik-O22/dry4ts";

interface SarifPhysicalLocation {
  readonly artifactLocation: { readonly uri: string };
  readonly region: { readonly startLine: number; readonly endLine: number };
}

interface SarifLocation {
  physicalLocation: SarifPhysicalLocation;
  logicalLocations?: { name: string }[];
  properties: Record<string, unknown>;
  relationships?: { target: number; kinds: string[] }[];
}

interface SarifRelatedLocation {
  readonly id: number;
  readonly physicalLocation: SarifPhysicalLocation;
  readonly message: { text: string };
}

// SARIF 2.1.0 for GitHub code scanning and other SARIF consumers (issue #47).
// One `result` per cluster — the finding unit, matching json/edn — with each
// ClusterLocation as a SARIF location. --counterparts nearest data becomes
// `relatedLocations`, joined back to its origin location by a `relevant`
// relationship. The rule keeps "candidate" framing: these are structural
// candidates, not confirmed duplicates. The scan/gate pipeline is untouched.
//
// version defaults to the package version (read once from package.json, which
// sits one level above this module in both the src and dist layouts); tests pass
// an explicit value for deterministic output.
export function toSarif(clusters: readonly Cluster[], version: string = packageVersion()): string {
  const sarif = {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "dry-ts",
            informationUri: TOOL_INFO_URI,
            version,
            rules: [
              {
                id: SARIF_RULE_ID,
                name: "StructuralDuplicate",
                shortDescription: { text: "Candidate structural duplicate" },
                fullDescription: {
                  text: "Two or more declarations share normalized AST structure above the configured similarity threshold. These are structural candidates for de-duplication, not confirmed duplicates — review before refactoring.",
                },
                helpUri: TOOL_INFO_URI,
                defaultConfiguration: { level: "note" },
              },
            ],
          },
        },
        results: clusters.map(sarifResult),
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

function sarifResult(cluster: Cluster) {
  const status = statusOf(cluster);
  const shared = crossFileSharedNames(cluster);
  const locations = cluster.locations.map(sarifLocation);
  const relatedLocations: SarifRelatedLocation[] = [];
  cluster.locations.forEach((location, index) => {
    if (location.nearest === undefined) {
      return;
    }
    // relationships[].target is the array index into relatedLocations (not the
    // related location's id) — see SARIF 2.1.0 §3.33.3.
    const target = relatedLocations.length;
    relatedLocations.push(sarifRelatedLocation(location.nearest, target));
    locations[index].relationships = [{ target, kinds: ["relevant"] }];
  });
  return {
    ruleId: SARIF_RULE_ID,
    ruleIndex: 0,
    level: sarifLevel(status),
    message: { text: sarifMessage(cluster, status, shared) },
    locations,
    // Omitted entirely off --counterparts, keeping the common case clean.
    ...(relatedLocations.length > 0 ? { relatedLocations } : {}),
    properties: {
      status,
      scoreMin: minScore(cluster),
      scoreMax: maxScore(cluster),
      locationCount: cluster.locations.length,
      ...(shared.length > 0 ? { sameName: shared } : {}),
    },
  };
}

function sarifLocation(location: ClusterLocation): SarifLocation {
  // The scanner's diagnostic facts ride in properties (mirroring json/edn);
  // SARIF's own region/uri stay canonical.
  const properties: Record<string, unknown> = { nodes: location.nodes };
  if (location.kind !== undefined) {
    properties.kind = location.kind;
    properties.name = location.name ?? null;
  }
  if (location.changed !== undefined) {
    properties.changed = location.changed;
  }
  const result: SarifLocation = {
    physicalLocation: {
      artifactLocation: { uri: location.file },
      region: { startLine: location.startLine, endLine: location.endLine },
    },
    properties,
  };
  // A named declaration also gets a logicalLocation so consumers can group by
  // symbol; anonymous candidates (null name) carry none.
  if (location.name != null) {
    result.logicalLocations = [{ name: location.name }];
  }
  return result;
}

function sarifRelatedLocation(nearest: Nearest, id: number): SarifRelatedLocation {
  return {
    id,
    physicalLocation: {
      artifactLocation: { uri: nearest.file },
      region: { startLine: nearest.startLine, endLine: nearest.endLine },
    },
    message: { text: `nearest counterpart (${nearest.shared}/${nearest.total}, score=${nearest.score})` },
  };
}

// A "new" cluster (intersects the active change) is the actionable finding → a
// warning the gate can surface; "known"/"unscoped" stay informational notes so a
// full-tree scan does not flood code scanning with errors. (Issue #47: new →
// warning/error, known/unscoped → note.)
function sarifLevel(status: ClusterStatus): "warning" | "note" {
  return status === "new" ? "warning" : "note";
}

function sarifMessage(cluster: Cluster, status: ClusterStatus, shared: readonly string[]): string {
  const sameName =
    shared.length > 0
      ? ` same-name: ${shared.slice(0, 3).join(", ")}${shared.length > 3 ? ` (+${shared.length - 3})` : ""}`
      : "";
  return `Structural duplicate candidate: ${cluster.locations.length} locations, score ${scoreRange(cluster)}, status ${status}.${sameName}`;
}

let cachedVersion: string | undefined;

function packageVersion(): string {
  if (cachedVersion === undefined) {
    try {
      const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
      cachedVersion = (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
    } catch {
      // Never let a missing/garbled package.json sink a scan: SARIF stays valid
      // with a placeholder version rather than throwing mid-pipeline.
      cachedVersion = "0.0.0";
    }
  }
  return cachedVersion;
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
