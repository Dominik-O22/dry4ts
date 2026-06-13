# Output Contract

Exit codes:

- `0`: success — no findings, or `--fail-on-duplicates` was not set
- `1`: findings with `--fail-on-duplicates`. Under a changed-scope (`--changed-from`/`--changed`), only clusters with `status: "new"` count as findings; with no scope, any cluster does
- `2`: usage/configuration error (unknown flag or format, out-of-range value, both scope flags, an ungateable `--changed` file under the gate, not a git repository with `--changed-from`, a bad ref) **or** any git/scanner failure. The gate fails closed: it never exits `0` or `1` on an error it could not interpret

JSON output:

```json
{
  "clusters": [
    {
      "score": { "min": 0.8909090909090909, "max": 0.8909090909090909 },
      "status": "unscoped",
      "locationCount": 2,
      "locations": [
        { "file": "src/invoice.ts", "startLine": 12, "endLine": 25, "nodes": 88 },
        { "file": "src/receipt.ts", "startLine": 30, "endLine": 44, "nodes": 91 }
      ]
    }
  ]
}
```

Cluster fields:

- `score.min` and `score.max`: structural similarity score range across the duplicate matches that connected the cluster
- `status`: `"new" | "known" | "unscoped"` (CLI output only — see below)
- `locationCount`: number of duplicate regions in the cluster
- `locations`: file and line ranges for duplicate regions that belong to the same cluster
- `locations[].nodes`: normalized syntax node count for the duplicated block

## Incremental gating and `status`

`--fail-on-duplicates` on its own is zero-tolerance: any cluster anywhere fails
the build. Pair it with a changed-scope flag to gate only on duplication a change
introduces, while still reporting known debt.

- `--changed-from <ref>`: line-level. Marks clusters intersecting code changed
  since `merge-base(<ref>, HEAD)`. Untracked scanned files count as fully
  changed. Requires a git repository.
- `--changed <file>` (repeatable): file-level. Marks clusters intersecting the
  named file. For agents and non-git callers. Cannot be combined with
  `--changed-from`.
- `--explain-changed`: dumps the resolved changed-region map to stderr.

Every cluster carries a `status`:

- `new` — at least one location intersects the changed scope. This is the
  *finding*, even when the counterpart location is old code you copied. Only
  `new` clusters gate under `--fail-on-duplicates`.
- `known` — pre-existing duplication, entirely in unchanged code. Reported,
  never gates.
- `unscoped` — emitted for every cluster when no changed-scope flag is active
  (the tool cannot label what is "known" without a scope). Read the **exit
  code**, not `status`, when no scope is active: an unscoped
  `--fail-on-duplicates` run can exit `1` while every cluster says `"unscoped"`.

`status` is assigned by the CLI. The `TypeScriptDuplicateFinder` library returns
clusters with `status` unset.
