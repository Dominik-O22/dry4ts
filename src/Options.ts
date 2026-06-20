import type { ConfigOptions } from "./Config.js";
import { resolveExcludeKinds } from "./FileScanner.js";
import { isOutputFormat, type OutputFormat } from "./types.js";

// Curated flag bundles for `--profile NAME`. A profile only ever *sets* options
// (turns features on, raises a floor, adds a kind exclusion) — there is no
// negation flag to turn one back off — so each profile stays at the high-signal
// defaults its name implies. Resolution precedence is explicit CLI flag >
// profile > built-in default; list flags (`excludeKinds`) union the profile's
// entries with the user's rather than replacing them.
interface ProfileFlags {
  readonly excludeTests?: boolean;
  readonly minNodes?: number;
  readonly excludeKinds?: readonly string[];
  readonly onlyNew?: boolean;
  readonly failOnDuplicates?: boolean;
  readonly format?: OutputFormat;
  readonly counterparts?: boolean;
}

// PR gate, highest signal. Deliberately requires an explicit --changed-from /
// --changed: `onlyNew` without an active scope is a hard error in the Options
// constructor, so `--profile pr` alone fails loud rather than silently gating
// against the wrong base. Named so `agent` can extend it without re-listing.
const PR_PROFILE: ProfileFlags = {
  excludeTests: true,
  minNodes: 50,
  excludeKinds: ["ArrowFunction", "VariableStatement"],
  onlyNew: true,
  failOnDuplicates: true,
};

const PROFILES: Record<string, ProfileFlags> = {
  pr: PR_PROFILE,
  // Source-only sane defaults: drop test scaffolding, keep the standard floors.
  src: { excludeTests: true },
  // Broad exploratory scan: lower the size floor to surface near-misses the
  // default would filter out; exclude nothing.
  audit: { minNodes: 12 },
  // Test-INFRASTRUCTURE duplication, explicitly not normal test bodies: drop
  // anonymous arrow bodies (the dominant test-scan noise) and raise the floor.
  // Point it at your test directories.
  tests: { excludeKinds: ["ArrowFunction"], minNodes: 40 },
  // After-edit agent loop: the PR gate plus per-location counterpart routing and
  // JSON output, so an agent reads each new finding's nearest existing match and
  // either reuses it or justifies the duplication. Inherits pr's onlyNew, so it
  // too fails loud without a --changed-from/--changed scope.
  agent: { ...PR_PROFILE, counterparts: true, format: "json" },
};

// The profile names a user can pass, for validation and help/docs.
export const PROFILE_NAMES: readonly string[] = Object.keys(PROFILES);

function resolveProfile(name: string): ProfileFlags {
  const profile = PROFILES[name];
  if (profile === undefined) {
    throw new Error(`Unknown profile: ${name} (valid: ${PROFILE_NAMES.join(", ")})`);
  }
  return profile;
}

export interface OptionsInput {
  readonly paths?: readonly string[];
  readonly threshold?: number;
  readonly minLines?: number;
  readonly minNodes?: number;
  readonly minLocations?: number;
  readonly format?: OutputFormat;
  readonly help?: boolean;
  readonly failOnDuplicates?: boolean;
  readonly respectGitignore?: boolean;
  readonly changedFrom?: string;
  readonly changed?: readonly string[];
  readonly explainChanged?: boolean;
  readonly onlyNew?: boolean;
  readonly excludeKinds?: readonly string[];
  readonly minDistinctKinds?: number;
  readonly exclude?: readonly string[];
  readonly excludeTaggedTemplates?: boolean;
  readonly excludeTests?: boolean;
  readonly counterparts?: boolean;
  readonly demoteBoilerplate?: boolean;
}

// A fully-resolved option set: every field present, defaults and any profile
// already applied. The Options constructor's single argument. Replaces 19
// positional parameters whose three adjacent booleans (excludeTaggedTemplates /
// excludeTests / counterparts) `tsc` could not tell apart on transposition — a
// named object makes a transposed field a compile error, and new flags stop
// appending positionals (TODOS "Internal Options object/builder").
export interface ResolvedOptions {
  readonly paths: readonly string[];
  readonly threshold: number;
  readonly minLines: number;
  readonly minNodes: number;
  readonly format: OutputFormat;
  readonly help: boolean;
  readonly failOnDuplicates: boolean;
  readonly respectGitignore: boolean;
  readonly minLocations: number;
  readonly changedFrom: string | undefined;
  readonly changed: readonly string[];
  readonly explainChanged: boolean;
  readonly onlyNew: boolean;
  readonly excludeKinds: readonly string[];
  readonly minDistinctKinds: number;
  readonly exclude: readonly string[];
  readonly excludeTaggedTemplates: boolean;
  readonly excludeTests: boolean;
  readonly counterparts: boolean;
  readonly demoteBoilerplate: boolean;
}

