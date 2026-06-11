import { Options } from "./Options.js";
import { TypeScriptDuplicateFinder } from "./TypeScriptDuplicateFinder.js";
import type { Candidate, Location } from "./types.js";

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

  const candidates = new TypeScriptDuplicateFinder().findDuplicates(options);
  switch (options.format) {
    case "edn":
      console.log(toEdn(candidates));
      break;
    case "json":
      console.log(toJson(candidates));
      break;
    case "text":
      printText(candidates);
      break;
    default:
      console.error(`Unknown format: ${options.format}`);
      process.exitCode = 2;
  }

  if (options.failOnDuplicates && candidates.length > 0 && process.exitCode === undefined) {
    process.exitCode = 1;
  }
}

export function printText(candidates: readonly Candidate[]): void {
  if (candidates.length === 0) {
    console.log("No duplicate candidates found.");
    return;
  }
  candidates.forEach((candidate, index) => {
    if (index > 0) {
      console.log();
    }
    console.log(formatCandidate(candidate));
  });
}

export function formatCandidate(candidate: Candidate): string {
  return `DUPLICATE score=${candidate.score.toFixed(2)}\n  ${lineRange(candidate.left)}\n  ${lineRange(candidate.right)}`;
}

export function toEdn(candidates: readonly Candidate[]): string {
  if (candidates.length === 0) {
    return "{:candidates []}";
  }
  const entries = candidates
    .map(
      (candidate) =>
        `{:score ${candidate.score}\n   :left ${locationEdn(candidate.left)}\n   :right ${locationEdn(candidate.right)}\n   :left-nodes ${candidate.leftNodes}\n   :right-nodes ${candidate.rightNodes}}`,
    )
    .join("\n  ");
  return `{:candidates\n [${entries}]}`;
}

export function toJson(candidates: readonly Candidate[]): string {
  return `${JSON.stringify({ candidates }, null, 2)}\n`;
}

function locationEdn(location: Location): string {
  return `{:file "${escapeEdn(location.file)}", :start-line ${location.startLine}, :end-line ${location.endLine}}`;
}

function escapeEdn(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function lineRange(location: Location): string {
  return `${location.file}:${location.startLine}-${location.endLine}`;
}
