import { createHash } from "node:crypto";

import type { ReportedCluster, ReportedLocation } from "./Report.js";

// PR-grade CI formatters. Both are pure: (ReportedCluster[]) => string, written
// to stdout like every other formatter. They surface only the changed copies
// of status:"new" clusters — PR-grade reporting is about *this* change, never
// the whole backlog. known/unscoped clusters and unchanged counterpart copies
// are never annotated; counterparts are named in the message text instead.

const GITHUB_CAP = 10; // GitHub Actions renders at most 10 error annotations per step.
const GITLAB_CAP = 50; // Anti-spam ceiling; the report stays a valid CodeClimate array.
const COUNTERPART_CAP = 3; // Counterparts named per message before "+N more".

const CHECK_NAME = "dry-ts/duplicate-code";

interface Finding {
  readonly location: ReportedLocation;
  readonly counterparts: readonly ReportedLocation[];
}

// The changed copies of new clusters, in deterministic cluster/location order.
// Counterparts are the cluster's unchanged copies (the old code you duplicated);
// when the change covers every copy there are none.
function findings(model: readonly ReportedCluster[]): Finding[] {
  const result: Finding[] = [];
  for (const cluster of model) {
    if (cluster.status !== "new") {
      continue;
    }
    const counterparts = cluster.locations.filter((location) => !location.intersectsChangedScope);
    for (const location of cluster.locations) {
      if (location.intersectsChangedScope) {
        result.push({ location, counterparts });
      }
    }
  }
  return result;
}

function span(location: ReportedLocation): string {
  return `${location.path}:${location.startLine}-${location.endLine}`;
}

function message(finding: Finding): string {
  const self = `lines ${finding.location.startLine}-${finding.location.endLine}`;
  if (finding.counterparts.length === 0) {
    return `dry-ts: duplicate code (${self}) — duplicates code elsewhere in this change`;
  }
  const shown = finding.counterparts.slice(0, COUNTERPART_CAP).map(span);
  const overflow = finding.counterparts.length - shown.length;
  const list = overflow > 0 ? `${shown.join(", ")} (+${overflow} more)` : shown.join(", ");
  return `dry-ts: duplicate code (${self}). Candidate counterparts in the same duplicate cluster: ${list}`;
}

// GitHub Actions workflow-command escaping uses two distinct tables (Actions
// spec). "%" is replaced first in both so the % of a later replacement is not
// re-escaped.
function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(",", "%2C").replaceAll(":", "%3A");
}

export function toGithub(model: readonly ReportedCluster[]): string {
  const all = findings(model);
  const shown = all.slice(0, GITHUB_CAP);
  const lines = shown.map((finding) => {
    const file = escapeProperty(finding.location.path);
    const line = finding.location.annotationLine ?? finding.location.startLine;
    const title = escapeProperty("dry-ts: duplicate code");
    return `::error file=${file},line=${line},title=${title}::${escapeData(message(finding))}`;
  });
  const overflow = all.length - shown.length;
  if (overflow > 0) {
    lines.push(
      `::notice::${escapeData(`dry-ts: ${overflow} more duplicate finding(s) not shown (GitHub caps annotations at ${GITHUB_CAP} per step)`)}`,
    );
  }
  return lines.join("\n");
}

interface CodeClimateEntry {
  readonly description: string;
  readonly check_name: string;
  readonly fingerprint: string;
  readonly severity: "major";
  readonly location: { readonly path: string; readonly lines: { readonly begin: number } };
}

// Versioned, line-independent fingerprint: a comment inserted above the block
// shifts lines.begin but the structural key is unchanged, so GitLab does not
// re-flag the whole backlog every run. The path discriminates the changed
// copies of one cluster — they share structuralKey by definition (that is what
// makes them duplicates), so without it GitLab would collapse two changed
// copies into a single issue. Path is line-independent, so drift stability holds.
function fingerprint(location: ReportedLocation): string {
  return createHash("sha256").update(`v1:${location.path}:${location.structuralKey}`).digest("hex");
}

export function toGitlab(model: readonly ReportedCluster[]): string {
  const all = findings(model);
  const shown = all.slice(0, GITLAB_CAP);
  const overflow = all.length - shown.length;
  const entries = shown.map((finding, index): CodeClimateEntry => {
    let description = message(finding);
    // Truncation note rides inside the last surviving finding's description —
    // never an out-of-schema object, so the report stays a valid array.
    if (overflow > 0 && index === shown.length - 1) {
      description += ` (${overflow} further finding(s) truncated)`;
    }
    return {
      description,
      check_name: CHECK_NAME,
      fingerprint: fingerprint(finding.location),
      severity: "major",
      location: {
        path: finding.location.path,
        lines: { begin: finding.location.annotationLine ?? finding.location.startLine },
      },
    };
  });
  return JSON.stringify(entries, null, 2);
}