export class Options {
  readonly paths: readonly string[];
  readonly threshold: number;
  readonly minLines: number;
  readonly minNodes: number;
  readonly format: OutputFormat;
  readonly help: boolean;
  readonly failOnDuplicates: boolean;
  readonly respectGitignore: boolean;
  readonly minLocations: number;
  readonly changedFrom: string | undefined;
  readonly changed: readonly string[];
  readonly explainChanged: boolean;
  readonly onlyNew: boolean;
  readonly excludeKinds: readonly string[];
  readonly minDistinctKinds: number;
  readonly exclude: readonly string[];
  readonly excludeTaggedTemplates: boolean;
  readonly excludeTests: boolean;
  readonly counterparts: boolean;
  readonly demoteBoilerplate: boolean;

  constructor(resolved: ResolvedOptions) {
    if (!(resolved.threshold > 0 && resolved.threshold <= 1)) {
      throw new Error(`threshold must be greater than 0 and at most 1, got ${resolved.threshold}`);
    }
    if (resolved.minLines < 1) {
      throw new Error(`minLines must be at least 1, got ${resolved.minLines}`);
    }
    if (resolved.minNodes < 1) {
      throw new Error(`minNodes must be at least 1, got ${resolved.minNodes}`);
    }
    if (resolved.minDistinctKinds < 0) {
      throw new Error(`minDistinctKinds must be at least 0, got ${resolved.minDistinctKinds}`);
    }
    if (resolved.minLocations < 2) {
      throw new Error(`minLocations must be at least 2, got ${resolved.minLocations}`);
    }
    if (resolved.changedFrom !== undefined && resolved.changed.length > 0) {
      throw new Error("--changed-from and --changed cannot be combined");
    }
    if (resolved.onlyNew && resolved.changedFrom === undefined && resolved.changed.length === 0) {
      throw new Error("--only-new requires --changed-from or --changed");
    }
    // Validate names eagerly so an unknown/non-candidate kind fails at
    // construction time, not silently at scan time.
    resolveExcludeKinds(resolved.excludeKinds);

    this.paths = resolved.paths;
    this.threshold = resolved.threshold;
    this.minLines = resolved.minLines;
    this.minNodes = resolved.minNodes;
    this.format = resolved.format;
    this.help = resolved.help;
    this.failOnDuplicates = resolved.failOnDuplicates;
    this.respectGitignore = resolved.respectGitignore;
    this.minLocations = resolved.minLocations;
    this.changedFrom = resolved.changedFrom;
    this.changed = resolved.changed;
    this.explainChanged = resolved.explainChanged;
    this.onlyNew = resolved.onlyNew;
    this.excludeKinds = resolved.excludeKinds;
    this.minDistinctKinds = resolved.minDistinctKinds;
    this.exclude = resolved.exclude;
    this.excludeTaggedTemplates = resolved.excludeTaggedTemplates;
    this.excludeTests = resolved.excludeTests;
    this.counterparts = resolved.counterparts;
    this.demoteBoilerplate = resolved.demoteBoilerplate;
  }

  static defaults(): Options {
    return new Options({
      paths: ["src"],
      threshold: 0.82,
      minLines: 4,
      minNodes: 20,
      format: "text",
      help: false,
      failOnDuplicates: false,
      respectGitignore: true,
      minLocations: 2,
      changedFrom: undefined,
      changed: [],
      explainChanged: false,
      onlyNew: false,
      excludeKinds: [],
      minDistinctKinds: 0,
      exclude: [],
      excludeTaggedTemplates: false,
      excludeTests: false,
      counterparts: false,
      demoteBoilerplate: false,
    });
  }

