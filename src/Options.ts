import type { OutputFormat } from "./types.js";

export interface OptionsInput {
  readonly paths?: readonly string[];
  readonly threshold?: number;
  readonly minLines?: number;
  readonly minNodes?: number;
  readonly format?: OutputFormat;
  readonly help?: boolean;
  readonly failOnDuplicates?: boolean;
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
  ) {}

  static defaults(): Options {
    return new Options(["src"], 0.82, 4, 20, "text", false, false);
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
    );
  }

  static parse(...args: string[]): Options {
    const paths: string[] = [];
    let threshold = 0.82;
    let minLines = 4;
    let minNodes = 20;
    let format: OutputFormat = "text";
    let help = false;
    let failOnDuplicates = false;

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
        case "--format":
          format = valueFor(args, ++i, arg);
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
        case "--help":
        case "-h":
          help = true;
          break;
        default:
          paths.push(arg);
      }
    }

    if (paths.length === 0) {
      paths.push("src");
    }
    return new Options(paths, threshold, minLines, minNodes, format, help, failOnDuplicates);
  }
}

function valueFor(args: readonly string[], index: number, option: string): string {
  if (index >= args.length) {
    throw new Error(`Missing value for ${option}`);
  }
  return args[index];
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
