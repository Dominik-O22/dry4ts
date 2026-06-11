# Output Contract

Exit codes:

- `0`: command ran successfully and either no duplicates were found or `--fail-on-duplicates` was not set
- `1`: duplicate candidates were found with `--fail-on-duplicates`
- `2`: CLI usage or configuration error, such as an unknown output format

JSON output:

```json
{
  "candidates": [
    {
      "score": 0.8909090909090909,
      "left": { "file": "src/invoice.ts", "startLine": 12, "endLine": 25 },
      "right": { "file": "src/receipt.ts", "startLine": 30, "endLine": 44 },
      "leftNodes": 88,
      "rightNodes": 91
    }
  ]
}
```

Candidate fields:

- `score`: structural similarity score
- `left` and `right`: file and line range for each candidate region
- `leftNodes` and `rightNodes`: normalized AST node counts after filtering