  static from(input: OptionsInput = {}): Options {
    const defaults = Options.defaults();
    return new Options({
      paths: input.paths && input.paths.length > 0 ? [...input.paths] : defaults.paths,
      threshold: input.threshold ?? defaults.threshold,
      minLines: input.minLines ?? defaults.minLines,
      minNodes: input.minNodes ?? defaults.minNodes,
      format: input.format ?? defaults.format,
      help: input.help ?? defaults.help,
      failOnDuplicates: input.failOnDuplicates ?? defaults.failOnDuplicates,
      respectGitignore: input.respectGitignore ?? defaults.respectGitignore,
      minLocations: input.minLocations ?? defaults.minLocations,
      changedFrom: input.changedFrom,
      changed: input.changed ?? [],
      explainChanged: input.explainChanged ?? defaults.explainChanged,
      onlyNew: input.onlyNew ?? defaults.onlyNew,
      excludeKinds: input.excludeKinds ?? [],
      minDistinctKinds: input.minDistinctKinds ?? defaults.minDistinctKinds,
      exclude: input.exclude ?? [],
      excludeTaggedTemplates: input.excludeTaggedTemplates ?? defaults.excludeTaggedTemplates,
      excludeTests: input.excludeTests ?? defaults.excludeTests,
      counterparts: input.counterparts ?? defaults.counterparts,
      demoteBoilerplate: input.demoteBoilerplate ?? defaults.demoteBoilerplate,
    });
  }

  static parse(...args: string[]): Options {
    return Options.fromCli(args);
  }

  // Resolve CLI args layered over a (possibly empty) config file. Precedence per
  // option: explicit CLI flag > active --profile > .dry-ts.json > built-in
  // default. `parse` is the no-config entrypoint; main() calls this with the
  // loaded config so a committed baseline applies without a flag overriding it.
  static fromCli(args: readonly string[], config: ConfigOptions = {}): Options {
    const paths: string[] = [];
    const changed: string[] = [];
    const excludeKinds: string[] = [];
    const exclude: string[] = [];
    // Scalars start undefined so resolution can tell "user set this" from "left
    // at the default" — the distinction `--profile` precedence needs (explicit >
    // profile > default). Arrays accumulate; an empty array means "not set".
    let profileName: string | undefined;
    let threshold: number | undefined;
    let minLines: number | undefined;
    let minNodes: number | undefined;
    let minLocations: number | undefined;
    let format: OutputFormat | undefined;
    let help: boolean | undefined;
    let failOnDuplicates: boolean | undefined;
    let respectGitignore: boolean | undefined;
    let changedFrom: string | undefined;
    let explainChanged: boolean | undefined;
    let onlyNew: boolean | undefined;
    let minDistinctKinds: number | undefined;
    let excludeTaggedTemplates: boolean | undefined;
    let excludeTests: boolean | undefined;
    let counterparts: boolean | undefined;
    let demoteBoilerplate: boolean | undefined;

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      switch (arg) {
        case "--profile":
          profileName = valueFor(args, ++i, arg);
          break;
        case "--threshold":
          threshold = numberValue(args, ++i, arg);
          break;
        case "--min-lines":
          minLines = integerValue(args, ++i, arg);
          break;
        case "--min-nodes":
          minNodes = integerValue(args, ++i, arg);
          break;
        case "--min-distinct-kinds":
          minDistinctKinds = integerValue(args, ++i, arg);
          break;
        case "--exclude": {
          const glob = valueFor(args, ++i, arg).trim();
          if (glob.length > 0) {
            exclude.push(glob);
          }
          break;
        }
        case "--min-locations":
          minLocations = integerValue(args, ++i, arg);
          break;
        case "--format":
          format = formatValue(args, ++i, arg);
          break;
        case "--changed-from":
          changedFrom = valueFor(args, ++i, arg);
          break;
        case "--changed":
          changed.push(valueFor(args, ++i, arg));
          break;
        case "--explain-changed":
          explainChanged = true;
          break;
        case "--only-new":
          onlyNew = true;
          break;
        case "--exclude-tagged-templates":
          excludeTaggedTemplates = true;
          break;
        case "--exclude-tests":
          excludeTests = true;
          break;
        case "--counterparts":
          counterparts = true;
          break;
        case "--demote-boilerplate":
          demoteBoilerplate = true;
          break;
        case "--exclude-kinds":
          for (const name of valueFor(args, ++i, arg).split(",")) {
            const trimmed = name.trim();
            if (trimmed.length > 0) {
              excludeKinds.push(trimmed);
            }
          }
          break;
        case "--edn":
          format = "edn";
          break;
        case "--json":
          format = "json";
          break;
        case "--text":
          format = "text";
          break;
        case "--sarif":
          format = "sarif";
          break;
        case "--fail-on-duplicates":
          failOnDuplicates = true;
          break;
        case "--no-gitignore":
          respectGitignore = false;
          break;
        case "--help":
        case "-h":
          help = true;
          break;
        default:
          // A typo'd flag silently becoming a scan path would scan nothing
          // and exit 0 — a silent gate bypass.
          if (arg.startsWith("-")) {
            throw new Error(`Unknown option: ${arg}`);
          }
          paths.push(arg);
      }
    }

