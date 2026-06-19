import fs from "node:fs";
import path from "node:path";

import type { OptionsInput } from "./Options.js";
import { isOutputFormat, OUTPUT_FORMATS, type OutputFormat } from "./types.js";

// The repo-checked-in config file. A persisted alternative to retyping the same
// flags on every run — the top v0.12 adoption blocker (#23). Read from cwd; its
// values sit BELOW an active --profile and any explicit CLI flag in precedence
// (explicit CLI flag > profile > config > built-in default), so a committed
// config sets the repo's baseline without overriding a flag the caller typed for
// this one run.
export const CONFIG_FILENAME = ".dry-ts.json";

// Only persistable *policy* belongs here, so ConfigOptions is the policy slice of
// OptionsInput picked by name (keeping each value's type coupled to the canonical
// option) plus the config-only `ignore` alias. Run-scoped inputs (changedFrom /
// changed / onlyNew / explainChanged / help) are deliberately excluded: they
// describe a single invocation, not a repo baseline, and an `onlyNew` in a
// committed file would make every plain scan throw "requires --changed-from".
// `ignore` is the issue's spelling for an `exclude` glob list: both are unioned
// into the resolved --exclude list, applied in addition to .gitignore.
export type ConfigOptions = Pick<
  OptionsInput,
  | "paths"
  | "threshold"
  | "minLines"
  | "minNodes"
  | "minLocations"
  | "minDistinctKinds"
  | "format"
  | "failOnDuplicates"
  | "respectGitignore"
  | "excludeKinds"
  | "exclude"
  | "excludeTaggedTemplates"
  | "excludeTests"
  | "counterparts"
> & {
  readonly ignore?: readonly string[];
};

type MutableConfig = { -readonly [K in keyof ConfigOptions]: ConfigOptions[K] };

type FieldParser = (source: string, key: string, value: unknown) => ConfigOptions[keyof ConfigOptions];

// Value validators: shape and TYPE only. Numeric RANGES (threshold in (0,1],
// minLines >= 1, …) are enforced once, downstream, by the Options constructor —
// duplicating them here would let the two drift.

// finiteNumber and the integer (count) check are the same guard shape — a typeof
// test plus a predicate — so they share one factory rather than two near-identical
// bodies (which dry-ts's own --fail-on-duplicates gate would, rightly, flag). The
// count keys use the integer predicate so a config cannot express a fractional
// floor the integer CLI flags (--min-nodes etc., parsed with parseInt) never could
// — `minLocations: 2.5` would otherwise silently mean "effectively 3". NaN and
// Infinity fail both predicates.
function numericValidator(isValid: (value: number) => boolean, label: string): FieldParser {
  return (source, key, value) => {
    if (typeof value !== "number" || !isValid(value)) {
      throw new Error(`${source}: "${key}" must be ${label}`);
    }
    return value;
  };
}

const finiteNumber = numericValidator(Number.isFinite, "a number");
const integer = numericValidator(Number.isInteger, "an integer");

function boolean(source: string, key: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${source}: "${key}" must be a boolean`);
  }
  return value;
}

// Trims and drops empties so a stray "" never becomes a glob matching everything,
// matching how --exclude/--exclude-kinds discard blank entries in Options.parse.
function stringList(source: string, key: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${source}: "${key}" must be an array of strings`);
  }
  return value.map((entry) => (entry as string).trim()).filter((entry) => entry.length > 0);
}

function outputFormat(source: string, key: string, value: unknown): OutputFormat {
  if (!isOutputFormat(value)) {
    throw new Error(`${source}: "${key}" must be one of ${OUTPUT_FORMATS.join(", ")}`);
  }
  return value;
}

// SINGLE source of truth for the persistable keys: each maps to the validator
// that types its value. parseConfig dispatches off this map and builds the
// unknown-key error's "valid:" list from its keys, so the accepted set can never
// drift from a hand-maintained second list (the prior KNOWN_KEYS array + switch).
// `satisfies Record<keyof ConfigOptions, …>` makes tsc reject any key here that
// is not a ConfigOptions field, and any ConfigOptions field missing a parser —
// coupling this map to the type at compile time.
const FIELD_PARSERS = {
  paths: stringList,
  threshold: finiteNumber,
  minLines: integer,
  minNodes: integer,
  minLocations: integer,
  minDistinctKinds: integer,
  format: outputFormat,
  failOnDuplicates: boolean,
  respectGitignore: boolean,
  excludeKinds: stringList,
  exclude: stringList,
  ignore: stringList,
  excludeTaggedTemplates: boolean,
  excludeTests: boolean,
  counterparts: boolean,
} satisfies Record<keyof ConfigOptions, FieldParser>;

const KNOWN_KEYS = Object.keys(FIELD_PARSERS);

// Reads CONFIG_FILENAME from `cwd`. ONLY a missing file (ENOENT) is the common,
// non-error case → empty config (every value falls through to profile/default).
// Any OTHER read error on a PRESENT file — a directory named .dry-ts.json
// (EISDIR), unreadable permissions (EACCES), an I/O error — fails loud (exit 2),
// rather than silently downgrading a committed policy to permissive defaults and
// passing CI at exit 0. A malformed-but-readable file throws in parseConfig.
export function loadConfig(cwd: string = process.cwd()): ConfigOptions {
  let text: string;
  try {
    text = fs.readFileSync(path.join(cwd, CONFIG_FILENAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new Error(`${CONFIG_FILENAME}: cannot read (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseConfig(text);
}

// `source` names the file in error messages so a config problem is attributable.
export function parseConfig(text: string, source: string = CONFIG_FILENAME): ConfigOptions {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: expected a JSON object at the top level`);
  }

  const config: MutableConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    // hasOwn (not `in`) so an inherited name like "toString" is still rejected,
    // and a JSON `__proto__`/`constructor` key (own, post-parse) misses the map
    // and falls to the unknown-key throw rather than reaching a parser.
    if (!Object.hasOwn(FIELD_PARSERS, key)) {
      throw new Error(`${source}: unknown key "${key}" (valid: ${KNOWN_KEYS.join(", ")})`);
    }
    const parse = FIELD_PARSERS[key as keyof typeof FIELD_PARSERS];
    (config as Record<string, unknown>)[key] = parse(source, key, value);
  }
  return config;
}
