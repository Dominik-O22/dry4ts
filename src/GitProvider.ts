import { spawnSync } from "node:child_process";

// Thin provider around the git subprocess for --changed-from. All policy
// (hunk parsing, intersection) lives in ChangedRegions; this module only
// spawns git and fails closed: ANY failure — binary missing, non-zero exit,
// unexpected output — throws with git's stderr attached. Exit codes are the
// gate's API; a silently wrong changed set would wave new duplication
// through green.
//
// Hardening:
// - argument vectors only, never a shell string (CI refs are
//   attacker-influenced on fork PRs);
// - refs starting with "-" rejected outright (argument injection);
// - refs validated with `rev-parse --verify <ref>^{commit}` before use;
// - every call passes --no-color --no-ext-diff --no-textconv and
//   -c core.quotePath=false, with pathspecs after --, so user/global git
//   config can never reshape output under the strict parser.

export class GitProvider {
  constructor(private readonly cwd: string = process.cwd()) {}

  repoRoot(): string {
    return this.run(["rev-parse", "--show-toplevel"]).trim();
  }

  // Rejects unresolvable names and non-commit objects; returns the sha.
  verifyRef(ref: string): string {
    if (ref.startsWith("-")) {
      throw new Error(`Invalid git ref (must not start with "-"): ${ref}`);
    }
    return this.run(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  }

  // --changed-from never diffs literally against the ref: a branch behind its
  // base would see unrelated base-side changes pollute the changed set.
  mergeBase(ref: string): string {
    return this.run(["merge-base", ref, "HEAD"]).trim();
  }

  // base → working tree, matching the files the scanner reads. -U0: default
  // context lines would silently widen the gate. -M: follow renames.
  diffSince(base: string): string {
    return this.run(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", "-M", base, "--"]);
  }

  // Canonical (root-relative, slash-separated) paths of files in git's index,
  // bounded to the given pathspecs. A scanned file absent from this set is
  // untracked and counts as fully changed.
  indexedFiles(pathspecs: readonly string[]): Set<string> {
    const output = this.run(["ls-files", "--", ...pathspecs]);
    return new Set(output.split("\n").filter((line) => line !== ""));
  }

  private run(args: readonly string[]): string {
    const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: this.cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 256,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error("git executable not found; --changed-from requires git");
      }
      throw new Error(`git ${args[0]} failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
    }
    return result.stdout;
  }
}