    // `--help` short-circuits before any profile resolution so `dry-ts --help`
    // never fails on an unrelated profile typo; the resolved Options below are
    // unused when help is set (main() prints USAGE and returns).
    const profile = help || profileName === undefined ? {} : resolveProfile(profileName);

    return new Options({
      paths: paths.length > 0 ? paths : config.paths && config.paths.length > 0 ? [...config.paths] : ["src"],
      threshold: pick(threshold, undefined, config.threshold, 0.82),
      minLines: pick(minLines, undefined, config.minLines, 4),
      minNodes: pick(minNodes, profile.minNodes, config.minNodes, 20),
      format: pick(format, profile.format, config.format, "text"),
      help: help ?? false,
      failOnDuplicates: pick(failOnDuplicates, profile.failOnDuplicates, config.failOnDuplicates, false),
      respectGitignore: pick(respectGitignore, undefined, config.respectGitignore, true),
      minLocations: pick(minLocations, undefined, config.minLocations, 2),
      changedFrom,
      changed,
      explainChanged: explainChanged ?? false,
      // onlyNew is run-scoped: a profile may set it, but a config file may not (a
      // committed `onlyNew` would make every plain scan throw on the missing scope).
      onlyNew: pick(onlyNew, profile.onlyNew, undefined, false),
      excludeKinds: unionLists(profile.excludeKinds, config.excludeKinds, excludeKinds),
      minDistinctKinds: pick(minDistinctKinds, undefined, config.minDistinctKinds, 0),
      // Config `exclude` and its alias `ignore` both feed the --exclude glob list,
      // unioned ahead of the CLI's own --exclude entries.
      exclude: unionLists(config.exclude, config.ignore, exclude),
      excludeTaggedTemplates: pick(excludeTaggedTemplates, undefined, config.excludeTaggedTemplates, false),
      excludeTests: pick(excludeTests, profile.excludeTests, config.excludeTests, false),
      counterparts: pick(counterparts, profile.counterparts, config.counterparts, false),
      // Prototype: CLI-only (no profile/config layer yet).
      demoteBoilerplate: demoteBoilerplate ?? false,
    });
  }
}

// Resolution precedence for a scalar option: an explicit CLI value wins, then
// the active profile's value, then the config file's value, then the built-in
// default. A layer that does not apply to an option passes undefined for its slot.
function pick<T>(explicit: T | undefined, fromProfile: T | undefined, fromConfig: T | undefined, fallback: T): T {
  return explicit ?? fromProfile ?? fromConfig ?? fallback;
}

// List flags union their layers (deduped, earliest layer first) rather than
// letting a later one replace an earlier — adding `--exclude-kinds` on top of a
// profile augments it, and config-level globs sit ahead of CLI ones, none discarding
// the others. Undefined/empty layers are skipped.
function unionLists(...layers: ReadonlyArray<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const layer of layers) {
    if (layer === undefined) {
      continue;
    }
    for (const value of layer) {
      if (!seen.has(value)) {
        seen.add(value);
        result.push(value);
      }
    }
  }
  return result;
}

function valueFor(args: readonly string[], index: number, option: string): string {
  if (index >= args.length) {
    throw new Error(`Missing value for ${option}`);
  }
  return args[index];
}

function formatValue(args: readonly string[], index: number, option: string): OutputFormat {
  const value = valueFor(args, index, option);
  if (!isOutputFormat(value)) {
    throw new Error(`Unknown format: ${value}`);
  }
  return value;
}

function numberValue(args: readonly string[], index: number, option: string): number {
  return parsedValue(args, index, option, Number.parseFloat, "number");
}

function integerValue(args: readonly string[], index: number, option: string): number {
  return parsedValue(args, index, option, (value) => Number.parseInt(value, 10), "integer");
}

function parsedValue(
  args: readonly string[],
  index: number,
  option: string,
  parse: (value: string) => number,
  label: string,
): number {
  const parsed = parse(valueFor(args, index, option));
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${label} for ${option}`);
  }
  return parsed;
}
