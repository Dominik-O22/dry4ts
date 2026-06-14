import { resolveExcludeKinds } from "./FileScanner.js";
import type { OutputFormat } from "./types.js";

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
}

const PROFILES: Record<string, ProfileFlags> = {
  // PR gate, highest signal. Deliberately requires an explicit --changed-from /
  // --changed: `onlyNew` without an active scope is a hard error in the Options
  // constructor, so `--profile pr` alone fails loud rather than silently gating
  // against the wrong base.
  pr: {
    excludeTests: true,
    minNodes: 50,
    excludeKinds: ["ArrowFunction", "VariableStatement"],
    onlyNew: true,
    failOnDuplicates: true,
  },
  // Source-only sane defaults: drop test scaffolding, keep the standard floors.
  src: { excludeTests: true },
  // Broad exploratory scan: lower the size floor to surface near-misses the
  // default would filter out; exclude nothing.
  audit: { minNodes: 12 },
  // Test-INFRASTRUCTURE duplication, explicitly not normal test bodies: drop
  // anonymous arrow bodies (the dominant test-scan noise) and raise the floor.
  // Point it at your test directories.
  tests: { excludeKinds: ["ArrowFunction"], minNodes: 40 },
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
}

export class Options {
  constructor(
    public readonly paths: readonly string[],
    public readonly threshold: number,
    public readonly minLines: number,
    public readonly minNodes: number,
    public readonly format: OutputFormat,
    public readonly help: boolean,
    public readonly failOnDuplicates: boolean,
    public readonly respectGitignore: boolean,
    public readonly minLocations: number = 2,
    public readonly changedFrom: string | undefined = undefined,
    public readonly changed: readonly string[] = [],
    public readonly explainChanged: boolean = false,
    public readonly onlyNew: boolean = false,
    public readonly excludeKinds: readonly string[] = [],
    public readonly minDistinctKinds: number = 0,
    public readonly exclude: readonly string[] = [],
    public readonly excludeTaggedTemplates: boolean = false,
    public readonly excludeTests: boolean = false,
    public readonly counterparts: boolean = false,
  ) {
    if (!(threshold > 0 && threshold <= 1)) {
      throw new Error(`threshold must be greater than 0 and at most 1, got ${threshold}`);
    }
    if (minLines < 1) {
      throw new Error(`minLines must be at least 1, got ${minLines}`);
    }
    if (minNodes < 1) {
      throw new Error(`minNodes must be at least 1, got ${minNodes}`);
    }
    if (minDistinctKinds < 0) {
      throw new Error(`minDistinctKinds must be at least 0, got ${minDistinctKinds}`);
    }
    if (minLocations < 2) {
      throw new Error(`minLocations must be at least 2, got ${minLocations}`);
    }
    if (changedFrom !== undefined && changed.length > 0) {
      throw new Error("--changed-from and --changed cannot be combined");
    }
    if (onlyNew && changedFrom === undefined && changed.length === 0) {
      throw new Error("--only-new requires --changed-from or --changed");
    }
    // Validate names eagerly so an unknown/non-candidate kind fails at
    // construction time, not silently at scan time.
    resolveExcludeKinds(excludeKinds);
  }

  static defaults(): Options {
    return new Options(["src"], 0.82, 4, 20, "text", false, false, true, 2);
  }

  static from(input: OptionsInput = {}): Options {
    const defaults = Options.defaults();
    const paths = input.paths && input.paths.length > 0 ? [...input.paths] : defaults.paths;
    return new Options(
      paths,
      input.threshold ?? defaults.threshold,
      input.minLines ?? defaults.minLines,
      input.minNodes ?? defaults.minNodes,
      input.format ?? defaults.format,
      input.help ?? defaults.help,
      input.failOnDuplicates ?? defaults.failOnDuplicates,
      input.respectGitignore ?? defaults.respectGitignore,
      input.minLocations ?? defaults.minLocations,
      input.changedFrom,
      input.changed ?? [],
      input.explainChanged ?? defaults.explainChanged,
      input.onlyNew ?? defaults.onlyNew,
      input.excludeKinds ?? [],
      input.minDistinctKinds ?? defaults.minDistinctKinds,
      input.exclude ?? [],
      input.excludeTaggedTemplates ?? defaults.excludeTaggedTemplates,
      input.excludeTests ?? defaults.excludeTests,
      input.counterparts ?? defaults.counterparts,
    );
  }

  static parse(...args: string[]): Options {
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

    return new Options(
      paths.length > 0 ? paths : ["src"],
      pick(threshold, undefined, 0.82),
      pick(minLines, undefined, 4),
      pick(minNodes, profile.minNodes, 20),
      pick(format, undefined, "text"),
      help ?? false,
      pick(failOnDuplicates, profile.failOnDuplicates, false),
      pick(respectGitignore, undefined, true),
      pick(minLocations, undefined, 2),
      changedFrom,
      changed,
      explainChanged ?? false,
      pick(onlyNew, profile.onlyNew, false),
      unionLists(profile.excludeKinds, excludeKinds),
      pick(minDistinctKinds, undefined, 0),
      exclude,
      pick(excludeTaggedTemplates, undefined, false),
      pick(excludeTests, profile.excludeTests, false),
      pick(counterparts, undefined, false),
    );
  }
}

// Resolution precedence for a scalar option: an explicit CLI value wins, then
// the active profile's value, then the built-in default.
function pick<T>(explicit: T | undefined, fromProfile: T | undefined, fallback: T): T {
  return explicit ?? fromProfile ?? fallback;
}

// List flags union the profile's entries with the user's (deduped, profile
// first) rather than letting either replace the other — adding `--exclude-kinds`
// on top of a profile augments it, it does not discard the profile's kinds.
function unionLists(fromProfile: readonly string[] | undefined, explicit: readonly string[]): string[] {
  if (fromProfile === undefined || fromProfile.length === 0) {
    return [...explicit];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of [...fromProfile, ...explicit]) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
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
  if (value !== "text" && value !== "edn" && value !== "json") {
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
