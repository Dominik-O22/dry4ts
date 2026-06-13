import type { OutputFormat } from "./types.js";

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
    if (minLocations < 2) {
      throw new Error(`minLocations must be at least 2, got ${minLocations}`);
    }
    if (changedFrom !== undefined && changed.length > 0) {
      throw new Error("--changed-from and --changed cannot be combined");
    }
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
    );
  }

  static parse(...args: string[]): Options {
    const paths: string[] = [];
    let threshold = 0.82;
    let minLines = 4;
    let minNodes = 20;
    let minLocations = 2;
    let format: OutputFormat = "text";
    let help = false;
    let failOnDuplicates = false;
    let respectGitignore = true;
    let changedFrom: string | undefined;
    const changed: string[] = [];
    let explainChanged = false;

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      switch (arg) {
        case "--threshold":
          threshold = numberValue(args, ++i, arg);
          break;
        case "--min-lines":
          minLines = integerValue(args, ++i, arg);
          break;
        case "--min-nodes":
          minNodes = integerValue(args, ++i, arg);
          break;
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

    if (paths.length === 0) {
      paths.push("src");
    }
    return new Options(
      paths,
      threshold,
      minLines,
      minNodes,
      format,
      help,
      failOnDuplicates,
      respectGitignore,
      minLocations,
      changedFrom,
      changed,
      explainChanged,
    );
  }
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
