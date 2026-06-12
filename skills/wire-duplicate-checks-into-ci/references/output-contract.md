# Output Contract

Exit codes:

- `0`: command ran successfully and either no duplicates were found or `--fail-on-duplicates` was not set
- `1`: duplicate candidates were found with `--fail-on-duplicates`
- `2`: CLI usage or configuration error, such as an unknown output format

JSON output:

```json
{
  "clusters": [
    {
      "score": { "min": 0.8909090909090909, "max": 0.8909090909090909 },
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
- `locationCount`: number of duplicate regions in the cluster
- `locations`: file and line ranges for duplicate regions that belong to the same cluster
- `locations[].nodes`: normalized syntax node count for the duplicated block
