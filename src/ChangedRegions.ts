import path from "node:path";

// Pure changed-region logic for incremental duplicate gating. No git here;
// the subprocess lives in GitProvider. Pipeline:
//
//   git diff -U0 -M text ──► parseUnifiedDiff ──► ChangedRegions ─┐
//   --changed files / untracked ──► addWholeFile ────────────────┤
//                                                                ▼
//   cluster locations ──► intersectsLocation ──► status "new" | "known"
//
// All file keys are canonical: root-relative with forward slashes. Git output
// (already root-relative, core.quotePath=false) and scanner paths (OS-native,
// cwd-relative) are both converted at this boundary via canonicalPath().

export type RegionSource = "hunk" | "untracked" | "listed";

export interface ChangedRange {
  readonly start: number;
  readonly end: number;
  readonly source: RegionSource;
}

const WHOLE_FILE_END = Number.MAX_SAFE_INTEGER;

export class ChangedRegions {
  private readonly rangesByFile = new Map<string, ChangedRange[]>();

  addRange(file: string, start: number, end: number, source: RegionSource): void {
    const ranges = this.rangesByFile.get(file) ?? [];
    ranges.push({ start, end, source });
    this.rangesByFile.set(file, ranges);
  }

  addWholeFile(file: string, source: RegionSource): void {
    this.addRange(file, 1, WHOLE_FILE_END, source);
  }

  intersectsLocation(file: string, startLine: number, endLine: number): boolean {
    const ranges = this.rangesByFile.get(file);
    if (!ranges) {
      return false;
    }
    return ranges.some((range) => range.start <= endLine && startLine <= range.end);
  }

  entries(): Array<{ file: string; ranges: readonly ChangedRange[] }> {
    return [...this.rangesByFile.entries()]
      .map(([file, ranges]) => ({ file, ranges: [...ranges].sort((a, b) => a.start - b.start) }))
      .sort((a, b) => a.file.localeCompare(b.file));
  }

  describe(): string {
    const entries = this.entries();
    if (entries.length === 0) {
      return "  (no changed regions)";
    }
    return entries
      .flatMap(({ file, ranges }) => ranges.map((range) => `  ${describeRange(file, range)}`))
      .join("\n");
  }
}

function describeRange(file: string, range: ChangedRange): string {
  if (range.end === WHOLE_FILE_END) {
    return `${file} (entire file, ${range.source})`;
  }
  return `${file}:${range.start}-${range.end} (${range.source})`;
}

// Canonical form: root-relative, forward slashes. One conversion site for
// scanner paths (OS-native, cwd-relative) and --changed arguments.
export function canonicalPath(root: string, filePath: string): string {
  return path.relative(root, path.resolve(filePath)).split(path.sep).join("/");
}

// Strict parser for `git diff -U0 -M` output (ref → working tree). Post-image
// line ranges only. Never best-effort: an unrecognized line is an error — a
// silently wrong changed set would wave new duplication through green.
export function parseUnifiedDiff(diffText: string): ChangedRegions {
  const regions = new ChangedRegions();
  // Post-image path of the current file block; null between blocks and for
  // deleted files (+++ /dev/null).
  let currentFile: string | null = null;
  let inFileBlock = false;
  let pendingOld = 0;
  let pendingNew = 0;

  for (const line of diffText.split("\n")) {
    if (pendingOld > 0 || pendingNew > 0) {
      if (line.startsWith("-")) {
        pendingOld -= 1;
        continue;
      }
      if (line.startsWith("+")) {
        pendingNew -= 1;
        continue;
      }
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" marker; not a content line.
        continue;
      }
      throw new Error(`Unrecognized line inside diff hunk: ${JSON.stringify(line)}`);
    }

    if (line === "" || line.startsWith("\\")) {
      continue;
    }
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      inFileBlock = false;
      continue;
    }
    if (skippedHeaderPrefixes.some((prefix) => line.startsWith(prefix))) {
      continue;
    }
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      continue;
    }
    if (line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice("+++ ".length);
      currentFile = target === "/dev/null" ? null : stripPathPrefix(target);
      inFileBlock = true;
      continue;
    }

    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (!inFileBlock) {
        throw new Error(`Diff hunk before any file header: ${JSON.stringify(line)}`);
      }
      pendingOld = hunk[1] === undefined ? 1 : Number.parseInt(hunk[1], 10);
      const newStart = Number.parseInt(hunk[2], 10);
      const newCount = hunk[3] === undefined ? 1 : Number.parseInt(hunk[3], 10);
      pendingNew = newCount;
      // currentFile is null for a deleted file (+++ /dev/null): no post-image,
      // nothing to gate there.
      if (currentFile !== null) {
        if (newCount === 0) {
          // Deletion-only hunk: deleting the line that distinguished a
          // function can make the remaining code a duplicate. Mark the
          // post-image boundary line so that cluster gates as "new".
          regions.addRange(currentFile, Math.max(newStart, 1), Math.max(newStart, 1), "hunk");
        } else {
          regions.addRange(currentFile, newStart, newStart + newCount - 1, "hunk");
        }
      }
      continue;
    }

    throw new Error(`Unrecognized diff line: ${JSON.stringify(line)}`);
  }

  if (pendingOld > 0 || pendingNew > 0) {
    throw new Error("Truncated diff: hunk ended before all content lines were seen");
  }
  return regions;
}

// Git emits "b/<path>" with default prefixes; --no-ext-diff keeps it that way.
function stripPathPrefix(target: string): string {
  return target.startsWith("b/") ? target.slice(2) : target;
}

const skippedHeaderPrefixes = [
  "index ",
  "old mode ",
  "new mode ",
  "deleted file mode ",
  "new file mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
  "Submodule ",
];
